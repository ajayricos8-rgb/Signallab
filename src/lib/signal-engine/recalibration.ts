// Layer 3b — PRECISION RECALIBRATION.
//
// `stats.ts` calibrates a probability with one chronological 50/50 split: the
// calibrator is fitted on the older half and scored on the newer half. That is
// honest but wasteful and imprecise —
//   * the deployed calibrator only ever sees half of the available rows, so the
//     mapping it learns is noisy (low precision);
//   * the skill that decides whether to accept it is measured on the other half
//     only, so a real improvement is often lost in the noise of ~40 rows and the
//     calibration is rejected — leaving the raw, uncalibrated estimate in place
//     (low accuracy).
//
// This module replaces that single split with PURGED WALK-FORWARD
// CROSS-VALIDATION, the standard causal scheme for time-ordered rows:
//
//   fold 1: train [0, a)          → predict [a, b)
//   fold 2: train [0, b)          → predict [b, c)
//   ...
//
// Every row after a minimum training size receives a prediction from a model
// that never saw it, so:
//   1. the skill, reliability and error numbers are measured on (nearly) every
//      row instead of half of them — a far more precise estimate;
//   2. the method (identity / Platt / isotonic / a shrunk blend) is chosen by
//      out-of-fold Brier over the whole sample instead of one lucky half;
//   3. the calibrator that is finally deployed is refitted on ALL rows, so it
//      is fitted on twice as much data as before.
//
// `embargo` drops the rows immediately after each training block as well, so no
// label that straddles a fold boundary leaks into the fold that scores it.
//
// Everything here is deterministic, allocation-light and worker-safe.
import {
  brierScore, clamp, fitIsotonic, fitLogistic, mean, pairedImprovementZ, standardDeviation,
  type CalibrationPoint, type LogisticModel,
} from './stats.ts';

export type Predictor = (probability: number) => number;

export const CALIBRATION_EPSILON = 1e-4;
const identity: Predictor = (probability) => clamp(probability, CALIBRATION_EPSILON, 1 - CALIBRATION_EPSILON);

/** Clamp into a probability range that stays invertible in logit space. */
export function safeProbability(value: number, epsilon = CALIBRATION_EPSILON): number {
  return Number.isFinite(value) ? clamp(value, epsilon, 1 - epsilon) : 0.5;
}

const logit = (probability: number) => Math.log(safeProbability(probability) / (1 - safeProbability(probability)));

// ---- reliability diagnostics ------------------------------------------------

export type CalibrationBin = {
  /** Mean forecast probability inside the bin. */
  forecast: number;
  /** Observed win frequency inside the bin. */
  observed: number;
  sample: number;
  /** Squared difference the bin contributes to the reliability term. */
  gap: number;
  /** Var(forecast | bin) − 2·Cov(forecast, outcome | bin). */
  residual: number;
};

export type ReliabilityReport = {
  sample: number;
  /** Mean squared error of the forecasts. */
  brier: number;
  /**
   * Exact Murphy (1973) decomposition over the bins below:
   *   brier = reliability − resolution + uncertainty + withinBinResidual.
   * The last term is the spread of forecasts inside a bin. Reporting it
   * separately makes the identity hold to machine precision, which it does not
   * when the raw unbinned Brier is compared to binned reliability terms.
   */
  reliability: number;
  resolution: number;
  uncertainty: number;
  /**
   * Weighted mean of `Var(forecast | bin) − 2·Cov(forecast, outcome | bin)`:
   * the part of the Brier score binning cannot attribute to reliability or
   * resolution. Negative when the forecast still separates wins from losses
   * *inside* a bin, which is discrimination the binning deliberately discards.
   */
  withinBinResidual: number;
  /** 1 − brier / uncertainty. Higher is better; 0 means "no better than the base rate". */
  brierSkillScore: number | null;
  /** Sample-weighted mean |forecast − observed| across equal-count bins. */
  expectedCalibrationError: number | null;
  maximumCalibrationError: number | null;
  /** Cox recalibration: logit(y) ≈ intercept + slope · logit(p). 1 and 0 are perfect. */
  slope: number | null;
  intercept: number | null;
  /**
   * Bias-corrected reliability, expressed in probability units: the root of
   * Σ w·[(forecast − observed)² − observed(1−observed)/(n−1)] over the bins.
   *
   * The raw reliability term above is inflated by the sampling noise of each
   * bin's own observed frequency, which is large when a bin holds only a few
   * dozen rows — enough to make a perfectly calibrated model look 7 points off.
   * Subtracting that noise leaves the part that is genuinely miscalibration,
   * and THIS is the number the precision layer should put in an error bar.
   */
  miscalibration: number;
  /** Rows per reliability bin (the precision of `miscalibration` depends on it). */
  binSample: number;
  /** Standard deviation of the issued forecasts (higher = sharper, riskier). */
  sharpness: number;
  /** Mean forecast minus observed base rate: >0 means the model is optimistic. */
  bias: number;
  /** Equal-count reliability bins, ordered by forecast value. */
  bins: CalibrationBin[];
};

