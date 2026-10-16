// Always-on Rise/Fall signal layer.
//
// Fourteen engines vote on every market and every duration (1–10 ticks,
// 1–15 minutes): twelve state engines (trend, swing structure, momentum, RSI,
// MACD, EMA cross, EMA-50, breadth, ROC, regression slope, tick-direction
// Markov chain, variance-ratio regime), a duration-specific historical drift
// engine and a logistic-regression meta-model (the "AI" engine) trained on the
// other engines' replayed scores. Each engine's weight comes from its
// directional accuracy on a validation slice, and the consensus rule is then
// replayed on a later held-out slice (backtest) before the live vote.
import { analyzeRiseFall, type MarketTick, type RiseFallAnalysis } from '../rise-fall-analysis.ts';
import {
  confidenceScore, strengthOf, summarizeBacktest, tallyVotes,
  type BacktestSummary, type ConfidenceBreakdown, type EngineVote, type SignalStrength, type VoteTally,
} from './confidence.ts';
import { familyBalancedWeights } from './consensus.ts';

export type RiseFallDirection = 'RISE' | 'FALL';
export type RiseFallHorizon = { unit: 'ticks' | 'minutes'; value: number };
export type ProgressCallback = (fraction: number, stage: string) => void;

export const RISE_FALL_MIN_TICKS = 600;
export const RISE_FALL_HORIZONS: RiseFallHorizon[] = [
  ...Array.from({ length: 10 }, (_, index) => ({ unit: 'ticks' as const, value: index + 1 })),
  ...Array.from({ length: 15 }, (_, index) => ({ unit: 'minutes' as const, value: index + 1 })),
];

const INDICATOR_WINDOW = 500;
const REPLAY_STRIDE = 2;
const VOTE_THRESHOLD = 0.05;
const MARKOV_WINDOW = 1_000;
const DRIFT_WINDOW = 500;

/**
 * Keep the feed's newest quote for each epoch, then restore chronological
 * order. This makes all engines see the same unique observations even when a
 * caller supplies a replay with out-of-order or duplicated ticks.
 */
export function normalizeRiseFallTicks(ticks: readonly MarketTick[]): MarketTick[] {
  const byEpoch = new Map<number, MarketTick>();
  for (const tick of ticks) {
    if (!Number.isFinite(tick.epoch) || !Number.isFinite(tick.quote) || tick.epoch <= 0 || tick.quote <= 0) continue;
    byEpoch.set(tick.epoch, tick);
  }
  return [...byEpoch.values()].sort((left, right) => left.epoch - right.epoch);
}

/** Validate and de-duplicate user-provided model durations before any fit. */
export function resolveRiseFallHorizons(horizons?: readonly RiseFallHorizon[]): RiseFallHorizon[] {
  if (!horizons?.length) return [...RISE_FALL_HORIZONS];
  const unique = new Map<string, RiseFallHorizon>();
  for (const horizon of horizons) {
    const validTicks = horizon?.unit === 'ticks' && Number.isInteger(horizon.value) && horizon.value >= 1 && horizon.value <= 10;
    const validMinutes = horizon?.unit === 'minutes' && Number.isInteger(horizon.value) && horizon.value >= 1 && horizon.value <= 15;
    if (!validTicks && !validMinutes) throw new Error('Rise/Fall durations must be 1–10 ticks or 1–15 minutes.');
    unique.set(`${horizon.unit}:${horizon.value}`, { unit: horizon.unit, value: horizon.value });
  }
  return [...unique.values()];
}

export type RiseFallHorizonSignal = {
  horizon: RiseFallHorizon;
  direction: RiseFallDirection;
  /** Weighted consensus score from -1 (fall) to 1 (rise). */
  consensusScore: number;
  /** Meta-model probability of a rise, when it could be trained. */
  aiProbability: number | null;
  /** Validated win-probability estimate for the signalled direction. */
  winEstimate: number;
  /** Win probability with no edge (half of the non-flat outcomes). */
  fairProbability: number;
  votes: EngineVote[];
  tally: VoteTally;
  backtest: BacktestSummary;
  validationSkill: number | null;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  strength: SignalStrength;
  historical: { sample: number; rise: number; fall: number; unchanged: number };
};

