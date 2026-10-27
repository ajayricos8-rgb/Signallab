// Same-origin data bridge between Signal Lab and the embedded DBot workspace.
//
// Signal Lab already holds the account connection (PAT → OTP → authenticated
// socket) and the shared public tick feed for every volatility index. The
// embedded workspace runs in an iframe on the same origin, so instead of
// asking the user to link the account again we hand it the account through the
// existing single-use socket bridge, and post the ticks already collected here.
//
// Everything in this file is pure: no sockets, no React, no timers. The host
// component decides *when* to send; these functions decide *what* is sent and
// keep the per-market cursor so a live update only carries new ticks.

/** Ticks per market kept in the workspace cache (matches DBot's tick list). */
export const BRIDGE_HISTORY_LIMIT = 1_000;
/** Open positions sent to the workspace; more than this is not useful in a bot. */
export const BRIDGE_POSITION_LIMIT = 20;

/** `[epoch, quote]` keeps the wire payload small for 13 markets of history. */
export type BridgeTick = [number, number];

export type BridgeMarket = {
  symbol: string;
  name: string;
  pipSize: number | null;
  ticks: BridgeTick[];
};

export type BridgeFeedMessage = {
  type: 'signal-lab-feed';
  /** `true` replaces the workspace cache; `false` appends only new ticks. */
  reset: boolean;
  sentAt: number;
  markets: BridgeMarket[];
};

export type BridgePosition = {
  contractId: number;
  contractType: string | null;
  symbol: string | null;
  buyPrice: number | null;
  payout: number | null;
  profit: number | null;
};

export type BridgeAccountMessage = {
  type: 'signal-lab-account';
  accountId: string;
  accountType: 'demo' | 'real' | 'unknown';
  balance: number | null;
  currency: string;
  openPositions: BridgePosition[];
  /** Open positions whose live profit is known. */
  openProfit: number;
  /** Last 50 closed trades, as Signal Lab reports them. */
  realizedProfit: number;
  closedTrades: number;
  updatedAt: number;
};

/** The subset of a Signal Lab market feed entry the bridge needs. */
export type BridgeSourceMarket = {
  symbol: string;
  name?: string;
  pipSize: number | null;
  ticks: readonly { epoch: number; quote: number }[];
};

/** The subset of the trading session the bridge needs. */
export type BridgeAccountSource = {
  accountId: string;
  accountType: 'demo' | 'real' | 'unknown';
  balance: number | null;
  currency: string;
  openPositions: readonly {
    contractId: number;
    contractType: string | null;
    symbol: string | null;
    buyPrice: number | null;
    payout: number | null;
    profit: number | null;
  }[];
  closedPositions: readonly { profit: number }[];
};