/**
 * Equal-count (quantile) reliability bins. Equal-count bins keep every bin's
 * observed frequency equally noisy, which makes the expected calibration error
 * comparable across contracts with very different probability ranges.
 */
export function calibrationBins(points: readonly CalibrationPoint[], bins = 8): CalibrationBin[] {
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  if (usable.length < 12) return [];
  const count = Math.max(2, Math.min(bins, Math.floor(usable.length / 6)));
  const sorted = usable
    .map((point) => ({ probability: safeProbability(point.probability), won: point.won }))
    .sort((left, right) => left.probability - right.probability);
  const width = sorted.length / count;
  const output: CalibrationBin[] = [];
  for (let bin = 0; bin < count; bin += 1) {
    const start = Math.floor(bin * width);
    const end = bin === count - 1 ? sorted.length : Math.floor((bin + 1) * width);
    const members = sorted.slice(start, end);
    if (!members.length) continue;
    const forecast = mean(members.map((point) => point.probability));
    const observed = mean(members.map((point) => point.won));
    let variance = 0;
    let covariance = 0;
    for (const member of members) {
      variance += (member.probability - forecast) ** 2;
      covariance += (member.probability - forecast) * (member.won - observed);
    }
    const memberCount = members.length;
    variance = memberCount ? variance / memberCount : 0;
    covariance = memberCount ? covariance / memberCount : 0;
    output.push({ forecast, observed, sample: memberCount, gap: (forecast - observed) ** 2, residual: variance - 2 * covariance });
  }
  return output;
}

/**
 * Full Murphy decomposition of the Brier score plus the Cox recalibration
 * slope/intercept. The terms answer different questions:
 *   reliability        — is the number on the screen the true frequency? (accuracy)
 *   resolution         — does the forecast separate wins from losses at all? (skill)
 *   uncertainty        — how hard is the outcome itself, independent of the model?
 *   withinBinResidual  — what binning cannot attribute: forecast noise inside a
 *                        bin, less the discrimination still left inside it.
 */
