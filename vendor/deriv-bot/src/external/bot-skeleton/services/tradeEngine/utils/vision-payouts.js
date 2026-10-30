/**
 * Vision Lab — the digit payout table.
 *
 * Choosing a barrier without knowing what it pays is guessing, so the engine
 * asks Deriv itself: one proposal per barrier per direction (at most 20), read
 * straight off the API. The table is cached per symbol/duration/currency and
 * refreshed in the background, so the running bot never waits on the network
 * more than once — and only when nothing is cached yet.
 *
 * If the API is unreachable or rate limited we keep the last table we had and,
 * failing that, fall back to a conservative fair-odds model rather than
 * inventing a payout that would make a losing trade look profitable.
 */

import { api_base } from '../../api/api-base';
import { fallbackPayout, winningDigitCount } from './vision-ai.mjs';
import { PARITY_FALLBACK_PAYOUT } from './parity-strategies.mjs';

const STORAGE_KEY = 'signal-lab.vision-payouts.v1';
const REFRESH_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const BATCH_SIZE = 4;
const BATCH_GAP_MS = 260;
/** How long a failed or partial table fetch keeps us from blocking a tick again. */
const RETRY_MS = 30 * 1000;

const cache = new Map(); // key -> { table, at }
const inflight = new Map();
/** Last time we let a tick wait on the network for this table. */
const attempts = new Map();
let stored = readStored();

function readStored() {
    try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function writeStored() {
    try {
        if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        }
    } catch {
        // Storage failures are not worth stopping a trade for.
    }
}

const keyOf = ({ symbol, duration, durationUnit, currency }) =>
    `${symbol || ''}|${duration || ''}|${durationUnit || ''}|${currency || ''}`;

export class PayoutTable {
    constructor(key) {
        this.key = key;
        this.over = new Array(10).fill(0);
        this.under = new Array(10).fill(0);
        // Even/Odd pays one multiple per side (no barrier): two slots read by
        // the parity engine. Old stored tables lack them and read as 0.
        this.even = 0;
        this.odd = 0;
        this.filled = 0;
        this.live = false;
        this.at = 0;
    }

    set(direction, barrier, multiple) {
        const index = Math.max(0, Math.min(9, Math.round(barrier)));
        if (!(multiple > 0)) return;
        if (!this[direction][index]) this.filled += 1;
        this[direction][index] = multiple;
    }

    has(direction, barrier) {
        return Boolean(this[direction]?.[Math.max(0, Math.min(9, Math.round(barrier)))]);
    }

    /** Payout multiple for a contract; falls back to the model when unknown. */
    get(direction, barrier) {
        const index = Math.max(0, Math.min(9, Math.round(barrier)));
        const value = this[direction]?.[index];
        if (value > 0) return value;
        return fallbackPayout(direction, index);
    }

    setParity(side, multiple) {
        const key = String(side).toLowerCase() === 'odd' ? 'odd' : 'even';
        if (!(multiple > 0)) return;
        if (!this[key]) this.filled += 1;
        this[key] = multiple;
    }

    hasParity(side) {
        const key = String(side).toLowerCase() === 'odd' ? 'odd' : 'even';
        return this[key] > 0;
    }

    /** Even/Odd multiple for a side; the modelled 1.95× until quoted. */
    getParity(side) {
        const key = String(side).toLowerCase() === 'odd' ? 'odd' : 'even';
        return this[key] > 0 ? this[key] : PARITY_FALLBACK_PAYOUT;
    }

    /** True when both Even/Odd slots came from the API. */
    get parityComplete() {
        return this.even > 0 && this.odd > 0;
    }

    /** True only when every tradeable slot came from the API. */
    get complete() {
        let expected = 0;
        for (let b = 0; b <= 9; b++) {
            if (winningDigitCount('over', b) > 0) expected += 1;
            if (winningDigitCount('under', b) > 0) expected += 1;
        }
        return this.filled >= expected;
    }

    toJSON() {
        return {
            key: this.key,
            over: this.over,
            under: this.under,
            even: this.even,
            odd: this.odd,
            filled: this.filled,
            live: this.live,
            at: this.at || Date.now(),
        };
    }

