// ENGINES K & L — Deriv execution engine and live contract monitoring engine.
//
// The module is the deterministic half of order placement: it owns decision
// identifiers, the in-flight lock, duplicate-purchase protection, the
// unreconciled-purchase state that survives reconnects, and the conversion of
// Deriv contract updates into settlements. Network calls live in the hook that
// drives these transitions, so every rule here is unit testable.
import { extractFinalDigit, type DigitObservation } from '../digit-analysis.ts';
import type { DerivBuyReceipt, DerivOpenPosition } from '../deriv-trading.ts';
import { normalizeMoney } from './expectancy.ts';
import type { BotMode, MonitoredContract, PurchaseOutcome, TradeIntent } from './types.ts';

export type ExecutionStage = 'idle' | 'purchasing' | 'unreconciled';

export type ExecutionState = {
  sequence: number;
  stage: ExecutionStage;
  inFlight: { decisionId: string; intent: TradeIntent; startedAt: number } | null;
  /** Bounded FIFO of decision ids that already produced a purchase. */
  purchasedDecisionIds: string[];
  lastOutcome: PurchaseOutcome | null;
  /** Kept until the account state confirms what happened to that order. */
  unreconciled: PurchaseOutcome | null;
  contracts: MonitoredContract[];
  monitoringRequested: boolean;
};

const PURCHASE_HISTORY = 50;

export function createExecutionState(): ExecutionState {
  return {
    sequence: 0,
    stage: 'idle',
    inFlight: null,
    purchasedDecisionIds: [],
    lastOutcome: null,
    unreconciled: null,
    contracts: [],
    monitoringRequested: false,
  };
}

/** Unique, monotonic decision identifier used for idempotent order handling. */
export function nextDecisionId(state: ExecutionState, now: number, symbol: string): { state: ExecutionState; decisionId: string } {
  const sequence = state.sequence + 1;
  return { state: { ...state, sequence }, decisionId: `bot-${now.toString(36)}-${sequence}-${symbol}` };
}

export function hasPurchasedDecision(state: ExecutionState, decisionId: string): boolean {
  return state.purchasedDecisionIds.includes(decisionId);
}

export type BeginPurchaseResult = { state: ExecutionState; ok: boolean; message: string };

/**
 * Takes the single-flight lock. A second purchase cannot start until the first
 * one is confirmed, failed with certainty, or reconciled.
 */
export function beginPurchase(state: ExecutionState, intent: TradeIntent, now: number): BeginPurchaseResult {
  if (state.unreconciled) {
    return { state, ok: false, message: 'A previous purchase has not been reconciled with Deriv yet.' };
  }
  if (state.stage !== 'idle' || state.inFlight) {
    return { state, ok: false, message: 'A purchase is already in progress on this account.' };
  }
  if (hasPurchasedDecision(state, intent.decisionId)) {
    return { state, ok: false, message: 'This decision already purchased a contract; duplicate orders are blocked.' };
  }
  return {
    state: { ...state, stage: 'purchasing', inFlight: { decisionId: intent.decisionId, intent, startedAt: now } },
    ok: true,
    message: 'Purchase lock acquired.',
  };
}

/** Confirms a purchase using Deriv's own receipt. */
export function completePurchase(state: ExecutionState, intent: TradeIntent, receipt: DerivBuyReceipt, now: number): { state: ExecutionState; outcome: PurchaseOutcome } {
  const outcome: PurchaseOutcome = {
    status: 'confirmed',
    decisionId: intent.decisionId,
    contractId: receipt.contractId,
    buyPrice: receipt.buyPrice,
    payout: receipt.payout,
    balanceAfter: receipt.balanceAfter,
    message: `Deriv confirmed contract ${receipt.contractId} for ${receipt.buyPrice}.`,
    at: now,
  };
  return {
    state: {
      ...state,
      stage: 'idle',
      inFlight: null,
      lastOutcome: outcome,
      purchasedDecisionIds: [...state.purchasedDecisionIds, intent.decisionId].slice(-PURCHASE_HISTORY),
      contracts: upsertMonitoredContract(state.contracts, receiptToMonitored(receipt, intent, now)),
      monitoringRequested: true,
    },
    outcome,
  };
}

