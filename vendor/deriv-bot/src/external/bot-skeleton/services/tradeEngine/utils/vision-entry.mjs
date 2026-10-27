/**
 * Vision Lab — the entry switch.
 *
 * The engine decides *what* to buy; this file decides *whether the bot is
 * allowed to buy it right now*. Three things live here, all pure so they can be
 * tested without a live trade engine:
 *
 *   - the warm-up floor: how many ticks the AI needs before it will publish a
 *     decision, and how many it needs before it stops publishing one it has
 *     already made;
 *   - the last-known fallback: the barrier and direction a strategy is handed
 *     when the current tick cannot be read, so trade options are never built
 *     from a -1 barrier (which the API rejects, silently swallowing the entry);
 *   - the entry pacer: a floor on the time between entries, so "trade as often
 *     as possible" still means "one position every couple of seconds" instead of
 *     a loop that hammers the buy endpoint on every tick.
 */

/** Ticks the AI needs before its first decision is worth anything. */
export const MIN_TICKS_TO_READ = 12;

/** Never open contracts faster than this unless a strategy asks for it. */
export const DEFAULT_ENTRY_GAP_MS = 2_000;

/** The widest Over contract: nine winning digits, the smallest possible loss. */
export const NEUTRAL_BARRIER = 0;
export const NEUTRAL_DIRECTION = 'over';

const clamp = (value, low, high) => Math.min(Math.max(Number(value) || 0, low), high);

/**
 * A rate limit on entries.
 *
 * `ready()` is true when the strategy may open a position; `mark()` records
 * that it just did. Nothing is marked until the strategy actually reaches its
 * purchase block, so a rejected or skipped entry never eats the next slot.
 */
export function createEntryPacer({ gapMs = DEFAULT_ENTRY_GAP_MS, now = () => Date.now() } = {}) {
    let gap = Math.max(0, Number(gapMs) || 0);
    let lastAt = null;

    /** Seconds a strategy may ask for; anything below one tick collapses to 0. */
    const setGapSeconds = seconds => {
        gap = Math.max(0, (Number(seconds) || 0) * 1000);
        return gap;
    };

    return {
        get gapMs() {
            return gap;
        },
        get lastAt() {
            return lastAt;
        },
        setGapSeconds,
        /** True when enough time has passed since the last marked entry. */
        ready() {
            if (!(gap > 0)) return true;
            if (lastAt === null) return true;
            return now() - lastAt >= gap;
        },
        /** Record an entry now. Returns the timestamp used. */
        mark() {
            lastAt = now();
            return lastAt;
        },
        /** Milliseconds until the next entry is allowed. */
        waitMs() {
            if (!(gap > 0) || lastAt === null) return 0;
            return Math.max(0, gap - (now() - lastAt));
        },
        reset() {
            lastAt = null;
        },
    };
}

/** The barrier to hand to trade options, never -1 once anything is known. */
export function readBarrier(plan, last) {
    const value = plan?.best?.barrier ?? last?.best?.barrier;
    if (Number.isFinite(value) && value >= 0 && value <= 9) return Math.round(value);
    return NEUTRAL_BARRIER;
}

/** The side of the barrier to buy, never 'wait' once anything is known. */
export function readDirection(plan, last) {
    const value = plan?.best?.direction ?? last?.best?.direction;
    return value === 'under' ? 'under' : value === 'over' ? 'over' : NEUTRAL_DIRECTION;
}

/** True when this plan carries a contract the strategy can actually buy. */
export const hasContract = plan => Boolean(plan?.best) && Number.isFinite(plan?.best?.barrier);

/**
 * Should this tick be traded?
 *
 * `go` comes from the engine. When it is false but the strategy has asked for
 * an always-on entry (`forceEntry`, the shipped default) and the AI has no
 * fresh read at all, the neutral contract keeps the bot in the market instead
 * of sitting out every tick — which is exactly what made the bot look dead.
 */
export function entryDecision({ plan, last, forceEntry = true } = {}) {
    const live = hasContract(plan);
    const remembered = hasContract(last);
    if (live && plan.go) return { go: true, forced: Boolean(plan.forced), source: 'ai' };
    if (forceEntry && remembered) {
        return { go: true, forced: true, source: live ? 'fallback' : 'memory' };
    }
    if (forceEntry && !live && !remembered) {
        // Nothing has ever been read: the neutral contract is the only honest
        // choice, and it is still a real (if widest) Over/Under position.
        return { go: true, forced: true, source: 'neutral' };
    }
    return { go: false, forced: false, source: 'wait' };
}

/** A one-line explanation of why the tick was not traded. */
export function waitingReason({ ticks = 0, min = MIN_TICKS_TO_READ } = {}) {
    const count = Math.max(0, Math.floor(Number(ticks) || 0));
    if (count < min) return `warming up — ${count}/${min} ticks on this market`;
    return 'no contract to buy';
}

/** Clamp a stake to something Deriv will accept. */
export const MINIMUM_STAKE = 0.35;
export const readStake = value => {
    const stake = Number(value);
    if (!Number.isFinite(stake) || stake <= 0) return MINIMUM_STAKE;
    return Math.max(MINIMUM_STAKE, Math.round(stake * 100) / 100);
};

export { clamp };

export default {
    MIN_TICKS_TO_READ,
    DEFAULT_ENTRY_GAP_MS,
    NEUTRAL_BARRIER,
    NEUTRAL_DIRECTION,
    MINIMUM_STAKE,
    createEntryPacer,
    entryDecision,
    hasContract,
    readBarrier,
    readDirection,
    readStake,
    waitingReason,
};
