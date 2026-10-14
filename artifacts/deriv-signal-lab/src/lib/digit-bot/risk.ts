// ENGINE J — Risk management engine.
//
// Fixed stake by default. There is no martingale, no doubling after a loss, no
// recovery cycle and no leverage: the stake depends only on the configured
// stake rule and the live balance, never on recent wins or losses.
import { clamp } from '../over-under/math.ts';
import { normalizeMoney } from './expectancy.ts';
import type { BotAccountState, BotMode, BotRiskConfig, MonitoredContract, ReasonCode, RiskEvaluation, SafetyState } from './types.ts';

export const MONEY_EPSILON = 1e-6;

/** Returns a validated configuration; invalid numbers are clamped, never trusted. */
export function sanitizeRiskConfig(config: BotRiskConfig): BotRiskConfig {
  const positive = (value: number, fallback: number) => (Number.isFinite(value) && value > 0 ? value : fallback);
  const minStake = positive(config.minStake, 0.35);
  const maxStake = Math.max(minStake, positive(config.maxStake, 5));
  const windows = (Array.isArray(config.analysisWindows) ? config.analysisWindows : [])
    .filter((window) => Number.isInteger(window) && window > 0)
    .sort((left, right) => left - right);
  const tolerance = Math.max(1e-6, config.maxTickAgeMs);
  return {
    ...config,
    fixedStake: clamp(Number.isFinite(config.fixedStake) ? config.fixedStake : minStake, 0, maxStake),
    percentOfBalance: clamp(Number.isFinite(config.percentOfBalance) ? config.percentOfBalance : 0.5, 0, 100),
    minStake,
    maxStake,
    maxStakeShareOfBalance: clamp(Number.isFinite(config.maxStakeShareOfBalance) ? config.maxStakeShareOfBalance : 2, 0.01, 100),
    maxDailyLoss: positive(config.maxDailyLoss, 10),
    maxSessionLoss: positive(config.maxSessionLoss, 5),
    maxConsecutiveLosses: Math.max(1, Math.floor(positive(config.maxConsecutiveLosses, 3))),
    maxDailyTrades: Math.max(1, Math.floor(positive(config.maxDailyTrades, 40))),
    maxEntriesPerSession: Math.max(1, Math.floor(positive(config.maxEntriesPerSession, 20))),
    maxTradesPerSymbol: Math.max(1, Math.floor(positive(config.maxTradesPerSymbol, 12))),
    maxOpenContracts: Math.max(1, Math.floor(positive(config.maxOpenContracts, 1))),
    minTicksBetweenEntries: Math.max(0, Math.floor(Number.isFinite(config.minTicksBetweenEntries) ? config.minTicksBetweenEntries : 10)),
    cooldownAfterContractMs: Math.max(0, Number.isFinite(config.cooldownAfterContractMs) ? config.cooldownAfterContractMs : 5_000),
    maxSessionMinutes: positive(config.maxSessionMinutes, 120),
    minProbabilityEdge: clamp(Number.isFinite(config.minProbabilityEdge) ? config.minProbabilityEdge : 0.01, 0, 0.5),
    minEffectiveSample: Math.max(10, Math.floor(positive(config.minEffectiveSample, 500))),
    analysisWindows: windows.length ? windows : [25, 50, 100, 250, 500, 1_000],
    durationTicks: Math.max(1, Math.floor(positive(config.durationTicks, 1))),
    decisionIntervalMs: Math.max(500, Math.floor(positive(config.decisionIntervalMs, 2_000))),
    maxTickAgeMs: Math.max(1_000, Math.floor(tolerance)),
  };
}

