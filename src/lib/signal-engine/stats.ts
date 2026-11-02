// Small, dependency-free statistics used by the deep analysis, confirmation
// and entry layers. Everything here is deterministic and worker-safe.
//
// The functions are deliberately conservative: every test returns the sample
// it used, its statistic and a two-sided p-value, so callers can require a
// material effect AND significance instead of treating a lucky histogram as a
// market edge. Calibration helpers are validated out of sample by their
// callers, never fitted and scored on the same rows.

export const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

export function standardDeviation(values: readonly number[]): number {
  return Math.sqrt(Math.max(0, variance(values)));
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function dot(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) total += left[index] * right[index];
  return total;
}

import { recalibrate, type ReliabilityReport } from './recalibration.ts';

// ---- distributions ---------------------------------------------------------

/** Lanczos approximation (g = 7, n = 9); relative error ~1e-13. */
export function logGamma(value: number): number {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value);
  const shifted = value - 1;
  let sumValue = coefficients[0];
  for (let index = 1; index < 9; index += 1) sumValue += coefficients[index] / (shifted + index);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sumValue);
}

/** Regularized lower incomplete gamma P(a, x). */
function gammaP(a: number, x: number): number {
  if (!(a > 0) || x < 0) return 0;
  if (x === 0) return 0;
  if (x < a + 1) {
    let term = 1 / a;
    let total = term;
    for (let index = 1; index < 300; index += 1) {
      term *= x / (a + index);
      total += term;
      if (Math.abs(term) < Math.abs(total) * 1e-14) break;
    }
    return clamp(total * Math.exp(-x + a * Math.log(x) - logGamma(a)), 0, 1);
  }
  return 1 - gammaQ(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) via Lentz's continued fraction. */
function gammaQ(a: number, x: number): number {
  if (!(a > 0) || x < 0) return 1;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaP(a, x);
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let index = 1; index < 300; index += 1) {
    const an = -index * (index - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return clamp(Math.exp(-x + a * Math.log(x) - logGamma(a)) * h, 0, 1);
}

/** Chi-square survival function (p-value). */
export function chiSquarePValue(statistic: number, degreesOfFreedom: number): number {
  if (!(statistic > 0) || !(degreesOfFreedom > 0)) return 1;
  return clamp(gammaQ(degreesOfFreedom / 2, statistic / 2), 0, 1);
}

export function erf(value: number): number {
  const signValue = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const tail = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return signValue * (1 - tail);
}

export function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

/** Two-sided normal p-value. */
export function normalPValue(zScore: number): number {
  if (!Number.isFinite(zScore)) return 1;
  return clamp(2 * (1 - normalCdf(Math.abs(zScore))), 0, 1);
}

/** Binomial tail probability for at least `hits` of `sample` at `rate`. */
export function binomialTail(hits: number, sample: number, rate: number): number {
  if (sample <= 0) return 1;
  const p = clamp(rate, 1e-9, 1 - 1e-9);
  let total = 0;
  let logTerm = sample * Math.log(1 - p);
  for (let k = 0; k <= sample; k += 1) {
    if (k >= hits) total += Math.exp(logTerm);
    logTerm += Math.log((sample - k) / (k + 1)) + Math.log(p) - Math.log(1 - p);
  }
  return clamp(total, 0, 1);
}

// ---- hypothesis tests ------------------------------------------------------

export type ChiSquareResult = {
  statistic: number;
  degreesOfFreedom: number;
  pValue: number;
  sample: number;
  effect: number;
};

/** Goodness of fit against an expected distribution (uniform by default). */
export function chiSquareGoodnessOfFit(counts: readonly number[], expected?: readonly number[]): ChiSquareResult {
  const sample = sum(counts);
  const target = expected ?? counts.map(() => sample / Math.max(1, counts.length));
  let statistic = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const expectedValue = target[index] ?? 0;
    if (expectedValue > 1e-9) statistic += (counts[index] - expectedValue) ** 2 / expectedValue;
  }
  const degreesOfFreedom = Math.max(1, counts.length - 1);
  // Cramér's V for a one-dimensional goodness-of-fit test.
  const effect = sample > 0 ? Math.sqrt(statistic / (sample * degreesOfFreedom)) : 0;
  return { statistic, degreesOfFreedom, pValue: chiSquarePValue(statistic, degreesOfFreedom), sample, effect };
}

/** Tests whether rows and columns of a contingency table are independent. */
export function chiSquareIndependence(table: readonly (readonly number[])[]): ChiSquareResult & { mutualInformationBits: number } {
  const rows = table.length;
  const columns = table[0]?.length ?? 0;
  const rowTotals = table.map((row) => sum(row));
  const columnTotals = Array.from({ length: columns }, (_, column) => sum(table.map((row) => row[column] ?? 0)));
  const sample = sum(rowTotals);
  let statistic = 0;
  let mutualInformationBits = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const expected = (rowTotals[row] * columnTotals[column]) / Math.max(1, sample);
      const observed = table[row][column] ?? 0;
      if (expected > 1e-9) statistic += (observed - expected) ** 2 / expected;
      if (observed > 0 && sample > 0 && rowTotals[row] > 0 && columnTotals[column] > 0) {
        mutualInformationBits += (observed / sample) * Math.log2((observed * sample) / (rowTotals[row] * columnTotals[column]));
      }
    }
  }
  const degreesOfFreedom = Math.max(1, (rows - 1) * (columns - 1));
  const minDimension = Math.max(1, Math.min(rows, columns) - 1);
  return {
    statistic,
    degreesOfFreedom,
    pValue: chiSquarePValue(statistic, degreesOfFreedom),
    sample,
    effect: sample > 0 ? Math.sqrt(statistic / (sample * minDimension)) : 0,
    mutualInformationBits: Math.max(0, mutualInformationBits),
  };
}

