// Layer 8 — training the forged model, with the knowledge base as the syllabus.
//
// The forge is fitted the way every other layer in this workspace is fitted —
// chronologically, purged, calibrated on a slice it did not train on, scored
// once on a later slice — plus one addition the syllabus asks for:
//
//   DISTILLATION. A contract has a few hundred binary outcomes, which is a very
//   thin signal for a network of this width. So each row is trained against a
//   SOFT target: the realised outcome mixed with the family-weighted ensemble's
//   probability for the same row (itself shrunk toward the contract's fair rate
//   by the knowledge prior). That is the "combine the engines, the AI and the
//   calculations" part of the brief done as learning rather than as a hand
//   weighting: the network is taught what the audited layers believed at that
//   moment and what actually happened, and it has to reconcile the two.
//
//   Nothing is leaked: the teacher probability of a row is computed from the
//   engines' own causal forecast at that origin, the teacher is not refitted,
//   the holdout is never used to choose the temperature, and the gate is the
//   same one the research and neural layers use (positive Brier and log-loss
//   skill with a paired z of at least 2 on at least 60 unseen rows).
import { cloneNetwork, createNetwork, forward, softmax, type Network, type NetworkSpec } from '../neural/network.ts';
import { knowledgeAnchor, knowledgeShrinkagePoints } from './knowledge.ts';
import { FORGE_MIN_HOLDOUT, FORGE_MIN_Z, FORGE_MAX_WEIGHT } from './types.ts';
import type { ForgeMetrics } from './types.ts';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export type ForgeRow = {
  features: Float64Array;
  /** Realised outcome of the traded call on this row. */
  label: 0 | 1;
  /** The audited ensemble's probability for the same call at the same origin. */
  teacher: number;
  /** Origin tick index, kept for the audit trail and ordering assertions. */
  origin?: number;
};

export type ForgeTrainConfig = {
  spec: NetworkSpec;
  /** Rows dropped on each side of a split boundary. */
  purge: number;
  maxTrainRows?: number;
  maxValidationRows?: number;
  maxHoldoutRows?: number;
  /** Share of the teacher probability mixed into the label (0–1). */
  distillation: number;
  trainFraction?: number;
  validationFraction?: number;
  /**
   * Candidates competing in the same scan (contracts × markets). Each one is a
   * separate fit, so the z a fit must clear is raised by the expected maximum
   * of that many draws — otherwise 200 fits of noise produce a handful of
   * "validated" models by construction.
   */
  selectionPool?: number;
};

export type TrainedForge = {
  network: Network;
  temperature: number;
  scaler: { mean: Float64Array; deviation: Float64Array };
  metrics: ForgeMetrics;
  /** Share of a published edge the forge earned (0 unless validated). */
  weight: number;
  /** How much of the network's own correction was kept (0 = pure teacher). */
  residualScale: number;
  /** Out-of-sample gain of that correction on the validation slice. */
  residualGain: number;
  epochsRun: number;
  bestEpoch: number;
  trainingLoss: number | null;
  validationLoss: number | null;
  /**
   * Probability that the traded call wins, for a raw feature vector and the
   * audited teacher's probability at the same origin (the residual baseline).
   */
  predict: (features: ArrayLike<number>, teacher: number) => number;
};

function takeEvenly<T>(rows: readonly T[], cap: number): T[] {
  if (cap <= 0 || rows.length <= cap) return [...rows];
  const stride = rows.length / cap;
  const sampled: T[] = [];
  for (let index = 0; index < cap; index += 1) sampled.push(rows[Math.floor(index * stride)]);
  return sampled;
}

export type ForgeSplit = {
  train: ForgeRow[];
  validation: ForgeRow[];
  holdout: ForgeRow[];
  boundaries: { train: number; validation: number; purge: number };
};

