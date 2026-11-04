// Deriv Options API (v1) trading protocol.
//
// Request builders and response parsers for the authenticated WebSocket
// channels. Authentication is established by Deriv's REST OTP endpoint (see
// `deriv-rest.ts`), not by an in-socket `authorize` message, so every message
// here is sent on a socket that Deriv already tied to one account.
//
// Field names follow Deriv's published JSON schemas: requests use
// `underlying_symbol` (not the legacy `symbol`) and the new-profit-table rows
// use `underlying_symbol` as well. Nothing in this module performs I/O, so the
// mapping rules can be unit tested.
import { parseFiniteNumber, parseInteger } from './deriv-digit-metadata.ts';

export type DerivDurationUnit = 't' | 's' | 'm' | 'h' | 'd';

/** Everything needed to quote and buy one contract. */
export type DerivTradeRequest = {
  contractType: string;
  symbol: string;
  currency: string;
  stake: number;
  duration: number;
  durationUnit: DerivDurationUnit;
  /** Last-digit prediction (digits) or relative barrier (rise/fall does not need one). */
  barrier?: string | null;
  /**
   * Which of the next five ticks a TICKHIGH / TICKLOW contract predicts
   * (1–5). Only sent for those contract types.
   */
  selectedTick?: number | null;
};

export type DerivQuote = {
  id: string;
  askPrice: number;
  payout: number | null;
  spot: number | null;
  spotTime: number | null;
  dateStart: number | null;
  dateExpiry: number | null;
  longcode: string | null;
};

export type DerivBuyReceipt = {
  contractId: number;
  buyPrice: number;
  payout: number | null;
  balanceAfter: number | null;
  purchaseTime: number | null;
  startTime: number | null;
  longcode: string | null;
  shortcode: string | null;
  transactionId: number | null;
};

export type DerivOpenPosition = {
  contractId: number;
  contractType: string | null;
  symbol: string | null;
  currency: string | null;
  buyPrice: number | null;
  payout: number | null;
  profit: number | null;
  profitPercentage: number | null;
  entrySpot: number | null;
  exitSpot: number | null;
  currentSpot: number | null;
  status: string | null;
  longcode: string | null;
  shortcode: string | null;
  buyTime: number | null;
  expiryTime: number | null;
  isSold: boolean;
  isExpired: boolean;
  isValidToSell: boolean;
  tickCount: number | null;
  tickPassed: number | null;
  /** `contract` rows come from the live stream and carry a current profit. */
  source: 'portfolio' | 'contract';
};

export type DerivClosedPosition = {
  contractId: number;
  contractType: string | null;
  symbol: string | null;
  currency: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  payout: number | null;
  profit: number;
  purchaseTime: number | null;
  sellTime: number | null;
  longcode: string | null;
  shortcode: string | null;
  source: 'profit-table' | 'contract';
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Removes binary floating-point noise from money that this app derives
 * (for example `sell_price - buy_price`). Values reported by Deriv are passed
 * through untouched.
 */
function derivedMoney(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e8) / 1e8 : value;
}

/** Digit contracts are rendered as digits; other barriers keep Deriv's text form. */
export function barrierFor(contractType: string, digit: number | null): string | null {
  if (contractType === 'DIGITOVER' || contractType === 'DIGITUNDER' || contractType === 'DIGITMATCH')
    return digit === null || !Number.isInteger(digit) ? null : String(digit);
  return null;
}

export function buildProposalRequest(
  request: DerivTradeRequest,
  reqId: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    proposal: 1,
    amount: request.stake,
    basis: 'stake',
    contract_type: request.contractType,
    currency: request.currency,
    duration: request.duration,
    duration_unit: request.durationUnit,
    underlying_symbol: request.symbol,
    req_id: reqId,
  };
  // The barrier is only sent when the contract family needs one. Sending
  // `barrier: undefined` would be dropped by JSON.stringify anyway, but the
  // explicit branch documents the contract rules.
  if (request.barrier) message.barrier = request.barrier;
  if (request.selectedTick !== undefined && request.selectedTick !== null) message.selected_tick = request.selectedTick;
  return message;
}

export function buildBuyRequest(quote: DerivQuote, reqId: number): Record<string, unknown> {
  // `price` is the maximum price the client accepts. The quote's ask price is
  // used so a buy never silently fills above the amount the user approved.
  return { buy: quote.id, price: quote.askPrice, req_id: reqId };
}

