import test from 'node:test';
import assert from 'node:assert/strict';

import * as math from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/vision-math.mjs';
import * as ai from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/vision-ai.mjs';
import * as memory from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/vision-memory.mjs';
import { createMarketPicker, scoreMarket, VOLATILITY_MARKETS } from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/vision-markets.mjs';

/** A deterministic random walk, so every assertion below is reproducible. */
function walk(size, { start = 1234.56, step = 0.37, decimals = 2, seed = 7 } = {}) {
    let state = seed;
    const random = () => {
        state = (state * 16807) % 2147483647;
        return (state - 1) / 2147483646;
    };
    const quotes = [start];
    for (let i = 1; i < size; i++) {
        const drift = Math.sin(i / 37) * 0.02;
        const next = quotes[i - 1] + (random() - 0.5) * step * 2 + drift;
        quotes.push(Number(next.toFixed(decimals)));
    }
    return quotes;
}

/** A stream whose last digit is deliberately lopsided (ends in 7 too often). */
function biasedDigits(size, { hot = 7, rate = 0.45, seed = 11 } = {}) {
    let state = seed;
    const random = () => {
        state = (state * 16807) % 2147483647;
        return (state - 1) / 2147483646;
    };
    const quotes = [];
    for (let i = 0; i < size; i++) {
        const base = 500 + Math.floor(random() * 400);
        const digit = random() < rate ? hot : Math.floor(random() * 10);
        quotes.push(Number(`${base}.${digit}0`));
    }
    return quotes;
}

test('descriptive statistics match closed-form values', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    assert.equal(math.mean(values), 5);
    assert.equal(math.median([1, 2, 3, 4]), 2.5);
    assert.ok(Math.abs(math.stdDev(values, false) - 2) < 1e-12);
    assert.equal(math.statistic(values, 'min'), 2);
    assert.equal(math.statistic(values, 'max'), 9);
    assert.equal(math.statistic(values, 'range'), 7);
    assert.equal(math.statistic(values, 'count'), 8);
    assert.ok(Math.abs(math.quantile(values, 0.5) - 4.5) < 1e-9);
});

test('moving averages, RSI and Bollinger stay inside their ranges', () => {
    const series = walk(400);
    assert.ok(math.sma(series, 20) > 0);
    assert.ok(math.ema(series, 20) > 0);
    assert.ok(math.wma(series, 20) > 0);
    const rsi = math.rsi(series, 14);
    assert.ok(rsi >= 0 && rsi <= 100);
    const flat = new Array(60).fill(100);
    assert.equal(math.rsi(flat, 14), 50);
    const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
    assert.equal(math.rsi(rising, 14), 100);
    const percentB = math.bollingerPercentB(series, 20, 2);
    assert.ok(Number.isFinite(percentB));
    assert.ok(Math.abs(math.macd(series, 12, 26, 9)) < 5);
});

test('digit helpers read the market’s decimal places correctly', () => {
    const values = [1234.56, 1234.57, 1234.58];
    assert.equal(math.inferPipSize(values), 2);
    assert.deepEqual(math.lastDigits(values), [6, 7, 8]);
    assert.equal(math.lastDigitOf(1234.59), 9);
    const counts = math.digitCounts(biasedDigits(600));
    assert.equal(math.sum(counts), 600);
    assert.equal(counts[7], Math.max(...counts));
    assert.ok(math.digitSpread(biasedDigits(600)) > 10);
});

test('entropy separates a lopsided stream from a fair one', () => {
    const fair = walk(3000);
    const biased = biasedDigits(3000);
    const fairEntropy = math.digitEntropy(fair);
    const biasedEntropy = math.digitEntropy(biased);
    assert.ok(biasedEntropy < fairEntropy, `${biasedEntropy} should be below ${fairEntropy}`);
    assert.ok(fairEntropy > 3.2, `fair stream should be near log2(10), got ${fairEntropy}`);
});

