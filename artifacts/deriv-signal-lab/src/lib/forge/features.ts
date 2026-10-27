// Layer 8 — the forged feature vector.
//
// The forge does not look at a single model family. Each row is the state of
// the whole analysis at one origin, in one flat vector:
//
//   the audited teacher probabilities (family-weighted engine ensemble, the
//   rolling-frequency baseline, the analysis prior), the spread and agreement
//   of the engines behind them, how much sample and data quality stood behind
//   the reading, the contract's horizon and no-edge rate, the market's cadence
//   and volatility class from the instrument atlas, and the market's own
//   measured structure at that origin (entropy, runs, hot/cold, parity, streak
//   for digits; variance ratio, trend z, volatility ratio, momentum, position
//   and autocorrelation for quotes).
//
// Every value is computed from ticks at or before the origin, so a row can be
// replayed exactly, split chronologically and scored out of sample without any
// look-ahead. The two builders share one width so the network, the trainer and
// the card are family-agnostic; the feature at each index means the same KIND
// of thing for both families.
import type { ForgeFeature, ForgeFamily } from './types.ts';
import { marketProfile, type ForgeMarketClass, type ForgeMarketProfile } from './knowledge.ts';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const safeProbability = (value: number) => clamp(value, 0.0005, 0.9995);

/** Width of a forge row. Both families use the same width by design. */
export const FORGE_FEATURE_COUNT = 24;
/** Ticks of history the digit context reads at an origin. */
export const FORGE_DIGIT_WINDOW = 100;
/** Ticks of history the quote context reads at an origin. */
export const FORGE_QUOTE_WINDOW = 60;

const MARKET_KIND_CODE: Record<ForgeMarketClass, number> = {
  volatility: 0.2,
  'volatility-1s': 0.35,
  jump: 0.55,
  step: 0.7,
  'crash-boom': 0.85,
  basket: 0.45,
  unknown: 0,
};

/**
 * The frozen input list. Positions are pinned here so a stored card can never
 * disagree with the weights: index i of the vector is exactly this feature.
 */
export const FORGE_FEATURES: readonly ForgeFeature[] = [
  { index: 0, key: 'bias', label: 'Bias term', knowledge: 'stats.chronological-split' },
  { index: 1, key: 'teacher.edgeLogit', label: 'Teacher edge (log-odds vs fair)', knowledge: 'stats.brier-skill' },
  { index: 2, key: 'teacher.edgePts', label: 'Teacher edge (points)', knowledge: 'stats.brier-skill' },
  { index: 3, key: 'baseline.edgePts', label: 'Rolling baseline edge (points)', knowledge: 'stats.brier-skill' },
  { index: 4, key: 'prior.edgePts', label: 'Analysis prior edge (points)', knowledge: 'structure.uniformity' },
  { index: 5, key: 'fair.centred', label: 'Fair rate (centred)', knowledge: 'contract.horizon-settles' },
  { index: 6, key: 'engines.spread', label: 'Engine disagreement', knowledge: 'risk.correlated-sources' },
  { index: 7, key: 'engines.agreement', label: 'Skill-weighted agreement', knowledge: 'risk.correlated-sources' },
  { index: 8, key: 'engines.balance', label: 'Vote balance', knowledge: 'risk.correlated-sources' },
  { index: 9, key: 'engines.abstain', label: 'Abstention share', knowledge: 'stats.min-expected-counts' },
  { index: 10, key: 'sample.maturity', label: 'Sample maturity', knowledge: 'feed.sample-maturity' },
  { index: 11, key: 'contract.horizon', label: 'Contract horizon', knowledge: 'contract.horizon-settles' },
  { index: 12, key: 'prior.skill', label: 'Analysis prior skill', knowledge: 'stats.paired-z' },
  { index: 13, key: 'market.cadence', label: 'Tick cadence', knowledge: 'feed.tick-cadence' },
  { index: 14, key: 'market.volatility', label: 'Volatility class', knowledge: 'market.volatility-class' },
  { index: 15, key: 'market.kind', label: 'Market family', knowledge: 'market.symbol-family' },
  { index: 16, key: 'context.dispersion', label: 'Digit entropy / variance ratio', knowledge: 'structure.conditional-entropy' },
  { index: 17, key: 'context.runs', label: 'Runs test / trend z', knowledge: 'structure.parity-runs' },
  { index: 18, key: 'context.hot', label: 'Hot-digit z / volatility ratio', knowledge: 'structure.uniformity' },
  { index: 19, key: 'context.balance', label: 'Parity imbalance / momentum', knowledge: 'structure.parity-runs' },
  { index: 20, key: 'context.streak', label: 'Parity streak / price position', knowledge: 'structure.parity-runs' },
  { index: 21, key: 'interaction.edgeDispersion', label: 'Edge × dispersion', knowledge: 'stats.distillation' },
  { index: 22, key: 'interaction.edgeAgreement', label: 'Edge × agreement', knowledge: 'risk.correlated-sources' },
  { index: 23, key: 'knowledge.uncertainty', label: 'Knowledge uncertainty', knowledge: 'stats.wilson-interval' },
];

