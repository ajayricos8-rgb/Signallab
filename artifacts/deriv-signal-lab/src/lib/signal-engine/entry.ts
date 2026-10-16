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

export type EntryTrigger = 'immediate' | 'quote' | 'digit';
export type EntryMode = 'immediate' | 'pullback' | 'breakout' | 'context';

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
  /** Context digits the tick before the entry must print (digit triggers only). */
  contextDigits: number[] | null;
  /** How to read those digits, e.g. "after an even digit". */
  contextLabel: string | null;
  /** The entry must happen inside this many ticks of the signal. */
  windowTicks: number;
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
   * True when the replay measured a win-rate gain for this trigger (and, for the
   * digit families, when the context survived its held-out slice). A plan with
   * `measured: false` is a structural level only: the bot follows it when the
   * trade menu's Entry setting says to wait for the level regardless.
   */
  measured: boolean;
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
  status: 'waiting' | 'ready' | 'expired';
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
  maxSample: 120,
  /** Most ticks a replay may scan forward for an entry trigger. */
  scanTicks: 120,
  /** Rows, reach and lift needed before a trigger is offered at all. */
  minSample: 40,
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

/** Pullback depth percentile: the level about 65% of replayed signals reached. */
const PULLBACK_PERCENTILE = 0.35;
/** Breakout depth percentile: above the noise of about 60% of replayed signals. */
const BREAKOUT_PERCENTILE = 0.4;
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
export function immediateEntryPlan(options: { reason: string; sample?: number; confidence?: number }): EntryPlan {
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
    measured: false,
  };
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
      waitedMs: trigger >= 0 ? epochs[trigger] - epochs[row.origin] : -1,
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
    policy.settled >= ENTRY_LIMITS.minSample &&
    // Timing is not a rescue: the signal must already have replay support and
    // the entry policy must clear the contract's no-edge rate on its own.
    policy.baselineRate >= fairRate &&
    policy.policyRate >= fairRate
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
  if (rows.length < ENTRY_LIMITS.minSample) {
    return immediateEntryPlan({
      reason: `Only ${rows.length} replayed signals were available, so the bot enters at the next tick instead of guessing a level.`,
      sample: rows.length,
      confidence: 35,
    });
  }
  const averageMove = input.averageMove && input.averageMove > 0 ? input.averageMove : typicalTickMove(prices);
  if (!(averageMove > 0)) {
    return immediateEntryPlan({
      reason: 'The market printed no measurable tick movement, so there is no entry point to wait for.',
      sample: rows.length,
      confidence: 35,
    });
  }
  const fairRate = clamp(
    input.fairRate !== null && input.fairRate !== undefined && input.fairRate > 0 && input.fairRate < 1
      ? input.fairRate
      : 0.5,
    0.05,
    0.95,
  );
  const horizonTicks = clamp(Math.round(input.horizonTicks) || 1, 1, 3_000);
  const direction = input.direction;

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
  const pullbackDepth = percentile(
    stats.map((row) => row.adverse).filter((depth) => depth > 0),
    PULLBACK_PERCENTILE,
  );
  const breakoutDepth = percentile(
    stats.map((row) => row.favourable).filter((depth) => depth > 0),
    BREAKOUT_PERCENTILE,
  );
  const candidates = [
    pullbackDepth !== null && pullbackDepth >= minDepth
      ? assessTrigger({ ...input, rows: stats, side: 'adverse', depth: pullbackDepth, stopDepth: null })
      : null,
    breakoutDepth !== null && breakoutDepth >= minDepth
      ? assessTrigger({
          ...input,
          rows: stats,
          side: 'favourable',
          depth: breakoutDepth,
          stopDepth: Math.max(minDepth, pullbackDepth ?? minDepth),
        })
      : null,
  ].filter((candidate): candidate is CandidateAssessment => candidate !== null);

  const assessed = candidates.map((candidate) => {
    const windowTicks = windowTicksFor(candidate.waits, horizonTicks);
    return { candidate, windowTicks, policy: assessPolicy(input, candidate, windowTicks) };
  });
  const promising = assessed.filter((item) => usableCandidate(item.policy, fairRate));
  // A level can be structurally useful (the price comes back to it most of the
  // time) without the replay confirming a win-rate gain. It is still reported,
  // flagged as unmeasured, and only traded when the Entry setting asks for it.
  const structural = [...assessed]
    .filter(
      (item) =>
        item.policy.reached >= ENTRY_LIMITS.minSample &&
        item.policy.reachRate >= ENTRY_LIMITS.minReach &&
        item.policy.waitTicks.length >= ENTRY_LIMITS.minSample,
    )
    .sort((left, right) => right.policy.reachRate - left.policy.reachRate)[0];

  if (!promising.length) {
    if (structural) {
      const { candidate, windowTicks, policy } = structural;
      const mode: EntryMode = candidate.side === 'adverse' ? 'pullback' : 'breakout';
      const expectedWaitTicks = Math.round(median(policy.waitTicks) ?? 0);
      const expectedWaitMs = Math.max(0, Math.round(median(policy.waits) ?? expectedWaitTicks * 1_000));
      const priceCondition: 'above' | 'below' =
        candidate.side === 'adverse' ? (direction === 1 ? 'below' : 'above') : direction === 1 ? 'above' : 'below';
      const distance = candidate.depth;
      const priceLevel =
        referenceQuote === null ? null : priceCondition === 'below' ? referenceQuote - distance : referenceQuote + distance;
      return {
        mode,
        trigger: 'quote',
        label: mode === 'pullback' ? 'Pullback level' : 'Breakout level',
        detail: `The replay measured no win-rate gain from waiting (${describeRates(policy)}, fair ${(fairRate * 100).toFixed(1)}%), but the ${mode === 'pullback' ? 'pullback' : 'breakout'} level is where the price usually goes: ${Math.round(policy.reachRate * 100)}% of the ${rows.length} replayed signals reached it, in a median of ${expectedWaitTicks} tick${expectedWaitTicks === 1 ? '' : 's'}${expectedWaitMs > 0 ? ` (~${(expectedWaitMs / 1_000).toFixed(1)}s)` : ''}, and the entry stays valid ${windowTicks} ticks. The trade menu's Entry setting decides whether the bot waits for it or buys at the signal price.`,
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
        confidence: entryConfidence({ improved: policy.improved, worsened: policy.worsened, sample: policy.settled }),
        measured: false,
      };
    }
    const best = [...assessed].sort((left, right) => right.policy.gainPts - left.policy.gainPts)[0];
    let reason = `Replayed ${rows.length} signals and found no price level worth waiting for, so the bot enters at the next tick.`;
    if (best) {
      if (best.policy.baselineRate < fairRate)
        reason = `Replayed ${rows.length} signals: buying at the signal only won ${(best.policy.baselineRate * 100).toFixed(1)}%, below this contract's ${(fairRate * 100).toFixed(1)}% no-edge rate, so waiting cannot add a timing edge — the bot enters at the next tick.`;
      else if (best.policy.policyRate < fairRate)
        reason = `Replayed ${rows.length} signals: entering on the ${best.candidate.side === 'adverse' ? 'typical pullback' : 'typical breakout'} level won only ${(best.policy.policyRate * 100).toFixed(1)}%, below this contract's ${(fairRate * 100).toFixed(1)}% no-edge rate, so the bot enters at the next tick.`;
      else if (best.policy.gainPts < ENTRY_LIMITS.minEdgePts)
        reason = `Replayed ${rows.length} signals: waiting at the ${best.candidate.side === 'adverse' ? 'typical pullback' : 'typical breakout'} level did not beat buying at the signal (${describeRates(best.policy)}), so the bot enters at the next tick.`;
      else
        reason = `Replayed ${rows.length} signals: the entry level was reached too rarely to be worth waiting for, so the bot enters at the next tick.`;
    }
    return immediateEntryPlan({ reason, sample: rows.length });
  }

  const best = [...promising].sort((left, right) => right.policy.gainPts - left.policy.gainPts)[0];
  const { candidate, windowTicks, policy } = best;
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
  const evidence = `the entry must fire within ${windowTicks} ticks: ${Math.round(policy.reachRate * 100)}% of the ${rows.length} replayed signals got there, in a median of ${expectedWaitTicks} tick${expectedWaitTicks === 1 ? '' : 's'}${expectedWaitMs > 0 ? ` (~${(expectedWaitMs / 1_000).toFixed(1)}s)` : ''}, and ${describeRates(policy)} (fair ${(fairRate * 100).toFixed(1)}%).`;
  const detail =
    mode === 'pullback'
      ? `Waits for the price to pull ${level} against the signal before buying the ${direction === 1 ? 'rise' : 'fall'}, and buys at the market price if the level never arrives before the window closes — ${evidence}`
      : `Waits for the price to break ${level} further in the signal's direction (a continuation entry) before buying, and buys at the market price if the level never arrives before the window closes — ${evidence}`;

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
    measured: true,
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
};

