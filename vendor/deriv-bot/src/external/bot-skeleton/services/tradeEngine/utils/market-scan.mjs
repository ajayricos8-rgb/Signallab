/**
 * Vision Lab — the AI multi-market scan.
 *
 * A Deriv contract is bought on one symbol, so every preset trades one market
 * at a time. What the bot can still do is *read* every market before it
 * decides where to stand: Signal Lab already streams thirteen volatility
 * indices into this frame, and the decision models are pure functions of a
 * tick array, so the same ensemble that prices the live contract can price
 * all thirteen in about the time one tick takes to print.
 *
 * That is what this module is: the part of the scan that can be tested
 * without a trade engine. Nothing here places an order — it ranks markets,
 * decides whether moving is worth it, and reports. The strategy still owns
 * the purchase, and the decision models are untouched: the scan calls the
 * same `parityDecision` / `priceDecision` the bot trades on, so the ranking
 * and the trade agree by construction.
 *
 *   - `scoreRead` turns a decision (parity or price) into one 0–100 number
 *     that means the same thing on every market.
 *   - `rankReads` ranks a whole scan and remembers each market's score and
 *     rank, so a journal line can say where the bot stands.
 *   - `chooseScanTarget` decides whether to move, with a floor, a margin and
 *     a dwell time: a switch trades a warm tick stream for a cold one, so the
 *     challenger has to win by more than noise.
 *   - `createCadenceClock` is the "at least one entry a minute" clock. It
 *     watches the engine's own run counter, so a bot that has not traded for
 *     a minute can say so — and a strategy can relax its *soft* quality gates
 *     instead of idling forever. It never relaxes a money gate; that is the
 *     caller's job to keep.
 */

/** Quotes a market needs before the scan will read it at all. */
export const SCAN_MIN_TICKS = 60;

/**
 * Quotes per market handed to the models. The parity replay is bounded to 500
 * ticks internally and the price models are dominated by the recent window, so
 * a deeper history buys nothing and costs latency on every scan.
 */
export const SCAN_TICK_LIMIT = 700;

/** Freshness a shared tick stream needs before it may be scored. */
export const SCAN_STALE_MS = 15_000;

/** Seconds between two full scans when the strategy does not say. */
export const DEFAULT_SCAN_INTERVAL_S = 8;

/** The score a market has to reach before the scan will move onto it. */
export const DEFAULT_SCAN_FLOOR = 25;

/** How much better the challenger must read than the incumbent. */
export const DEFAULT_SCAN_MARGIN = 3;

/** Seconds the bot stays on a market before the scan may move it again. */
export const DEFAULT_SCAN_DWELL_S = 25;

/** Seconds without a purchase before the cadence asks for an entry. */
export const DEFAULT_CADENCE_S = 60;

/** The contract families the scan knows how to score. */
export const SCAN_FAMILIES = ['even-odd', 'over-under', 'high-low-tick', 'rise-fall'];

const safe = (value, fallback = 0) => {
    const parsed = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, low, high) => Math.min(Math.max(safe(value, low), low), high);

const round = (value, digits = 1) => {
    const factor = 10 ** digits;
    return Math.round(safe(value, 0) * factor) / factor;
};

/** One of `SCAN_FAMILIES`; anything else reads as parity. */
export function normalizeScanFamily(family) {
    const value = String(family ?? '').trim().toLowerCase();
    return SCAN_FAMILIES.includes(value) ? value : 'even-odd';
}

/** The contract mode the price models want for a scan family. */
export function scanMode(family) {
    return normalizeScanFamily(family) === 'high-low-tick' ? 'tick' : 'rise';
}

/**
 * One 0–100 read on how worth trading a market is.
 *
 * The five terms are the same five the shipped scout prints, so a scan score
 * and a scout score mean the same thing: measured expected value, the
 * engine's own certainty, the DNA readability, the sample behind the read,
 * and the blend's walk-forward skill. It ranks markets; it is not a forecast
 * of profit. Over/Under plans are scored by `scoreMarket` in vision-markets
 * instead — the plan carries its own lean, confidence and agreement — so a
 * cross-family comparison is still one comparable number.
 */
export function scoreRead(decision, dna = null) {
    if (!decision || decision.modelReady === false) return 0;
    // A dead tape scores nothing: its phantom edge is what the frozen veto
    // exists to refuse, and the scan must walk away from it, not toward it.
    if ((dna || decision.dna)?.phase === 'frozen') return 0;
    const report = dna || decision.dna || null;
    const ev = Number.isFinite(decision.ev) ? clamp(decision.ev, -0.2, 0.2) : 0;
    const evScore = clamp((ev + 0.05) / 0.15, 0, 1);
    const certainty = clamp(safe(decision.certainty, 0) / 100, 0, 1);
    const readability = clamp(safe(report?.readability, decision.dnaScore) / 100, 0, 1);
    const sample = clamp(safe(decision.samples, 0) / 600, 0, 1);
    const skill = clamp((50 + 200 * safe(decision.skill, 0)) / 100, 0, 1);
    return round(100 * (0.35 * evScore + 0.2 * certainty + 0.15 * readability + 0.15 * sample + 0.15 * skill), 1);
}

/**
 * Rank a scan. `reads` is `[{ symbol, score, decision }]`; the returned maps
 * are what the value blocks read back, so a strategy can gate on "am I on the
 * best market, and by how much".
 */
export function rankReads(reads = []) {
    const rows = (Array.isArray(reads) ? reads : [])
        .filter(row => row && typeof row.symbol === 'string' && row.symbol)
        .map(row => ({ ...row, score: round(row.score, 1) }))
        .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol));
    const scores = new Map(rows.map(row => [row.symbol, row.score]));
    const rank = new Map(rows.map((row, index) => [row.symbol, index + 1]));
    return { ordered: rows, scores, rank, count: rows.length, best: rows[0]?.symbol ?? '' };
}

