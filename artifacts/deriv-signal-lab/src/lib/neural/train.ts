// Walk-forward training + out-of-sample measurement for the embedded model.
//
// The network is only allowed to influence a signal if it beat the no-edge
// baseline on a slice of ticks it never saw. This module enforces that
// mechanically:
//
//   1. rows are chronological (the feature builders guarantee each row only
//      sees its own past), so the split is a genuine time split;
//   2. a purge gap removes the rows whose features or labels straddle a
//      boundary, so overlapping windows cannot leak the test set into training;
//   3. the scaler, the weights and the temperature are fitted on the training
//      and validation slices only;
//   4. the final slice is scored once, with the Brier skill and a paired
//      z-score against the training-implied baseline distribution;
//   5. `validated` is true only when both clear their bar, and only then does
//      `neuralWeight` allow the model to move a published probability.
import { evaluateLoss, forward, parameterCount, softmax, trainNetwork, type Network, type NetworkSpec, type TrainingRow } from './network.ts';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Highest share of a published edge a validated neural model may take. */
export const NEURAL_MAX_WEIGHT = 0.25;
/** Independent holdout rows a model needs before it can carry any weight. */
export const NEURAL_MIN_HOLDOUT = 60;
/** Paired z the model's holdout Brier improvement must clear. */
export const NEURAL_MIN_Z = 2;

export type SupervisedRow = {
  features: Float64Array;
  label: number;
  /** Tick origin for causal replay consumers. */
  origin?: number;
  /** Tick at which this label settles; used to purge variable-duration horizons. */
  exit?: number;
};

export type NeuralMetrics = {
  /** Class indices the network predicts. */
  classes: number;
  trainRows: number;
  validationRows: number;
  holdoutRows: number;
  /** Share of holdout rows whose top class was right. */
  accuracy: number | null;
  /** Accuracy of guessing at random (1 / classes). */
  baselineAccuracy: number | null;
  /** Mean softmax cross-entropy on holdout rows (lower is better). */
  logLoss: number | null;
  /**
   * Cross-entropy of the no-edge baseline the contracts are priced against.
   * For a 10-way digit head that is the uniform 10% distribution, and for the
   * two-way direction head it is the coin flip — the same `fair` probability
   * the tools compare a published edge to. Using the training class
   * frequencies here instead would quietly make "predict the historical
   * average" count as skill.
   */
  baselineLogLoss: number | null;
  /** 1 − model Brier / baseline Brier on holdout rows (multi-class Brier). */
  brierSkill: number | null;
  /** Paired z of the per-row Brier improvement over the baseline. */
  z: number | null;
  /** Log-loss skill versus the baseline distribution. */
  logLossSkill: number | null;
  /**
   * True only when the model beat the no-edge baseline out of sample with a
   * paired z of at least 2 on at least NEURAL_MIN_HOLDOUT rows.
   */
  validated: boolean;
  /** Softmax temperature fitted on the validation slice. */
  temperature: number;
  /** Log-loss improvement of that temperature on the validation slice. */
  temperatureGain: number;
};

export type TrainedNeural = {
  network: Network;
  temperature: number;
  /** Training-set standardisation, kept so predictions are reproducible. */
  scaler: { mean: Float64Array; deviation: Float64Array };
  metrics: NeuralMetrics;
  epochsRun: number;
  bestEpoch: number;
  trainingLoss: number | null;
  validationLoss: number | null;
  /** Calibrated distribution for a raw feature vector. */
  predict: (features: ArrayLike<number>) => Float64Array;
  /** Predictions on the sampled, untouched chronological holdout rows. */
  holdoutPredictions: Array<{ origin?: number; probabilities: number[] }>;
};

export type TrainConfig = {
  spec: NetworkSpec;
  /** Rows consumed by fitting (capped, evenly sampled across the slice). */
  maxTrainRows?: number;
  maxValidationRows?: number;
  maxHoldoutRows?: number;
  /** Rows dropped on each side of a boundary. */
  purge?: number;
  trainFraction?: number;
  validationFraction?: number;
  temperatureTemperature?: number;
};