test('streaks, runs and drawdowns are signed and bounded', () => {
    const rising = [1, 2, 3, 4, 5];
    assert.equal(math.streak(rising), 4);
    assert.equal(math.streak([5, 4, 3]), -2);
    assert.equal(math.parityRun([100.02, 100.04, 100.06]), 3);
    assert.equal(math.parityRun([100.01, 100.03]), -2);
    assert.equal(math.overUnderRun([100.07, 100.08, 100.09], 5), 3);
    assert.equal(math.digitStreak([100.05, 100.05, 100.05]), 3);
    assert.equal(math.maxDrawdown([10, 12, 8, 11]), 4);
});

test('the momentum model collapses to uniform when volatility dwarfs the digit step', () => {
    const series = walk(600, { step: 3.5 });
    const distribution = ai.momentumDistribution(series, 5);
    assert.equal(distribution.length, 10);
    assert.ok(Math.abs(math.sum(distribution) - 1) < 1e-9);
    distribution.forEach(p => assert.ok(Math.abs(p - 0.1) < 0.02, `expected near-uniform, got ${p}`));
});

test('every expert returns a normalised ten-digit distribution', () => {
    const series = walk(900);
    const forecast = ai.forecastDigits(series, { horizon: 5, brain: ai.defaultBrain() });
    assert.equal(forecast.distribution.length, 10);
    assert.ok(Math.abs(math.sum(forecast.distribution) - 1) < 1e-9);
    forecast.distribution.forEach(p => assert.ok(p >= 0 && p <= 1));
    Object.entries(forecast.experts).forEach(([name, expert]) => {
        assert.ok(Math.abs(math.sum(expert.distribution) - 1) < 1e-9, `${name} is not normalised`);
        assert.ok(expert.share >= 0 && expert.share <= 1, `${name} weight out of range`);
    });
    assert.ok(forecast.confidence >= 0 && forecast.confidence <= 100);
});

test('the analog expert finds a planted digit bias', () => {
    const biased = biasedDigits(1200);
    const forecast = ai.forecastDigits(biased, { horizon: 1, brain: ai.defaultBrain() });
    const frequency = ai.defaultBrain();
    assert.ok(frequency);
    assert.ok(forecast.distribution[7] > forecast.distribution[0], 'digit 7 should be the most likely');
    const historical = math.historicalOverUnder(biased, 6, 1, 'over');
    assert.ok(historical > 30, `expected a strong historical over-6 rate, got ${historical}`);
});

test('winning-digit counts and the payout fallback follow the contract rules', () => {
    assert.equal(ai.winningDigitCount('over', 0), 9);
    assert.equal(ai.winningDigitCount('over', 9), 0);
    assert.equal(ai.winningDigitCount('under', 1), 1);
    assert.equal(ai.winningDigitCount('under', 0), 0);
    assert.equal(ai.fallbackPayout('over', 9), 0);
    // Long shots carry the heaviest margin, so the modelled payout for a
    // one-digit contract must sit well below the fair 10x.
    assert.ok(ai.fallbackPayout('over', 8) > 5 && ai.fallbackPayout('over', 8) < 8);
    // Near-certain contracts trade close to fair.
    assert.ok(ai.fallbackPayout('over', 0) > 1 && ai.fallbackPayout('over', 0) < 1.1);
    assert.equal(ai.fallbackPayout('under', 1), ai.fallbackPayout('over', 8));
});

test('probabilities over and under a barrier sum to one minus the barrier itself', () => {
    const distribution = Array.from({ length: 10 }, () => 0.1);
    assert.ok(Math.abs(ai.probabilityOver(distribution, 4) - 0.5) < 1e-9);
    assert.ok(Math.abs(ai.probabilityUnder(distribution, 5) - 0.5) < 1e-9);
    assert.ok(Math.abs(ai.probabilityOver(distribution, 5) + ai.probabilityUnder(distribution, 5) - 0.9) < 1e-9);
});

