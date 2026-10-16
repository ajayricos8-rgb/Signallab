// ENGINES D & E — Pattern recognition and probability estimation, plus the
// model family required by the specification (models A–H).
//
// Rules enforced here:
//   * every model is fitted on the training segment only,
//   * ensemble weights come from tuning-segment skill on a rolling baseline,
//   * the holdout segment is used once, for reporting, and never for fitting,
//   * a model that fails to beat the simple baseline out of sample is
//     downgraded to zero weight instead of being trusted for its confidence,
//   * abstaining is allowed (a model may return a null distribution).
import { clamp, countsOf, mean, mix, normalize, softmax, sum, UNIFORM } from '../over-under/math.ts';
import { improvementSummary } from '../over-under/math.ts';
import type { EnsembleFinding, ModelEvidence } from './types.ts';
import {
  DIRICHLET_ALPHA,
  brierScore,
  calibrationReport,
  dirichletMean,
  ewmaDigitProbabilities,
  logLossScore,
  pairFollowProbabilities,
  transitionCounts,
  transitionProbabilities,
} from './statistics.ts';

export type ModelKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export type ModelForecast = { probabilities: number[] | null; support: number; note: string };

export type FittedModel = {
  key: ModelKey;
  label: string;
  kind: 'statistical' | 'ml' | 'pattern';
  /** Digits used to fit or configure the model (training segment only). */
  trainingSample: number;
  predict: (context: readonly number[]) => ModelForecast;
};

export type WalkForwardPoint = {
  origin: number;
  targetIndex: number;
  target: number;
  baseline: number[];
  forecasts: ModelForecast[];
};

export type ModelReport = {
  symbol: string;
  sample: number;
  horizon: number;
  trainEnd: number;
  tuningEnd: number;
  tuningOrigins: number;
  holdoutOrigins: number;
  models: ModelEvidence[];
  ensemble: EnsembleFinding;
  fittedAt: number;
  /** Quick fingerprint so the caller can tell when a refit is warranted. */
  fingerprint: string;
};

export const MODEL_LABELS: Record<ModelKey, string> = {
  A: 'Smoothed statistical baseline',
  B: 'Bayesian digit model',
  C: 'Conditional transition model',
  D: 'Rolling-window model',
  E: 'Exponentially weighted model',
  F: 'Pattern-recognition model',
  G: 'Machine-learning classifier',
  H: 'Ensemble probability model',
};

const BASELINE_WINDOW = 1_000;
const TRANSITION_WINDOW = 1_000;
const PATTERN_WINDOW = 1_500;

/** Rolling-frequency baseline every model is compared against. */
export function baselineForecast(context: readonly number[]): number[] {
  return dirichletMean(countsOf(context.slice(-BASELINE_WINDOW)));
}

function weightedCounts(digits: readonly number[], halfLife: number): number[] {
  const counts = Array<number>(10).fill(0);
  const lambda = Math.log(2) / Math.max(1, halfLife);
  for (let index = 0; index < digits.length; index += 1) {
    const weight = Math.exp(-lambda * (digits.length - 1 - index));
    counts[digits[index]] += weight;
  }
  return counts;
}

/** MODEL A — Dirichlet-smoothed counts over a rolling window. */
function fitSmoothedBaseline(window: number): FittedModel {
  const size = clamp(window, 25, 1_000);
  return {
    key: 'A',
    label: MODEL_LABELS.A,
    kind: 'statistical',
    trainingSample: size,
    predict: (context) => {
      const slice = context.slice(-size);
      if (slice.length < 10) return { probabilities: null, support: slice.length, note: 'Fewer than ten ticks in the configured window.' };
      return { probabilities: dirichletMean(countsOf(slice)), support: slice.length, note: `Rolling ${size}-tick posterior.` };
    },
  };
}