export function featureLabels(family: ForgeFamily): ForgeFeature[] {
  return FORGE_FEATURES.map((feature) => ({ ...feature, label: family === 'digit' ? feature.label : quoteLabel(feature) }));
}

function quoteLabel(feature: ForgeFeature): string {
  if (feature.key === 'context.dispersion') return 'Variance ratio (trend vs reversion)';
  if (feature.key === 'context.runs') return 'Trend z-score';
  if (feature.key === 'context.hot') return 'Short/long volatility ratio';
  if (feature.key === 'context.balance') return 'RSI / momentum balance';
  if (feature.key === 'context.streak') return 'Price position vs range';
  return feature.label;
}

/* -------------------------------------------------------------------------- */
/* Causal market context                                                      */
/* -------------------------------------------------------------------------- */

export type DigitContext = {
  entropy: number;
  runsZ: number;
  hotZ: number;
  parity: number;
  streak: number;
};

export type QuoteContext = {
  varianceRatio: number;
  trendZ: number;
  volatilityRatio: number;
  momentum: number;
  position: number;
};

const EMPTY_DIGIT_CONTEXT: DigitContext = { entropy: 0, runsZ: 0, hotZ: 0, parity: 0, streak: 0 };
const EMPTY_QUOTE_CONTEXT: QuoteContext = { varianceRatio: 1, trendZ: 0, volatilityRatio: 1, momentum: 0, position: 0 };

/**
 * Digit structure at `origin`, using only digits[0…origin].
 * Entropy, parity runs, hot/cold and the current parity streak: the four
 * quantities the syllabus says answer "is there anything to condition on?".
 */
export function digitContextAt(digits: readonly number[], origin: number): DigitContext {
  if (!Array.isArray(digits) || !Number.isInteger(origin) || origin < FORGE_DIGIT_WINDOW - 1) return { ...EMPTY_DIGIT_CONTEXT };
  const start = Math.max(0, origin - FORGE_DIGIT_WINDOW + 1);
  const slice = digits.slice(start, origin + 1);
  if (slice.length < 30) return { ...EMPTY_DIGIT_CONTEXT };
  const counts = Array<number>(10).fill(0);
  let even = 0;
  for (const digit of slice) {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) continue;
    counts[digit] += 1;
    if (digit % 2 === 0) even += 1;
  }
  const total = slice.length;
  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const share = count / total;
    entropy -= share * Math.log(share);
  }
  const normalisedEntropy = entropy / Math.log(10);
  // Runs test on parity: alternations against the expected count of a fair
  // sequence, expressed as a z-score.
  let runs = 1;
  for (let index = 1; index < slice.length; index += 1) {
    if ((slice[index] % 2 === 0) !== (slice[index - 1] % 2 === 0)) runs += 1;
  }
  const evenShare = even / total;
  const expectedRuns = 1 + 2 * total * evenShare * (1 - evenShare);
  const runsDeviation = Math.sqrt(Math.max(1e-9, 2 * total * evenShare * (1 - evenShare) * (2 * total * evenShare * (1 - evenShare) - 1) / Math.max(1, total - 1)));
  const runsZ = (runs - expectedRuns) / runsDeviation;
  // Hot/cold: the largest one-sided z across the ten digits.
  const expectedCount = total / 10;
  const deviation = Math.sqrt(total * 0.09) || 1;
  let hotZ = 0;
  for (const count of counts) {
    const z = (count - expectedCount) / deviation;
    if (Math.abs(z) > Math.abs(hotZ)) hotZ = z;
  }
  // Current parity streak, signed: positive = even run, negative = odd run.
  let streak = 0;
  const lastParity = slice[slice.length - 1] % 2 === 0;
  for (let index = slice.length - 1; index >= 0; index -= 1) {
    if ((slice[index] % 2 === 0) === lastParity) streak += 1; else break;
  }
  return {
    entropy: clamp(normalisedEntropy, 0, 1),
    runsZ: clamp(runsZ / 3, -1, 1),
    hotZ: clamp(hotZ / 3, -1, 1),
    parity: clamp((evenShare - 0.5) / 0.15, -1, 1),
    streak: clamp((lastParity ? 1 : -1) * Math.min(10, streak) / 10, -1, 1),
  };
}