export function reliabilityReport(points: readonly CalibrationPoint[], bins = 8): ReliabilityReport {
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  const sample = usable.length;
  const empty: ReliabilityReport = {
    sample, brier: 0, reliability: 0, resolution: 0, uncertainty: 0, withinBinResidual: 0,
    miscalibration: 0, binSample: 0,
    brierSkillScore: null, expectedCalibrationError: null, maximumCalibrationError: null,
    slope: null, intercept: null, sharpness: 0, bias: 0, bins: [],
  };
  if (sample < 8) return empty;
  // Clamp once and use the same values everywhere: the decomposition is an
  // algebraic identity, so a mismatch between the clamped Brier and unclamped
  // bin statistics would break it in the last decimal place.
  const probabilities = usable.map((point) => safeProbability(point.probability));
  const outcomes = usable.map((point) => point.won);
  const brier = mean(probabilities.map((probability, index) => (probability - outcomes[index]) ** 2));
  const baseRate = mean(outcomes);
  const uncertainty = baseRate * (1 - baseRate);
  const groups = calibrationBins(usable, bins);
  let reliability = 0;
  let resolution = 0;
  let withinBinResidual = 0;
  let expectedCalibrationError = 0;
  let maximumCalibrationError = 0;
  let miscalibrationVariance = 0;
  let miscalibrationNoise = 0;
  for (const bin of groups) {
    const weight = bin.sample / sample;
    reliability += weight * bin.gap;
    resolution += weight * (bin.observed - baseRate) ** 2;
    withinBinResidual += weight * bin.residual;
    expectedCalibrationError += weight * Math.abs(bin.forecast - bin.observed);
    maximumCalibrationError = Math.max(maximumCalibrationError, Math.abs(bin.forecast - bin.observed));
    // Expected squared gap from the bin's own sampling noise alone. Clipping
    // each bin at zero separately would leave a positive floor — about half the
    // noise survives whenever the gap and the noise are the same size — so the
    // noise is pooled and the clip is applied once, at the end.
    const noise = bin.sample > 1 ? (bin.observed * (1 - bin.observed)) / (bin.sample - 1) : 0;
    miscalibrationVariance += weight * (bin.gap - noise);
    miscalibrationNoise += weight ** 2 * 2 * noise ** 2;
  }
  // One standard error is subtracted as well: a well-calibrated model's measured
  // miscalibration is a small positive number purely by chance, and pricing that
  // as if it were real would penalise the honest model for being measured.
  miscalibrationVariance = Math.max(0, miscalibrationVariance - Math.sqrt(miscalibrationNoise));
  const model = fitLogistic(usable.map((point) => [logit(point.probability)]), outcomes, { ridge: 1, minSample: 30, iterations: 14 });
  return {
    sample,
    brier,
    reliability,
    resolution,
    uncertainty,
    withinBinResidual,
    miscalibration: Math.sqrt(miscalibrationVariance),
    binSample: groups.length ? sample / groups.length : 0,
    brierSkillScore: uncertainty > 1e-9 ? 1 - brier / uncertainty : null,
    expectedCalibrationError: groups.length ? expectedCalibrationError : null,
    maximumCalibrationError: groups.length ? maximumCalibrationError : null,
    slope: model ? model.coefficients[1] ?? null : null,
    intercept: model ? model.coefficients[0] ?? null : null,
    sharpness: standardDeviation(probabilities),
    bias: mean(probabilities) - baseRate,
    bins: groups,
  };
}

/**
 * Cox recalibration slope. slope < 1 means the forecast is too extreme
 * (overconfident) and should be shrunk toward the base rate; slope > 1 means it
 * is too flat and could be sharpened. It is the single most interpretable
 * accuracy diagnostic for a probability stream.
 */
export function calibrationSlope(points: readonly CalibrationPoint[]): number | null {
  if (points.length < 40) return null;
  const model = fitLogistic(points.map((point) => [logit(point.probability)]), points.map((point) => point.won), { ridge: 1, minSample: 30, iterations: 14 });
  return model ? model.coefficients[1] ?? null : null;
}

// ---- calibrators ------------------------------------------------------------

export type PlattFit = {
  predict: Predictor;
  model: LogisticModel | null;
  slope: number | null;
  intercept: number | null;
  sample: number;
};

/**
 * Platt scaling fitted on the log-odds of the forecast. Fitting on the raw
 * probability (which the older code did) can only express a straight line and
 * misses the sigmoid-shaped miscalibration that overconfident models produce;
 * fitting on logit(p) is the standard, strictly more expressive form.
 */
export function fitPlatt(points: readonly CalibrationPoint[]): PlattFit {
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  const model = usable.length >= 30
    ? fitLogistic(usable.map((point) => [logit(point.probability)]), usable.map((point) => point.won), { ridge: 1, minSample: 30, iterations: 14 })
    : null;
  if (!model) return { predict: identity, model: null, slope: null, intercept: null, sample: usable.length };
  const slope = model.coefficients[1] ?? null;
  const intercept = model.coefficients[0] ?? null;
  return {
    predict: (probability) => safeProbability(model.predict([logit(probability)])),
    model, slope, intercept, sample: usable.length,
  };
}

export type IsotonicFit = { predict: Predictor; blocks: number; sample: number };

/**
 * Pool-adjacent-violators isotonic regression. Monotone and therefore able to
 * express any shape, but unregularized: on small samples it chases the noise in
 * each bin. Callers blend it toward a parametric fit with a weight chosen
 * out of fold (see `blendPredictors`).
 */
export function fitIsotonicCalibrator(points: readonly CalibrationPoint[], bins = 10): IsotonicFit {
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  if (usable.length < 20) return { predict: identity, blocks: 0, sample: usable.length };
  const fitted = fitIsotonic(usable, bins);
  return { predict: (probability) => safeProbability(fitted.predict(probability)), blocks: fitted.blocks, sample: usable.length };
}