/** MODEL B — Bayesian posterior over recency-weighted counts. */
function fitBayesianModel(halfLife: number): FittedModel {
  return {
    key: 'B',
    label: MODEL_LABELS.B,
    kind: 'statistical',
    trainingSample: 0,
    predict: (context) => {
      const slice = context.slice(-1_000);
      if (slice.length < 20) return { probabilities: null, support: slice.length, note: 'Fewer than twenty ticks available for a posterior.' };
      const counts = weightedCounts(slice, halfLife);
      const total = sum(counts);
      const posterior = normalize(counts.map((count) => count + DIRICHLET_ALPHA + (total > 0 ? (0.5 * total) / 10 : 0.05)));
      return { probabilities: posterior, support: slice.length, note: `Exponential prior with a ${halfLife}-tick half-life.` };
    },
  };
}

/** MODEL C — conditional transition model conditioned on the newest digits. */
function fitTransitionModel(order: 1 | 2, minimumSupport: number): FittedModel {
  return {
    key: 'C',
    label: MODEL_LABELS.C,
    kind: 'statistical',
    trainingSample: 0,
    predict: (context) => {
      const slice = context.slice(-TRANSITION_WINDOW);
      if (slice.length < 50) return { probabilities: null, support: slice.length, note: 'Transition rows need at least fifty ticks.' };
      const matrix = transitionProbabilities(transitionCounts(slice));
      const latest = slice.at(-1);
      if (latest === undefined) return { probabilities: null, support: 0, note: 'No context digit.' };
      const marginal = dirichletMean(countsOf(slice));
      if (order === 1) {
        const rowSample = sum(transitionCounts(slice)[latest]);
        if (rowSample < minimumSupport) {
          return { probabilities: mix(marginal, matrix[latest], clamp(rowSample / minimumSupport, 0, 1)), support: rowSample, note: `Row from digit ${latest} blended toward the marginal until ${minimumSupport} transitions exist (have ${rowSample}).` };
        }
        return { probabilities: matrix[latest], support: rowSample, note: `Row from digit ${latest}.` };
      }
      const pairs = pairFollowProbabilities(slice);
      if (pairs.current && pairs.sample >= minimumSupport) {
        return { probabilities: mix(pairs.current, marginal, 0.35), support: pairs.sample, note: `Two-digit suffix follow-through (${pairs.sample} observations) blended with the marginal.` };
      }
      const rowSample = sum(transitionCounts(slice)[latest]);
      return {
        probabilities: mix(marginal, matrix[latest], clamp(rowSample / Math.max(1, minimumSupport), 0, 1)),
        support: pairs.sample,
        note: `Two-digit suffix support (${pairs.sample}) is below ${minimumSupport}; fell back to the single-digit row.`,
      };
    },
  };
}

/** MODEL D — rolling-window model that selects its window on training data. */
function fitRollingWindow(train: readonly number[], horizon: number, candidates: readonly number[]): FittedModel {
  const viable = candidates.filter((window) => window > 0);
  let bestWindow = viable[0] ?? 100;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const window of viable) {
    let loss = 0;
    let count = 0;
    for (let origin = window; origin + horizon < train.length; origin += Math.max(1, horizon)) {
      const probabilities = dirichletMean(countsOf(train.slice(origin - window, origin)));
      loss += brierScore(probabilities, train[origin + horizon]);
      count += 1;
    }
    if (count >= 10) {
      const average = loss / count;
      if (average < bestLoss) {
        bestLoss = average;
        bestWindow = window;
      }
    }
  }
  return {
    key: 'D',
    label: MODEL_LABELS.D,
    kind: 'statistical',
    trainingSample: train.length,
    predict: (context) => {
      const slice = context.slice(-bestWindow);
      if (slice.length < Math.min(20, bestWindow)) return { probabilities: null, support: slice.length, note: 'Window is not filled yet.' };
      return { probabilities: dirichletMean(countsOf(slice)), support: slice.length, note: `Window ${bestWindow} chosen on the training segment.` };
    },
  };
}

