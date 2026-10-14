// Types, defaults and input sanitisation for the Rise/Fall premium bot.
//
// The engine is a port of the reference "Deriv Rise/Fall AI Bot" script:
// live ticks → feature engine → decision engine → risk manager → CALL/PUT
// purchase. This module holds data shapes only — no I/O, no React, no Deriv
// messages — so every rule downstream stays unit testable.
export type RiseFallDirection = 'CALL' | 'PUT';

export const RISE_FALL_LABELS: Record<RiseFallDirection, string> = {
  CALL: 'Rise',
  PUT: 'Fall',
};

/** Which signal rule named the direction. */
export type RiseFallRule = 'momentum' | 'continuation' | 'none';

export const RISE_FALL_RULE_LABELS: Record<RiseFallRule, string> = {
  momentum: 'Strong momentum',
  continuation: 'Continuation of the last move',
  none: 'No rule fired',
};

/** Mirrors the digit bot: analysis never sends an order, live really buys. */
export type RiseFallBotMode = 'analysis' | 'live';

export type RiseFallStakeMode = 'fixed' | 'martingale' | 'percent';

export type RiseFallDurationUnit = 't' | 's' | 'm';

export const RISE_FALL_STAKE_MODES: Array<{ id: RiseFallStakeMode; label: string; blurb: string }> = [
  { id: 'fixed', label: 'Fixed stake', blurb: 'Every order uses the same stake, win or lose.' },
  { id: 'martingale', label: 'Martingale ladder', blurb: 'Multiplies the stake after a loss up to a step limit, then resets. Losses grow fast.' },
  { id: 'percent', label: 'Percentage of balance', blurb: 'Sizes each order as a percentage of the live Deriv balance.' },
];

/** Operator configuration — the script's `Config` dataclass, made editable. */
export type RiseFallConfig = {
  /** Contract expiry. */
  duration: number;
  durationUnit: RiseFallDurationUnit;

  // Money management
  stakeMode: RiseFallStakeMode;
  baseStake: number;
  minStake: number;
  maxStake: number;
  /** Hard ceiling on any single stake as a percentage of the live balance. */
  maxStakeShareOfBalance: number;
  /** Percentage of balance used by the `percent` stake mode. */
  riskPercent: number;
  martingaleMultiplier: number;
  maxMartingaleSteps: number;

  // Risk limits
  maxConsecutiveLosses: number;
  maxDailyLoss: number;
  /** Trading stops for the day once realised profit reaches this figure. */
  dailyTakeProfit: number;
  /** 0 = unlimited, as in the reference script. */
  maxTrades: number;
  maxOpenContracts: number;
  cooldownMs: number;
  /** 0 = unlimited session length. */
  maxSessionMinutes: number;

  // Strategy / feature engine
  tickWindow: number;
  minTicksBeforeTrade: number;
  momentumTicks: number;
  volatilityTicks: number;
  /** Momentum edge required, in verified pips of the selected symbol. */
  momentumThresholdPips: number;
  /** Mean absolute tick move below which the market is treated as dead. */
  minVolatilityPips: number;
  /** Scale the momentum edge with measured volatility instead of a fixed pip count. */
  adaptiveThresholds: boolean;
  adaptiveMultiple: number;
  /** Up/down ratio required by the strong-momentum rule. */
  strongRatio: number;
  /** Up/down ratio required by the continuation rule. */
  continuationRatio: number;

  // Expected-value gate (measured against a live Deriv proposal)
  requirePositiveExpectedValue: boolean;
  minEvidenceSample: number;
  /** Minimum expected value per unit staked, measured on a live proposal. */
  minExpectedValue: number;

  // Runtime
  decisionIntervalMs: number;
  maxTickAgeMs: number;
};

export type RiseFallFeatures = {
  /** Quotes inside the feature window. */
  sample: number;
  price: number;
  upRatio: number;
  downRatio: number;
  flatRatio: number;
  /** Net move over the momentum window, in price units. */
  momentum: number;
  momentumPips: number;
  /** Mean absolute tick move over the volatility window, in price units. */
  volatility: number;
  volatilityPips: number;
  lastMove: number;
  lastMovePips: number;
  streakDirection: 'up' | 'down' | 'flat';
  streakLength: number;
  computedAt: number;
};

/** Historical performance of the same rule on the ticks already collected. */
export type SignalEvidence = {
  direction: RiseFallDirection;
  horizonTicks: number | null;
  occurrences: number;
  wins: number;
  losses: number;
  pushes: number;
  /** Wins over decisive outcomes; null when nothing decisive happened. */
  winRate: number | null;
  /** Share of occurrences that ended level and would return the stake. */
  pushRate: number | null;
  /** Unconditional rise/fall rate over the same horizon. */
  baselineWinRate: number | null;
  sufficient: boolean;
  note: string;
};

/** Economics of one order, measured against Deriv's own live proposal. */
export type ProposalEconomics = {
  askPrice: number;
  payout: number;
  breakEvenProbability: number;
  /** Expected profit in account currency for the quoted stake. */
  expectedValue: number;
  /** Historical win rate minus the proposal's break-even probability. */
  edge: number;
  /** Expected profit per unit staked; null when the stake is unknown. */
  returnOnStake: number | null;
};