/** Chronological 60/20/20 split with a purge gap on each boundary. */
export function splitForgeRows(
  rows: readonly ForgeRow[],
  purge = 12,
  trainFraction = 0.6,
  validationFraction = 0.2,
): ForgeSplit {
  const n = rows.length;
  const gap = Math.max(0, Math.trunc(purge));
  if (n < 3) return { train: [...rows], validation: [], holdout: [], boundaries: { train: n, validation: n, purge: gap } };
  const trainEnd = Math.max(1, Math.min(n - 1, Math.floor(n * clamp(trainFraction, 0.2, 0.9))));
  const validationEnd = Math.max(trainEnd + gap + 1, Math.min(n, Math.floor(n * clamp(trainFraction + validationFraction, trainFraction + 0.05, 0.98))));
  return {
    train: rows.slice(0, Math.max(1, trainEnd - gap)),
    validation: rows.slice(trainEnd, Math.max(trainEnd + 1, validationEnd - gap)),
    holdout: rows.slice(validationEnd),
    boundaries: { train: trainEnd, validation: validationEnd, purge: gap },
  };
}

/** Soft target for one row: the outcome mixed with the shrunk teacher. */
export function softTarget(row: ForgeRow, distillation: number, fair: number, sample: number): number {
  const share = clamp(Number.isFinite(distillation) ? distillation : 0, 0, 1);
  return clamp((1 - share) * row.label + share * anchoredTeacher(row, fair, sample), 0.001, 0.999);
}

/** The teacher probability after the knowledge prior pulls it toward fair. */
function anchoredTeacher(row: ForgeRow, fair: number, sample: number): number {
  const anchor = knowledgeAnchor(fair);
  const shrink = knowledgeShrinkagePoints(sample);
  const teacher = clamp(Number.isFinite(row.teacher) ? row.teacher : anchor, 0.001, 0.999);
  return clamp(teacher + Math.sign(anchor - teacher) * Math.min(Math.abs(anchor - teacher), shrink), 0.001, 0.999);
}

function standardise(rows: readonly ForgeRow[], width: number): { rows: ForgeRow[]; mean: Float64Array; deviation: Float64Array } {
  const sums = new Float64Array(width);
  for (const row of rows) for (let index = 0; index < width; index += 1) sums[index] += row.features[index];
  const count = Math.max(1, rows.length);
  const mean = sums.map((sum) => sum / count);
  const variance = new Float64Array(width);
  for (const row of rows) for (let index = 0; index < width; index += 1) variance[index] += (row.features[index] - mean[index]) ** 2;
  const deviation = variance.map((value) => Math.max(1e-6, Math.sqrt(value / count)));
  return {
    rows: rows.map((row) => ({
      label: row.label,
      teacher: row.teacher,
      origin: row.origin,
      features: Float64Array.from(row.features, (value, index) => clamp((value - mean[index]) / deviation[index], -6, 6)),
    })),
    mean,
    deviation,
  };
}

/**
 * A training step: the standardised inputs, the soft target, and the teacher's
 * log-odds for this row.
 *
 * The offset is what makes the forge a RESIDUAL model: the network does not
 * have to rediscover the ensemble's view from scratch, it only learns what the
 * teacher got wrong. The forged log-odds are `logit(teacher) + f(x)`, so with a
 * network that learnt nothing the model degrades gracefully to the audited
 * teacher instead of to a random initialisation.
 */
type Step = { features: Float64Array; target: number; offset: number };

const LOGIT_FLOOR = 1e-4;

function logit(probability: number): number {
  const value = clamp(probability, LOGIT_FLOOR, 1 - LOGIT_FLOOR);
  return Math.log(value / (1 - value));
}

/** Teacher log-odds, anchored so a missing teacher means "no correction". */
function teacherOffset(teacher: number): number {
  return Number.isFinite(teacher) ? logit(teacher) : 0;
}

/**
 * Forged probability: the teacher's log-odds plus a SHRUNK version of the
 * network's own log-odds. `scale` is fitted on the validation slice, so a
 * correction that does not generalise is turned off (scale → 0) and the forge
 * falls back to exactly the audited teacher rather than to a worse model.
 */
function probabilityWithOffset(logits: ArrayLike<number>, offset: number, scale = 1): number {
  const delta = clamp(nudge(logits, scale) + offset, -30, 30);
  return 1 / (1 + Math.exp(-delta));
}

/**
 * How far the forged model is allowed to move the teacher's log-odds: at most
 * 0.6 (about fourteen probability points at even odds). The forge distils the
 * same engines the master decision already prices, so its job is to correct
 * them, not to replace them — and a bounded correction cannot turn a fair
 * teacher into a wild one when the residual happens to be wrong.
 */