/** MODEL E — exponentially weighted probabilities. */
function fitExponentialModel(train: readonly number[], horizon: number): FittedModel {
  const decays = [0.99, 0.97, 0.9];
  let bestDecay = decays[0];
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const decay of decays) {
    let loss = 0;
    let count = 0;
    for (let origin = 250; origin + horizon < train.length; origin += Math.max(1, horizon * 5)) {
      const probabilities = ewmaDigitProbabilities(train.slice(0, origin), decay);
      loss += brierScore(probabilities, train[origin + horizon]);
      count += 1;
    }
    if (count >= 5) {
      const average = loss / count;
      if (average < bestLoss) {
        bestLoss = average;
        bestDecay = decay;
      }
    }
  }
  return {
    key: 'E',
    label: MODEL_LABELS.E,
    kind: 'statistical',
    trainingSample: train.length,
    predict: (context) => {
      if (context.length < 50) return { probabilities: null, support: context.length, note: 'Fewer than fifty ticks for a weighted estimate.' };
      return { probabilities: ewmaDigitProbabilities(context.slice(-1_000), bestDecay), support: context.length, note: `Decay ${bestDecay} chosen on the training segment.` };
    },
  };
}

/** MODEL F — suffix pattern recognition with an explicit support threshold. */
function fitPatternModel(order: 1 | 2 | 3, minimumSupport: number): FittedModel {
  return {
    key: 'F',
    label: MODEL_LABELS.F,
    kind: 'pattern',
    trainingSample: 0,
    predict: (context) => {
      const slice = context.slice(-PATTERN_WINDOW);
      if (slice.length < order + 30) return { probabilities: null, support: 0, note: 'Not enough history for a suffix scan.' };
      const suffix = slice.slice(-order).join('');
      const follows = Array<number>(10).fill(0);
      let support = 0;
      for (let index = order; index < slice.length; index += 1) {
        if (slice.slice(index - order, index).join('') === suffix) {
          follows[slice[index]] += 1;
          support += 1;
        }
      }
      const marginal = dirichletMean(countsOf(slice));
      if (support < minimumSupport) {
        // Under-supported patterns must not produce a confident claim.
        return {
          probabilities: mix(dirichletMean(follows), marginal, clamp(support / minimumSupport, 0, 1) * 0.5),
          support,
          note: `Suffix "${suffix}" occurred ${support} times; estimate shrunk toward the marginal.`,
        };
      }
      return {
        probabilities: normalize(follows.map((count, digit) => count + DIRICHLET_ALPHA + 0.15 * marginal[digit])),
        support,
        note: `Suffix "${suffix}" occurred ${support} times in the last ${slice.length} ticks.`,
      };
    },
  };
}

/** Feature vector for the local classifier; index-stable across train/predict. */
const FEATURE_WIDTH = 18;

export function digitFeatures(digits: readonly number[], index: number): number[] {
  const features = Array<number>(FEATURE_WIDTH).fill(0);
  const last = digits[index] ?? 0;
  features[last] = 1;
  features[10] = last % 2 === 0 ? 1 : 0;
  let run = 1;
  for (let cursor = index - 1; cursor >= 0 && digits[cursor] === last; cursor -= 1) run += 1;
  features[11] = clamp(run / 10, 0, 1);
  const window = digits.slice(Math.max(0, index - 99), index + 1);
  const averaged = window.length ? mean(window) / 9 : 0.5;
  features[12] = averaged;
  features[13] = clamp(window.length / 100, 0, 1);
  const ewma = ewmaDigitProbabilities(window, 0.97);
  features[14] = ewma[0] + ewma[1];
  features[15] = ewma[8] + ewma[9];
  features[16] = Math.max(...ewma);
  features[17] = 1;
  return features;
}

/**
 * MODEL G — multinomial logistic regression trained with deterministic
 * full-batch gradient descent and L2 regularization. No randomness and no
 * future information: sample `index` only ever uses digits up to `index`.
 */