test('a plan is coherent: the barrier, direction, stake and probability belong together', () => {
    const series = walk(1500);
    const plan = ai.planTrade(series, { horizon: 5, minEdge: 1.5, minConfidence: 55, brain: ai.defaultBrain() });
    assert.ok(plan.best, 'a plan always names a best candidate even when it declines to trade');
    assert.ok(plan.barrier >= 0 && plan.barrier <= 9);
    assert.ok(['over', 'under'].includes(plan.direction));
    assert.ok(plan.candidates.length >= 10);
    // The winner must be the candidate with the strongest measured lean.
    const best = plan.candidates.reduce((a, b) => (b.tStat > a.tStat ? b : a));
    assert.equal(best.barrier, plan.best.barrier);
    assert.equal(best.direction, plan.best.direction);
    // Every candidate carries the numbers the UI shows.
    plan.candidates.forEach(candidate => {
        assert.ok(candidate.payout > 0);
        assert.ok(candidate.probability >= 0 && candidate.probability <= 1);
        assert.ok(candidate.rawProbability >= 0 && candidate.rawProbability <= 1);
        assert.ok(Number.isFinite(candidate.edge));
        assert.ok(Number.isFinite(candidate.tStat));
        assert.ok(candidate.kelly >= 0 && candidate.kelly <= 1);
    });
    assert.ok(plan.stakeFactor >= 0 && plan.stakeFactor <= 1);
    assert.equal(typeof plan.reason, 'string');
    assert.ok(plan.summary.includes(plan.direction.toUpperCase()));
});

test('a fair stream rarely reaches the entry bar', () => {
    let fired = 0;
    for (let trial = 0; trial < 12; trial++) {
        const series = walk(1400, { seed: 31 + trial * 97 });
        const plan = ai.planTrade(series, { horizon: 5, minEdge: 1.5, minConfidence: 55, brain: ai.defaultBrain() });
        if (plan.go) fired += 1;
    }
    // Digit markets are close to fair: an honest engine must decline most ticks.
    assert.ok(fired <= 4, `the engine fired on ${fired} of 12 fair streams`);
});

test('learning moves the expert weights and grows the neural net', () => {
    const brain = ai.defaultBrain();
    const before = { ...brain.experts.analog };
    const distribution = Array.from({ length: 10 }, (_, d) => (d === 7 ? 0.7 : 0.3 / 9));
    const next = ai.learn(brain, {
        digit: 7,
        features: [0.4, -0.2, 1.1, 0.3, 0.05],
        expertDistributions: [
            { name: 'analog', distribution },
            { name: 'frequency', distribution: Array.from({ length: 10 }, () => 0.1) },
        ],
    });
    assert.equal(next.trained, 1);
    assert.notEqual(next.experts.analog.weight, before.weight);
    assert.ok(next.experts.analog.weight > next.experts.frequency.weight, 'the expert that called it should gain weight');
    assert.equal(next.neural.updates, 1);
    assert.ok(next.neural.weights.some(row => row.some(value => value !== 0)));
    // Learning is idempotent-free: the original brain object is untouched.
    assert.equal(brain.trained, 0);
});

test('repeated lessons on one digit sharpen the net’s forecast for it', () => {
    let brain = ai.defaultBrain();
    const features = [0.5, 0.5, 1.2, 0.4, 0.1];
    const flat = Array.from({ length: 10 }, () => 0.1);
    for (let i = 0; i < 200; i++) {
        brain = ai.learn(brain, { digit: 9, features, expertDistributions: [{ name: 'neural', distribution: flat }] });
    }
    const { distribution } = ai.neuralDistribution(brain, features);
    assert.ok(distribution[9] > 0.3, `the net should favourite digit 9, got ${distribution[9].toFixed(3)}`);
    assert.ok(Math.abs(math.sum(distribution) - 1) < 1e-9);
});