/**
 * Quote structure at `origin`, using only prices[0…origin].
 *
 * Variance ratio (10-tick vs 1-tick), the z-score of the recent mean return,
 * the short/long volatility ratio, a momentum balance, the position of the
 * quote inside its recent range, all in units the network can compare across
 * markets.
 */
export function quoteContextAt(prices: readonly number[], origin: number): QuoteContext {
  if (!Array.isArray(prices) || !Number.isInteger(origin) || origin < FORGE_QUOTE_WINDOW) return { ...EMPTY_QUOTE_CONTEXT };
  const start = Math.max(1, origin - FORGE_QUOTE_WINDOW + 1);
  const returns: number[] = [];
  for (let index = start; index <= origin; index += 1) {
    const previous = prices[index - 1];
    const current = prices[index];
    if (!finite(previous) || !finite(current)) continue;
    returns.push(current - previous);
  }
  if (returns.length < 20) return { ...EMPTY_QUOTE_CONTEXT };
  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const deviation = Math.sqrt(Math.max(1e-18, variance));
  // Variance ratio with an overlap-safe estimator: variance of 10-tick sums
  // over 10 × variance of 1-tick returns. 1 = random walk, >1 = trending.
  const horizon = 10;
  const sums: number[] = [];
  for (let index = horizon; index <= returns.length; index += 1) {
    let total = 0;
    for (let step = index - horizon; step < index; step += 1) total += returns[step];
    sums.push(total);
  }
  const sumMean = sums.length ? sums.reduce((total, value) => total + value, 0) / sums.length : 0;
  const sumVariance = sums.length > 1
    ? sums.reduce((total, value) => total + (value - sumMean) ** 2, 0) / (sums.length - 1)
    : variance * horizon;
  const varianceRatio = variance > 1e-18 ? clamp(sumVariance / (horizon * variance), 0, 4) : 1;
  const standardError = deviation / Math.sqrt(returns.length);
  const trendZ = standardError > 1e-12 ? clamp(mean / standardError / 3, -1, 1) : 0;
  const shortWindow = returns.slice(-10);
  const longWindow = returns.slice(-Math.min(returns.length, 50));
  const shortVariance = shortWindow.reduce((total, value) => total + value * value, 0) / Math.max(1, shortWindow.length);
  const longVariance = longWindow.reduce((total, value) => total + value * value, 0) / Math.max(1, longWindow.length);
  const volatilityRatio = longVariance > 1e-18 ? clamp(shortVariance / longVariance - 1, -1, 2) : 0;
  // Momentum: mean of the last five returns against the local deviation.
  const momentum = deviation > 1e-12
    ? clamp((returns.slice(-5).reduce((total, value) => total + value, 0) / 5) / deviation / 2, -1, 1)
    : 0;
  // Position inside the recent range, centered on zero.
  let low = Infinity;
  let high = -Infinity;
  for (let index = Math.max(0, origin - FORGE_QUOTE_WINDOW + 1); index <= origin; index += 1) {
    const value = prices[index];
    if (!finite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const last = prices[origin];
  const position = finite(high) && finite(low) && high - low > 1e-12 && finite(last)
    ? clamp((2 * (last - low)) / (high - low) - 1, -1, 1)
    : 0;
  return {
    varianceRatio: clamp((varianceRatio - 1) / 2, -1, 1),
    trendZ,
    volatilityRatio: clamp(volatilityRatio, -1, 1),
    momentum,
    position,
  };
}

/* -------------------------------------------------------------------------- */
/* Vector builders                                                            */
/* -------------------------------------------------------------------------- */

type CommonInput = {
  /** Family-weighted ensemble estimate for the traded outcome. */
  teacherProbability: number | null;
  /** Per-engine probabilities for the traded outcome (null = abstained). */
  engineValues: readonly (number | null)[];
  /** Per-engine weights inside the ensemble (0 = no vote). */
  engineWeights: readonly number[];
  /** Rolling-frequency baseline for this exact contract/duration. */
  baselineProbability: number | null;
  /** The analysis layer's own prior for the traded outcome. */
  priorProbability: number | null;
  /** No-edge probability of the traded outcome. */
  fair: number;
  /** Engine votes for / against / abstaining. */
  agreeing: number;
  against: number;
  voting: number;
  /** Rows behind the ensemble reading. */
  sample: number;
  /** Contract horizon in ticks (digit duration or resolved quote horizon). */
  horizonTicks: number;
  /** Analysis prior's measured out-of-sample skill. */
  priorSkill: number | null;
  /** Median milliseconds between ticks on this market. */
  tickSpacingMs: number;
  /** 0–1 maturity of the sample. */
  dataQuality: number;
  symbol?: string | null;
  name?: string | null;
};

export type ForgeDigitInput = CommonInput & { digits: readonly number[]; origin: number };
export type ForgeQuoteInput = CommonInput & { prices: readonly number[]; origin: number };

function logit(probability: number): number {
  const value = clamp(probability, 1e-4, 1 - 1e-4);
  return Math.log(value / (1 - value));
}

function marketFeatures(profile: ForgeMarketProfile, tickSpacingMs: number): { cadence: number; volatility: number; kind: number } {
  const spacing = finite(tickSpacingMs) && tickSpacingMs > 0 ? tickSpacingMs : profile.expectedTickMs;
  const cadence = clamp(Math.log(spacing / 1_000) / Math.log(60), -1, 1);
  const volatility = profile.volatilityClass !== null && Number.isFinite(profile.volatilityClass)
    ? clamp(Math.log10(Math.max(1, profile.volatilityClass)) / Math.log10(250), 0, 1)
    : 0.5;
  return { cadence, volatility, kind: MARKET_KIND_CODE[profile.kind] };
}

function commonVector(input: CommonInput, context: readonly number[]): Float64Array {
  const features = new Float64Array(FORGE_FEATURE_COUNT);
  const fair = safeProbability(finite(input.fair) ? input.fair : 0.5);
  const teacher = finite(input.teacherProbability) ? safeProbability(input.teacherProbability as number) : null;
  const baseline = finite(input.baselineProbability) ? safeProbability(input.baselineProbability as number) : null;
  const prior = finite(input.priorProbability) ? safeProbability(input.priorProbability as number) : null;
  const profile = marketProfile(input.symbol, input.name);
  const market = marketFeatures(profile, input.tickSpacingMs);
  const teacherEdge = teacher === null ? 0 : teacher - fair;
  // Engine dispersion around the family-weighted estimate: correlated engines
  // that disagree still tell the network the ensemble is unstable.
  const available = input.engineValues
    .map((value, index) => ({ value, weight: input.engineWeights[index] ?? 0 }))
    .filter((row): row is { value: number; weight: number } => finite(row.value));
  const weightTotal = available.reduce((total, row) => total + Math.abs(row.weight), 0);
  let spread = 0;
  if (available.length >= 2 && weightTotal > 1e-9) {
    for (const row of available) {
      const weight = Math.abs(row.weight) / weightTotal;
      spread += weight * (row.value - fair - teacherEdge) ** 2;
    }
    spread = Math.sqrt(spread);
  }
  const tallyTotal = Math.max(1, input.agreeing + input.against + Math.max(0, input.voting - input.agreeing - input.against));
  const abstain = Math.max(0, input.engineValues.length - available.length) / Math.max(1, input.engineValues.length);
  const agreeShare = (input.agreeing + 0.5 * (input.against)) / tallyTotal;
  const agreement = finite(agreeShare) ? (input.agreeing - input.against) / tallyTotal : 0;
  const sample = Math.max(0, finite(input.sample) ? input.sample : 0);
  const maturity = clamp(sample / 300, 0, 1);
  const dispersion = context[0] ?? 0;
  /** Knowledge uncertainty: how much of a point the teacher's sample could be off by, in points. */
  const uncertainty = teacher === null
    ? 1
    : clamp(Math.sqrt(Math.max(1e-6, teacher * (1 - teacher)) / Math.max(20, sample)) / 0.05, 0, 1);

  features[0] = 1;
  features[1] = clamp(Math.tanh(teacher === null ? 0 : logit(teacher) - logit(fair)), -1, 1);
  features[2] = clamp(teacherEdge / 0.1, -1, 1);
  features[3] = clamp((baseline === null ? 0 : baseline - fair) / 0.1, -1, 1);
  features[4] = clamp((prior === null ? 0 : prior - fair) / 0.1, -1, 1);
  features[5] = clamp(2 * fair - 1, -1, 1);
  features[6] = clamp(spread / 0.1, 0, 1);
  features[7] = clamp(agreement, -1, 1);
  features[8] = clamp((input.agreeing + 0.5 * (input.voting - input.agreeing - input.against)) / tallyTotal, 0, 1);
  features[9] = clamp(abstain, 0, 1);
  features[10] = maturity;
  features[11] = clamp(Math.max(1, input.horizonTicks) / 10, 0, 1);
  features[12] = clamp((finite(input.priorSkill) ? (input.priorSkill as number) : 0) / 0.05, -1, 1);
  features[13] = market.cadence;
  features[14] = market.volatility;
  features[15] = market.kind;
  features[16] = clamp(dispersion, -1, 1);
  features[17] = clamp(context[1] ?? 0, -1, 1);
  features[18] = clamp(context[2] ?? 0, -1, 1);
  features[19] = clamp(context[3] ?? 0, -1, 1);
  features[20] = clamp(context[4] ?? 0, -1, 1);
  features[21] = clamp(teacherEdge / 0.1, -1, 1) * clamp(1 - Math.abs(dispersion), 0, 1);
  features[22] = clamp(teacherEdge / 0.1, -1, 1) * clamp(agreement, -1, 1);
  features[23] = clamp(uncertainty * (1 - maturity), 0, 1);
  for (let index = 0; index < features.length; index += 1) {
    if (!Number.isFinite(features[index])) features[index] = 0;
  }
  return features;
}

/** One causal row for a digit contract at `origin`. */
export function digitForgeVector(input: ForgeDigitInput): Float64Array {
  const context = digitContextAt(input.digits, input.origin);
  return commonVector(input, [context.entropy, context.runsZ, context.hotZ, context.parity, context.streak]);
}

/** One causal row for a Rise/Fall duration at `origin`. */
export function quoteForgeVector(input: ForgeQuoteInput): Float64Array {
  const context = quoteContextAt(input.prices, input.origin);
  return commonVector(input, [
    context.varianceRatio,
    context.trendZ,
    context.volatilityRatio,
    context.momentum,
    context.position,
  ]);
}

/**
 * A one-line reading of the market context the forge saw, used for the card
 * and the analysis notes. Deliberately descriptive: it reports what was
 * measured, not what should be traded.
 */
export function describeDigitContext(context: DigitContext): string {
  const entropy = `${(100 * context.entropy).toFixed(1)}% of maximum`;
  const parity = Math.abs(context.parity) < 0.2 ? 'balanced' : context.parity > 0 ? 'even-leaning' : 'odd-leaning';
  const runs = Math.abs(context.runsZ) < 0.33 ? 'typical alternation' : context.runsZ > 0 ? 'more alternation than chance' : 'more clustering than chance';
  return `Digit entropy ${entropy}, parity ${parity}, ${runs}, largest hot/cold z ${(3 * context.hotZ).toFixed(2)}.`;
}

export function describeQuoteContext(context: QuoteContext): string {
  const regime = context.varianceRatio > 0.25
    ? 'trend-persistent'
    : context.varianceRatio < -0.25
      ? 'mean-reverting'
      : 'random-walk-like';
  return `Variance ratio ${(1 + 2 * context.varianceRatio).toFixed(2)}, trend z ${(3 * context.trendZ).toFixed(2)}, short/long volatility ${(1 + context.volatilityRatio).toFixed(2)} — ${regime}.`;
}
