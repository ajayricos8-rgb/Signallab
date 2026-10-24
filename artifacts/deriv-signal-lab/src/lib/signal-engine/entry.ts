// Entry analysis: WHEN and AT WHAT the signal should be traded.
//
// Run Analysis answers "which contract, on which market, for how long". This
// module answers the other half of the question: the entry point (the quote or
// the tick context the trade should be opened on) and the entry time (how long
// that entry usually takes, and how long the signal stays worth entering).
//
// Everything is measured on replayed signals, never assumed:
//   * quote contracts (Rise/Fall) — for every past signal the same consensus
//     rule fired on, the replay records how far the price moved against the
//     signal before the contract expired (the pullback an entry can wait for)
//     and how far it moved with it (the breakout an entry can wait for). The
//     entry depth is a percentile of those excursions, the window is a
//     percentile of the waits, and a trigger is only offered when entering on
//     it won more often than buying at the signal price on the same rows. When
//     the entry never arrives the bot decides with its own Entry setting
//     (market or skip) — that fallback is the caller's job.
//   * digit contracts (Over/Under, Even/Odd, Matches) — the quote is irrelevant
//     (the contract settles on the exit tick's digit), so the entry is a tick
//     context: the digit printed by the tick right before the entry tick.
//     Contexts are selected on the older 60% of the ticks and only kept when
//     the lift survives on the newer 40%.
//
// Pure module: no I/O, no DOM, no React. It runs inside the Web Workers that
// analyse markets, so every value must be structured-clone friendly.
import type { SignalStrength } from './confidence.ts';
import { fitLevelReversion, type LevelReversionModel } from './market-state.ts';

export type EntryTrigger = 'immediate' | 'quote' | 'digit';
export type EntryMode = 'immediate' | 'pullback' | 'breakout' | 'context';

/**
 * The analysis this entry belongs to: what its engines and its AI model said
 * about the traded outcome. Both analyzers require it, so an entry can only
 * ever be produced by a real analysis — there is no way to build one from
 * nothing, and `EntryPlan.evidence` carries these numbers to the UI and the bot.
 */
export type EntrySignalContext = {
  source: 'rise-fall' | 'digit';
  /** Engines that agreed with the traded outcome, out of those that voted. */
  agreeing: number;
  total: number;
  /** The analysis's own probability for the traded outcome (0–1). */
  probability: number | null;
  /** Raw AI meta-model probability for the same outcome (0–1), when there is one. */
  aiProbability?: number | null;
  /** Layer-3 verdict for the same trade, when the analysis produced one. */
  confirmation?: {
    status: 'confirmed' | 'adjusted' | 'cautious' | 'contradicted';
    edgePts: number;
    decisive: boolean;
  } | null;
};

/** Where an entry came from: the engine analysis, its AI and its replay. */
export type EntryEvidence = {
  source: 'rise-fall' | 'digit';
  agreeing: number;
  total: number;
  /** The analysis's own probability for the traded outcome (0–1). */
  signalProbability: number | null;
  /** Raw AI meta-model probability for the same outcome (0–1). */
  aiProbability: number | null;
  /** Win probability with no edge for this contract (0–1). */
  fairRate: number;
  /** The replay the entry numbers were measured on. */
  rule: string;
  /** Confirmation layer verdict that travelled with the signal. */
  confirmation: {
    status: 'confirmed' | 'adjusted' | 'cautious' | 'contradicted';
    edgePts: number;
    decisive: boolean;
  } | null;
};

/** The replay rule behind each family's entry numbers. */
const ENTRY_RULES: Record<EntrySignalContext['source'], string> = {
  'rise-fall': "the signal's consensus rule replayed tick by tick on this market",
  digit: "the contract's held-out ensemble rule replayed tick by tick",
};

export type EntryValidation = {
  /** Rows the entry rule was validated on (the newer part of the replay). */
  sample: number;
  /** Win-rate gain over buying at the signal, in points, on those rows. */
  gainPts: number;
  /** Share of validated signals that reached the trigger inside the window. */
  reachRate: number;
  /** Win rate of the whole entry policy on the validation rows. */
  rate: number;
  /** No-edge rate the policy had to clear. */
  fairRate: number;
  /** True when the validation rows independently confirmed the rule. */
  passed: boolean;
  /**
   * `out-of-sample` when the level/window were selected on older rows and
   * scored on newer ones; `in-sample` only when there were too few rows to
   * split (never presented as validated).
   */
  phase: 'out-of-sample' | 'in-sample';
};

export type EntryPlan = {
  mode: EntryMode;
  trigger: EntryTrigger;
  /** Short chip text, e.g. "Pullback entry". */
  label: string;
  /** Why this entry, with the replay numbers behind it. */
  detail: string;
  /** Quote the entry waits for (quote triggers only). */
  priceLevel: number | null;
  /** 'below' waits for the price to tick down to the level, 'above' up to it. */
  priceCondition: 'above' | 'below' | null;
  /** Distance from the reference quote to the level, in price units (≥ 0). */
  distance: number | null;
  /** Quote the analysis saw; every bot run re-bases the level on the live quote. */
  referenceQuote: number | null;
  /**
   * How the bot re-bases this level on the live quote. `relative` (the default)
   * keeps the measured distance, which is right for an excursion-based level.
   * `absolute` keeps the level itself, which is right for a level anchored to a
   * fitted equilibrium: dragging it along with the price would erase exactly the
   * stretch it was measured on.
   */
  rebase?: 'relative' | 'absolute';
  /** Context digits the tick before the entry must print (digit triggers only). */
  contextDigits: number[] | null;
  /** How to read those digits, e.g. "after an even digit". */
  contextLabel: string | null;
  /** The entry must happen inside this many ticks of the signal. */
  windowTicks: number;
  /**
   * Layer-6 cap on that window: how many ticks the measured edge actually
   * survived after the signal. The entry may never wait longer than this, even
   * when the timing replay offered a wider window. Absent on plans built
   * outside a full analysis, in which case the measured window stands.
   */
  validForTicks?: number | null;
  /** Median ticks the entry took in the replay. */
  expectedWaitTicks: number;
  /** Median wall-clock wait measured on the replayed signals. */
  expectedWaitMs: number;
  /** Share of replayed signals that reached the entry inside the window (0–1). */
  reachRate: number | null;
  /** Win-rate change from waiting for the entry instead of buying at the signal, in points. */
  edgeGainPts: number | null;
  /** Replayed signals behind the plan. */
  sample: number;
  /** 0–100 strength of the ENTRY evidence (not of the direction). */
  confidence: number;
  /**
   * How far beyond the measured level the quote may print and still count as
   * the planned entry. A larger gap means the trigger arrived faster than the
   * replay measured, so the bot treats it as a missed entry instead of chasing.
   */
  tolerance: number | null;
  /** Out-of-sample validation of the timing rule, when there was enough data. */
  validation: EntryValidation | null;
  /** How the order should be filled at the trigger. */
  fill: 'market' | 'level-or-better' | 'limit-with-tolerance' | 'context';
  /**
   * True when the replay measured a win-rate gain for this trigger (and, for the
   * digit families, when the context survived its held-out slice). Only a
   * measured trigger is ever offered to the bot; `false` always means "the
   * analysis concluded the trade should be entered at the signal tick".
   */
  measured: boolean;
  /**
   * The engine analysis this entry came from: which engines agreed, what the AI
   * model said, the contract's no-edge rate and the replay the numbers were
   * measured on. Every plan carries it, and `isEntryPlan` refuses plans without
   * it, so the bot can never trade an entry that was not produced by a run.
   */
  evidence: EntryEvidence;
};

export type EntryObservation = {
  /** Latest tick for the plan's market. */
  quote: number | null;
  digit: number | null;
  epoch: number | null;
};

export type EntryState = {
  /** Ticks printed since the entry was armed. */
  elapsedTicks: number;
  /** Wall-clock now, in the same clock as `deadline`. */
  now: number;
  /** Wall-clock moment the entry window closes. */
  deadline: number;
};

export type EntryEvaluation = {
  status: 'waiting' | 'ready' | 'expired' | 'missed';
  /** One line for the bot ledger. */
  reason: string;
  /** How far the quote still is from the level (price units). */
  distance: number | null;
  elapsedTicks: number;
  remainingTicks: number;
  remainingMs: number;
};

export const ENTRY_LIMITS = {
  /** Entry window, in ticks. Below two ticks "waiting" is meaningless. */
  windowTicks: { min: 2, max: 60 },
  /** Replayed signals sampled for the timing statistics. */
  maxSample: 240,
  /** Most ticks a replay may scan forward for an entry trigger. */
  scanTicks: 120,
  /** Rows, reach and lift needed before a trigger is offered at all. */
  minSample: 40,
  /** Newer rows needed to independently confirm a trigger out of sample. */
  minValidationSample: 30,
  /** Paired z-score the validation rows must clear (better vs worse entries). */
  minValidationZ: 0.5,
  minReach: 0.55,
  /** Points of win rate a trigger must add before it beats buying at the signal. */
  minEdgePts: 0.5,
  /** An excursion below this fraction of the average tick move is not tradeable. */
  minDepthRatio: 0.25,
  /** Digit context windows stay short: digits reshuffle every tick. */
  contextWindowTicks: { min: 3, max: 40 },
} as const;

