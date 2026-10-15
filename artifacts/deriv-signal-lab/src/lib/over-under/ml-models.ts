// Dependency-free, deliberately small local models. These are actually fitted
// to the training partition on every scan, not branded/pretrained AI services.
import { clamp, countsOf, mean, seededRandom, smooth, softmax, sum } from './math.ts';
import { classifierFeatures, prefix, timeDeltaFeature, type FittedEngine, type Sequence } from './features.ts';

const INPUTS = 11; // ten one-hot digit inputs + causal tick time delta
const HIDDEN = 8;
const STEPS = 12;
const WIDTH = INPUTS + HIDDEN + 1;
const GATE_PARAMETERS = 4 * HIDDEN * WIDTH;
const OUTPUT_OFFSET = GATE_PARAMETERS;
const BIAS_OFFSET = OUTPUT_OFFSET + 10 * HIDDEN;
const PARAMETERS = BIAS_OFFSET + 10;
const sigmoid = (value: number) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));

export function fitLstm(sequence: Sequence, horizon: number) {
  const random = seededRandom(12383 + horizon);
  const weights = Float64Array.from({ length: PARAMETERS }, () => (random() - 0.5) * 0.18);
  const accumulators = new Float64Array(PARAMETERS).fill(0.05);
  const prior = smooth(countsOf(sequence.digits));
  for (let digit = 0; digit < 10; digit += 1) weights[BIAS_OFFSET + digit] = Math.log(prior[digit]);
  // Forget-gate bias encourages retaining context at initialization.
  for (let unit = 0; unit < HIDDEN; unit += 1) weights[(HIDDEN + unit) * WIDTH + WIDTH - 1] = 1;

  // Each step's input is a one-hot digit plus a causal time delta, stored as the
  // active digit index (-1 when the step precedes the series) and the delta.
  // Skipping the exact zeros of the one-hot block leaves every partial sum
  // bit-identical while roughly halving the gate arithmetic.
  const encodeInto = (digitsOut: Int8Array, deltasOut: Float64Array, offset: number, context: Sequence, origin: number) => {
    for (let step = 0; step < STEPS; step += 1) {
      const index = origin - STEPS + step + 1;
      const digit = context.digits[index];
      digitsOut[offset + step] = Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit : -1;
      deltasOut[offset + step] = timeDeltaFeature(context.epochs, index);
    }
  };
  // Preallocated trace buffers so the forward / backward passes do not allocate
  // per step. Slot 0 of the cell and hidden buffers is the zero initial state;
  // step s reads slot s and writes slot s + 1.
  const gateTrace = new Float64Array(STEPS * 4 * HIDDEN);
  const cellTrace = new Float64Array((STEPS + 1) * HIDDEN);
  const hiddenTrace = new Float64Array((STEPS + 1) * HIDDEN);
  const logits = Array<number>(10).fill(0);
  const forward = (stepDigits: Int8Array, stepDeltas: Float64Array, offset: number): number[] => {
    for (let step = 0; step < STEPS; step += 1) {
      const digit = stepDigits[offset + step];
      const delta = stepDeltas[offset + step];
      const previous = step * HIDDEN;
      const gates = step * 4 * HIDDEN;
      for (let gate = 0; gate < 4 * HIDDEN; gate += 1) {
        const row = gate * WIDTH;
        let activation = 0;
        if (digit >= 0) activation += weights[row + digit];
        activation += weights[row + 10] * delta;
        for (let unit = 0; unit < HIDDEN; unit += 1) activation += weights[row + INPUTS + unit] * hiddenTrace[previous + unit];
        activation += weights[row + WIDTH - 1];
        gateTrace[gates + gate] = gate >= 3 * HIDDEN ? Math.tanh(activation) : sigmoid(activation);
      }
      const next = (step + 1) * HIDDEN;
      for (let unit = 0; unit < HIDDEN; unit += 1) {
        const cell = gateTrace[gates + HIDDEN + unit] * cellTrace[previous + unit] + gateTrace[gates + unit] * gateTrace[gates + 3 * HIDDEN + unit];
        cellTrace[next + unit] = cell;
        hiddenTrace[next + unit] = gateTrace[gates + 2 * HIDDEN + unit] * Math.tanh(cell);
      }
    }
    const last = STEPS * HIDDEN;
    for (let digit = 0; digit < 10; digit += 1) {
      let logit = weights[BIAS_OFFSET + digit];
      for (let unit = 0; unit < HIDDEN; unit += 1) logit += weights[OUTPUT_OFFSET + digit * HIDDEN + unit] * hiddenTrace[last + unit];
      logits[digit] = logit;
    }
    return softmax(logits);
  };
  const origins = Array.from({ length: Math.max(0, sequence.digits.length - horizon - STEPS + 1) }, (_, i) => i + STEPS - 1);
  const inputDigits = new Int8Array(origins.length * STEPS);
  const inputDeltas = new Float64Array(origins.length * STEPS);
  origins.forEach((origin, index) => encodeInto(inputDigits, inputDeltas, index * STEPS, sequence, origin));
  const targets = origins.map((origin) => sequence.digits[origin + horizon]);
  const loss = () => mean(targets.map((target, index) => -Math.log(Math.max(1e-9, forward(inputDigits, inputDeltas, index * STEPS)[target]))));
  const initialLoss = loss();
  const epochs = 7;
  const gradient = new Float64Array(PARAMETERS);
  const dh = new Float64Array(HIDDEN);
  const dc = new Float64Array(HIDDEN);
  const previousDh = new Float64Array(HIDDEN);
  const previousDc = new Float64Array(HIDDEN);
  const gateDerivative = new Float64Array(4 * HIDDEN);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const order = origins.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let batch = 0; batch < order.length; batch += 16) {
      gradient.fill(0);
      const batchEnd = Math.min(order.length, batch + 16);
      for (let sample = batch; sample < batchEnd; sample += 1) {
        const index = order[sample];
        const probabilities = forward(inputDigits, inputDeltas, index * STEPS);
        dh.fill(0);
        dc.fill(0);
        const last = STEPS * HIDDEN;
        for (let digit = 0; digit < 10; digit += 1) {
          const error = probabilities[digit] - Number(targets[index] === digit);
          gradient[BIAS_OFFSET + digit] += error;
          for (let unit = 0; unit < HIDDEN; unit += 1) {
            gradient[OUTPUT_OFFSET + digit * HIDDEN + unit] += error * hiddenTrace[last + unit];
            dh[unit] += error * weights[OUTPUT_OFFSET + digit * HIDDEN + unit];
          }
        }
        // Full backpropagation through the 12-step sequence, including all
        // input/forget/output/candidate gates and recurrent connections.
        for (let step = STEPS - 1; step >= 0; step -= 1) {
          const gates = step * 4 * HIDDEN;
          const cells = (step + 1) * HIDDEN;
          const previousCells = step * HIDDEN;
          for (let unit = 0; unit < HIDDEN; unit += 1) {
            const input = gateTrace[gates + unit];
            const forget = gateTrace[gates + HIDDEN + unit];
            const output = gateTrace[gates + 2 * HIDDEN + unit];
            const candidate = gateTrace[gates + 3 * HIDDEN + unit];
            const tanhCell = Math.tanh(cellTrace[cells + unit]);
            const cellGradient = dc[unit] + dh[unit] * output * (1 - tanhCell * tanhCell);
            gateDerivative[unit] = cellGradient * candidate * input * (1 - input);
            gateDerivative[HIDDEN + unit] = cellGradient * cellTrace[previousCells + unit] * forget * (1 - forget);
            gateDerivative[2 * HIDDEN + unit] = dh[unit] * tanhCell * output * (1 - output);
            gateDerivative[3 * HIDDEN + unit] = cellGradient * input * (1 - candidate * candidate);
            previousDc[unit] = cellGradient * forget;
          }
          previousDh.fill(0);
          const digit = inputDigits[index * STEPS + step];
          const timeDelta = inputDeltas[index * STEPS + step];
          for (let gate = 0; gate < 4 * HIDDEN; gate += 1) {
            const delta = gateDerivative[gate];
            const row = gate * WIDTH;
            // Zero one-hot inputs contribute exactly zero gradient; skip them.
            if (digit >= 0) gradient[row + digit] += delta;
            gradient[row + 10] += delta * timeDelta;
            for (let unit = 0; unit < HIDDEN; unit += 1) {
              gradient[row + INPUTS + unit] += delta * hiddenTrace[previousCells + unit];
              previousDh[unit] += delta * weights[row + INPUTS + unit];
            }
            gradient[row + WIDTH - 1] += delta;
          }
          dh.set(previousDh);
          dc.set(previousDc);
        }
      }
      for (let parameter = 0; parameter < PARAMETERS; parameter += 1) {
        const value = clamp(gradient[parameter] / (batchEnd - batch) + 0.0001 * weights[parameter], -1, 1);
        accumulators[parameter] += value * value;
        weights[parameter] -= 0.035 * value / Math.sqrt(accumulators[parameter]);
      }
    }
  }
  const finalLoss = loss();
  const liveDigits = new Int8Array(STEPS);
  const liveDeltas = new Float64Array(STEPS);
  const engine: FittedEngine = {
    id: 'lstm', family: 'ml', label: 'LSTM · 12-step / 8-cell sequence classifier',
    predict: (context) => {
      encodeInto(liveDigits, liveDeltas, 0, context, context.digits.length - 1);
      return { probabilities: forward(liveDigits, liveDeltas, 0), support: origins.length, note: 'Local categorical head sums strictly above / below each barrier; equality is a loss' };
    },
  };
  return { engine, samples: origins.length, epochs, sequenceLength: STEPS, hiddenUnits: HIDDEN, parameters: PARAMETERS, initialLoss, finalLoss };
}