export type RunsTestResult = {
  runs: number;
  expectedRuns: number;
  zScore: number;
  pValue: number;
  positives: number;
  negatives: number;
  /** Positive z means more alternation than chance (mean reversion). */
  direction: 'alternating' | 'clustered' | 'random';
};

/** Wald–Wolfowitz runs test on the non-zero signs of a sequence. */
export function runsTest(values: readonly number[]): RunsTestResult {
  const signs: number[] = [];
  for (const value of values) {
    if (value > 0) signs.push(1);
    else if (value < 0) signs.push(-1);
  }
  const sample = signs.length;
  let runs = 0;
  let positives = 0;
  for (let index = 0; index < sample; index += 1) {
    if (signs[index] > 0) positives += 1;
    if (index === 0 || signs[index] !== signs[index - 1]) runs += 1;
  }
  const negatives = sample - positives;
  const expectedRuns = sample ? 1 + (2 * positives * negatives) / sample : 0;
  const varianceRuns = sample > 1
    ? (2 * positives * negatives * (2 * positives * negatives - sample)) / (sample ** 2 * (sample - 1))
    : 0;
  // Continuity correction toward the mean.
  const correction = runs > expectedRuns ? -0.5 : 0.5;
  const zScore = varianceRuns > 0 ? (runs - expectedRuns + correction) / Math.sqrt(varianceRuns) : 0;
  return {
    runs,
    expectedRuns,
    zScore,
    pValue: normalPValue(zScore),
    positives,
    negatives,
    direction: normalPValue(zScore) < 0.05 ? (zScore > 0 ? 'alternating' : 'clustered') : 'random',
  };
}

export function autocorrelation(values: readonly number[], lag: number): number | null {
  const n = values.length;
  if (lag < 1 || n - lag < 20) return null;
  const center = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    denominator += (values[index] - center) ** 2;
    if (index >= lag) numerator += (values[index] - center) * (values[index - lag] - center);
  }
  return denominator > 1e-12 ? numerator / denominator : null;
}

