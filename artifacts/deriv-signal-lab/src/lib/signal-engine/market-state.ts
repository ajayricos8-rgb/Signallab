// Layer 1 — ANALYSIS ENGINES.
//
// Before any model is allowed to predict, the market itself is measured with a
// panel of independent statistical tests:
//
//   digit markets  · uniformity, transition independence, conditional entropy,
//                    parity runs, periodicity, hot/cold drift, recurring
//                    context patterns, structural break, gap hazard
//   quote markets  · regression trend, ADX direction, efficiency ratio, Hurst
//                    exponent, variance ratio, Ljung–Box autocorrelation, runs
//                    test, AR(1) mean reversion, volatility regime, CUSUM
//                    structural break and tick cadence
//
// Every engine reports its own sample, effect size and p-value. The synthesis
// only claims predictability when an effect is both material AND statistically
// significant after a Bonferroni correction for the number of tests, and any
// prior it offers is additionally backtested against a uniform baseline on the
// latest part of the stream. A pure random-number market therefore reads as
// "random" instead of manufacturing an edge.
//
// Pure module: no I/O, no DOM, safe inside the scan Web Workers.

import { marketStructure } from '../over-under/structure.ts';
import {
  autocorrelation, chiSquareGoodnessOfFit, chiSquareIndependence, clamp, cusumChange,
  hurstExponent, ljungBox, mean, normalCdf, normalPValue, percentile, runsTest, standardDeviation,
  varianceRatioTest, wilsonInterval,
} from './stats.ts';

export type AnalysisLayer = 'analysis';
export type DigitRegime = 'random' | 'biased' | 'serially-dependent' | 'regime-shifting' | 'insufficient';
export type QuoteRegime = 'trending-up' | 'trending-down' | 'mean-reverting' | 'volatile' | 'quiet' | 'random' | 'insufficient';

export type AnalysisEngine = {
  id: string;
  label: string;
  family: string;
  /** Human-readable conclusion of this test, e.g. "uniform (p = 0.41)". */
  verdict: string;
  /** Signed direction when the test has a side (-1 … 1), otherwise null. */
  value: number | null;
  /** Effect size from 0 (nothing) to 1 (strong). */
  strength: number;
  /** Two-sided p-value when the test has one. */
  pValue: number | null;
  sample: number;
  detail: string;
};

export type PriorBacktest = {
  sample: number;
  /** Brier score of the analysis prior on the realised outcome. */
  brier: number | null;
  /** Brier score of the uniform baseline on the same rows. */
  baseline: number | null;
  /** 1 − brier / baseline; positive means the analysis prior added information. */
  skill: number | null;
  /** Hit rate when the prior is read as a best-digit/next-side call. */
  accuracy: number | null;
  /** Paired z of the per-row Brier improvement over uniform. */
  pairedZ?: number | null;
  improved: boolean;
};

export type DigitMarketState = {
  kind: 'digit';
  regime: DigitRegime;
  predictability: number;
  confidence: number;
  sample: number;
  /** Distribution over the next digit built only from significant tests. */
  prior: number[] | null;
  priorStrength: number;
  /**
   * Every measured angle behind the prior, with its own out-of-sample Brier
   * skill and the weight it earned. Angles that could not beat uniform carry
   * weight 0 and are kept only for the panel.
   */
  priorComponents: DigitPriorComponent[];
  /**
   * How far the shipped prior is allowed to commit, earned by its own replay.
   * Exposed so any historical replay of the prior uses the same band.
   */
  priorLimits: DigitPriorLimits;
  /** The pool's own out-of-sample skill, measured before the validation tail. */
  priorReplay: { skill: number | null; sample: number };
  priorBacktest: PriorBacktest;
  engines: AnalysisEngine[];
  metrics: {
    uniformityChiSquare: number | null;
    uniformityP: number | null;
    uniformityEffect: number | null;
    independenceChiSquare: number | null;
    independenceP: number | null;
    independenceEffect: number | null;
    mutualInformationBits: number | null;
    entropyBits: number | null;
    conditionalEntropyBits: number | null;
    entropyRatio: number | null;
    diagonalMass: number | null;
    parityRunsP: number | null;
    parityRunsZ: number | null;
    ljungBoxP: number | null;
    maxAutocorrelation: number | null;
    structureStatus: 'stable' | 'shifted' | 'insufficient';
    hotDigit: number | null;
    coldDigit: number | null;
    hotZ: number | null;
    patternSupport: number;
    expectedGap: number;
    observedGap: number | null;
  };
  summary: string;
};

export type VolatilityState = {
  perTick: number;
  atr: number;
  shortLongRatio: number;
  percentile: number;
  regime: 'volatile' | 'quiet' | 'normal';
};

/**
 * Level-reversion (Ornstein–Uhlenbeck / AR(1) on the quote itself) model.
 *
 * The return-only engines are blind to this: a genuinely mean-reverting market
 * can have almost no return autocorrelation while its *level* is strongly
 * pulled back toward equilibrium, because the reversion is proportional to the
 * distance from the mean rather than to the last tick's move. Fitting
 * `quote[t] = a + phi·quote[t−1] + e` measures exactly that pull, and the fit
 * converts into a directional probability at any exit horizon:
 *
 *   E[Δh] = (x_t − mean)·(phi^h − 1),  sd[Δh] = σ·√((1 − phi^{2h}) / (1 − phi²))
 *
 * A random walk has phi ≈ 1, so the drift term vanishes and the published
 * probability collapses to a coin flip — the model cannot invent an edge.
 */
export type LevelReversionModel = {
  /** Quotes used in the fit. */
  sample: number;
  /** AR(1) coefficient on levels (1 = unit root / random walk). */
  phi: number;
  /** Equilibrium the fit pulls toward. */
  mean: number;
  /** Last quote in the fitted window. */
  last: number;
  /** One-tick residual standard deviation. */
  sigma: number;
  /** Stationary standard deviation of the level, σ/√(1 − phi²). */
  levelSigma: number;
  /** (last − mean) / levelSigma: how stretched the price is right now. */
  displacementZ: number;
  /** Half-life of a shock, in ticks. */
  halfLifeTicks: number | null;
  /** t-statistic of phi − 1 (H0: unit root). */
  tStatistic: number;
  /** Two-sided normal p-value of `tStatistic`. */
  pValue: number;
  /** True when the pull is strong enough to trade. */
  significant: boolean;
  /** Reads a rising quote as the winning side; false when the fit is unusable. */
  active: boolean;
};

export type QuoteMarketState = {
  kind: 'quote';
  regime: QuoteRegime;
  predictability: number;
  confidence: number;
  sample: number;
  /** Signed analysis direction: +1 strongly up, −1 strongly down. */
  direction: number;
  tickSpacingMs: number;
  volatility: VolatilityState;
  /** P(next quote rises) suggested by the analysis engines, when validated. */
  prior: number | null;
  /** AR(1)-on-levels reversion fit, or null when the market is too short. */
  levelReversion: LevelReversionModel | null;
  priorBacktest: PriorBacktest;
  engines: AnalysisEngine[];
  metrics: {
    efficiencyRatio100: number | null;
    efficiencyRatio300: number | null;
    hurst: number | null;
    varianceRatio: number | null;
    varianceRatioZ: number | null;
    varianceRatioP: number | null;
    ljungBoxP: number | null;
    maxAutocorrelation: number | null;
    lagOneAutocorrelation: number | null;
    runsZ: number | null;
    runsP: number | null;
    adx: number | null;
    plusDi: number | null;
    minusDi: number | null;
    trendSlope: number | null;
    trendTStatistic: number | null;
    /** t-statistic of the average return (the valid drift test). */
    driftTStatistic: number | null;
    ar1: number | null;
    halfLifeTicks: number | null;
    /** AR(1)-on-levels coefficient (the mean-reversion engine's fit). */
    levelReversionPhi: number | null;
    /** t-statistic of phi − 1 against the unit-root null. */
    levelReversionTStatistic: number | null;
    levelReversionP: number | null;
    /** Current stretch away from the fitted equilibrium, in stationary σ. */
    displacementZ: number | null;
    cusum: number | null;
    cusumSignificance: number | null;
    cadenceVariation: number | null;
  };
  summary: string;
};

export type MarketState = DigitMarketState | QuoteMarketState;

const UNIFORM = Array.from({ length: 10 }, () => 0.1);
const TESTS_PER_FAMILY = 8;
/** Unit-root t bar for the level-reversion engine (beyond Dickey–Fuller 1%). */
const LEVEL_REVERSION_T = 3.5;
/** Largest probability tilt one engine may publish. */
const LEVEL_REVERSION_MAX_TILT = 0.2;

function finiteDigits(digits: readonly number[]): number[] {
  return digits.filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9);
}

function normalize(values: readonly number[]): number[] {
  const clean = values.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  const total = clean.reduce((sum, value) => sum + value, 0);
  return total > 0 ? clean.map((value) => value / total) : clean.map(() => 1 / clean.length);
}

function mix(left: readonly number[], right: readonly number[], leftWeight: number): number[] {
  return normalize(left.map((value, index) => value * leftWeight + right[index] * (1 - leftWeight)));
}

function entropy(probabilities: readonly number[]): number {
  return -probabilities.reduce((sum, probability) => (probability > 0 ? sum + probability * Math.log2(probability) : sum), 0);
}

function counts(digits: readonly number[]): number[] {
  const result = Array<number>(10).fill(0);
  for (const digit of digits) result[digit] += 1;
  return result;
}

function transitions(digits: readonly number[]): number[][] {
  const table = Array.from({ length: 10 }, () => Array<number>(10).fill(0));
  for (let index = 1; index < digits.length; index += 1) table[digits[index - 1]][digits[index]] += 1;
  return table;
}

/** Counts from a digit to the digit `steps` ticks later. */
function transitionsAhead(digits: readonly number[], steps: number): number[][] {
  const table = Array.from({ length: 10 }, () => Array<number>(10).fill(0));
  for (let index = 0; index + steps < digits.length; index += 1) table[digits[index]][digits[index + steps]] += 1;
  return table;
}

function smoothed(countsValue: readonly number[], strength = 10): number[] {
  return normalize(countsValue.map((count) => count + strength / 10));
}

function totalVariation(left: readonly number[], right: readonly number[]): number {
  return 0.5 * left.reduce((sum, value, index) => sum + Math.abs(value - (right[index] ?? 0)), 0);
}

/** Exponentially weighted digit histogram; recent ticks matter most. */
function decayedHistogram(digits: readonly number[], halfLife: number): number[] {
  const weights = Array<number>(10).fill(0);
  const decay = Math.pow(0.5, 1 / Math.max(1, halfLife));
  let weight = 1;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    weights[digits[index]] += weight;
    weight *= decay;
  }
  return normalize(weights.map((value) => value + 0.2));
}

/**
 * The digit `horizon` ticks ahead, given the last `order` digits.
 *
 * The target is the digit at `origin + horizon`, not the next one: a digit
 * contract settles at its own exit tick, so a one-tick-ahead forecast is the
 * wrong question for a five-tick contract — and answering it anyway is exactly
 * what produced a negative out-of-sample skill on serially dependent streams.
 */