/** Convex blend of two calibrators; lambda = 0 keeps `left`, 1 keeps `right`. */
export function blendPredictors(left: Predictor, right: Predictor, lambda: number): Predictor {
  const weight = clamp(lambda, 0, 1);
  if (weight <= 0) return left;
  if (weight >= 1) return right;
  return (probability) => safeProbability((1 - weight) * left(probability) + weight * right(probability));
}

// ---- purged walk-forward cross-validation -----------------------------------

export type Fold = { train: readonly CalibrationPoint[]; test: readonly CalibrationPoint[] };

/**
 * Chronological fold boundaries for `sample` rows.
 *
 * `minimumTraining` rows are always reserved for the first fit; the remaining
 * rows are split into `folds` contiguous test blocks. `embargo` rows after each
 * training block are dropped from BOTH sides so a label that straddles a
 * boundary can never inform the fold that scores it.
 */
export function purgedFolds(
  sample: number,
  options: { folds?: number; minimumTraining?: number; embargo?: number } = {},
): Array<{ trainStart: number; trainEnd: number; testStart: number; testEnd: number }> {
  if (sample < 20) return [];
  const embargo = Math.max(0, Math.floor(options.embargo ?? 1));
  const folds = clamp(Math.round(options.folds ?? Math.min(6, Math.max(3, Math.round(sample / 60)))), 2, 8);
  const minimumTraining = Math.max(24, Math.floor(options.minimumTraining ?? Math.max(30, sample * 0.3)));
  const span = sample - minimumTraining;
  if (span < folds * 2) return [];
  const step = span / folds;
  const output: Array<{ trainStart: number; trainEnd: number; testStart: number; testEnd: number }> = [];
  for (let fold = 0; fold < folds; fold += 1) {
    const testStart = Math.round(minimumTraining + fold * step);
    const testEnd = fold === folds - 1 ? sample : Math.round(minimumTraining + (fold + 1) * step);
    const trainEnd = testStart - embargo;
    if (trainEnd - minimumTraining < 8 || testEnd - testStart < 6) continue;
    output.push({ trainStart: 0, trainEnd, testStart, testEnd });
  }
  return output;
}

export function foldSlices(points: readonly CalibrationPoint[], options?: { folds?: number; minimumTraining?: number; embargo?: number }): Fold[] {
  return purgedFolds(points.length, options).map(({ trainStart, trainEnd, testStart, testEnd }) => ({
    train: points.slice(trainStart, trainEnd),
    test: points.slice(testStart, testEnd),
  }));
}

export type CandidateCalibrator = {
  id: 'none' | 'platt' | 'isotonic' | 'isotonic+platt' | 'shrunk-isotonic';
  predict: Predictor;
};

/**
 * The candidate set scored out of fold. `none` is in the set on purpose: a
 * calibrator only earns its place by beating the raw probability on rows it has
 * never seen, which is what keeps this layer from manufacturing accuracy.
 */
export function candidateCalibrators(points: readonly CalibrationPoint[], bins = 10): CandidateCalibrator[] {
  const platt = fitPlatt(points);
  const isotonic = fitIsotonicCalibrator(points, bins);
  return [
    { id: 'none', predict: identity },
    { id: 'platt', predict: platt.predict },
    { id: 'isotonic', predict: isotonic.predict },
    { id: 'isotonic+platt', predict: blendPredictors(isotonic.predict, platt.predict, 0.5) },
    { id: 'shrunk-isotonic', predict: blendPredictors(isotonic.predict, platt.predict, 0.75) },
  ];
}

export type CalibrationCandidateScore = {
  id: CandidateCalibrator['id'];
  brier: number;
  /** 1 − brier / rawBrier over every out-of-fold row. */
  skill: number;
  pairedZ: number;
  evaluationSample: number;
};