export type LjungBoxResult = { statistic: number; degreesOfFreedom: number; pValue: number; sample: number; maxAutocorrelation: number; lagOne: number | null };

/** Ljung–Box joint autocorrelation test with individual lag correlations. */
export function ljungBox(values: readonly number[], lags: number): LjungBoxResult {
  const n = values.length;
  let statistic = 0;
  let maxAutocorrelation = 0;
  let used = 0;
  for (let lag = 1; lag <= Math.max(1, lags); lag += 1) {
    const rho = autocorrelation(values, lag);
    if (rho === null) continue;
    used += 1;
    statistic += (rho * rho) / Math.max(1e-9, n - lag);
    if (Math.abs(rho) > Math.abs(maxAutocorrelation)) maxAutocorrelation = rho;
  }
  statistic *= n * (n + 2);
  return {
    statistic,
    degreesOfFreedom: Math.max(1, used),
    pValue: chiSquarePValue(statistic, Math.max(1, used)),
    sample: n,
    maxAutocorrelation,
    lagOne: autocorrelation(values, 1),
  };
}

export type VarianceRatioResult = {
  ratio: number;
  zScore: number;
  pValue: number;
  sample: number;
  /** Positive: persistent / trending. Negative: mean reverting. */
  interpretation: 'persistent' | 'mean-reverting' | 'random';
};

/**
 * Lo–MacKinlay variance ratio, homoskedastic version. Under a random walk the
 * variance of q-period returns grows linearly with q, so the ratio is one.
 */
export function varianceRatioTest(returns: readonly number[], q = 10): VarianceRatioResult {
  const n = returns.length;
  if (n < q + 20) return { ratio: 1, zScore: 0, pValue: 1, sample: n, interpretation: 'random' };
  const center = mean(returns);
  const variance1 = returns.reduce((sum, value) => sum + (value - center) ** 2, 0) / n;
  if (!(variance1 > 1e-12)) return { ratio: 1, zScore: 0, pValue: 1, sample: n, interpretation: 'random' };
  let aggregated = 0;
  let count = 0;
  for (let index = q; index <= n; index += 1) {
    let total = 0;
    for (let offset = 1; offset <= q; offset += 1) total += returns[index - offset] - center;
    aggregated += total * total;
    count += 1;
  }
  if (!count) return { ratio: 1, zScore: 0, pValue: 1, sample: n, interpretation: 'random' };
  const ratio = aggregated / (count * q * variance1);
  // Homoskedastic Lo–MacKinlay standard error.
  const zScore = (ratio - 1) / Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * n));
  return {
    ratio,
    zScore,
    pValue: normalPValue(zScore),
    sample: n,
    interpretation: normalPValue(zScore) < 0.05 ? (ratio > 1 ? 'persistent' : 'mean-reverting') : 'random',
  };
}

/**
 * Hurst exponent by aggregated variance: log Var(m-period sum) against
 * log m, slope / 2. A random walk gives ~0.5, persistence > 0.5 and mean
 * reversion < 0.5.
 */
export function hurstExponent(returns: readonly number[]): { hurst: number; sample: number; points: number } {
  const n = returns.length;
  if (n < 128) return { hurst: 0.5, sample: n, points: 0 };
  const maxLag = Math.max(2, Math.min(64, Math.floor(n / 8)));
  const lags: number[] = [];
  for (let lag = 2; lag <= maxLag; lag *= 2) lags.push(lag);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const lag of lags) {
    const increments: number[] = [];
    for (let index = 0; index + lag <= n; index += lag) {
      let total = 0;
      for (let offset = 0; offset < lag; offset += 1) total += returns[index + offset];
      increments.push(total);
    }
    if (increments.length < 8) continue;
    const varianceValue = variance(increments);
    if (!(varianceValue > 1e-14)) continue;
    xs.push(Math.log(lag));
    ys.push(Math.log(varianceValue));
  }
  if (xs.length < 3) return { hurst: 0.5, sample: n, points: xs.length };
  const centerX = mean(xs);
  const centerY = mean(ys);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - centerX) * (ys[index] - centerY);
    denominator += (xs[index] - centerX) ** 2;
  }
  const slope = denominator > 1e-12 ? numerator / denominator : 1;
  return { hurst: clamp(slope / 2, 0, 1), sample: n, points: xs.length };
}