    static fromJSON(data) {
        const table = new PayoutTable(data?.key);
        if (Array.isArray(data?.over)) table.over = data.over.slice(0, 10);
        if (Array.isArray(data?.under)) table.under = data.under.slice(0, 10);
        table.even = Number(data?.even) || 0;
        table.odd = Number(data?.odd) || 0;
        table.filled =
            Number(data?.filled) ||
            table.over.filter(Boolean).length + table.under.filter(Boolean).length + (table.even ? 1 : 0) + (table.odd ? 1 : 0);
        table.live = Boolean(data?.live);
        table.at = Number(data?.at) || Date.now();
        return table;
    }
}

function sendProposal(request) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), REQUEST_TIMEOUT_MS);
        Promise.resolve(api_base?.api?.send(request))
            .then(response => {
                clearTimeout(timer);
                resolve(response);
            })
            .catch(error => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTable(key, options) {
    const { symbol, duration, durationUnit, currency, amount } = options;
    const table = cache.get(key) || PayoutTable.fromJSON({ ...(stored[key] || {}), key });

    const jobs = [];
    for (let barrier = 0; barrier <= 9; barrier++) {
        ['over', 'under'].forEach(direction => {
            if (winningDigitCount(direction, barrier) <= 0) return;
            if (table.has(direction, barrier) && Date.now() - table.at < REFRESH_MS) return;
            jobs.push({ barrier, direction });
        });
    }
    // Even/Odd needs no barrier: two proposals price the whole family.
    ['even', 'odd'].forEach(side => {
        if (table.hasParity(side) && Date.now() - table.at < REFRESH_MS) return;
        jobs.push({ parity: side });
    });
    if (!jobs.length) return table;

    let sawLive = false;
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
        const batch = jobs.slice(i, i + BATCH_SIZE);
        await Promise.all(
            batch.map(async job => {
                try {
                    const isParity = Boolean(job.parity);
                    const request = {
                        proposal: 1,
                        amount: Number(amount) > 0 ? Number(amount) : 1,
                        basis: 'stake',
                        contract_type: isParity
                            ? job.parity === 'odd'
                                ? 'DIGITODD'
                                : 'DIGITEVEN'
                            : job.direction === 'over'
                              ? 'DIGITOVER'
                              : 'DIGITUNDER',
                        currency: currency || 'USD',
                        duration: Number(duration) || 5,
                        duration_unit: durationUnit || 't',
                        underlying_symbol: symbol,
                    };
                    if (!isParity) request.barrier = job.barrier;
                    const response = await sendProposal(request);
                    const proposal = response?.proposal;
                    const payout = Number(proposal?.payout);
                    const stake = Number(proposal?.ask_price) || Number(amount) || 1;
                    if (payout > 0 && stake > 0) {
                        if (isParity) table.setParity(job.parity, payout / stake);
                        else table.set(job.direction, job.barrier, payout / stake);
                        sawLive = true;
                    }
                } catch {
                    // A single failed slot keeps its old (or modelled) value.
                }
            })
        );
        if (i + BATCH_SIZE < jobs.length) await sleep(BATCH_GAP_MS);
    }

    if (sawLive) {
        table.live = true;
        table.at = Date.now();
        cache.set(key, table);
        stored[key] = table.toJSON();
        writeStored();
    }
    return table;
}

/** Refresh in the background; never blocks the bot. */
export function refreshPayouts(options) {
    const key = keyOf(options);
    if (inflight.has(key)) return inflight.get(key);
    const promise = fetchTable(key, options)
        .catch(() => cache.get(key) || null)
        .then(table => {
            inflight.delete(key);
            return table;
        });
    inflight.set(key, promise);
    return promise;
}

/**
 * Return a usable table immediately. The very first call waits for the API
 * (with a hard cap) so the first trade is priced correctly; later calls reuse
 * the cache and trigger a silent refresh when it goes stale.
 */