export type RiseFallMarketAnalysis = {
  kind: 'rise-fall';
  symbol: string;
  name: string;
  sample: number;
  lastQuote: number | null;
  lastEpoch: number | null;
  fresh: boolean;
  dataQuality: number;
  engineCount: number;
  best: RiseFallHorizonSignal;
  horizons: RiseFallHorizonSignal[];
  analysis: RiseFallAnalysis;
  notes: string[];
  durationMs: number;
};

export type RiseFallMarketInput = {
  symbol: string;
  name: string;
  ticks: readonly MarketTick[];
  fresh: boolean;
  horizons?: readonly RiseFallHorizon[];
  /** Markets competing in the same scan (for the selection penalty). */
  marketsInScan?: number;
};

type EngineDef = { id: string; label: string; family: string };

export type PurgedReplayRow = { origin: number; exit: number; label: number | null };
export type PurgedReplaySplit<T extends PurgedReplayRow> = { training: T[]; validation: T[]; holdout: T[] };

/**
 * Chronological 50/25/25 replay split with horizon-aware purging. A training
 * label must settle before validation begins, and a validation label must settle
 * before holdout begins; otherwise future price movement can leak across a
 * split even though the prediction origin itself is earlier.
 */
export function splitPurgedReplay<T extends PurgedReplayRow>(
  rows: readonly T[],
  trainingBoundary: number,
  holdoutBoundary: number,
): PurgedReplaySplit<T> {
  if (!Number.isFinite(trainingBoundary) || !Number.isFinite(holdoutBoundary) || holdoutBoundary <= trainingBoundary) {
    throw new Error('Replay boundaries must be finite and strictly increasing.');
  }
  const labelled = rows.filter((row) => row.label !== null && Number.isFinite(row.label) && Number.isFinite(row.origin) && Number.isFinite(row.exit) && row.exit >= row.origin);
  return {
    training: labelled.filter((row) => row.origin < trainingBoundary && row.exit < trainingBoundary),
    validation: labelled.filter((row) => row.origin >= trainingBoundary && row.origin < holdoutBoundary && row.exit < holdoutBoundary),
    holdout: labelled.filter((row) => row.origin >= holdoutBoundary),
  };
}

/** Select outcome intervals that do not reuse any return increments. */
export function selectNonOverlappingOutcomes<T extends Pick<PurgedReplayRow, 'origin' | 'exit'>>(rows: readonly T[]): T[] {
  const ordered = rows
    .filter((row) => Number.isFinite(row.origin) && Number.isFinite(row.exit) && row.exit > row.origin)
    .slice()
    .sort((left, right) => left.origin - right.origin || left.exit - right.exit);
  const selected: T[] = [];
  let lastExit = Number.NEGATIVE_INFINITY;
  for (const row of ordered) {
    if (row.origin < lastExit) continue;
    selected.push(row);
    lastExit = row.exit;
  }
  return selected;
}

/** Count independent outcome intervals. */
export function countNonOverlappingOutcomes(rows: readonly Pick<PurgedReplayRow, 'origin' | 'exit'>[]): number {
  return selectNonOverlappingOutcomes(rows).length;
}

export const RISE_FALL_ENGINES: EngineDef[] = [
  { id: 'trend', label: 'Multi-window trend · 20–500 ticks', family: 'trend' },
  { id: 'dow', label: 'Dow swing structure · HH/HL vs LH/LL', family: 'structure' },
  { id: 'momentum', label: 'Momentum composite · RSI / EMA / MACD', family: 'momentum' },
  { id: 'rsi', label: 'RSI-14 momentum', family: 'momentum' },
  { id: 'macd', label: 'MACD histogram · 12 / 26 / 9', family: 'momentum' },
  { id: 'ema-cross', label: 'EMA 9 / 21 crossover', family: 'trend' },
  { id: 'ema50', label: 'Price vs EMA-50', family: 'trend' },
  { id: 'breadth', label: '100-tick up / down breadth', family: 'structure' },
  { id: 'roc', label: 'ROC-20 · volatility normalized', family: 'momentum' },
  { id: 'regression', label: 'Linear-regression slope · 60 ticks', family: 'statistical' },
  { id: 'markov', label: 'Tick-direction Markov chain · orders 1–3', family: 'statistical' },
  { id: 'variance-ratio', label: 'Variance-ratio regime · Lo–MacKinlay', family: 'statistical' },
  { id: 'drift', label: 'Historical drift at this duration', family: 'statistical' },
  { id: 'ai', label: 'AI meta-model · logistic regression on all engines', family: 'ml' },
];
const STATE_ENGINE_COUNT = 12;
const DRIFT_INDEX = 12;
const AI_INDEX = 13;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sign = (value: number) => (value > 0 ? 1 : value < 0 ? -1 : 0);