/**
 * Should the bot leave the market it is on?
 *
 * The order of the checks is the point:
 *
 *   1. nothing readable was scanned — stay, and say so;
 *   2. the dwell has not passed — stay, however bad the market reads, because
 *      a switch costs a tick stream and a payout table;
 *   3. the incumbent is already the best — stay;
 *   4. the best read is under the floor — stay, the whole scan is cold;
 *   5. the best read does not beat the incumbent by the margin — stay, that is
 *      selection noise, not a better market.
 *
 * Only then does it move. The returned `reason` is the journal line.
 */
export function chooseScanTarget({
    current = '',
    currentScore = null,
    ordered = [],
    scores = null,
    floor = DEFAULT_SCAN_FLOOR,
    margin = DEFAULT_SCAN_MARGIN,
    dwellOk = true,
} = {}) {
    const rows = Array.isArray(ordered) ? ordered.filter(Boolean) : [];
    const best = rows[0];
    if (!best) {
        return { symbol: current, switched: false, reason: 'no readable market in the scan — staying put' };
    }
    const bestScore = round(best.score, 1);
    const mine = currentScore === null || currentScore === undefined
        ? (typeof scores?.get === 'function' ? scores.get(current) ?? null : null)
        : round(currentScore, 1);
    const stay = reason => ({ symbol: current, switched: false, best: best.symbol, bestScore, currentScore: mine, reason });
    if (!dwellOk) return stay(`staying on ${current || 'this market'} — the dwell time has not passed`);
    if (best.symbol === current) return stay(`${current} is the strongest read (${bestScore.toFixed(1)})`);
    const minimum = clamp(floor, 0, 100);
    if (bestScore < minimum) {
        return stay(`best read ${best.symbol} ${bestScore.toFixed(1)} is under the ${minimum.toFixed(0)} floor`);
    }
    // An unscored incumbent (not shared by Signal Lab, or just switched to)
    // only has to clear the floor; a scored one has to lose by the margin.
    const bar = mine === null ? minimum : mine + Math.max(0, safe(margin, 0));
    if (bestScore < bar) {
        return stay(
            `${best.symbol} ${bestScore.toFixed(1)} does not beat ${current} ${mine === null ? '—' : mine.toFixed(1)} by ${safe(margin, 0)}`
        );
    }
    return {
        symbol: best.symbol,
        switched: true,
        best: best.symbol,
        bestScore,
        currentScore: mine,
        reason: `moving to ${best.symbol} — ${bestScore.toFixed(1)} vs ${current || '—'} ${mine === null ? '—' : mine.toFixed(1)}`,
    };
}

/** One journal line for the scan: the ranking and where the bot stands. */
export function scanReport(state = {}) {
    const ordered = Array.isArray(state.ordered) ? state.ordered : [];
    if (!ordered.length) return String(state.reason || 'AI scan · no readable market yet');
    const top = ordered
        .slice(0, 4)
        .map(row => `${row.symbol} ${round(row.score, 1).toFixed(1)}`)
        .join(' · ');
    const head = `AI scan · ${ordered.length} markets · ${top}`;
    const tail = state.current ? ` · standing on ${state.current}` : '';
    const note = state.reason ? ` · ${state.reason}` : '';
    return `${head}${tail}${note}`;
}

/**
 * The "at least one entry a minute" clock.
 *
 * It does not trigger anything by itself: it reports that the bot has gone a
 * whole interval without a purchase, so a strategy can relax the gates that
 * are *about quality* (a DNA floor, a confidence bar) while every money gate
 * — stake, loss limit, profit target, drawdown, trade cap — stays exactly as
 * configured. The engine's own run counter is what marks a trade, so a purchase
 * made by any block in any section resets the clock without the strategy having
 * to remember to call anything.
 */
export function createCadenceClock({ now = () => Date.now(), gapSeconds = DEFAULT_CADENCE_S, runs = 0 } = {}) {
    let lastTradeAt = null;
    const startedAt = now();
    let runsSeen = Math.max(0, Math.round(safe(runs, 0)));

    /** Feed the engine's run counter; a rise means a contract was bought. */
    const observe = value => {
        const current = Math.max(0, Math.round(safe(value, 0)));
        if (current > runsSeen) lastTradeAt = now();
        // A counter that went backwards is a new run, not a trade.
        runsSeen = current;
        return lastTradeAt;
    };

    const anchor = () => lastTradeAt ?? startedAt;

    return {
        get lastTradeAt() {
            return lastTradeAt;
        },
        get runs() {
            return runsSeen;
        },
        observe,
        secondsSinceTrade: () => Math.max(0, (now() - anchor()) / 1000),
        /** True when `gap` seconds have passed with no purchase. */
        due(gap = gapSeconds) {
            const seconds = Math.max(0, safe(gap, gapSeconds));
            if (seconds <= 0) return true;
            return (now() - anchor()) / 1000 >= seconds;
        },
        /** Record a purchase the engine counter cannot see (paper or hedged legs). */
        mark() {
            lastTradeAt = now();
            return lastTradeAt;
        },
    };
}

export default {
    SCAN_MIN_TICKS,
    SCAN_TICK_LIMIT,
    SCAN_STALE_MS,
    DEFAULT_SCAN_INTERVAL_S,
    DEFAULT_SCAN_FLOOR,
    DEFAULT_SCAN_MARGIN,
    DEFAULT_SCAN_DWELL_S,
    DEFAULT_CADENCE_S,
    SCAN_FAMILIES,
    normalizeScanFamily,
    scanMode,
    scoreRead,
    rankReads,
    chooseScanTarget,
    scanReport,
    createCadenceClock,
};