const ENTRY_MIN_WINDOW_MS = 1_500;
const ENTRY_MAX_WINDOW_MS = 180_000;

/**
 * Digit-context gates. Up to ten contexts are inspected per contract and every
 * scan inspects several contracts, so the selection z is a multiple-comparison
 * one and the lift only counts when it survives on the newer 40% of the ticks
 * with its own one-sided test. Calibrated on random digit streams: with these
 * numbers a pure-noise stream almost never earns a context entry.
 */
const CONTEXT_SELECTION_Z = 2.8;
const CONTEXT_MIN_LIFT = 0.02;
const CONTEXT_MIN_VALIDATION_ROWS = 40;
const CONTEXT_MIN_VALIDATION_PTS = 1;
const CONTEXT_VALIDATION_Z = 1.64;

/**
 * Depth grid. The entry engine does not pick one arbitrary percentile: it
 * measures a few shallow-to-deep levels on the selection slice and keeps the
 * one whose policy (wait for the level, else enter at market) added the most
 * win rate there — subject to the same rule holding on the newer slice.
 */
const PULLBACK_PERCENTILES = [0.3, 0.35, 0.4, 0.45] as const;
const BREAKOUT_PERCENTILES = [0.35, 0.45] as const;
/** Wait percentile the window has to cover. */
const WAIT_WINDOW_PERCENTILE = 0.85;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sign = (value: number) => (value > 0 ? 1 : value < 0 ? -1 : 0);

function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

/** Compact price text: keeps the significant decimals, drops a trailing dot. */
function priceText(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 1_000 ? 3 : Math.abs(value) >= 1 ? 4 : 6;
  return value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Wilson score interval, used to keep thin contexts out of the plan. */
export function wilsonLowerBound(hits: number, sample: number, z = 1.96): number {
  if (!(sample > 0)) return 0;
  const rate = hits / sample;
  const denominator = 1 + (z * z) / sample;
  const centre = rate + (z * z) / (2 * sample);
  const spread = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * sample)) / sample);
  return clamp((centre - spread) / denominator, 0, 1);
}

/**
 * Evidence strength of the entry timing from the paired replay: how often the
 * entry beat buying at the signal against how often it lost to it, shrunk when
 * few signals were replayed. 50 means "no timing evidence either way".
 */
export function entryConfidence(input: { improved: number; worsened: number; sample: number }): number {
  const discordant = input.improved + input.worsened;
  const z = discordant > 0 ? (input.improved - input.worsened) / Math.sqrt(discordant) : 0;
  const reliability = clamp(input.sample / 120, 0, 1);
  return Math.round(clamp(50 + 50 * Math.tanh(z / 2) * reliability, 0, 100));
}

/** The plan the bot falls back to when no timing evidence exists. */
export function immediateEntryPlan(options: {
  reason: string;
  sample?: number;
  confidence?: number;
  /** The analysis the plan belongs to. Required: an entry always has a source. */
  evidence: EntryEvidence;
}): EntryPlan {
  return {
    mode: 'immediate',
    trigger: 'immediate',
    label: 'Enter next tick',
    detail: options.reason,
    priceLevel: null,
    priceCondition: null,
    distance: null,
    referenceQuote: null,
    contextDigits: null,
    contextLabel: null,
    windowTicks: ENTRY_LIMITS.windowTicks.min,
    expectedWaitTicks: 0,
    expectedWaitMs: 0,
    reachRate: null,
    edgeGainPts: 0,
    sample: Math.max(0, Math.round(options.sample ?? 0)),
    confidence: clamp(Math.round(options.confidence ?? 50), 0, 100),
    tolerance: null,
    validation: null,
    fill: 'market',
    measured: false,
    evidence: options.evidence,
  };
}

/** Builds the provenance block from what the analysis knows about the signal. */
function buildEvidence(signal: EntrySignalContext, fairRate: number): EntryEvidence {
  return {
    source: signal.source,
    agreeing: Math.max(0, Math.round(signal.agreeing)),
    total: Math.max(0, Math.round(signal.total)),
    signalProbability:
      typeof signal.probability === 'number' && Number.isFinite(signal.probability)
        ? clamp(signal.probability, 0, 1)
        : null,
    aiProbability:
      typeof signal.aiProbability === 'number' && Number.isFinite(signal.aiProbability)
        ? clamp(signal.aiProbability, 0, 1)
        : null,
    fairRate,
    rule: ENTRY_RULES[signal.source],
    confirmation: signal.confirmation ? { ...signal.confirmation } : null,
  };
}

/**
 * Why the analysis does not stand behind this signal, or null when it does. An
 * entry is never planned on a signal the analysis rates below the contract's
 * no-edge rate: timing cannot rescue a trade with no edge.
 */
function analysisRejection(evidence: EntryEvidence): string | null {
  const probability = evidence.signalProbability;
  if (probability !== null && probability < evidence.fairRate)
    return `${(probability * 100).toFixed(1)}% against the contract's ${(evidence.fairRate * 100).toFixed(1)}% no-edge rate`;
  return null;
}

/** Average absolute tick move, used when the caller has no estimate handy. */
export function typicalTickMove(prices: readonly number[]): number {
  const window = prices.slice(-250);
  let total = 0;
  for (let index = 1; index < window.length; index += 1) total += Math.abs(window[index] - window[index - 1]);
  return window.length > 1 ? total / (window.length - 1) : 0;
}

export type QuoteEntryRow = {
  /** Index of the tick the signal was taken on. */
  origin: number;
  /** Index of the tick its contract expired on. */
  exit: number;
};

export type QuoteEntryInput = {
  prices: readonly number[];
  epochs: readonly number[];
  /** Replayed signals that the same consensus rule fired on. */
  rows: readonly QuoteEntryRow[];
  /** 1 when the signal buys a rise, -1 when it buys a fall. */
  direction: 1 | -1;
  /** Average absolute tick move; measured from the prices when omitted. */
  averageMove?: number | null;
  /** Contract length in ticks (minute durations converted with the tick spacing). */
  horizonTicks: number;
  /** Exit tick index of every tick, when the caller has the exact mapping. */
  exits?: ArrayLike<number> | null;
  /** Win probability with no edge (flat outcomes removed); 0.5 when omitted. */
  fairRate?: number | null;
  /**
   * The analysis that produced the signal. Required, so every plan is traceable
   * to the engines, the AI and the probability the analysis put on the trade.
   */
  signal: EntrySignalContext;
};

type RowStats = {
  origin: number;
  exit: number;
  /** Worst excursion against the signal inside the scanned horizon (≥ 0). */
  adverse: number;
  /** Best excursion with the signal inside the scanned horizon (≥ 0). */
  favourable: number;
};

function sampleRows(rows: readonly QuoteEntryRow[], limit: number): QuoteEntryRow[] {
  const usable = rows.filter((row) => Number.isFinite(row.origin) && Number.isFinite(row.exit) && row.exit > row.origin);
  if (usable.length <= limit) return [...usable];
  const stride = usable.length / limit;
  const sampled: QuoteEntryRow[] = [];
  for (let index = 0; index < limit; index += 1) sampled.push(usable[Math.floor(index * stride)]);
  return sampled;
}

/** One replayed signal and where its trigger (if any) fired. */
type RowPlan = {
  origin: number;
  /** Index the trigger fired on, or -1 when it never fired inside the scan. */
  trigger: number;
  /** Ticks between the signal and the trigger, -1 when it never fired. */
  wait: number;
  /** Wall-clock wait of the trigger, -1 when unknown. */
  waitedMs: number;
  /**
   * How far past the level the quote printed when the trigger fired (≥ 0).
   * This is the slippage the replay actually saw, and it sets the plan's
   * no-chase tolerance.
   */
  overshoot: number;
};

type CandidateAssessment = {
  side: 'adverse' | 'favourable';
  depth: number;
  rows: RowPlan[];
  /** Wait ticks of the rows whose trigger fired at all. */
  waits: number[];
  triggered: number;
  sample: number;
};

type PolicyAssessment = {
  /** Rows whose trigger fired inside the window. */
  reached: number;
  /** Rows that reached the trigger divided by every replayed row. */
  reachRate: number;
  /** Wait ticks of the entries that fired inside the window. */
  waitTicks: number[];
  /** Wall-clock waits of the same entries. */
  waits: number[];
  settled: number;
  wins: number;
  baselineSettled: number;
  baselineWins: number;
  improved: number;
  worsened: number;
  /** Win rate of the entry policy (wait for the trigger, else enter at market). */
  policyRate: number;
  /** Win rate of buying every replayed signal at the signal tick. */
  baselineRate: number;
  /** Points the policy added over buying at the signal. */
  gainPts: number;
};

/**
 * Finds the trigger of one candidate on every replayed signal.
 *
 * `adverse` candidates wait for the price to move against the signal (a
 * pullback for a rise) and fire the moment the level is touched. `favourable`
 * candidates wait for a continuation and are invalidated when the price moves
 * past the reference counter-move first.
 */
