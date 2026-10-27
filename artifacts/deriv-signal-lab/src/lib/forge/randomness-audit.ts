// A deliberately small, prequential probe for the Base workspace.
//
// This does not try to reverse-engineer Deriv's generator or recover a seed.
// It asks a narrower, testable question: do the public digits seen so far make
// a smoothed first-order transition forecast beat a uniform 10-digit forecast
// on later observations from the same chronological stream?
//
// Each walk-forward probability is built strictly from earlier digits. The
// result is a research diagnostic, not a trading signal or a promise about the
// next output. Repeatedly inspecting many markets can still create false
// positives; the screen therefore includes a candidate-pool correction and
// keeps its limitations visible in the UI.

const DIGIT_COUNT = 10;
const FAIR_PROBABILITY = 1 / DIGIT_COUNT;
const FAIR_BRIER = (DIGIT_COUNT - 1) / DIGIT_COUNT;
const FAIR_LOG_LOSS = Math.log(DIGIT_COUNT);
const PRIOR_STRENGTH = 12;

export const RANDOMNESS_AUDIT = {
  warmupTicks: 200,
  trainWindowTicks: 800,
  minimumForecasts: 250,
  minimumDigits: 450,
  minimumZ: 2,
} as const;

export type DigitForecast = {
  /** Ten probabilities in digit order (0 through 9). */
  probabilities: number[];
  /** Up to three highest-probability outcomes, sorted by probability. */
  topDigits: number[];
  previousDigit: number;
  /** Number of observed transitions used by the conditional model. */
  transitionsUsed: number;
  /** Number of matching transitions for the current previous digit. */
  contextTransitions: number;
};

export type DigitRandomnessAudit = {
  sampleSize: number;
  transitionCount: number;
  expectedPerDigit: number;
  counts: number[];
  normalizedEntropy: number | null;
  chiSquare: number | null;
  chiSquarePValue: number | null;
  repeatedDigitRate: number | null;
  repeatedDigitZ: number | null;
  forecastRows: number;
  warmupTicks: number;
  trainWindowTicks: number;
  modelBrier: number | null;
  fairBrier: number;
  brierSkill: number | null;
  modelLogLoss: number | null;
  fairLogLoss: number;
  logLossSkill: number | null;
  /** HAC/Newey–West paired z of the per-row Brier improvement. */
  pairedZ: number | null;
  zBar: number;
  selectionPool: number;
  passedHistoricalScreen: boolean;
  forecast: DigitForecast | null;
};

function isDigit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < DIGIT_COUNT
  );
}

function cleanDigits(values: readonly number[]): number[] {
  return Array.isArray(values) ? values.filter(isDigit) : [];
}

/**
 * Build one forecast at `endExclusive`. The loop never reads digits at or
 * after that index, which makes this safe for both replay and the live edge.
 */
function forecastAt(
  digits: readonly number[],
  endExclusive: number,
  windowTicks: number,
): DigitForecast | null {
  if (endExclusive < 1 || endExclusive > digits.length) return null;
  const previousDigit = digits[endExclusive - 1];
  if (!isDigit(previousDigit)) return null;

  const start = Math.max(0, endExclusive - Math.max(2, windowTicks));
  const globalCounts = Array<number>(DIGIT_COUNT).fill(0);
  const transitionCounts = Array<number>(DIGIT_COUNT * DIGIT_COUNT).fill(0);
  let transitionsUsed = 0;

  // Transition at `index - 1 → index`; index < endExclusive excludes the
  // outcome the current forecast is meant to predict.
  for (let index = Math.max(1, start + 1); index < endExclusive; index += 1) {
    const prior = digits[index - 1];
    const next = digits[index];
    if (!isDigit(prior) || !isDigit(next)) continue;
    globalCounts[next] += 1;
    transitionCounts[prior * DIGIT_COUNT + next] += 1;
    transitionsUsed += 1;
  }

  // Empirical marginal prior, smoothed toward uniform. The conditional table
  // is shrunk toward that prior so a rare previous digit cannot dominate.
  const marginalDenominator = transitionsUsed + DIGIT_COUNT;
  const marginal = globalCounts.map(
    (count) => (count + 1) / marginalDenominator,
  );
  const rowOffset = previousDigit * DIGIT_COUNT;
  const contextCounts = transitionCounts.slice(
    rowOffset,
    rowOffset + DIGIT_COUNT,
  );
  const contextTransitions = contextCounts.reduce(
    (total, count) => total + count,
    0,
  );
  const conditionalDenominator = contextTransitions + PRIOR_STRENGTH;
  const probabilities = contextCounts.map(
    (count, digit) =>
      (count + PRIOR_STRENGTH * marginal[digit]) / conditionalDenominator,
  );

  // Remove floating point round-off so callers can rely on a proper simplex.
  const totalProbability = probabilities.reduce(
    (total, probability) => total + probability,
    0,
  );
  const normalized = probabilities.map(
    (probability) => probability / totalProbability,
  );
  const topDigits = normalized
    .map((probability, digit) => ({ digit, probability }))
    .sort(
      (left, right) =>
        right.probability - left.probability || left.digit - right.digit,
    )
    .slice(0, 3)
    .map(({ digit }) => digit);

  return {
    probabilities: normalized,
    topDigits,
    previousDigit,
    transitionsUsed,
    contextTransitions,
  };
}