export type CrossValidatedCalibration = {
  /** Out-of-fold calibrated probability for every row that received one. */
  outOfFold: number[];
  /** Row indices (into the input) the out-of-fold values belong to. */
  outOfFoldIndices: number[];
  /** Raw probability for the same rows, in the same order. */
  rawOutOfFold: number[];
  /** Outcomes for the same rows, in the same order. */
  labels: number[];
  evaluationSample: number;
  rawBrier: number | null;
  scores: CalibrationCandidateScore[];
  /** The candidate with the lowest out-of-fold Brier (never `none` by preference). */
  best: CandidateCalibrator['id'];
  /** Lowest out-of-fold Brier across all candidates. */
  bestBrier: number | null;
  /** Skill of the chosen candidate versus the raw probability. */
  skill: number;
  pairedZ: number;
};

/**
 * Score every candidate calibrator by purged walk-forward cross-validation.
 *
 * Each fold fits the candidate on all rows strictly before the fold (less the
 * embargo) and predicts the fold's rows, so the returned Brier numbers are
 * genuinely out of sample and use roughly `folds − 1` times more evaluation
 * rows than a single 50/50 split.
 */
export function crossValidateCalibration(
  points: readonly CalibrationPoint[],
  options: { folds?: number; minimumTraining?: number; embargo?: number; bins?: number } = {},
): CrossValidatedCalibration {
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  const empty: CrossValidatedCalibration = {
    outOfFold: [], outOfFoldIndices: [], rawOutOfFold: [], labels: [], evaluationSample: 0,
    rawBrier: null, scores: [], best: 'none', bestBrier: null, skill: 0, pairedZ: 0,
  };
  const folds = foldSlices(usable, options);
  if (!folds.length) return empty;

  const outOfFoldIndices: number[] = [];
  const rawOutOfFold: number[] = [];
  const labels: number[] = [];
  const perCandidate = new Map<CandidateCalibrator['id'], number[]>();
  const rawErrors: number[] = [];
  // Candidates are fitted per fold; store them so the winning method can be
  // replayed without refitting.
  const foldCandidates: CandidateCalibrator[][] = [];

  for (const fold of folds) {
    const candidates = candidateCalibrators(fold.train, options.bins ?? 10);
    foldCandidates.push(candidates);
    for (const candidate of candidates) if (!perCandidate.has(candidate.id)) perCandidate.set(candidate.id, []);
    for (let offset = 0; offset < fold.test.length; offset += 1) {
      const point = fold.test[offset];
      const raw = safeProbability(point.probability);
      rawOutOfFold.push(raw);
      labels.push(point.won);
      outOfFoldIndices.push(rawOutOfFold.length - 1);
      rawErrors.push((raw - point.won) ** 2);
      for (const candidate of candidates) perCandidate.get(candidate.id)!.push((safeProbability(candidate.predict(raw)) - point.won) ** 2);
    }
  }
  if (!outOfFoldIndices.length) return empty;
  const rawBrier = mean(rawErrors);
  const scores: CalibrationCandidateScore[] = [...perCandidate.entries()].map(([id, errors]) => {
    const brier = mean(errors);
    return {
      id,
      brier,
      skill: rawBrier > 1e-12 ? 1 - brier / rawBrier : 0,
      pairedZ: pairedImprovementZ(rawErrors, errors),
      evaluationSample: errors.length,
    };
  });
  scores.sort((left, right) => left.brier - right.brier);
  const best = scores[0];
  const outOfFold: number[] = [];
  folds.forEach((fold, foldIndex) => {
    const candidates = foldCandidates[foldIndex];
    const chosen = candidates.find((candidate) => candidate.id === best.id) ?? candidates[0];
    for (const point of fold.test) outOfFold.push(safeProbability(chosen.predict(safeProbability(point.probability))));
  });
  return {
    outOfFold, outOfFoldIndices, rawOutOfFold, labels,
    evaluationSample: outOfFold.length,
    rawBrier,
    scores,
    best: best.id,
    bestBrier: best.brier,
    skill: best.skill,
    pairedZ: best.pairedZ,
  };
}

// ---- the production entry point --------------------------------------------

export type RecalibrationResult = {
  method: CandidateCalibrator['id'];
  /** Rows available for calibration. */
  sample: number;
  /** Rows that received an out-of-fold prediction (the evaluation set). */
  evaluationSample: number;
  folds: number;
  brierBefore: number | null;
  brierAfter: number | null;
  /** 1 − brierAfter / brierBefore measured out of fold. */
  skill: number;
  pairedZ: number;
  improved: boolean;
  slope: number | null;
  intercept: number | null;
  /** Reliability of the RAW probabilities, measured out of fold. */
  raw: ReliabilityReport;
  /** Reliability of the CALIBRATED probabilities, measured out of fold. */
  calibrated: ReliabilityReport;
  predict: Predictor;
};