const MAX_NUDGE_LOGIT = 0.6;

function nudge(logits: ArrayLike<number>, scale: number): number {
  return clamp(scale * (logits[1] - logits[0]), -MAX_NUDGE_LOGIT, MAX_NUDGE_LOGIT);
}

/** Soft cross-entropy of a probability against a soft target. */
export function softCrossEntropy(probability: number, target: number): number {
  const p = clamp(probability, 1e-9, 1 - 1e-9);
  return -(target * Math.log(p) + (1 - target) * Math.log(1 - p));
}

function batchForward(network: Network, features: Float64Array) {
  const activations: Float64Array[] = [features];
  const pre: Float64Array[] = [];
  let current: Float64Array = features;
  for (let layerIndex = 0; layerIndex < network.layers.length; layerIndex += 1) {
    const layer = network.layers[layerIndex];
    const output = new Float64Array(layer.outputDim);
    for (let row = 0; row < layer.outputDim; row += 1) {
      let total = layer.biases[row];
      const offset = row * layer.inputDim;
      for (let column = 0; column < layer.inputDim; column += 1) total += layer.weights[offset + column] * current[column];
      output[row] = total;
    }
    pre.push(output);
    const next = layerIndex === network.layers.length - 1 ? output : output.map((value) => (value > 0 ? value : 0));
    activations.push(next);
    current = next;
  }
  return { activations, pre };
}

/**
 * Fit the forged network with Adam on soft targets, early stopping on the
 * validation slice. No shuffle across the chronological order beyond the
 * mini-batch order itself, and the batch order is seeded, so the same rows and
 * seed always produce the same weights.
 */