type DigitContextStats = { hits: number; sample: number };

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
  const fairRate = clamp(
    input.fairRate !== null && input.fairRate !== undefined && input.fairRate > 0 && input.fairRate < 1
      ? input.fairRate
      : 0.5,
    0.02,
    0.95,
  );
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
    measured: true,
  };
}

/**
 * Re-bases a price-level entry on the live quote so every bot run waits for the
 * same relative pullback (or breakout) the analysis measured, instead of an
 * absolute level that has gone stale. Immediate and context plans never change.
 */
export function rebaseEntryPlan(plan: EntryPlan, quote: number | null): EntryPlan {
  if (plan.trigger !== 'quote' || plan.distance === null || quote === null || !Number.isFinite(quote)) return plan;
  return {
    ...plan,
    referenceQuote: quote,
    priceLevel: plan.priceCondition === 'below' ? quote - plan.distance : quote + plan.distance,
  };
}

/** Wall-clock window the bot gives an entry, from the plan and the tick spacing. */
export function entryWindowMs(plan: EntryPlan, tickSpacingMs: number): number {
  const spacing = Number.isFinite(tickSpacingMs) && tickSpacingMs > 0 ? tickSpacingMs : 1_000;
  const expected = plan.expectedWaitMs > 0 ? plan.expectedWaitMs : plan.expectedWaitTicks * spacing;
  const scaled = expected * (plan.windowTicks / Math.max(1, plan.expectedWaitTicks || 1));
  return Math.round(clamp(Math.max(scaled, plan.windowTicks * spacing * 0.5), ENTRY_MIN_WINDOW_MS, ENTRY_MAX_WINDOW_MS));
}

