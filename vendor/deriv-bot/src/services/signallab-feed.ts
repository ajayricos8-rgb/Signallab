/**
 * Signal Lab data bridge (inside the embedded workspace).
 *
 * Signal Lab runs the shared public tick feed for every volatility index and
 * owns the authenticated Options session. The DBot frame is same-origin, so the
 * parent posts what it already has instead of paying for a second set of
 * sockets: ticks per market (history + live) and the account snapshot
 * (balance, currency, open positions, realised profit).
 *
 * Read-only by design — this module never holds a token and never places an
 * order. Trading stays on DBot's own authenticated socket, which is opened for
 * the same account by the same-origin account bridge. The blocks and the bot
 * runtime only read from the cache below.
 */

export type SignalLabTick = { epoch: number; quote: number };

export type SignalLabMarket = {
    symbol: string;
    name: string;
    pipSize: number | null;
    ticks: SignalLabTick[];
    updatedAt: number;
};

export type SignalLabPosition = {
    contractId: number;
    contractType: string | null;
    symbol: string | null;
    buyPrice: number | null;
    payout: number | null;
    profit: number | null;
};

export type SignalLabAccount = {
    accountId: string;
    accountType: 'demo' | 'real' | 'unknown';
    balance: number | null;
    currency: string;
    openPositions: SignalLabPosition[];
    openProfit: number;
    realizedProfit: number;
    closedTrades: number;
    updatedAt: number;
};

/** Keep the same window DBot's own "Ticks list" block reports. */
const TICK_LIMIT = 1_000;
const REQUEST_RETRY_MS = 4_000;
const DATA_WAIT_MS = 8_000;

let markets = new Map<string, SignalLabMarket>();
let account: SignalLabAccount | null = null;
let connected = false;
let listening = false;
let retryTimer: number | undefined;
let requestSequence = 0;
const listeners = new Set<() => void>();

/** Fallback order when the workspace opens before the parent has sent data. */
export const FALLBACK_MARKETS: Array<[string, string]> = [
    ['R_10', 'Volatility 10 Index'],
    ['R_25', 'Volatility 25 Index'],
    ['R_50', 'Volatility 50 Index'],
    ['R_75', 'Volatility 75 Index'],
    ['R_100', 'Volatility 100 Index'],
    ['1HZ10V', 'Volatility 10 (1s) Index'],
    ['1HZ15V', 'Volatility 15 (1s) Index'],
    ['1HZ25V', 'Volatility 25 (1s) Index'],
    ['1HZ30V', 'Volatility 30 (1s) Index'],
    ['1HZ50V', 'Volatility 50 (1s) Index'],
    ['1HZ75V', 'Volatility 75 (1s) Index'],
    ['1HZ90V', 'Volatility 90 (1s) Index'],
    ['1HZ100V', 'Volatility 100 (1s) Index'],
];

const isEmbedded = () => typeof window !== 'undefined' && window.parent !== window;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function notify() {
    listeners.forEach(listener => {
        try {
            listener();
        } catch {
            // A failing listener must not stop the cache from updating.
        }
    });
}