function assessTrigger(
  input: {
    prices: readonly number[];
    epochs: readonly number[];
    rows: readonly RowStats[];
    direction: 1 | -1;
    side: 'adverse' | 'favourable';
    depth: number;
    stopDepth: number | null;
  },
): CandidateAssessment {
  const { prices, epochs, rows, direction, side, depth } = input;
  const stopDepth = input.stopDepth;
  const tolerance = depth * 0.02;
  const last = prices.length - 1;
  const plans: RowPlan[] = [];
  const waits: number[] = [];
  let triggered = 0;

  for (const row of rows) {
    const scanEnd = Math.min(row.exit, last, row.origin + ENTRY_LIMITS.scanTicks);
    let trigger = -1;
    let stopped = -1;
    for (let index = row.origin + 1; index <= scanEnd; index += 1) {
      const excursion = direction * (prices[index] - prices[row.origin]);
      if (trigger < 0) {
        if (side === 'adverse' ? excursion <= -depth + tolerance : excursion >= depth - tolerance) trigger = index;
      }
      if (stopDepth !== null && stopped < 0 && excursion <= -stopDepth) stopped = index;
      if (trigger >= 0 && (stopDepth === null || stopped >= 0)) break;
    }
    if (trigger >= 0 && stopDepth !== null && stopped >= 0 && stopped < trigger) trigger = -1;
    if (trigger >= 0) {
      triggered += 1;
      waits.push(trigger - row.origin);
    }
    plans.push({
      origin: row.origin,
      trigger,
      wait: trigger >= 0 ? trigger - row.origin : -1,
      waitedMs: trigger >= 0 ? epochGapMs(epochs[row.origin], epochs[trigger]) : -1,
      overshoot:
        trigger >= 0
          ? Math.max(0, (side === 'adverse' ? -1 : 1) * (prices[trigger] - prices[row.origin]) - depth)
          : 0,
    });
  }

  return { side, depth, rows: plans, waits, triggered, sample: rows.length };
}

/** Outcome of the contract entered on `entryIndex` (0 win/loss, null unknown). */
function outcomeAt(
  input: { prices: readonly number[]; exits?: ArrayLike<number> | null; direction: 1 | -1; horizonTicks: number },
  entryIndex: number,
  lastIndex: number,
): 1 | 0 | null {
  if (entryIndex < 0 || entryIndex >= lastIndex) return null;
  const mapped = input.exits ? input.exits[entryIndex] ?? -1 : -1;
  const exitIndex = mapped > entryIndex ? mapped : entryIndex + input.horizonTicks <= lastIndex ? entryIndex + input.horizonTicks : -1;
  if (exitIndex <= entryIndex) return null;
  const move = sign(input.prices[exitIndex] - input.prices[entryIndex]);
  if (move === 0) return null;
  return move === input.direction ? 1 : 0;
}

/**
 * Measures the whole entry policy on the replay, not just the signals that
 * happened to reach the level: when the trigger fires inside the window the
 * trade is taken on it, otherwise the bot buys at market when the window
 * closes — exactly what the bot does with the "follow the analysis" setting.
 * The policy is compared against buying every signal at the signal tick, so a
 * level only earns a plan when waiting actually beat not waiting.
 */
function assessPolicy(
  input: {
    prices: readonly number[];
    exits?: ArrayLike<number> | null;
    direction: 1 | -1;
    horizonTicks: number;
  },
  candidate: CandidateAssessment,
  windowTicks: number,
): PolicyAssessment {
  const lastIndex = input.prices.length - 1;
  const waitTicks: number[] = [];
  const waits: number[] = [];
  let reached = 0;
  let settled = 0;
  let wins = 0;
  let baselineSettled = 0;
  let baselineWins = 0;
  let improved = 0;
  let worsened = 0;

  for (const row of candidate.rows) {
    const insideWindow = row.trigger >= 0 && row.wait <= windowTicks;
    const entryIndex = insideWindow ? row.trigger : Math.min(row.origin + windowTicks, lastIndex);
    if (insideWindow) {
      reached += 1;
      waitTicks.push(row.wait);
      if (row.waitedMs >= 0) waits.push(row.waitedMs);
    }
    const policy = outcomeAt(input, entryIndex, lastIndex);
    const baseline = outcomeAt(input, row.origin, lastIndex);
    if (policy === null || baseline === null) continue;
    settled += 1;
    baselineSettled += 1;
    wins += policy;
    baselineWins += baseline;
    if (policy > baseline) improved += 1;
    else if (baseline > policy) worsened += 1;
  }

  const policyRate = settled ? wins / settled : 0;
  const baselineRate = baselineSettled ? baselineWins / baselineSettled : 0;
  return {
    reached,
    reachRate: candidate.sample ? reached / candidate.sample : 0,
    waitTicks,
    waits,
    settled,
    wins,
    baselineSettled,
    baselineWins,
    improved,
    worsened,
    policyRate,
    baselineRate,
    gainPts: (policyRate - baselineRate) * 100,
  };
}

/**
 * The window has to cover the waits the triggers actually produced: past it the
 * signal is no longer the one the analysis scored and the bot falls back.
 */
function windowTicksFor(waits: readonly number[], horizonTicks: number): number {
  const wide = percentile(waits, WAIT_WINDOW_PERCENTILE) ?? 0;
  const expected = median(waits) ?? 0;
  const cap = clamp(Math.round(horizonTicks * 2), ENTRY_LIMITS.windowTicks.min, ENTRY_LIMITS.windowTicks.max);
  return Math.round(clamp(Math.max(wide + 2, expected + 1), ENTRY_LIMITS.windowTicks.min, cap));
}

function describeRates(policy: PolicyAssessment): string {
  if (!policy.settled) return 'the replay produced no settled outcomes for it';
  return `waiting for the level and entering on it (or at market when it never comes) won ${(policy.policyRate * 100).toFixed(1)}% of ${policy.settled} replayed signals against ${(policy.baselineRate * 100).toFixed(1)}% for buying every signal at once`;
}

function usableCandidate(
  policy: PolicyAssessment,
  fairRate: number,
): boolean {
  return (
    policy.reached >= ENTRY_LIMITS.minSample &&
    policy.reachRate >= ENTRY_LIMITS.minReach &&
    policy.gainPts >= ENTRY_LIMITS.minEdgePts &&
    policy.settled >= ENTRY_LIMITS.minSample
  );
}

/**
 * Rise/Fall entry: the bot waits for the typical adverse excursion (a pullback
 * for a rise, a bounce for a fall) or for the typical favourable excursion (a
 * continuation breakout), whichever the replay says actually added win rate.
 */