/** The bot's live check of one entry plan against the newest tick. */
export function evaluateEntry(plan: EntryPlan, observation: EntryObservation, state: EntryState): EntryEvaluation {
  const remainingTicks = plan.windowTicks - state.elapsedTicks;
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
    return { ...base, status: 'expired', distance: null, reason: `The entry window closed after ${plan.windowTicks} ticks.` };

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
  if (distance <= 0)
    return {
      ...base,
      status: 'ready',
      distance: 0,
      reason: `Entering on the ${plan.mode} trigger: the quote reached the entry level after ${state.elapsedTicks} tick${state.elapsedTicks === 1 ? '' : 's'}.`,
    };
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

/** Median milliseconds between the feed's recent ticks for one market. */
export function medianTickSpacingMs(ticks: readonly { epoch: number }[], fallbackMs = 1_000): number {
  if (ticks.length < 3) return fallbackMs;
  const gaps: number[] = [];
  const from = Math.max(1, ticks.length - 60);
  for (let index = from; index < ticks.length; index += 1) {
    const gap = ticks[index].epoch - ticks[index - 1].epoch;
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
  return `${plan.label} · within ${plan.windowTicks} ticks`;
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

/** Guards restored or older analyses that predate the entry layer. */
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
    typeof plan.confidence === 'number' &&
    Number.isFinite(plan.confidence) &&
    typeof plan.measured === 'boolean'
  );
}

/** Entry evidence tier used to colour the entry panel. */
export function entryTier(plan: EntryPlan): SignalStrength {
  if (plan.mode === 'immediate' || !plan.measured) return plan.confidence >= 60 ? 'MODERATE' : 'WEAK';
  if (plan.confidence >= 70 && (plan.edgeGainPts ?? 0) >= 2) return 'STRONG';
  if (plan.confidence >= 58) return 'MODERATE';
  return 'WEAK';
}