export async function ensurePayouts(options) {
    const key = keyOf(options);
    let table = cache.get(key);
    if (!table && stored[key]) {
        table = PayoutTable.fromJSON(stored[key]);
        cache.set(key, table);
    }
    const isStale = !table || Date.now() - table.at > REFRESH_MS || !table.complete;

    /**
     * A table the API never finished is the one case that used to stall the
     * bot: every tick found it incomplete and sat out another four-second
     * request. One blocking attempt per key per retry window is enough; after
     * that the modelled table carries the tick while the real one is fetched
     * in the background. This is what lets the bot walk through ten markets
     * without pausing at each one.
     */
    const blockingBudgetSpent = Date.now() - (attempts.get(key) || 0) < RETRY_MS;

    if (isStale && !blockingBudgetSpent) {
        attempts.set(key, Date.now());
        const result = await Promise.race([
            refreshPayouts(options),
            new Promise(resolve => setTimeout(() => resolve(table || null), 4000)),
        ]);
        table = result || table;
    } else if (isStale) {
        refreshPayouts(options);
    }

    if (!table) {
        table = new PayoutTable(key);
        cache.set(key, table);
    }
    return table;
}

/**
 * The table as it stands right now, without waiting for the network.
 *
 * The running bot must never spend four seconds of a two-second market waiting
 * for twenty proposals: the modelled ladder is already a conservative price, and
 * the live table replaces it as soon as it lands. So an entry-priced plan asks
 * for a peek and refreshes in the background, and only the explicit "refresh
 * the payout table" block waits for the API.
 */
export function peekPayouts(options) {
    const key = keyOf(options);
    const table = cache.get(key) || (stored[key] ? PayoutTable.fromJSON(stored[key]) : null);
    if (table) cache.set(key, table);
    // Warm the next decision without holding this one up.
    refreshPayouts(options);
    return table;
}

export function payoutSnapshot(options) {
    const table = cache.get(keyOf(options));
    if (!table) return null;
    return { live: table.live, complete: table.complete, ageSeconds: (Date.now() - table.at) / 1000, table };
}

export default {
    ensurePayouts,
    refreshPayouts,
    peekPayouts,
    payoutSnapshot,
    PayoutTable,
    refreshTickPayouts,
    peekTickPayouts,
    tickPayoutSnapshot,
    TickPayoutTable,
};

/* ------------------------------------------------------------------------- *
 * High/Low Tick pay-out table — ten quotes, one per (side, selected_tick).
 *
 * The digit table above prices ten barriers per direction, so the machinery is
 * the same; what differs is that a High/Low Tick contract is quoted *per
 * `selected_tick`*. Deriv's pricing engine prices "the strict high prints at
 * tick k" as its own contract, and those ten quotes are not equal: the ends of
 * the window are likelier and pay less, the middle pays more, and a tie-heavy
 * market (a Step index) shifts the whole ladder. Reading one quote and applying
 * it to all ten positions — which is what the first version did — misprices
 * every position but the one it happened to read.
 *
 * The table is cached per symbol/currency/amount and refreshed in the
 * background on a short cadence (tick pay-outs move with volatility, unlike the
 * digit ladder). The running bot never waits on it: a decision prices with the
 * table it has, and the fresh one lands when it lands.
 * ------------------------------------------------------------------------- */

const TICK_STORAGE_KEY = 'signal-lab.vision-tick-payouts.v1';
const TICK_REFRESH_MS = 90 * 1000;
const TICK_RETRY_MS = 20 * 1000;

const tickCache = new Map();
const tickInflight = new Map();
const tickAttempts = new Map();
let tickStored = readTickStored();

