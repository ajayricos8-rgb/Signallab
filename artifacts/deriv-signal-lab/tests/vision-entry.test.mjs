import test from 'node:test';
import assert from 'node:assert/strict';

import {
    clampBarrier,
    createEntryPacer,
    DEFAULT_ENTRY_GAP_MS,
    entryDecision,
    isAllowedBarrier,
    MIN_TICKS_TO_READ,
    MINIMUM_STAKE,
    NEUTRAL_BARRIER,
    NEUTRAL_DIRECTION,
    OVER_BARRIERS,
    readBarrier,
    readDirection,
    readStake,
    UNDER_BARRIERS,
    waitingReason,
} from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/vision-entry.mjs';

/** A clock the test moves by hand. */
function clock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: ms => (t += ms) };
}

const planWith = (overrides = {}) => ({
    go: true,
    best: { barrier: 3, direction: 'under', ...overrides },
});

test('the pacer allows the first entry and then holds the gap', () => {
    const time = clock();
    const pacer = createEntryPacer({ gapMs: 2_000, now: time.now });

    assert.equal(pacer.ready(), true, 'the first entry is never blocked');
    pacer.mark();
    assert.equal(pacer.ready(), false, 'the entry that just happened owns the slot');
    assert.equal(pacer.waitMs(), 2_000);

    time.advance(1_999);
    assert.equal(pacer.ready(), false);
    time.advance(1);
    assert.equal(pacer.ready(), true, 'two seconds later the bot may open another position');
});

test('a gap of zero removes the limit and a strategy can set it in seconds', () => {
    const time = clock();
    const pacer = createEntryPacer({ gapMs: DEFAULT_ENTRY_GAP_MS, now: time.now });
    assert.equal(pacer.gapMs, 2_000, 'the shipped default is one position per two seconds');

    pacer.setGapSeconds(0);
    pacer.mark();
    assert.equal(pacer.ready(), true, 'no gap means the next tick may trade too');

    pacer.setGapSeconds(5);
    assert.equal(pacer.gapMs, 5_000);
    time.advance(4_999);
    assert.equal(pacer.ready(), false);
    time.advance(1);
    assert.equal(pacer.ready(), true);
});

test('a pause does not eat the slot: only a marked position counts', () => {
    const time = clock();
    const pacer = createEntryPacer({ gapMs: 2_000, now: time.now });
    time.advance(60_000); // a minute of reading the market, no entry
    assert.equal(pacer.ready(), true);
    assert.equal(pacer.lastAt, null);
    pacer.mark();
    assert.equal(pacer.ready(), false);
});

test('the barrier is never -1, so trade options are never invalid', () => {
    // planWith() is an Under read: barriers always land in the tradable set
    // for their direction (Over 1–6, Under 4–8), never -1 and never an
    // extreme the bot is not allowed to trade.
    assert.equal(readBarrier(planWith({ barrier: 6 }), null), 6, 'an in-range Under barrier passes through');
    assert.equal(readBarrier(planWith(), null), 4, 'an Under 3 clamps up to the smallest allowed Under barrier');
    assert.equal(readBarrier(null, planWith()), 4, 'the last decision stands in while warming up');
    assert.equal(readBarrier(planWith({ barrier: -1 }), null), 4, 'a -1 barrier can never reach trade options');
    assert.equal(readBarrier(null, null), 1, 'the neutral contract is the widest allowed Over (1)');
    assert.equal(readBarrier({ best: { barrier: 99 } }, null), 6, 'an over-the-top barrier clamps to the Over ceiling');
    assert.equal(readBarrier({ best: { barrier: 0, direction: 'over' } }, null), 1, 'Over 0 is not tradable');
    assert.equal(readBarrier({ best: { barrier: 9, direction: 'under' } }, null), 8, 'Under 9 is not tradable');
});

test('only the configured barriers are tradable: Over 1–6, Under 4–8', () => {
    assert.deepEqual(OVER_BARRIERS, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(UNDER_BARRIERS, [4, 5, 6, 7, 8]);
    for (const barrier of [1, 2, 3, 4, 5, 6]) assert.equal(isAllowedBarrier('over', barrier), true);
    for (const barrier of [0, 7, 8, 9]) assert.equal(isAllowedBarrier('over', barrier), false);
    for (const barrier of [4, 5, 6, 7, 8]) assert.equal(isAllowedBarrier('under', barrier), true);
    for (const barrier of [0, 1, 2, 3, 9]) assert.equal(isAllowedBarrier('under', barrier), false);
    assert.equal(clampBarrier('over', 0), 1);
    assert.equal(clampBarrier('over', 9), 6);
    assert.equal(clampBarrier('under', 2), 4);
    assert.equal(clampBarrier('under', 9), 8);
    assert.equal(clampBarrier('over', Number.NaN), 1, 'a missing barrier falls back inside the set');
});

test('the direction is always over or under, never wait', () => {
    assert.equal(readDirection(planWith(), null), 'under');
    assert.equal(readDirection(null, planWith()), 'under');
    assert.equal(readDirection(planWith({ direction: 'wait' }), null), NEUTRAL_DIRECTION);
    assert.equal(readDirection(null, null), NEUTRAL_DIRECTION);
});

test('the entry switch trades a live plan and falls back when there is none', () => {
    const live = entryDecision({ plan: planWith(), last: null });
    assert.deepEqual([live.go, live.source], [true, 'ai']);

    const declined = entryDecision({ plan: { go: false, best: { barrier: 4, direction: 'over' } }, last: null });
    assert.equal(declined.go, false, 'a plan that says no is respected when the bars are on');

    const remembered = entryDecision({
        plan: null,
        last: planWith(),
        forceEntry: true,
    });
    assert.deepEqual([remembered.go, remembered.source], [true, 'memory']);

    const neutral = entryDecision({ plan: null, last: null, forceEntry: true });
    assert.deepEqual([neutral.go, neutral.source], [true, 'neutral'], 'a bot with no read still opens positions');

    const strict = entryDecision({ plan: null, last: null, forceEntry: false });
    assert.equal(strict.go, false, 'without forcing, no read means no trade');
});

test('the warm-up message names the tick count instead of hiding the wait', () => {
    assert.match(waitingReason({ ticks: 3, min: MIN_TICKS_TO_READ }), /3\/12 ticks/);
    assert.doesNotMatch(waitingReason({ ticks: 400, min: MIN_TICKS_TO_READ }), /warming/);
});

test('a stake is always large enough for the broker to accept it', () => {
    assert.equal(readStake(0), MINIMUM_STAKE);
    assert.equal(readStake(-4), MINIMUM_STAKE);
    assert.equal(readStake(0.07), MINIMUM_STAKE, 'a scaled-down stake must not fall below the minimum');
    assert.equal(readStake(2.345), 2.35);
    assert.equal(readStake('1.5'), 1.5);
});