export function trainSoftmaxClassifier(digits: readonly number[], horizon: number, options: { epochs?: number; learningRate?: number; l2?: number; minimumSamples?: number } = {}): { weights: number[][]; samples: number; initialLoss: number; finalLoss: number } | null {
  const epochs = options.epochs ?? 120;
  const learningRate = options.learningRate ?? 0.35;
  const l2 = options.l2 ?? 0.01;
  const minimumSamples = options.minimumSamples ?? 120;
  const samples: { features: number[]; target: number }[] = [];
  for (let index = 40; index + horizon < digits.length; index += 1) {
    samples.push({ features: digitFeatures(digits, index), target: digits[index + horizon] });
  }
  if (samples.length < minimumSamples) return null;
  const weights = Array.from({ length: 10 }, () => Array<number>(FEATURE_WIDTH).fill(0));
  let previousLoss = Number.POSITIVE_INFINITY;
  let initialLoss = Number.POSITIVE_INFINITY;
  let finalLoss = Number.POSITIVE_INFINITY;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Array.from({ length: 10 }, () => Array<number>(FEATURE_WIDTH).fill(0));
    let loss = 0;
    for (const sample of samples) {
      const logits = weights.map((row) => sum(row.map((weight, index) => weight * sample.features[index])));
      const probabilities = softmax(logits);
      loss += -Math.log(clamp(probabilities[sample.target], 1e-12, 1));
      for (let digit = 0; digit < 10; digit += 1) {
        const error = probabilities[digit] - Number(digit === sample.target);
        if (error === 0) continue;
        const row = gradient[digit];
        for (let index = 0; index < FEATURE_WIDTH; index += 1) row[index] += error * sample.features[index];
      }
    }
    loss /= samples.length;
    if (epoch === 0) initialLoss = loss;
    finalLoss = loss;
    const scale = learningRate / samples.length;
    for (let digit = 0; digit < 10; digit += 1) {
      for (let index = 0; index < FEATURE_WIDTH; index += 1) {
        const penalty = index === FEATURE_WIDTH - 1 ? 0 : l2 * weights[digit][index];
        weights[digit][index] -= scale * (gradient[digit][index] + penalty * samples.length);
      }
    }
    if (Math.abs(previousLoss - loss) < 1e-7) break;
    previousLoss = loss;
  }
  return { weights, samples: samples.length, initialLoss, finalLoss };
}

function fitClassifier(digits: readonly number[], horizon: number): FittedModel {
  const trained = trainSoftmaxClassifier(digits, horizon);
  return {
    key: 'G',
    label: MODEL_LABELS.G,
    kind: 'ml',
    trainingSample: trained?.samples ?? 0,
    predict: (context) => {
      if (!trained) return { probabilities: null, support: 0, note: 'Not enough training samples for the classifier.' };
      if (context.length < 41) return { probabilities: null, support: 0, note: 'Context is too short for the classifier features.' };
      const features = digitFeatures(context, context.length - 1);
      const logits = trained.weights.map((row) => sum(row.map((weight, index) => weight * features[index])));
      return {
        probabilities: softmax(logits),
        support: trained.samples,
        note: `${trained.samples} training samples; loss ${trained.initialLoss.toFixed(4)} → ${trained.finalLoss.toFixed(4)}.`,
      };
    },
  };
}

/** Weights capped so no single model can dominate the ensemble. */
/**
 * Minimum relative Brier improvement over the rolling baseline before a model is
 * allowed any ensemble weight at all. Below this the "improvement" is not
 * distinguishable from sampling noise, so the model is disabled instead of being
 * given a weight that would dress up luck as skill.
 */
export const MIN_TUNING_SKILL = 0.02;