function contextForecast(digits: readonly number[], order: number, horizon = 1): { distribution: number[]; support: number } | null {
  const length = digits.length;
  if (length < order + horizon + 10) return null;
  let context = 0;
  const place = 10 ** order;
  for (let index = length - order; index < length; index += 1) context = context * 10 + digits[index];
  const countsValue = Array<number>(10).fill(0);
  let support = 0;
  // Rolling integer key: no substring allocation per tick. This runs hundreds
  // of times per market (every prior origin), so it has to stay cheap.
  let key = 0;
  for (let index = 0; index < length; index += 1) {
    key = (key * 10 + digits[index]) % place;
    if (index >= order - 1 && key === context && index + horizon < length) {
      countsValue[digits[index + horizon]] += 1;
      support += 1;
    }
  }
  if (support < 6) return null;
  return { distribution: smoothed(countsValue, 8), support };
}

// ---------------------------------------------------------------------------
// Digit prior — one pool of measured forecasts, one weight per angle.
//
// The analysis layer used to assemble the next-digit prior from a handful of
// hand-tuned heuristics (a decayed histogram, the transition row, an n-gram
// forecast, a "hot digit" boost and a lag-1 periodic copy) mixed by five
// coarse evidence numbers, and then graded it with a BACKTEST THAT BUILT A
// DIFFERENT PRIOR. An out-of-sample audit of the result was blunt: on a
// stationary biased stream the published prior scored WORSE than uniform
// (Brier skill −0.12), and on a reversal stream it was catastrophic (−6.6).
//
// This replaces it with the same principle the Rise/Fall panel already uses:
// every angle is its own forecast, its own weight comes from its own measured
// out-of-sample Brier skill, and anything that cannot beat uniform carries
// exactly zero weight. The pool is then VALIDATED as a whole on rows the
// weights never saw, which is the number the UI reports.
// ---------------------------------------------------------------------------

export type DigitPriorComponentId =
  | 'frequency'
  | 'recent'
  | 'transition'
  | 'pattern'
  | 'momentum'
  | 'drift'
  | 'reversal'
  | 'repeat'
  | 'spike'
  | 'gap';

export type DigitPriorComponent = {
  id: DigitPriorComponentId;
  label: string;
  /** Next-digit distribution from this angle, or null when it has nothing to say. */
  probabilities: number[] | null;
  /** Independent observations behind the forecast. */
  support: number;
  /** Out-of-sample Brier skill vs uniform, measured on rows before the validation tail. */
  skill: number | null;
  /** Weight used in the pool (0 when the angle did not beat uniform). */
  weight: number;
};

/** Uniform mass the pool always keeps, so no single angle can take it over. */
const PRIOR_UNIFORM_FLOOR = 0.4;
/** Origins used to score each angle's own out-of-sample skill. */
const PRIOR_WEIGHT_ORIGINS = 180;
/** Origins used to validate the assembled prior (never used for the weights). */
const PRIOR_VALIDATION_ORIGINS = 240;
/** A digit forecast never moves a digit further than this from uniform. */
const PRIOR_DIGIT_CLIP = 0.12;

const D = (value: number) => Math.max(1e-6, value);

function digitSlope(values: readonly number[]): { slope: number; t: number; residual: number } {
  const n = values.length;
  if (n < 12) return { slope: 0, t: 0, residual: 0 };
  const meanX = (n - 1) / 2;
  const meanY = mean(values);
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = index - meanX;
    sxy += dx * (values[index] - meanY);
    sxx += dx * dx;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  let sse = 0;
  for (let index = 0; index < n; index += 1) sse += (values[index] - (meanY + slope * (index - meanX))) ** 2;
  const residual = Math.sqrt(sse / Math.max(1, n - 2));
  const standardError = sxx > 0 ? residual / Math.sqrt(sxx) : 0;
  return { slope, t: standardError > 1e-9 ? slope / standardError : 0, residual };
}

/** AR(1) on the digit values themselves: the signed reversion / momentum fit. */
function digitAr1(values: readonly number[]): { mu: number; phi: number; sigma: number; t: number } {
  const n = values.length;
  if (n < 20) return { mu: 4.5, phi: 0, sigma: 3, t: 0 };
  let sumX = 0;
  let sumY = 0;
  for (let index = 1; index < n; index += 1) { sumX += values[index - 1]; sumY += values[index]; }
  const meanX = sumX / (n - 1);
  const meanY = sumY / (n - 1);
  let sxx = 0;
  let sxy = 0;
  for (let index = 1; index < n; index += 1) {
    const dx = values[index - 1] - meanX;
    sxx += dx * dx;
    sxy += dx * (values[index] - meanY);
  }
  const phi = sxx > 1e-9 ? sxy / sxx : 0;
  const intercept = meanY - phi * meanX;
  let sse = 0;
  for (let index = 1; index < n; index += 1) sse += (values[index] - (intercept + phi * values[index - 1])) ** 2;
  const variance = sse / Math.max(1, n - 2);
  const standardError = sxx > 1e-9 ? Math.sqrt(variance / sxx) : 0;
  return {
    mu: Math.abs(1 - phi) > 1e-6 ? intercept / (1 - phi) : meanY,
    phi,
    sigma: Math.sqrt(Math.max(1e-6, variance)),
    t: standardError > 1e-12 ? phi / standardError : 0,
  };
}

/** Gaussian distribution over the ten digits, from a predicted centre. */
function digitGaussian(center: number, deviation: number): number[] {
  const sd = Math.max(0.8, deviation);
  return normalize(UNIFORM.map((_, digit) => {
    const upper = digit === 9 ? 1 : normalCdf((digit + 0.5 - center) / sd);
    const lower = digit === 0 ? 0 : normalCdf((digit - 0.5 - center) / sd);
    return Math.max(1e-6, upper - lower);
  }));
}

/** Rate of exact repeats (digit[i] === digit[i-1]) and its binomial z vs 10%. */
function repeatStats(values: readonly number[]): { rate: number; z: number; sample: number } {
  if (values.length < 40) return { rate: 0.1, z: 0, sample: 0 };
  let hits = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] === values[index - 1]) hits += 1;
  const sample = values.length - 1;
  const rate = hits / sample;
  const standardError = Math.sqrt((0.1 * 0.9) / sample);
  return { rate, z: (rate - 0.1) / Math.max(1e-9, standardError), sample };
}

/** Largest burst of one digit inside the last `size` ticks. */
function burstStats(values: readonly number[], size = 20, digitCount = 10): { digit: number | null; count: number; p: number } {
  if (values.length < size) return { digit: null, count: 0, p: 1 };
  const recent = values.slice(-size);
  const tally = Array<number>(10).fill(0);
  for (const digit of recent) tally[digit] += 1;
  let digit = 0;
  for (let index = 1; index < digitCount; index += 1) if (tally[index] > tally[digit]) digit = index;
  const count = tally[digit];
  // P(any digit appears `count`+ times in `size` draws at 10%) — binomial tail,
  // Bonferroni over the ten digits.
  let tail = 0;
  for (let k = count; k <= size; k += 1) tail += binomialProbability(size, k, 0.1);
  return { digit: count > 0 ? digit : null, count, p: clamp(tail * digitCount, 0, 1) };
}

function binomialProbability(n: number, k: number, p: number): number {
  let logProbability = 0;
  for (let index = 0; index < k; index += 1) logProbability += Math.log((n - index) / (index + 1));
  logProbability += k * Math.log(p) + (n - k) * Math.log(1 - p);
  return Math.exp(logProbability);
}

/**
 * How over-dispersed the per-digit gap distribution is (variance / mean of the
 * gaps). A memoryless digit stream has geometric gaps, where this is 1. Above
 * 1.3 digit appearances are clustered, which is the only case in which "this
 * digit is overdue" is a measurement rather than the gambler's fallacy.
 */
function gapDispersion(values: readonly number[]): { ratio: number; overdue: number[]; p: number } {
  if (values.length < 200) return { ratio: 1, overdue: [], p: 1 };
  let weighted = 0;
  let squares = 0;
  let observations = 0;
  for (let digit = 0; digit < 10; digit += 1) {
    const gaps: number[] = [];
    let last = -1;
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] !== digit) continue;
      if (last >= 0) gaps.push(index - last);
      last = index;
    }
    if (gaps.length < 12) continue;
    const average = mean(gaps);
    const variance = gaps.reduce((total, gap) => total + (gap - average) ** 2, 0) / Math.max(1, gaps.length - 1);
    weighted += variance;
    squares += average;
    observations += 1;
  }
  if (!observations) return { ratio: 1, overdue: [], p: 1 };
  // variance/mean over all ten digits: 1.0 under a memoryless stream.
  const ratio = weighted / Math.max(1e-9, squares);
  // The variance of the ratio is roughly 4/n_gaps; a 2-sigma excess is a real
  // clustering signal. Convert to a one-sided p for the engine panel.
  const p = normalPValue((ratio - 1) / 0.28);
  const seen = Array<number>(10).fill(-1);
  for (let index = 0; index < values.length; index += 1) seen[values[index]] = index;
  const gapsNow = seen.map((index) => (index < 0 ? values.length : values.length - 1 - index));
  const cutoff = Math.max(12, (values.length / 10) * 1.6);
  const overdue = gapsNow.map((gap, digit) => ({ gap, digit })).filter((row) => row.gap >= cutoff).sort((left, right) => right.gap - left.gap).map((row) => row.digit);
  return { ratio, overdue, p };
}

/**
 * Every measured angle that can say something about the next digit.
 * Each one is independent of the others (they read different statistics), and
 * each returns null when it has no evidence at all — never a guess.
 */
