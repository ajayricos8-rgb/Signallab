// RISK MANAGER — stake sizing, the purchase gate and the account ledger.
//
// This is the port of the reference script's `can_trade()` / `update_stake()`
// pair, extended with the interlocks this application already relies on: no
// order leaves the browser unless a Deriv account is authorized, the trading
// socket is open, the tick feed is genuinely fresh, and every configured limit
// still has room. Stopping or pausing only blocks new purchases — a contract
// Deriv already accepted keeps being monitored until it settles.
import { dayKeyOf, type RiseFallAccountState, type RiseFallBotMode, type RiseFallConfig, type RiskGate, type StakePlan } from './types.ts';

function roundStake(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Sizes the next order.
 *
 *   fixed      → base stake, unchanged by results
 *   martingale → base × multiplier^step, where step is the current losing
 *                streak capped at `maxMartingaleSteps`; past that cap the
 *                ladder is exhausted and the stake resets to base
 *   percent    → `riskPercent` of the live Deriv balance
 *
 * Every result is then clamped to [minStake, maxStake] and to the configured
 * share of the live balance, so no configuration can risk an unbounded amount.
 */
export function computeStakePlan(
  config: RiseFallConfig,
  account: Pick<RiseFallAccountState, 'balance' | 'consecutiveLosses'>,
): StakePlan {
  const notes: string[] = [];
  let stake = config.baseStake;
  let step = 0;

  if (config.stakeMode === 'martingale') {
    const losses = Math.max(0, Math.floor(account.consecutiveLosses));
    if (losses <= config.maxMartingaleSteps) {
      step = losses;
      stake = config.baseStake * config.martingaleMultiplier ** step;
      if (step > 0) notes.push(`Martingale step ${step} of ${config.maxMartingaleSteps}: ${config.baseStake.toFixed(2)} × ${config.martingaleMultiplier}^${step}.`);
    } else {
      step = 0;
      stake = config.baseStake;
      notes.push(`Martingale ladder exhausted after ${losses} consecutive losses; the stake reset to the base ${config.baseStake.toFixed(2)}.`);
    }
  } else if (config.stakeMode === 'percent') {
    if (account.balance === null || !Number.isFinite(account.balance) || account.balance <= 0) {
      stake = config.baseStake;
      notes.push('Percentage sizing needs a live Deriv balance; the base stake is used until the balance is reported.');
    } else {
      stake = (account.balance * config.riskPercent) / 100;
      notes.push(`${config.riskPercent}% of the reported balance ${account.balance.toFixed(2)}.`);
    }
  }

  let capped = false;
  if (account.balance !== null && Number.isFinite(account.balance) && account.balance > 0) {
    const balanceCap = (account.balance * config.maxStakeShareOfBalance) / 100;
    if (stake > balanceCap) {
      stake = balanceCap;
      capped = true;
      notes.push(`Capped at ${config.maxStakeShareOfBalance}% of the live balance (${balanceCap.toFixed(2)}).`);
    }
  }
  if (stake > config.maxStake) {
    stake = config.maxStake;
    capped = true;
    notes.push(`Capped at the configured maximum stake ${config.maxStake.toFixed(2)}.`);
  }
  if (stake < config.minStake) {
    stake = config.minStake;
    capped = true;
    notes.push(`Raised to the configured minimum stake ${config.minStake.toFixed(2)}.`);
  }

  return { stake: roundStake(stake), step, capped, notes };
}

export type RiskGateInput = {
  config: RiseFallConfig;
  account: RiseFallAccountState;
  mode: RiseFallBotMode;
  runState: 'idle' | 'running' | 'paused' | 'stopped';
  autoPauseReasons: readonly string[];
  manualPause: boolean;
  accountAuthorized: boolean;
  connectionHealthy: boolean;
  feedFresh: boolean;
  feedStatus: string;
  tickCount: number;
  openContracts: number;
  unreconciledPurchase: boolean;
  purchaseInFlight: boolean;
  now: number;
};

/**
 * The purchase gate. Every failed check adds a violation with a code, so the
 * panel can show exactly which limit stopped an order instead of a bare
 * "no trade".
 */
export function evaluateRiskGate(input: RiskGateInput): RiskGate {
  const { config, account, now } = input;
  const violations: string[] = [];
  const notes: string[] = [];
  const codes: string[] = [];
  const plan = computeStakePlan(config, account);

  // Analysis-only mode is not a violation: it is the mode the operator chose.
  // The controller decides what to do with a signal in that mode, and the gate
  // only reports the limits that would stop a live purchase.
  if (input.mode !== 'live') {
    notes.push('Analysis-only mode reads live ticks and reports the signal; it never sends an order.');
  }
  if (input.runState !== 'running') {
    violations.push(`The bot is ${input.runState}; new purchases are blocked until it runs again.`);
    codes.push('BOT_NOT_RUNNING');
  }
  if (input.manualPause) {
    violations.push('The bot is paused by the operator.');
    codes.push('MANUAL_PAUSE');
  }
  for (const reason of input.autoPauseReasons) {
    violations.push(reason);
    codes.push('AUTO_PAUSE');
  }
  if (!input.accountAuthorized) {
    violations.push('No Deriv account is authorized, so there is nothing to buy on.');
    codes.push('ACCOUNT_UNAUTHORIZED');
  }
  if (!input.connectionHealthy) {
    violations.push('The authenticated Deriv trading socket is not open.');
    codes.push('TRADING_SOCKET_CLOSED');
  }
  if (!input.feedFresh) {
    violations.push(`The tick feed is not fresh (${input.feedStatus}); the bot never trades on stale or generated ticks.`);
    codes.push('FEED_NOT_FRESH');
  }
  if (input.tickCount < config.minTicksBeforeTrade) {
    violations.push(`Only ${input.tickCount} verified tick(s) collected; ${config.minTicksBeforeTrade} are required before the first entry.`);
    codes.push('WARMUP');
  }
  if (account.consecutiveLosses >= config.maxConsecutiveLosses) {
    violations.push(`Consecutive-loss protection: ${account.consecutiveLosses} losses in a row reached the limit of ${config.maxConsecutiveLosses}.`);
    codes.push('MAX_CONSECUTIVE_LOSSES');
  }
  if (config.maxDailyLoss > 0 && account.dailyPnl <= -config.maxDailyLoss) {
    violations.push(`Daily loss limit hit: realised ${account.dailyPnl.toFixed(2)} against a limit of -${config.maxDailyLoss.toFixed(2)}.`);
    codes.push('DAILY_LOSS_LIMIT');
  }
  if (config.dailyTakeProfit > 0 && account.dailyPnl >= config.dailyTakeProfit) {
    violations.push(`Daily take profit reached: realised ${account.dailyPnl.toFixed(2)} against a target of ${config.dailyTakeProfit.toFixed(2)}.`);
    codes.push('DAILY_TAKE_PROFIT');
  }
  if (config.maxTrades > 0 && account.tradesThisSession >= config.maxTrades) {
    violations.push(`Session trade limit reached: ${account.tradesThisSession} of ${config.maxTrades}.`);
    codes.push('MAX_TRADES');
  }
  // The open-contract count is derived from the bot's own contract list, so it
  // is the authority. `account.openExposure` used to be OR-ed in here, and a
  // settlement Deriv never repeated left it above zero, permanently blocking
  // every later entry. Exposure is still carried for reporting.
  if (input.openContracts >= config.maxOpenContracts) {
    violations.push(`${input.openContracts} contract(s) already open; the limit is ${config.maxOpenContracts}.`);
    codes.push('MAX_OPEN_CONTRACTS');
  }
  if (config.maxSessionMinutes > 0 && account.sessionStartedAt !== null) {
    const elapsedMinutes = (now - account.sessionStartedAt) / 60_000;
    if (elapsedMinutes >= config.maxSessionMinutes) {
      violations.push(`Session time limit reached: ${elapsedMinutes.toFixed(0)} of ${config.maxSessionMinutes} minutes.`);
      codes.push('SESSION_TIME_LIMIT');
    }
  }
  if (account.lastSettlementAt !== null && config.cooldownMs > 0) {
    const waited = now - account.lastSettlementAt;
    if (waited < config.cooldownMs) {
      violations.push(`Cooling down for another ${Math.ceil((config.cooldownMs - waited) / 100) / 10}s after the last settled contract.`);
      codes.push('COOLDOWN');
    }
  }
  if (input.purchaseInFlight) {
    violations.push('A purchase is already in progress on this account.');
    codes.push('PURCHASE_IN_FLIGHT');
  }
  if (input.unreconciledPurchase) {
    violations.push('A previous purchase has not been reconciled with Deriv yet; no new order is sent until the account confirms it.');
    codes.push('UNRECONCILED_PURCHASE');
  }
  if (account.balance !== null && plan.stake > account.balance) {
    violations.push(`The next stake ${plan.stake.toFixed(2)} exceeds the available balance ${account.balance.toFixed(2)}.`);
    codes.push('INSUFFICIENT_BALANCE');
  }
  if (account.currency === '' && input.accountAuthorized) {
    violations.push('The account currency has not been reported by Deriv yet.');
    codes.push('CURRENCY_UNKNOWN');
  }

  if (!violations.length) {
    notes.push(`Next order: ${plan.stake.toFixed(2)} ${account.currency || ''} ${config.duration}${config.durationUnit} on the authorized ${account.accountType === 'real' ? 'real' : 'demo'} account.`.trim());
    notes.push(...plan.notes);
  } else {
    notes.push(...plan.notes);
  }

  return {
    allowed: violations.length === 0,
    violations: [...new Set(violations)],
    notes,
    codes: [...new Set(codes)],
    stake: plan.stake,
    step: plan.step,
    maxPossibleLoss: plan.stake,
  };
}

/** Starts (or restarts) a session: counters reset, the daily figures do not. */
export function beginSession(account: RiseFallAccountState, now: number): RiseFallAccountState {
  return {
    ...rollTradingDay(account, now),
    sessionStartedAt: now,
    sessionPnl: 0,
    tradesThisSession: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    consecutiveLosses: 0,
    longestLosingStreak: 0,
    grossStake: 0,
    peakEquity: null,
    maxDrawdown: 0,
  };
}

/** Rolls the daily counters over at midnight in the browser's own timezone. */
export function rollTradingDay(account: RiseFallAccountState, now: number): RiseFallAccountState {
  const key = dayKeyOf(now);
  if (account.dayKey === key) return account;
  return { ...account, dayKey: key, dailyPnl: 0, tradesToday: 0 };
}

/**
 * Records that an order was sent and accepted.
 *
 * The local balance is deliberately untouched: Deriv deducts the stake itself
 * and reports the new balance on the receipt and on the balance stream, and
 * that report is the authority (`reconcileBalance`). Deducting here as well
 * would count the stake twice, because a settlement only ever adds the profit.
 */
export function applyPurchase(
  account: RiseFallAccountState,
  options: { stake: number; now: number },
): RiseFallAccountState {
  const stake = Number.isFinite(options.stake) ? options.stake : 0;
  return {
    ...rollTradingDay(account, options.now),
    grossStake: Math.round((account.grossStake + stake) * 1e8) / 1e8,
    openExposure: Math.round((account.openExposure + stake) * 1e8) / 1e8,
    tradesThisSession: account.tradesThisSession + 1,
    tradesToday: account.tradesToday + 1,
  };
}

export type SettlementOutcome = 'win' | 'loss' | 'push';

/**
 * Credits one Deriv settlement.
 *
 * Only realised results move the ledger: `profit` comes from Deriv's own
 * contract update, never from a potential payout shown while a contract is
 * still open. A push (exit level equal to entry) returns the stake, so it
 * breaks the losing streak without counting as a win.
 */
export function applySettlement(
  account: RiseFallAccountState,
  options: { stake: number | null; profit: number; outcome: SettlementOutcome; now: number },
): RiseFallAccountState {
  const profit = Number.isFinite(options.profit) ? Math.round(options.profit * 1e8) / 1e8 : 0;
  const stake = Number.isFinite(options.stake ?? NaN) ? (options.stake as number) : 0;
  const rolled = rollTradingDay(account, options.now);
  const consecutiveLosses = options.outcome === 'loss' ? rolled.consecutiveLosses + 1 : 0;
  const sessionPnl = Math.round((rolled.sessionPnl + profit) * 1e8) / 1e8;
  const dailyPnl = Math.round((rolled.dailyPnl + profit) * 1e8) / 1e8;
  const balance = rolled.balance === null ? null : Math.round((rolled.balance + profit) * 1e8) / 1e8;
  const equity = balance;
  const peakEquity = equity === null ? rolled.peakEquity : rolled.peakEquity === null ? equity : Math.max(rolled.peakEquity, equity);
  const drawdown = equity === null || peakEquity === null ? rolled.maxDrawdown : Math.max(rolled.maxDrawdown, Math.round((peakEquity - equity) * 1e8) / 1e8);
  return {
    ...rolled,
    openExposure: Math.max(0, Math.round((rolled.openExposure - stake) * 1e8) / 1e8),
    sessionPnl,
    dailyPnl,
    balance,
    wins: rolled.wins + (options.outcome === 'win' ? 1 : 0),
    losses: rolled.losses + (options.outcome === 'loss' ? 1 : 0),
    pushes: rolled.pushes + (options.outcome === 'push' ? 1 : 0),
    consecutiveLosses,
    longestLosingStreak: Math.max(rolled.longestLosingStreak, consecutiveLosses),
    peakEquity,
    maxDrawdown: drawdown,
    lastSettlementAt: options.now,
  };
}

/** Replaces the reported balance without touching realised profit figures. */
export function reconcileBalance(
  account: RiseFallAccountState,
  reported: number | null,
): RiseFallAccountState {
  if (reported === null || !Number.isFinite(reported)) return account;
  return { ...account, balance: reported };
}

export function setOpenExposure(account: RiseFallAccountState, exposure: number): RiseFallAccountState {
  const value = Number.isFinite(exposure) ? Math.max(0, Math.round(exposure * 1e8) / 1e8) : 0;
  return account.openExposure === value ? account : { ...account, openExposure: value };
}

export function sessionMinutesRemaining(
  config: RiseFallConfig,
  account: RiseFallAccountState,
  now: number,
): number | null {
  if (config.maxSessionMinutes <= 0 || account.sessionStartedAt === null) return null;
  return Math.max(0, config.maxSessionMinutes - (now - account.sessionStartedAt) / 60_000);
}

export function tradesRemaining(config: RiseFallConfig, account: RiseFallAccountState): number | null {
  if (config.maxTrades <= 0) return null;
  return Math.max(0, config.maxTrades - account.tradesThisSession);
}