function readTickStored() {
    try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(TICK_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function writeTickStored() {
    try {
        if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(TICK_STORAGE_KEY, JSON.stringify(tickStored));
        }
    } catch {
        // Storage failures are not worth stopping a trade for.
    }
}

const tickKeyOf = ({ symbol, currency }) => `${symbol || ''}|${currency || ''}`;

export class TickPayoutTable {
    constructor(key) {
        this.key = key;
        this.high = new Array(5).fill(0);
        this.low = new Array(5).fill(0);
        this.at = 0;
        this.live = false;
    }

    set(side, tick, multiple) {
        const index = Math.max(0, Math.min(4, Math.round(tick) - 1));
        if (!(multiple > 0)) return;
        if (side === 'high') this.high[index] = multiple;
        else this.low[index] = multiple;
    }

    has(side, tick) {
        const index = Math.max(0, Math.min(4, Math.round(tick) - 1));
        return Boolean((side === 'high' ? this.high : this.low)[index]);
    }

    /** Every one of the ten outcomes has a live quote. */
    get complete() {
        return [...this.high, ...this.low].every(value => value > 0);
    }

    /** Quote for one outcome, or 0 when this market has not priced it. */
    get(side, tick) {
        const index = Math.max(0, Math.min(4, Math.round(tick) - 1));
        return (side === 'high' ? this.high : this.low)[index] || 0;
    }

    /** The ten multiples in decision order: [H1..H5, L1..L5]. */
    get vector() {
        return [...this.high, ...this.low];
    }

    toJSON() {
        return { key: this.key, high: this.high, low: this.low, live: this.live, at: this.at || Date.now() };
    }

    static fromJSON(data) {
        const table = new TickPayoutTable(data?.key);
        if (Array.isArray(data?.high)) table.high = data.high.slice(0, 5);
        if (Array.isArray(data?.low)) table.low = data.low.slice(0, 5);
        table.live = Boolean(data?.live);
        table.at = Number(data?.at) || Date.now();
        return table;
    }
}

async function fetchTickTable(key, options) {
    const { symbol, currency, amount } = options;
    const table = tickCache.get(key) || TickPayoutTable.fromJSON({ ...(tickStored[key] || {}), key });
    const fresh = table.at && Date.now() - table.at < TICK_REFRESH_MS;
    const jobs = [];
    for (let tick = 1; tick <= 5; tick++) {
        for (const side of ['high', 'low']) {
            if (table.has(side, tick) && fresh) continue;
            jobs.push({ side, tick });
        }
    }
    if (!jobs.length) {
        table.live = table.complete;
        return table;
    }

    let sawLive = false;
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
        const batch = jobs.slice(i, i + BATCH_SIZE);
        await Promise.all(
            batch.map(async ({ side, tick }) => {
                try {
                    const response = await sendProposal({
                        proposal: 1,
                        amount: Number(amount) > 0 ? Number(amount) : 1,
                        basis: 'stake',
                        contract_type: side === 'high' ? 'TICKHIGH' : 'TICKLOW',
                        currency: currency || 'USD',
                        duration: 5,
                        duration_unit: 't',
                        selected_tick: tick,
                        underlying_symbol: symbol,
                    });
                    const proposal = response?.proposal;
                    const payout = Number(proposal?.payout);
                    const stake = Number(proposal?.ask_price) || Number(amount) || 1;
                    if (payout > 0 && stake > 0) {
                        table.set(side, tick, payout / stake - 1);
                        sawLive = true;
                    }
                } catch {
                    // A single failed slot keeps its previous (or no) value.
                }
            })
        );
        if (i + BATCH_SIZE < jobs.length) await sleep(BATCH_GAP_MS);
    }

    if (sawLive) {
        table.live = true;
        table.at = Date.now();
        tickCache.set(key, table);
        tickStored[key] = table.toJSON();
        writeTickStored();
    }
    return table;
}

/** Refresh the ten High/Low Tick quotes in the background; never blocks. */
export function refreshTickPayouts(options) {
    const key = tickKeyOf(options);
    if (tickInflight.has(key)) return tickInflight.get(key);
    const promise = fetchTickTable(key, options)
        .catch(() => tickCache.get(key) || null)
        .then(table => {
            tickInflight.delete(key);
            return table;
        });
    tickInflight.set(key, promise);
    return promise;
}

/**
 * The tick table as it stands, without waiting for the network.
 *
 * A missing or stale table triggers a background refresh and returns whatever
 * is cached (or null on a cold start, in which case the decision falls back to
 * the strategy's own payout figure and ranks by probability).
 */
export function peekTickPayouts(options) {
    const key = tickKeyOf(options);
    const table = tickCache.get(key) || (tickStored[key] ? TickPayoutTable.fromJSON(tickStored[key]) : null);
    if (table) tickCache.set(key, table);
    const stale = !table || !table.complete || Date.now() - table.at > TICK_REFRESH_MS;
    const budgetSpent = Date.now() - (tickAttempts.get(key) || 0) < TICK_RETRY_MS;
    if (stale && !budgetSpent) {
        tickAttempts.set(key, Date.now());
        refreshTickPayouts(options);
    }
    return table;
}

export function tickPayoutSnapshot(options) {
    const table = tickCache.get(tickKeyOf(options));
    if (!table) return null;
    return {
        live: table.live,
        complete: table.complete,
        ageSeconds: table.at ? (Date.now() - table.at) / 1000 : Infinity,
        table,
    };
}