export function digitPriorComponents(digits: readonly number[], horizon = 1): DigitPriorComponent[] {
  const history = digits.slice(-3_000);
  const last = history.at(-1) ?? 0;
  const steps = Math.max(1, Math.min(10, Math.round(horizon)));
  const components: Array<{ id: DigitPriorComponentId; label: string; probabilities: number[] | null; support: number }> = [];

  // 1. Long-run frequency (decayed, so old ticks fade). Unconditional: it is a
  //    claim about the marginal distribution and needs no local trigger.
  const long = decayedHistogram(history.slice(-600), 90);
  components.push({
    id: 'frequency', label: 'Decayed frequency · 600 ticks',
    probabilities: long,
    support: Math.min(600, history.length),
  });

  // 2. Short-run appearance. Also unconditional, and deliberately responsive.
  const recentCounts = counts(history.slice(-120));
  components.push({
    id: 'recent', label: 'Recent appearance · 120 ticks',
    probabilities: smoothed(recentCounts, 18),
    support: Math.min(120, history.length),
  });

  // 3. Lag-1 transition row for the digit that just printed. CONDITIONAL: the
  //    row only means something when this digit's outcomes differ from the
  //    marginal by more than their own sampling error, so that is tested
  //    locally before the row is allowed to speak.
  // The row is built from `last` to the digit `steps` ticks ahead, so a five-tick
  // contract is given the five-tick transition, not the one-tick one.
  const table = transitionsAhead(history.slice(-1_400), steps);
  const row = table[last] ?? Array<number>(10).fill(0);
  const rowTotal = row.reduce((total, value) => total + value, 0);
  let transition: number[] | null = null;
  if (rowTotal >= 60) {
    const expected = UNIFORM.map((probability) => probability * rowTotal);
    let chiSquare = 0;
    for (let digit = 0; digit < 10; digit += 1) chiSquare += ((row[digit] - expected[digit]) ** 2) / Math.max(1e-9, expected[digit]);
    // df 9; the 1% critical value is 21.7. A local test, so no family correction.
    if (chiSquare > 21.7) transition = smoothed(row, 14);
  }
  components.push({ id: 'transition', label: 'Transition row · P(next | last digit)', probabilities: transition, support: rowTotal });

  // 4. Recurring n-gram context. CONDITIONAL on the context repeating AND the
  //    observed follow-through differing from the marginal by 2.5 standard
  //    errors at that support.
  let pattern: number[] | null = null;
  let patternSupport = 0;
  for (const order of [3, 2, 4]) {
    const forecast = contextForecast(history, order, steps);
    if (!forecast || forecast.support < 10) continue;
    const top = Math.max(...forecast.distribution);
    const standardError = Math.sqrt(Math.max(1e-9, 0.1 * 0.9 / forecast.support));
    if ((top - 0.1) / standardError < 2.5) continue;
    pattern = pattern ? mix(pattern, forecast.distribution, forecast.support / (forecast.support + 20)) : forecast.distribution;
    patternSupport = Math.max(patternSupport, forecast.support);
  }
  components.push({ id: 'pattern', label: 'Repeated 2–4 digit context', probabilities: pattern, support: patternSupport });

  // 5. Momentum: the digit level itself is trending. CONDITIONAL on a
  //    significant slope, so a flat stream never pays for a drift guess.
  const short = history.slice(-60);
  const slope = digitSlope(short);
  components.push({
    id: 'momentum', label: 'Digit-level momentum · 60-tick slope',
    probabilities: short.length >= 40 && Math.abs(slope.t) >= 2
      ? digitGaussian(last + slope.slope * Math.min(steps, 6), Math.max(1.1, slope.residual * Math.sqrt(steps)))
      : null,
    support: short.length,
  });

  // 6. Drift: which digits have become more (or less) frequent than they used
  //    to be. This is the angle that catches a distribution that MOVED — the
  //    level-trend forecast above cannot see it.
  const recent300 = counts(history.slice(-150));
  const older900 = counts(history.slice(-1_050, -150));
  const recentTotal = recent300.reduce((total, value) => total + value, 0);
  const olderTotal = older900.reduce((total, value) => total + value, 0);
  let drift: number[] | null = null;
  if (recentTotal >= 100 && olderTotal >= 300) {
    const shifts = Array.from({ length: 10 }, (_, digit) => {
      const newRate = (recent300[digit] + 1) / (recentTotal + 10);
      const oldRate = (older900[digit] + 1) / (olderTotal + 10);
      const standardError = Math.sqrt(Math.max(1e-9, newRate * (1 - newRate) / recentTotal + oldRate * (1 - oldRate) / olderTotal));
      return { digit, z: (newRate - oldRate) / Math.max(1e-9, standardError) };
    });
    const strongest = shifts.reduce((best, row) => (Math.abs(row.z) > Math.abs(best.z) ? row : best), shifts[0]);
    // Bonferroni over ten digits: |z| ≥ 3.0 is a real move at the 1% family bar.
    if (Math.abs(strongest.z) >= 3) {
      drift = normalize(UNIFORM.map((_, digit) => 0.1 + 0.05 * Math.max(-1.2, Math.min(1.2, shifts[digit].z / 3))));
    }
  }
  components.push({ id: 'drift', label: 'Frequency drift · 150 vs 900 ticks', probabilities: drift, support: recentTotal + olderTotal });

  // 7. Reversal: the signed AR(1) pull, only when the reversion is significant.
  const ar1 = digitAr1(history.slice(-400));
  components.push({
    id: 'reversal', label: 'Digit AR(1) reversal · pull to the mean',
    probabilities: history.length >= 120 && ar1.phi < -0.02 && ar1.t <= -2
      ? digitGaussian(
        ar1.mu + Math.pow(ar1.phi, steps) * (last - ar1.mu),
        Math.max(1.1, ar1.sigma * Math.sqrt((1 - Math.pow(ar1.phi, 2 * steps)) / Math.max(1e-6, 1 - ar1.phi * ar1.phi))),
      )
      : null,
    support: Math.min(400, history.length),
  });

  // 8. Repetition: does this stream repeat more (or less) than 10%?
  const repeat = repeatStats(history.slice(-800));
  const repeatProbability = (() => {
    if (repeat.sample < 60 || Math.abs(repeat.z) < 2.5) return null;
    const boost = Math.tanh(repeat.z / 2.5) * 1.2;
    const distribution = Array<number>(10).fill(0.1);
    distribution[last] = Math.max(0.005, 0.1 + 0.12 * boost);
    return normalize(distribution);
  })();
  // "Repeats more often than 10%" is a statement about the NEXT tick. Five ticks
  // later the chain has moved on, so at longer horizons the angle abstains
  // rather than smuggling a one-tick effect into a five-tick contract.
  components.push({
    id: 'repeat', label: 'Exact repeat rate · vs 10%',
    probabilities: steps === 1 ? repeatProbability : null,
    support: repeat.sample,
  });

  // 9. Spike / burst: a digit that has arrived in a cluster.
  const burst = burstStats(history.slice(-200));
  components.push({
    id: 'spike', label: 'Appearance burst · last 20 ticks',
    probabilities: burst.digit !== null && burst.p < 0.05 && burst.count >= 4
      ? normalize(UNIFORM.map((_, digit) => (digit === burst.digit ? 0.1 + 0.08 * Math.min(2, burst.count / 4) : 0.1)))
      : null,
    support: 20,
  });

  // 10. Overdue digits — only when the gap distribution is measurably clustered.
  const gap = gapDispersion(history.slice(-1_500));
  components.push({
    id: 'gap', label: 'Overdue digits · clustered appearance',
    probabilities: gap.ratio > 1.3 && gap.overdue.length
      ? normalize(UNIFORM.map((_, digit) => (gap.overdue.includes(digit) ? 0.1 + 0.03 * Math.min(3, gap.overdue.indexOf(digit) + 1) : 0.1)))
      : null,
    support: Math.min(1_500, history.length),
  });

  return components.map((component) => ({ ...component, skill: null, weight: 0 }));
}

/**
 * The pooled prior at an arbitrary point in time, with weights already decided.
 *
 * This is the function the analysis ships and the function its audit replays:
 * one recipe, so the skill number describes the number on screen. It is also
 * what the prediction layer uses to score the analysis prior per contract on
 * its own held-out rows.
 */
/**
 * How far the pool is allowed to commit: the share of uniform mass it always
 * keeps, and the most any single digit may be moved from 10%.
 *
 * Both are earned rather than fixed. A stream whose own replay shows no skill
 * keeps the conservative defaults (40% uniform, ±12 points), so it is
 * bit-identical to the old recipe. A stream whose replay shows real skill is
 * allowed to commit further, because a prior that is systematically 14 points
 * shy of what actually happens is not safe, it is miscalibrated in the other
 * direction — and under-confidence costs the same trades as over-confidence.
 */
export type DigitPriorLimits = { floor: number; clip: number };

export const CONSERVATIVE_DIGIT_PRIOR_LIMITS: DigitPriorLimits = { floor: PRIOR_UNIFORM_FLOOR, clip: PRIOR_DIGIT_CLIP };

/**
 * Translate the pool's own measured out-of-sample skill into how far it may
 * commit. The mapping is deliberately gentle and bounded: it can widen the band
 * to ±30 points and cut the uniform floor to 8%, never further, and it never
 * touches a pool that measured no skill at all.
 */
export function digitPriorLimitsFor(replaySkill: number | null): DigitPriorLimits {
  const skill = replaySkill !== null && Number.isFinite(replaySkill) ? Math.max(0, replaySkill) : 0;
  return {
    floor: clamp(PRIOR_UNIFORM_FLOOR - 8 * skill, 0.08, PRIOR_UNIFORM_FLOOR),
    clip: clamp(PRIOR_DIGIT_CLIP + 2 * skill, PRIOR_DIGIT_CLIP, 0.3),
  };
}

export function digitPriorWithWeights(
  digits: readonly number[],
  horizon: number,
  weights: ReadonlyMap<DigitPriorComponentId, number>,
  limits: DigitPriorLimits = CONSERVATIVE_DIGIT_PRIOR_LIMITS,
): { prior: number[]; fired: DigitPriorComponentId[] } {
  const steps = Math.max(1, Math.min(10, Math.round(horizon)));
  const components = digitPriorComponents(digits, steps);
  let total = 0;
  const fired: DigitPriorComponentId[] = [];
  for (const component of components) {
    const weight = weights.get(component.id) ?? 0;
    if (!component.probabilities || weight <= 0) continue;
    total += weight;
    fired.push(component.id);
  }
  const floor = clamp(limits.floor, 0.02, PRIOR_UNIFORM_FLOOR);
  const clip = clamp(limits.clip, PRIOR_DIGIT_CLIP, 0.45);
  let prior = UNIFORM.map((value) => value * floor);
  if (total > 1e-9) {
    for (const component of components) {
      const weight = weights.get(component.id) ?? 0;
      if (!component.probabilities || weight <= 0) continue;
      const scale = (weight / total) * (1 - floor);
      prior = prior.map((value, digit) => value + component.probabilities![digit] * scale);
    }
  }
  prior = normalize(prior.map((value) => D(value)));
  prior = normalize(prior.map((value) => clamp(value, 0.1 - clip, 0.1 + clip)));
  return { prior, fired };
}

/** Brier loss of a forecast against one target digit (ten-class). */
function digitBrier(probabilities: readonly number[], target: number): number {
  let loss = 0;
  for (let digit = 0; digit < 10; digit += 1) loss += (probabilities[digit] - (digit === target ? 1 : 0)) ** 2;
  return loss;
}

/**
 * Scores each angle on rows the live prior will never see: for a set of past
 * origins, the component is rebuilt from the history available at that origin
 * and its ten-class Brier loss is compared with uniform.
 */
function scoreDigitComponents(
  digits: readonly number[],
  origins: readonly number[],
  horizon = 1,
): Map<DigitPriorComponentId, { skill: number; sample: number }> {
  const totals = new Map<DigitPriorComponentId, { loss: number; base: number; sample: number }>();
  for (const origin of origins) {
    const history = digits.slice(0, origin + 1);
    if (history.length < 200) continue;
    // Score against the digit the contract actually settles on.
    const target = digits[origin + horizon];
    if (!Number.isInteger(target)) continue;
    let base = 0;
    for (let digit = 0; digit < 10; digit += 1) base += (0.1 - (digit === target ? 1 : 0)) ** 2;
    for (const component of digitPriorComponents(history, horizon)) {
      if (!component.probabilities) continue;
      const entry = totals.get(component.id) ?? { loss: 0, base: 0, sample: 0 };
      entry.loss += digitBrier(component.probabilities, target);
      entry.base += base;
      entry.sample += 1;
      totals.set(component.id, entry);
    }
  }
  const skills = new Map<DigitPriorComponentId, { skill: number; sample: number }>();
  for (const [id, entry] of totals) {
    skills.set(id, { skill: entry.base > 1e-12 ? 1 - entry.loss / entry.base : 0, sample: entry.sample });
  }
  return skills;
}

/**
 * The shipped next-digit prior: a linear pool of the measured angles.
 *
 * Weight = the angle's own out-of-sample Brier skill, shrunk by its sample and
 * capped, with a uniform floor of 40%. An angle that did not beat uniform gets
 * exactly zero, so on a fair stream the pool IS uniform and the published
 * probability cannot drift.
 */