export function formatRiseFallHorizon(horizon: RiseFallHorizon): string {
  const unit = horizon.unit === 'ticks' ? (horizon.value === 1 ? 'tick' : 'ticks') : (horizon.value === 1 ? 'minute' : 'minutes');
  return `${horizon.value} ${unit}`;
}

function regressionScore(prices: readonly number[]): number | null {
  const window = prices.slice(-60);
  const n = window.length;
  if (n < 20) return null;
  const meanX = (n - 1) / 2;
  const meanY = window.reduce((sum, value) => sum + value, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < n; index += 1) { sxy += (index - meanX) * (window[index] - meanY); sxx += (index - meanX) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;
  let moveSq = 0;
  for (let index = 1; index < n; index += 1) moveSq += (window[index] - window[index - 1]) ** 2;
  const tickDeviation = Math.sqrt(moveSq / (n - 1));
  if (!(tickDeviation > 0)) return 0;
  // Regression-implied move over the window relative to a random walk's scale.
  return Math.tanh((slope * n) / (tickDeviation * Math.sqrt(n)) / 2);
}

function varianceRatioScore(prices: readonly number[]): number | null {
  const window = prices.slice(-301);
  if (window.length < 120) return null;
  const q = 10;
  const returns: number[] = [];
  for (let index = 1; index < window.length; index += 1) returns.push(window[index] - window[index - 1]);
  const mu = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance1 = returns.reduce((sum, value) => sum + (value - mu) ** 2, 0) / returns.length;
  if (!(variance1 > 0)) return 0;
  let varianceQ = 0;
  let count = 0;
  for (let index = q; index < window.length; index += 1) { varianceQ += (window[index] - window[index - q] - q * mu) ** 2; count += 1; }
  const ratio = varianceQ / count / (q * variance1);
  const deviation = ratio - 1;
  if (Math.abs(deviation) < 0.08) return 0;
  const recent = window.at(-1)! - window[Math.max(0, window.length - 21)];
  // Ratio above one = persistent increments (follow); below one = mean reverting (fade).
  return sign(recent) * clamp(deviation * 2, -1, 1);
}

function directionOf(prices: readonly number[], index: number): number {
  return sign(prices[index] - prices[index - 1]);
}

/** Sliding-window tick-direction Markov chain (orders 3 → 1 back-off). */
class DirectionMarkov {
  private counts3 = new Float64Array(27 * 2);
  private counts1 = new Float64Array(3 * 2);
  private start = 0;
  private end = 0;
  private readonly prices: readonly number[];
  constructor(prices: readonly number[]) { this.prices = prices; }
  private key(index: number, order: number): number {
    let key = 0;
    for (let offset = order - 1; offset >= 0; offset -= 1) key = key * 3 + (directionOf(this.prices, index - offset) + 1);
    return key;
  }
  private apply(target: number, delta: number) {
    // Transition: context ending at target - 1 → direction at target.
    const next = directionOf(this.prices, target);
    if (next === 0) return;
    const slot = next > 0 ? 0 : 1;
    if (target - 3 >= 1) this.counts3[this.key(target - 1, 3) * 2 + slot] += delta;
    if (target - 1 >= 1) this.counts1[this.key(target - 1, 1) * 2 + slot] += delta;
  }
  /** Advance the window so it covers transitions ending in (origin - MARKOV_WINDOW, origin]. */
  advance(origin: number) {
    const desiredStart = Math.max(2, origin - MARKOV_WINDOW + 1);
    while (this.end <= origin) { if (this.end >= 2) this.apply(this.end, 1); this.end += 1; }
    while (this.start < desiredStart) { if (this.start >= 2 && this.start < this.end) this.apply(this.start, -1); this.start += 1; }
  }
  score(origin: number): number | null {
    if (origin < 4) return null;
    const k3 = this.key(origin, 3) * 2;
    let up = this.counts3[k3];
    let down = this.counts3[k3 + 1];
    if (up + down < 25) {
      const k1 = this.key(origin, 1) * 2;
      up = this.counts1[k1];
      down = this.counts1[k1 + 1];
    }
    if (up + down < 25) return null;
    const probability = (up + 1) / (up + down + 2);
    return clamp((probability - 0.5) * 5, -1, 1);
  }
}

function stateScores(analysis: RiseFallAnalysis, prices: readonly number[], markov: number | null): Array<number | null> {
  const average = analysis.averageTickMove14;
  const hasMove = average !== null && average > 0;
  return [
    analysis.tickCount >= 20 ? analysis.trendScore : null,
    analysis.tickCount >= 50 ? analysis.dowScore : null,
    analysis.tickCount >= 34 ? analysis.momentumScore : null,
    analysis.rsi14 === null ? null : clamp((analysis.rsi14 - 50) / 35, -1, 1),
    analysis.macdHistogram === null || !hasMove ? null : Math.tanh(analysis.macdHistogram / (average! * 5)),
    analysis.ema9 === null || analysis.ema21 === null || !hasMove ? null : Math.tanh((analysis.ema9 - analysis.ema21) / (average! * 4)),
    analysis.ema50 === null ? null : analysis.ema50Score,
    analysis.tickCount >= 100 ? analysis.breadthScore : null,
    analysis.roc20 === null ? null : analysis.rocScore,
    regressionScore(prices),
    markov,
    varianceRatioScore(prices),
  ];
}

function exitIndices(epochs: readonly number[], horizon: RiseFallHorizon): Int32Array {
  const n = epochs.length;
  const exits = new Int32Array(n).fill(-1);
  if (horizon.unit === 'ticks') {
    for (let start = 0; start + horizon.value < n; start += 1) exits[start] = start + horizon.value;
    return exits;
  }
  const duration = horizon.value * 60;
  let exit = 0;
  for (let start = 0; start < n; start += 1) {
    if (exit <= start) exit = start + 1;
    const target = epochs[start] + duration;
    while (exit < n && epochs[exit] < target) exit += 1;
    if (exit >= n) break;
    exits[start] = exit;
  }
  return exits;
}

/** Ridge-regularized logistic regression fitted by Newton / IRLS steps. */
function fitLogistic(rows: readonly number[][], labels: readonly number[], ridge = 2): ((row: number[]) => number) | null {
  if (rows.length < 120 || labels.length !== rows.length || !rows[0]?.length) return null;
  const width = rows[0].length;
  if (rows.some((row) => row.length !== width || row.some((value) => !Number.isFinite(value)))
    || labels.some((label) => label !== 0 && label !== 1)) return null;
  const positives = labels.reduce((total, label) => total + label, 0);
  if (positives < 10 || rows.length - positives < 10) return null;
  const means = Array.from({ length: width }, (_, j) => rows.reduce((sum, row) => sum + row[j], 0) / rows.length);
  const deviations = Array.from({ length: width }, (_, j) => Math.sqrt(rows.reduce((sum, row) => sum + (row[j] - means[j]) ** 2, 0) / rows.length) || 1);
  const standardize = (row: readonly number[]) => [1, ...row.map((value, j) => (value - means[j]) / deviations[j])];
  const x = rows.map(standardize);
  const size = width + 1;
  let beta = Array<number>(size).fill(0);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const hessian = Array.from({ length: size }, (_, row) => Array.from({ length: size + 1 }, (_, column) => (row === column && row > 0 ? ridge : row === column ? 1e-6 : 0)));
    for (let row = 1; row < size; row += 1) hessian[row][size] = -ridge * beta[row];
    x.forEach((features, index) => {
      let logit = 0;
      for (let j = 0; j < size; j += 1) logit += beta[j] * features[j];
      const p = 1 / (1 + Math.exp(-clamp(logit, -30, 30)));
      const weight = Math.max(1e-4, p * (1 - p));
      const residual = labels[index] - p;
      for (let j = 0; j < size; j += 1) {
        hessian[j][size] += features[j] * residual;
        for (let k = 0; k < size; k += 1) hessian[j][k] += weight * features[j] * features[k];
      }
    });
    // Solve H · step = gradient with partial pivoting.
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
    beta = beta.map((value, j) => clamp(value + step[j], -20, 20));
    if (step.every((value) => Math.abs(value) < 1e-6)) break;
  }
  return (row: number[]) => {
    const features = standardize(row);
    let logit = 0;
    for (let j = 0; j < size; j += 1) logit += beta[j] * features[j];
    return 1 / (1 + Math.exp(-clamp(logit, -30, 30)));
  };
}