function fitNetwork(
  spec: NetworkSpec,
  steps: readonly Step[],
  validation: readonly Step[],
  epochs: number,
): { network: Network; epochsRun: number; bestEpoch: number; trainingLoss: number | null; validationLoss: number | null } {
  const network = createNetwork(spec);
  const batchSize = Math.max(1, Math.trunc(spec.batchSize ?? 32));
  const learningRate = Number.isFinite(spec.learningRate) ? (spec.learningRate as number) : 0.01;
  const l2 = Number.isFinite(spec.l2) ? Math.max(0, spec.l2 as number) : 1e-4;
  const patience = Math.max(1, Math.trunc(spec.patience ?? 3));
  const moments = network.layers.map((layer) => ({
    mw: new Float64Array(layer.weights.length),
    vw: new Float64Array(layer.weights.length),
    mb: new Float64Array(layer.biases.length),
    vb: new Float64Array(layer.biases.length),
  }));
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;
  let step = 0;
  let seed = spec.seed >>> 0;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = steps.map((_, index) => index);
  const loss = (rows: readonly Step[]) => {
    if (!rows.length) return 0;
    let total = 0;
    for (const row of rows) {
      total += softCrossEntropy(probabilityWithOffset(forward(network, row.features), row.offset), row.target);
    }
    return total / rows.length;
  };
  let best: Network | null = null;
  let bestLoss = Number.POSITIVE_INFINITY;
  let bestEpoch = 0;
  let stale = 0;
  let epochsRun = 0;

  for (let epoch = 0; epoch < Math.max(1, epochs); epoch += 1) {
    epochsRun = epoch + 1;
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      step += 1;
      const gradWeights = network.layers.map((layer) => new Float64Array(layer.weights.length));
      const gradBiases = network.layers.map((layer) => new Float64Array(layer.biases.length));
      for (const index of batch) {
        const row = steps[index];
        const { activations, pre } = batchForward(network, row.features);
        const logits = activations[activations.length - 1];
        // The teacher's log-odds are added to the winning class, so the
        // probability starts at the audited teacher's view and the network
        // learns only the residual correction.
        const probability = probabilityWithOffset(logits, row.offset);
        const probabilities = [1 - probability, probability];
        // dL/dlogit for softmax + binary cross-entropy against a soft target.
        let delta = new Float64Array([probabilities[0] - (1 - row.target), probabilities[1] - row.target]);
        for (const value of delta) {
          if (!Number.isFinite(value)) delta.fill(0);
        }
        for (let layerIndex = network.layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
          const layer = network.layers[layerIndex];
          const input = activations[layerIndex];
          const gradientWeights = gradWeights[layerIndex];
          const gradientBiases = gradBiases[layerIndex];
          for (let rowIndex = 0; rowIndex < layer.outputDim; rowIndex += 1) {
            const value = delta[rowIndex] / batch.length;
            if (value === 0) continue;
            const offset = rowIndex * layer.inputDim;
            for (let column = 0; column < layer.inputDim; column += 1) gradientWeights[offset + column] += value * input[column];
            gradientBiases[rowIndex] += value;
          }
          if (layerIndex > 0) {
            const previous = network.layers[layerIndex - 1];
            const next = new Float64Array(previous.outputDim);
            for (let column = 0; column < layer.outputDim; column += 1) {
              const value = delta[column] / batch.length;
              if (value === 0) continue;
              const offset = column * layer.inputDim;
              for (let inputIndex = 0; inputIndex < layer.inputDim; inputIndex += 1) next[inputIndex] += value * layer.weights[offset + inputIndex];
            }
            const preActivation = pre[layerIndex - 1];
            for (let inputIndex = 0; inputIndex < next.length; inputIndex += 1) next[inputIndex] *= preActivation[inputIndex] > 0 ? 1 : 0;
            delta = next;
          }
        }
      }
      // Clip the batch gradient, then take a decoupled-L2 Adam step.
      let norm = 0;
      for (const gradient of gradWeights) for (const value of gradient) norm += value * value;
      for (const gradient of gradBiases) for (const value of gradient) norm += value * value;
      const clip = norm > 25 ? 5 / Math.sqrt(norm) : 1;
      const correction1 = 1 - beta1 ** step;
      const correction2 = 1 - beta2 ** step;
      for (let layerIndex = 0; layerIndex < network.layers.length; layerIndex += 1) {
        const layer = network.layers[layerIndex];
        const moment = moments[layerIndex];
        for (let position = 0; position < layer.weights.length; position += 1) {
          const gradient = gradWeights[layerIndex][position] * clip + l2 * layer.weights[position];
          moment.mw[position] = beta1 * moment.mw[position] + (1 - beta1) * gradient;
          moment.vw[position] = beta2 * moment.vw[position] + (1 - beta2) * gradient * gradient;
          layer.weights[position] -= learningRate * (moment.mw[position] / correction1) / (Math.sqrt(moment.vw[position] / correction2) + epsilon);
        }
        for (let position = 0; position < layer.biases.length; position += 1) {
          const gradient = gradBiases[layerIndex][position] * clip;
          moment.mb[position] = beta1 * moment.mb[position] + (1 - beta1) * gradient;
          moment.vb[position] = beta2 * moment.vb[position] + (1 - beta2) * gradient * gradient;
          layer.biases[position] -= learningRate * (moment.mb[position] / correction1) / (Math.sqrt(moment.vb[position] / correction2) + epsilon);
        }
      }
    }
    const validationLoss = validation.length ? loss(validation) : loss(steps);
    if (Number.isFinite(validationLoss) && validationLoss < bestLoss - 1e-6) {
      bestLoss = validationLoss;
      best = cloneNetwork(network);
      bestEpoch = epochsRun;
      stale = 0;
    } else {
      stale += 1;
      if (stale >= patience) break;
    }
  }
  return {
    network: best ?? cloneNetwork(network),
    epochsRun,
    bestEpoch,
    trainingLoss: steps.length ? loss(steps) : null,
    validationLoss: Number.isFinite(bestLoss) ? bestLoss : null,
  };
}

/**
 * Fit the residual scale on the validation slice: how much of the network's
 * own correction to keep. Fitted before the temperature, on data the weights
 * never saw, so a correction that only helped in-sample is shrunk out.
 */