test('memory keeps one brain per market and can forget', () => {
    const symbol = `test-${Date.now()}`;
    memory.resetBrain(symbol);
    assert.equal(memory.loadBrain(symbol).trained, 0);
    const taught = ai.learn(memory.loadBrain(symbol), { digit: 3, features: [0, 0, 1, 0, 0] });
    memory.saveBrain(symbol, taught);
    assert.equal(memory.loadBrain(symbol).trained, 1);
    assert.equal(memory.brainSize(symbol).trained, 1);
    memory.resetBrain(symbol);
    assert.equal(memory.loadBrain(symbol).trained, 0);
});

test('session statistics track streaks, win rate and drawdown', () => {
    memory.resetStats();
    assert.equal(memory.winRate(), 0);
    memory.recordTrade({ won: true, profit: 5 });
    memory.recordTrade({ won: true, profit: 4 });
    assert.equal(memory.getStats().streak, 2);
    assert.equal(memory.winRate(), 100);
    memory.recordTrade({ won: false, profit: -9 });
    assert.equal(memory.getStats().streak, -1);
    assert.ok(Math.abs(memory.winRate() - 66.67) < 0.1);
    assert.ok(memory.getStats().runningProfit === 0);
    assert.ok(memory.getStats().maxDrawdown >= 9);
    memory.resetStats();
    assert.equal(memory.getStats().trades, 0);
});

test('kelly and the shrink helpers behave at the edges', () => {
    assert.equal(math.kellyFraction(0.5, 1), 0);
    assert.ok(math.kellyFraction(1, 2) === 1);
    assert.ok(math.kellyFraction(0.6, 2) > 0 && math.kellyFraction(0.6, 2) < 1);
    assert.equal(math.clamp(5, 0, 1), 1);
    assert.equal(math.mapRange(5, 0, 10, 0, 100), 50);
    assert.equal(math.lerp(0, 10, 0.25), 2.5);
    assert.ok(math.seededRandom(42) > 0 && math.seededRandom(42) < 1);
    assert.equal(math.seededRandom(42), math.seededRandom(42));
});

test('the engine trades a planted bias and declines a fair stream', () => {
    const options = { horizon: 5, minLean: 1.5, minConfidence: 55, minAgreement: 0.7, brain: ai.defaultBrain() };
    let firedOnBias = 0;
    for (let trial = 0; trial < 6; trial++) {
        const plan = ai.planTrade(biasedDigits(1400, { seed: 11 + trial * 13 }), options);
        if (plan.go) firedOnBias += 1;
    }
    assert.equal(firedOnBias, 6, 'a market with a real, measured lean should be traded');

    let firedOnFair = 0;
    for (let trial = 0; trial < 12; trial++) {
        const plan = ai.planTrade(walk(1400, { seed: 31 + trial * 997 }), options);
        if (plan.go) firedOnFair += 1;
    }
    assert.equal(firedOnFair, 0, 'a fair stream must not produce entries');

    // And when it does decline, it says why.
    const declined = ai.planTrade(walk(1400), options);
    assert.equal(declined.go, false);
    assert.ok(declined.reason.length > 0);
    assert.ok(declined.summary.includes('fair'));
});

test('the significance bar is what separates signal from noise, not the payout', () => {
    const base = { horizon: 5, minConfidence: 55, minAgreement: 0.7, brain: ai.defaultBrain() };
    const strong = ai.planTrade(biasedDigits(1400), { ...base, minLean: 1.5 });
    const stricter = ai.planTrade(biasedDigits(1400), { ...base, minLean: 3 });
    assert.ok(strong.tStat >= 1.5);
    // A stronger signal needs a stronger lean; the stake follows it.
    assert.ok(strong.stakeFactor > 0);
    assert.ok(Number.isFinite(stricter.stakeFactor));
    // Raising the bar can only ever make the engine pickier.
    if (stricter.go) assert.ok(stricter.tStat >= 3);
});