type Tree = { value: number; feature?: number; threshold?: number; left?: Tree; right?: Tree };
function predictTree(tree: Tree, features: number[]): number {
  if (tree.feature === undefined) return tree.value;
  return predictTree(features[tree.feature] <= tree.threshold! ? tree.left! : tree.right!, features);
}

/** Multinomial Newton gradient boosting, regularized depth-two trees. */
export function fitBoosting(sequence: Sequence, horizon: number) {
  const origins = Array.from({ length: Math.max(0, sequence.digits.length - horizon - 50) }, (_, i) => i + 50);
  const features = origins.map((origin) => classifierFeatures(prefix(sequence, origin + 1)));
  const targets = origins.map((origin) => sequence.digits[origin + horizon]);
  const base = smooth(countsOf(targets)).map(Math.log);
  const logits = features.map(() => [...base]);
  const thresholds = features[0].map((_, feature) => {
    const sorted = features.map((row) => row[feature]).sort((a, b) => a - b);
    return [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => sorted[Math.floor(q * (sorted.length - 1))]))];
  });
  // Bin each value once against its ascending, de-duplicated thresholds:
  // value <= thresholds[j] exactly when bin <= j. Split search then becomes a
  // cumulative histogram scan with the same left/right membership rule.
  const rowCount = features.length;
  const featureCount = thresholds.length;
  const bins = new Uint8Array(featureCount * rowCount);
  for (let feature = 0; feature < featureCount; feature += 1) {
    const cuts = thresholds[feature];
    for (let row = 0; row < rowCount; row += 1) {
      const value = features[row][feature];
      let bin = 0;
      while (bin < cuts.length && value > cuts[bin]) bin += 1;
      bins[feature * rowCount + row] = bin;
    }
  }
  const histogramG = new Float64Array(5);
  const histogramH = new Float64Array(5);
  const histogramN = new Int32Array(5);
  const rounds: Tree[][] = [];
  const rate = 0.15;
  const lambda = 4;
  const allRows = features.map((_, i) => i);
  const loss = () => mean(logits.map((row, index) => -Math.log(Math.max(1e-9, softmax(row)[targets[index]]))));
  const initialLoss = loss();
  const buildTree = (rows: number[], gradient: Float64Array, curvature: Float64Array, depth: number): Tree => {
    let g = 0;
    let h = 0;
    for (const row of rows) { g += gradient[row]; h += curvature[row]; }
    const leaf = { value: clamp(g / (h + lambda), -2, 2) };
    if (depth === 2 || rows.length < 32) return leaf;
    let bestGain = 0.02;
    let best: { feature: number; bin: number; threshold: number } | null = null;
    for (let feature = 0; feature < featureCount; feature += 1) {
      const cuts = thresholds[feature];
      histogramG.fill(0); histogramH.fill(0); histogramN.fill(0);
      const offset = feature * rowCount;
      for (const row of rows) {
        const bin = bins[offset + row];
        histogramG[bin] += gradient[row];
        histogramH[bin] += curvature[row];
        histogramN[bin] += 1;
      }
      let leftG = 0; let leftH = 0; let leftN = 0;
      for (let bin = 0; bin < cuts.length; bin += 1) {
        leftG += histogramG[bin]; leftH += histogramH[bin]; leftN += histogramN[bin];
        if (leftN < 16 || rows.length - leftN < 16) continue;
        const gain = leftG * leftG / (leftH + lambda) + (g - leftG) ** 2 / (h - leftH + lambda) - g * g / (h + lambda);
        if (gain > bestGain) { bestGain = gain; best = { feature, bin, threshold: cuts[bin] }; }
      }
    }
    if (!best) return leaf;
    const split = best;
    const offset = split.feature * rowCount;
    return {
      ...leaf, feature: split.feature, threshold: split.threshold,
      left: buildTree(rows.filter((row) => bins[offset + row] <= split.bin), gradient, curvature, depth + 1),
      right: buildTree(rows.filter((row) => bins[offset + row] > split.bin), gradient, curvature, depth + 1),
    };
  };
  const gradient = new Float64Array(rowCount);
  const curvature = new Float64Array(rowCount);
  for (let round = 0; round < 24; round += 1) {
    const probabilities = logits.map(softmax);
    const trees = Array.from({ length: 10 }, (_, digit) => {
      for (let index = 0; index < rowCount; index += 1) {
        const p = probabilities[index][digit];
        gradient[index] = Number(targets[index] === digit) - p;
        curvature[index] = Math.max(1e-3, p * (1 - p));
      }
      return buildTree(allRows, gradient, curvature, 0);
    });
    rounds.push(trees);
    logits.forEach((row, index) => row.forEach((_, digit) => { row[digit] += rate * predictTree(trees[digit], features[index]); }));
  }
  const engine: FittedEngine = {
    id: 'boosting', family: 'ml', label: 'Gradient boosting · depth-two digit classifiers',
    predict: (context) => {
      const input = classifierFeatures(context);
      const output = base.map((value, digit) => value + rate * sum(rounds.map((trees) => predictTree(trees[digit], input))));
      return { probabilities: softmax(output), support: origins.length, note: 'Local boosted trees, not an XGBoost / LightGBM service or downloaded model' };
    },
  };
  return { engine, samples: origins.length, rounds: rounds.length, depth: 2, features: features[0].length, initialLoss, finalLoss: loss() };
}