export function analyzeQuoteEntry(input: QuoteEntryInput): EntryPlan {
  const prices = input.prices;
  const rows = sampleRows(input.rows, ENTRY_LIMITS.maxSample);
  const referenceQuote = prices.at(-1) ?? null;
  const fairRate = clamp(
    input.fairRate !== null && input.fairRate !== undefined && input.fairRate > 0 && input.fairRate < 1
      ? input.fairRate
      : 0.5,
    0.05,
    0.95,
  );
  const evidence = buildEvidence(input.signal, fairRate);
  if (rows.length < ENTRY_LIMITS.minSample) {
    return immediateEntryPlan({
      reason: `Only ${rows.length} replayed signals were available, so the bot enters at the next tick instead of guessing a level.`,
      sample: rows.length,
      confidence: 35,
      evidence,
    });
  }
  const averageMove = input.averageMove && input.averageMove > 0 ? input.averageMove : typicalTickMove(prices);
  if (!(averageMove > 0)) {
    return immediateEntryPlan({
      reason: 'The market printed no measurable tick movement, so there is no entry point to wait for.',
      sample: rows.length,
      confidence: 35,
      evidence,
    });
  }
  const horizonTicks = clamp(Math.round(input.horizonTicks) || 1, 1, 3_000);
  const direction = input.direction;

  // Model-driven timing first. When the level-reversion fit validates a stretch
  // window, that IS the entry: it is the same equilibrium the analysis layer
  // published, measured on the same replayed signals. The excursion percentiles
  // below remain the fallback for markets with no measurable equilibrium.
  const levelPlan = analyzeLevelEntry({
    ...input,
    fairRate,
    averageMove,
    referenceQuote,
    horizonTicks,
    evidence,
  });
  if (levelPlan) return levelPlan;

  // Pass 1 — how far the price travelled against and with each replayed signal.
  const stats: RowStats[] = [];
  for (const row of rows) {
    const scanEnd = Math.min(row.exit, prices.length - 1, row.origin + ENTRY_LIMITS.scanTicks);
    let adverse = 0;
    let favourable = 0;
    for (let index = row.origin + 1; index <= scanEnd; index += 1) {
      const excursion = direction * (prices[index] - prices[row.origin]);
      if (-excursion > adverse) adverse = -excursion;
      if (excursion > favourable) favourable = excursion;
    }
    stats.push({ origin: row.origin, exit: row.exit, adverse, favourable });
  }

  const minDepth = ENTRY_LIMITS.minDepthRatio * averageMove;
  // Walk-forward split: the level and window are chosen on the older 60% of the
  // replay and only accepted when they hold on the newer 40%. This is the
  // difference between a measured entry and a curve-fitted one.
  const split = Math.floor(stats.length * 0.6);
  const selectionStats = stats.slice(0, split);
  const validationStats = stats.slice(split);
  const canValidate = validationStats.length >= ENTRY_LIMITS.minValidationSample;
  const adverseDepths = selectionStats.map((row) => row.adverse).filter((depth) => depth > 0);
  const favourableDepths = selectionStats.map((row) => row.favourable).filter((depth) => depth > 0);
  const pullbackDepths = PULLBACK_PERCENTILES.map((fraction) => percentile(adverseDepths, fraction))
    .filter((depth): depth is number => depth !== null && depth >= minDepth);
  const breakoutDepths = BREAKOUT_PERCENTILES.map((fraction) => percentile(favourableDepths, fraction))
    .filter((depth): depth is number => depth !== null && depth >= minDepth);
  const shallowestPullback = pullbackDepths.length ? Math.min(...pullbackDepths) : minDepth;
  const candidateSpecs: Array<{
    side: 'adverse' | 'favourable';
    depth: number;
    stopDepth: number | null;
  }> = [];
  const seen = new Set<string>();
  for (const depth of pullbackDepths) {
    const key = `a:${depth.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidateSpecs.push({ side: 'adverse', depth, stopDepth: null });
  }
  for (const depth of breakoutDepths) {
    const key = `f:${depth.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidateSpecs.push({ side: 'favourable', depth, stopDepth: Math.max(minDepth, shallowestPullback) });
  }

  const assessed = candidateSpecs.map((spec) => {
    const selectionTrigger = assessTrigger({
      ...input,
      rows: selectionStats,
      side: spec.side,
      depth: spec.depth,
      stopDepth: spec.stopDepth,
    });
    const windowTicks = windowTicksFor(selectionTrigger.waits, horizonTicks);
    const selectionPolicy = assessPolicy(input, selectionTrigger, windowTicks);
    const validationTrigger = canValidate
      ? assessTrigger({
          ...input,
          rows: validationStats,
          side: spec.side,
          depth: spec.depth,
          stopDepth: spec.stopDepth,
        })
      : null;
    const validationPolicy = validationTrigger ? assessPolicy(input, validationTrigger, windowTicks) : null;
    const overshoots = validationTrigger
      ? validationTrigger.rows.filter((row) => row.trigger >= 0).map((row) => row.overshoot)
      : selectionTrigger.rows.filter((row) => row.trigger >= 0).map((row) => row.overshoot);
    const tolerance = clamp(
      Math.max(averageMove * 0.5, percentile(overshoots, 0.9) ?? 0),
      averageMove * 0.1,
      spec.depth * 0.5,
    );
    const validation = validationPolicy
      ? validationReport(validationPolicy, fairRate)
      : null;
    return { candidate: selectionTrigger, windowTicks, selectionPolicy, validationPolicy, validation, tolerance };
  });

  // Selection gates use a minimum that scales with the split: with 40+ rows a
  // 60/40 split still has to show dozens of reached triggers, not five.
  const selectionMin = Math.min(
    ENTRY_LIMITS.minSample,
    Math.max(20, Math.round(selectionStats.length * 0.35)),
  );
  // The selection slice picks the depth by its absolute policy win rate; the
  // newer slice then has to show that waiting beat buying at the signal. The
  // depth is never chosen on the slice that scores it.
  const selectionPass = (policy: PolicyAssessment): boolean =>
    policy.reached >= selectionMin &&
    policy.reachRate >= ENTRY_LIMITS.minReach &&
    policy.settled >= selectionMin &&
    policy.policyRate >= fairRate;
  // Absolute edge is the analysis layer's job: `analysisRejection` already
  // refuses a signal rated below fair.
  const rejection = analysisRejection(evidence);
  const promising = assessed.filter((item) => {
    if (rejection !== null) return false;
    if (!selectionPass(item.selectionPolicy)) return false;
    if (canValidate) return item.validation !== null && item.validation.passed;
    // Not enough newer rows to hold out a validation slice. The old gates still
    // apply, and the plan is explicitly marked in-sample.
    return usableCandidate(item.selectionPolicy, fairRate);
  });

  if (!promising.length) {
    const best = [...assessed].sort(
      (left, right) => right.selectionPolicy.policyRate - left.selectionPolicy.policyRate,
    )[0];
    // The level the price usually returns to, for the explanation only.
    const reached = [...assessed]
      .filter(
        (item) =>
          item.selectionPolicy.reached >= selectionMin &&
          item.selectionPolicy.reachRate >= ENTRY_LIMITS.minReach,
      )
      .sort((left, right) => right.selectionPolicy.reachRate - left.selectionPolicy.reachRate)[0];
    const reachedNote = reached
      ? ` The ${reached.candidate.side === 'adverse' ? 'pullback' : 'breakout'} level itself was reached by ${Math.round(reached.selectionPolicy.reachRate * 100)}% of the selection signals inside ${reached.windowTicks} ticks, but being reached is not the same as winning more often.`
      : '';
    let reason = `Replayed ${rows.length} signals and found no price level that improved the win rate, so the bot enters at the next tick.${reachedNote}`;
    if (rejection !== null)
      reason = `The analysis rates this signal at ${rejection}, so there is no edge to time and the bot enters at the next tick.`;
    else if (best && canValidate && best.validation && !best.validation.passed)
      reason = `Replayed ${rows.length} signals: the best ${best.candidate.side === 'adverse' ? 'pullback' : 'breakout'} level was chosen on the older ${selectionStats.length} signals but did not hold on the newer ${validationStats.length} (${(best.validation.rate * 100).toFixed(1)}% win rate at a ${(fairRate * 100).toFixed(1)}% no-edge rate, ${best.validation.gainPts >= 0 ? '+' : ''}${best.validation.gainPts.toFixed(1)} points against buying at the signal), so the bot enters at the next tick.${reachedNote}`;
    else if (best) {
      const policy = canValidate && best.validationPolicy ? best.validationPolicy : best.selectionPolicy;
      if (policy.baselineRate < fairRate)
        reason = `Replayed ${rows.length} signals: buying at the signal only won ${(policy.baselineRate * 100).toFixed(1)}%, below this contract's ${(fairRate * 100).toFixed(1)}% no-edge rate, so waiting cannot add a timing edge — the bot enters at the next tick.${reachedNote}`;
      else if (policy.policyRate < fairRate)
        reason = `Replayed ${rows.length} signals: entering on the ${best.candidate.side === 'adverse' ? 'typical pullback' : 'typical breakout'} level won only ${(policy.policyRate * 100).toFixed(1)}%, below this contract's ${(fairRate * 100).toFixed(1)}% no-edge rate, so the bot enters at the next tick.${reachedNote}`;
      else if (policy.gainPts < ENTRY_LIMITS.minEdgePts)
        reason = `Replayed ${rows.length} signals: waiting at the ${best.candidate.side === 'adverse' ? 'typical pullback' : 'typical breakout'} level did not beat buying at the signal (${describeRates(policy)}), so the bot enters at the next tick.${reachedNote}`;
      else
        reason = `Replayed ${rows.length} signals: no entry level was reached often enough to be worth waiting for, so the bot enters at the next tick.${reachedNote}`;
    }
    return immediateEntryPlan({ reason, sample: rows.length, evidence });
  }

  const best = [...promising].sort(
    (left, right) =>
      right.selectionPolicy.policyRate - left.selectionPolicy.policyRate ||
      right.selectionPolicy.gainPts - left.selectionPolicy.gainPts,
  )[0];
  const { candidate, windowTicks } = best;
  const policy = canValidate && best.validationPolicy ? best.validationPolicy : best.selectionPolicy;
  const mode: EntryMode = candidate.side === 'adverse' ? 'pullback' : 'breakout';
  const expectedWaitTicks = Math.round(median(policy.waitTicks) ?? 0);
  const expectedWaitMs = Math.max(0, Math.round(median(policy.waits) ?? expectedWaitTicks * 1_000));
  const confidence = entryConfidence({ improved: policy.improved, worsened: policy.worsened, sample: policy.settled });
  const priceCondition: 'above' | 'below' =
    candidate.side === 'adverse' ? (direction === 1 ? 'below' : 'above') : direction === 1 ? 'above' : 'below';
  const distance = candidate.depth;
  const priceLevel =
    referenceQuote === null ? null : priceCondition === 'below' ? referenceQuote - distance : referenceQuote + distance;
  const level = `${priceText(distance)} (${(distance / averageMove).toFixed(1)} average ticks)`;
  const splitNote = canValidate
    ? `the level and window were chosen on the older ${selectionStats.length} signals and confirmed on the newer ${validationStats.length}: `
    : `too few signals to hold out a validation slice, so this is measured in-sample on ${selectionStats.length} signals: `;
  const replayNote = `${splitNote}the entry must fire within ${windowTicks} ticks: ${Math.round(policy.reachRate * 100)}% got there, in a median of ${expectedWaitTicks} tick${expectedWaitTicks === 1 ? '' : 's'}${expectedWaitMs > 0 ? ` (~${(expectedWaitMs / 1_000).toFixed(1)}s)` : ''}, and ${describeRates(policy)} (fair ${(fairRate * 100).toFixed(1)}%).`;
  const noChase = `The quote must not gap more than ${priceText(best.tolerance)} past the level, or the entry is missed rather than chased.`;
  const detail =
    mode === 'pullback'
      ? `Waits for the price to pull ${level} against the signal before buying the ${direction === 1 ? 'rise' : 'fall'}, and buys at the market price if the level never arrives before the window closes — ${replayNote} ${noChase}`
      : `Waits for the price to break ${level} further in the signal's direction (a continuation entry) before buying, and buys at the market price if the level never arrives before the window closes — ${replayNote} ${noChase}`;

  return {
    mode,
    trigger: 'quote',
    label: mode === 'pullback' ? 'Pullback entry' : 'Breakout entry',
    detail,
    priceLevel,
    priceCondition,
    distance,
    referenceQuote,
    contextDigits: null,
    contextLabel: null,
    windowTicks,
    expectedWaitTicks,
    expectedWaitMs,
    reachRate: policy.reachRate,
    edgeGainPts: Math.round(policy.gainPts * 10) / 10,
    sample: rows.length,
    confidence,
    tolerance: best.tolerance,
    validation: best.validation ?? {
      sample: policy.settled,
      gainPts: policy.gainPts,
      reachRate: policy.reachRate,
      rate: policy.policyRate,
      fairRate,
      passed: false,
      phase: 'in-sample',
    },
    fill: 'limit-with-tolerance',
    measured: true,
    evidence,
  };
}

/** Out-of-sample report for one candidate's entry policy. */
function validationReport(policy: PolicyAssessment, fairRate: number): EntryValidation {
  const passed =
    policy.settled >= ENTRY_LIMITS.minValidationSample &&
    policy.reached >= ENTRY_LIMITS.minValidationSample &&
    policy.reachRate >= ENTRY_LIMITS.minReach &&
    policy.gainPts >= ENTRY_LIMITS.minEdgePts;
  return {
    sample: policy.settled,
    gainPts: policy.gainPts,
    reachRate: policy.reachRate,
    rate: policy.policyRate,
    fairRate,
    passed,
    phase: 'out-of-sample',
  };
}

export type DigitEntryInput = {
  /** Digits in chronological order, one per tick. */
  digits: readonly number[];
  /** Epoch (ms) of each digit's tick, aligned with `digits`. */
  epochs: readonly number[];
  /** Contract length in ticks. */
  horizon: number;
  /** True when the contract wins on the digit printed at its exit tick. */
  wins: (digit: number) => boolean;
  /** Even/Odd reads the tick's parity; every other family reads the digit. */
  context?: 'digit' | 'parity';
  /** Win probability with no edge (0.5 for Even/Odd, the barrier odds otherwise). */
  fairRate?: number | null;
  /**
   * The analysis that produced the contract signal. Required, so a context
   * entry always carries the engines and the probability behind it.
   */
  signal: EntrySignalContext;
};

type DigitContextStats = { hits: number; sample: number };

/**
 * Entry timing from the level-reversion model (Layer 1's equilibrium fit).
 *
 * The excursion-percentile replay above answers "how far does price usually
 * pull back". This answers a different and more direct question: the analysis
 * already measured WHERE the price is relative to its fitted equilibrium and
 * how strong the pull is. Entering while the price sits far from equilibrium
 * wins materially more often than entering at an arbitrary tick, so the entry
 * engine re-measures that stretch on the older replay rows, confirms it on the
 * newer ones, and then either fires now (already stretched) or waits for the
 * stretch to arrive at the model's own level.
 *
 * Measured on planted mean-reversion streams the win rate goes from ~62% (enter
 * anywhere) to ~72% at one stationary σ of stretch; on random walks the fit
 * never clears its unit-root bar, so no plan is produced at all.
 */
const LEVEL_STRETCH_GRID = [0.5, 0.75, 1, 1.25, 1.5] as const;
/** Smallest inside-sample a stretch rule may be selected on. */
const LEVEL_MIN_SELECTION = 20;
/** z the inside-vs-outside gap must clear on the newer rows. */
const LEVEL_VALIDATION_Z = 1.64;

type LevelStretchRow = {
  origin: number;
  /** Signed stretch in the favourable direction: > 0 means "already stretched". */
  stretch: number;
  /** Model level the price would have to reach to be stretched by `threshold`. */
  level: number | null;
  model: LevelReversionModel | null;
  /** Whether the trade won when entered at the origin. */
  won: 0 | 1;
  exit: number;
};

function levelStretchRows(
  prices: readonly number[],
  rows: readonly QuoteEntryRow[],
  direction: 1 | -1,
): LevelStretchRow[] {
  const result: LevelStretchRow[] = [];
  for (const row of rows) {
    if (row.origin < 120 || row.origin >= prices.length) continue;
    // Only ticks up to the origin: no look-ahead, exactly like the replay.
    const model = fitLevelReversion(prices.slice(0, row.origin + 1));
    const exit = Math.min(row.exit, prices.length - 1);
    if (exit <= row.origin) continue;
    const move = prices[exit] - prices[row.origin];
    if (move === 0) continue;
    const won = (sign(move) === direction ? 1 : 0) as 0 | 1;
    if (!model || !model.active) {
      result.push({ origin: row.origin, stretch: 0, level: null, model: null, won, exit });
      continue;
    }
    // Fading the stretch means buying the direction that the pull supports:
    // a RISE signal is favoured when the price sits BELOW equilibrium.
    const stretch = -direction * model.displacementZ;
    result.push({ origin: row.origin, stretch, level: null, model, won, exit });
  }
  return result;
}

function stretchRates(rows: readonly LevelStretchRow[], threshold: number): { insideHits: number; inside: number; outsideHits: number; outside: number } {
  let insideHits = 0;
  let inside = 0;
  let outsideHits = 0;
  let outside = 0;
  for (const row of rows) {
    if (!row.model) continue;
    if (row.stretch >= threshold) { inside += 1; insideHits += row.won; }
    else { outside += 1; outsideHits += row.won; }
  }
  return { insideHits, inside, outsideHits, outside };
}

function proportionZ(insideHits: number, inside: number, outsideHits: number, outside: number): number {
  if (inside < 2 || outside < 2) return 0;
  const pooled = (insideHits + outsideHits) / (inside + outside);
  const standardError = Math.sqrt(Math.max(1e-12, pooled * (1 - pooled)) * (1 / inside + 1 / outside));
  return standardError > 1e-12 ? (insideHits / inside - outsideHits / outside) / standardError : 0;
}

/**
 * How long the price took to reach the stretch level, and what the trade bought
 * at that point settled as. Rows already stretched wait zero ticks.
 */
function measureStretchReach(
  prices: readonly number[],
  epochs: readonly number[],
  rows: readonly LevelStretchRow[],
  direction: 1 | -1,
  threshold: number,
  horizonTicks: number,
): { reached: number; settled: number; wins: number; waits: number[]; waitedMs: number[] } {
  let reached = 0;
  let settled = 0;
  let wins = 0;
  const waits: number[] = [];
  const waitedMs: number[] = [];
  for (const row of rows) {
    if (!row.model) continue;
    const level = row.model.mean - direction * threshold * row.model.levelSigma;
    let index = -1;
    if (row.stretch >= threshold) index = row.origin;
    else {
      const stop = Math.min(prices.length - 1, row.origin + ENTRY_LIMITS.scanTicks);
      for (let cursor = row.origin + 1; cursor <= stop; cursor += 1) {
        // The price has to reach the stretched level (worse for the signal).
        if (direction === 1 ? prices[cursor] <= level : prices[cursor] >= level) { index = cursor; break; }
      }
    }
    if (index < 0) continue;
    reached += 1;
    const wait = index - row.origin;
    waits.push(wait);
    if (Number.isFinite(epochs[index]) && Number.isFinite(epochs[row.origin])) {
      const waited = epochs[index] - epochs[row.origin];
      if (Number.isFinite(waited) && waited >= 0) waitedMs.push(waited);
    }
    const exit = index + horizonTicks;
    if (exit >= prices.length) continue;
    const move = prices[exit] - prices[index];
    if (move === 0) continue;
    settled += 1;
    if (sign(move) === direction) wins += 1;
  }
  return { reached, settled, wins, waits, waitedMs };
}

function analyzeLevelEntry(input: QuoteEntryInput & {
  fairRate: number;
  averageMove: number;
  referenceQuote: number | null;
  horizonTicks: number;
  evidence: EntryEvidence;
}): EntryPlan | null {
  // Timing cannot rescue a trade the analysis does not rate.
  if (analysisRejection(input.evidence) !== null) return null;
  const live = fitLevelReversion(input.prices);
  if (!live || !live.active) return null;
  const direction = input.direction;
  const all = levelStretchRows(input.prices, input.rows, direction);
  const usable = all.filter((row) => row.model !== null);
  if (usable.length < ENTRY_LIMITS.minSample) return null;
  const split = Math.floor(all.length * 0.6);
  const selectionRows = all.slice(0, split);
  const validationRows = all.slice(split);
  const canValidate = validationRows.filter((row) => row.model !== null).length >= ENTRY_LIMITS.minValidationSample;

  // Pick the threshold on the older rows only: the shallowest stretch that
  // clears the no-edge rate on enough rows. Selection and scoring never share
  // a row.
  const selected = LEVEL_STRETCH_GRID
    .map((threshold) => ({ threshold, ...stretchRates(selectionRows, threshold) }))
    .filter((candidate) => candidate.inside >= LEVEL_MIN_SELECTION)
    .sort((left, right) => {
      const leftLift = left.insideHits / left.inside - input.fairRate;
      const rightLift = right.insideHits / right.inside - input.fairRate;
      if (Math.abs(leftLift - rightLift) > 0.01) return rightLift - leftLift;
      return left.threshold - right.threshold;
    })[0];
  if (!selected) return null;

  const check = canValidate ? stretchRates(validationRows, selected.threshold) : selected;
  const insideRate = check.inside > 0 ? check.insideHits / check.inside : 0;
  const outsideRate = check.outside > 0 ? check.outsideHits / check.outside : 0;
  const z = proportionZ(check.insideHits, check.inside, check.outsideHits, check.outside);
  const baselineRate = check.inside + check.outside > 0 ? (check.insideHits + check.outsideHits) / (check.inside + check.outside) : 0;
  const gainPts = (insideRate - baselineRate) * 100;
  const validation = {
    sample: check.inside + check.outside,
    gainPts,
    reachRate: check.inside / Math.max(1, check.inside + check.outside),
    rate: insideRate,
    fairRate: input.fairRate,
    passed: check.inside >= LEVEL_MIN_SELECTION && insideRate >= input.fairRate && z >= LEVEL_VALIDATION_Z && gainPts >= ENTRY_LIMITS.minEdgePts,
    phase: (canValidate ? 'out-of-sample' : 'in-sample') as 'out-of-sample' | 'in-sample',
  };
  if (!validation.passed) return null;

  const reach = measureStretchReach(input.prices, input.epochs, usable, direction, selected.threshold, input.horizonTicks);
  const liveStretch = -direction * live.displacementZ;
  const alreadyStretched = liveStretch >= selected.threshold;
  const level = live.mean - direction * selected.threshold * live.levelSigma;
  const sigmaText = `${selected.threshold.toFixed(2)}σ`;
  const rates = `${(insideRate * 100).toFixed(1)}% when the price was at least ${sigmaText} from equilibrium against ${(outsideRate * 100).toFixed(1)}% elsewhere (${(baselineRate * 100).toFixed(1)}% overall)`;
  const splitNote = canValidate
    ? `threshold chosen on the older ${selectionRows.filter((row) => row.model).length} replayed signals and confirmed on the newer ${validationRows.filter((row) => row.model).length}`
    : `measured in-sample on ${selectionRows.filter((row) => row.model).length} replayed signals`;

  if (alreadyStretched) {
    return {
      mode: 'immediate',
      trigger: 'immediate',
      label: 'Enter next tick',
      detail: `The quote is already ${liveStretch.toFixed(2)}σ from its ${live.halfLifeTicks === null ? 'fitted' : `${live.halfLifeTicks.toFixed(0)}-tick half-life`} equilibrium (${live.mean.toFixed(4)}), past the ${sigmaText} the replay needs: trades taken there won ${rates} — ${splitNote}, z ${z.toFixed(2)}. Entering at the next tick because waiting would mean waiting for a better price than the model says is required.`,
      priceLevel: null,
      priceCondition: null,
      distance: null,
      referenceQuote: null,
      contextDigits: null,
      contextLabel: null,
      windowTicks: ENTRY_LIMITS.windowTicks.min,
      expectedWaitTicks: 0,
      expectedWaitMs: 0,
      reachRate: null,
      edgeGainPts: Math.round(gainPts * 10) / 10,
      sample: all.length,
      confidence: entryConfidence({ improved: check.insideHits, worsened: check.inside - check.insideHits, sample: check.inside }),
      tolerance: Math.max(input.averageMove * 0.5, live.sigma),
      validation,
      fill: 'market',
      // No trigger to wait for: the replay's verdict is "fire now", and the
      // entry-plan invariant reserves `measured` for plans with a trigger.
      measured: false,
      evidence: input.evidence,
    };
  }

  const waits = reach.waits;
  const reaching = waits.length > 0 ? Math.min(1, reach.reached / Math.max(1, usable.length)) : 0;
  const expectedWaitTicks = Math.max(1, Math.round(median(waits) ?? 0));
  const expectedWaitMs = Math.max(0, Math.round(median(reach.waitedMs) ?? expectedWaitTicks * 1_000));
  const windowTicks = Math.round(clamp(
    (percentile(waits, WAIT_WINDOW_PERCENTILE) ?? expectedWaitTicks) + 2,
    ENTRY_LIMITS.windowTicks.min,
    ENTRY_LIMITS.windowTicks.max,
  ));
  const priceCondition: 'above' | 'below' = direction === 1 ? 'below' : 'above';
  return {
    mode: 'pullback',
    trigger: 'quote',
    label: 'Equilibrium entry',
    detail: `Waits for the quote to reach ${level.toFixed(4)} — ${sigmaText} below the ${live.mean.toFixed(4)} equilibrium the ${live.halfLifeTicks === null ? 'fit' : `${live.halfLifeTicks.toFixed(0)}-tick half-life`} fit measures — before buying the ${direction === 1 ? 'rise' : 'fall'}: trades taken at that stretch won ${rates}, ${splitNote}, z ${z.toFixed(2)}. ${Math.round(reaching * 100)}% of replayed signals reached it, in a median of ${expectedWaitTicks} tick${expectedWaitTicks === 1 ? '' : 's'}${expectedWaitMs > 0 ? ` (~${(expectedWaitMs / 1_000).toFixed(1)}s)` : ''}, inside ${windowTicks} ticks; the level is anchored to the equilibrium, so the bot never drags it along with the price.`,
    priceLevel: level,
    priceCondition,
    distance: input.referenceQuote === null ? null : Math.abs(input.referenceQuote - level),
    referenceQuote: input.referenceQuote,
    rebase: 'absolute',
    contextDigits: null,
    contextLabel: null,
    windowTicks,
    expectedWaitTicks,
    expectedWaitMs,
    reachRate: reaching,
    edgeGainPts: Math.round(gainPts * 10) / 10,
    sample: all.length,
    confidence: entryConfidence({ improved: check.insideHits, worsened: check.inside - check.insideHits, sample: check.inside }),
    tolerance: Math.max(input.averageMove * 2, live.sigma * 2),
    validation,
    fill: 'limit-with-tolerance',
    measured: true,
    evidence: input.evidence,
  };
}

/**
 * Digit entry: a digit contract settles on the exit tick's digit, so the quote
 * is not the entry decision — the tick context is ("enter on the tick right
 * after an even digit"). Contexts are picked on the older 60% of the ticks and
 * only kept when their lift survives on the newer 40%.
 */
export function analyzeDigitEntry(input: DigitEntryInput): EntryPlan {
  const { digits, epochs } = input;
  const length = Math.min(digits.length, epochs.length);
  const horizon = clamp(Math.round(input.horizon) || 1, 1, 10);
  const fairRate = clamp(
    input.fairRate !== null && input.fairRate !== undefined && input.fairRate > 0 && input.fairRate < 1
      ? input.fairRate
      : 0.5,
    0.02,
    0.95,
  );
  const evidence = buildEvidence(input.signal, fairRate);
  const contextMode = input.context ?? 'digit';
  const readContext = (index: number) => (contextMode === 'parity' ? digits[index] % 2 : digits[index]);
  // The entry tick is the first tick the bot can buy on after reading a
  // context tick, so the contract settles `horizon` ticks after it.
  const exitOf = (contextIndex: number) => contextIndex + 1 + horizon;
  const end = length - 1 - horizon;
  if (end <= 160) {
    return immediateEntryPlan({
      reason: `Only ${Math.max(0, end)} ticks were available to measure an entry context, so the bot enters at the next tick.`,
      sample: Math.max(0, end),
      confidence: 35,
      evidence,
    });
  }

  const bucketCount = contextMode === 'parity' ? 2 : 10;
  const start = Math.max(0, end - 1_800);
  const split = start + Math.floor((end - start) * 0.6);
  const selection = Array.from({ length: bucketCount }, (): DigitContextStats => ({ hits: 0, sample: 0 }));
  let selectionHits = 0;
  let selectionSample = 0;
  for (let index = start; index < split; index += 1) {
    const exitDigit = digits[exitOf(index)];
    const bucket = selection[readContext(index)];
    if (!bucket || !Number.isInteger(exitDigit) || exitDigit < 0 || exitDigit > 9) continue;
    const won = input.wins(exitDigit) ? 1 : 0;
    bucket.sample += 1;
    bucket.hits += won;
    selectionSample += 1;
    selectionHits += won;
  }
  if (selectionSample < 150) {
    return immediateEntryPlan({
      reason: `Only ${selectionSample} settled ticks were available to measure an entry context, so the bot enters at the next tick.`,
      sample: selectionSample,
      confidence: 35,
      evidence,
    });
  }

  const selectionRate = selectionHits / selectionSample;
  const chosen: number[] = [];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const stats = selection[bucket];
    if (stats.sample < 25) continue;
    const rate = stats.hits / stats.sample;
    // A context only survives when the lift is material AND the whole
    // confidence interval of its hit rate sits above the contract's own rate.
    // The interval uses a multiple-comparison z, because up to ten contexts
    // (and several scans) are inspected for every plan, so a lone lucky bucket
    // must not buy itself an entry rule.
    if (rate - selectionRate < CONTEXT_MIN_LIFT) continue;
    if (wilsonLowerBound(stats.hits, stats.sample, CONTEXT_SELECTION_Z) <= selectionRate) continue;
    chosen.push(bucket);
  }
  if (!chosen.length || chosen.length === bucketCount) {
    return immediateEntryPlan({
      reason: chosen.length
        ? 'Every digit context was equally good, so waiting for one adds nothing; the bot enters at the next tick.'
        : `Replayed ${selectionSample} ticks: no digit context beat this contract's overall hit rate with enough evidence, so the bot enters at the next tick.`,
      sample: selectionSample,
      evidence,
    });
  }

  // Validation slice: does the chosen context still win more often, and how
  // long does a matching tick take to arrive?
  const chosenSet = new Set(chosen);
  const nextMatch = new Int32Array(end).fill(-1);
  let lastMatch = -1;
  for (let index = end - 1; index >= split; index -= 1) {
    if (chosenSet.has(readContext(index))) lastMatch = index;
    nextMatch[index] = lastMatch;
  }
  let insideHits = 0;
  let insideSample = 0;
  let outsideHits = 0;
  let outsideSample = 0;
  const waitTicks: number[] = [];
  const waits: number[] = [];
  for (let index = split; index < end; index += 1) {
    const exitDigit = digits[exitOf(index)];
    if (!Number.isInteger(exitDigit) || exitDigit < 0 || exitDigit > 9) continue;
    const won = input.wins(exitDigit) ? 1 : 0;
    if (chosenSet.has(readContext(index))) {
      insideHits += won;
      insideSample += 1;
      waitTicks.push(0);
    } else {
      outsideHits += won;
      outsideSample += 1;
      const match = nextMatch[index];
      if (match >= 0) {
        waitTicks.push(match - index);
        const waited = epochs[match] - epochs[index];
        if (Number.isFinite(waited) && waited >= 0) waits.push(waited);
      }
    }
  }
  const insideRate = insideSample ? insideHits / insideSample : 0;
  const outsideRate = outsideSample ? outsideHits / outsideSample : 0;
  const edgeGainPts = (insideRate - outsideRate) * 100;
  const total = insideSample + outsideSample;
  const pooled = total ? (insideHits + outsideHits) / total : 0;
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, insideSample) + 1 / Math.max(1, outsideSample)));
  const validationZ = standardError > 0 ? (insideRate - outsideRate) / standardError : 0;
  // A context cannot rescue a contract the analysis itself does not rate: the
  // ensemble's own probability for this contract has to clear its no-edge rate.
  const rejection = analysisRejection(evidence);
  if (rejection !== null) {
    return immediateEntryPlan({
      reason: `The analysis rates this contract at ${rejection}, so the entry is not timed and the bot enters at the next tick.`,
      sample: total,
      evidence,
    });
  }
  if (
    insideSample < CONTEXT_MIN_VALIDATION_ROWS ||
    outsideSample < 25 ||
    edgeGainPts < CONTEXT_MIN_VALIDATION_PTS ||
    validationZ < CONTEXT_VALIDATION_Z ||
    // The context has to beat the contract's own no-edge rate, not just the
    // rest of the stream.
    insideRate < fairRate
  ) {
    return immediateEntryPlan({
      reason: `The digit context did not hold out of sample (${(insideRate * 100).toFixed(1)}% against ${(outsideRate * 100).toFixed(1)}% on ${total} held-out ticks), so the bot enters at the next tick.`,
      sample: total,
      evidence,
    });
  }

  const waitingWaits = waitTicks.filter((wait) => wait > 0);
  const windowTicks = Math.round(
    clamp(
      Math.max((percentile(waitingWaits, WAIT_WINDOW_PERCENTILE) ?? 0) + 2, (median(waitingWaits) ?? 0) + 1),
      ENTRY_LIMITS.contextWindowTicks.min,
      ENTRY_LIMITS.contextWindowTicks.max,
    ),
  );
  const immediateReady = waitTicks.filter((wait) => wait === 0).length;
  let insideWindow = immediateReady;
  for (const wait of waitingWaits) if (wait <= windowTicks) insideWindow += 1;
  const reachRate = total ? clamp(insideWindow / total, 0, 1) : null;
  const expectedWaitTicks = Math.round(median(waitingWaits) ?? 0);
  const expectedWaitMs = Math.max(0, Math.round(median(waits) ?? expectedWaitTicks * 1_000));
  const confidence = Math.round(clamp(50 + 50 * Math.tanh(validationZ / 2) * clamp(insideSample / 120, 0, 1), 0, 100));
  const contextDigits =
    contextMode === 'parity'
      ? Array.from({ length: 10 }, (_, digit) => digit).filter((digit) => chosenSet.has(digit % 2))
      : [...chosen].sort((left, right) => left - right);
  const readable = contextMode === 'parity' ? (chosen[0] === 0 ? 'an even digit' : 'an odd digit') : chosen.length === 1 ? `digit ${chosen[0]}` : `digits ${contextDigits.join(', ')}`;
  const contextLabel = `after ${readable}`;

  return {
    mode: 'context',
    trigger: 'digit',
    label: 'Context entry',
    detail: `Waits for the tick before the entry to print ${readable}: those contracts won ${(insideRate * 100).toFixed(1)}% against ${(outsideRate * 100).toFixed(1)}% elsewhere on ${total} held-out ticks. ${expectedWaitTicks <= 1 ? 'A matching tick is usually the next one' : `A matching tick turns up about every ${expectedWaitTicks} ticks (~${(expectedWaitMs / 1_000).toFixed(1)}s)`} and the entry is abandoned after ${windowTicks} ticks. Digit contracts settle on the exit tick's digit, so there is no price level to wait for.`,
    priceLevel: null,
    priceCondition: null,
    distance: null,
    referenceQuote: null,
    contextDigits,
    contextLabel,
    windowTicks,
    expectedWaitTicks,
    expectedWaitMs,
    reachRate,
    edgeGainPts: Math.round(edgeGainPts * 10) / 10,
    sample: total,
    confidence,
    tolerance: null,
    validation: {
      sample: total,
      gainPts: edgeGainPts,
      reachRate: reachRate ?? 0,
      rate: insideRate,
      fairRate,
      passed: true,
      phase: 'out-of-sample',
    },
    fill: 'context',
    measured: true,
    evidence,
  };
}