/** Subscribe to cache changes (ticks or account). Returns an unsubscribe. */
export function subscribeSignalLabFeed(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function mergeTicks(market: SignalLabMarket, incoming: SignalLabTick[], reset: boolean) {
    const base = reset ? [] : market.ticks;
    const last = base.at(-1)?.epoch ?? 0;
    const merged = base.slice();
    let appended = 0;
    for (const tick of incoming) {
        if (tick.epoch <= last) {
            // A correction for an epoch already held: replace it in place.
            const index = merged.findIndex(item => item.epoch === tick.epoch);
            if (index >= 0) merged[index] = tick;
            continue;
        }
        merged.push(tick);
        appended += 1;
    }
    if (!reset && appended === 0 && incoming.length === 0) return false;
    market.ticks = merged.length > TICK_LIMIT ? merged.slice(-TICK_LIMIT) : merged;
    market.updatedAt = Date.now();
    return true;
}

function applyFeed(data: Record<string, unknown>) {
    const reset = data.reset === true;
    const incoming = Array.isArray(data.markets) ? data.markets : [];
    if (reset) markets = new Map();
    let changed = false;
    for (const raw of incoming) {
        const entry = asRecord(raw);
        if (!entry || typeof entry.symbol !== 'string' || !entry.symbol) continue;
        const symbol = entry.symbol;
        const ticks: SignalLabTick[] = [];
        if (Array.isArray(entry.ticks)) {
            for (const tick of entry.ticks) {
                if (!Array.isArray(tick) || tick.length < 2) continue;
                const [epoch, quote] = tick;
                if (!isFiniteNumber(epoch) || !isFiniteNumber(quote)) continue;
                ticks.push({ epoch, quote });
            }
        }
        const current = markets.get(symbol) ?? {
            symbol,
            name: typeof entry.name === 'string' && entry.name ? entry.name : symbol,
            pipSize: isFiniteNumber(entry.pipSize) ? entry.pipSize : null,
            ticks: [],
            updatedAt: 0,
        };
        if (typeof entry.name === 'string' && entry.name) current.name = entry.name;
        if (isFiniteNumber(entry.pipSize)) current.pipSize = entry.pipSize;
        if (!ticks.length && !current.ticks.length) continue;
        if (mergeTicks(current, ticks, reset)) changed = true;
        markets.set(symbol, current);
    }
    if (reset) connected = incoming.length > 0;
    else if (incoming.length) connected = true;
    if (reset || changed || incoming.length) notify();
}

function applyAccount(data: Record<string, unknown>) {
    if (typeof data.accountId !== 'string' || !data.accountId) {
        account = null;
        notify();
        return;
    }
    const positions: SignalLabPosition[] = [];
    if (Array.isArray(data.openPositions)) {
        for (const raw of data.openPositions) {
            const position = asRecord(raw);
            if (!position || !isFiniteNumber(position.contractId)) continue;
            positions.push({
                contractId: position.contractId,
                contractType: typeof position.contractType === 'string' ? position.contractType : null,
                symbol: typeof position.symbol === 'string' ? position.symbol : null,
                buyPrice: isFiniteNumber(position.buyPrice) ? position.buyPrice : null,
                payout: isFiniteNumber(position.payout) ? position.payout : null,
                profit: isFiniteNumber(position.profit) ? position.profit : null,
            });
        }
    }
    account = {
        accountId: data.accountId,
        accountType:
            data.accountType === 'demo' || data.accountType === 'real' ? data.accountType : 'unknown',
        balance: isFiniteNumber(data.balance) ? data.balance : null,
        currency: typeof data.currency === 'string' ? data.currency : '',
        openPositions: positions,
        openProfit: isFiniteNumber(data.openProfit) ? data.openProfit : 0,
        realizedProfit: isFiniteNumber(data.realizedProfit) ? data.realizedProfit : 0,
        closedTrades: isFiniteNumber(data.closedTrades) ? data.closedTrades : 0,
        updatedAt: isFiniteNumber(data.updatedAt) ? data.updatedAt : Date.now(),
    };
    notify();
}

function requestFeed() {
    if (!isEmbedded()) return;
    requestSequence += 1;
    window.parent.postMessage(
        { source: 'signal-lab-dbot', type: 'feed-subscribe', requestId: requestSequence },
        window.location.origin
    );
}

function startRequesting() {
    if (!isEmbedded() || retryTimer !== undefined) return;
    // The parent answers with a full snapshot. Retry a few times while the
    // workspace is still booting, then rely on the live updates.
    let attempts = 0;
    const tick = () => {
        attempts += 1;
        if (markets.size) {
            window.clearInterval(retryTimer);
            retryTimer = undefined;
            return;
        }
        requestFeed();
        if (attempts >= 15) {
            window.clearInterval(retryTimer);
            retryTimer = undefined;
        }
    };
    tick();
    retryTimer = window.setInterval(tick, REQUEST_RETRY_MS);
}

/** Wire the parent channel. Safe to call more than once. */
export function connectSignalLabBridge() {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    if (!isEmbedded()) return;
    window.addEventListener('message', (event: MessageEvent) => {
        if (event.origin !== window.location.origin || event.source !== window.parent) return;
        const data = asRecord(event.data);
        if (!data || data.source !== 'signal-lab') return;
        if (data.type === 'signal-lab-feed') applyFeed(data);
        else if (data.type === 'signal-lab-account') applyAccount(data);
        else if (data.type === 'signal-lab-bridge') {
            // The parent unlinked the account or closed the bridge: drop the
            // cache so no stale balance or position survives in the workspace.
            if (data.live === false) {
                account = null;
                markets = new Map();
                connected = false;
                notify();
            }
        }
    });
    startRequesting();
}

/** Marker set once the parent has sent at least one snapshot. */
export const isSignalLabConnected = () => connected;

export function getSignalLabMarkets(): SignalLabMarket[] {
    return [...markets.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

/** `[[label, value]]` for a Blockly dropdown, with a static fallback. */
export function getSignalLabMarketOptions(): Array<[string, string]> {
    const options = getSignalLabMarkets().map(
        market => [`${market.name} (${market.symbol})`, market.symbol] as [string, string]
    );
    return options.length ? options : FALLBACK_MARKETS;
}

export function getSignalLabMarket(symbol: string): SignalLabMarket | null {
    return markets.get(symbol) ?? null;
}

export function getSignalLabTicks(symbol: string): number[] {
    return (markets.get(symbol)?.ticks ?? []).map(tick => tick.quote);
}

export function getSignalLabTickEpochs(symbol: string): number[] {
    return (markets.get(symbol)?.ticks ?? []).map(tick => tick.epoch);
}

/** Decimal places implied by a pip size (0.01 → 2). */
export function decimalsFor(pipSize: number | null): number {
    if (pipSize === null || !Number.isFinite(pipSize) || pipSize <= 0) return 2;
    const text = pipSize.toFixed(10).replace(/0+$/, '');
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
}

export function lastDigitOf(quote: number, pipSize: number | null): number {
    const text = quote.toFixed(decimalsFor(pipSize));
    const digit = Number(text.replace(/[^0-9]/g, '').slice(-1));
    return Number.isFinite(digit) ? digit : 0;
}

export function getSignalLabLastTick(symbol: string): number | null {
    const ticks = markets.get(symbol)?.ticks;
    return ticks && ticks.length ? ticks[ticks.length - 1].quote : null;
}

export function getSignalLabLastDigit(symbol: string): number | null {
    const market = markets.get(symbol);
    const last = market?.ticks.at(-1);
    if (!market || !last) return null;
    return lastDigitOf(last.quote, market.pipSize);
}

/** Net move over the last `count` ticks (newest minus oldest in that window). */
export function getSignalLabTickChange(symbol: string, count: number): number | null {
    const ticks = markets.get(symbol)?.ticks;
    const span = Math.max(1, Math.floor(count));
    if (!ticks || ticks.length < 2) return null;
    const newest = ticks[ticks.length - 1].quote;
    const oldest = ticks[Math.max(0, ticks.length - 1 - span)].quote;
    return newest - oldest;
}

export function getSignalLabAccount(): SignalLabAccount | null {
    return account;
}

export function getSignalLabBalance(): number | null {
    return account?.balance ?? null;
}

export function getSignalLabOpenPositions(): SignalLabPosition[] {
    return account?.openPositions ?? [];
}

/**
 * Wait until a market has ticks (the snapshot may still be in flight when a bot
 * starts). Rejects with a message the bot's log can show instead of trading on
 * invented data.
 */
export async function waitForSignalLabTicks(symbol: string, timeoutMs = DATA_WAIT_MS): Promise<SignalLabTick[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ticks = markets.get(symbol)?.ticks;
        if (ticks && ticks.length) return ticks;
        if (Date.now() >= deadline) {
            throw new Error(
                `Signal Lab has no ticks for ${symbol} yet. Open Signal Lab once so its feed can load, then run the bot again.`
            );
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
    }
}

export async function waitForSignalLabAccount(timeoutMs = DATA_WAIT_MS): Promise<SignalLabAccount> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (account) return account;
        if (Date.now() >= deadline) {
            throw new Error(
                'Signal Lab is not connected to an account. Connect an account in Signal Lab — DBot links it automatically.'
            );
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
    }
}

/** True when this frame is embedded in Signal Lab (the bridge is available). */
export const hasSignalLabParent = isEmbedded;
