// ENGINE C — Statistical analysis engine.
//
// Deliberately independent of any AI model: every number the decision layer
// uses can be recomputed here from the raw digit sequence. The module is pure
// (no I/O, no randomness) so the automated tests can pin exact behaviour.
//
// The engine keeps four things strictly apart, as required:
//   * observed frequency  — what the sample contained,
//   * estimated probability — a smoothed posterior over that sample,
//   * predictive probability — a model's forecast for the next eligible tick,
//   * statistical uncertainty — the interval around those estimates.
import { chiSquareP9, clamp, countsOf, entropy, mean, normalize, sum, variance } from '../over-under/math.ts';
import { jensenShannon } from '../over-under/structure.ts';

/** Laplace/Dirichlet prior strength per cell used for digit frequencies. */
export const DIRICHLET_ALPHA = 0.5;
/** 90% credible interval. */
export const CREDIBLE_Z = 1.6448536269514722;
export const WILSON_95_Z = 1.959963984540054;

function logGamma(x: number): number {
  // Lanczos approximation, accurate to ~1e-12 for x > 0.
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let index = 0; index < coefficients.length; index += 1) a += coefficients[index] / (z + index + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (!(a > 0) || !(b > 0)) return Number.NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Inverse of the regularized incomplete beta function, by bounded bisection. */
export function betaQuantile(p: number, a: number, b: number): number {
  if (!(p > 0) || p >= 1 || !(a > 0) || !(b > 0)) return p <= 0 ? 0 : 1;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (low + high) / 2;
    if (incompleteBeta(a, b, mid) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export type PosteriorEstimate = {
  probabilities: number[];
  lower: number[];
  upper: number[];
  sample: number;
  alpha: number;
  intervalLevel: number;
};

/**
 * Posterior mean only. This is the hot path used by the models for every
 * walk-forward origin, so it computes no beta quantiles.
 */
export function dirichletMean(counts: readonly number[], alpha = DIRICHLET_ALPHA): number[] {
  const cells = counts.map((count) => (Number.isFinite(count) && count > 0 ? count : 0));
  const denominator = sum(cells) + alpha * cells.length;
  return normalize(cells.map((count) => (count + alpha) / (denominator || 1)));
}

/**
 * Dirichlet-multinomial posterior over the ten digits.
 *
 * Counting prior `alpha` per digit keeps rare outcomes possible instead of
 * producing the extreme (and false) claim that a digit can never appear.
 * `withIntervals` is off for the model hot path; the dashboard asks for the
 * credible interval once per cycle.
 */
export function dirichletPosterior(
  counts: readonly number[],
  options: { alpha?: number; level?: number; withIntervals?: boolean } = {},
): PosteriorEstimate {
  const alpha = options.alpha ?? DIRICHLET_ALPHA;
  const level = options.level ?? 0.9;
  const cells = counts.map((count) => (Number.isFinite(count) && count > 0 ? count : 0));
  const total = sum(cells);
  const probabilities = dirichletMean(cells, alpha);
  if (options.withIntervals === false) {
    return { probabilities, lower: [...probabilities], upper: [...probabilities], sample: total, alpha, intervalLevel: level };
  }
  const tail = (1 - level) / 2;
  const lower = cells.map((count) => betaQuantile(tail, count + alpha, total - count + alpha * (cells.length - 1)));
  const upper = cells.map((count) => betaQuantile(1 - tail, count + alpha, total - count + alpha * (cells.length - 1)));
  return { probabilities, lower, upper, sample: total, alpha, intervalLevel: level };
}

/** Which digits satisfy a contract's winning condition. */
export type DigitEvent =
  | { kind: 'parity'; parity: 0 | 1 }
  | { kind: 'over'; barrier: number }
  | { kind: 'under'; barrier: number }
  | { kind: 'match'; target: number };

/** The digits a contract wins on, under Deriv's published settlement rules. */
export function digitsForEvent(event: DigitEvent): number[] {
  const all = Array.from({ length: 10 }, (_, digit) => digit);
  switch (event.kind) {
    case 'parity':
      return all.filter((digit) => digit % 2 === event.parity);
    case 'over':
      // Strict boundary: the barrier digit itself does not satisfy the contract.
      return all.filter((digit) => digit > event.barrier);
    case 'under':
      return all.filter((digit) => digit < event.barrier);
    default:
      return all.filter((digit) => digit === event.target);
  }
}

export function probabilityOfEvent(probabilities: readonly number[], event: DigitEvent): number {
  return sum(digitsForEvent(event).map((digit) => probabilities[digit] ?? 0));
}

export function describeEvent(event: DigitEvent, contractType: string): string {
  switch (event.kind) {
    case 'parity':
      return `${contractType} wins when the final digit is ${event.parity === 0 ? 'even (0, 2, 4, 6, 8)' : 'odd (1, 3, 5, 7, 9)'}`;
    case 'over':
      return `${contractType} ${event.barrier} wins when the final digit is greater than ${event.barrier} (${digitsForEvent(event).join(', ')})`;
    case 'under':
      return `${contractType} ${event.barrier} wins when the final digit is less than ${event.barrier} (${digitsForEvent(event).join(', ')})`;
    default:
      return `${contractType} ${event.target} wins only when the final digit is exactly ${event.target}`;
  }
}

/**
 * Probability of a contract event under the Dirichlet posterior, with the
 * posterior standard deviation for the summed event probability.
 *
 * For Dirichlet(alpha_i) with alpha_0 = Σ alpha_i and A = Σ_{i ∈ E} alpha_i:
 *   mean = A / alpha_0
 *   var  = A (alpha_0 − A) / (alpha_0² (alpha_0 + 1))
 * The interval is what stops a small sample from being read as a strong edge.
 */
export function dirichletEventEstimate(
  counts: readonly number[],
  event: DigitEvent,
  options: { alpha?: number; z?: number } = {},
): { probability: number; standardDeviation: number; lower: number; upper: number; sample: number; digits: number[] } {
  const alpha = options.alpha ?? DIRICHLET_ALPHA;
  const z = options.z ?? CREDIBLE_Z;
  const posterior = dirichletMean(counts, alpha);
  const digits = digitsForEvent(event);
  const alphaTotal = sum(counts.map((count) => Math.max(0, count))) + alpha * counts.length;
  const eventAlpha = sum(digits.map((digit) => (counts[digit] ?? 0) + alpha));
  const mean = alphaTotal > 0 ? eventAlpha / alphaTotal : 0;
  const variance = alphaTotal > 0 ? (eventAlpha * (alphaTotal - eventAlpha)) / (alphaTotal * alphaTotal * (alphaTotal + 1)) : 0;
  const standardDeviation = Math.sqrt(Math.max(0, variance));
  return {
    probability: probabilityOfEvent(posterior, event),
    standardDeviation,
    lower: clamp(mean - z * standardDeviation, 0, 1),
    upper: clamp(mean + z * standardDeviation, 0, 1),
    sample: counts.reduce((total, count) => total + Math.max(0, Number.isFinite(count) ? count : 0), 0),
    digits,
  };
}

/** Chi-square goodness-of-fit against the 1/10-per-digit baseline (df = 9). */
export function chiSquareUniform(counts: readonly number[]): { statistic: number | null; pValue: number | null; degreesOfFreedom: number; expectedPerCell: number | null; usable: boolean } {
  const sample = sum(counts);
  const expectedPerCell = sample > 0 ? sample / counts.length : null;
  // With fewer than five expected observations per cell the asymptotic
  // p-value is not trustworthy, so it is withheld rather than faked.
  const usable = expectedPerCell !== null && expectedPerCell >= 5;
  if (!usable || expectedPerCell === null) {
    return { statistic: null, pValue: null, degreesOfFreedom: counts.length - 1, expectedPerCell, usable: false };
  }
  const statistic = sum(counts.map((count) => (count - expectedPerCell) ** 2 / expectedPerCell));
  return {
    statistic,
    pValue: chiSquareP9(statistic),
    degreesOfFreedom: counts.length - 1,
    expectedPerCell,
    usable: true,
  };
}

export function shuffleInvariantParityCounts(digits: readonly number[]): [number, number] {
  let even = 0;
  for (const digit of digits) if (digit % 2 === 0) even += 1;
  return [even, digits.length - even];
}

export function entropyBits(probabilities: readonly number[]): number {
  return entropy(probabilities);
}

export function normalizedEntropy(probabilities: readonly number[]): number {
  return entropy(probabilities) / Math.log2(Math.max(2, probabilities.length));
}

/** Wilson score interval for a binomial rate; never returns a degenerate band. */
export function wilsonInterval(hits: number, sample: number, z = WILSON_95_Z): { lower: number; upper: number } | null {
  if (!Number.isFinite(hits) || !Number.isFinite(sample) || sample <= 0) return null;
  const bounded = clamp(hits, 0, sample);
  const phat = bounded / sample;
  const denominator = 1 + (z * z) / sample;
  const center = (phat + (z * z) / (2 * sample)) / denominator;
  const spread = (z * Math.sqrt((phat * (1 - phat)) / sample + (z * z) / (4 * sample * sample))) / denominator;
  return { lower: clamp(center - spread, 0, 1), upper: clamp(center + spread, 0, 1) };
}

/**
 * Effective sample size after removing the serial dependence present in the
 * sequence. Digit ticks are not independent draws in the statistical sense
 * when a model conditions on recent digits, so every gate uses this value.
 */
export function effectiveSampleSize(digits: readonly number[], maxLag = 12): number {
  const values = digits.filter((digit) => Number.isFinite(digit));
  const n = values.length;
  if (n < 10) return n;
  const center = mean(values);
  const denominator = sum(values.map((value) => (value - center) ** 2));
  if (denominator <= 1e-12) return n;
  let adjustment = 0;
  const lags = Math.min(maxLag, Math.floor(n / 4));
  for (let lag = 1; lag <= lags; lag += 1) {
    let numerator = 0;
    for (let index = lag; index < n; index += 1) numerator += (values[index] - center) * (values[index - lag] - center);
    const autocorrelation = numerator / denominator;
    adjustment += (1 - lag / (lags + 1)) * autocorrelation;
  }
  const scale = 1 + 2 * adjustment;
  return clamp(n / Math.max(1e-6, scale), 5, n);
}

/** Exponentially weighted digit probabilities — a recency view, not a forecast. */
export function ewmaDigitProbabilities(digits: readonly number[], decay = 0.99): number[] {
  if (!digits.length) return Array.from({ length: 10 }, () => 0.1);
  const weights: number[] = [];
  let weight = 1;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    weights[index] = weight;
    weight *= decay;
  }
  const total = sum(weights);
  const raw = Array.from({ length: 10 }, (_, digit) => sum(digits.map((value, index) => (value === digit ? weights[index] : 0))));
  return normalize(raw.map((value) => value + (total > 0 ? (DIRICHLET_ALPHA * total) / 10 : 1)));
}

/** Rolling-window observed probabilities ending at the newest observation. */
export function rollingDigitProbabilities(digits: readonly number[], window: number): number[] {
  return dirichletMean(countsOf(digits.slice(-window)));
}

/** Markov transition counts for the ten digits. */
export function transitionCounts(digits: readonly number[]): number[][] {
  const rows = Array.from({ length: 10 }, () => Array<number>(10).fill(0));
  for (let index = 1; index < digits.length; index += 1) rows[digits[index - 1]][digits[index]] += 1;
  return rows;
}

/** Row-smoothed conditional transition probabilities. */
export function transitionProbabilities(counts: readonly number[][], alpha = DIRICHLET_ALPHA): number[][] {
  return counts.map((row) => {
    const total = sum(row);
    const denominator = total + alpha * row.length;
    const smoothed = row.map((count) => (count + alpha) / denominator);
    const blend = clamp(total / (total + 20), 0, 0.9);
    // Sparse rows stay close to the uniform baseline instead of claiming a
    // confident conditional distribution from a handful of transitions.
    return normalize(smoothed.map((probability) => probability * blend + 0.1 * (1 - blend)));
  });
}

/** Observed distribution of the digit that follows a given two-digit suffix. */
export function pairFollowProbabilities(digits: readonly number[], alpha = DIRICHLET_ALPHA): { keys: Record<string, number[]>; current: number[] | null; sample: number } {
  const table = new Map<string, number[]>();
  for (let index = 2; index < digits.length; index += 1) {
    const key = `${digits[index - 2]}${digits[index - 1]}`;
    const row = table.get(key) ?? Array<number>(10).fill(0);
    row[digits[index]] += 1;
    table.set(key, row);
  }
  const keys: Record<string, number[]> = {};
  for (const [key, row] of table) keys[key] = normalize(row.map((count) => count + alpha));
  const currentKey = digits.length >= 2 ? `${digits[digits.length - 2]}${digits[digits.length - 1]}` : null;
  const currentRow = currentKey ? table.get(currentKey) ?? null : null;
  return {
    keys,
    current: currentRow ? normalize(currentRow.map((count) => count + alpha)) : null,
    sample: currentRow ? sum(currentRow) : 0,
  };
}

/** Brier score for a categorical probability vector. Lower is better. */
export function brierScore(probabilities: readonly number[], target: number): number {
  return sum(probabilities.map((probability, digit) => (probability - Number(digit === target)) ** 2));
}

/** Multiclass log loss. */
export function logLossScore(probabilities: readonly number[], target: number): number {
  const probability = clamp(probabilities[target] ?? 0, 1e-12, 1);
  return -Math.log(probability);
}

export type CalibrationBin = { lower: number; upper: number; count: number; predicted: number; observed: number };

/**
 * Reliability curve + expected calibration error for binary forecasts
 * (for example "probability that the next digit is even").
 */
export function calibrationReport(predictions: readonly number[], outcomes: readonly boolean[], binCount = 10): { bins: CalibrationBin[]; expectedCalibrationError: number | null; maxCalibrationError: number | null; sample: number } {
  const rows = predictions
    .map((prediction, index) => ({ prediction, outcome: outcomes[index] }))
    .filter((row) => Number.isFinite(row.prediction) && typeof row.outcome === 'boolean');
  if (!rows.length) return { bins: [], expectedCalibrationError: null, maxCalibrationError: null, sample: 0 };
  const bins: CalibrationBin[] = [];
  let weightedGap = 0;
  let maxGap = 0;
  for (let index = 0; index < binCount; index += 1) {
    const lower = index / binCount;
    const upper = (index + 1) / binCount;
    const bucket = rows.filter((row) => (index === binCount - 1 ? row.prediction >= lower && row.prediction <= upper : row.prediction >= lower && row.prediction < upper));
    if (!bucket.length) {
      bins.push({ lower, upper, count: 0, predicted: 0, observed: 0 });
      continue;
    }
    const predicted = mean(bucket.map((row) => row.prediction));
    const observed = mean(bucket.map((row) => (row.outcome ? 1 : 0)));
    const gap = Math.abs(predicted - observed);
    weightedGap += (bucket.length / rows.length) * gap;
    maxGap = Math.max(maxGap, gap);
    bins.push({ lower, upper, count: bucket.length, predicted, observed });
  }
  return { bins, expectedCalibrationError: weightedGap, maxCalibrationError: maxGap, sample: rows.length };
}

export type ChangePointFinding = {
  status: 'stable' | 'shifted' | 'insufficient';
  splitIndex: number | null;
  marginalDivergence: number | null;
  maxDivergence: number | null;
  marginalThreshold: number;
  segmentSamples: [number, number];
  note: string;
};

/**
 * Distribution-shift detector. Compares the marginal digit distribution
 * before and after every candidate split point. A shift is reported as a
 * change in the observed distribution — never as a prediction.
 */
export function detectDistributionShift(digits: readonly number[], options: { minimumSegment?: number; threshold?: number } = {}): ChangePointFinding {
  const minimumSegment = options.minimumSegment ?? 100;
  const threshold = options.threshold ?? 0.08;
  const values = digits.filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9);
  if (values.length < minimumSegment * 2) {
    return {
      status: 'insufficient',
      splitIndex: null,
      marginalDivergence: null,
      maxDivergence: null,
      marginalThreshold: threshold,
      segmentSamples: [0, values.length],
      note: `At least ${minimumSegment * 2} validated digits are required to test for a distribution change.`,
    };
  }
  const balancedSplit = Math.floor(values.length / 2);
  const marginalDivergence = jensenShannon(countsOf(values.slice(0, balancedSplit)), countsOf(values.slice(balancedSplit)));
  let bestSplit: number | null = null;
  let bestDivergence = -1;
  for (let split = minimumSegment; split <= values.length - minimumSegment; split += Math.max(1, Math.floor(minimumSegment / 4))) {
    const divergence = jensenShannon(countsOf(values.slice(0, split)), countsOf(values.slice(split)));
    if (divergence > bestDivergence) {
      bestDivergence = divergence;
      bestSplit = split;
    }
  }
  const shifted = bestDivergence > threshold || marginalDivergence > threshold;
  return {
    status: shifted ? 'shifted' : 'stable',
    splitIndex: bestSplit,
    marginalDivergence,
    maxDivergence: bestDivergence >= 0 ? bestDivergence : null,
    marginalThreshold: threshold,
    segmentSamples: bestSplit === null ? [0, values.length] : [bestSplit, values.length - bestSplit],
    note: shifted
      ? 'The observed digit distribution differs between earlier and later parts of the sample; the fitted models are re-checked on the later segment before anything is traded.'
      : 'No material distribution change was detected inside the sample window.',
  };
}

/**
 * One-sided normal approximation for a rate comparison against a fixed
 * baseline (used for parity and barrier events where df = 1).
 */
export function rateZScore(hits: number, sample: number, baseline: number): number | null {
  if (!(sample > 0) || !(baseline > 0) || baseline >= 1) return null;
  const phat = clamp(hits / sample, 0, 1);
  const standardError = Math.sqrt((baseline * (1 - baseline)) / sample);
  if (standardError <= 0) return null;
  return (phat - baseline) / standardError;
}

/** Two-sided p-value for a z statistic using the Abramowitz–Stegun erfc. */
export function twoSidedPValue(z: number): number {
  if (!Number.isFinite(z)) return Number.NaN;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const tail = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const oneSided = z >= 0 ? tail : 2 - tail;
  return clamp(2 * Math.min(oneSided, 1 - oneSided), 0, 1);
}

/** Sample standard error of a mean, used for improvement comparisons. */
export function meanStandardError(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  return Math.sqrt(variance(values) / (values.length - 1));
}

export function standardDeviation(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}