export function buildBalanceRequest(reqId: number): Record<string, unknown> {
  return { balance: 1, subscribe: 1, req_id: reqId };
}

export function buildPortfolioRequest(reqId: number): Record<string, unknown> {
  return { portfolio: 1, req_id: reqId };
}

export function buildContractSubscriptionRequest(reqId: number): Record<string, unknown> {
  // Without `contract_id` Deriv streams every open contract on the account.
  return { proposal_open_contract: 1, subscribe: 1, req_id: reqId };
}

export function buildProfitTableRequest(reqId: number, limit = 50): Record<string, unknown> {
  return { profit_table: 1, description: 1, limit, sort: 'DESC', req_id: reqId };
}

export function buildSellRequest(contractId: number, reqId: number): Record<string, unknown> {
  return { sell: contractId, price: 0, req_id: reqId };
}

export function parseProposalMessage(message: Record<string, unknown>): DerivQuote | null {
  const proposal = asRecord(message.proposal);
  if (!proposal) return null;
  const id = asString(proposal.id);
  const askPrice = parseFiniteNumber(proposal.ask_price);
  if (!id || askPrice === null || askPrice <= 0) return null;
  return {
    id,
    askPrice,
    payout: parseFiniteNumber(proposal.payout),
    spot: parseFiniteNumber(proposal.spot),
    spotTime: parseInteger(proposal.spot_time),
    dateStart: parseInteger(proposal.date_start),
    dateExpiry: parseInteger(proposal.date_expiry),
    longcode: asString(proposal.longcode),
  };
}

export function parseBuyMessage(message: Record<string, unknown>): DerivBuyReceipt | null {
  const buy = asRecord(message.buy);
  if (!buy) return null;
  const contractId = parseInteger(buy.contract_id);
  const buyPrice = parseFiniteNumber(buy.buy_price);
  if (contractId === null || contractId <= 0 || buyPrice === null) return null;
  return {
    contractId,
    buyPrice,
    payout: parseFiniteNumber(buy.payout),
    balanceAfter: parseFiniteNumber(buy.balance_after),
    purchaseTime: parseInteger(buy.purchase_time),
    startTime: parseInteger(buy.start_time),
    longcode: asString(buy.longcode),
    shortcode: asString(buy.shortcode),
    transactionId: parseInteger(buy.transaction_id),
  };
}

export function parseBalanceMessage(
  message: Record<string, unknown>,
): { balance: number; currency: string | null } | null {
  const balance = asRecord(message.balance);
  if (!balance) return null;
  const value = parseFiniteNumber(balance.balance);
  if (value === null) return null;
  return { balance: value, currency: asString(balance.currency) };
}

