// Types, defaults and sanitizers for the Mafia bot.
//
// The Mafia bot is a TWO-SIDED Rise/Fall trader on Step indices. Each entry is
// a pair of 4-tick Rise/Fall contracts bought at the same moment on the same
// market, in opposite directions:
//
//   * the PRIMARY leg trades the direction the uniformity analysis measured;
//   * the COVER leg trades the other way, sized by `hedgeRatioPercent`.
//
// Because both legs open on the same tick and expire on the same tick, exactly
// one of them wins — unless the price ends where it started, in which case the
// window was flat and BOTH lose. The pair therefore has three outcomes, not
// two, and the bot prices all three from the live payouts:
//
//   primary wins → payoutPrimary − (stakePrimary + stakeCover)
//   cover wins   → payoutCover   − (stakePrimary + stakeCover)
//   flat         → −(stakePrimary + stakeCover)
//
// With equal stakes the first two are identical and always negative: a pair of
// opposite 4-tick RISE/FALL contracts is a bet that pays less than its cost.
// Sizing the two legs differently is what turns it into a position that can
// have positive expected value when the measured direction probability clears
// the pair's break-even rate — which the gate requires before it buys.
import type { RiseFallAccountState } from '../rise-fall-bot/types.ts';

export type MafiaDirection = 'CALL' | 'PUT';
export type MafiaLegSide = 'primary' | 'cover';
export type MafiaMode = 'analysis' | 'live';
/** How the primary stake is chosen for each pair. */
export type MafiaStakeMode = 'flat' | 'martingale' | 'fixed-fraction';
/** Which replay drives the probability the gate is measured against. */
export type MafiaProbabilitySource = 'conditional' | 'unconditional' | 'none';

/** The contract length. Every Mafia pair is four ticks: it was specified, and it is fixed here. */
export const MAFIA_DURATION_TICKS = 4;

export const MAFIA_DIRECTION_LABELS: Record<MafiaDirection, string> = {
  CALL: 'Rise (CALL)',
  PUT: 'Fall (PUT)',
};

export function oppositeDirection(direction: MafiaDirection): MafiaDirection {
  return direction === 'CALL' ? 'PUT' : 'CALL';
}

