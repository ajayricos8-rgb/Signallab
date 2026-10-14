// RISK MANAGER — leg sizing and the pair purchase gate.
//
// The account ledger is the same one the Rise/Fall bot keeps (balance, session
// and daily P/L, trade counters), because it describes the Deriv account rather
// than a strategy. What differs is the gate: a pair is two purchases, so the
// limits are counted in pairs and the worst-case loss is both stakes together.
import { dayKeyOf, type RiseFallAccountState } from '../rise-fall-bot/types.ts';
import {
  roundMoney,
  type HedgePair,
  type HedgingBotConfig,
  type HedgingBotMode,
} from './types.ts';

export type LegSizing = {
  /** The stake for each leg, or null when the balance cannot fund the minimum. */
  stake: number | null;
  note: string;
};

/**
 * Sizes one leg. The configured stake is clamped to its minimum and maximum,
 * then to the per-leg share of the live balance: the pair share is split across
 * the two legs, so a pair never puts more than `maxStakeShareOfBalance` percent
 * of the balance at risk.
 */
export function sizeLegStake(config: HedgingBotConfig, balance: number | null): LegSizing {
  const stake = Math.min(config.maxStakePerLeg, Math.max(config.minStakePerLeg, config.stakePerLeg));
  if (balance === null || !Number.isFinite(balance)) {
    return { stake: roundMoney(stake), note: 'Balance not reported yet; the configured stake is used and the purchase still needs the live proposal.' };
  }
  const cap = roundMoney((balance * config.maxStakeShareOfBalance) / 100 / 2);
  if (cap < 0.35) {
    return { stake: null, note: `The balance share allows ${cap.toFixed(2)} per leg, below Deriv's 0.35 minimum stake.` };
  }
  if (stake > cap) {
    return {
      stake: cap < config.minStakePerLeg ? null : cap,
      note: cap < config.minStakePerLeg
        ? `The balance share caps each leg at ${cap.toFixed(2)}, below the configured minimum ${config.minStakePerLeg.toFixed(2)}.`
        : `Each leg is capped at ${cap.toFixed(2)} by the balance share.`,
    };
  }
  return { stake: roundMoney(stake), note: '' };
}

/** Consecutive settled pairs that lost money, newest first, ignoring rejected and open pairs. */
export function consecutiveLosingPairs(pairs: readonly HedgePair[]): number {
  const settled = pairs
    .filter((pair) => pair.status === 'settled' || pair.status === 'partial')
    .filter((pair) => pair.netProfit !== null)
    .sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0));
  let streak = 0;
  for (const pair of settled) {
    if ((pair.netProfit ?? 0) < 0) streak += 1;
    else break;
  }
  return streak;
}

export type HedgeGateInput = {
  config: HedgingBotConfig;
  account: RiseFallAccountState;
  pairs: readonly HedgePair[];
  mode: HedgingBotMode;
  runState: 'idle' | 'running' | 'paused' | 'stopped';
  manualPause: boolean;
  autoPauseReasons: readonly string[];
  accountAuthorized: boolean;
  connectionHealthy: boolean;
  feedFresh: boolean;
  feedStatus: string;
  /** Null until Deriv has answered the contract-metadata request for the market. */
  tickContractsSupported: boolean | null;
  tickCount: number;
  openPairs: number;
  unreconciled: boolean;
  purchaseInFlight: boolean;
  stake: number | null;
  now: number;
};

export type HedgeGate = {
  allowed: boolean;
  violations: string[];
  codes: string[];
  notes: string[];
  /** Stake per leg the gate sized, or null. */
  stake: number | null;
  /** Total cost of the pair, which is also the most a pair can lose. */
  totalStake: number | null;
};

/**
 * Decides whether a new pair may be requested. Every violated limit is listed,
 * not just the first, so the operator sees the full set of reasons.
 */
