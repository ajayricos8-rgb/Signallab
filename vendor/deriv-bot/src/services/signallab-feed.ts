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

export type SignalLabAnalysisFamily = 'rise-fall' | 'over-under' | 'even-odd' | 'matches';
export type SignalLabAnalysisEntry = {
    action: 'enter-now' | 'enter-on-trigger' | 'no-edge';
    trigger: 'immediate' | 'quote' | 'digit';
    windowTicks: number;
    priceLevel: number | null;
    priceCondition: 'above' | 'below' | null;
    tolerance: number | null;
    contextDigits: number[];
};
export type SignalLabAnalysisSnapshot = {
    analysisId: string;
    family: SignalLabAnalysisFamily;
    symbol: string;
    contractType: string;
    barrier: number | null;
    targetDigit: number | null;
    generatedAt: number;
    asOfEpoch: number;
    maxAgeMs: number;
    validForTicks: number;
    tradeable: boolean;
    entry: SignalLabAnalysisEntry;
};

/** Family the cross-market scan is scored for. */
export type SignalLabScanFamily = 'rise-fall' | 'over-under' | 'even-odd' | 'matches';

/** Result of the last `signalLabScanMarkets` call, read back by the scan blocks. */
export type SignalLabScanState = {
    family: SignalLabScanFamily;
    duration: number;
    minScore: number;
    best: string;
    scores: Map<string, number>;
    rank: Map<string, number>;
    count: number;
    tradeable: boolean;
    ranAt: number;
};

/** A single virtual position opened with the virtual blocks. */
export type SignalLabVirtualPosition = {
    symbol: string;
    direction: string;
    stake: number;
    payout: number;
    barrier: number;
    quote: number;
    digit: number;
    epoch: number;
};

/** Module-level virtual ledger, reset whenever the shared feed is reset. */
let virtualLedger: {
    balance: number;
    profit: number;
    runs: number;
    wins: number;
    positions: SignalLabVirtualPosition[];
} = { balance: 10_000, profit: 0, runs: 0, wins: 0, positions: [] };

/** Keep the same window DBot's own "Ticks list" block reports. */
const TICK_LIMIT = 1_000;
const DATA_STALE_MS = 15_000;
const REQUEST_RETRY_MS = 4_000;
// A bot can start the moment the workspace opens, before the parent's first
// snapshot lands. Thirty seconds covers a cold feed; after that the waiters
// below resolve empty instead of throwing (see their doc comments).
const DATA_WAIT_MS = 30_000;

let markets = new Map<string, SignalLabMarket>();
let account: SignalLabAccount | null = null;
let analysis: SignalLabAnalysisSnapshot | null = null;
/** Last cross-market scan result, refreshed by `signalLabScanMarkets`. */
let scan: SignalLabScanState | null = null;
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
    if (reset) {
        markets = new Map();
        analysis = null;
        scan = null;
        virtualLedger = { balance: 10_000, profit: 0, runs: 0, wins: 0, positions: [] };
    }
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
const analysisFamilies: SignalLabAnalysisFamily[] = ['rise-fall', 'over-under', 'even-odd', 'matches'];
const contractFamilies: Record<SignalLabAnalysisFamily, string[]> = {
    'rise-fall': ['CALL', 'PUT'],
    'over-under': ['DIGITOVER', 'DIGITUNDER'],
    'even-odd': ['DIGITEVEN', 'DIGITODD'],
    matches: ['DIGITMATCH'],
};