export function cappedWeights(strengths: readonly number[], cap = 0.4): number[] {
  const total = sum(strengths.map((value) => Math.max(0, value)));
  if (total <= 0) return strengths.map(() => 0);
  const weights = strengths.map((value) => Math.max(0, value) / total);
  // Redistribute anything above the cap over the remaining models.
  for (let pass = 0; pass < 5; pass += 1) {
    const over = weights.map((weight, index) => (weight > cap && strengths[index] > 0 ? index : -1)).filter((index) => index >= 0);
    if (!over.length) break;
    let excess = 0;
    for (const index of over) {
      excess += weights[index] - cap;
      weights[index] = cap;
    }
    const receivers = weights.map((weight, index) => (weight > 0 && weight < cap && strengths[index] > 0 ? index : -1)).filter((index) => index >= 0);
    const receiverTotal = sum(receivers.map((index) => weights[index]));
    if (!receivers.length || receiverTotal <= 0) break;
    for (const index of receivers) weights[index] += (excess * weights[index]) / receiverTotal;
  }
  const normalized = sum(weights);
  return normalized > 0 ? weights.map((weight) => weight / normalized) : weights;
}

function evaluate(engines: FittedModel[], sequence: readonly number[], start: number, end: number, horizon: number): WalkForwardPoint[] {
  const rows: WalkForwardPoint[] = [];
  for (let origin = start; origin + horizon < end; origin += Math.max(1, horizon)) {
    const context = sequence.slice(0, origin + 1);
    rows.push({
      origin,
      targetIndex: origin + horizon,
      target: sequence[origin + horizon],
      baseline: baselineForecast(context),
      forecasts: engines.map((engine) => engine.predict(context)),
    });
  }
  return rows;
}

function scoreForecast(points: readonly WalkForwardPoint[], index: number): { sample: number; brier: number | null; logLoss: number | null; calibration: number | null } {
  const usable = points.filter((point) => point.forecasts[index].probabilities !== null);
  if (!usable.length) return { sample: 0, brier: null, logLoss: null, calibration: null };
  const brier = mean(usable.map((point) => brierScore(point.forecasts[index].probabilities!, point.target)));
  const logLoss = mean(usable.map((point) => logLossScore(point.forecasts[index].probabilities!, point.target)));
  const predictions: number[] = [];
  const outcomes: boolean[] = [];
  for (const point of usable) {
    const probabilities = point.forecasts[index].probabilities!;
    for (let digit = 0; digit < 10; digit += 1) {
      predictions.push(probabilities[digit]);
      outcomes.push(digit === point.target);
    }
  }
  return { sample: usable.length, brier, logLoss, calibration: calibrationReport(predictions, outcomes).expectedCalibrationError };
}

function combine(forecasts: readonly ModelForecast[], weights: readonly number[], baseline: readonly number[], shrink: number): number[] {
  const usable = forecasts.map((forecast, index) => (forecast.probabilities ? Math.max(0, weights[index]) : 0));
  const total = sum(usable);
  if (total <= 0) return [...baseline];
  const normalized = usable.map((weight) => weight / total);
  const model = normalize(UNIFORM.map((_, digit) => sum(forecasts.map((forecast, index) => (forecast.probabilities?.[digit] ?? 0) * normalized[index]))));
  return mix(model, baseline, 1 - shrink);
}

export type ModelTrainingInput = {
  symbol: string;
  digits: readonly number[];
  horizon: number;
  now: number;
  /** Minimum non-overlapping tuning and holdout origins required. */
  minimumOrigins?: number;
  /** Directory of rolling windows to consider for model D. */
  candidateWindows?: readonly number[];
};

/**
 * Trains, tunes and validates models A–G, then weights them into ensemble H.
 * Chronology: 60% train, 20% tuning, 20% holdout, with evaluation origins
 * spaced by the tick horizon so overlapping outcomes are not double counted.
 */