/**
 * Re-bases a price-level entry on the live quote so every bot run waits for the
 * same relative pullback (or breakout) the analysis measured, instead of an
 * absolute level that has gone stale. Immediate and context plans never change.
 */
export function rebaseEntryPlan(plan: EntryPlan, quote: number | null): EntryPlan {
  if (plan.trigger !== 'quote' || plan.distance === null || quote === null || !Number.isFinite(quote)) return plan;
  // An equilibrium-anchored level is absolute: the bot waits for the price to
  // come to the model's level, it never drags the level along with the price.
  if (plan.rebase === 'absolute') return { ...plan, referenceQuote: quote };
  return {
    ...plan,
    referenceQuote: quote,
    priceLevel: plan.priceCondition === 'below' ? quote - plan.distance : quote + plan.distance,
  };
}

/** Wall-clock window the bot gives an entry, from the plan and the tick spacing. */
export function effectiveWindowTicks(plan: EntryPlan): number {
  const measured = Number.isFinite(plan.windowTicks) ? Math.max(1, Math.round(plan.windowTicks)) : 1;
  const cap = Number.isFinite(plan.validForTicks)
    ? Math.max(1, Math.round(plan.validForTicks as number))
    : measured;
  return Math.max(1, Math.min(measured, cap));
}

/**
 * Wall-clock window the bot gives an entry, from the plan and the tick spacing.
 *
 * The Layer-6 validity cap is applied here, so a signal whose edge was measured
 * to survive for 4 ticks can never keep the bot waiting 12 ticks for a trigger
 * that the analysis no longer vouches for. With a one-tick window the deadline
 * is exactly one tick: the minimum window floor is only applied when the
 * validity allows it.
 */