export function buildDigitPrior(digits: readonly number[], horizon = 1): {
  prior: number[];
  strength: number;
  components: DigitPriorComponent[];
  weights: Map<DigitPriorComponentId, number>;
  limits: DigitPriorLimits;
  replay: { skill: number | null; sample: number };
} {
  const steps = Math.max(1, Math.min(10, Math.round(horizon)));
  const components = digitPriorComponents(digits, steps);
  const sample = digits.length;
  const validationStart = Math.max(350, sample - 400);
  const firstOrigin = Math.max(300, validationStart - 900);
  const trainingOrigins: number[] = [];
  const stride = Math.max(2, Math.floor((validationStart - firstOrigin) / PRIOR_WEIGHT_ORIGINS));
  for (let origin = firstOrigin; origin < validationStart; origin += stride) trainingOrigins.push(origin);
  const skills = scoreDigitComponents(digits, trainingOrigins, steps);
  const weights = new Map<DigitPriorComponentId, number>();
  let rawTotal = 0;
  for (const component of components) {
    const measured = skills.get(component.id);
    // The weight is a property of the ANGLE, not of this particular tick: an
    // angle that is silent right now must still carry its weight when it fires
    // during validation, or the audited prior would not be the shipped one.
    if (!measured || measured.sample < 12) {
      component.skill = measured ? measured.skill : null;
      component.weight = 0;
      weights.set(component.id, 0);
      continue;
    }
    // Shrink the measured skill by its sample: a dozen lucky rows is not
    // evidence that an angle will keep working.
    const shrink = measured.sample / (measured.sample + 40);
    const skill = Math.max(0, measured.skill) * shrink;
    component.skill = measured.skill;
    component.weight = skill;
    weights.set(component.id, skill);
    rawTotal += skill;
  }
  void rawTotal;
  // How far may the pool commit? Its OWN replay on the training origins says
  // so: the same weights, the same recipe, scored on rows that were never used
  // to choose them.
  let replayLoss = 0;
  let replayBase = 0;
  let replayRows = 0;
  for (const origin of trainingOrigins) {
    const target = digits[origin + steps];
    if (!Number.isInteger(target)) continue;
    const history = digits.slice(0, origin + 1);
    if (history.length < 200) continue;
    const { prior: replayPrior } = digitPriorWithWeights(history, steps, weights);
    replayLoss += digitBrier(replayPrior, target);
    let uniformLoss = 0;
    for (let digit = 0; digit < 10; digit += 1) uniformLoss += (0.1 - (digit === target ? 1 : 0)) ** 2;
    replayBase += uniformLoss;
    replayRows += 1;
  }
  const replaySkill = replayRows >= 12 && replayBase > 1e-12 ? 1 - replayLoss / replayBase : null;
  const limits = digitPriorLimitsFor(replaySkill);
  const { prior } = digitPriorWithWeights(digits, steps, weights, limits);
  const strength = totalVariation(prior, UNIFORM);
  return { prior, strength, components, weights, limits, replay: { skill: replaySkill, sample: replayRows } };
}

/**
 * Honest out-of-sample audit of the shipped prior.
 *
 * The weights are fitted on the earlier part of the history only; the prior is
 * then rebuilt at each origin in the validation tail from that origin's own
 * history and scored on the next digit. Nothing in the scored rows was used to
 * choose a weight, so `skill` describes what the analysis layer would really
 * have published.
 */
function backtestDigitPrior(digits: readonly number[], horizon = 1): PriorBacktest {
  const empty: PriorBacktest = { sample: 0, brier: null, baseline: null, skill: null, accuracy: null, improved: false };
  const sample = digits.length;
  const steps = Math.max(1, Math.min(10, Math.round(horizon)));
  if (sample < 800) return empty;
  // Build once: this is what the live analysis ships, weights included.
  const built = buildDigitPrior(digits, steps);
  const validationStart = Math.max(350, sample - 700);
  const stride = Math.max(1, Math.floor((sample - 1 - validationStart) / PRIOR_VALIDATION_ORIGINS));
  let brier = 0;
  let baseline = 0;
  let hits = 0;
  let rows = 0;
  const improvements: number[] = [];
  for (let origin = validationStart; origin < sample - 1 - steps; origin += stride) {
    const history = digits.slice(0, origin + 1);
    // The audit replays the SHIPPED recipe, commit band included.
    const { prior } = digitPriorWithWeights(history, steps, built.weights, built.limits);
    const target = digits[origin + steps];
    const priorLoss = digitBrier(prior, target);
    let uniformLoss = 0;
    for (let digit = 0; digit < 10; digit += 1) uniformLoss += (0.1 - (digit === target ? 1 : 0)) ** 2;
    brier += priorLoss;
    baseline += uniformLoss;
    improvements.push(uniformLoss - priorLoss);
    if (prior.indexOf(Math.max(...prior)) === target) hits += 1;
    rows += 1;
  }
  if (rows < 20) return { ...empty, sample: rows };
  const skill = baseline > 1e-12 ? 1 - brier / baseline : null;
  const accuracy = hits / rows;
  // Paired test of the prior against uniform on the SAME rows. A ten-class
  // Brier gain is small even for a real edge, so the raw skill alone is a weak
  // gate; this asks whether the gain is consistent row by row, which is the
  // same test the prediction layer uses for its own skill.
  const meanImprovement = improvements.reduce((total, value) => total + value, 0) / rows;
  const improvementSd = Math.sqrt(improvements.reduce((total, value) => total + (value - meanImprovement) ** 2, 0) / Math.max(1, rows - 1));
  const pairedZ = improvementSd > 1e-12 ? (meanImprovement / (improvementSd / Math.sqrt(rows))) : 0;
  return {
    sample: rows,
    brier: brier / rows,
    baseline: baseline / rows,
    skill,
    accuracy,
    pairedZ,
    // A prior is CREDITED only when it beat uniform out of sample by a margin
    // that is statistically real. The bar is 1.5 rather than 2 because a
    // ten-class Brier gain from one biased digit is small by construction
    // (~1.5% even for a perfect forecast), and the confidence the layer grants
    // scales continuously with the z rather than flipping at a threshold.
    improved: skill !== null && skill > 0.004 && pairedZ >= 1.5,
  };
}