test('learning from a run of outcomes shifts the forecast toward what happened', () => {
    let brain = ai.defaultBrain();
    const features = [0.2, 0.1, 1, 0.3, 0];
    const flat = Array.from({ length: 10 }, () => 0.1);
    const before = ai.neuralDistribution(brain, features).distribution.slice();
    for (let i = 0; i < 120; i++) {
        brain = ai.learn(brain, { digit: 3, features, expertDistributions: [{ name: 'neural', distribution: flat }] });
    }
    const after = ai.neuralDistribution(brain, features).distribution;
    assert.ok(after[3] > before[3], 'the net should move toward the digit it was taught');
    assert.ok(Math.abs(math.sum(after) - 1) < 1e-9);
});

test('a min lean of zero means trade, not wait', () => {
    // The shipped bot runs with the bars off so it actually opens positions.
    // Everything is still measured and published — only the gate moves.
    const relaxed = { horizon: 1, minLean: 0, minConfidence: 0, minAgreement: 0, minEdge: -100, risk: 0.6 };

    let fired = 0;
    const trials = 20;
    for (let trial = 0; trial < trials; trial++) {
        if (ai.planTrade(walk(1000, { seed: 71 + trial * 13 }), relaxed).go) fired += 1;
    }
    assert.equal(fired, trials, 'with the bars off a fair market is still traded');
});

test('a relaxed entry is a real contract, not the largest shortfall', () => {
    const relaxed = { horizon: 1, minLean: 0, minConfidence: 0, minAgreement: 0, minEdge: -100, risk: 0.6 };

    for (let trial = 0; trial < 20; trial++) {
        const plan = ai.planTrade(walk(1000, { seed: 71 + trial * 13 }), relaxed);
        assert.equal(plan.go, true);
        assert.ok(plan.barrier >= 0 && plan.barrier <= 9);
        assert.ok(['over', 'under'].includes(plan.direction));
        assert.ok(plan.best.bias > 0, 'the contract it buys has to lean past the fair odds');
        // Over 9 and under 0 win on no digit at all; the API rejects them.
        assert.ok(ai.winningDigitCount(plan.direction, plan.barrier) > 0);
        assert.ok(plan.payout > 0 && Number.isFinite(plan.payout));
        assert.ok(Number.isFinite(plan.edge), 'the expected value is still reported, however bad');
    }
});

test('the bars are the only thing standing between a fair market and a trade', () => {
    const strict = { horizon: 1, minLean: 1.5, minConfidence: 55, minAgreement: 0.7, minEdge: -100, risk: 0.6 };
    const relaxed = { ...strict, minLean: 0, minConfidence: 0, minAgreement: 0 };

    let strictFired = 0;
    let relaxedFired = 0;
    const trials = 20;
    for (let trial = 0; trial < trials; trial++) {
        const stream = walk(1000, { seed: 71 + trial * 13 });
        if (ai.planTrade(stream, strict).go) strictFired += 1;
        if (ai.planTrade(stream, relaxed).go) relaxedFired += 1;
    }
    assert.equal(strictFired, 0, 'the bars are what keep a fair market quiet');
    assert.equal(relaxedFired, trials, 'taking them off is what makes the bot trade');
});

/* ------------------------------------------------------------------ *
 * Choosing a market
 * ------------------------------------------------------------------ */

/** A picker whose clock we control, so a dwell timer can be tested. */
function fakeClock() {
    let t = 0;
    return { now: () => t, advance: seconds => (t += seconds * 1000) };
}

test('the bot leaves the market it started on', () => {
    // Regression: the dwell clock used to sit at zero until the first switch,
    // so "seconds on market" was always 0 < dwell and the guard returned early
    // on every tick. The bot was pinned to its opening market forever.
    const clock = fakeClock();
    const picker = createMarketPicker({ now: clock.now });
    const start = 'R_100';

    assert.equal(picker.choose({ mode: 'next', dwell: 2, current: start }), start, 'dwell not elapsed yet');
    clock.advance(1);
    assert.equal(picker.choose({ mode: 'next', dwell: 2, current: start }), start, 'still inside the dwell');

    clock.advance(1.5);
    const moved = picker.choose({ mode: 'next', dwell: 2, current: start });
    assert.notEqual(moved, start, 'the bot must move once the dwell has passed');
    assert.ok(VOLATILITY_MARKETS.includes(moved));
});