/** Local calendar day key, used for the daily loss and daily trade limits. */
export function dayKeyOf(now: number): string {
  const date = new Date(now);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Rolls the daily counters when the calendar day changes mid-session. */
export function rollTradingDay(account: BotAccountState, now: number): BotAccountState {
  const key = dayKeyOf(now);
  if (account.dayKey === key) return account;
  return { ...account, dayKey: key, dailyPnl: 0, tradesToday: 0 };
}

export type StakeComputation = {
  stake: number | null;
  issues: string[];
  reasonCodes: ReasonCode[];
  basis: 'fixed' | 'percent-of-balance' | 'unavailable';
};

/**
 * Stake sizing. `percent` mode is conservative: the result is additionally
 * capped by `maxStakeShareOfBalance` of the live balance, and the balance must
 * be known before any stake is produced.
 */
export function computeStake(config: BotRiskConfig, account: BotAccountState): StakeComputation {
  const reasonCodes: ReasonCode[] = [];
  const issues: string[] = [];
  const balance = account.currentBalance;
  if (config.stakeMode === 'fixed') {
    const stake = normalizeMoney(config.fixedStake);
    if (stake < config.minStake - MONEY_EPSILON) {
      issues.push(`The configured stake ${stake} is below the minimum permitted stake ${config.minStake}.`);
      reasonCodes.push('STAKE_BELOW_MINIMUM');
      return { stake: null, issues, reasonCodes, basis: 'fixed' };
    }
    if (stake > config.maxStake + MONEY_EPSILON) {
      issues.push(`The configured stake ${stake} is above the maximum permitted stake ${config.maxStake}.`);
      reasonCodes.push('STAKE_ABOVE_MAXIMUM');
      return { stake: null, issues, reasonCodes, basis: 'fixed' };
    }
    if (balance === null) {
      // Without an authoritative balance the maximum possible loss cannot be
      // compared with the account, so a percentage cap cannot be enforced.
      return { stake, issues, reasonCodes, basis: 'fixed' };
    }
    const cap = normalizeMoney((balance * config.maxStakeShareOfBalance) / 100);
    if (stake > cap + MONEY_EPSILON) {
      issues.push(`The configured stake ${stake} exceeds ${config.maxStakeShareOfBalance}% of the live balance.`);
      reasonCodes.push('STAKE_ABOVE_MAXIMUM');
      return { stake: null, issues, reasonCodes, basis: 'fixed' };
    }
    if (balance + MONEY_EPSILON < stake) {
      issues.push('The available balance does not cover the configured stake.');
      reasonCodes.push('ACCOUNT_UNAVAILABLE');
      return { stake: null, issues, reasonCodes, basis: 'fixed' };
    }
    return { stake, issues, reasonCodes, basis: 'fixed' };
  }

  if (balance === null || !Number.isFinite(balance)) {
    issues.push('Percentage staking needs the authoritative account balance, which is not available yet.');
    reasonCodes.push('ACCOUNT_UNAVAILABLE');
    return { stake: null, issues, reasonCodes, basis: 'unavailable' };
  }
  const raw = normalizeMoney((balance * config.percentOfBalance) / 100);
  const capped = Math.min(raw, config.maxStake, (balance * config.maxStakeShareOfBalance) / 100);
  const stake = normalizeMoney(Math.max(capped, 0));
  if (stake < config.minStake - MONEY_EPSILON) {
    issues.push(`A ${config.percentOfBalance}% stake of the current balance is below the minimum permitted stake ${config.minStake}.`);
    reasonCodes.push('STAKE_BELOW_MINIMUM');
    return { stake: null, issues, reasonCodes, basis: 'percent-of-balance' };
  }
  if (balance + MONEY_EPSILON < stake) {
    issues.push('The available balance does not cover the calculated stake.');
    reasonCodes.push('ACCOUNT_UNAVAILABLE');
    return { stake: null, issues, reasonCodes, basis: 'percent-of-balance' };
  }
  return { stake, issues, reasonCodes, basis: 'percent-of-balance' };
}

export type RiskEvaluationInput = {
  config: BotRiskConfig;
  account: BotAccountState;
  mode: BotMode;
  safety: SafetyState;
  symbol: string;
  now: number;
  tickCount: number;
  activeContracts: readonly MonitoredContract[];
  /** Set when a previous purchase may still be in flight or unreconciled. */
  purchaseInFlight: boolean;
};

/**
 * Full pre-purchase risk evaluation. Every gate is reported, so the decision
 * log can show exactly which limit stopped a trade.
 */
export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluation {
  const { config, account, safety, symbol, now } = input;
  const violations: string[] = [];
  const reasonCodes: ReasonCode[] = [];
  const notes: string[] = [];

  const stakeComputation = computeStake(config, account);
  if (stakeComputation.stake === null) {
    violations.push(...stakeComputation.issues);
    reasonCodes.push(...stakeComputation.reasonCodes);
  } else {
    notes.push(stakeComputation.basis === 'fixed'
      ? `Fixed stake ${stakeComputation.stake} ${account.currency || ''}`.trim()
      : `Balance-based stake ${stakeComputation.stake} ${account.currency || ''} (${config.percentOfBalance}% of balance, capped).`);
  }

  if (safety.emergencyStop) {
    violations.push('The emergency stop is engaged; no purchases are permitted.');
    reasonCodes.push('EMERGENCY_STOP');
  }
  if (safety.manualPause) {
    violations.push('The bot is paused manually.');
    reasonCodes.push('MANUAL_PAUSE');
  }
  for (const reason of safety.autoPauseReasons) {
    violations.push(reason);
    reasonCodes.push('CONNECTION_INTERRUPTED');
  }
  if (input.purchaseInFlight) {
    violations.push('A previous purchase has not been reconciled yet.');
    reasonCodes.push('PURCHASE_UNRECONCILED');
  }

  const openContracts = input.activeContracts.filter((contract) => !contract.isSold).length;
  if (openContracts >= config.maxOpenContracts) {
    violations.push(`The maximum of ${config.maxOpenContracts} open contract(s) is already reached.`);
    reasonCodes.push('OPEN_CONTRACT_LIMIT');
  }

  if (account.currentBalance === null) {
    violations.push('The authoritative account balance is unavailable, so no trade may be opened.');
    reasonCodes.push('ACCOUNT_UNAVAILABLE');
  }

  if (account.sessionPnl <= -Math.abs(config.maxSessionLoss) + MONEY_EPSILON) {
    violations.push(`The session loss limit of ${config.maxSessionLoss} has been reached.`);
    reasonCodes.push('SESSION_LOSS_LIMIT');
  }
  if (account.dailyPnl <= -Math.abs(config.maxDailyLoss) + MONEY_EPSILON) {
    violations.push(`The daily loss limit of ${config.maxDailyLoss} has been reached.`);
    reasonCodes.push('DAILY_LOSS_LIMIT');
  }
  if (account.consecutiveLosses >= config.maxConsecutiveLosses) {
    violations.push(`${account.consecutiveLosses} consecutive losses reached the configured limit of ${config.maxConsecutiveLosses}.`);
    reasonCodes.push('CONSECUTIVE_LOSS_LIMIT');
  }
  if (account.tradesToday >= config.maxDailyTrades) {
    violations.push(`The daily trade limit of ${config.maxDailyTrades} has been reached.`);
    reasonCodes.push('DAILY_TRADE_LIMIT');
  }
  if (account.tradesThisSession >= config.maxEntriesPerSession) {
    violations.push(`The session entry limit of ${config.maxEntriesPerSession} has been reached.`);
    reasonCodes.push('SESSION_TRADE_LIMIT');
  }
  const symbolTrades = account.tradesBySymbol[symbol] ?? 0;
  if (symbolTrades >= config.maxTradesPerSymbol) {
    violations.push(`${symbolTrades} trades on ${symbol} reached the per-symbol limit of ${config.maxTradesPerSymbol}.`);
    reasonCodes.push('SYMBOL_TRADE_LIMIT');
  }
  if (account.lastReconciledAt !== null && account.balanceDiscrepancy !== null && Math.abs(account.balanceDiscrepancy) > MONEY_EPSILON) {
    violations.push('The locally tracked balance does not match Deriv, so trading is suspended until it reconciles.');
    reasonCodes.push('BALANCE_DISCREPANCY');
  }
  if (account.sessionStartedAt !== null && now - account.sessionStartedAt > config.maxSessionMinutes * 60_000) {
    violations.push(`The session duration limit of ${config.maxSessionMinutes} minutes has been reached.`);
    reasonCodes.push('SESSION_DURATION_LIMIT');
  }
  if (account.lastSettlementAt !== null && now - account.lastSettlementAt < config.cooldownAfterContractMs) {
    const remaining = Math.ceil((config.cooldownAfterContractMs - (now - account.lastSettlementAt)) / 1_000);
    violations.push(`Cooling down for ${remaining}s after the previous contract.`);
    reasonCodes.push('COOLDOWN_ACTIVE');
  }
  if (account.lastEntryTickCount !== null && input.tickCount - account.lastEntryTickCount < config.minTicksBetweenEntries) {
    const remaining = config.minTicksBetweenEntries - (input.tickCount - account.lastEntryTickCount);
    violations.push(`Waiting for ${remaining} more validated tick(s) before the next entry.`);
    reasonCodes.push('MIN_TICKS_BETWEEN_ENTRIES');
  }
  if (input.mode !== 'live') {
    violations.push(input.mode === 'analysis'
      ? 'Analysis-only mode never places an order.'
      : 'Paper-trading mode records the decision without placing an order.');
    reasonCodes.push('MODE_NOT_EXECUTABLE');
  }

  const allowed = violations.length === 0;
  // A blocked trade reports no stake: there is nothing to size, and reporting a
  // number here would look like an order the bot intends to place.
  const stake = allowed ? stakeComputation.stake : null;
  const maxPossibleLoss = stake ?? 0;

  if (allowed) reasonCodes.push('RISK_LIMITS_PASSED');

  return {
    allowed,
    stake,
    maxPossibleLoss,
    projectedDailyLoss: account.dailyPnl - maxPossibleLoss,
    projectedSessionLoss: account.sessionPnl - maxPossibleLoss,
    violations,
    reasonCodes,
    limits: {
      dailyLoss: config.maxDailyLoss,
      sessionLoss: config.maxSessionLoss,
      consecutiveLosses: config.maxConsecutiveLosses,
      dailyTrades: config.maxDailyTrades,
      sessionTrades: config.maxEntriesPerSession,
      symbolTrades: config.maxTradesPerSymbol,
      openContracts: config.maxOpenContracts,
    },
    notes,
  };
}

/** Records that a stake was committed. Stakes are never derived from losses. */
export function applyPurchase(account: BotAccountState, options: { stake: number; symbol: string; now: number; tickCount: number }): BotAccountState {
  const tradesBySymbol = { ...account.tradesBySymbol, [options.symbol]: (account.tradesBySymbol[options.symbol] ?? 0) + 1 };
  return {
    ...account,
    totalStaked: normalizeMoney(account.totalStaked + options.stake),
    openExposure: normalizeMoney(account.openExposure + options.stake),
    tradesToday: account.tradesToday + 1,
    tradesThisSession: account.tradesThisSession + 1,
    tradesBySymbol,
    sessionStartedAt: account.sessionStartedAt ?? options.now,
    dayKey: account.dayKey ?? dayKeyOf(options.now),
    lastEntryTickCount: options.tickCount,
  };
}

export type Settlement = {
  contractId: number;
  stake: number | null;
  /** Authoritative profit from Deriv. Required for realised P/L. */
  profit: number | null;
  symbol: string | null;
};

/**
 * Applies an authoritative settlement. An open contract's displayed potential
 * profit is never treated as realised: only Deriv's settled figure counts.
 */
export function applySettlement(account: BotAccountState, settlement: Settlement, now: number): BotAccountState {
  if (settlement.profit === null || !Number.isFinite(settlement.profit)) return account;
  const profit = normalizeMoney(settlement.profit);
  const stake = settlement.stake !== null && Number.isFinite(settlement.stake) ? settlement.stake : 0;
  const won = profit > 0;
  const consecutiveLosses = won ? 0 : account.consecutiveLosses + 1;
  const realizedPnl = normalizeMoney(account.realizedPnl + profit);
  const sessionPnl = normalizeMoney(account.sessionPnl + profit);
  const dailyPnl = normalizeMoney(account.dailyPnl + profit);
  const openExposure = normalizeMoney(Math.max(0, account.openExposure - stake));
  const equity = (account.currentBalance ?? 0) + account.expectedBalanceDelta + profit;
  const peakEquity = account.peakEquity === null ? equity : Math.max(account.peakEquity, equity);
  return {
    ...account,
    realizedPnl,
    sessionPnl,
    dailyPnl,
    openExposure,
    wins: account.wins + (won ? 1 : 0),
    losses: account.losses + (won ? 0 : 1),
    consecutiveLosses,
    longestLosingStreak: Math.max(account.longestLosingStreak, consecutiveLosses),
    peakEquity,
    maxDrawdown: normalizeMoney(Math.max(account.maxDrawdown, peakEquity - equity)),
    expectedBalanceDelta: normalizeMoney(account.expectedBalanceDelta + profit),
    lastSettlementAt: now,
  };
}

export type BalanceReconciliation = {
  account: BotAccountState;
  discrepancy: number | null;
  unexplained: boolean;
  note: string;
  reasonCodes: ReasonCode[];
};

/**
 * Compares Deriv's authoritative balance with the locally tracked ledger.
 * An unexplained gap pauses trading instead of being silently absorbed.
 */
export function reconcileBalance(account: BotAccountState, reportedBalance: number, options: { now: number; tolerance?: number } = { now: Date.now() }): BalanceReconciliation {
  const tolerance = options.tolerance ?? Math.max(0.01, Math.abs(reportedBalance) * 1e-4);
  if (!Number.isFinite(reportedBalance)) {
    return { account, discrepancy: null, unexplained: false, note: 'Deriv did not report a usable balance.', reasonCodes: [] };
  }
  const expected = account.currentBalance === null ? reportedBalance : normalizeMoney(account.currentBalance + account.expectedBalanceDelta);
  const discrepancy = normalizeMoney(reportedBalance - expected);
  const unexplained = Math.abs(discrepancy) > tolerance;
  const basis: BotAccountState = {
    ...account,
    currentBalance: normalizeMoney(reportedBalance),
    initialBalance: account.initialBalance ?? normalizeMoney(reportedBalance),
    expectedBalanceDelta: 0,
    balanceDiscrepancy: unexplained ? discrepancy : 0,
    lastReconciledAt: options.now,
    peakEquity: account.peakEquity === null ? normalizeMoney(reportedBalance) : account.peakEquity,
  };
  return {
    account: basis,
    discrepancy,
    unexplained,
    note: unexplained
      ? `Deriv reports ${reportedBalance} while the local ledger expected ${expected}; trading is suspended until this reconciles.`
      : 'The authoritative balance matches the local ledger.',
    reasonCodes: unexplained ? ['BALANCE_DISCREPANCY'] : [],
  };
}

/** Entries remaining in the session, or null when the allowance is unlimited. */
export function entriesRemaining(config: BotRiskConfig, account: BotAccountState): number {
  return Math.max(0, config.maxEntriesPerSession - account.tradesThisSession);
}

/** Minutes left in the configured session window; null when not started. */
export function sessionMinutesRemaining(config: BotRiskConfig, account: BotAccountState, now: number): number | null {
  if (account.sessionStartedAt === null) return config.maxSessionMinutes;
  return Math.max(0, config.maxSessionMinutes - (now - account.sessionStartedAt) / 60_000);
}

/** Resets session-scoped counters when the user explicitly starts a session. */
export function beginSession(account: BotAccountState, now: number): BotAccountState {
  return {
    ...account,
    sessionStartedAt: now,
    sessionPnl: 0,
    tradesThisSession: 0,
    consecutiveLosses: 0,
    initialBalance: account.currentBalance ?? account.initialBalance,
    dayKey: account.dayKey ?? dayKeyOf(now),
  };
}