/** Layer 1 for digit markets (Over/Under, Even/Odd, Matches). */
export function analyzeDigitState(
  input: readonly number[],
  options: { recentWindow?: number; horizon?: number } = {},
): DigitMarketState {
  const horizon = Math.max(1, Math.min(10, Math.round(options.horizon ?? 1)));
  const digits = finiteDigits(input);
  const sample = digits.length;
  const recentWindow = Math.max(300, Math.min(options.recentWindow ?? 1_200, sample));
  if (sample < 300) {
    return {
      kind: 'digit', regime: 'insufficient', predictability: 0, confidence: 0, sample,
      prior: null, priorStrength: 0, priorComponents: [],
      priorLimits: CONSERVATIVE_DIGIT_PRIOR_LIMITS, priorReplay: { skill: null, sample: 0 },
      priorBacktest: { sample: 0, brier: null, baseline: null, skill: null, accuracy: null, improved: false },
      engines: [],
      metrics: {
        uniformityChiSquare: null, uniformityP: null, uniformityEffect: null,
        independenceChiSquare: null, independenceP: null, independenceEffect: null, mutualInformationBits: null,
        entropyBits: null, conditionalEntropyBits: null, entropyRatio: null, diagonalMass: null,
        parityRunsP: null, parityRunsZ: null, ljungBoxP: null, maxAutocorrelation: null,
        structureStatus: 'insufficient', hotDigit: null, coldDigit: null, hotZ: null,
        patternSupport: 0, expectedGap: 10, observedGap: null,
      },
      summary: `Only ${sample} validated digits — the analysis engines need at least 300 ticks to measure structure.`,
    };
  }

  const window = digits.slice(-recentWindow);
  const recent = window.slice(-1_000);
  const engines: AnalysisEngine[] = [];
  const alpha = 0.05 / TESTS_PER_FAMILY;

  // 1. Marginal uniformity.
  const counts1000 = counts(recent);
  const uniformity = chiSquareGoodnessOfFit(counts1000);
  const biasEngine: AnalysisEngine = {
    id: 'uniformity', label: 'Uniformity χ² · every digit equal', family: 'distribution',
    verdict: uniformity.pValue < alpha ? (uniformity.effect > 0.05 ? 'biased digit distribution' : 'weak bias') : 'uniform within sampling error',
    value: null, strength: uniformity.pValue < alpha ? clamp(uniformity.effect / 0.08, 0, 1) : 0,
    pValue: uniformity.pValue, sample: uniformity.sample,
    detail: `χ² = ${uniformity.statistic.toFixed(1)} (df ${uniformity.degreesOfFreedom}), p = ${uniformity.pValue.toFixed(4)}, Cramér's V = ${uniformity.effect.toFixed(3)}.`,
  };
  engines.push(biasEngine);

  // 2. First-order transition independence + persistence.
  const table = transitions(recent);
  const independence = chiSquareIndependence(table);
  const diagonalMass = independence.sample > 0 ? table.reduce((sum, row, digit) => sum + row[digit], 0) / independence.sample : 0.1;
  const dependenceEngine: AnalysisEngine = {
    id: 'transition-independence', label: 'Markov dependence · lag-1 transitions', family: 'serial',
    verdict: independence.pValue < alpha ? (diagonalMass > 0.11 ? 'repeating transitions (persistent)' : 'transitions deviate from independence') : 'transitions consistent with independence',
    value: diagonalMass > 0.1 ? 1 : diagonalMass < 0.1 ? -1 : 0,
    strength: independence.pValue < alpha ? clamp(independence.effect / 0.08, 0, 1) : 0,
    pValue: independence.pValue, sample: independence.sample,
    detail: `χ² = ${independence.statistic.toFixed(1)} (df ${independence.degreesOfFreedom}), p = ${independence.pValue.toFixed(4)}; diagonal mass ${(diagonalMass * 100).toFixed(1)}% vs 10% chance; mutual information ${independence.mutualInformationBits.toFixed(4)} bits.`,
  };
  engines.push(dependenceEngine);

  // 3. Conditional entropy (how much of the next digit the previous one explains).
  let conditionalEntropy = Math.log2(10);
  for (let rowDigit = 0; rowDigit < 10; rowDigit += 1) {
    const rowTotal = table[rowDigit].reduce((sum, value) => sum + value, 0);
    if (!rowTotal) continue;
    const rowEntropy = entropy(table[rowDigit].map((value) => value / rowTotal));
    conditionalEntropy -= (rowTotal / independence.sample) * (Math.log2(10) - rowEntropy);
  }
  conditionalEntropy = clamp(conditionalEntropy, 0, Math.log2(10));
  const marginalEntropy = entropy(counts1000.map((value) => value / Math.max(1, uniformity.sample)));
  const entropyRatio = conditionalEntropy / Math.log2(10);
  const informationEngine: AnalysisEngine = {
    id: 'entropy-rate', label: 'Conditional entropy · H(next | previous)', family: 'information',
    verdict: entropyRatio < 0.985 ? 'the past compresses the next digit' : 'next digit is essentially uncompressible',
    value: null, strength: entropyRatio < 0.985 ? clamp((0.985 - entropyRatio) / 0.06, 0, 1) : 0,
    pValue: independence.pValue < 0.05 ? independence.pValue : null, sample: independence.sample,
    detail: `H(next|previous) = ${conditionalEntropy.toFixed(3)} bits against a ${Math.log2(10).toFixed(3)}-bit maximum (${(entropyRatio * 100).toFixed(1)}% of maximum); marginal entropy ${marginalEntropy.toFixed(3)} bits.`,
  };
  engines.push(informationEngine);

  // 4. Parity runs.
  const paritySigns = recent.slice(-600).map((digit) => (digit % 2 === 0 ? 1 : -1));
  const parityRuns = runsTest(paritySigns);
  const runsEngine: AnalysisEngine = {
    id: 'parity-runs', label: 'Parity runs · even/odd clustering', family: 'serial',
    verdict: parityRuns.pValue < alpha ? (parityRuns.direction === 'alternating' ? 'parity alternates more than chance' : 'parity clusters more than chance') : 'parity pattern consistent with chance',
    value: parityRuns.direction === 'alternating' ? 1 : parityRuns.direction === 'clustered' ? -1 : 0,
    strength: parityRuns.pValue < alpha ? clamp(Math.abs(parityRuns.zScore) / 3.5, 0, 1) : 0,
    pValue: parityRuns.pValue, sample: parityRuns.positives + parityRuns.negatives,
    detail: `${parityRuns.runs} runs against ${parityRuns.expectedRuns.toFixed(1)} expected; z = ${parityRuns.zScore.toFixed(2)}, p = ${parityRuns.pValue.toFixed(4)}.`,
  };
  engines.push(runsEngine);

  // 5. Periodicity / autocorrelation of the digit series.
  const lb = ljungBox(recent, 12);
  const periodEngine: AnalysisEngine = {
    id: 'periodicity', label: 'Periodicity · Ljung–Box lags 1–12', family: 'serial',
    verdict: lb.pValue < alpha ? 'digit series carries repeatable lag structure' : 'no repeatable lag structure',
    value: lb.maxAutocorrelation >= 0 ? 1 : -1,
    strength: lb.pValue < alpha ? clamp(Math.abs(lb.maxAutocorrelation) / 0.12, 0, 1) : 0,
    pValue: lb.pValue, sample: lb.sample,
    detail: `Q = ${lb.statistic.toFixed(1)} (df ${lb.degreesOfFreedom}), p = ${lb.pValue.toFixed(4)}; strongest |correlation| ${Math.abs(lb.maxAutocorrelation).toFixed(3)} at the inspected lags.`,
  };
  engines.push(periodEngine);

  // 6. Hot / cold drift: recent 300 against the older stream, Bonferroni over 10 digits.
  const recent300 = counts(window.slice(-300));
  const older = counts(window.slice(-1_000, -300));
  const olderTotal = older.reduce((sum, value) => sum + value, 0);
  const recentTotal = recent300.reduce((sum, value) => sum + value, 0);
  let hotDigit: number | null = null;
  let coldDigit: number | null = null;
  let hotZ = 0;
  for (let digit = 0; digit < 10; digit += 1) {
    const pooled = (recent300[digit] + older[digit]) / Math.max(1, recentTotal + olderTotal);
    const standardError = Math.sqrt(Math.max(1e-9, pooled * (1 - pooled) * (1 / Math.max(1, recentTotal) + 1 / Math.max(1, olderTotal))));
    const zScore = ((recent300[digit] / Math.max(1, recentTotal)) - (older[digit] / Math.max(1, olderTotal))) / Math.max(1e-9, standardError);
    if (Math.abs(zScore) > Math.abs(hotZ)) { hotZ = zScore; hotDigit = digit; coldDigit = digit; }
  }
  if (hotDigit !== null) {
    if (hotZ > 0) coldDigit = counts(window.slice(-1_000, -300)).indexOf(Math.max(...older));
    else coldDigit = hotDigit;
    if (hotZ < 0) { coldDigit = hotDigit; hotDigit = null; }
  }
  const hotColdP = normalPValue(hotZ) * 10;
  const driftEngine: AnalysisEngine = {
    id: 'hot-cold-drift', label: 'Hot / cold drift · recent 300 vs prior', family: 'distribution',
    verdict: hotColdP < 0.05 ? (hotZ > 0 ? `digit ${hotDigit} is running hot` : `digit ${coldDigit} is running cold`) : 'no digit is running significantly hot or cold',
    value: hotZ > 0 ? 1 : hotZ < 0 ? -1 : 0,
    strength: hotColdP < 0.05 ? clamp(Math.abs(hotZ) / 3.5, 0, 1) : 0,
    pValue: clamp(hotColdP, 0, 1), sample: recentTotal + olderTotal,
    detail: `Largest drift z = ${hotZ.toFixed(2)} after a 10-digit Bonferroni adjustment (p = ${clamp(hotColdP, 0, 1).toFixed(4)}); recent window ${recentTotal} ticks, reference ${olderTotal}.`,
  };
  engines.push(driftEngine);

  // 7. Recurring context pattern (n-gram support and lift).
  let patternSupport = 0;
  let patternLift = 0;
  let patternP: number | null = null;
  for (const order of [4, 3, 2]) {
    const forecast = contextForecast(window, order);
    if (!forecast) continue;
    const best = forecast.distribution.indexOf(Math.max(...forecast.distribution));
    const lift = forecast.distribution[best] - 0.1;
    if (forecast.support >= 8 && lift > patternLift) {
      patternSupport = forecast.support;
      patternLift = lift;
      patternP = normalPValue(lift / Math.max(0.001, Math.sqrt(0.1 * 0.9 / forecast.support)));
    }
  }
  const patternEngine: AnalysisEngine = {
    id: 'context-pattern', label: 'Recurring context · repeated 2–4 digit patterns', family: 'pattern',
    verdict: patternSupport && patternP !== null && patternP < alpha ? 'the current context has repeated with a biased next digit' : 'current context has no repeatable next digit',
    value: null, strength: patternSupport && patternP !== null && patternP < alpha ? clamp(patternLift / 0.08, 0, 1) : 0,
    pValue: patternP, sample: patternSupport,
    detail: patternSupport ? `${patternSupport} previous matches of the current context; best next-digit lift ${(patternLift * 100).toFixed(1)} pts (p = ${(patternP ?? 1).toFixed(4)}).` : 'The current 2–4 digit context does not repeat often enough to learn from.',
  };
  engines.push(patternEngine);

  // 8. Structural break: frequencies or transitions have shifted.
  const split = Math.max(1, Math.floor(window.length * 0.6));
  const structure = marketStructure(window.slice(0, split), window.slice(split));
  const shiftEngine: AnalysisEngine = {
    id: 'structure-break', label: 'Structural stability · frequency + transitions', family: 'structure',
    verdict: structure.status === 'shifted' ? 'the market has shifted away from the fitted window' : structure.status === 'stable' ? 'stable over the inspection window' : 'too little recent data',
    value: structure.status === 'shifted' ? -1 : 0,
    strength: structure.status === 'shifted' ? clamp(Math.max(structure.marginalDivergence / 0.2, (structure.transitionDivergence ?? 0) / 0.35), 0, 1) : 0,
    pValue: null, sample: structure.referenceSample + structure.recentSample,
    detail: `Jensen–Shannon divergence ${structure.marginalDivergence.toFixed(3)} (shift threshold ${structure.marginalThreshold}) and transition divergence ${structure.transitionDivergence === null ? '—' : structure.transitionDivergence.toFixed(3)} (threshold ${structure.transitionThreshold}).`,
  };
  engines.push(shiftEngine);

  // 9. Gap hazard: are digits overdue relative to their geometric expectation?
  const lastSeen = Array<number>(10).fill(-1);
  for (let index = 0; index < window.length; index += 1) lastSeen[window[index]] = index;
  const gaps = lastSeen.map((index) => (index < 0 ? window.length : window.length - 1 - index));
  const averageGap = mean(gaps);
  const observedGap = gaps[digits.at(-1) ?? 0] ?? null;
  const gapEngine: AnalysisEngine = {
    id: 'gap-hazard', label: 'Gap hazard · overdue digits', family: 'distribution',
    verdict: averageGap > 14 ? 'some digits are unusually overdue' : 'digit gaps close to the 10-tick expectation',
    value: null, strength: clamp((averageGap - 10) / 12, 0, 1) * 0.5,
    pValue: null, sample: window.length,
    detail: `Mean time since each digit last appeared is ${averageGap.toFixed(1)} ticks (10 expected); the last digit's gap is ${observedGap ?? '—'}.`,
  };
  engines.push(gapEngine);

  // Synthesis: only significant, material effects count.
  const biasStrength = uniformity.pValue < alpha ? clamp(uniformity.effect / 0.07, 0, 1) : 0;
  const dependenceStrength = independence.pValue < alpha ? clamp(independence.effect / 0.07, 0, 1) : 0;
  const informationStrength = independence.pValue < alpha ? clamp((0.995 - entropyRatio) / 0.05, 0, 1) : 0;
  const runsStrength = parityRuns.pValue < alpha ? clamp(Math.abs(parityRuns.zScore) / 3.5, 0, 1) : 0;
  const periodStrength = lb.pValue < alpha ? clamp(Math.abs(lb.maxAutocorrelation) / 0.1, 0, 1) : 0;
  const driftStrength = hotColdP < 0.05 ? clamp(Math.abs(hotZ) / 3.5, 0, 1) : 0;
  const patternStrength = patternP !== null && patternP < alpha ? clamp(patternLift / 0.07, 0, 1) : 0;
  const shiftStrength = structure.status === 'shifted' ? 0.4 : 0;
  const contributions = [biasStrength, dependenceStrength, informationStrength, runsStrength, periodStrength, driftStrength, patternStrength];
  const combined = 1 - contributions.reduce((product, value) => product * (1 - 0.7 * clamp(value, 0, 1)), 1);
  const sampleFactor = clamp((sample - 300) / 900, 0.25, 1);
  const predictability = clamp(combined * sampleFactor, 0, 0.95);
  const confidence = clamp(predictability * clamp(sample / 1_200, 0.35, 1), 0, 0.95);

  const evidence = {
    bias: biasStrength,
    dependence: Math.max(dependenceStrength, informationStrength),
    pattern: patternStrength,
    hotCold: driftStrength,
    periodicity: Math.max(periodStrength, runsStrength),
  };
  // Every angle is always measured, so the panel can show what was looked at
  // even when nothing earned weight. The weights and the audit are only fitted
  // when the stream showed structure at all (predictability ≥ 0.1), because a
  // full weight search on a fair stream is pure cost: no angle can beat uniform
  // there by construction.
  const components = digitPriorComponents(digits, horizon);
  const built = predictability >= 0.1 ? buildDigitPrior(digits, horizon) : null;
  const priorBacktest = built
    ? backtestDigitPrior(digits, horizon)
    : { sample: 0, brier: null, baseline: null, skill: null, accuracy: null, improved: false };
  const significant = engines.filter((engine) => engine.strength > 0 || (engine.pValue !== null && engine.pValue < 0.05));
  const regime: DigitRegime = structure.status === 'shifted' && predictability > 0.12
    ? 'regime-shifting'
    : biasStrength >= Math.max(dependenceStrength, periodStrength, driftStrength) && biasStrength > 0.15
      ? 'biased'
      : Math.max(dependenceStrength, informationStrength, periodStrength, driftStrength, patternStrength) > 0.12
        ? 'serially-dependent'
        : 'random';
  const summary = regime === 'random'
    ? `The ${engines.length} analysis engines found no material, significant structure in ${sample} digits — predictability ${(predictability * 100).toFixed(0)}%. Prediction and entry engines are therefore told to stay neutral.`
    : `The ${engines.length} analysis engines found ${significant.length} significant effect${significant.length === 1 ? '' : 's'} in ${sample} digits: ${significant.map((engine) => engine.id).join(', ')}. Regime: ${regime}.`;

  return {
    kind: 'digit', regime, predictability, confidence, sample,
    // The prior is a FORECAST, not yet a claim: it ships with its own measured
    // audit, and the prediction layer decides how much weight each contract
    // gives it from that audit (see `confirmDigitContract`). Withholding it
    // here was the second half of why a validated bias never reached the
    // published probability.
    prior: built ? built.prior : null,
    priorStrength: built ? built.strength : 0,
    priorComponents: built ? built.components : components,
    priorLimits: built ? built.limits : CONSERVATIVE_DIGIT_PRIOR_LIMITS,
    priorReplay: built ? built.replay : { skill: null, sample: 0 },
    priorBacktest,
    engines,
    metrics: {
      uniformityChiSquare: uniformity.statistic, uniformityP: uniformity.pValue, uniformityEffect: uniformity.effect,
      independenceChiSquare: independence.statistic, independenceP: independence.pValue, independenceEffect: independence.effect,
      mutualInformationBits: independence.mutualInformationBits,
      entropyBits: marginalEntropy, conditionalEntropyBits: conditionalEntropy, entropyRatio,
      diagonalMass,
      parityRunsP: parityRuns.pValue, parityRunsZ: parityRuns.zScore,
      ljungBoxP: lb.pValue, maxAutocorrelation: lb.maxAutocorrelation,
      structureStatus: structure.status,
      hotDigit, coldDigit, hotZ,
      patternSupport, expectedGap: 10, observedGap,
    },
    summary,
  };
}