export function evaluateHedgeGate(input: HedgeGateInput): HedgeGate {
  const { config, account, pairs, now } = input;
  const violations: string[] = [];
  const codes: string[] = [];
  const notes: string[] = [];
  const block = (code: string, message: string) => {
    violations.push(message);
    if (!codes.includes(code)) codes.push(code);
  };

  if (input.mode !== 'live') block('ANALYSIS_MODE', 'Analysis mode never sends orders.');
  if (input.runState !== 'running') block('NOT_RUNNING', 'The bot is not running.');
  if (input.manualPause) block('MANUAL_PAUSE', 'The bot is paused by the operator.');
  for (const reason of input.autoPauseReasons) block('AUTO_PAUSE', reason);
  if (!input.accountAuthorized) block('ACCOUNT_UNAUTHORIZED', 'No Deriv account is authorized for trading.');
  if (!input.connectionHealthy) block('CONNECTION_INTERRUPTED', 'The authenticated Deriv trading connection is not open.');
  if (!input.feedFresh) block('FEED_STALE', `The live tick stream is ${input.feedStatus === 'live' ? 'stale' : input.feedStatus}; new pairs wait for genuine ticks.`);
  if (input.tickContractsSupported === false) {
    block('CONTRACT_UNSUPPORTED', 'Deriv does not report High/Low Tick contracts for this market. They are offered on synthetic indices only.');
  }
  if (input.tickCount < config.minTicksBeforeTrade) {
    block('WARMUP', `Only ${input.tickCount} verified tick(s); ${config.minTicksBeforeTrade} are needed before the first pair.`);
  }
  if (input.purchaseInFlight) block('PURCHASE_IN_FLIGHT', 'A pair purchase is already in progress.');
  if (input.unreconciled) block('UNRECONCILED', 'A previous purchase has not been reconciled with Deriv yet.');
  if (input.openPairs >= config.maxOpenPairs) {
    block('OPEN_PAIR_LIMIT', `${input.openPairs} pair(s) still open; the limit is ${config.maxOpenPairs}.`);
  }

  const lastSettled = pairs.reduce((latest, pair) => Math.max(latest, pair.settledAt ?? 0), 0);
  if (lastSettled > 0 && now - lastSettled < config.cooldownMs) {
    block('COOLDOWN', `Cooling down after the last settlement (${config.cooldownMs} ms).`);
  }

  if (config.maxPairsPerSession > 0) {
    const sessionStart = account.sessionStartedAt ?? 0;
    const sessionPairs = pairs.filter((pair) => pair.at >= sessionStart && pair.status !== 'rejected').length;
    if (sessionPairs >= config.maxPairsPerSession) block('MAX_PAIRS', `The session limit of ${config.maxPairsPerSession} pair(s) has been reached.`);
  }

  if (config.maxDailyLoss > 0 && account.dailyPnl <= -config.maxDailyLoss) {
    block('DAILY_LOSS', `Daily loss ${Math.abs(account.dailyPnl).toFixed(2)} has reached the limit of ${config.maxDailyLoss.toFixed(2)}.`);
  }
  if (config.dailyTakeProfit > 0 && account.dailyPnl >= config.dailyTakeProfit) {
    block('DAILY_TARGET', `Daily profit ${account.dailyPnl.toFixed(2)} has reached the take-profit target of ${config.dailyTakeProfit.toFixed(2)}.`);
  }
  if (config.maxSessionMinutes > 0 && account.sessionStartedAt !== null) {
    const elapsed = (now - account.sessionStartedAt) / 60_000;
    if (elapsed >= config.maxSessionMinutes) block('SESSION_TIME', `The ${config.maxSessionMinutes}-minute session limit has passed.`);
  }

  const losingStreak = consecutiveLosingPairs(pairs);
  if (losingStreak >= config.maxConsecutiveLosingPairs) {
    block('LOSING_STREAK', `${losingStreak} losing pair(s) in a row; the limit is ${config.maxConsecutiveLosingPairs}.`);
  }

  let totalStake: number | null = null;
  if (input.stake === null || !Number.isFinite(input.stake) || input.stake <= 0) {
    block('NO_STAKE', 'The risk manager could not size a stake for each leg.');
  } else {
    totalStake = roundMoney(input.stake * 2);
    if (account.balance !== null && totalStake > account.balance) {
      block('INSUFFICIENT_BALANCE', `The pair costs ${totalStake.toFixed(2)}, more than the balance ${account.balance.toFixed(2)}.`);
    }
    notes.push(`Next pair: two legs of ${input.stake.toFixed(2)} each, ${totalStake.toFixed(2)} in total. The most it can lose is ${totalStake.toFixed(2)}.`);
  }

  if (account.dayKey !== null && account.dayKey !== dayKeyOf(now)) {
    notes.push('The daily counters roll over at midnight in this browser.');
  }

  return {
    allowed: violations.length === 0,
    violations,
    codes,
    notes,
    stake: input.stake,
    totalStake,
  };
}

/** Minutes left in the session, or null when there is no time limit or no session yet. */
export function hedgeSessionMinutesRemaining(
  config: HedgingBotConfig,
  account: RiseFallAccountState,
  now: number,
): number | null {
  if (config.maxSessionMinutes <= 0 || account.sessionStartedAt === null) return null;
  return Math.max(0, config.maxSessionMinutes - (now - account.sessionStartedAt) / 60_000);
}
