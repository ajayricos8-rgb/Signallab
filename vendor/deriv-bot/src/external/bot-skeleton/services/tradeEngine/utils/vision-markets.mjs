/**
 * Vision Lab — choosing which market to stand on.
 *
 * Kept pure and separate from the interface on purpose. The first version of
 * this lived inside `Bot.visionAutoMarket` where nothing could call it without
 * a live trade engine, so the one bug that mattered — a dwell clock that never
 * started, which pinned the bot to its opening market forever — shipped
 * untested. Here the clock is injected, so a test can move time.
 */

const clamp = (value, low, high) => Math.min(Math.max(Number(value) || 0, low), high);
const round = (value, digits = 1) => {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
};

/** Every volatility index Deriv offers digit contracts on. */
export const VOLATILITY_MARKETS = [
    '1HZ10V',
    '1HZ25V',
    '1HZ50V',
    '1HZ75V',
    '1HZ100V',
    'R_10',
    'R_25',
    'R_50',
    'R_75',
    'R_100',
];

/**
 * A 0-100 read on how worth trading a market is: how far past the noise the
 * strongest lean sits, how confident the ensemble is, how many models agree,
 * and how much data is behind the lot. It ranks markets for choosing where to
 * stand; it is not a forecast of profit.
 */
export const scoreMarket = plan => {
    if (!plan?.best) return 0;
    const lean = clamp(Math.abs(plan.best.tStat) / 3, 0, 1);
    const confidence = clamp((plan.confidence ?? 0) / 100, 0, 1);
    const agreement = clamp(plan.agreementRatio ?? 0, 0, 1);
    const quality = clamp(plan.dataQuality ?? 0, 0, 1);
    return round(100 * (0.4 * lean + 0.25 * confidence + 0.2 * agreement + 0.15 * quality), 1);
};

/**
 * Decides where the bot should stand.
 *
 * Every market visited is scored and remembered, so "best" compares markets
 * the bot has actually read rather than guessing. The dwell time is a rate
 * limit: the bot will not change market more often than that however bad the
 * market looks, because every switch costs a tick stream and a payout table.
 */
export function createMarketPicker({ markets = VOLATILITY_MARKETS, now = () => Date.now() } = {}) {
    const scores = new Map();
    // null, not 0: a clock may legitimately read 0, and treating that as
    // "not started" restarts the dwell timer on every single call, which pins
    // the bot to the market it started on.
    let switchedAt = null;

    /** Start the clock. Without this the dwell guard reads zero forever. */
    const start = () => {
        if (switchedAt === null) switchedAt = now();
        return switchedAt;
    };

    const secondsOnMarket = () => (switchedAt === null ? 0 : (now() - switchedAt) / 1000);

    const markSwitched = () => {
        switchedAt = now();
        return switchedAt;
    };

    const recordScore = (symbol, score) => {
        if (!symbol) return;
        const previous = scores.get(symbol);
        const smoothed = previous ? previous * 0.6 + score * 0.4 : score;
        scores.set(symbol, round(smoothed, 1));
    };

    const others = symbol => markets.filter(market => market !== symbol);

    const random = symbol => {
        const options = others(symbol);
        if (!options.length) return symbol;
        return options[Math.floor(Math.random() * options.length)];
    };

    const next = symbol => {
        const index = markets.indexOf(symbol);
        return index < 0 ? markets[0] : markets[(index + 1) % markets.length];
    };

    /** The best-scoring market we are not already standing on. */
    const bestKnown = symbol => {
        let best = null;
        scores.forEach((score, market) => {
            if (market === symbol) return;
            if (!best || score > best.score) best = { market, score };
        });
        if (best && best.score > 0) return best.market;
        return random(symbol);
    };

    const resolve = (wanted, current) => {
        const key = String(wanted || '').trim();
        if (!key) return current;
        if (markets.includes(key)) return key;
        if (key === 'random') return random(current);
        if (key === 'next') return next(current);
        if (key === 'best' || key === 'suitable') return bestKnown(current);
        return key; // anything else is a symbol we do not know; pass it through
    };

    /**
     * Where to go next. Returns the current symbol to mean "stay".
     *
     * @param {string} mode    suitable | random | next | best
     * @param {number} minScore the score floor for 'suitable'
     * @param {number} dwell   seconds that must pass before we may move
     * @param {string} current the market the bot is on
     * @param {number} score   the current market's score
     */
    const choose = ({ mode = 'suitable', minScore = 0, dwell = 2, current, score = null } = {}) => {
        start(); // the dwell clock starts the first time we are asked
        const floor = clamp(minScore, 0, 100);
        const wanted = String(mode || 'suitable').toLowerCase();

        if (secondsOnMarket() < Math.max(0, Number(dwell) || 0)) return current;

        if (wanted === 'random') return random(current);
        if (wanted === 'next') return next(current);
        if (wanted === 'best') return bestKnown(current);
        // Pass a fresh score when you have one; otherwise fall back to the
        // remembered read for this market.
        const currentScore = score === null ? scores.get(current) ?? 0 : score;
        if (currentScore < floor) return bestKnown(current);
        return current;
    };

    return { start, choose, resolve, recordScore, markSwitched, secondsOnMarket, scores, markets };
}