function dataQuality(sample: number, fresh: boolean): number {
  return (0.85 + 0.15 * clamp((sample - RISE_FALL_MIN_TICKS) / 1_400, 0, 1)) * (fresh ? 1 : 0.85);
}

/** Full multi-duration analysis for one market. */
export function analyzeRiseFallMarket(input: RiseFallMarketInput, onProgress?: ProgressCallback): RiseFallMarketAnalysis {
  const started = Date.now();
  const ticks = normalizeRiseFallTicks(input.ticks);
  if (ticks.length < RISE_FALL_MIN_TICKS) throw new Error(`${input.name} has ${ticks.length} valid unique ticks; ${RISE_FALL_MIN_TICKS} are needed.`);
  const prices = ticks.map((tick) => tick.quote);
  const epochs = ticks.map((tick) => tick.epoch);
  const n = ticks.length;
  const horizons = resolveRiseFallHorizons(input.horizons);
  onProgress?.(0.02, 'Replaying 12 indicator engines over recent history');

  // 1. Replay every state engine at past origins (no look-ahead: each origin
  //    sees only ticks up to and including itself).
  const firstOrigin = Math.min(n - 1, INDICATOR_WINDOW + 20);
  const origins: number[] = [];
  for (let origin = firstOrigin; origin < n - 1; origin += REPLAY_STRIDE) origins.push(origin);
  const markov = new DirectionMarkov(prices);
  const replayScores: Array<Array<number | null>> = [];
  origins.forEach((origin, index) => {
    markov.advance(origin);
    const windowTicks = ticks.slice(Math.max(0, origin - INDICATOR_WINDOW + 1), origin + 1);
    const windowPrices = prices.slice(Math.max(0, origin - INDICATOR_WINDOW + 1), origin + 1);
    replayScores.push(stateScores(analyzeRiseFall(windowTicks, 5), windowPrices, markov.score(origin)));
    if (index % 60 === 0) onProgress?.(0.02 + 0.38 * (index / Math.max(1, origins.length)), 'Replaying 12 indicator engines over recent history');
  });
  markov.advance(n - 1);
  const liveAnalysis = analyzeRiseFall(ticks.slice(-INDICATOR_WINDOW), 5);
  const liveState = stateScores(liveAnalysis, prices.slice(-INDICATOR_WINDOW), markov.score(n - 1));
  const quality = dataQuality(n, input.fresh);

  // 2. Evaluate every duration.
  const signals: RiseFallHorizonSignal[] = horizons.map((horizon, horizonIndex) => {
    if (horizonIndex % 3 === 0) onProgress?.(0.4 + 0.55 * (horizonIndex / horizons.length), `Training the AI meta-model and backtesting ${formatRiseFallHorizon(horizon)}`);
    const exits = exitIndices(epochs, horizon);
    const outcome = (start: number) => exits[start] < 0 ? null : sign(prices[exits[start]] - prices[start]);
    // Prefix sums of completed outcomes for the drift engine.
    const risePrefix = new Int32Array(n + 1);
    const fallPrefix = new Int32Array(n + 1);
    for (let start = 0; start < n; start += 1) {
      const result = outcome(start);
      risePrefix[start + 1] = risePrefix[start] + (result === 1 ? 1 : 0);
      fallPrefix[start + 1] = fallPrefix[start] + (result === -1 ? 1 : 0);
    }
    let lastCompleted = -1;
    const driftAt = (origin: number) => {
      // Starts whose exit tick is already known at this origin.
      while (lastCompleted + 1 < n && exits[lastCompleted + 1] >= 0 && exits[lastCompleted + 1] <= origin) lastCompleted += 1;
      if (lastCompleted < 0) return null;
      const from = Math.max(0, lastCompleted - DRIFT_WINDOW + 1);
      const rise = risePrefix[lastCompleted + 1] - risePrefix[from];
      const fall = fallPrefix[lastCompleted + 1] - fallPrefix[from];
      return rise + fall >= 30 ? (rise - fall) / (rise + fall) : null;
    };
    const rows = origins.map((origin, index) => ({
      origin,
      exit: exits[origin],
      scores: [...replayScores[index], driftAt(origin)],
      label: outcome(origin),
    }));
    const liveDrift = driftAt(n - 1);
    const replaySpan = Math.max(1, n - firstOrigin - 1);
    const trainingBoundary = firstOrigin + Math.floor(replaySpan * 0.5);
    const holdoutBoundary = firstOrigin + Math.floor(replaySpan * 0.75);
    const { training: setA, validation: setB, holdout: setC } = splitPurgedReplay(rows, trainingBoundary, holdoutBoundary);

    // 3. AI meta-model: logistic regression on all replayed engine scores.
    const features = (scores: Array<number | null>) => scores.slice(0, STATE_ENGINE_COUNT + 1).map((value) => value ?? 0);
    const trainRows = selectNonOverlappingOutcomes(setA).filter((row) => row.label !== 0);
    const model = fitLogistic(trainRows.map((row) => features(row.scores)), trainRows.map((row) => (row.label === 1 ? 1 : 0)));
    const aiScore = (scores: Array<number | null>) => (model ? 2 * (model(features(scores)) - 0.5) : null);
    const withAi = (scores: Array<number | null>) => [...scores, aiScore(scores)];

    // 4. Engine weights from independent directional outcomes in validation
    // slice B, not the overlapping replay rows themselves.
    const independentValidationRows = selectNonOverlappingOutcomes(setB);
    const accuracy = RISE_FALL_ENGINES.map((_, engine) => {
      let hits = 0;
      let total = 0;
      for (const row of independentValidationRows) {
        const score = engine === AI_INDEX ? aiScore(row.scores) : row.scores[engine];
        if (score === null || Math.abs(score) <= VOTE_THRESHOLD) continue;
        total += 1;
        if (sign(score) === row.label) hits += 1;
      }
      return { hits, total, rate: total >= 20 ? hits / total : null };
    });
    // Log-odds style weighting: coin-flip engines fade, consistently right ones lead.
    const factors = accuracy.map((item) => (item.rate === null ? 1 : clamp(Math.exp(8 * (item.rate - 0.5)), 0.3, 3)));
    const consensus = (scores: Array<number | null>) => {
      const weights = familyBalancedWeights(RISE_FALL_ENGINES.map((engine, index) => ({
        family: engine.family,
        reliability: factors[index],
        available: scores[index] !== null,
      })));
      const score = scores.reduce<number>((total, value, index) => total + (value === null ? 0 : weights[index] * value), 0);
      return { score, weights };
    };

    // 5. Backtest the consensus rule on the later held-out slice C, separately
    //    per direction: a live RISE is judged only by past RISE calls.
    const fired = { rise: 0, fall: 0 };
    const firedRows: { rise: typeof setC; fall: typeof setC } = { rise: [], fall: [] };
    const independentHoldoutOrigins = new Set(selectNonOverlappingOutcomes(setC).map((row) => row.origin));
    const wins = { rise: 0, fall: 0 };
    let flats = 0;
    let aiLoss = 0;
    let fairLoss = 0;
    let aiRows = 0;
    for (const row of setC) {
      if (row.label === 0) flats += 1;
      const scores = withAi(row.scores);
      const score = consensus(scores).score;
      if (score > 0.02) { fired.rise += 1; firedRows.rise.push(row); if (row.label === 1) wins.rise += 1; }
      else if (score < -0.02) { fired.fall += 1; firedRows.fall.push(row); if (row.label === -1) wins.fall += 1; }
      const ai = scores[AI_INDEX];
      if (independentHoldoutOrigins.has(row.origin) && ai !== null && row.label !== 0) {
        const p = 0.5 + ai / 2;
        const y = row.label === 1 ? 1 : 0;
        aiLoss += (p - y) ** 2;
        fairLoss += 0.25;
        aiRows += 1;
      }
    }
    const flatRate = setC.length ? flats / setC.length : 0;
    const fair = 0.5 * (1 - flatRate);
    // Count non-overlapping outcome intervals directly from their observed exit
    // ticks. This is more reliable than converting elapsed minutes with an
    // average tick rate, especially when the feed has irregular gaps.
    const independentOutcomes = countNonOverlappingOutcomes(setC);
    const reliability = clamp(independentOutcomes / 40, 0, 1);
    const rawSkill = aiRows >= 30 && fairLoss > 0 ? 1 - aiLoss / fairLoss : null;
    const validationSkill = rawSkill === null ? null : rawSkill * reliability;

    // 6. Live vote. Family budgets prevent correlated indicators from
    // outvoting independent evidence just because that family has more models.
    const liveScores = withAi([...liveState, liveDrift]);
    const liveConsensus = consensus(liveScores);
    const consensusScore = liveConsensus.score;
    const directionSign = consensusScore !== 0 ? sign(consensusScore) : sign(liveAnalysis.trendScore) || 1;
    const direction: RiseFallDirection = directionSign > 0 ? 'RISE' : 'FALL';
    const votes: EngineVote[] = RISE_FALL_ENGINES.map((engine, index) => {
      const score = liveScores[index];
      const vote = score === null ? 'abstain' : Math.abs(score) <= VOTE_THRESHOLD ? 'neutral' : sign(score) === directionSign ? 'agree' : 'against';
      const measured = accuracy[index];
      return {
        id: engine.id, label: engine.label, family: engine.family, vote,
        value: score === null ? null : score * directionSign,
        weight: score === null ? 0 : liveConsensus.weights[index],
        skill: measured.rate === null ? null : measured.rate - 0.5,
        note: measured.rate === null ? 'Too few validation outcomes to measure accuracy' : `Validation accuracy ${(measured.rate * 100).toFixed(1)}% on ${measured.total} outcomes`,
      };
    });
    const tally = tallyVotes(votes);
    const aiProbability = liveScores[AI_INDEX] === null ? null : 0.5 + (liveScores[AI_INDEX] as number) / 2;
    const side = direction === 'RISE' ? 'rise' : 'fall';
    const independentCalls = countNonOverlappingOutcomes(firedRows[side]);
    const backtest = summarizeBacktest(wins[side], fired[side], fair, independentCalls);
    const horizonQuality = quality * clamp(0.6 + 0.4 * reliability, 0.6, 1);
    // Indicator alignment is not an edge by itself (trend tools agree whenever a
    // random path drifts). The edge comes from the AI meta-model's probability
    // for this direction, trusted only as far as it validated out of sample.
    const aiForDirection = aiProbability === null ? null : direction === 'RISE' ? aiProbability : 1 - aiProbability;
    const trust = clamp(25 * Math.max(0, validationSkill ?? 0), 0, 1);
    const winEstimate = aiForDirection === null ? fair : fair + trust * (aiForDirection - 0.5);
    const { confidence, breakdown } = confidenceScore({
      weightedAgreement: tally.weightedAgreement,
      edgeRatio: (winEstimate - fair) / 0.5,
      backtest,
      validationSkill,
      dataQuality: horizonQuality,
      selectionPool: horizons.length * Math.max(1, input.marketsInScan ?? 1),
    });
    const recent = { sample: 0, rise: 0, fall: 0, unchanged: 0 };
    // Report the latest 500 completed outcomes (not 500 start ticks) so the
    // historical panel uses comparable sample sizes across every duration.
    for (let start = n - 1; start >= 0 && recent.sample < DRIFT_WINDOW; start -= 1) {
      const result = outcome(start);
      if (result === null) continue;
      recent.sample += 1;
      if (result > 0) recent.rise += 1; else if (result < 0) recent.fall += 1; else recent.unchanged += 1;
    }
    return {
      horizon, direction, consensusScore, aiProbability, winEstimate, fairProbability: fair, votes, tally, backtest, validationSkill,
      confidence, breakdown, strength: strengthOf(confidence, tally, backtest), historical: recent,
    };
  });

  signals.sort((a, b) => b.confidence - a.confidence || b.tally.weightedAgreement - a.tally.weightedAgreement || (a.horizon.unit === b.horizon.unit ? a.horizon.value - b.horizon.value : a.horizon.unit === 'ticks' ? -1 : 1));
  const notes: string[] = [];
  if (!input.fresh) notes.push('Live tick freshness was not confirmed; confidence is reduced.');
  if (n < 1_500) notes.push(`Only ${n} ticks of history; longer minute durations have little validation data.`);
  onProgress?.(1, 'Signal ready');
  return {
    kind: 'rise-fall', symbol: input.symbol, name: input.name, sample: n,
    lastQuote: prices.at(-1) ?? null, lastEpoch: epochs.at(-1) ?? null, fresh: input.fresh, dataQuality: quality,
    engineCount: RISE_FALL_ENGINES.length, best: signals[0], horizons: signals, analysis: liveAnalysis, notes,
    durationMs: Date.now() - started,
  };
}
