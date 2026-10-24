// Types, defaults and sanitizers for the High/Low Tick hedging bot.
//
// A "hedged pair" is two Deriv High/Low Tick contracts bought on the same
// market at the same moment, in opposite directions:
//
//   * TICKHIGH — wins if the selected tick is the HIGHEST of the next five ticks;
//   * TICKLOW  — wins if the selected tick is the LOWEST of the next five ticks.
//
// Both contracts run for exactly five ticks, and each one names a tick position
// (1–5) that the bot either chooses from the replayed tick history or takes from
// the operator's manual selection.
import type { RiseFallAccountState } from '../rise-fall-bot/types.ts';

export type HedgeSide = 'HIGH' | 'LOW';
export type HedgeContractType = 'TICKHIGH' | 'TICKLOW';

export const HEDGE_CONTRACT_TYPES: Record<HedgeSide, HedgeContractType> = { HIGH: 'TICKHIGH', LOW: 'TICKLOW' };

export const HEDGE_SIDE_LABELS: Record<HedgeSide, string> = { HIGH: 'High Tick', LOW: 'Low Tick' };

/** Deriv's High/Low Tick contracts always settle on the next five ticks. */
export const HEDGE_WINDOW_TICKS = 5;

/** The tick positions a High/Low Tick contract can predict. */
export const HEDGE_TICK_POSITIONS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * Chance that a specific tick is the extreme of five i.i.d. ticks. Ties are not
 * counted as wins, so a tick-based sample never exceeds this on a random walk.
 */
export const HEDGE_BASELINE_RATE = 1 / HEDGE_WINDOW_TICKS;

export type HedgingBotMode = 'analysis' | 'live';

export type HedgingBotConfig = {
  /** Stake for each of the two legs, in account currency. */
  stakePerLeg: number;
  minStakePerLeg: number;
  maxStakePerLeg: number;
  /** Largest share of the live balance one pair may put at risk, in percent. */
  maxStakeShareOfBalance: number;

  /** Auto selects the tick position per leg from the replay; manual uses the two values below. */
  autoSelectTicks: boolean;
  manualHighTick: number;
  manualLowTick: number;
  /** Most recent verified ticks replayed to score the tick positions. */
  selectionTicks: number;
  /** Replay windows needed before automatic selection (and the EV gate) may rely on the sample. */
  minSelectionWindows: number;
  /** Auto selection needs the chosen position to beat the 20% baseline by at least this many standard errors. */
  minTickEdgeZ: number;
  /** Verified ticks collected before the first pair may be considered. */
  minTicksBeforeTrade: number;

  requirePositiveExpectedValue: boolean;
  /** Minimum expected value of the pair per unit staked, e.g. 0 = break even. */
  minExpectedValue: number;

  maxOpenPairs: number;
  /** 0 means unlimited pairs in one session. */
  maxPairsPerSession: number;
  maxConsecutiveLosingPairs: number;
  maxDailyLoss: number;
  dailyTakeProfit: number;
  /** 0 means the session has no time limit. */
  maxSessionMinutes: number;
  cooldownMs: number;

  decisionIntervalMs: number;
  maxTickAgeMs: number;
};

export function defaultHedgingBotConfig(): HedgingBotConfig {
  return {
    stakePerLeg: 1,
    minStakePerLeg: 0.35,
    maxStakePerLeg: 100,
    maxStakeShareOfBalance: 5,

    autoSelectTicks: true,
    manualHighTick: 1,
    manualLowTick: 5,
    selectionTicks: 500,
    minSelectionWindows: 200,
    minTickEdgeZ: 2,
    minTicksBeforeTrade: 120,

    // The selection is the trigger; the expected-value gate is the optional
    // brake. Leaving it on by default made every pair wait for a replay sample
    // it could not accumulate, so nothing was ever bought.
    requirePositiveExpectedValue: false,
    minExpectedValue: 0,

    maxOpenPairs: 1,
    maxPairsPerSession: 0,
    maxConsecutiveLosingPairs: 3,
    maxDailyLoss: 20,
    dailyTakeProfit: 20,
    maxSessionMinutes: 0,
    cooldownMs: 500,

    decisionIntervalMs: 500,
    maxTickAgeMs: 15_000,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback));
}

/** Rounds money to cents, the precision Deriv's stake field accepts. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Clamps every operator input into a range the engine can act on. A stored or
 * pasted value therefore cannot produce a zero window, a negative stake or an
 * unbounded exposure.
 */