export function entryWindowMs(plan: EntryPlan, tickSpacingMs: number): number {
  const spacing = Number.isFinite(tickSpacingMs) && tickSpacingMs > 0 ? tickSpacingMs : 1_000;
  const ticks = effectiveWindowTicks(plan);
  const expected = plan.expectedWaitMs > 0 ? plan.expectedWaitMs : plan.expectedWaitTicks * spacing;
  const scaled = expected * (ticks / Math.max(1, plan.expectedWaitTicks || 1));
  const capMs = ticks * spacing;
  // The floor is allowed to exceed the tick cap in wall-clock terms: the bot's
  // expiry check is the earlier of "ticks elapsed" and "deadline passed", so a
  // one-tick validity still expires after one tick even though no sensible UI
  // wants to show a sub-second window. Above the floor the window is capped by
  // the validity itself.
  const upperMs = Math.max(capMs, ENTRY_MIN_WINDOW_MS);
  return Math.round(clamp(
    Math.min(Math.max(scaled, capMs * 0.5), upperMs),
    ENTRY_MIN_WINDOW_MS,
    ENTRY_MAX_WINDOW_MS,
  ));
}

/** The bot's live check of one entry plan against the newest tick. */
export function evaluateEntry(plan: EntryPlan, observation: EntryObservation, state: EntryState): EntryEvaluation {
  const windowTicks = effectiveWindowTicks(plan);
  const remainingTicks = windowTicks - state.elapsedTicks;
  const remainingMs = state.deadline - state.now;
  const base = {
    elapsedTicks: state.elapsedTicks,
    remainingTicks: Math.max(0, remainingTicks),
    remainingMs: Math.max(0, remainingMs),
  };
  // An immediate entry has no trigger to wait for, so it is ready the moment it
  // is armed — the window only describes a wait that never happens.
  if (plan.trigger === 'immediate')
    return { ...base, status: 'ready', distance: null, reason: 'Entering at the signal price.' };
  if (remainingTicks <= 0 || remainingMs <= 0)
    return { ...base, status: 'expired', distance: null, reason: `The entry window closed after ${windowTicks} ticks.` };

  if (plan.trigger === 'digit') {
    const digits = plan.contextDigits ?? [];
    if (observation.digit === null || !Number.isInteger(observation.digit))
      return { ...base, status: 'waiting', distance: null, reason: 'Waiting for the next tick to print a digit.' };
    if (!digits.includes(observation.digit))
      return {
        ...base,
        status: 'waiting',
        distance: null,
        reason: `Waiting for ${plan.contextLabel ?? 'the entry context'} — the last tick printed ${observation.digit}.`,
      };
    return {
      ...base,
      status: 'ready',
      distance: null,
      reason: `Entering on the tick after ${plan.contextLabel ?? 'the matching digit'} (the last tick printed ${observation.digit}).`,
    };
  }

  if (observation.quote === null || !Number.isFinite(observation.quote))
    return { ...base, status: 'waiting', distance: null, reason: 'Waiting for a live quote.' };
  if (plan.priceLevel === null)
    return { ...base, status: 'waiting', distance: null, reason: 'Waiting for the entry level.' };
  const distance =
    plan.priceCondition === 'below' ? observation.quote - plan.priceLevel : plan.priceLevel - observation.quote;
  if (distance <= 0) {
    // A quote that prints far past the level is not the entry the replay
    // measured: the move arrived in one gap. Never chase it.
    const overshoot = -distance;
    if (plan.tolerance !== null && Number.isFinite(plan.tolerance) && overshoot > plan.tolerance)
      return {
        ...base,
        status: 'missed',
        distance: 0,
        reason: `The quote gapped ${priceText(overshoot)} past the entry level, more than the ${priceText(plan.tolerance)} the replay allowed, so this entry was not chased.`,
      };
    return {
      ...base,
      status: 'ready',
      distance: 0,
      reason: `Entering on the ${plan.mode} trigger: the quote reached the entry level after ${state.elapsedTicks} tick${state.elapsedTicks === 1 ? '' : 's'}.`,
    };
  }
  return {
    ...base,
    status: 'waiting',
    distance,
    reason: `Waiting for the quote to move ${plan.priceCondition === 'below' ? 'down' : 'up'} ${priceText(distance)} to the entry level.`,
  };
}