/** Wilder's ADX with +DI / −DI over the latest `period`-smoothed window. */
function adxState(prices: readonly number[], period = 14): { adx: number; plusDi: number; minusDi: number } {
  const length = prices.length;
  if (length < period * 2 + 2) return { adx: 0, plusDi: 0.5, minusDi: 0.5 };
  let plus = 0;
  let minus = 0;
  let trueRange = 0;
  let smoothedPlus = 0;
  let smoothedMinus = 0;
  let smoothedRange = 0;
  let adx = 0;
  const dxValues: number[] = [];
  for (let index = 1; index < length; index += 1) {
    const up = prices[index] - prices[index - 1];
    const down = prices[index - 1] - prices[index];
    plus = up > down && up > 0 ? up : 0;
    minus = down > up && down > 0 ? down : 0;
    trueRange = Math.max(prices[index], prices[index - 1]) - Math.min(prices[index], prices[index - 1]);
    if (index <= period) {
      smoothedPlus += plus;
      smoothedMinus += minus;
      smoothedRange += trueRange;
      continue;
    }
    smoothedPlus = smoothedPlus - smoothedPlus / period + plus;
    smoothedMinus = smoothedMinus - smoothedMinus / period + minus;
    smoothedRange = smoothedRange - smoothedRange / period + trueRange;
    if (smoothedRange <= 1e-12) continue;
    const plusDi = 100 * (smoothedPlus / smoothedRange);
    const minusDi = 100 * (smoothedMinus / smoothedRange);
    const sum = plusDi + minusDi;
    const dx = sum > 0 ? 100 * Math.abs(plusDi - minusDi) / sum : 0;
    dxValues.push(dx);
  }
  if (dxValues.length >= period) {
    adx = mean(dxValues.slice(-period));
  } else if (dxValues.length) {
    adx = mean(dxValues);
  }
  const range = Math.max(1e-12, smoothedRange);
  return { adx, plusDi: 100 * (smoothedPlus / range), minusDi: 100 * (smoothedMinus / range) };
}

/** Ordinary least squares slope on the latest `window` quotes and its t-statistic. */
function regressionTrend(prices: readonly number[], window = 200): { slope: number; tStatistic: number } {
  const values = prices.slice(-window);
  const n = values.length;
  if (n < 30) return { slope: 0, tStatistic: 0 };
  const meanX = (n - 1) / 2;
  const meanY = mean(values);
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < n; index += 1) {
    sxy += (index - meanX) * (values[index] - meanY);
    sxx += (index - meanX) ** 2;
  }
  if (!(sxx > 0)) return { slope: 0, tStatistic: 0 };
  const slope = sxy / sxx;
  let residual = 0;
  for (let index = 0; index < n; index += 1) residual += (values[index] - (meanY + slope * (index - meanX))) ** 2;
  const standardError = Math.sqrt(residual / Math.max(1, n - 2) / sxx);
  return { slope, tStatistic: standardError > 1e-12 ? slope / standardError : 0 };
}

/** Kaufman efficiency ratio: net move divided by the path it travelled. */
function efficiencyRatio(prices: readonly number[], window: number): number {
  const values = prices.slice(-window);
  if (values.length < 20) return 0;
  let path = 0;
  for (let index = 1; index < values.length; index += 1) path += Math.abs(values[index] - values[index - 1]);
  return path > 1e-12 ? Math.abs(values.at(-1)! - values[0]) / path : 0;
}

/**
 * t-statistic of the average return. A regression t-statistic on price levels
 * is not valid for a random walk (it is spuriously large because the regressor
 * is persistent), so significance is tested on returns instead.
 */
function returnDriftTStatistic(returns: readonly number[], window = 300): number {
  const values = returns.slice(-window);
  if (values.length < 30) return 0;
  const deviation = standardDeviation(values);
  if (!(deviation > 1e-12)) return 0;
  return mean(values) / (deviation / Math.sqrt(values.length));
}

/**
 * Fit the level-reversion model on the last `window` quotes.
 *
 * OLS on `quote[t] = a + phi·quote[t−1] + e` with the usual standard error, so
 * `tStatistic` is a real unit-root test rather than a descriptive number. The
 * engine's significance bar lives in `analyzeQuoteState`; the model itself just
 * reports what the data says.
 */
export function fitLevelReversion(pricesInput: readonly number[], window = 600): LevelReversionModel | null {
  const values = pricesInput.filter((value) => Number.isFinite(value) && value > 0).slice(-Math.max(120, window));
  const n = values.length;
  if (n < 120) return null;
  const pairs = n - 1;
  let sumX = 0;
  let sumY = 0;
  for (let index = 1; index < n; index += 1) {
    sumX += values[index - 1];
    sumY += values[index];
  }
  const meanX = sumX / pairs;
  const meanY = sumY / pairs;
  let sxx = 0;
  let sxy = 0;
  for (let index = 1; index < n; index += 1) {
    const dx = values[index - 1] - meanX;
    sxx += dx * dx;
    sxy += dx * (values[index] - meanY);
  }
  if (!(sxx > 1e-12)) return null;
  const phi = sxy / sxx;
  const intercept = meanY - phi * meanX;
  let sse = 0;
  for (let index = 1; index < n; index += 1) {
    const residual = values[index] - (intercept + phi * values[index - 1]);
    sse += residual * residual;
  }
  const residualVariance = sse / Math.max(1, pairs - 1);
  const sigma = Math.sqrt(Math.max(0, residualVariance));
  const standardError = Math.sqrt(Math.max(1e-18, residualVariance / sxx));
  const tStatistic = standardError > 1e-12 ? (phi - 1) / standardError : 0;
  const stationary = phi > 0 && phi < 1;
  const meanLevel = stationary ? intercept / (1 - phi) : meanY;
  const levelSigma = stationary ? sigma / Math.sqrt(Math.max(1e-12, 1 - phi * phi)) : 0;
  const last = values[n - 1];
  const displacementZ = levelSigma > 1e-12 ? (last - meanLevel) / levelSigma : 0;
  const halfLifeTicks = stationary ? -Math.log(2) / Math.log(phi) : null;
  // Only a fit that is statistically distinguishable from a unit root, with a
  // half-life the bot could actually trade (two ticks to two minutes), can move
  // a probability. Anything else is descriptive.
  const significant = stationary
    && tStatistic <= -LEVEL_REVERSION_T
    && halfLifeTicks !== null
    && halfLifeTicks >= 2
    && halfLifeTicks <= 120;
  return {
    sample: pairs,
    phi,
    mean: meanLevel,
    last,
    sigma,
    levelSigma,
    displacementZ,
    halfLifeTicks,
    tStatistic,
    pValue: normalPValue(tStatistic),
    significant,
    active: significant,
  };
}

/**
 * P(the quote is higher after `horizonTicks`) under the fitted reversion model.
 *
 * Returns null when the fit is not significant, so callers cannot accidentally
 * publish an edge that the level test never found.
 */
export function levelReversionProbabilityUp(model: LevelReversionModel | null, horizonTicks: number): number | null {
  if (!model || !model.active) return null;
  const horizon = clamp(Math.round(Number.isFinite(horizonTicks) ? horizonTicks : 5), 1, 120);
  if (!(model.phi > 0 && model.phi < 1)) return null;
  const decay = Math.pow(model.phi, horizon);
  const expected = (model.last - model.mean) * (decay - 1);
  const variance = (model.sigma * model.sigma * (1 - Math.pow(model.phi, 2 * horizon))) / Math.max(1e-12, 1 - model.phi * model.phi);
  if (!(variance > 1e-18)) return null;
  const raw = normalCdf(expected / Math.sqrt(variance));
  // The tilt is capped the way the prior is: one engine may inform the
  // probability, never take it over.
  return clamp(0.5 + clamp(raw - 0.5, -LEVEL_REVERSION_MAX_TILT, LEVEL_REVERSION_MAX_TILT), 0.001, 0.999);
}