export type ChangePointResult = { statistic: number; shift: number; significance: number; index: number | null };

/**
 * Two-sided CUSUM on standardized values. `significance` approximates the
 * Kolmogorov probability of the maximum standardized path, so a random stream
 * rarely exceeds it.
 */
export function cusumChange(values: readonly number[]): ChangePointResult {
  const n = values.length;
  if (n < 40) return { statistic: 0, shift: 0, significance: 0, index: null };
  const center = mean(values);
  const deviation = Math.max(1e-12, standardDeviation(values));
  let path = 0;
  let maximum = 0;
  let maxIndex: number | null = null;
  let atMax = 0;
  for (let index = 0; index < n; index += 1) {
    path += (values[index] - center) / deviation;
    if (Math.abs(path) > Math.abs(maximum)) {
      maximum = path;
      maxIndex = index;
      atMax = path;
    }
  }
  const scaled = Math.abs(atMax) / Math.sqrt(n);
  // Brownian-bridge tail: P(sup |B| > x) ≈ 2 exp(-2x²).
  const significance = clamp(2 * Math.exp(-2 * scaled * scaled), 0, 1);
  const split = Math.max(1, (maxIndex ?? 0) + 1);
  const before = mean(values.slice(0, split));
  const after = split < n ? mean(values.slice(split)) : before;
  return {
    statistic: scaled,
    shift: after - before,
    significance,
    index: maxIndex,
  };
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(hits: number, sample: number, z = 1.96): { lower: number; upper: number; rate: number } {
  if (!(sample > 0)) return { lower: 0, upper: 1, rate: 0 };
  const rate = clamp(hits / sample, 0, 1);
  const denominator = 1 + (z * z) / sample;
  const centre = rate + (z * z) / (2 * sample);
  const spread = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * sample)) / sample);
  return {
    lower: clamp((centre - spread) / denominator, 0, 1),
    upper: clamp((centre + spread) / denominator, 0, 1),
    rate,
  };
}

// ---- calibration -----------------------------------------------------------

export type CalibrationPoint = { probability: number; won: 0 | 1 };
export type CalibrationMethod = 'isotonic' | 'platt' | 'isotonic+platt' | 'shrunk-isotonic' | 'ensemble' | 'none';
export type CalibrationResult = {
  method: CalibrationMethod;
  sample: number;
  evaluationSample: number;
  brierBefore: number | null;
  brierAfter: number | null;
  /** 1 - brierAfter / brierBefore, measured out of fold. */
  skill: number | null;
  improved: boolean;
  slope: number | null;
  intercept: number | null;
  predict: (probability: number) => number;
  /** Purged walk-forward folds used to score the calibrator. */
  folds?: number;
  /** Paired z-score behind `improved`. */
  pairedZ?: number;
  /**
   * Murphy reliability decomposition of the raw and calibrated probabilities,
   * both measured on rows no calibrator saw. Present only when enough rows were
   * available to measure them.
   */
  reliability?: { raw: ReliabilityReport; calibrated: ReliabilityReport };
};

const identity = (probability: number) => clamp(probability, 0.0005, 0.9995);

export function brierScore(points: readonly CalibrationPoint[], predict: (probability: number) => number = identity): number | null {
  if (!points.length) return null;
  return mean(points.map((point) => (clamp(predict(point.probability), 0.0005, 0.9995) - point.won) ** 2));
}

/**
 * Paired z-score of a loss reduction. A slightly lower average Brier score on a
 * few hundred rows is not evidence by itself: this asks whether the per-row
 * improvement is large relative to its own dispersion. Calibration is only
 * accepted when this clears 2.5.
 */