/**
 * Records a failure. When the failure is uncertain (a timeout or a dropped
 * socket after the request was sent) the decision stays unreconciled so the
 * account is checked before any further order is attempted.
 */
export function failPurchase(
  state: ExecutionState,
  intent: TradeIntent,
  message: string,
  now: number,
  options: { uncertain: boolean },
): { state: ExecutionState; outcome: PurchaseOutcome } {
  const outcome: PurchaseOutcome = {
    status: options.uncertain ? 'timeout' : 'rejected',
    decisionId: intent.decisionId,
    contractId: null,
    buyPrice: null,
    payout: null,
    balanceAfter: null,
    message,
    at: now,
  };
  return {
    state: {
      ...state,
      stage: options.uncertain ? 'unreconciled' : 'idle',
      inFlight: null,
      lastOutcome: outcome,
      unreconciled: options.uncertain ? outcome : state.unreconciled,
    },
    outcome,
  };
}

/** Cancels the in-flight lock without recording a rejection (connection loss). */
export function abandonInFlight(state: ExecutionState, message: string, now: number): ExecutionState {
  if (!state.inFlight) return state;
  const outcome: PurchaseOutcome = {
    status: 'unreconciled',
    decisionId: state.inFlight.decisionId,
    contractId: null,
    buyPrice: null,
    payout: null,
    balanceAfter: null,
    message,
    at: now,
  };
  return { ...state, stage: 'unreconciled', inFlight: null, lastOutcome: outcome, unreconciled: outcome };
}

function receiptToMonitored(receipt: DerivBuyReceipt, intent: TradeIntent, now: number): MonitoredContract {
  return {
    contractId: receipt.contractId,
    decisionId: intent.decisionId,
    contractType: intent.contractType,
    symbol: intent.symbol,
    currency: intent.currency,
    buyPrice: receipt.buyPrice,
    payout: receipt.payout,
    stake: receipt.buyPrice,
    barrierDigit: intent.barrierDigit,
    entrySpot: null,
    exitSpot: null,
    currentSpot: null,
    entryDigit: null,
    exitDigit: null,
    profit: null,
    status: 'open',
    purchaseTime: receipt.purchaseTime ?? receipt.startTime ?? now,
    expiryTime: null,
    isSold: false,
    lastUpdateAt: now,
    settledProfit: null,
    settledAt: null,
    mode: intent.mode,
  };
}