export type MafiaBotConfig = {
  /** Stake for the PRIMARY leg, in account currency. */
  primaryStake: number;
  minStake: number;
  maxStake: number;
  /**
   * COVER leg size as a percentage of the primary stake (10–100).
   *
   * The ratio is what decides whether a winning leg pays for both stakes. A leg
   * covers the pair when `payoutRatio × h > 1 + h`, i.e. `h > 1 / (m − 1)` for a
   * quoted payout multiple `m`: at Deriv's usual 4-tick quote (about 3×) any
   * cover above 50% pays for the pair, and 90% keeps both legs close to equal,
   * which is the cheapest hedge while the level-window risk is what it is.
   */
  hedgeRatioPercent: number;
  stakeMode: MafiaStakeMode;
  /** Multiplier applied per consecutive losing pair in `martingale` mode. */
  martingaleFactor: number;
  /** How many consecutive losses the martingale may compound over. */
  maxMartingaleSteps: number;
  /** Share of the live balance risked per pair in `fixed-fraction` mode. */
  fixedFractionPercent: number;
  /** Largest share of the live balance one pair may put at risk, in percent. */
  maxStakeShareOfBalance: number;

  /** Ticks analysed to decide whether the market has a uniform direction. */
  uniformityWindow: number;
  /** Minimum uniformity score (0–1) before a pair is considered. */
  minUniformity: number;
  /** Minimum z of both the directional share and sign persistence. */
  minUniformityZ: number;
  /** Verified ticks needed before the first pair. */
  minTicksBeforeTrade: number;
  /** Most recent ticks replayed to measure the 4-tick direction probability. */
  replayTicks: number;
  /** Replayed entries needed before the measured probability may be used. */
  minDirectionSamples: number;

  /** Require the measured pair expected value to clear `minExpectedValue`. */
  requirePositiveExpectedValue: boolean;
  /** Minimum pair expected value per unit staked, e.g. 0 = break even. */
  minExpectedValue: number;
  /**
   * Standard errors subtracted from the replayed probability before the gate
   * compares it with the pair's break-even. An in-sample replay estimate is
   * optimistic; the haircut charges it for its own sample size.
   */
  evidenceZ: number;

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

export function defaultMafiaBotConfig(): MafiaBotConfig {
  return {
    primaryStake: 2,
    minStake: 0.35,
    maxStake: 50,
    hedgeRatioPercent: 90,
    stakeMode: 'flat',
    martingaleFactor: 2,
    maxMartingaleSteps: 3,
    fixedFractionPercent: 1,
    maxStakeShareOfBalance: 5,

    uniformityWindow: 60,
    minUniformity: 0.2,
    minUniformityZ: 1,
    minTicksBeforeTrade: 120,
    replayTicks: 1_200,
    minDirectionSamples: 60,

    // The bot's job is to fire the moment uniformity appears. The expected-value
    // gate is the optional brake, not the trigger; the pair arithmetic stays on
    // screen either way.
    requirePositiveExpectedValue: false,
    minExpectedValue: 0,
    evidenceZ: 1,

    maxOpenPairs: 1,
    maxPairsPerSession: 0,
    maxConsecutiveLosingPairs: 3,
    maxDailyLoss: 20,
    dailyTakeProfit: 20,
    maxSessionMinutes: 0,
    cooldownMs: 1_000,

    decisionIntervalMs: 1_000,
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
 * pasted value cannot produce a zero window, a negative stake, a cover leg
 * larger than the primary, or an unbounded exposure.
 */
export function sanitizeMafiaBotConfig(raw: Partial<MafiaBotConfig> | null | undefined): MafiaBotConfig {
  const base = defaultMafiaBotConfig();
  const input = raw ?? {};
  const minStake = clampNumber(input.minStake, 0.35, 1_000, base.minStake);
  const maxStake = clampNumber(input.maxStake, minStake, 1_000, base.maxStake);
  return {
    primaryStake: roundMoney(clampNumber(input.primaryStake, minStake, maxStake, base.primaryStake)),
    minStake,
    maxStake,
    // A cover leg bigger than the primary would make the cover the position the
    // analysis did NOT choose, so the range stops at parity.
    hedgeRatioPercent: clampNumber(input.hedgeRatioPercent, 10, 100, base.hedgeRatioPercent),
    maxStakeShareOfBalance: clampNumber(input.maxStakeShareOfBalance, 0.1, 100, base.maxStakeShareOfBalance),
    stakeMode: input.stakeMode === 'martingale' || input.stakeMode === 'fixed-fraction' || input.stakeMode === 'flat'
      ? input.stakeMode
      : base.stakeMode,
    martingaleFactor: clampNumber(input.martingaleFactor, 1, 4, base.martingaleFactor),
    maxMartingaleSteps: clampInteger(input.maxMartingaleSteps, 0, 10, base.maxMartingaleSteps),
    fixedFractionPercent: clampNumber(input.fixedFractionPercent, 0.1, 100, base.fixedFractionPercent),

    uniformityWindow: clampInteger(input.uniformityWindow, 20, 300, base.uniformityWindow),
    minUniformity: clampNumber(input.minUniformity, 0, 1, base.minUniformity),
    minUniformityZ: clampNumber(input.minUniformityZ, 0, 6, base.minUniformityZ),
    minTicksBeforeTrade: clampInteger(input.minTicksBeforeTrade, 20, 2_000, base.minTicksBeforeTrade),
    replayTicks: clampInteger(input.replayTicks, 100, 1_500, base.replayTicks),
    minDirectionSamples: clampInteger(input.minDirectionSamples, 10, 1_000, base.minDirectionSamples),

    requirePositiveExpectedValue: typeof input.requirePositiveExpectedValue === 'boolean'
      ? input.requirePositiveExpectedValue
      : base.requirePositiveExpectedValue,
    minExpectedValue: clampNumber(input.minExpectedValue, -1, 10, base.minExpectedValue),
    evidenceZ: clampNumber(input.evidenceZ, 0, 2.58, base.evidenceZ),

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

export type MafiaLegStatus = 'pending' | 'open' | 'won' | 'lost' | 'push' | 'closed' | 'rejected';

export type MafiaLeg = {
  side: MafiaLegSide;
  direction: MafiaDirection;
  contractType: MafiaDirection;
  contractId: number | null;
  stake: number;
  askPrice: number | null;
  payout: number | null;
  status: MafiaLegStatus;
  profit: number | null;
  exitSpot: number | null;
  settledAt: number | null;
  longcode: string | null;
};

/** `open` — at least one bought leg is unsettled. `settled` — both legs reported. */
export type MafiaPairStatus = 'open' | 'settled' | 'partial' | 'rejected' | 'unreconciled';

export type MafiaPair = {
  id: string;
  at: number;
  symbol: string;
  mode: MafiaMode;
  status: MafiaPairStatus;
  /** The direction the analysis measured; the primary leg trades it. */
  direction: MafiaDirection | null;
  primary: MafiaLeg;
  cover: MafiaLeg;
  entrySpot: number | null;
  exitSpot: number | null;
  /** Uniformity score at entry, 0–1. */
  uniformity: number | null;
  /** Measured probability the primary direction wins the 4-tick window. */
  probability: number | null;
  /** The pair's break-even probability for that direction, from the live payouts. */
  breakEven: number | null;
  expectedValue: number | null;
  netProfit: number | null;
  balanceAfter: number | null;
  settledAt: number | null;
  note: string;
};

/**
 * One entry the analysis rule would have taken, scored against the ticks that
 * followed. Recorded in both modes, so the hit rate describes the RULE rather
 * than only the pairs the risk gate happened to allow.
 */
export type MafiaPrediction = {
  id: string;
  at: number;
  symbol: string;
  entryEpoch: number;
  entryQuote: number;
  direction: MafiaDirection;
  uniformity: number;
  probability: number | null;
  exitEpoch: number | null;
  exitQuote: number | null;
  outcome: 'primary' | 'cover' | 'flat' | null;
  resolvedAt: number | null;
};

export type MafiaDecisionAction = 'WAIT' | 'TRADE' | 'BLOCKED';

export type MafiaDecision = {
  id: string;
  at: number;
  symbol: string;
  mode: MafiaMode;
  action: MafiaDecisionAction;
  actionLabel: string;
  reasons: string[];
  reasonCodes: string[];
  direction: MafiaDirection | null;
  uniformity: number | null;
  probability: number | null;
  primaryStake: number | null;
  coverStake: number | null;
  executed: boolean;
  pairId: string | null;
  error: string | null;
};

export type MafiaAccountState = RiseFallAccountState;