function flag(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

/** Maps a `proposal_open_contract` payload (stream or one-shot). */
export function parseContractMessage(message: Record<string, unknown>): DerivOpenPosition | null {
  const contract = asRecord(message.proposal_open_contract);
  if (!contract) return null;
  const contractId = parseInteger(contract.contract_id);
  if (contractId === null || contractId <= 0) return null;
  const isSold = flag(contract.is_sold);
  const buyPrice = parseFiniteNumber(contract.buy_price);
  const sellPrice = parseFiniteNumber(contract.sell_price);
  // Profit is reported by Deriv; when it is absent the only verified fallback
  // is a settled sell price against the buy price.
  let profit = parseFiniteNumber(contract.profit);
  if (profit === null && isSold && buyPrice !== null && sellPrice !== null) profit = derivedMoney(sellPrice - buyPrice);
  return {
    contractId,
    contractType: asString(contract.contract_type),
    symbol: asString(contract.underlying_symbol) ?? asString(contract.symbol),
    currency: asString(contract.currency),
    buyPrice,
    payout: parseFiniteNumber(contract.payout),
    profit,
    profitPercentage: parseFiniteNumber(contract.profit_percentage),
    entrySpot: parseFiniteNumber(contract.entry_spot),
    exitSpot: parseFiniteNumber(contract.exit_spot),
    currentSpot: parseFiniteNumber(contract.current_spot),
    status: asString(contract.status),
    longcode: asString(contract.longcode),
    shortcode: asString(contract.shortcode),
    buyTime: parseInteger(contract.date_start) ?? parseInteger(contract.purchase_time),
    expiryTime: parseInteger(contract.date_expiry) ?? parseInteger(contract.expiry_time),
    isSold,
    isExpired: flag(contract.is_expired),
    isValidToSell: flag(contract.is_valid_to_sell),
    tickCount: parseInteger(contract.tick_count),
    tickPassed: parseInteger(contract.tick_passed),
    source: 'contract',
  };
}

/** Maps a `portfolio` response into open positions. Portfolio rows are open contracts only. */
export function parsePortfolioMessage(message: Record<string, unknown>): DerivOpenPosition[] {
  const portfolio = asRecord(message.portfolio);
  const list = portfolio ? portfolio.contracts : null;
  if (!Array.isArray(list)) return [];
  const positions: DerivOpenPosition[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (!item) continue;
    const contractId = parseInteger(item.contract_id);
    if (contractId === null || contractId <= 0) continue;
    positions.push({
      contractId,
      contractType: asString(item.contract_type),
      symbol: asString(item.underlying_symbol) ?? asString(item.symbol),
      currency: asString(item.currency),
      buyPrice: parseFiniteNumber(item.buy_price),
      payout: parseFiniteNumber(item.payout),
      profit: null,
      profitPercentage: null,
      entrySpot: parseFiniteNumber(item.entry_spot) ?? parseFiniteNumber(item.entry_tick),
      exitSpot: null,
      currentSpot: null,
      status: null,
      longcode: asString(item.longcode),
      shortcode: asString(item.shortcode),
      buyTime: parseInteger(item.date_start) ?? parseInteger(item.purchase_time),
      expiryTime: parseInteger(item.expiry_time) ?? parseInteger(item.date_expiry),
      isSold: false,
      isExpired: false,
      isValidToSell: false,
      tickCount: null,
      tickPassed: null,
      source: 'portfolio',
    });
  }
  return positions;
}

/** Maps a `profit_table` response. The v1 schema reports a sell price, not a profit field. */
export function parseProfitTableMessage(message: Record<string, unknown>): DerivClosedPosition[] {
  const profitTable = asRecord(message.profit_table);
  const list = profitTable ? profitTable.transactions : null;
  if (!Array.isArray(list)) return [];
  const rows: DerivClosedPosition[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (!item) continue;
    const contractId = parseInteger(item.contract_id);
    const buyPrice = parseFiniteNumber(item.buy_price);
    const sellPrice = parseFiniteNumber(item.sell_price);
    if (contractId === null || contractId <= 0 || buyPrice === null || sellPrice === null) continue;
    const declared = parseFiniteNumber(item.profit);
    rows.push({
      contractId,
      contractType: asString(item.contract_type),
      symbol: asString(item.underlying_symbol) ?? asString(item.symbol),
      currency: asString(item.currency),
      buyPrice,
      sellPrice,
      payout: parseFiniteNumber(item.payout),
      profit: declared ?? derivedMoney(sellPrice - buyPrice),
      purchaseTime: parseInteger(item.purchase_time) ?? parseInteger(item.date_start),
      sellTime: parseInteger(item.sell_time) ?? parseInteger(item.date_expiry),
      longcode: asString(item.longcode),
      shortcode: asString(item.shortcode),
      source: 'profit-table',
    });
  }
  return rows;
}

/** Field-level merge that refuses to erase a known value with a null. */
function mergeDefined<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && value !== undefined) next[key] = value;
  }
  return next as T;
}

function newestFirst<T>(rows: T[], timeOf: (row: T) => number | null): T[] {
  return [...rows].sort((left, right) => (timeOf(right) ?? 0) - (timeOf(left) ?? 0));
}

/**
 * Applies a `portfolio` snapshot without discarding the richer live values that
 * the contract stream already delivered for the same contract.
 */
export function mergePortfolioPositions(
  current: DerivOpenPosition[],
  rows: DerivOpenPosition[],
): DerivOpenPosition[] {
  const streamById = new Map(
    current.filter((position) => position.source === 'contract').map((position) => [position.contractId, position]),
  );
  const next: DerivOpenPosition[] = rows.map((row) => {
    const live = streamById.get(row.contractId);
    if (!live) return row;
    return mergeDefined({ ...row }, {
      profit: live.profit,
      profitPercentage: live.profitPercentage,
      currentSpot: live.currentSpot,
      status: live.status ?? row.status,
      entrySpot: live.entrySpot ?? row.entrySpot,
      isValidToSell: live.isValidToSell,
      tickCount: live.tickCount ?? row.tickCount,
      tickPassed: live.tickPassed ?? row.tickPassed,
      // Keep the stream row so live profit keeps arriving until it settles.
      source: 'contract' as const,
    });
  });
  // A contract bought moments ago can be missing from a portfolio snapshot that
  // was already in flight; keep it on screen until Deriv reports it.
  for (const position of current) {
    if (position.isSold) continue;
    if (!next.some((row) => row.contractId === position.contractId)) next.push(position);
  }
  return newestFirst(next, (position) => position.buyTime ?? position.expiryTime);
}