function parseAnalysisSnapshot(value: unknown): SignalLabAnalysisSnapshot | null {
    const record = asRecord(value);
    const rawEntry = asRecord(record?.entry);
    if (!record || !rawEntry) return null;
    const family = record.family;
    const symbol = typeof record.symbol === 'string' ? record.symbol.trim().toUpperCase() : '';
    const contractType = typeof record.contractType === 'string' ? record.contractType.trim().toUpperCase() : '';
    const analysisId = typeof record.analysisId === 'string' ? record.analysisId.trim().slice(0, 180) : '';
    const action = rawEntry.action;
    const trigger = rawEntry.trigger;
    const priceCondition = rawEntry.priceCondition;
    const generatedAt = record.generatedAt;
    const asOfEpoch = record.asOfEpoch;
    const maxAgeMs = record.maxAgeMs;
    const validForTicks = record.validForTicks;
    const windowTicks = rawEntry.windowTicks;
    const barrier = record.barrier === null
        ? null
        : isFiniteNumber(record.barrier) && Number.isInteger(record.barrier) && record.barrier >= 1 && record.barrier <= 8
            ? record.barrier
            : undefined;
    const targetDigit = record.targetDigit === null
        ? null
        : isFiniteNumber(record.targetDigit) && Number.isInteger(record.targetDigit) && record.targetDigit >= 0 && record.targetDigit <= 9
            ? record.targetDigit
            : undefined;
    if (!analysisFamilies.includes(family as SignalLabAnalysisFamily)
        || !/^(?:R_\d{1,3}|1HZ\d{1,3}V)$/.test(symbol)
        || !analysisId
        || !contractFamilies[family as SignalLabAnalysisFamily].includes(contractType)
        || barrier === undefined || targetDigit === undefined
        || (family === 'over-under' ? barrier === null : barrier !== null)
        || (family === 'matches' ? targetDigit === null : targetDigit !== null)
        || !isFiniteNumber(generatedAt) || generatedAt <= 0
        || !isFiniteNumber(asOfEpoch) || asOfEpoch <= 0
        || !isFiniteNumber(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 900_000
        || !isFiniteNumber(validForTicks) || validForTicks < 1 || validForTicks > 500
        // The entry window used to be capped at 50 ticks. Loading the
        // strategy, confirming it and booting the bot can eat most of that on
        // a 1-second market, so the gate expired before the first Purchase
        // conditions ran and the bot watched forever without trading. The
        // snapshot's own validForTicks (≤500) is still the hard expiry.
        || !isFiniteNumber(windowTicks) || windowTicks < 1 || windowTicks > 500
        || (action !== 'enter-now' && action !== 'enter-on-trigger' && action !== 'no-edge')
        || (trigger !== 'immediate' && trigger !== 'quote' && trigger !== 'digit')
        || (priceCondition !== null && priceCondition !== 'above' && priceCondition !== 'below')) return null;

    const priceLevel = rawEntry.priceLevel === null ? null : isFiniteNumber(rawEntry.priceLevel) ? rawEntry.priceLevel : null;
    const tolerance = rawEntry.tolerance === null ? null : isFiniteNumber(rawEntry.tolerance) && rawEntry.tolerance >= 0 ? rawEntry.tolerance : null;
    const contextDigits = Array.isArray(rawEntry.contextDigits)
        ? [...new Set(rawEntry.contextDigits.filter((digit): digit is number => isFiniteNumber(digit) && Number.isInteger(digit) && digit >= 0 && digit <= 9))]
        : [];
    if (action === 'enter-on-trigger' && trigger === 'immediate') return null;
    if (trigger === 'quote' && (priceLevel === null || priceCondition === null)) return null;
    if (trigger === 'digit' && contextDigits.length === 0) return null;
    return {
        analysisId,
        family: family as SignalLabAnalysisFamily,
        symbol,
        contractType,
        barrier,
        targetDigit,
        generatedAt,
        asOfEpoch,
        maxAgeMs,
        validForTicks: Math.floor(validForTicks),
        tradeable: record.tradeable === true,
        entry: {
            action: action as SignalLabAnalysisEntry['action'],
            trigger: trigger as SignalLabAnalysisEntry['trigger'],
            windowTicks: Math.floor(windowTicks),
            priceLevel,
            priceCondition: priceCondition as SignalLabAnalysisEntry['priceCondition'],
            tolerance,
            contextDigits,
        },
    };
}

/** Set or clear the one analysis snapshot a generated DBot strategy may use. */
export function setSignalLabAnalysisSnapshot(value: unknown): boolean {
    if (value === null || value === undefined) {
        analysis = null;
        notify();
        return true;
    }
    const next = parseAnalysisSnapshot(value);
    analysis = next;
    notify();
    return next !== null;
}

export function getSignalLabAnalysisSnapshot(): SignalLabAnalysisSnapshot | null {
    return analysis;
}

/**
 * Why the live entry gate is open or closed, in one line. The gate itself is
 * `reason === 'ok'`; the text exists so a strategy (or the journal) can say
 * exactly which condition is holding entries closed instead of a bot that
 * visibly runs yet never trades. The purchase block remains the only code
 * that can place an order.
 */
export function getSignalLabAnalysisGateReason(
    family: string,
    symbol: string,
    analysisId: string,
    contractType: string,
    barrier: number,
    targetDigit: number,
): string {
    const snapshot = analysis;
    const market = markets.get(String(symbol));
    if (!connected) return 'Signal Lab feed is not connected to this workspace yet.';
    if (!snapshot) return 'No Signal Lab analysis is loaded. Run Analysis, then Load and Run.';
    if (!market || !market.ticks.length) return `Signal Lab has no ticks for ${String(symbol)} yet.`;
    if (snapshot.tradeable !== true) return 'The loaded analysis is marked not tradeable.';
    if (snapshot.family !== family) return `The loaded analysis is for ${snapshot.family}, not ${String(family)}.`;
    if (snapshot.symbol !== symbol) return `The loaded analysis is for ${snapshot.symbol}, not ${String(symbol)}.`;
    if (snapshot.analysisId !== analysisId) return 'The loaded analysis key does not match this strategy (it was built from a different analysis run).';
    if (snapshot.contractType !== contractType) return `The loaded analysis trades ${snapshot.contractType}, not ${String(contractType)}.`;
    if (snapshot.family === 'over-under' && snapshot.barrier !== barrier) return `The loaded analysis barrier is ${snapshot.barrier}, not ${barrier}.`;
    if (snapshot.family === 'matches' && snapshot.targetDigit !== targetDigit) return `The loaded analysis target digit is ${snapshot.targetDigit}, not ${targetDigit}.`;
    const now = Date.now();
    if (now < snapshot.generatedAt - 60_000) return 'The loaded analysis is timestamped in the future; run a fresh analysis.';
    if (now - snapshot.generatedAt > snapshot.maxAgeMs) return 'The loaded analysis is older than its 15-minute limit; run a fresh analysis.';
    if (now - market.updatedAt > DATA_STALE_MS) return `The shared ${snapshot.symbol} feed has gone stale; waiting for fresh Signal Lab ticks.`;
    const elapsedTicks = market.ticks.reduce((count, tick) => count + (tick.epoch > snapshot.asOfEpoch ? 1 : 0), 0);
    if (snapshot.entry.action === 'no-edge') return 'The loaded analysis carries no entry; run a fresh analysis.';
    if (elapsedTicks > snapshot.validForTicks) return `The analysis entry expired after ${snapshot.validForTicks} ticks (${elapsedTicks} have printed); run a fresh analysis.`;
    if (snapshot.entry.action === 'enter-now') {
        return snapshot.entry.trigger === 'immediate' ? 'ok' : 'The loaded analysis entry is malformed (enter-now without an immediate trigger).';
    }
    if (elapsedTicks > snapshot.entry.windowTicks) return `The measured entry window closed after ${snapshot.entry.windowTicks} ticks (${elapsedTicks} have printed).`;
    if (snapshot.entry.trigger === 'digit') {
        const digit = getSignalLabLastDigit(snapshot.symbol);
        if (digit === null) return 'Waiting for the next tick to read its last digit.';
        return snapshot.entry.contextDigits.includes(digit)
            ? 'ok'
            : `Waiting for a tick ending in ${snapshot.entry.contextDigits.join(' or ')} (last digit ${digit}).`;
    }
    if (snapshot.entry.trigger === 'quote') {
        const quote = getSignalLabLastTick(snapshot.symbol);
        if (quote === null || snapshot.entry.priceLevel === null || !snapshot.entry.priceCondition) return 'Waiting for a live quote at the entry level.';
        const distance = snapshot.entry.priceCondition === 'below'
            ? quote - snapshot.entry.priceLevel
            : snapshot.entry.priceLevel - quote;
        if (distance > 0) return `Waiting for the quote to trade ${snapshot.entry.priceCondition} ${snapshot.entry.priceLevel} (now ${quote}).`;
        const overshoot = -distance;
        if (snapshot.entry.tolerance !== null && overshoot > snapshot.entry.tolerance) return `The quote overshot the entry level ${snapshot.entry.priceLevel} by more than the no-chase band.`;
        return 'ok';
    }
    return 'The loaded analysis entry trigger is not recognised.';
}

/**
 * Live entry gate for the generated Blockly strategy. It requires the exact
 * analysis key and market, a fresh feed, an unexpired measured window and the
 * analysis engine's current quote/digit trigger.
 */
export function getSignalLabAnalysisGate(
    family: string,
    symbol: string,
    analysisId: string,
    contractType: string,
    barrier: number,
    targetDigit: number,
): boolean {
    return getSignalLabAnalysisGateReason(family, symbol, analysisId, contractType, barrier, targetDigit) === 'ok';
}

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
        else if (data.type === 'signal-lab-analysis') setSignalLabAnalysisSnapshot(data.analysis);
        else if (data.type === 'clear-analysis') setSignalLabAnalysisSnapshot(null);
        else if (data.type === 'signal-lab-bridge') {
            // The parent unlinked the account or closed the bridge: drop the
            // cache so no stale balance or position survives in the workspace.
            if (data.live === false) {
                account = null;
                analysis = null;
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

/* ------------------------------------------------------------------ *
 * Cross-market scan — the "all markets" blocks.
 *
 * The scan is deliberately lightweight: it reads the tick cache Signal Lab
 * already shared with this workspace and scores every market with the same
 * one-line statistic. It never opens a socket and never places an order. A
 * strategy runs it once (in tick_analysis or before_purchase) and then reads
 * the best market, its score, its rank and whether it cleared the floor.
 * ------------------------------------------------------------------ */

const SCAN_FAMILIES: SignalLabScanFamily[] = ['rise-fall', 'over-under', 'even-odd', 'matches'];

function normalizeScanFamily(family: unknown): SignalLabScanFamily {
    const value = String(family ?? '').trim().toLowerCase();
    return (SCAN_FAMILIES as string[]).includes(value) ? (value as SignalLabScanFamily) : 'rise-fall';
}

/**
 * One signed lean in [-1, 1]: the share of the last `duration` ticks that
 * moved the family's way. Rise/Fall uses the quote's direction, the digit
 * families use the last digit's parity and distance from the middle.
 */
function scanLean(
    family: SignalLabScanFamily,
    ticks: SignalLabTick[],
    pipSize: number | null,
    duration: number,
): number | null {
    if (ticks.length < 2) return null;
    const span = Math.max(2, Math.min(ticks.length, Math.floor(duration)));
    let total = 0;
    let count = 0;
    if (family === 'rise-fall') {
        for (let index = ticks.length - span + 1; index < ticks.length; index += 1) {
            const move = ticks[index].quote - ticks[index - 1].quote;
            if (move > 0) total += 1;
            else if (move < 0) total -= 1;
            count += 1;
        }
    } else {
        for (let index = ticks.length - span; index < ticks.length; index += 1) {
            const digit = lastDigitOf(ticks[index].quote, pipSize);
            if (family === 'even-odd') total += digit % 2 === 0 ? 1 : -1;
            else total += digit > 4 ? 1 : digit < 4 ? -1 : 0;
            count += 1;
        }
    }
    return count ? total / count : 0;
}

/** Score every shared market and remember the strongest one. Returns the count. */
export function signalLabScanMarkets(family: unknown, duration: unknown, minScore: unknown): number {
    const normalized = normalizeScanFamily(family);
    const span = Math.max(1, Math.min(500, Math.floor(Number(duration) || 1)));
    const floor = Math.max(0, Math.min(1, Number(minScore) || 0));
    const scores = new Map<string, number>();
    for (const market of markets.values()) {
        if (!market.ticks.length) continue;
        const lean = scanLean(normalized, market.ticks, market.pipSize, span);
        if (lean === null) continue;
        scores.set(market.symbol, lean);
    }
    const ranked = [...scores.entries()].sort(
        (left, right) => Math.abs(right[1]) - Math.abs(left[1]) || left[0].localeCompare(right[0]),
    );
    const rank = new Map<string, number>();
    ranked.forEach((entry, index) => rank.set(entry[0], index + 1));
    const bestLean = ranked[0]?.[1] ?? 0;
    scan = {
        family: normalized,
        duration: span,
        minScore: floor,
        best: ranked[0]?.[0] ?? '',
        scores,
        rank,
        count: ranked.length,
        tradeable: Math.abs(bestLean) >= floor,
        ranAt: Date.now(),
    };
    notify();
    return ranked.length;
}

export function signalLabScanBest(): string {
    return scan?.best ?? '';
}

export function signalLabScanScore(symbol: string): number {
    return scan?.scores.get(String(symbol).trim().toUpperCase()) ?? 0;
}

export function signalLabScanRank(symbol: string): number {
    return scan?.rank.get(String(symbol).trim().toUpperCase()) ?? 0;
}

export function signalLabScanCount(): number {
    return scan?.count ?? 0;
}

export function signalLabScanTradeable(): boolean {
    return scan?.tradeable ?? false;
}

export function getSignalLabScanState(): SignalLabScanState | null {
    return scan;
}

/* ------------------------------------------------------------------ *
 * Hedging blocks — read the open positions Signal Lab reports and let a
 * strategy decide whether a hedge is balanced. They never place an order.
 * ------------------------------------------------------------------ */

export function signalLabHedgeLegs(symbol: string): number {
    const target = String(symbol ?? '').trim().toUpperCase();
    return getSignalLabOpenPositions()
        .filter(position => (position.symbol ?? '').toUpperCase() === target)
        .length;
}

export function signalLabHedgePairs(symbol: string): number {
    return Math.floor(signalLabHedgeLegs(symbol) / 2);
}

export function signalLabHedgeBalanced(symbol: string): boolean {
    return signalLabHedgeLegs(symbol) % 2 === 0;
}

export function signalLabHedgeCount(): number {
    return getSignalLabOpenPositions().length;
}

export function signalLabHedgeProfit(): number {
    return account?.openProfit ?? 0;
}

/* ------------------------------------------------------------------ *
 * Virtual blocks — a paper ledger a strategy can trade against without ever
 * sending an order. `signalLabVirtualBuy` opens a position at the live quote;
 * `signalLabVirtualSettle` resolves every open position against the latest
 * tick and books the win or loss.
 * ------------------------------------------------------------------ */

const VIRTUAL_DIRECTIONS = ['rise', 'fall', 'over', 'under', 'even', 'odd', 'match'];

function normalizeVirtualDirection(direction: unknown): string {
    const value = String(direction ?? '').trim().toLowerCase();
    return VIRTUAL_DIRECTIONS.includes(value) ? value : 'rise';
}

function virtualWins(position: SignalLabVirtualPosition, quote: number, digit: number): boolean {
    switch (position.direction) {
        case 'rise': return quote > position.quote;
        case 'fall': return quote < position.quote;
        case 'over': return digit > position.barrier;
        case 'under': return digit < position.barrier;
        case 'even': return digit % 2 === 0;
        case 'odd': return digit % 2 === 1;
        case 'match': return digit === position.barrier;
        default: return false;
    }
}

export function signalLabVirtualBuy(
    symbol: unknown,
    direction: unknown,
    stake: unknown,
    payout: unknown,
    barrier: unknown,
): boolean {
    const target = String(symbol ?? '').trim().toUpperCase();
    const market = markets.get(target);
    const last = market?.ticks.at(-1);
    if (!market || !last) return false;
    virtualLedger.positions.push({
        symbol: target,
        direction: normalizeVirtualDirection(direction),
        stake: Math.max(0, Number(stake) || 0),
        payout: Math.max(0, Number(payout) || 0),
        barrier: Math.max(0, Math.floor(Number(barrier) || 0)),
        quote: last.quote,
        digit: lastDigitOf(last.quote, market.pipSize),
        epoch: last.epoch,
    });
    notify();
    return true;
}

/** Resolve every open virtual position against the latest tick. Returns the count. */
export function signalLabVirtualSettle(): number {
    const remaining: SignalLabVirtualPosition[] = [];
    let settled = 0;
    for (const position of virtualLedger.positions) {
        const market = markets.get(position.symbol);
        const last = market?.ticks.at(-1);
        if (!market || !last) {
            remaining.push(position);
            continue;
        }
        const quote = last.quote;
        const digit = lastDigitOf(quote, market.pipSize);
        const won = virtualWins(position, quote, digit);
        virtualLedger.profit += won ? position.stake * position.payout : -position.stake;
        virtualLedger.runs += 1;
        if (won) virtualLedger.wins += 1;
        settled += 1;
    }
    virtualLedger.positions = remaining;
    notify();
    return settled;
}

export function signalLabVirtualReset(): void {
    virtualLedger = { balance: 10_000, profit: 0, runs: 0, wins: 0, positions: [] };
    notify();
}

export function signalLabVirtualProfit(): number {
    return virtualLedger.profit;
}

export function signalLabVirtualRuns(): number {
    return virtualLedger.runs;
}

export function signalLabVirtualWins(): number {
    return virtualLedger.wins;
}

export function signalLabVirtualOpen(): number {
    return virtualLedger.positions.length;
}

export function signalLabVirtualBalance(): number {
    return virtualLedger.balance + virtualLedger.profit;
}

export function getSignalLabVirtualLedger(): typeof virtualLedger {
    return virtualLedger;
}

/**
 * Wait until a market has ticks (the snapshot may still be in flight when a
 * bot starts), resolving with an empty list after the timeout. This used to
 * THROW: inside the bot interpreter that error either killed the run or —
 * with "restart on error" enabled — restarted the strategy from the top
 * every few seconds, so the bot visibly ran forever without ever reaching a
 * Purchase block. A read-only data block must never be able to do that; an
 * empty result simply makes the strategy's own conditions read "no data yet"
 * and it re-checks on the next tick.
 */
export async function waitForSignalLabTicks(symbol: string, timeoutMs = DATA_WAIT_MS): Promise<SignalLabTick[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ticks = markets.get(symbol)?.ticks;
        if (ticks && ticks.length) return ticks;
        if (Date.now() >= deadline) return [];
        await new Promise(resolve => window.setTimeout(resolve, 250));
    }
}

/**
 * Wait for the shared account snapshot, resolving with `null` after the
 * timeout (never throwing — see `waitForSignalLabTicks`). Callers map a null
 * account to neutral read values so account blocks cannot kill a run.
 */
export async function waitForSignalLabAccount(timeoutMs = DATA_WAIT_MS): Promise<SignalLabAccount | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (account) return account;
        if (Date.now() >= deadline) return null;
        await new Promise(resolve => window.setTimeout(resolve, 250));
    }
}

/** True when this frame is embedded in Signal Lab (the bridge is available). */
export const hasSignalLabParent = isEmbedded;