test('after a switch the dwell clock restarts', () => {
    const clock = fakeClock();
    const picker = createMarketPicker({ now: clock.now });
    picker.start(); // the bot has been on R_100 since the session began

    clock.advance(3);
    const first = picker.choose({ mode: 'next', dwell: 2, current: 'R_100' });
    picker.markSwitched();
    assert.notEqual(first, 'R_100');

    // One tick later it must not move again, or it would thrash the API.
    clock.advance(0.5);
    assert.equal(picker.choose({ mode: 'next', dwell: 2, current: first }), first);

    clock.advance(2);
    assert.notEqual(picker.choose({ mode: 'next', dwell: 2, current: first }), first);
});

test('the bot walks every market in turn', () => {
    const clock = fakeClock();
    const picker = createMarketPicker({ now: clock.now });
    const visited = ['R_100'];

    for (let step = 0; step < 10; step++) {
        clock.advance(3);
        const next = picker.choose({ mode: 'next', dwell: 2, current: visited[visited.length - 1] });
        picker.markSwitched();
        if (next !== visited[visited.length - 1]) visited.push(next);
    }
    assert.equal(visited.length, VOLATILITY_MARKETS.length, 'a full lap should reach every market');
    assert.equal(new Set(visited).size, VOLATILITY_MARKETS.length, 'and never repeat one');
});

test('random mode moves, and can reach more than one market', () => {
    const clock = fakeClock();
    const picker = createMarketPicker({ now: clock.now });
    picker.start();
    clock.advance(5);
    const seen = new Set();
    let current = 'R_100';
    for (let step = 0; step < 40; step++) {
        clock.advance(3);
        const next = picker.choose({ mode: 'random', dwell: 2, current });
        picker.markSwitched();
        assert.notEqual(next, current, 'random mode never stays put once the dwell is up');
        current = next;
        seen.add(next);
    }
    assert.ok(seen.size > 1, 'a random walk should visit more than one market');
});

test('the best mode goes to the market that scored highest', () => {
    const clock = fakeClock();
    const picker = createMarketPicker({ now: clock.now });
    picker.recordScore('R_10', 20);
    picker.recordScore('R_50', 80);
    picker.recordScore('R_75', 40);

    picker.start();
    clock.advance(5);
    assert.equal(picker.choose({ mode: 'best', dwell: 2, current: 'R_100' }), 'R_50');
    // Standing on the best one, it should go to the next best.
    assert.equal(picker.choose({ mode: 'best', dwell: 2, current: 'R_50' }), 'R_75');
});

test('the suitable mode stays on a good market and leaves a bad one', () => {
    const clock = fakeClock();
    const picker = createMarketPicker({ now: clock.now });
    picker.recordScore('R_100', 70);

    picker.start();
    clock.advance(5);
    assert.equal(picker.choose({ mode: 'suitable', minScore: 50, dwell: 2, current: 'R_100' }), 'R_100');
    assert.notEqual(picker.choose({ mode: 'suitable', minScore: 90, dwell: 2, current: 'R_100' }), 'R_100');
});

test('a market score reflects the strength of the read', () => {
    const relaxed = { horizon: 1, minLean: 0, minConfidence: 0, minAgreement: 0, minEdge: -100, risk: 0.6 };
    const quiet = ai.planTrade(walk(600, { seed: 5 }), relaxed);
    const loud = ai.planTrade(biasedDigits(1200, { rate: 0.6, seed: 3 }), relaxed);
    assert.ok(scoreMarket(loud) > scoreMarket(quiet), 'a market with a measurable lean should score higher');
    assert.ok(scoreMarket(loud) <= 100 && scoreMarket(quiet) >= 0);
    assert.equal(scoreMarket(null), 0);
});