/** Every k-th row, preserving chronology and keeping the newest row. */
function takeEvenly<T>(rows: readonly T[], cap: number): T[] {
  if (cap <= 0 || rows.length <= cap) return [...rows];
  const stride = rows.length / cap;
  const sampled: T[] = [];
  for (let index = 0; index < cap; index += 1) sampled.push(rows[Math.floor(index * stride)]);
  return sampled;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function stdev(values: readonly number[], average: number): number {
  if (values.length < 2) return 0;
  let total = 0;
  for (const value of values) total += (value - average) ** 2;
  return Math.sqrt(total / values.length);
}

export type ChronologicalSplit = {
  train: SupervisedRow[];
  validation: SupervisedRow[];
  holdout: SupervisedRow[];
  boundaries: { train: number; validation: number; purge: number };
};

/**
 * Split chronological rows into train/validation/holdout with a purge gap.
 * The holdout slice is never used to fit anything — not the scaler, not the
 * weights, not the temperature.
 */
export function splitChronological(rows: readonly SupervisedRow[], purge = 12, trainFraction = 0.6, validationFraction = 0.2): ChronologicalSplit {
  if (rows.length < 3) return { train: [...rows], validation: [], holdout: [], boundaries: { train: rows.length, validation: rows.length, purge } };
  const gap = Math.max(0, Math.trunc(purge));
  const n = rows.length;
  const trainEnd = Math.max(1, Math.min(n - 1, Math.floor(n * clamp(trainFraction, 0.2, 0.9))));
  const validationEnd = Math.max(trainEnd + 1, Math.min(n, Math.floor(n * clamp(trainFraction + validationFraction, trainFraction + 0.05, 0.98))));
  const trainBoundaryOrigin = rows[trainEnd]?.origin;
  const holdoutBoundaryOrigin = rows[validationEnd]?.origin;
  const settlesBefore = (row: SupervisedRow, boundary: number | undefined) =>
    boundary === undefined || !Number.isFinite(row.origin) || !Number.isFinite(row.exit) || (row.exit as number) < boundary;
  const train = rows.slice(0, Math.max(1, trainEnd - gap)).filter((row) => settlesBefore(row, trainBoundaryOrigin));
  const validation = rows.slice(trainEnd, Math.max(trainEnd + 1, validationEnd - gap)).filter((row) => settlesBefore(row, holdoutBoundaryOrigin));
  return {
    train,
    validation,
    holdout: rows.slice(validationEnd),
    boundaries: { train: trainEnd, validation: validationEnd, purge: gap },
  };
}

/** Fit a softmax temperature on validation logits (out of sample w.r.t. training). */
function fitTemperature(network: Network, rows: readonly SupervisedRow[]): { temperature: number; gain: number } {
  if (rows.length < 20) return { temperature: 1, gain: 0 };
  const logits = rows.map((row) => forward(network, row.features));
  const lossAt = (temperature: number) => {
    let loss = 0;
    for (let index = 0; index < rows.length; index += 1) {
      loss += -Math.log(Math.max(1e-12, softmax(logits[index], temperature)[rows[index].label]));
    }
    return loss / rows.length;
  };
  const uncalibrated = lossAt(1);
  let bestTemperature = 1;
  let bestLoss = uncalibrated;
  for (let candidate = 0.4; candidate <= 4.001; candidate += 0.05) {
    const temperature = Math.round(candidate * 100) / 100;
    const loss = lossAt(temperature);
    // Prefer T = 1 on ties: an unnecessary calibration should not be applied.
    if (loss < bestLoss - 1e-9 || (Math.abs(loss - bestLoss) <= 1e-9 && Math.abs(temperature - 1) < Math.abs(bestTemperature - 1))) {
      bestLoss = loss;
      bestTemperature = temperature;
    }
  }
  return { temperature: bestTemperature, gain: uncalibrated - bestLoss };
}

function standardise(rows: readonly SupervisedRow[], width: number): { rows: SupervisedRow[]; mean: Float64Array; deviation: Float64Array } {
  const sums = new Float64Array(width);
  for (const row of rows) for (let index = 0; index < width; index += 1) sums[index] += row.features[index];
  const count = Math.max(1, rows.length);
  const averages = sums.map((sum) => sum / count);
  const variance = new Float64Array(width);
  for (const row of rows) for (let index = 0; index < width; index += 1) variance[index] += (row.features[index] - averages[index]) ** 2;
  const deviations = variance.map((value) => Math.max(1e-6, Math.sqrt(value / count)));
  return {
    rows: rows.map((row) => ({
      label: row.label,
      ...(row.origin === undefined ? {} : { origin: row.origin }),
      ...(row.exit === undefined ? {} : { exit: row.exit }),
      features: Float64Array.from(row.features, (value, index) => clamp((value - averages[index]) / deviations[index], -6, 6)),
    })),
    mean: averages,
    deviation: deviations,
  };
}

/** Multi-class Brier score of one distribution. */
function brier(probabilities: ArrayLike<number>, label: number): number {
  let total = 0;
  for (let index = 0; index < probabilities.length; index += 1) total += (probabilities[index] - (index === label ? 1 : 0)) ** 2;
  return total;
}

/**
 * Train and measure the network on chronological rows.
 * Returns null when the sample is too thin for a meaningful fit.
 */
export function trainClassifier(rows: readonly SupervisedRow[], config: TrainConfig): TrainedNeural | null {
  const classes = Math.max(2, Math.trunc(config.spec.outputs));
  const clean = rows.filter((row) => Number.isInteger(row.label) && row.label >= 0 && row.label < classes
    && row.features.length === config.spec.inputDim && row.features.every((value) => Number.isFinite(value)));
  if (clean.length < 200) return null;
  const split = splitChronological(clean, config.purge ?? 12, config.trainFraction ?? 0.6, config.validationFraction ?? 0.2);
  if (split.train.length < 120 || split.holdout.length < 30) return null;

  const width = config.spec.inputDim;
  const scaled = standardise(split.train, width);
  // Standardise every other slice with the TRAINING statistics only, so no
  // information from validation or holdout leaks into the inputs.
  const applyScaler = (source: readonly SupervisedRow[]) => source.map((row) => ({
    label: row.label,
    ...(row.origin === undefined ? {} : { origin: row.origin }),
    ...(row.exit === undefined ? {} : { exit: row.exit }),
    features: Float64Array.from(row.features, (value, index) => clamp((value - scaled.mean[index]) / scaled.deviation[index], -6, 6)),
  }));
  const validationRows = applyScaler(split.validation);
  const holdoutRows = applyScaler(split.holdout);

  const trainRows = takeEvenly(scaled.rows, config.maxTrainRows ?? 640);
  const validationSample = takeEvenly(validationRows, config.maxValidationRows ?? 256);
  const holdoutSample = takeEvenly(holdoutRows, config.maxHoldoutRows ?? 512);

  const result = trainNetwork(config.spec, trainRows as TrainingRow[], validationSample as TrainingRow[]);
  const network = result.network;
  const { temperature, gain } = fitTemperature(network, validationSample);

  // Baseline distribution: the no-edge reference the contracts are priced
  // against (uniform digits, a coin flip for direction). Skill is measured
  // against the same reference the published edge uses, so the two numbers
  // can never tell different stories.
  const baseline = Array.from({ length: classes }, () => 1 / classes);
  let hits = 0;
  let modelLoss = 0;
  let baselineLoss = 0;
  let modelBrier = 0;
  let baseBrier = 0;
  const differences: number[] = [];
  const holdoutPredictions: Array<{ origin?: number; probabilities: number[] }> = [];
  for (const row of holdoutSample) {
    const probabilities = softmax(forward(network, row.features), temperature);
    holdoutPredictions.push({
      ...(row.origin === undefined ? {} : { origin: row.origin }),
      probabilities: Array.from(probabilities),
    });
    const predicted = probabilities.indexOf(Math.max(...probabilities));
    if (predicted === row.label) hits += 1;
    modelLoss += -Math.log(Math.max(1e-12, probabilities[row.label]));
    baselineLoss += -Math.log(Math.max(1e-12, baseline[row.label]));
    const modelRowBrier = brier(probabilities, row.label);
    const baseRowBrier = brier(baseline, row.label);
    modelBrier += modelRowBrier;
    baseBrier += baseRowBrier;
    differences.push(baseRowBrier - modelRowBrier);
  }
  const holdoutRowsCount = holdoutSample.length;
  const modelMeanBrier = modelBrier / Math.max(1, holdoutRowsCount);
  const baseMeanBrier = baseBrier / Math.max(1, holdoutRowsCount);
  const brierSkill = baseMeanBrier > 1e-12 ? 1 - modelMeanBrier / baseMeanBrier : null;
  const averageDifference = mean(differences);
  const differenceDeviation = stdev(differences, averageDifference);
  // A paired test needs variation between rows. When every row improves by
  // exactly the same amount (a perfectly learnable pattern) the variance is
  // zero, which is the strongest possible evidence, not an unmeasurable one.
  const z = holdoutRowsCount < 30
    ? null
    : differenceDeviation > 1e-12
      ? averageDifference / (differenceDeviation / Math.sqrt(holdoutRowsCount))
      : averageDifference > 1e-12 ? 50 : 0;
  const holdoutLogLoss = modelLoss / Math.max(1, holdoutRowsCount);
  const baselineLogLoss = baselineLoss / Math.max(1, holdoutRowsCount);
  const logLossSkill = baselineLogLoss > 1e-12 ? 1 - holdoutLogLoss / baselineLogLoss : null;
  const validated = holdoutRowsCount >= NEURAL_MIN_HOLDOUT
    && brierSkill !== null && brierSkill > 0
    && (logLossSkill ?? 0) > 0
    && z !== null && z >= NEURAL_MIN_Z;

  const metrics: NeuralMetrics = {
    classes,
    trainRows: split.train.length,
    validationRows: split.validation.length,
    holdoutRows: holdoutRowsCount,
    accuracy: holdoutRowsCount ? hits / holdoutRowsCount : null,
    baselineAccuracy: holdoutRowsCount ? 1 / classes : null,
    logLoss: holdoutRowsCount ? holdoutLogLoss : null,
    baselineLogLoss,
    brierSkill,
    z,
    logLossSkill,
    validated,
    temperature,
    temperatureGain: gain,
  };

  return {
    network,
    temperature,
    scaler: { mean: scaled.mean, deviation: scaled.deviation },
    metrics,
    epochsRun: result.epochsRun,
    bestEpoch: result.bestEpoch,
    trainingLoss: result.trainingLoss,
    validationLoss: result.bestValidationLoss,
    holdoutPredictions,
    predict: (features: ArrayLike<number>) => softmax(
      forward(network, Float64Array.from({ length: features.length }, (_, index) => clamp((features[index] - scaled.mean[index]) / scaled.deviation[index], -6, 6))),
      temperature,
    ),
  };
}

/**
 * The share of a published edge the model has earned. Zero unless the holdout
 * showed a positive Brier skill with a paired z of at least 2; otherwise the
 * weight grows with skill, the sample and the log-loss improvement, capped at
 * NEURAL_MAX_WEIGHT.
 */
export function neuralWeight(metrics: NeuralMetrics | null | undefined): number {
  if (!metrics || !metrics.validated) return 0;
  const skill = clamp(metrics.brierSkill ?? 0, 0, 1);
  if (skill <= 0) return 0;
  const sample = clamp(metrics.holdoutRows / 200, 0.3, 1);
  const logLossFactor = clamp(1 + (metrics.logLossSkill ?? 0) * 2, 0.5, 1.5);
  return clamp(NEURAL_MAX_WEIGHT * Math.tanh(6 * skill) * sample * logLossFactor, 0.02, NEURAL_MAX_WEIGHT);
}

/** Parameter count of a network, exposed for the model card. */
export { parameterCount };
/** Loss of the fitted network on a slice, exposed for the model card. */
export { evaluateLoss };