export function pairedImprovementZ(before: readonly number[], after: readonly number[]): number {
  const count = Math.min(before.length, after.length);
  if (count < 20) return 0;
  const differences: number[] = [];
  for (let index = 0; index < count; index += 1) differences.push(before[index] - after[index]);
  const deviation = standardDeviation(differences);
  if (!(deviation > 1e-12)) return differences.every((value) => value > 0) ? 99 : 0;
  return mean(differences) / (deviation / Math.sqrt(count));
}

type IsotonicBlock = { x: number; sumY: number; weight: number; start: number };

/** Pool-adjacent-violators isotonic regression on binned calibration data. */
export function fitIsotonic(points: readonly CalibrationPoint[], bins = 10): { predict: (probability: number) => number; blocks: number } {
  if (points.length < 20) return { predict: identity, blocks: 0 };
  const sorted = [...points].sort((left, right) => left.probability - right.probability);
  const bucketCount = Math.max(3, Math.min(bins, Math.floor(sorted.length / 8)));
  const width = 1 / bucketCount;
  const binned: Array<{ x: number; y: number; weight: number }> = [];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const low = bucket * width;
    const high = bucket === bucketCount - 1 ? 1.0000001 : (bucket + 1) * width;
    const members = sorted.filter((point) => point.probability >= low && point.probability < high);
    if (!members.length) continue;
    binned.push({ x: mean(members.map((point) => point.probability)), y: mean(members.map((point) => point.won)), weight: members.length });
  }
  if (binned.length < 2) return { predict: identity, blocks: binned.length };
  const blocks: IsotonicBlock[] = [];
  binned.forEach((point) => {
    blocks.push({ x: point.x, sumY: point.y * point.weight, weight: point.weight, start: blocks.length });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      if (previous.sumY / previous.weight <= last.sumY / last.weight) break;
      blocks.splice(blocks.length - 2, 2, {
        x: previous.x,
        sumY: previous.sumY + last.sumY,
        weight: previous.weight + last.weight,
        start: previous.start,
      });
    }
  });
  const xs = blocks.map((block) => block.x);
  const values = blocks.map((block) => clamp(block.sumY / block.weight, 0.0005, 0.9995));
  return {
    predict: (probability: number) => {
      if (probability <= xs[0]) return values[0];
      for (let index = 1; index < xs.length; index += 1) if (probability <= xs[index]) return (values[index - 1] + values[index]) / 2;
      return values[values.length - 1];
    },
    blocks: blocks.length,
  };
}

export type LogisticModel = {
  predict: (features: readonly number[]) => number;
  coefficients: number[];
  converged: boolean;
  sample: number;
};

/**
 * Ridge-regularized logistic regression fitted by Newton / IRLS. Features are
 * standardized internally; the returned model accepts raw features.
 */