/**
 * Forecast at a replay origin. Values at or after `endExclusive` are ignored,
 * so callers can assert that rewriting the future cannot alter this reading.
 */
export function forecastDigitAt(
  values: readonly number[],
  endExclusive: number,
  windowTicks = RANDOMNESS_AUDIT.trainWindowTicks,
): DigitForecast | null {
  const digits = cleanDigits(values);
  const origin = Math.max(0, Math.min(digits.length, Math.trunc(endExclusive)));
  return forecastAt(digits, origin, windowTicks);
}

/**
 * Estimate the next digit from the latest verified history. Probabilities
 * shrink toward uniform unless the observed transitions supply enough data.
 */
export function forecastNextDigit(
  values: readonly number[],
  windowTicks = RANDOMNESS_AUDIT.trainWindowTicks,
): DigitForecast | null {
  const digits = cleanDigits(values);
  return forecastAt(digits, digits.length, windowTicks);
}

function brierScore(probabilities: readonly number[], outcome: number): number {
  let score = 0;
  for (let digit = 0; digit < DIGIT_COUNT; digit += 1) {
    const target = digit === outcome ? 1 : 0;
    score += (probabilities[digit] - target) ** 2;
  }
  return score;
}

/** HAC/Newey–West standard error for a short-range-dependent score sequence. */
function pairedHacZ(
  differences: readonly number[],
  maxLag = 10,
): number | null {
  const count = differences.length;
  if (count < 2) return null;
  const mean = differences.reduce((total, value) => total + value, 0) / count;
  let longRunVariance = 0;
  for (let lag = 0; lag <= Math.min(maxLag, count - 1); lag += 1) {
    let covariance = 0;
    const pairs = count - lag;
    for (let index = lag; index < count; index += 1) {
      covariance +=
        (differences[index] - mean) * (differences[index - lag] - mean);
    }
    covariance /= count;
    const weight = lag === 0 ? 1 : 1 - lag / (Math.min(maxLag, count - 1) + 1);
    longRunVariance += (lag === 0 ? 1 : 2) * weight * covariance;
  }
  const standardError = Math.sqrt(Math.max(0, longRunVariance) / count);
  if (standardError <= 1e-12) return mean > 1e-12 ? 50 : 0;
  return mean / standardError;
}

// Lanczos approximation, used only for the descriptive chi-square p-value.
function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5)
    return (
      Math.log(Math.PI) -
      Math.log(Math.sin(Math.PI * value)) -
      logGamma(1 - value)
    );
  const shifted = value - 1;
  let sum = 0.9999999999998099;
  for (let index = 0; index < coefficients.length; index += 1) {
    sum += coefficients[index] / (shifted + index + 1);
  }
  const t = shifted + coefficients.length - 0.5;
  return 0.9189385332046727 + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Regularized upper incomplete gamma Q(a, x), for chi-square diagnostics. */
function regularizedGammaQ(a: number, x: number): number {
  if (!(a > 0) || x < 0 || !Number.isFinite(a) || !Number.isFinite(x))
    return NaN;
  if (x === 0) return 1;
  const logScale = -x + a * Math.log(x) - logGamma(a);
  const epsilon = 1e-14;
  const floor = 1e-300;

  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    let denominator = a;
    for (let iteration = 1; iteration <= 10_000; iteration += 1) {
      denominator += 1;
      term *= x / denominator;
      sum += term;
      if (Math.abs(term) <= Math.abs(sum) * epsilon) break;
    }
    const lower = sum * Math.exp(logScale);
    return Math.max(0, Math.min(1, 1 - lower));
  }

  let b = x + 1 - a;
  let c = 1 / floor;
  let d = (1 / Math.max(floor, Math.abs(b))) * Math.sign(b || 1);
  let fraction = d;
  for (let iteration = 1; iteration <= 10_000; iteration += 1) {
    const coefficient = -iteration * (iteration - a);
    b += 2;
    d = coefficient * d + b;
    if (Math.abs(d) < floor) d = floor;
    c = b + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    fraction *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return Math.max(0, Math.min(1, Math.exp(logScale) * fraction));
}