export function trainModelFamily(input: ModelTrainingInput): ModelReport {
  const minimumOrigins = input.minimumOrigins ?? 30;
  const sequence = input.digits.filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9);
  const horizon = Math.max(1, Math.floor(input.horizon));
  const trainEnd = Math.floor(sequence.length * 0.6);
  const tuningEnd = Math.floor(sequence.length * 0.8);
  const train = sequence.slice(0, trainEnd);

  const engines: FittedModel[] = [
    fitSmoothedBaseline(100),
    fitBayesianModel(150),
    fitTransitionModel(1, 20),
    fitRollingWindow(train, horizon, input.candidateWindows ?? [25, 50, 100, 250, 500, 1_000]),
    fitExponentialModel(train, horizon),
    fitPatternModel(2, 12),
    fitClassifier(train, horizon),
  ];

  // Shrinkage toward the rolling baseline is derived from the training segment
  // only, so the holdout cannot influence any weight or blend decision.
  const baselineWeight = clamp(0.15 + 0.25 * uniformityOf(train), 0.15, 0.45);
  const tuning = evaluate(engines, sequence, trainEnd, tuningEnd, horizon);
  const holdout = evaluate(engines, sequence, tuningEnd, sequence.length, horizon);
  const baselineTuningLoss = tuning.length ? mean(tuning.map((point) => brierScore(point.baseline, point.target))) : null;
  const baselineHoldoutLoss = holdout.length ? mean(holdout.map((point) => brierScore(point.baseline, point.target))) : null;

  const tuningScores = engines.map((_, index) => scoreForecast(tuning, index));
  const holdoutScores = engines.map((_, index) => scoreForecast(holdout, index));

  const strengths = engines.map((engine, index) => {
    const tuningScore = tuningScores[index];
    if (tuningScore.brier === null || baselineTuningLoss === null || baselineTuningLoss <= 1e-9) return 0;
    if (tuningScore.sample < minimumOrigins) return 0;
    const skill = 1 - tuningScore.brier / baselineTuningLoss;
    // Weight is skill × coverage. A confident model with no skill gets nothing,
    // and a model whose improvement over the baseline is down in the noise of its
    // own sampling error is treated as no skill rather than a small one.
    if (skill < MIN_TUNING_SKILL) return 0;
    return skill * (tuningScore.sample / Math.max(1, tuning.length));
  });
  const weights = cappedWeights(strengths);

  // The holdout check uses the exact combination that would have been deployed
  // at that moment: same model weights, same shrinkage.
  const checkedHoldout = holdout.map((point) => ({ ...point, ensemble: combine(point.forecasts, weights, point.baseline, 1 - baselineWeight) }));
  const improvements = checkedHoldout.map((point) => brierScore(point.baseline, point.target) - brierScore(point.ensemble, point.target));
  const improvement = improvements.length > 1 ? improvementSummary(improvements) : { mean: 0, standardError: Number.POSITIVE_INFINITY, lower: Number.NEGATIVE_INFINITY };
  const ensembleBrier = checkedHoldout.length ? mean(checkedHoldout.map((point) => brierScore(point.ensemble, point.target))) : null;
  const validationPassed = checkedHoldout.length >= minimumOrigins && improvement.lower > 0;

  const liveForecasts = engines.map((engine) => engine.predict(sequence));
  const baseline = baselineForecast(sequence);
  const ensembleProbabilities = combine(liveForecasts, weights, baseline, 1 - baselineWeight);

  const activeWeight = sum(liveForecasts.map((forecast, index) => (forecast.probabilities ? weights[index] : 0)));
  const dispersion = activeWeight > 0
    ? Math.sqrt(sum(liveForecasts.map((forecast, index) => {
      if (!forecast.probabilities || weights[index] <= 0) return 0;
      const weight = weights[index] / activeWeight;
      return weight * sum(forecast.probabilities.map((probability, digit) => (probability - ensembleProbabilities[digit]) ** 2));
    })))
    : 0;

  const models: ModelEvidence[] = engines.map((engine, index) => {
    const tuningScore = tuningScores[index];
    const holdoutScore = holdoutScores[index];
    const skill = tuningScore.brier !== null && baselineTuningLoss !== null && baselineTuningLoss > 1e-9 ? 1 - tuningScore.brier / baselineTuningLoss : null;
    const holdoutSkill = holdoutScore.brier !== null && baselineHoldoutLoss !== null && baselineHoldoutLoss > 1e-9 ? 1 - holdoutScore.brier / baselineHoldoutLoss : null;
    const liveForecast = liveForecasts[index];
    const status: ModelEvidence['status'] = !liveForecast.probabilities || tuningScore.sample < minimumOrigins
      ? 'sparse'
      : weights[index] > 0.005 ? 'contributing' : 'no-skill';
    return {
      key: engine.key,
      label: engine.label,
      kind: engine.kind,
      probabilities: liveForecast.probabilities,
      support: liveForecast.support,
      trainingSample: engine.trainingSample,
      tuningSample: tuningScore.sample,
      tuningBrier: tuningScore.brier,
      tuningLogLoss: tuningScore.logLoss,
      tuningCalibrationError: tuningScore.calibration,
      validationSample: holdoutScore.sample,
      validationBrier: holdoutScore.brier,
      validationLogLoss: holdoutScore.logLoss,
      validationCalibrationError: holdoutScore.calibration,
      baselineBrier: baselineHoldoutLoss,
      skill: holdoutSkill,
      improvementLower: holdoutSkill,
      weight: weights[index] * (1 - baselineWeight),
      status,
      note: liveForecast.note,
    };
  });

  const ensemble: EnsembleFinding = {
    symbol: input.symbol,
    probabilities: ensembleProbabilities,
    baselineProbabilities: baseline,
    baselineWeight,
    agreement: activeWeight > 0 ? capAgreement(liveForecasts, weights, ensembleProbabilities) : 0,
    dispersion,
    supportingModels: liveForecasts.filter((forecast, index) => forecast.probabilities !== null && weights[index] > 0).length,
    horizon,
    valid: validationPassed,
    validationSkill: ensembleBrier !== null && baselineHoldoutLoss !== null && baselineHoldoutLoss > 1e-9 ? 1 - ensembleBrier / baselineHoldoutLoss : null,
    validationBrier: ensembleBrier,
    baselineBrier: baselineHoldoutLoss,
    improvementLower: improvements.length > 1 ? improvement.lower : null,
    reason: validationPassed
      ? ''
      : checkedHoldout.length < minimumOrigins
        ? `Need ${minimumOrigins} non-overlapping holdout outcomes; have ${checkedHoldout.length}.`
        : 'The combined model did not establish held-out improvement over the rolling frequency baseline.',
  };

  return {
    symbol: input.symbol,
    sample: sequence.length,
    horizon,
    trainEnd,
    tuningEnd,
    tuningOrigins: tuning.length,
    holdoutOrigins: checkedHoldout.length,
    models,
    ensemble,
    fittedAt: input.now,
    fingerprint: `${input.symbol}:${sequence.length}:${horizon}:${sequence.at(-1) ?? -1}`,
  };
}