function fitResidualScale(network: Network, rows: readonly Step[]): { scale: number; gain: number } {
  if (rows.length < 20) return { scale: 0, gain: 0 };
  const logits = rows.map((row) => forward(network, row.features));
  const lossAt = (scale: number) => {
    let total = 0;
    for (let index = 0; index < rows.length; index += 1) {
      total += softCrossEntropy(probabilityWithOffset(logits[index], rows[index].offset, scale), rows[index].target);
    }
    return total / rows.length;
  };
  const base = lossAt(0);
  let bestScale = 0;
  let bestLoss = base;
  for (let candidate = 0; candidate <= 1.5001; candidate += 0.05) {
    const scale = Math.round(candidate * 100) / 100;
    const value = lossAt(scale);
    if (value < bestLoss - 1e-9) {
      bestLoss = value;
      bestScale = scale;
    }
  }
  const gain = base - bestLoss;
  // A validation surface this flat is noise, and picking its argmax is how a
  // correction that does not generalise gets kept. The correction has to earn a
  // material gain on data the weights never saw, and it is shrunk in proportion
  // to how marginal that gain is. Below the floor the forge publishes the
  // audited teacher unchanged — a strictly safer model, not a worse one.
  const MIN_GAIN = 0.004;
  if (gain < MIN_GAIN) return { scale: 0, gain };
  const confidence = clamp(gain / 0.012, 0.3, 1);
  // The correction is a NUDGE, not a replacement. The forge distils the same
  // collection of engines the master decision already prices, so letting its
  // residual swing the teacher's log-odds by more than a third would import
  // variance the validation slice cannot certify.
  return { scale: clamp(bestScale * confidence, 0, 0.4), gain };
}

/** Fit a scalar temperature on validation logits (out of sample w.r.t. training). */
function fitTemperature(network: Network, rows: readonly Step[], residualScale: number): { temperature: number; gain: number } {
  if (rows.length < 20) return { temperature: 1, gain: 0 };
  const logits = rows.map((row) => forward(network, row.features));
  const lossAt = (temperature: number) => {
    let total = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const delta = clamp(nudge(logits[index], residualScale) + rows[index].offset, -30, 30) / temperature;
      total += softCrossEntropy(1 / (1 + Math.exp(-delta)), rows[index].target);
    }
    return total / rows.length;
  };
  const uncalibrated = lossAt(1);
  let bestTemperature = 1;
  let bestLoss = uncalibrated;
  for (let candidate = 0.4; candidate <= 4.001; candidate += 0.05) {
    const temperature = Math.round(candidate * 100) / 100;
    const value = lossAt(temperature);
    if (value < bestLoss - 1e-9 || (Math.abs(value - bestLoss) <= 1e-9 && Math.abs(temperature - 1) < Math.abs(bestTemperature - 1))) {
      bestLoss = value;
      bestTemperature = temperature;
    }
  }
  return { temperature: bestTemperature, gain: uncalibrated - bestLoss };
}

/**
 * Train the forge on chronological rows.
 *
 * `fair` is the contract's no-edge rate: it anchors the teacher target and the
 * holdout baseline, so the reported skill and the published edge are measured
 * against the same reference.
 */