export function sanitizeHedgingBotConfig(raw: Partial<HedgingBotConfig> | null | undefined): HedgingBotConfig {
  const base = defaultHedgingBotConfig();
  const input = raw ?? {};
  const minStakePerLeg = clampNumber(input.minStakePerLeg, 0.35, 1_000, base.minStakePerLeg);
  const maxStakePerLeg = clampNumber(input.maxStakePerLeg, minStakePerLeg, 1_000, base.maxStakePerLeg);
  return {
    stakePerLeg: roundMoney(clampNumber(input.stakePerLeg, minStakePerLeg, maxStakePerLeg, base.stakePerLeg)),
    minStakePerLeg,
    maxStakePerLeg,
    maxStakeShareOfBalance: clampNumber(input.maxStakeShareOfBalance, 0.1, 100, base.maxStakeShareOfBalance),

    autoSelectTicks: typeof input.autoSelectTicks === 'boolean' ? input.autoSelectTicks : base.autoSelectTicks,
    manualHighTick: clampInteger(input.manualHighTick, 1, 5, base.manualHighTick),
    manualLowTick: clampInteger(input.manualLowTick, 1, 5, base.manualLowTick),
    selectionTicks: clampInteger(input.selectionTicks, 50, 2_000, base.selectionTicks),
    minSelectionWindows: clampInteger(input.minSelectionWindows, 20, 1_500, base.minSelectionWindows),
    minTickEdgeZ: clampNumber(input.minTickEdgeZ, 0, 5, base.minTickEdgeZ),
    minTicksBeforeTrade: clampInteger(input.minTicksBeforeTrade, 20, 2_000, base.minTicksBeforeTrade),

    requirePositiveExpectedValue: typeof input.requirePositiveExpectedValue === 'boolean'
      ? input.requirePositiveExpectedValue
      : base.requirePositiveExpectedValue,
    minExpectedValue: clampNumber(input.minExpectedValue, -1, 10, base.minExpectedValue),

    maxOpenPairs: clampInteger(input.maxOpenPairs, 1, 5, base.maxOpenPairs),
    maxPairsPerSession: clampInteger(input.maxPairsPerSession, 0, 100_000, base.maxPairsPerSession),
    maxConsecutiveLosingPairs: clampInteger(input.maxConsecutiveLosingPairs, 1, 50, base.maxConsecutiveLosingPairs),
    maxDailyLoss: clampNumber(input.maxDailyLoss, 0, 1_000_000, base.maxDailyLoss),
    dailyTakeProfit: clampNumber(input.dailyTakeProfit, 0, 1_000_000, base.dailyTakeProfit),
    maxSessionMinutes: clampInteger(input.maxSessionMinutes, 0, 10_080, base.maxSessionMinutes),
    cooldownMs: clampInteger(input.cooldownMs, 0, 600_000, base.cooldownMs),

    decisionIntervalMs: clampInteger(input.decisionIntervalMs, 500, 60_000, base.decisionIntervalMs),
    maxTickAgeMs: clampInteger(input.maxTickAgeMs, 2_000, 120_000, base.maxTickAgeMs),
  };
}

/** One leg of a pair: a single TICKHIGH or TICKLOW contract. */
export type HedgeLegStatus = 'pending' | 'open' | 'won' | 'lost' | 'push' | 'closed' | 'rejected';

export type HedgeLeg = {
  side: HedgeSide;
  contractType: HedgeContractType;
  /** The tick position (1–5) this contract predicts. */
  tickPosition: number;
  contractId: number | null;
  stake: number;
  askPrice: number | null;
  payout: number | null;
  /** Historical rate at which this tick position was the extreme, when known. */
  historicalRate: number | null;
  status: HedgeLegStatus;
  profit: number | null;
  exitSpot: number | null;
  settledAt: number | null;
  longcode: string | null;
};

/**
 * `open` — both legs bought, not both settled. `settled` — every leg reported.
 * `partial` — one leg bought and then closed because its partner was refused.
 * `rejected` — nothing was bought. `unreconciled` — a purchase reply went missing.
 */
export type HedgePairStatus = 'open' | 'settled' | 'partial' | 'rejected' | 'unreconciled';

export type HedgePair = {
  id: string;
  at: number;
  symbol: string;
  mode: HedgingBotMode;
  status: HedgePairStatus;
  high: HedgeLeg;
  low: HedgeLeg;
  entrySpot: number | null;
  expectedValue: number | null;
  netProfit: number | null;
  balanceAfter: number | null;
  settledAt: number | null;
  note: string;
};

/** A pair the bot would have opened, scored later from the ticks that followed (analysis mode). */
export type HedgePrediction = {
  id: string;
  at: number;
  symbol: string;
  entryEpoch: number;
  entryQuote: number;
  highTick: number;
  lowTick: number;
  highRate: number | null;
  lowRate: number | null;
  resolved: boolean;
  expired: boolean;
  highWon: boolean | null;
  lowWon: boolean | null;
  resolvedAt: number | null;
};

export type HedgeDecisionAction = 'WAIT' | 'TRADE' | 'BLOCKED';

export type HedgeDecision = {
  id: string;
  at: number;
  symbol: string;
  mode: HedgingBotMode;
  action: HedgeDecisionAction;
  actionLabel: string;
  reasons: string[];
  reasonCodes: string[];
  highTick: number | null;
  lowTick: number | null;
  stake: number | null;
  executed: boolean;
  pairId: string | null;
  error: string | null;
};

export type HedgingAccountState = RiseFallAccountState;