export type RecalibrationOptions = {
  minimum?: number;
  minimumEvaluation?: number;
  /** Relative Brier improvement required before a calibration is accepted. */
  minimumImprovement?: number;
  /** Paired z required before a calibration is accepted. */
  minimumZ?: number;
  folds?: number;
  embargo?: number;
  bins?: number;
};

/**
 * Cross-validated recalibration with a full reliability audit.
 *
 * 1. every candidate is scored by purged walk-forward CV;
 * 2. the winner is accepted only when it beats the raw probability by both a
 *    material margin and a paired z on rows it never saw;
 * 3. the accepted method is refitted on every row for live use — twice the data
 *    the old single split gave it, which is where the extra precision comes from;
 * 4. the reported skill, reliability and slope stay the out-of-fold numbers.
 */
export function recalibrate(points: readonly CalibrationPoint[], options: RecalibrationOptions = {}): RecalibrationResult {
  const minimum = options.minimum ?? 80;
  const minimumEvaluation = options.minimumEvaluation ?? 25;
  const minimumImprovement = options.minimumImprovement ?? 0.015;
  const minimumZ = options.minimumZ ?? 2.5;
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  const report = reliabilityReport(usable, options.bins ?? 8);
  const failure = (): RecalibrationResult => ({
    method: 'none', sample: usable.length, evaluationSample: 0, folds: 0,
    brierBefore: null, brierAfter: null, skill: 0, pairedZ: 0, improved: false,
    slope: null, intercept: null, raw: report, calibrated: report, predict: identity,
  });
  if (usable.length < minimum) return failure();

  const foldCount = purgedFolds(usable.length, { folds: options.folds, embargo: options.embargo }).length;
  const cv = crossValidateCalibration(usable, { folds: options.folds, embargo: options.embargo, bins: options.bins });
  if (!cv.evaluationSample || cv.evaluationSample < minimumEvaluation) return failure();

  const rawPoints: CalibrationPoint[] = cv.rawOutOfFold.map((probability, index) => ({ probability, won: cv.labels[index] as 0 | 1 }));
  const calibratedPoints: CalibrationPoint[] = cv.outOfFold.map((probability, index) => ({ probability, won: cv.labels[index] as 0 | 1 }));
  const rawReport = reliabilityReport(rawPoints, options.bins ?? 8);
  const improved = cv.best !== 'none' && cv.skill >= minimumImprovement && cv.pairedZ >= minimumZ;
  const method = improved ? cv.best : 'none';
  const calibratedReport = reliabilityReport(improved ? calibratedPoints : rawPoints, options.bins ?? 8);

  // Refit the accepted method on EVERY row. Its measured skill stays the
  // out-of-fold number, so this is a precision gain, not an optimistic one.
  let predict: Predictor = identity;
  if (improved) {
    const platt = fitPlatt(usable);
    const isotonic = fitIsotonicCalibrator(usable, options.bins ?? 10);
    if (method === 'platt') predict = platt.predict;
    else if (method === 'isotonic') predict = isotonic.predict;
    else if (method === 'isotonic+platt') predict = blendPredictors(isotonic.predict, platt.predict, 0.5);
    else if (method === 'shrunk-isotonic') predict = blendPredictors(isotonic.predict, platt.predict, 0.75);
  }
  const finalPlatt = fitPlatt(usable);
  return {
    method,
    sample: usable.length,
    evaluationSample: cv.evaluationSample,
    folds: foldCount,
    brierBefore: cv.rawBrier,
    brierAfter: improved ? cv.bestBrier : cv.rawBrier,
    skill: improved ? cv.skill : 0,
    pairedZ: cv.pairedZ,
    improved,
    slope: finalPlatt.slope,
    intercept: finalPlatt.intercept,
    raw: rawReport,
    calibrated: calibratedReport,
    predict,
  };
}

// ---- uncertainty ------------------------------------------------------------