export function upsertMonitoredContract(contracts: readonly MonitoredContract[], update: MonitoredContract): MonitoredContract[] {
  const index = contracts.findIndex((contract) => contract.contractId === update.contractId);
  if (index === -1) return [update, ...contracts];
  const merged = { ...contracts[index] };
  for (const [key, value] of Object.entries(update)) {
    if (value !== null && value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return contracts.map((contract, position) => (position === index ? merged : contract));
}

export function removeMonitoredContract(contracts: readonly MonitoredContract[], contractId: number): MonitoredContract[] {
  return contracts.filter((contract) => contract.contractId !== contractId);
}

export type Settlement = { contractId: number; stake: number | null; profit: number; symbol: string | null; exitDigit: number | null };

/**
 * Converts a Deriv `proposal_open_contract` update into the local monitored
 * record. A payout shown while the contract is open is an indication only —
 * `settledProfit` stays null until Deriv reports the contract as sold.
 */
export function applyContractUpdate(
  state: ExecutionState,
  position: DerivOpenPosition,
  options: { now: number; pipSize: number | null; mode: BotMode },
): { state: ExecutionState; settled: Settlement | null; contract: MonitoredContract | null } {
  const existing = state.contracts.find((contract) => contract.contractId === position.contractId) ?? null;
  const digit = (spot: number | null): number | null => (spot === null || options.pipSize === null ? null : extractFinalDigit(spot, options.pipSize));
  const settledProfit = position.isSold ? position.profit : null;
  const contract: MonitoredContract = {
    contractId: position.contractId,
    decisionId: existing?.decisionId ?? null,
    contractType: position.contractType ?? existing?.contractType ?? null,
    symbol: position.symbol ?? existing?.symbol ?? null,
    currency: position.currency ?? existing?.currency ?? null,
    buyPrice: position.buyPrice ?? existing?.buyPrice ?? null,
    payout: position.payout ?? existing?.payout ?? null,
    stake: position.buyPrice ?? existing?.stake ?? null,
    barrierDigit: existing?.barrierDigit ?? null,
    entrySpot: position.entrySpot ?? existing?.entrySpot ?? null,
    exitSpot: position.exitSpot ?? existing?.exitSpot ?? null,
    currentSpot: position.currentSpot ?? existing?.currentSpot ?? null,
    entryDigit: existing?.entryDigit ?? digit(position.entrySpot ?? null),
    exitDigit: digit(position.exitSpot ?? null) ?? existing?.exitDigit ?? null,
    profit: position.profit ?? existing?.profit ?? null,
    status: position.status ?? existing?.status ?? null,
    purchaseTime: position.buyTime ?? existing?.purchaseTime ?? null,
    expiryTime: position.expiryTime ?? existing?.expiryTime ?? null,
    isSold: position.isSold,
    lastUpdateAt: options.now,
    settledProfit: settledProfit ?? existing?.settledProfit ?? null,
    settledAt: position.isSold ? (existing?.settledAt ?? options.now) : existing?.settledAt ?? null,
    mode: existing?.mode ?? options.mode,
  };
  const contracts = upsertMonitoredContract(state.contracts, contract);
  const settled: Settlement | null = position.isSold && position.profit !== null
    ? { contractId: position.contractId, stake: contract.stake, profit: normalizeMoney(position.profit), symbol: contract.symbol, exitDigit: contract.exitDigit }
    : null;
  const alreadySettled = existing?.settledProfit !== null && existing?.settledProfit !== undefined;
  return {
    state: { ...state, contracts, monitoringRequested: !position.isSold },
    settled: settled && !alreadySettled ? settled : null,
    contract,
  };
}

/**
 * Reconciles account state after a timeout, reconnect or restart.
 *
 * Any open contract on the account that the bot does not know about is adopted
 * so its settlement is still monitored, and a purchase whose receipt never
 * arrived is matched to the contract it produced using the purchase time.
 */
export function reconcileWithPortfolio(
  state: ExecutionState,
  positions: readonly DerivOpenPosition[],
  options: { now: number; mode: BotMode },
): { state: ExecutionState; adopted: number[]; resolved: PurchaseOutcome | null } {
  let contracts = [...state.contracts];
  const adopted: number[] = [];
  for (const position of positions) {
    if (position.isSold) continue;
    if (contracts.some((contract) => contract.contractId === position.contractId)) continue;
    contracts = upsertMonitoredContract(contracts, {
      contractId: position.contractId,
      decisionId: null,
      contractType: position.contractType,
      symbol: position.symbol,
      currency: position.currency,
      buyPrice: position.buyPrice,
      payout: position.payout,
      stake: position.buyPrice,
      barrierDigit: null,
      entrySpot: position.entrySpot,
      exitSpot: null,
      currentSpot: null,
      entryDigit: null,
      exitDigit: null,
      profit: null,
      status: position.status ?? 'open',
      purchaseTime: position.buyTime,
      expiryTime: position.expiryTime,
      isSold: false,
      lastUpdateAt: options.now,
      settledProfit: null,
      settledAt: null,
      mode: options.mode,
    });
    adopted.push(position.contractId);
  }

  let resolved: PurchaseOutcome | null = null;
  let unreconciled = state.unreconciled;
  let purchasedDecisionIds = state.purchasedDecisionIds;
  if (unreconciled) {
    const match = contracts.find((contract) =>
      contract.decisionId === unreconciled!.decisionId
      || (unreconciled!.at - 180_000 <= (contract.purchaseTime ?? 0) * 1_000 && (contract.purchaseTime ?? 0) * 1_000 <= unreconciled!.at + 180_000));
    if (match) {
      resolved = {
        ...unreconciled,
        status: 'confirmed',
        contractId: match.contractId,
        buyPrice: match.buyPrice,
        payout: match.payout,
        message: `The unconfirmed purchase was reconciled with contract ${match.contractId} on the account.`,
        at: options.now,
      };
      unreconciled = null;
      purchasedDecisionIds = [...purchasedDecisionIds, resolved.decisionId].slice(-PURCHASE_HISTORY);
      contracts = contracts.map((contract) => (contract.contractId === match.contractId ? { ...contract, decisionId: resolved!.decisionId } : contract));
    }
  }

  return {
    state: {
      ...state,
      contracts,
      unreconciled,
      purchasedDecisionIds,
      lastOutcome: resolved ?? state.lastOutcome,
      stage: unreconciled ? 'unreconciled' : 'idle',
    },
    adopted,
    resolved,
  };
}

/** Clears an unreconciled purchase once the account proves nothing was bought. */
export function clearUnreconciled(state: ExecutionState, message: string, now: number): ExecutionState {
  if (!state.unreconciled) return state;
  return {
    ...state,
    unreconciled: null,
    stage: 'idle',
    lastOutcome: { ...state.unreconciled, status: 'rejected', message, at: now },
  };
}

export function openContractCount(state: ExecutionState): number {
  return state.contracts.filter((contract) => !contract.isSold).length;
}

export function openExposure(state: ExecutionState): number {
  return normalizeMoney(state.contracts.filter((contract) => !contract.isSold).reduce((total, contract) => total + (contract.stake ?? 0), 0));
}

/** True when the contract's own settlement digit matches the contract result. */
export function settlementMatchesRule(contract: MonitoredContract): boolean | null {
  if (contract.exitDigit === null || contract.settledProfit === null) return null;
  const won = contract.settledProfit > 0;
  switch (contract.contractType) {
    case 'DIGITEVEN':
      return won === (contract.exitDigit % 2 === 0);
    case 'DIGITODD':
      return won === (contract.exitDigit % 2 === 1);
    case 'DIGITOVER':
      return contract.barrierDigit === null ? null : won === (contract.exitDigit > contract.barrierDigit);
    case 'DIGITUNDER':
      return contract.barrierDigit === null ? null : won === (contract.exitDigit < contract.barrierDigit);
    case 'DIGITMATCH':
      return contract.barrierDigit === null ? null : won === (contract.exitDigit === contract.barrierDigit);
    default:
      return null;
  }
}

export type PaperSettlement = { won: boolean; exitDigit: number; profit: number; at: number };

/**
 * Resolves a simulated (paper) entry using the same strict boundary rules as
 * the real contract, from the digit observed at the entry epoch plus the
 * configured tick duration. Paper results are never mixed with live ones.
 */
export function settlePaperContract(
  contract: MonitoredContract,
  ticks: readonly DigitObservation[],
  durationTicks: number,
): PaperSettlement | null {
  if (contract.stake === null || !Number.isFinite(contract.stake)) return null;
  if (contract.contractType === null || contract.purchaseTime === null) return null;
  const entryIndex = ticks.findIndex((tick) => tick.epoch * 1_000 >= contract.purchaseTime!);
  if (entryIndex < 0) return null;
  const settlementIndex = entryIndex + durationTicks;
  if (settlementIndex >= ticks.length) return null;
  const settlementTick = ticks[settlementIndex];
  const exitDigit = settlementTick.digit;
  const barrier = contract.barrierDigit;
  let won = false;
  switch (contract.contractType) {
    case 'DIGITEVEN':
      won = exitDigit % 2 === 0;
      break;
    case 'DIGITODD':
      won = exitDigit % 2 === 1;
      break;
    case 'DIGITOVER':
      won = barrier !== null && exitDigit > barrier;
      break;
    case 'DIGITUNDER':
      won = barrier !== null && exitDigit < barrier;
      break;
    case 'DIGITMATCH':
      won = barrier !== null && exitDigit === barrier;
      break;
    default:
      return null;
  }
  const profit = won ? normalizeMoney((contract.payout ?? contract.stake) - contract.stake) : normalizeMoney(-contract.stake);
  return { won, exitDigit, profit, at: settlementTick.epoch * 1_000 };
}