export type RiseFallDecision = {
  id: string;
  at: number;
  symbol: string;
  mode: RiseFallBotMode;
  action: 'TRADE' | 'WAIT' | 'BLOCKED';
  actionLabel: string;
  direction: RiseFallDirection | null;
  rule: RiseFallRule;
  reasons: string[];
  reasonCodes: string[];
  features: RiseFallFeatures | null;
  evidence: SignalEvidence | null;
  stake: number | null;
  step: number;
  executed: boolean;
  contractId: number | null;
  error: string | null;
};

export type MonitoredRiseFallContract = {
  contractId: number;
  decisionId: string;
  direction: RiseFallDirection;
  symbol: string;
  currency: string;
  stake: number;
  payout: number | null;
  entrySpot: number | null;
  currentSpot: number | null;
  exitSpot: number | null;
  /** Running indication while open; realised profit once Deriv settles. */
  profit: number | null;
  tickCount: number | null;
  tickPassed: number | null;
  expiryTime: number | null;
  status: string | null;
  longcode: string | null;
  isSold: boolean;
  isValidToSell: boolean;
  settledProfit: number | null;
  settledAt: number | null;
  openedAt: number;
  lastUpdateAt: number;
  mode: RiseFallBotMode;
};

export type RiseFallTradeRecord = {
  id: string;
  at: number;
  settledAt: number | null;
  mode: RiseFallBotMode;
  symbol: string;
  direction: RiseFallDirection;
  rule: RiseFallRule;
  stake: number;
  step: number;
  payout: number | null;
  contractId: number | null;
  entrySpot: number | null;
  exitSpot: number | null;
  status: 'open' | 'won' | 'lost' | 'push' | 'rejected' | 'unreconciled';
  profit: number | null;
  balanceAfter: number | null;
  sessionPnl: number;
  dailyPnl: number;
  momentumPips: number | null;
  volatilityPips: number | null;
  winRateEstimate: number | null;
  expectedValue: number | null;
  note: string;
};

/** A signal that was never traded, scored against the ticks that followed. */
export type RiseFallPrediction = {
  id: string;
  at: number;
  symbol: string;
  direction: RiseFallDirection;
  rule: RiseFallRule;
  /** Deriv epoch of the tick the signal was read on; indexes survive pruning. */
  entryEpoch: number;
  entryQuote: number;
  horizonTicks: number;
  stake: number | null;
  winRateEstimate: number | null;
  resolved: boolean;
  /** The entry tick left the buffer before the horizon elapsed. */
  expired: boolean;
  exitQuote: number | null;
  outcome: 'win' | 'loss' | 'push' | null;
  resolvedAt: number | null;
};

export type RiseFallAccountState = {
  accountId: string | null;
  accountType: 'demo' | 'real' | null;
  currency: string;
  balance: number | null;
  sessionStartedAt: number | null;
  sessionPnl: number;
  dailyPnl: number;
  dayKey: string | null;
  tradesThisSession: number;
  tradesToday: number;
  wins: number;
  losses: number;
  pushes: number;
  consecutiveLosses: number;
  longestLosingStreak: number;
  grossStake: number;
  openExposure: number;
  peakEquity: number | null;
  maxDrawdown: number;
  lastSettlementAt: number | null;
};

export type RiskGate = {
  allowed: boolean;
  violations: string[];
  notes: string[];
  codes: string[];
  stake: number | null;
  step: number;
  maxPossibleLoss: number | null;
};

export type StakePlan = {
  stake: number;
  step: number;
  capped: boolean;
  notes: string[];
};

export type RiseFallTradeSummary = {
  purchased: number;
  settled: number;
  wins: number;
  losses: number;
  pushes: number;
  open: number;
  rejected: number;
  netProfit: number;
  grossStake: number;
  winRate: number | null;
  returnOnStake: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
};

export type RiseFallPredictionSummary = {
  scored: number;
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  expired: number;
  hitRate: number | null;
};

export function dayKeyOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function defaultRiseFallConfig(): RiseFallConfig {
  return {
    duration: 5,
    durationUnit: 't',

    stakeMode: 'fixed',
    baseStake: 1,
    minStake: 0.35,
    maxStake: 250,
    maxStakeShareOfBalance: 5,
    riskPercent: 1,
    martingaleMultiplier: 2,
    maxMartingaleSteps: 4,

    maxConsecutiveLosses: 5,
    maxDailyLoss: 50,
    dailyTakeProfit: 100,
    maxTrades: 0,
    maxOpenContracts: 1,
    cooldownMs: 1_000,
    maxSessionMinutes: 0,

    tickWindow: 20,
    minTicksBeforeTrade: 15,
    momentumTicks: 5,
    volatilityTicks: 10,
    momentumThresholdPips: 8,
    minVolatilityPips: 3,
    adaptiveThresholds: true,
    adaptiveMultiple: 1,
    strongRatio: 0.65,
    continuationRatio: 0.55,

    requirePositiveExpectedValue: true,
    minEvidenceSample: 30,
    minExpectedValue: 0,

    decisionIntervalMs: 1_500,
    maxTickAgeMs: 15_000,
  };
}