export function fitLogistic(
  rows: readonly (readonly number[])[],
  labels: readonly number[],
  options: { ridge?: number; iterations?: number; minSample?: number } = {},
): LogisticModel | null {
  const minSample = options.minSample ?? 40;
  const ridge = options.ridge ?? 2;
  if (rows.length < minSample || labels.length !== rows.length || !rows[0]?.length) return null;
  const width = rows[0].length;
  if (rows.some((row) => row.length !== width || row.some((value) => !Number.isFinite(value)))) return null;
  if (labels.some((label) => label !== 0 && label !== 1)) return null;
  const positives = labels.reduce((total, label) => total + label, 0);
  if (positives < 5 || rows.length - positives < 5) return null;
  const centers = Array.from({ length: width }, (_, feature) => mean(rows.map((row) => row[feature])));
  const scales = Array.from({ length: width }, (_, feature) => {
    const deviation = standardDeviation(rows.map((row) => row[feature]));
    return deviation > 1e-9 ? deviation : 1;
  });
  const design = rows.map((row) => [1, ...row.map((value, feature) => (value - centers[feature]) / scales[feature])]);
  const size = width + 1;
  let beta = Array<number>(size).fill(0);
  let converged = false;
  for (let iteration = 0; iteration < (options.iterations ?? 12); iteration += 1) {
    const hessian = Array.from({ length: size }, (_, row) => Array.from({ length: size + 1 }, (_, column) => {
      if (row === column) return row === 0 ? 1e-6 : ridge;
      return 0;
    }));
    for (let row = 1; row < size; row += 1) hessian[row][size] = -ridge * beta[row];
    design.forEach((features, index) => {
      let logit = 0;
      for (let j = 0; j < size; j += 1) logit += beta[j] * features[j];
      const probability = 1 / (1 + Math.exp(-clamp(logit, -30, 30)));
      const weight = Math.max(1e-4, probability * (1 - probability));
      const residual = labels[index] - probability;
      for (let j = 0; j < size; j += 1) {
        hessian[j][size] += features[j] * residual;
        for (let k = 0; k < size; k += 1) hessian[j][k] += weight * features[j] * features[k];
      }
    });
    for (let column = 0; column < size; column += 1) {
      let pivot = column;
      for (let row = column + 1; row < size; row += 1) if (Math.abs(hessian[row][column]) > Math.abs(hessian[pivot][column])) pivot = row;
      [hessian[column], hessian[pivot]] = [hessian[pivot], hessian[column]];
      const divisor = hessian[column][column];
      if (Math.abs(divisor) < 1e-12) continue;
      for (let k = column; k <= size; k += 1) hessian[column][k] /= divisor;
      for (let row = 0; row < size; row += 1) {
        if (row === column) continue;
        const factor = hessian[row][column];
        for (let k = column; k <= size; k += 1) hessian[row][k] -= factor * hessian[column][k];
      }
    }
    const step = hessian.map((row) => (Number.isFinite(row[size]) ? row[size] : 0));
    beta = beta.map((value, index) => clamp(value + step[index], -20, 20));
    if (step.every((value) => Math.abs(value) < 1e-6)) { converged = true; break; }
  }
  const coefficients = [beta[0], ...beta.slice(1).map((value, feature) => value / scales[feature])];
  return {
    predict: (features: readonly number[]) => {
      let logit = beta[0];
      for (let feature = 0; feature < width; feature += 1) logit += beta[feature + 1] * ((features[feature] - centers[feature]) / scales[feature]);
      return 1 / (1 + Math.exp(-clamp(logit, -30, 30)));
    },
    coefficients,
    converged,
    sample: rows.length,
  };
}

/**
 * Chronological out-of-sample calibration.
 *
 * This is now a purged walk-forward CROSS-VALIDATION rather than a single 50/50
 * split (see `recalibration.ts` for the full rationale). Every candidate
 * — identity, Platt on the log-odds, isotonic, and two shrunk blends of the
 * two — is fitted on all rows strictly before each fold and scored on that
 * fold, so:
 *
 *   * the skill, reliability and slope are measured on nearly every row instead
 *     of half of them, which is what makes the decision precise;
 *   * the calibrator that is finally returned is refitted on ALL rows, which is
 *     what makes the deployed mapping accurate;
 *   * a calibrator is still only accepted when it beats the raw probability by
 *     both a material margin and a paired z on rows it never saw, so this layer
 *     can never manufacture an edge it cannot prove.
 *
 * The return shape is unchanged, so every existing caller keeps working.
 */