function summarizeDigits(digits: readonly number[]) {
  const counts = Array<number>(DIGIT_COUNT).fill(0);
  for (const digit of digits) counts[digit] += 1;
  const sampleSize = digits.length;
  const expectedPerDigit = sampleSize / DIGIT_COUNT;
  let entropy = 0;
  let chiSquare = 0;
  for (const count of counts) {
    if (count > 0 && sampleSize > 0) {
      const share = count / sampleSize;
      entropy -= share * Math.log(share);
    }
    if (expectedPerDigit > 0)
      chiSquare += (count - expectedPerDigit) ** 2 / expectedPerDigit;
  }
  let repeats = 0;
  for (let index = 1; index < sampleSize; index += 1) {
    if (digits[index] === digits[index - 1]) repeats += 1;
  }
  const transitionCount = Math.max(0, sampleSize - 1);
  const repeatedDigitRate =
    transitionCount > 0 ? repeats / transitionCount : null;
  const repeatStandardError =
    transitionCount > 0
      ? Math.sqrt((FAIR_PROBABILITY * (1 - FAIR_PROBABILITY)) / transitionCount)
      : 0;
  const repeatedDigitZ =
    repeatedDigitRate === null || repeatStandardError <= 1e-12
      ? null
      : (repeatedDigitRate - FAIR_PROBABILITY) / repeatStandardError;
  const normalizedEntropy =
    sampleSize > 0 ? entropy / Math.log(DIGIT_COUNT) : null;
  const chiSquarePValue =
    sampleSize >= 50
      ? regularizedGammaQ((DIGIT_COUNT - 1) / 2, chiSquare / 2)
      : null;
  return {
    counts,
    sampleSize,
    transitionCount,
    expectedPerDigit,
    normalizedEntropy,
    chiSquare,
    chiSquarePValue,
    repeatedDigitRate,
    repeatedDigitZ,
  };
}

/**
 * Replay a smoothed first-order model one tick at a time and score each
 * forecast before revealing its target. The uniform benchmark is 10% for each
 * digit. `selectionPool` accounts for choosing among multiple scanned
 * markets; it cannot correct repeated manual peeking at the same stream.
 */
export function auditDigitRandomness(
  values: readonly number[],
  options: {
    warmupTicks?: number;
    trainWindowTicks?: number;
    selectionPool?: number;
  } = {},
): DigitRandomnessAudit {
  const digits = cleanDigits(values);
  const summary = summarizeDigits(digits);
  const warmupTicks = Math.max(
    2,
    Math.trunc(options.warmupTicks ?? RANDOMNESS_AUDIT.warmupTicks),
  );
  const trainWindowTicks = Math.max(
    2,
    Math.trunc(options.trainWindowTicks ?? RANDOMNESS_AUDIT.trainWindowTicks),
  );
  const selectionPool = Math.max(1, Math.trunc(options.selectionPool ?? 13));
  const zBar =
    2 +
    0.6 *
      (Math.sqrt(2 * Math.log(Math.max(2, selectionPool))) -
        Math.sqrt(2 * Math.log(2)));
  const differences: number[] = [];
  let modelBrierTotal = 0;
  let modelLogLossTotal = 0;

  for (
    let targetIndex = warmupTicks;
    targetIndex < digits.length;
    targetIndex += 1
  ) {
    const forecast = forecastAt(digits, targetIndex, trainWindowTicks);
    if (!forecast) continue;
    const outcome = digits[targetIndex];
    modelBrierTotal += brierScore(forecast.probabilities, outcome);
    modelLogLossTotal += -Math.log(
      Math.max(1e-12, forecast.probabilities[outcome]),
    );
    differences.push(FAIR_BRIER - brierScore(forecast.probabilities, outcome));
  }

  const forecastRows = differences.length;
  const modelBrier = forecastRows > 0 ? modelBrierTotal / forecastRows : null;
  const modelLogLoss =
    forecastRows > 0 ? modelLogLossTotal / forecastRows : null;
  const brierSkill = modelBrier === null ? null : 1 - modelBrier / FAIR_BRIER;
  const logLossSkill =
    modelLogLoss === null ? null : 1 - modelLogLoss / FAIR_LOG_LOSS;
  const pairedZ = pairedHacZ(differences);
  const forecast = forecastAt(digits, digits.length, trainWindowTicks);
  const passedHistoricalScreen =
    forecastRows >= RANDOMNESS_AUDIT.minimumForecasts &&
    (brierSkill ?? 0) > 0 &&
    (logLossSkill ?? 0) > 0 &&
    (pairedZ ?? Number.NEGATIVE_INFINITY) >= zBar;

  return {
    ...summary,
    forecastRows,
    warmupTicks,
    trainWindowTicks,
    modelBrier,
    fairBrier: FAIR_BRIER,
    brierSkill,
    modelLogLoss,
    fairLogLoss: FAIR_LOG_LOSS,
    logLossSkill,
    pairedZ,
    zBar,
    selectionPool,
    passedHistoricalScreen,
    forecast,
  };
}