function uniformityOf(digits: readonly number[]): number {
  const counts = countsOf(digits.slice(-1_000));
  const total = sum(counts);
  if (!total) return 1;
  const probabilities = counts.map((count) => count / total);
  const entropy = -sum(probabilities.map((probability) => (probability > 0 ? probability * Math.log2(probability) : 0)));
  return clamp(entropy / Math.log2(10), 0, 1);
}

function capAgreement(forecasts: readonly ModelForecast[], weights: readonly number[], ensemble: readonly number[]): number {
  const active = forecasts.map((forecast, index) => ({ forecast, weight: weights[index] })).filter((row) => row.forecast.probabilities !== null && row.weight > 0);
  const total = sum(active.map((row) => row.weight));
  if (!total) return 0;
  let agreeing = 0;
  for (const row of active) {
    const probabilities = row.forecast.probabilities!;
    const distance = sum(probabilities.map((probability, digit) => Math.abs(probability - ensemble[digit])));
    // Half the total-variation distance: 1 means identical, 0 means disjoint.
    agreeing += row.weight * clamp(1 - distance / 2, 0, 1);
  }
  return agreeing / total;
}

/** Cheap change detector so the caller only refits when it matters. */
export function needsRefit(report: ModelReport | null, symbol: string, tickCount: number, horizon: number): boolean {
  if (!report) return true;
  if (report.symbol !== symbol) return true;
  if (report.horizon !== horizon) return true;
  return Math.abs(tickCount - report.sample) >= 25;
}