/** Per-market epoch of the newest tick already sent. */
export type BridgeCursor = Record<string, number>;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sortMarkets(markets: readonly BridgeSourceMarket[]): BridgeSourceMarket[] {
  return [...markets].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function toTicks(source: readonly { epoch: number; quote: number }[], fromEpoch: number, limit: number): BridgeTick[] {
  const output: BridgeTick[] = [];
  for (const tick of source) {
    const epoch = finite(tick.epoch);
    const quote = finite(tick.quote);
    if (epoch === null || quote === null || epoch <= fromEpoch) continue;
    output.push([epoch, quote]);
  }
  return output.slice(-limit);
}

function toMarket(source: BridgeSourceMarket, ticks: BridgeTick[]): BridgeMarket {
  return {
    symbol: source.symbol,
    name: source.name?.trim() || source.symbol,
    pipSize: source.pipSize ?? null,
    ticks,
  };
}

function cursorAfter(source: readonly BridgeSourceMarket[], cursor: BridgeCursor): BridgeCursor {
  const next: BridgeCursor = { ...cursor };
  for (const market of source) {
    const last = market.ticks.at(-1);
    if (!last) continue;
    const epoch = finite(last.epoch);
    if (epoch === null) continue;
    const current = next[market.symbol] ?? 0;
    next[market.symbol] = Math.max(current, epoch);
  }
  return next;
}

/**
 * Full snapshot. Sent when the workspace first asks for data and after every
 * reload; the workspace replaces its cache with exactly this.
 */
export function buildBridgeSnapshot(
  source: readonly BridgeSourceMarket[],
  limit = BRIDGE_HISTORY_LIMIT,
  now = Date.now(),
): { message: BridgeFeedMessage | null; cursor: BridgeCursor } {
  const markets: BridgeMarket[] = [];
  for (const market of sortMarkets(source)) {
    if (!market.ticks.length) continue;
    const ticks = toTicks(market.ticks, 0, limit);
    if (ticks.length) markets.push(toMarket(market, ticks));
  }
  const cursor = cursorAfter(source, {});
  if (!markets.length) return { message: null, cursor };
  return { message: { type: 'signal-lab-feed', reset: true, sentAt: now, markets }, cursor };
}

/**
 * Incremental update. Returns `null` when no market has a newer tick, so the
 * host can skip the post entirely instead of posting empty frames every second.
 */
export function buildBridgeUpdate(
  source: readonly BridgeSourceMarket[],
  cursor: BridgeCursor,
  limit = BRIDGE_HISTORY_LIMIT,
  now = Date.now(),
): { message: BridgeFeedMessage | null; cursor: BridgeCursor } {
  const markets: BridgeMarket[] = [];
  for (const market of sortMarkets(source)) {
    const ticks = toTicks(market.ticks, cursor[market.symbol] ?? 0, limit);
    if (ticks.length) markets.push(toMarket(market, ticks));
  }
  const next = cursorAfter(source, cursor);
  if (!markets.length) return { message: null, cursor: next };
  return { message: { type: 'signal-lab-feed', reset: false, sentAt: now, markets }, cursor: next };
}

/**
 * Compact "what the workspace can see" summary for the host UI. Counts what is
 * actually shared: the newest `BRIDGE_HISTORY_LIMIT` ticks per market.
 */
export function bridgeStats(
  source: readonly BridgeSourceMarket[],
  limit = BRIDGE_HISTORY_LIMIT,
): { markets: number; ticks: number; latestEpoch: number | null } {
  let markets = 0;
  let ticks = 0;
  let latestEpoch: number | null = null;
  for (const market of source) {
    if (!market.ticks.length) continue;
    markets += 1;
    ticks += Math.min(market.ticks.length, limit);
    const epoch = finite(market.ticks.at(-1)?.epoch);
    if (epoch !== null && (latestEpoch === null || epoch > latestEpoch)) latestEpoch = epoch;
  }
  return { markets, ticks, latestEpoch };
}

/** Account state pushed to the workspace: the same account Signal Lab trades. */
export function buildAccountMessage(
  account: BridgeAccountSource,
  now = Date.now(),
): BridgeAccountMessage {
  const openPositions = account.openPositions.slice(0, BRIDGE_POSITION_LIMIT).map((position) => ({
    contractId: position.contractId,
    contractType: position.contractType,
    symbol: position.symbol,
    buyPrice: position.buyPrice,
    payout: position.payout,
    profit: position.profit,
  }));
  let openProfit = 0;
  for (const position of openPositions) openProfit += finite(position.profit) ?? 0;
  let realizedProfit = 0;
  for (const position of account.closedPositions) realizedProfit += finite(position.profit) ?? 0;
  return {
    type: 'signal-lab-account',
    accountId: account.accountId,
    accountType: account.accountType,
    balance: finite(account.balance),
    currency: account.currency || '',
    openPositions,
    openProfit,
    realizedProfit,
    closedTrades: account.closedPositions.length,
    updatedAt: now,
  };
}

/** True when two account messages would render identical state. */
export function sameAccountState(left: BridgeAccountMessage | null, right: BridgeAccountMessage): boolean {
  if (!left) return false;
  return left.accountId === right.accountId
    && left.accountType === right.accountType
    && left.balance === right.balance
    && left.currency === right.currency
    && left.openProfit === right.openProfit
    && left.realizedProfit === right.realizedProfit
    && left.closedTrades === right.closedTrades
    && left.openPositions.length === right.openPositions.length
    && left.openPositions.every((position, index) => {
      const other = right.openPositions[index];
      return other !== undefined
        && position.contractId === other.contractId
        && position.profit === other.profit;
    });
}
