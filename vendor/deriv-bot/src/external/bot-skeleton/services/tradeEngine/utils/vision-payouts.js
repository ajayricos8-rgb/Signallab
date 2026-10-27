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
            filled: this.filled,
            live: this.live,
            at: this.at || Date.now(),
        };
    }

    static fromJSON(data) {
        const table = new PayoutTable(data?.key);
        if (Array.isArray(data?.over)) table.over = data.over.slice(0, 10);
        if (Array.isArray(data?.under)) table.under = data.under.slice(0, 10);
        table.filled = Number(data?.filled) || table.over.filter(Boolean).length + table.under.filter(Boolean).length;
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
    if (!jobs.length) return table;

    let sawLive = false;
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
        const batch = jobs.slice(i, i + BATCH_SIZE);
        await Promise.all(
            batch.map(async ({ barrier, direction }) => {
                try {
                    const response = await sendProposal({
                        proposal: 1,
                        amount: Number(amount) > 0 ? Number(amount) : 1,
                        basis: 'stake',
                        contract_type: direction === 'over' ? 'DIGITOVER' : 'DIGITUNDER',
                        currency: currency || 'USD',
                        duration: Number(duration) || 5,
                        duration_unit: durationUnit || 't',
                        barrier,
                        underlying_symbol: symbol,
                    });
                    const proposal = response?.proposal;
                    const payout = Number(proposal?.payout);
                    const stake = Number(proposal?.ask_price) || Number(amount) || 1;
                    if (payout > 0 && stake > 0) {
                        table.set(direction, barrier, payout / stake);
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

export default { ensurePayouts, refreshPayouts, peekPayouts, payoutSnapshot, PayoutTable };
