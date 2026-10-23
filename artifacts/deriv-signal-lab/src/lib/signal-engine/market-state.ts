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

/** Next-digit distribution for a repeated n-gram context. */
function contextForecast(digits: readonly number[], order: number): { distribution: number[]; support: number } | null {
  if (digits.length < order + 10) return null;
  const context = digits.slice(-order).join('');
  const countsValue = Array<number>(10).fill(0);
  let support = 0;
  for (let index = 0; index + order < digits.length; index += 1) {
    if (digits.slice(index, index + order).join('') !== context) continue;
    countsValue[digits[index + order]] += 1;
    support += 1;
  }
  if (support < 6) return null;
  return { distribution: smoothed(countsValue, 8), support };
}

/**
 * Fast prior used by the internal backtest. Deliberately the same recipe the
 * live prior uses, so the skill number describes the prior actually shipped.
 */
function buildDigitPrior(
  digits: readonly number[],
  evidence: { bias: number; dependence: number; pattern: number; hotCold: number; periodicity: number },
): { prior: number[]; strength: number } | null {
  if (digits.length < 250) return null;
  const components: Array<{ distribution: number[]; weight: number }> = [];
  components.push({ distribution: decayedHistogram(digits.slice(-600), 90), weight: 0.3 + evidence.bias });
  const table = transitions(digits.slice(-1_000));
  const last = digits.at(-1) ?? 0;
  const row = table[last];
  const rowTotal = row.reduce((total, value) => total + value, 0);
  if (rowTotal >= 40) components.push({ distribution: smoothed(row, 12), weight: 0.2 + evidence.dependence });
  for (const order of [2, 3, 4]) {
    const forecast = contextForecast(digits, order);
    if (forecast) components.push({ distribution: forecast.distribution, weight: (0.15 + evidence.pattern) * Math.min(1, forecast.support / 20) });
  }
  if (evidence.hotCold > 0.05) {
    const recent = counts(digits.slice(-300));
    const older = counts(digits.slice(-1_000, -300));
    const boost = Array.from({ length: 10 }, (_, digit) => {
      const oldRate = (older[digit] + 1) / (older.reduce((sum, value) => sum + value, 0) + 10);
      const newRate = (recent[digit] + 1) / (recent.reduce((sum, value) => sum + value, 0) + 10);
      return Math.max(0, newRate - oldRate);
    });
    components.push({ distribution: normalize(boost.map((value) => 0.01 + value * 8)), weight: 0.1 + evidence.hotCold });
  }
  if (evidence.periodicity > 0.05) {
    const values = digits.slice(-600);
    let bestLag = 1;
    let best = 0;
    for (let lag = 1; lag <= 20; lag += 1) {
      const rho = autocorrelation(values, lag);
      if (rho !== null && Math.abs(rho) > Math.abs(best)) { best = rho; bestLag = lag; }
    }
    if (Math.abs(best) > 0.04) {
      const distribution = Array<number>(10).fill(0.2);
      let weight = 1;
      for (let step = 1; step <= 4; step += 1) {
        const index = values.length - 1 - bestLag * step;
        if (index < 0) break;
        distribution[values[index]] += weight;
        weight *= 0.6;
      }
      components.push({ distribution: normalize(distribution), weight: 0.1 + evidence.periodicity });
    }
  }
  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
  if (!(totalWeight > 0)) return null;
  let prior = Array<number>(10).fill(0);
  for (const component of components) prior = prior.map((value, digit) => value + component.distribution[digit] * (component.weight / totalWeight));
  prior = normalize(prior);
  // Never let the analysis layer claim more than a modest shift from uniform.
  const clip = 0.1;
  prior = normalize(prior.map((value) => clamp(value, 0.1 - clip, 0.1 + clip * 2)));
  const strength = totalVariation(prior, UNIFORM);
  return { prior: mix(prior, UNIFORM, clamp(1 - strength * 2, 0.6, 0.95)), strength };
}

function backtestDigitPrior(digits: readonly number[]): PriorBacktest {
  const empty: PriorBacktest = { sample: 0, brier: null, baseline: null, skill: null, accuracy: null, improved: false };
  if (digits.length < 600) return empty;
  const start = Math.max(400, digits.length - 1_200);
  let brier = 0;
  let baseline = 0;
  let hits = 0;
  let sample = 0;
  for (let origin = start; origin < digits.length - 1; origin += 12) {
    const history = digits.slice(0, origin + 1);
    // Evidence for the backtest rule is measured on the same trailing window.
    const window = history.slice(-600);
    const table = transitions(window);
    const independence = chiSquareIndependence(table);
    const uniformity = chiSquareGoodnessOfFit(counts(window));
    const values = window;
    const acf = autocorrelation(values, 1) ?? 0;
    const forecast = contextForecast(history, 4);
    const built = buildDigitPrior(history, {
      // The live prior is built with the uniformity/bias strength too; leaving
      // this at zero made the backtest grade a different (timider) prior than
      // the one the analysis actually ships.
      bias: uniformity.pValue < 0.05 ? clamp(uniformity.effect / 0.06, 0, 1) : 0,
      dependence: independence.pValue < 0.05 ? clamp(independence.effect / 0.06, 0, 1) : 0,
      pattern: forecast && forecast.support >= 10 ? clamp(forecast.support / 30, 0, 1) : 0,
      hotCold: clamp(Math.abs(acf) / 0.08, 0, 1),
      periodicity: clamp(Math.abs(acf) / 0.08, 0, 1),
    });
    if (!built) continue;
    const target = digits[origin + 1];
    brier += built.prior.reduce((sum, probability, digit) => sum + (probability - Number(digit === target)) ** 2, 0);
    baseline += UNIFORM.reduce((sum, probability, digit) => sum + (probability - Number(digit === target)) ** 2, 0);
    const best = built.prior.indexOf(Math.max(...built.prior));
    if (best === target) hits += 1;
    sample += 1;
  }
  if (sample < 20) return { ...empty, sample };
  const skill = baseline > 1e-12 ? 1 - brier / baseline : null;
  return {
    sample,
    brier: brier / sample,
    baseline: baseline / sample,
    skill,
    accuracy: hits / sample,
    // A ten-class Brier improvement is small even for a real edge; require a
    // positive skill AND an accuracy above the 10% chance line.
    improved: skill !== null && skill > 0.004 && hits / sample > 0.11,
  };
}

/** Layer 1 for digit markets (Over/Under, Even/Odd, Matches). */
export function analyzeDigitState(input: readonly number[], options: { recentWindow?: number } = {}): DigitMarketState {
  const digits = finiteDigits(input);
  const sample = digits.length;
  const recentWindow = Math.max(300, Math.min(options.recentWindow ?? 1_200, sample));
  if (sample < 300) {
    return {
      kind: 'digit', regime: 'insufficient', predictability: 0, confidence: 0, sample,
      prior: null, priorStrength: 0,
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
  const built = predictability >= 0.1 ? buildDigitPrior(digits, evidence) : null;
  const priorBacktest = built ? backtestDigitPrior(digits) : { sample: 0, brier: null, baseline: null, skill: null, accuracy: null, improved: false };
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
    prior: built && priorBacktest.improved ? built.prior : null,
    priorStrength: built ? built.strength : 0,
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