export function createRiseFallAccountState(): RiseFallAccountState {
  return {
    accountId: null,
    accountType: null,
    currency: '',
    balance: null,
    sessionStartedAt: null,
    sessionPnl: 0,
    dailyPnl: 0,
    dayKey: null,
    tradesThisSession: 0,
    tradesToday: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    consecutiveLosses: 0,
    longestLosingStreak: 0,
    grossStake: 0,
    openExposure: 0,
    peakEquity: null,
    maxDrawdown: 0,
    lastSettlementAt: null,
  };
}

function number(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.min(max, Math.max(min, parsed));
  return integer ? Math.round(bounded) : bounded;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stakeMode(value: unknown): RiseFallStakeMode {
  return value === 'martingale' || value === 'percent' ? value : 'fixed';
}

function durationUnit(value: unknown): RiseFallDurationUnit {
  return value === 's' || value === 'm' ? value : 't';
}

/**
 * Clamps every operator input into a range the engines can reason about. A
 * stored value from an older version, a cleared field or a pasted number can
 * never produce an unbounded stake, a zero window or an infinite ladder.
 */
export function sanitizeRiseFallConfig(raw: Partial<RiseFallConfig> | null | undefined): RiseFallConfig {
  const base = defaultRiseFallConfig();
  const input = (raw ?? {}) as Partial<RiseFallConfig>;
  const tickWindow = number(input.tickWindow, base.tickWindow, 10, 500, true);
  const maxMartingaleSteps = number(input.maxMartingaleSteps, base.maxMartingaleSteps, 0, 10, true);
  return {
    duration: number(input.duration, base.duration, 1, 3_600, true),
    durationUnit: durationUnit(input.durationUnit),

    stakeMode: stakeMode(input.stakeMode),
    baseStake: number(input.baseStake, base.baseStake, 0.35, 10_000),
    minStake: number(input.minStake, base.minStake, 0.35, 10_000),
    maxStake: number(input.maxStake, base.maxStake, 0.35, 100_000),
    maxStakeShareOfBalance: number(input.maxStakeShareOfBalance, base.maxStakeShareOfBalance, 0.1, 100),
    riskPercent: number(input.riskPercent, base.riskPercent, 0.1, 25),
    martingaleMultiplier: number(input.martingaleMultiplier, base.martingaleMultiplier, 1, 5),
    maxMartingaleSteps,

    maxConsecutiveLosses: number(input.maxConsecutiveLosses, base.maxConsecutiveLosses, 1, 100, true),
    maxDailyLoss: number(input.maxDailyLoss, base.maxDailyLoss, 0, 1_000_000),
    dailyTakeProfit: number(input.dailyTakeProfit, base.dailyTakeProfit, 0, 1_000_000),
    maxTrades: number(input.maxTrades, base.maxTrades, 0, 10_000, true),
    maxOpenContracts: number(input.maxOpenContracts, base.maxOpenContracts, 1, 10, true),
    cooldownMs: number(input.cooldownMs, base.cooldownMs, 0, 120_000, true),
    maxSessionMinutes: number(input.maxSessionMinutes, base.maxSessionMinutes, 0, 1_440, true),

    tickWindow,
    minTicksBeforeTrade: Math.min(number(input.minTicksBeforeTrade, base.minTicksBeforeTrade, 5, 500, true), tickWindow),
    momentumTicks: Math.min(number(input.momentumTicks, base.momentumTicks, 2, 100, true), tickWindow),
    volatilityTicks: Math.min(number(input.volatilityTicks, base.volatilityTicks, 2, 200, true), tickWindow),
    momentumThresholdPips: number(input.momentumThresholdPips, base.momentumThresholdPips, 0, 10_000),
    minVolatilityPips: number(input.minVolatilityPips, base.minVolatilityPips, 0, 10_000),
    adaptiveThresholds: boolean(input.adaptiveThresholds, base.adaptiveThresholds),
    adaptiveMultiple: number(input.adaptiveMultiple, base.adaptiveMultiple, 0, 20),
    strongRatio: number(input.strongRatio, base.strongRatio, 0.5, 1),
    continuationRatio: number(input.continuationRatio, base.continuationRatio, 0.5, 1),

    requirePositiveExpectedValue: boolean(input.requirePositiveExpectedValue, base.requirePositiveExpectedValue),
    minEvidenceSample: number(input.minEvidenceSample, base.minEvidenceSample, 5, 500, true),
    minExpectedValue: number(input.minExpectedValue, base.minExpectedValue, -1, 10),

    decisionIntervalMs: number(input.decisionIntervalMs, base.decisionIntervalMs, 500, 60_000, true),
    maxTickAgeMs: number(input.maxTickAgeMs, base.maxTickAgeMs, 2_000, 120_000, true),
  };
}