/** Inserts or refreshes one open contract from the live stream. */
export function upsertOpenPosition(
  current: DerivOpenPosition[],
  update: DerivOpenPosition,
): DerivOpenPosition[] {
  const index = current.findIndex((position) => position.contractId === update.contractId);
  if (index === -1) return newestFirst([update, ...current], (position) => position.buyTime ?? position.expiryTime);
  const next = [...current];
  next[index] = mergeDefined({ ...next[index] }, update);
  return next;
}

export function removeOpenPosition(current: DerivOpenPosition[], contractId: number): DerivOpenPosition[] {
  return current.filter((position) => position.contractId !== contractId);
}

/** Deduplicates history rows, preferring the most complete record per contract. */
export function mergeClosedPositions(
  current: DerivClosedPosition[],
  incoming: DerivClosedPosition[],
): DerivClosedPosition[] {
  const byId = new Map(current.map((row) => [row.contractId, row]));
  for (const row of incoming) {
    const existing = byId.get(row.contractId);
    byId.set(
      row.contractId,
      existing
        ? mergeDefined({ ...existing }, {
            ...row,
            buyPrice: row.buyPrice ?? existing.buyPrice,
            payout: row.payout ?? existing.payout,
          })
        : row,
    );
  }
  return newestFirst([...byId.values()], (row) => row.sellTime ?? row.purchaseTime);
}

/** A settled position derived from the live stream, used until profit history catches up. */
export function contractToClosedPosition(position: DerivOpenPosition): DerivClosedPosition {
  return {
    contractId: position.contractId,
    contractType: position.contractType,
    symbol: position.symbol,
    currency: position.currency,
    buyPrice: position.buyPrice,
    sellPrice:
      position.profit !== null && position.buyPrice !== null
        ? derivedMoney(position.buyPrice + position.profit)
        : null,
    payout: position.payout,
    profit: position.profit ?? 0,
    purchaseTime: position.buyTime,
    sellTime: null,
    longcode: position.longcode,
    shortcode: position.shortcode,
    source: 'contract',
  };
}

/** A pending position derived from a buy receipt, shown until portfolio/stream data arrives. */
export function receiptToOpenPosition(receipt: DerivBuyReceipt, request: DerivTradeRequest): DerivOpenPosition {
  return {
    contractId: receipt.contractId,
    contractType: request.contractType,
    symbol: request.symbol,
    currency: request.currency,
    buyPrice: receipt.buyPrice,
    payout: receipt.payout,
    profit: null,
    profitPercentage: null,
    entrySpot: null,
    exitSpot: null,
    currentSpot: null,
    status: 'open',
    longcode: receipt.longcode,
    shortcode: receipt.shortcode,
    buyTime: receipt.startTime ?? receipt.purchaseTime,
    expiryTime: null,
    isSold: false,
    isExpired: false,
    isValidToSell: false,
    tickCount: null,
    tickPassed: null,
    source: 'contract',
  };
}

/** Deriv reports failures as `{ error: { code, message } }` on the socket. */
export function parseErrorMessage(message: Record<string, unknown>): string | null {
  const error = asRecord(message.error);
  if (!error) return null;
  return asString(error.message) ?? asString(error.code) ?? 'Deriv rejected the request.';
}

export function formatAmount(value: number | null | undefined, currency: string | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const amount = value.toFixed(decimals);
  return currency ? `${amount} ${currency}` : amount;
}

export function formatSignedAmount(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatAmount(value, currency)}`;
}

export function formatEpochTime(epoch: number | null | undefined): string {
  if (epoch === null || epoch === undefined || !Number.isFinite(epoch) || epoch <= 0) return '—';
  return new Date(epoch * 1_000).toLocaleTimeString();
}

export function formatEpochDateTime(epoch: number | null | undefined): string {
  if (epoch === null || epoch === undefined || !Number.isFinite(epoch) || epoch <= 0) return '—';
  return new Date(epoch * 1_000).toLocaleString();
}