export function calibrateOutOfSample(
  points: readonly CalibrationPoint[],
  options: { minimum?: number; minimumEvaluation?: number; minimumImprovement?: number } = {},
): CalibrationResult {
  const usable = points.filter((point) => Number.isFinite(point.probability) && (point.won === 0 || point.won === 1));
  const result = recalibrate(usable, {
    minimum: options.minimum ?? 80,
    minimumEvaluation: options.minimumEvaluation ?? 25,
    minimumImprovement: options.minimumImprovement ?? 0.015,
  });
  if (!result.evaluationSample) {
    // Too few rows to fit a calibrator, but never too few to MEASURE the model:
    // the reliability report is what tells the precision layer how much this
    // estimate can be trusted, and withholding it is how an overconfident model
    // on a thin holdout slips through.
    return {
      method: 'none', sample: usable.length, evaluationSample: 0, brierBefore: null, brierAfter: null,
      skill: null, improved: false, slope: null, intercept: null, predict: identity, folds: 0, pairedZ: 0,
      reliability: { raw: result.raw, calibrated: result.calibrated },
    };
  }
  return {
    method: result.method,
    sample: result.sample,
    evaluationSample: result.evaluationSample,
    brierBefore: result.brierBefore,
    brierAfter: result.brierAfter,
    skill: result.skill,
    improved: result.improved,
    slope: result.slope,
    intercept: result.intercept,
    predict: result.predict,
    folds: result.folds,
    pairedZ: result.pairedZ,
    reliability: { raw: result.raw, calibrated: result.calibrated },
  };
}

export type StackResult = {
  model: LogisticModel | null;
  featureCount: number;
  sample: number;
  evaluationSample: number;
  baseBrier: number | null;
  stackBrier: number | null;
  skill: number | null;
  improved: boolean;
  weights: number[];
};

/**
 * Chronological stack: the base probability is feature zero, so the stack can
 * only be accepted when adding the other engines/analysis features beats the
 * base model on rows the fit never saw.
 */
export function fitOutOfSampleStack(
  rows: readonly (readonly number[])[],
  labels: readonly number[],
  options: { minimum?: number; minimumEvaluation?: number; ridge?: number; minimumZ?: number } = {},
): StackResult {
  const minimum = options.minimum ?? 120;
  const minimumEvaluation = options.minimumEvaluation ?? 40;
  const empty: StackResult = { model: null, featureCount: rows[0]?.length ?? 0, sample: rows.length, evaluationSample: 0, baseBrier: null, stackBrier: null, skill: null, improved: false, weights: [] };
  if (rows.length < minimum || labels.length !== rows.length) return empty;
  const split = Math.floor(rows.length / 2);
  const evaluationSample = rows.length - split;
  if (evaluationSample < minimumEvaluation) return { ...empty, evaluationSample };
  const fittingRows = rows.slice(0, split);
  const fittingLabels = labels.slice(0, split);
  const evaluationRows = rows.slice(split);
  const evaluationLabels = labels.slice(split);
  const model = fitLogistic(fittingRows, fittingLabels, { ridge: options.ridge ?? 2, minSample: 40 });
  if (!model) return { ...empty, evaluationSample };
  const baseErrors = evaluationRows.map((row, index) => (clamp(row[0], 0.0005, 0.9995) - evaluationLabels[index]) ** 2);
  const stackErrors = evaluationRows.map((row, index) => (clamp(model.predict(row), 0.0005, 0.9995) - evaluationLabels[index]) ** 2);
  const baseBrier = mean(baseErrors);
  const stackBrier = mean(stackErrors);
  const skill = baseBrier > 1e-12 ? 1 - stackBrier / baseBrier : null;
  const pairedZ = pairedImprovementZ(baseErrors, stackErrors);
  // `minimumZ` lets a pool of many contracts raise the bar for accepting a
  // stack. A single contract at 2.5 is a 5σ-looking result across a 16-contract
  // scan only when it is the winner; three sigma is the honest default there.
  const improved = skill !== null && skill > 0.02 && pairedZ >= (options.minimumZ ?? 2.5);
  if (!improved) {
    return { model: null, featureCount: rows[0].length, sample: rows.length, evaluationSample, baseBrier, stackBrier, skill, improved: false, weights: [] };
  }
  const finalModel = fitLogistic(rows, labels, { ridge: options.ridge ?? 2, minSample: 40 });
  return {
    model: finalModel,
    featureCount: rows[0].length,
    sample: rows.length,
    evaluationSample,
    baseBrier,
    stackBrier,
    skill,
    improved: true,
    weights: finalModel?.coefficients.slice(1) ?? [],
  };
}