function tickSpacingMs(epochs: readonly number[]): number {
  const gaps: number[] = [];
  for (let index = Math.max(1, epochs.length - 500); index < epochs.length; index += 1) {
    const gap = epochs[index] - epochs[index - 1];
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 1_000;
  gaps.sort((left, right) => left - right);
  const raw = gaps[Math.floor(gaps.length / 2)];
  // Feeds report epochs in seconds; an obviously millisecond-scale value is
  // accepted as-is so tests and replays can use either unit.
  return raw > 1e6 ? raw : raw * 1_000;
}

/**
 * The prior probability of a rise that the analysis layer publishes.
 *
 * Two measured terms: the engine direction blend (drift, trend, structure) and
 * the level-reversion pull at the exit horizon. The level term only exists when
 * the unit-root test cleared its bar, so a random walk gets the trend term
 * alone. `backtestQuotePrior` calls this exact function over a rolling window,
 * so the published skill grades the prior that is actually shipped.
 */
export function quotePriorProbability(input: {
  direction: number;
  level: LevelReversionModel | null;
  horizonTicks?: number;
}): number {
  const trendTilt = 0.08 * clamp(input.direction, -1, 1);
  const levelProbability = levelReversionProbabilityUp(input.level, input.horizonTicks ?? 5);
  const levelTilt = levelProbability === null ? 0 : (levelProbability - 0.5) * 0.6;
  return clamp(0.5 + trendTilt + levelTilt, 0.3, 0.7);
}

function backtestQuotePrior(prices: readonly number[]): PriorBacktest {
  const empty: PriorBacktest = { sample: 0, brier: null, baseline: null, skill: null, accuracy: null, improved: false };
  if (prices.length < 800) return empty;
  let brier = 0;
  let baseline = 0;
  let hits = 0;
  let sample = 0;
  const start = Math.max(500, prices.length - 900);
  for (let origin = start; origin < prices.length - 6; origin += 5) {
    const history = prices.slice(0, origin + 1);
    const window = history.slice(-300);
    const returns = window.slice(1).map((value, index) => value - window[index]);
    const trend = regressionTrend(window, 120);
    const efficiency = efficiencyRatio(window, 120);
    const vr = varianceRatioTest(returns, 10);
    const drift = returnDriftTStatistic(returns, 200);
    const direction = Math.tanh(
      (trend.tStatistic / 6) * 0.25
      + Math.tanh(drift / 3) * 0.4
      + (efficiency > 0.18 ? Math.sign(trend.slope) : 0) * 0.2
      + (vr.interpretation === 'persistent' ? Math.sign(trend.slope) : 0) * 0.15,
    );
    // Same recipe as the live prior, level pull included.
    const probability = quotePriorProbability({ direction, level: fitLevelReversion(history), horizonTicks: 5 });
    const move = prices[origin + 5] - prices[origin];
    const won = move > 0 ? 1 : 0;
    brier += (probability - won) ** 2;
    baseline += 0.25;
    if ((probability >= 0.5 ? 1 : 0) === won) hits += 1;
    sample += 1;
  }
  if (sample < 40) return { ...empty, sample };
  const skill = baseline > 1e-12 ? 1 - brier / baseline : null;
  const accuracy = hits / sample;
  // 2√n (accuracy − 0.5) is the z-score of a coin-flip hit rate.
  const significance = normalPValue(2 * Math.sqrt(sample) * (accuracy - 0.5));
  return {
    sample,
    brier: brier / sample,
    baseline: baseline / sample,
    skill,
    accuracy,
    improved: skill !== null && skill > 0.01 && significance < 0.1,
  };
}

/** Layer 1 for quote markets (Rise/Fall). */
export function analyzeQuoteState(pricesInput: readonly number[], epochsInput: readonly number[] = []): QuoteMarketState {
  const prices = pricesInput.filter((value) => Number.isFinite(value) && value > 0);
  const sample = prices.length;
  const emptyBacktest: PriorBacktest = { sample: 0, brier: null, baseline: null, skill: null, accuracy: null, improved: false };
  if (sample < 200) {
    return {
      kind: 'quote', regime: 'insufficient', predictability: 0, confidence: 0, sample, direction: 0,
      tickSpacingMs: 1_000, volatility: { perTick: 0, atr: 0, shortLongRatio: 1, percentile: 0.5, regime: 'normal' },
      prior: null, levelReversion: null, priorBacktest: emptyBacktest, engines: [],
      metrics: {
        efficiencyRatio100: null, efficiencyRatio300: null, hurst: null,
        varianceRatio: null, varianceRatioZ: null, varianceRatioP: null,
        ljungBoxP: null, maxAutocorrelation: null, lagOneAutocorrelation: null,
        runsZ: null, runsP: null, adx: null, plusDi: null, minusDi: null,
        trendSlope: null, trendTStatistic: null, driftTStatistic: null, ar1: null, halfLifeTicks: null,
        levelReversionPhi: null, levelReversionTStatistic: null, levelReversionP: null, displacementZ: null,
        cusum: null, cusumSignificance: null, cadenceVariation: null,
      },
      summary: `Only ${sample} validated quotes — the analysis engines need at least 200 ticks to measure structure.`,
    };
  }

  const recent = prices.slice(-1_200);
  const returns = recent.slice(1).map((value, index) => value - recent[index]);
  const absoluteReturns = returns.map(Math.abs);
  const sigma = Math.max(1e-12, standardDeviation(returns));
  const engines: AnalysisEngine[] = [];
  const alpha = 0.05 / 8;

  // 1. Return drift + regression trend. The p-value is a t-test on average
  // returns: a level regression is spuriously significant on a random walk.
  const trend = regressionTrend(recent, 200);
  const driftT = returnDriftTStatistic(returns, 300);
  const driftP = normalPValue(driftT);
  const trendStrength = clamp(Math.abs(driftT) / 3.5, 0, 1);
  const trendEngine: AnalysisEngine = {
    id: 'regression-trend', label: 'Return drift + regression trend · 200–300 ticks', family: 'trend',
    verdict: driftP < alpha ? (driftT > 0 ? 'significant upward drift' : 'significant downward drift') : 'no significant drift',
    value: Math.tanh(driftT / 3),
    strength: driftP < alpha ? trendStrength : 0,
    pValue: driftP, sample: Math.min(300, returns.length),
    detail: `Mean-return t = ${driftT.toFixed(2)} (p = ${driftP.toFixed(4)}); price slope ${trend.slope.toExponential(3)} per tick.`,
  };
  engines.push(trendEngine);

  // 2. ADX direction.
  const adx = adxState(recent, 14);
  const directional = (adx.plusDi - adx.minusDi) / Math.max(1, adx.plusDi + adx.minusDi);
  const adxEngine: AnalysisEngine = {
    id: 'adx-direction', label: 'ADX / DI · directional movement', family: 'trend',
    verdict: adx.adx >= 22 ? `trending strength ${adx.adx.toFixed(0)} (${adx.plusDi > adx.minusDi ? 'buyers' : 'sellers'} in control)` : 'weak directional movement',
    value: directional,
    strength: clamp((adx.adx - 15) / 30, 0, 1),
    pValue: null, sample: Math.min(400, recent.length),
    detail: `ADX ${adx.adx.toFixed(1)}, +DI ${adx.plusDi.toFixed(1)} vs −DI ${adx.minusDi.toFixed(1)}. ADX is descriptive strength, not a significance test.`,
  };
  engines.push(adxEngine);

  // 3. Efficiency ratio.
  const er100 = efficiencyRatio(recent, 100);
  const er300 = efficiencyRatio(recent, 300);
  const efficiencyEngine: AnalysisEngine = {
    id: 'efficiency-ratio', label: 'Efficiency ratio · net move / path', family: 'structure',
    verdict: er300 >= 0.25 ? 'price is travelling efficiently (trend)' : er300 <= 0.08 ? 'price is chopping without net progress' : 'mixed path efficiency',
    value: Math.sign(recent.at(-1)! - recent[Math.max(0, recent.length - 300)]),
    strength: clamp(er300 / 0.3, 0, 1),
    pValue: null, sample: 300,
    detail: `Efficiency ${(er100 * 100).toFixed(1)}% over 100 ticks and ${(er300 * 100).toFixed(1)}% over 300; 0% is pure noise, 100% is a straight line.`,
  };
  engines.push(efficiencyEngine);

  // 4. Hurst exponent.
  const hurst = hurstExponent(returns);
  const hurstStrength = clamp(Math.abs(hurst.hurst - 0.5) / 0.12, 0, 1);
  const hurstEngine: AnalysisEngine = {
    id: 'hurst-exponent', label: 'Hurst exponent · aggregated variance', family: 'structure',
    verdict: hurst.hurst > 0.56 ? 'persistent long memory' : hurst.hurst < 0.44 ? 'anti-persistent / mean reverting' : 'consistent with a random walk',
    value: hurst.hurst > 0.5 ? 1 : -1,
    strength: hurst.hurst > 0.56 || hurst.hurst < 0.44 ? hurstStrength : 0,
    pValue: null, sample: hurst.sample,
    detail: `H = ${hurst.hurst.toFixed(3)} over ${hurst.points} aggregation lags (0.5 = random walk; >0.5 persistent, <0.5 reverting).`,
  };
  engines.push(hurstEngine);

  // 5. Variance ratio.
  const vr = varianceRatioTest(returns, 10);
  const vrEngine: AnalysisEngine = {
    id: 'variance-ratio', label: 'Variance ratio · Lo–MacKinlay q=10', family: 'statistical',
    verdict: vr.pValue < alpha ? (vr.ratio > 1 ? 'returns are persistent (momentum)' : 'returns mean-revert') : 'variance grows like a random walk',
    value: vr.ratio > 1 ? 1 : -1,
    strength: vr.pValue < alpha ? clamp(Math.abs(vr.ratio - 1) / 0.45, 0, 1) : 0,
    pValue: vr.pValue, sample: vr.sample,
    detail: `VR(10) = ${vr.ratio.toFixed(3)}, z = ${vr.zScore.toFixed(2)}, p = ${vr.pValue.toFixed(4)} (1 = random walk).`,
  };
  engines.push(vrEngine);

  // 6. Autocorrelation.
  const lb = ljungBox(returns, 10);
  const lagOne = autocorrelation(returns, 1) ?? 0;
  const acfEngine: AnalysisEngine = {
    id: 'autocorrelation', label: 'Ljung–Box · return autocorrelation', family: 'statistical',
    verdict: lb.pValue < alpha ? (lagOne >= 0 ? 'momentum in recent returns' : 'mean reversion in recent returns') : 'returns uncorrelated',
    value: Math.sign(lagOne),
    strength: lb.pValue < alpha ? clamp(Math.abs(lagOne) / 0.12, 0, 1) : 0,
    pValue: lb.pValue, sample: lb.sample,
    detail: `Q = ${lb.statistic.toFixed(1)} (df ${lb.degreesOfFreedom}), p = ${lb.pValue.toFixed(4)}; lag-1 correlation ${lagOne.toFixed(3)}, strongest ${lb.maxAutocorrelation.toFixed(3)}.`,
  };
  engines.push(acfEngine);

  // 7. Runs test on tick direction.
  const runs = runsTest(returns.slice(-600));
  const runsEngine: AnalysisEngine = {
    id: 'direction-runs', label: 'Direction runs · up/down clustering', family: 'structure',
    verdict: runs.pValue < alpha ? (runs.direction === 'clustered' ? 'direction persists (trend)' : 'direction alternates (reversion)') : 'direction sequence consistent with chance',
    value: runs.direction === 'clustered' ? 1 : runs.direction === 'alternating' ? -1 : 0,
    strength: runs.pValue < alpha ? clamp(Math.abs(runs.zScore) / 3.5, 0, 1) : 0,
    pValue: runs.pValue, sample: runs.positives + runs.negatives,
    detail: `${runs.runs} runs against ${runs.expectedRuns.toFixed(1)} expected; z = ${runs.zScore.toFixed(2)}, p = ${runs.pValue.toFixed(4)}.`,
  };
  engines.push(runsEngine);

  // 8. AR(1) mean reversion.
  const ar1 = autocorrelation(returns, 1) ?? 0;
  const halfLife = ar1 > 0 && ar1 < 1 ? -Math.log(2) / Math.log(ar1) : null;
  const meanReversionEngine: AnalysisEngine = {
    id: 'mean-reversion', label: 'AR(1) half-life · pull toward the mean', family: 'statistical',
    verdict: ar1 < -0.03 ? `mean reverting (half-life ${halfLife === null ? 'short' : `${halfLife.toFixed(1)} ticks`})` : ar1 > 0.03 ? 'returns show momentum, not reversion' : 'no measurable reversion',
    value: ar1 < 0 ? 1 : ar1 > 0 ? -1 : 0,
    strength: clamp(Math.abs(ar1) / 0.12, 0, 1),
    pValue: normalPValue(ar1 * Math.sqrt(Math.max(1, returns.length))), sample: returns.length,
    detail: `Lag-1 autocorrelation ${ar1.toFixed(3)}; ${halfLife === null ? 'no positive decay estimate' : `implied half-life ${halfLife.toFixed(1)} ticks`}.`,
  };
  engines.push(meanReversionEngine);

  // 9. Level reversion (Ornstein–Uhlenbeck on the quote itself). The AR(1)
  //    engine above reads *returns*; a market can revert around an equilibrium
  //    with almost no return autocorrelation, because the pull scales with the
  //    distance from the mean, not with the last tick's move. This engine fits
  //    the level directly, so "price is two σ above its equilibrium" becomes a
  //    measured directional edge at any exit horizon instead of an invisible
  //    one. A random walk fits phi ≈ 1 and publishes nothing.
  const levelModel = fitLevelReversion(prices);
  const levelStrength = levelModel === null
    ? 0
    : clamp(Math.abs(levelModel.tStatistic) / 6, 0, 1) * (levelModel.significant ? 1 : 0);
  // Direction the reversion implies for the NEXT move: toward the equilibrium.
  const levelDirection = levelModel === null || !levelModel.significant || Math.abs(levelModel.displacementZ) < 0.15
    ? 0
    : clamp(-Math.sign(levelModel.displacementZ) * Math.min(1, Math.abs(levelModel.displacementZ) / 2), -1, 1);
  const levelEngine: AnalysisEngine = {
    id: 'level-reversion', label: 'AR(1) on quote levels · pull to equilibrium', family: 'statistical',
    verdict: levelModel === null
      ? 'not enough quotes to fit a level model'
      : levelModel.significant
        ? `mean reversion confirmed (half-life ${(levelModel.halfLifeTicks ?? 0).toFixed(1)} ticks, price ${levelModel.displacementZ >= 0 ? '+' : ''}${levelModel.displacementZ.toFixed(2)}σ from equilibrium)`
        : levelModel.phi >= 0.999
          ? 'level behaves like a unit root (random walk); no pull measured'
          : `no significant pull (phi ${levelModel.phi.toFixed(4)}, t ${levelModel.tStatistic.toFixed(2)})`,
    value: levelModel === null ? null : Math.sign(levelDirection),
    strength: levelStrength,
    pValue: levelModel === null ? null : levelModel.pValue,
    sample: levelModel === null ? 0 : levelModel.sample,
    detail: levelModel === null
      ? 'The level fit needs at least 120 quotes.'
      : `quote[t] = a + phi·quote[t−1]; phi = ${levelModel.phi.toFixed(4)} (unit root = 1), t = ${levelModel.tStatistic.toFixed(2)} against phi = 1 (bar ${LEVEL_REVERSION_T}), implied half-life ${levelModel.halfLifeTicks === null ? '—' : `${levelModel.halfLifeTicks.toFixed(1)} ticks`}, equilibrium ${levelModel.mean.toFixed(4)}, current quote ${levelModel.last.toFixed(4)} (${levelModel.displacementZ >= 0 ? '+' : ''}${levelModel.displacementZ.toFixed(2)}σ).`,
  };
  engines.push(levelEngine);

  // 10. Volatility regime.
  const shortAtr = mean(absoluteReturns.slice(-20));
  const longAtr = mean(absoluteReturns.slice(-300));
  const shortLongRatio = longAtr > 1e-12 ? shortAtr / longAtr : 1;
  const volatilityPercentile = clamp(0.5 + (shortLongRatio - 1) * 0.5, 0, 1);
  const volatilityEngine: AnalysisEngine = {
    id: 'volatility-regime', label: 'Volatility regime · ATR-20 vs ATR-300', family: 'volatility',
    verdict: shortLongRatio > 1.3 ? 'volatility expansion' : shortLongRatio < 0.7 ? 'volatility compression' : 'normal volatility',
    value: null, strength: clamp(Math.abs(shortLongRatio - 1) / 0.6, 0, 1),
    pValue: null, sample: returns.length,
    detail: `Short ATR ${shortAtr.toFixed(4)} vs long ATR ${longAtr.toFixed(4)} (${(shortLongRatio * 100).toFixed(0)}%); per-tick σ ${sigma.toFixed(4)}.`,
  };
  engines.push(volatilityEngine);

  // 11. CUSUM structural break.
  const cusum = cusumChange(returns.slice(-400));
  const shiftEngine: AnalysisEngine = {
    id: 'cusum-break', label: 'CUSUM · structural break in returns', family: 'structure',
    verdict: cusum.significance < 0.05 ? `regime shift detected (${cusum.shift > 0 ? 'toward' : 'away from'} positive drift)` : 'no structural break',
    value: cusum.shift > 0 ? 1 : cusum.shift < 0 ? -1 : 0,
    strength: cusum.significance < 0.05 ? clamp(Math.abs(cusum.statistic) / 1.5, 0, 1) : 0,
    pValue: cusum.significance, sample: 400,
    detail: `Standardized CUSUM maximum ${Math.abs(cusum.statistic).toFixed(2)} (Brownian-bridge p = ${cusum.significance.toFixed(4)}), post-break drift change ${cusum.shift.toExponential(2)}.`,
  };
  engines.push(shiftEngine);

  // 12. Tick cadence — a quality check, not an edge.
  let cadenceVariation: number | null = null;
  if (epochsInput.length > 10) {
    const gaps: number[] = [];
    for (let index = Math.max(1, epochsInput.length - 200); index < epochsInput.length; index += 1) {
      const gap = epochsInput[index] - epochsInput[index - 1];
      if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
    }
    if (gaps.length > 5) cadenceVariation = standardDeviation(gaps) / Math.max(1e-9, mean(gaps));
  }
  const cadenceEngine: AnalysisEngine = {
    id: 'tick-cadence', label: 'Tick cadence · feed regularity', family: 'data-quality',
    verdict: cadenceVariation === null ? 'epochs unavailable' : cadenceVariation > 0.6 ? 'irregular tick spacing' : 'regular tick spacing',
    value: null, strength: cadenceVariation === null ? 0 : clamp(cadenceVariation / 1.2, 0, 1),
    pValue: null, sample: Math.max(0, epochsInput.length - 1),
    detail: cadenceVariation === null ? 'No epoch context was supplied, so cadence was not measured.' : `Coefficient of variation of tick gaps ${cadenceVariation.toFixed(2)} (below 0.6 is regular).`,
  };
  engines.push(cadenceEngine);

  // Synthesis. Only significant structure contributes. Descriptive measures
  // (efficiency, ADX, volatility) shape the regime and direction, never the
  // predictability claim: they are not hypothesis tests.
  const trendSignificant = driftP < alpha;
  const vrSignificant = vr.pValue < alpha;
  const acfSignificant = lb.pValue < alpha;
  const runsSignificant = runs.pValue < alpha;
  const levelSignificant = levelModel !== null && levelModel.significant && Math.abs(levelModel.displacementZ) >= 0.15;
  // Hurst is a noisier long-memory estimate; only counts when another test
  // agrees that the series is not a pure random walk.
  const hurstSignificant = (hurst.hurst > 0.56 || hurst.hurst < 0.44) && (vrSignificant || acfSignificant);
  const contributions = [
    trendSignificant ? trendStrength : 0,
    vrSignificant ? clamp(Math.abs(vr.ratio - 1) / 0.45, 0, 1) : 0,
    acfSignificant ? clamp(Math.abs(lagOne) / 0.12, 0, 1) : 0,
    runsSignificant ? clamp(Math.abs(runs.zScore) / 3.5, 0, 1) : 0,
    hurstSignificant ? hurstStrength : 0,
    levelSignificant ? levelStrength : 0,
  ];
  const combined = 1 - contributions.reduce((product, value) => product * (1 - 0.65 * clamp(value, 0, 1)), 1);
  const sampleFactor = clamp((sample - 200) / 1_000, 0.3, 1);
  const predictability = clamp(combined * sampleFactor, 0, 0.95);
  const confidence = clamp(predictability * clamp(sample / 1_200, 0.4, 1), 0, 0.95);

  const directionParts = [
    { value: Math.tanh(driftT / 2.5), weight: trendSignificant ? 0.5 : 0.12 },
    { value: Math.tanh(trend.tStatistic / 12), weight: 0.12 },
    { value: directional, weight: 0.18 },
    { value: hurst.hurst > 0.56 ? Math.sign(trend.slope) * 0.4 : hurst.hurst < 0.44 ? -Math.sign(trend.slope) * 0.4 : 0, weight: 0.1 },
    { value: vrSignificant ? (vr.ratio > 1 ? Math.sign(trend.slope) : -Math.sign(trend.slope)) * 0.3 : 0, weight: 0.08 },
    { value: acfSignificant ? Math.sign(lagOne) * 0.3 : 0, weight: 0.08 },
    // The level engine is a direct statement about the next move, so it carries
    // real weight when it fires — and zero when it does not.
    { value: levelSignificant ? levelDirection : 0, weight: levelSignificant ? 0.32 : 0.04 },
  ];
  const direction = clamp(directionParts.reduce((sum, part) => sum + part.value * part.weight, 0) / directionParts.reduce((sum, part) => sum + part.weight, 0), -1, 1);
  const priorBacktest = backtestQuotePrior(prices);
  // A prior is only shipped when the analysis layer itself found significant
  // directional structure. A backtest that "improves" on a market the engines
  // measured as random is noise, not a prior.
  const prior =
    priorBacktest.improved && predictability >= 0.1
      ? quotePriorProbability({ direction, level: levelModel, horizonTicks: 5 })
      : null;

  // A statistically significant drift is a trend even when ADX is muted: ADX
  // is a descriptive strength measure, not the test. Efficiency only has to
  // show that the path is not pure noise.
  const trending =
    (trendSignificant && er300 >= 0.1 && Math.abs(direction) >= 0.15) ||
    (vrSignificant && vr.ratio > 1 && er300 >= 0.12 && Math.abs(direction) >= 0.15) ||
    (driftP < 0.001 && adx.adx >= 25 && er300 >= 0.2 && Math.abs(direction) >= 0.2);
  const reverting = (vrSignificant && vr.ratio < 1) || (acfSignificant && lagOne < -0.03) || (runsSignificant && runs.direction === 'alternating' && Math.abs(runs.zScore) >= 2.5) || levelSignificant;
  const regime: QuoteRegime = trending
    ? direction >= 0 ? 'trending-up' : 'trending-down'
    : reverting
      ? 'mean-reverting'
      : shortLongRatio > 1.35
        ? 'volatile'
        : shortLongRatio < 0.7
          ? 'quiet'
          : 'random';
  const significantEngines = engines.filter((engine) => engine.strength >= 0.05);
  const summary = regime === 'random'
    ? `The ${engines.length} analysis engines found no material, significant directional structure in ${sample} ticks — predictability ${(predictability * 100).toFixed(0)}%. The prediction engines are told to stay near fair odds.`
    : `The ${engines.length} analysis engines measured ${regime} conditions in ${sample} ticks (predictability ${(predictability * 100).toFixed(0)}%, direction ${direction >= 0 ? '+' : ''}${direction.toFixed(2)}): ${significantEngines.map((engine) => engine.id).join(', ') || 'descriptive structure only'}.`;

  return {
    kind: 'quote', regime, predictability, confidence, sample, direction,
    tickSpacingMs: tickSpacingMs(epochsInput),
    volatility: {
      perTick: sigma,
      atr: mean(absoluteReturns.slice(-20)),
      shortLongRatio,
      percentile: volatilityPercentile,
      regime: shortLongRatio > 1.3 ? 'volatile' : shortLongRatio < 0.7 ? 'quiet' : 'normal',
    },
    prior, levelReversion: levelModel, priorBacktest, engines,
    metrics: {
      efficiencyRatio100: er100, efficiencyRatio300: er300, hurst: hurst.hurst,
      varianceRatio: vr.ratio, varianceRatioZ: vr.zScore, varianceRatioP: vr.pValue,
      ljungBoxP: lb.pValue, maxAutocorrelation: lb.maxAutocorrelation, lagOneAutocorrelation: lagOne,
      runsZ: runs.zScore, runsP: runs.pValue,
      adx: adx.adx, plusDi: adx.plusDi, minusDi: adx.minusDi,
      trendSlope: trend.slope, trendTStatistic: trend.tStatistic, driftTStatistic: driftT,
      ar1, halfLifeTicks: halfLife,
      levelReversionPhi: levelModel === null ? null : levelModel.phi,
      levelReversionTStatistic: levelModel === null ? null : levelModel.tStatistic,
      levelReversionP: levelModel === null ? null : levelModel.pValue,
      displacementZ: levelModel === null ? null : levelModel.displacementZ,
      cusum: Math.abs(cusum.statistic), cusumSignificance: cusum.significance,
      cadenceVariation,
    },
    summary,
  };
}