test('a plan with the bars off always names a buyable contract', () => {
    // Ten flat digit streams: every digit appears exactly as often as every
    // other, which is the worst case for a significance gate — and the case the
    // shipped bot spends most of its life in.
    const even = Array.from({ length: 600 }, (_, i) => Number(`500.${(i % 10)}0`));
    const relaxed = { horizon: 1, minLean: 0, minConfidence: 0, minAgreement: 0, minEdge: -100, risk: 0.6 };

    const plan = ai.planTrade(even, relaxed);
    assert.equal(plan.go, true, 'the bot buys even when nothing leans past the fair odds');
    assert.ok(plan.best, 'and it names the contract it is buying');
    assert.ok(plan.barrier >= 0 && plan.barrier <= 9);
    assert.ok(['over', 'under'].includes(plan.direction));
    assert.ok(plan.payout > 0);
    // A forced entry still has to be a real contract with a real stake.
    assert.ok(ai.winningDigitCount(plan.direction, plan.barrier) > 0);
    assert.ok(plan.stakeFactor >= 0.2, 'a forced entry is never sized to zero');
});

test('with the bars off every tick of every market is tradeable', () => {
    const relaxed = { horizon: 1, minLean: 0, minConfidence: 0, minAgreement: 0, minEdge: -100, risk: 0.6 };
    let fired = 0;
    const trials = 40;
    for (let trial = 0; trial < trials; trial++) {
        // Short histories too: twelve ticks is the floor the interface now uses.
        const size = trial % 2 ? 12 : 400;
        const plan = ai.planTrade(walk(size, { seed: 101 + trial * 17 }), relaxed);
        if (plan.go) fired += 1;
        assert.ok(plan.best, `trial ${trial} produced no contract`);
    }
    assert.equal(fired, trials, 'the entry switch must never be the reason nothing opens');
});

test('a plan is never passed off as a measured edge when it was not one', () => {
    const even = Array.from({ length: 600 }, (_, i) => Number(`500.${(i % 10)}0`));
    const relaxed = { horizon: 1, minLean: 0, minConfidence: 0, minAgreement: 0, minEdge: -100, risk: 0.6 };
    const plan = ai.planTrade(even, relaxed);

    // A flat digit stream is the one case where no barrier can lean past the
    // fair odds for every candidate at once; if the engine had to force the
    // entry it must say so rather than dress it up as a signal. Otherwise it
    // found a real (if tiny) lean and reports that instead.
    if (plan.forced) {
        assert.match(plan.reason, /safest contract/);
        assert.match(plan.summary, /forced/);
    } else {
        assert.ok(plan.best.bias > 0, 'a non-forced plan always carries a positive lean');
        assert.doesNotMatch(plan.summary, /forced/);
    }
    assert.equal(plan.go, true, 'either way the bot has a position to open');
});

test('the bars switch the forcing off: an explicit floor is never overridden', () => {
    const strict = { horizon: 1, minLean: 2.5, minConfidence: 60, minAgreement: 0.8, minEdge: 0.5, risk: 0.6 };
    let fired = 0;
    for (let trial = 0; trial < 20; trial++) {
        const plan = ai.planTrade(walk(800, { seed: 5 + trial * 31 }), strict);
        if (plan.go) fired += 1;
        assert.equal(plan.forced, false);
    }
    assert.ok(fired <= 2, `strict bars must stay quiet, fired on ${fired} of 20`);
});

test('forceEntry can be turned off programmatically', () => {
    const even = Array.from({ length: 600 }, (_, i) => Number(`500.${(i % 10)}0`));
    const plan = ai.planTrade(even, {
        horizon: 1,
        minLean: 0,
        minEdge: -100,
        risk: 0.6,
        forceEntry: false,
    });
    assert.equal(plan.forced, false);
    assert.equal(plan.go, Boolean(plan.best?.passes));
});
