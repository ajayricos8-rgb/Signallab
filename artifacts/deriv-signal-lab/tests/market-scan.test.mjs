// The AI multi-market scan: ranking, the move/no-move rule and the cadence
// clock. All three are pure, so the whole "trade on the most suitable market,
// at least once a minute" contract is pinned here without a trade engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_CADENCE_S,
    DEFAULT_SCAN_MARGIN,
    SCAN_MIN_TICKS,
    chooseScanTarget,
    createCadenceClock,
    normalizeScanFamily,
    rankReads,
    scanMode,
    scanReport,
    scoreRead,
} from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/market-scan.mjs';

const decision = overrides => ({
    modelReady: true,
    ev: 0.02,
    certainty: 60,
    dnaScore: 55,
    samples: 300,
    skill: 0.05,
    ...overrides,
});

test('the scan family decides the price mode', () => {
    assert.equal(normalizeScanFamily('Even-Odd'), 'even-odd');
    assert.equal(normalizeScanFamily('high-low-tick'), 'high-low-tick');
    assert.equal(normalizeScanFamily('nonsense'), 'even-odd');
    assert.equal(scanMode('high-low-tick'), 'tick');
    assert.equal(scanMode('rise-fall'), 'rise');
    assert.equal(scanMode('even-odd'), 'rise');
});

test('a decision scores higher when its evidence is stronger', () => {
    const fair = scoreRead(decision({ ev: -0.02, certainty: 40, samples: 60, skill: 0 }));
    const strong = scoreRead(decision({ ev: 0.08, certainty: 90, samples: 900, skill: 0.2 }));
    assert.ok(strong > fair, `strong ${strong} should beat fair ${fair}`);
    assert.ok(fair >= 0 && strong <= 100);
});

test('an unreadable or frozen market scores nothing', () => {
    assert.equal(scoreRead(null), 0);
    assert.equal(scoreRead(decision({ modelReady: false })), 0);
    assert.equal(scoreRead(decision(), { phase: 'frozen' }), 0);
    // The decision's own DNA is used when no separate report is handed in.
    assert.equal(scoreRead(decision({ dna: { phase: 'frozen' } })), 0);
});

test('ranking is by score, then by symbol, with ranks and a best market', () => {
    const ranked = rankReads([
        { symbol: 'R_25', score: 41.2 },
        { symbol: '1HZ100V', score: 63.4 },
        { symbol: 'R_100', score: 41.2 },
        { symbol: '', score: 90 },
        null,
    ]);
    assert.equal(ranked.count, 3);
    // Ties break on the symbol, so the order never depends on scan timing.
    assert.deepEqual(ranked.ordered.map(row => row.symbol), ['1HZ100V', 'R_100', 'R_25']);
    assert.equal(ranked.best, '1HZ100V');
    assert.equal(ranked.rank.get('1HZ100V'), 1);
    assert.equal(ranked.rank.get('R_25'), 3);
    assert.equal(ranked.scores.get('R_25'), 41.2);
});

test('the scan moves only when the challenger wins by the margin over the floor', () => {
    const ranked = rankReads([
        { symbol: 'R_50', score: 61 },
        { symbol: 'R_100', score: 58 },
    ]);
    // The incumbent is already the best: stay.
    assert.equal(chooseScanTarget({ current: 'R_50', ordered: ranked.ordered, scores: ranked.scores }).switched, false);
    // A challenger that is better but inside the margin is selection noise.
    const close = rankReads([{ symbol: 'R_50', score: 61 }, { symbol: 'R_100', score: 60 }]);
    const tight = chooseScanTarget({
        current: 'R_100',
        ordered: close.ordered,
        scores: close.scores,
        floor: 20,
        margin: DEFAULT_SCAN_MARGIN,
    });
    assert.equal(tight.switched, false);
    assert.equal(tight.symbol, 'R_100');
    assert.match(tight.reason, /does not beat/);
    // Clear of the margin and the floor: move to the best read.
    const move = chooseScanTarget({
        current: 'R_100',
        ordered: ranked.ordered,
        scores: ranked.scores,
        floor: 20,
        margin: 1,
    });
    assert.equal(move.switched, true);
    assert.equal(move.symbol, 'R_50');
    assert.match(move.reason, /moving to R_50/);
});

test('a cold scan and a fresh switch both win over a better market', () => {
    const ranked = rankReads([{ symbol: 'R_50', score: 12 }, { symbol: 'R_100', score: 5 }]);
    const cold = chooseScanTarget({ current: 'R_100', ordered: ranked.ordered, floor: 20 });
    assert.equal(cold.switched, false, 'nothing clears the floor');
    assert.match(cold.reason, /floor/);
    const dwell = chooseScanTarget({ current: 'R_100', ordered: ranked.ordered, floor: 1, margin: 0, dwellOk: false });
    assert.equal(dwell.switched, false, 'the dwell holds the bot on its market');
    assert.match(dwell.reason, /dwell/);
    const empty = chooseScanTarget({ current: 'R_100', ordered: [] });
    assert.equal(empty.switched, false);
    assert.match(empty.reason, /no readable market/);
});

test('the scan report names the ranking and the market the bot stands on', () => {
    const ranked = rankReads([{ symbol: 'R_50', score: 61.02 }, { symbol: 'R_100', score: 58.4 }]);
    const line = scanReport({ ordered: ranked.ordered, current: 'R_100', reason: 'holding' });
    assert.match(line, /AI scan · 2 markets/);
    assert.match(line, /R_50 61\.0/);
    assert.match(line, /standing on R_100/);
    assert.equal(scanReport({}), 'AI scan · no readable market yet');
});

test('the cadence clock asks for an entry a minute after the last one', () => {
    let clock = 0;
    const cadence = createCadenceClock({ now: () => clock, gapSeconds: DEFAULT_CADENCE_S });
    assert.equal(DEFAULT_CADENCE_S, 60);
    assert.equal(cadence.due(), false, 'no minute has passed yet');
    clock += 30_000;
    assert.equal(cadence.due(), false);
    clock += 30_000;
    assert.equal(cadence.due(), true, 'a minute with no purchase is due');
    // The engine's own counter marking a trade resets the clock.
    cadence.observe(1);
    assert.equal(cadence.due(), false);
    assert.equal(cadence.lastTradeAt, clock);
    clock += 61_000;
    assert.equal(cadence.due(), true);
    // A run counter that went backwards is a new run, not a purchase.
    cadence.observe(0);
    assert.equal(cadence.runs, 0);
    assert.equal(cadence.due(), true, 'a reset does not fake a trade');
    cadence.mark();
    assert.equal(cadence.due(), false, 'an explicit mark counts as a trade');
});

test('the scan floor leaves a readable market alone from the first tick', () => {
    // Signal Lab shares the same history window the models expect.
    assert.ok(SCAN_MIN_TICKS > 0 && SCAN_MIN_TICKS < 256, 'the parity warm-up is the lower of the two models');
});