/** Ticks a market printed after `epoch`, capped so the scan stays cheap. */
export function ticksSince(ticks: readonly { epoch: number }[], epoch: number | null): number {
  if (epoch === null) return 0;
  let count = 0;
  for (let index = ticks.length - 1; index >= 0 && count < 500; index -= 1) {
    if (ticks[index].epoch <= epoch) break;
    count += 1;
  }
  return count;
}

/**
 * Convert an epoch gap to milliseconds.
 *
 * Deriv publishes tick epochs as Unix SECONDS (~1.7e9), while unit tests and
 * some adapters use milliseconds (~1.7e12). Treating a one-second gap as 1 ms
 * silently collapsed every wall-clock entry window and validity countdown by a
 * factor of 1000. The magnitude of the absolute epoch makes the unit
 * unambiguous: no plausible millisecond epoch is below 1e11.
 */
export function epochGapMs(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const scale = Math.abs(to) < 1e11 ? 1_000 : 1;
  return (to - from) * scale;
}

/** Median milliseconds between the feed's recent ticks for one market. */
export function medianTickSpacingMs(ticks: readonly { epoch: number }[], fallbackMs = 1_000): number {
  if (ticks.length < 3) return fallbackMs;
  const gaps: number[] = [];
  const scale = Math.abs(ticks[ticks.length - 1].epoch) < 1e11 ? 1_000 : 1;
  const from = Math.max(1, ticks.length - 60);
  for (let index = from; index < ticks.length; index += 1) {
    const gap = (ticks[index].epoch - ticks[index - 1].epoch) * scale;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return fallbackMs;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Short chip text for the signal card, e.g. "Pullback entry · within 8 ticks". */
export function entryModeLabel(plan: EntryPlan): string {
  if (plan.mode === 'immediate') return 'Entry next tick';
  if (plan.mode === 'context') return `Context entry · ${plan.contextLabel ?? 'digit context'}`;
  return `${plan.label} · within ${effectiveWindowTicks(plan)} tick${effectiveWindowTicks(plan) === 1 ? '' : 's'}`;
}

/**
 * Where the entry came from, in one line: the engines that produced the signal,
 * the AI's probability, the analysis's own rating against the contract's
 * no-edge rate, and the replay the level and window were measured on.
 */
export function describeEntryEvidence(plan: EntryPlan): string {
  const { evidence } = plan;
  const parts = [`${evidence.agreeing}/${evidence.total} engines agree`];
  if (evidence.aiProbability !== null) parts.push(`AI ${(evidence.aiProbability * 100).toFixed(1)}%`);
  if (evidence.confirmation)
    parts.push(
      `confirmation ${evidence.confirmation.status} (${evidence.confirmation.edgePts >= 0 ? '+' : ''}${evidence.confirmation.edgePts.toFixed(1)} pts edge${evidence.confirmation.decisive ? ', decisive' : ''})`,
    );
  if (evidence.signalProbability !== null)
    parts.push(`the analysis rates the trade ${(evidence.signalProbability * 100).toFixed(1)}% against a ${(evidence.fairRate * 100).toFixed(1)}% no-edge rate`);
  else parts.push(`no-edge rate ${(evidence.fairRate * 100).toFixed(1)}%`);
  parts.push(`${plan.sample} replayed signal${plan.sample === 1 ? '' : 's'}`);
  return `${parts.join(' · ')} — ${evidence.rule}`;
}

/** True when a plan carries the analysis provenance the bot requires. */
function isEntryEvidence(value: unknown): value is EntryEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<EntryEvidence>;
  return (
    (item.source === 'rise-fall' || item.source === 'digit') &&
    typeof item.agreeing === 'number' &&
    typeof item.total === 'number' &&
    typeof item.fairRate === 'number' &&
    Number.isFinite(item.fairRate) &&
    typeof item.rule === 'string'
  );
}

/**
 * One sentence the tools and the bot page can print as-is. `formatQuote` keeps
 * price formatting (precision) in the caller, so this stays pure.
 */
export function describeEntryPlan(
  plan: EntryPlan,
  formatQuote: (value: number) => string = (value) => priceText(value),
): string {
  if (plan.mode === 'immediate') return `Entry: next tick — ${plan.detail}`;
  if (plan.mode === 'context')
    return `Entry: ${plan.contextLabel ?? 'digit context'}${plan.expectedWaitTicks > 0 ? ` (usually within ~${plan.expectedWaitTicks} tick${plan.expectedWaitTicks === 1 ? '' : 's'})` : ' (usually the next tick)'} — ${plan.detail}`;
  const level = plan.priceLevel === null ? 'the reference price' : formatQuote(plan.priceLevel);
  return `Entry: wait for the quote to tick ${plan.priceCondition === 'below' ? 'down' : 'up'} to ${level} within ${plan.windowTicks} ticks (usually ~${plan.expectedWaitTicks} tick${plan.expectedWaitTicks === 1 ? '' : 's'}) — ${plan.detail}`;
}

/**
 * Guards restored or older analyses: a plan is only usable when it carries the
 * evidence of the run that produced it, so the bot can never trade an entry
 * that did not come out of an analysis.
 */
export function isEntryPlan(value: unknown): value is EntryPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<EntryPlan>;
  return (
    (plan.mode === 'immediate' || plan.mode === 'pullback' || plan.mode === 'breakout' || plan.mode === 'context') &&
    (plan.trigger === 'immediate' || plan.trigger === 'quote' || plan.trigger === 'digit') &&
    typeof plan.label === 'string' &&
    typeof plan.detail === 'string' &&
    typeof plan.windowTicks === 'number' &&
    Number.isFinite(plan.windowTicks) &&
    (plan.validForTicks === undefined || plan.validForTicks === null ||
      (typeof plan.validForTicks === 'number' && Number.isFinite(plan.validForTicks) && plan.validForTicks >= 1)) &&
    typeof plan.confidence === 'number' &&
    Number.isFinite(plan.confidence) &&
    typeof plan.measured === 'boolean' &&
    // Either the analysis measured a trigger to wait for, or it concluded the
    // trade is entered at the signal tick — there is no third state, so a plan
    // can never ask the bot to wait for something nothing measured.
    plan.measured === (plan.trigger !== 'immediate') &&
    isEntryEvidence(plan.evidence)
  );
}

/** Entry evidence tier used to colour the entry panel. */
export function entryTier(plan: EntryPlan): SignalStrength {
  if (plan.mode === 'immediate' || !plan.measured) return plan.confidence >= 60 ? 'MODERATE' : 'WEAK';
  if (plan.confidence >= 70 && (plan.edgeGainPts ?? 0) >= 2) return 'STRONG';
  if (plan.confidence >= 58) return 'MODERATE';
  return 'WEAK';
}