export type ProbabilityInterval = {
  /** Point estimate. */
  probability: number;
  /** 95% interval for the true win rate behind that estimate. */
  lower: number;
  upper: number;
  /** Standard error of the estimate (probability units). */
  standardError: number;
  /** Rows behind the estimate. */
  sample: number;
  /** How the interval was produced. */
  method: 'local-mean' | 'forecast-variance' | 'binomial';
};

/**
 * Standard error of a forecast probability as an estimate of the true win rate.
 *
 * After an unbiased calibrator, Var(p̂ − θ) = Var(p)/n over independent rows
 * (decomposing p̂ − θ into the mean forecast error and the sampling error of the
 * outcome mean cancels every covariance term). Serial correlation inflates it,
 * so the variance is scaled by the Bartlett/Newey–West factor 1 + 2·ρ₁.
 *
 * A floor of the equivalent binomial error keeps a near-constant forecast from
 * reporting an interval far tighter than the outcome noise allows.
 */
export function forecastStandardError(points: readonly CalibrationPoint[]): number | null {
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  const n = usable.length;
  if (n < 20) return null;
  const probabilities = usable.map((point) => safeProbability(point.probability));
  const center = mean(probabilities);
  let variance = 0;
  let covariance = 0;
  for (let index = 0; index < n; index += 1) variance += (probabilities[index] - center) ** 2;
  for (let index = 1; index < n; index += 1) covariance += (probabilities[index] - center) * (probabilities[index - 1] - center);
  variance /= n;
  covariance /= n;
  const effectiveN = n / Math.max(1, 1 + 2 * Math.max(0, covariance / Math.max(1e-12, variance)));
  const baseRate = mean(usable.map((point) => point.won));
  const binomial = Math.sqrt(Math.max(1e-9, baseRate * (1 - baseRate)) / effectiveN);
  return Math.max(binomial, Math.sqrt(variance / effectiveN));
}

/**
 * Interval for the true win rate near `probability`, using a Nadaraya–Watson
 * local mean over the nearest rows in probability space (so the interval is
 * estimated where the signal actually sits, not averaged over the whole range).
 */
export function probabilityInterval(
  points: readonly CalibrationPoint[],
  probability: number,
  options: { neighbours?: number; z?: number } = {},
): ProbabilityInterval | null {
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  if (usable.length < 24) return null;
  const target = safeProbability(probability);
  const z = options.z ?? 1.96;
  const width = Math.max(0.02, Math.sqrt(Math.max(1e-9, target * (1 - target)) / Math.max(8, usable.length / 6)));
  const neighbours = usable
    .map((point) => ({ point, distance: Math.abs(safeProbability(point.probability) - target) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.max(24, Math.min(usable.length, Math.floor(options.neighbours ?? usable.length / 3))));
  let weightTotal = 0;
  let weightedOutcome = 0;
  let weightSquared = 0;
  for (const neighbour of neighbours) {
    const weight = Math.exp(-0.5 * (neighbour.distance / width) ** 2);
    weightTotal += weight;
    weightedOutcome += weight * neighbour.point.won;
    weightSquared += weight ** 2;
  }
  if (!(weightTotal > 1e-9)) return null;
  const observed = weightedOutcome / weightTotal;
  const effectiveN = Math.max(1, (weightTotal ** 2) / weightSquared);
  const standardError = Math.sqrt(Math.max(1e-9, observed * (1 - observed)) / effectiveN);
  return {
    probability: target,
    lower: safeProbability(observed - z * standardError),
    upper: safeProbability(observed + z * standardError),
    standardError,
    sample: neighbours.length,
    method: 'local-mean',
  };
}

/**
 * Shrink an edge by its own measurement error (minimum-MSE / James–Stein form
 * with a no-edge prior). `tau` is the true spread of edges across the candidate
 * pool: when edges are pure noise tau → 0 and every edge collapses to zero;
 * when real dispersion exists, precise edges survive and noisy ones do not.
 */
export function precisionShrinkage(edge: number, standardError: number | null, tau: number): number {
  if (!Number.isFinite(edge) || edge === 0) return 0;
  const sigma = Number.isFinite(standardError) && (standardError as number) > 0 ? (standardError as number) : 0;
  if (sigma <= 0) return edge;
  const variance = Math.max(0, tau) ** 2;
  return edge * (variance / (variance + sigma ** 2));
}