export function trainForge(
  rows: readonly ForgeRow[],
  fair: number,
  config: ForgeTrainConfig,
): TrainedForge | null {
  const width = config.spec.inputDim;
  const clean = rows.filter((row) => (row.label === 0 || row.label === 1)
    && row.features.length === width
    && row.features.every((value) => Number.isFinite(value))
    && Number.isFinite(row.teacher));
  // The syllabus sets a floor: below this, a fit would be noise with a model
  // card attached. Kept low enough to fit short streams while still leaving
  // room for a chronological train / validation / holdout split.
  if (clean.length < 81) return null;
  // 50 / 20 / 30: the holdout is the largest slice, because it is the only one
  // whose size buys statistical power at the gate.
  const split = splitForgeRows(clean, config.purge, config.trainFraction ?? 0.5, config.validationFraction ?? 0.2);
  if (split.train.length < 40 || split.holdout.length < 25) return null;

  const scaled = standardise(split.train, width);
  const applyScaler = (source: readonly ForgeRow[]) => source.map((row) => ({
    label: row.label,
    teacher: row.teacher,
    origin: row.origin,
    features: Float64Array.from(row.features, (value, index) => clamp((value - scaled.mean[index]) / scaled.deviation[index], -6, 6)),
  }));
  const validationRows = applyScaler(split.validation);
  const holdoutRows = applyScaler(split.holdout);
  const distillation = clamp(config.distillation, 0, 1);

  const trainSample = takeEvenly(scaled.rows, config.maxTrainRows ?? 360);
  const validationSample = takeEvenly(validationRows, config.maxValidationRows ?? 180);
  const holdoutSample = takeEvenly(holdoutRows, config.maxHoldoutRows ?? 420);
  const steps: Step[] = trainSample.map((row) => ({
    features: row.features,
    target: softTarget(row, distillation, fair, split.train.length),
    offset: teacherOffset(anchoredTeacher(row, fair, split.train.length)),
  }));
  const validationSteps: Step[] = validationSample.map((row) => ({
    features: row.features,
    target: softTarget(row, distillation, fair, split.train.length),
    offset: teacherOffset(anchoredTeacher(row, fair, split.train.length)),
  }));

  const fitted = fitNetwork(config.spec, steps, validationSteps, Math.max(1, Math.trunc(config.spec.epochs ?? 10)));
  const residual = fitResidualScale(fitted.network, validationSteps);
  const { temperature, gain } = fitTemperature(fitted.network, validationSteps, residual.scale);
  const predictRaw = (features: ArrayLike<number>) => forward(
    fitted.network,
    Float64Array.from({ length: features.length }, (_, index) => clamp((features[index] - scaled.mean[index]) / scaled.deviation[index], -6, 6)),
  );
  /**
   * Forged probability for a live vector. `teacher` is the audited ensemble's
   * probability for the same call at the live origin: the network's output is a
   * correction on top of it, so a forge that learnt nothing still publishes the
   * teacher's number rather than a coin flip.
   */
  const predict = (features: ArrayLike<number>, teacher: number) => {
    const logits = predictRaw(features);
    // Temperature is applied to the forged log-odds (teacher offset included),
    // exactly as it was fitted on the validation slice.
    const delta = clamp(nudge(logits, residual.scale) + teacherOffset(teacher), -30, 30) / temperature;
    return clamp(1 / (1 + Math.exp(-delta)), 1e-6, 1 - 1e-6);
  };

  const baseline = clamp(finiteProbability(fair) ? fair : 0.5, 0.001, 0.999);
  let hits = 0;
  let modelLoss = 0;
  let baselineLoss = 0;
  let modelBrier = 0;
  let baselineBrier = 0;
  let forecastSum = 0;
  let teacherErrors = 0;
  const differences: number[] = [];
  for (const row of holdoutSample) {
    const probability = predict(row.features, row.teacher);
    forecastSum += probability;
    if ((probability >= 0.5 ? 1 : 0) === row.label) hits += 1;
    modelLoss += -Math.log(clamp(probability, 1e-12, 1) * (row.label === 1 ? 1 : 0) + clamp(1 - probability, 1e-12, 1) * (row.label === 0 ? 1 : 0));
    baselineLoss += -Math.log(clamp(baseline, 1e-12, 1) * (row.label === 1 ? 1 : 0) + clamp(1 - baseline, 1e-12, 1) * (row.label === 0 ? 1 : 0));
    const modelRowBrier = (probability - row.label) ** 2;
    const baselineRowBrier = (baseline - row.label) ** 2;
    modelBrier += modelRowBrier;
    baselineBrier += baselineRowBrier;
    differences.push(baselineRowBrier - modelRowBrier);
    if ((row.teacher >= baseline ? 1 : 0) !== row.label) teacherErrors += 1;
  }
  const count = Math.max(1, holdoutSample.length);
  const meanDifference = differences.reduce((total, value) => total + value, 0) / count;
  const differenceVariance = differences.reduce((total, value) => total + (value - meanDifference) ** 2, 0) / count;
  const differenceDeviation = Math.sqrt(Math.max(0, differenceVariance));
  const z = holdoutSample.length < 30
    ? null
    : differenceDeviation > 1e-12
      ? meanDifference / (differenceDeviation / Math.sqrt(count))
      : meanDifference > 1e-12 ? 50 : 0;
  const meanBrier = modelBrier / count;
  const meanBaselineBrier = baselineBrier / count;
  const brierSkill = meanBaselineBrier > 1e-12 ? 1 - meanBrier / meanBaselineBrier : null;
  const logLoss = modelLoss / count;
  const baselineLogLoss = baselineLoss / count;
  const logLossSkill = baselineLogLoss > 1e-12 ? 1 - logLoss / baselineLogLoss : null;
  const hitRate = hits / count;
  const calibrationGap = holdoutSample.length ? Math.abs(forecastSum / count - hitRate) : null;
  const baselineAccuracy = count ? (baseline >= 0.5 === true ? baseline : 1 - baseline) : null;

  // The bar is raised for the size of the search, capped at 32: past that the
  // correction is dominated by the scan's own ranking penalty downstream
  // (`selectionPenalty` in the confidence score) and an uncapped bar would make
  // the gate unreachable on every market rather than strict.
  const pool = Math.min(32, Math.max(1, Math.trunc(finiteNumber(config.selectionPool) ? (config.selectionPool as number) : 1)));
  const zBar = FORGE_MIN_Z + 0.6 * (Math.sqrt(2 * Math.log(Math.max(2, pool))) - Math.sqrt(2 * Math.log(2)));
  const gate: string[] = [];
  const enoughRows = holdoutSample.length >= FORGE_MIN_HOLDOUT;
  gate.push(`${holdoutSample.length} independent holdout rows (${enoughRows ? 'meets' : 'below'} the ${FORGE_MIN_HOLDOUT}-row floor).`);
  gate.push(`Brier skill ${percent(brierSkill)} (${(brierSkill ?? 0) > 0 ? 'positive' : 'not positive'}).`);
  gate.push(`Log-loss skill ${percent(logLossSkill)} (${(logLossSkill ?? 0) > 0 ? 'positive' : 'not positive'}).`);
  gate.push(`Paired z ${z === null ? '—' : z.toFixed(2)} against a ${zBar.toFixed(2)} bar (${(z ?? 0) >= zBar ? 'clears' : 'below'} it; the bar is raised for the ${pool} candidate${pool === 1 ? '' : 's'} compared in this scan).`);
  const validated = enoughRows
    && brierSkill !== null && brierSkill > 0
    && (logLossSkill ?? 0) > 0
    && z !== null && z >= zBar;

  const metrics: ForgeMetrics = {
    trainRows: split.train.length,
    validationRows: split.validation.length,
    holdoutRows: holdoutSample.length,
    accuracy: count ? hitRate : null,
    baselineAccuracy,
    brier: count ? meanBrier : null,
    baselineBrier: count ? meanBaselineBrier : null,
    brierSkill,
    z,
    zBar,
    logLoss: count ? logLoss : null,
    baselineLogLoss,
    logLossSkill,
    calibrationGap,
    validated,
    gate,
    temperature,
    temperatureGain: gain,
    residualScale: residual.scale,
    teacherErrorRate: count ? teacherErrors / count : null,
  };

  return {
    network: fitted.network,
    temperature,
    scaler: { mean: scaled.mean, deviation: scaled.deviation },
    metrics,
    weight: forgeWeight(metrics),
    residualScale: residual.scale,
    residualGain: residual.gain,
    epochsRun: fitted.epochsRun,
    bestEpoch: fitted.bestEpoch,
    trainingLoss: fitted.trainingLoss,
    validationLoss: fitted.validationLoss,
    predict,
  };
}

const finiteProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const finiteNumber = finiteProbability;

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${(100 * value).toFixed(1)}%`;
}

/**
 * Share of a published edge the forge earned. Zero unless the holdout cleared
 * every gate; otherwise it grows with skill, sample and log-loss improvement,
 * capped at FORGE_MAX_WEIGHT. The cap exists because the forge consumes the
 * same inputs as the layers it distils, so its evidence is correlated with
 * theirs — a large weight would count the same information twice.
 */
export function forgeWeight(metrics: ForgeMetrics | null | undefined): number {
  if (!metrics || !metrics.validated) return 0;
  const skill = clamp(metrics.brierSkill ?? 0, 0, 1);
  if (skill <= 0) return 0;
  const rSample = clamp(metrics.holdoutRows / 200, 0.3, 1);
  const rLogLoss = clamp(1 + (metrics.logLossSkill ?? 0) * 2, 0.5, 1.5);
  return clamp(FORGE_MAX_WEIGHT * Math.tanh(6 * skill) * rSample * rLogLoss, 0.02, FORGE_MAX_WEIGHT);
}
