// Accuracy upgrades for the AI Vision engine: the analog expert must
// condition on the CURRENT market state (it used to compare history to
// the average state), learning must grade the forecast that opened a
// contract and learn from the whole tick stream (shadow samples), and
// the analysis horizon must target the tick that actually settles the
// contract (entry is the next tick after the buy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as ai from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/vision-ai.mjs';

function walk(size, { start = 1234.56, step = 0.37, decimals = 2, seed = 7 } = {}) {
    let state = seed;
    const random = () => {
        state = (state * 16807) % 2147483647;
        return (state - 1) / 2147483646;
    };
    const quotes = [start];
    for (let i = 1; i < size; i++) {
        const drift = Math.sin(i / 37) * 0.02;
        quotes.push(Number((quotes[i - 1] + (random() - 0.5) * step * 2 + drift).toFixed(decimals)));
    }
    return quotes;
}

const ramp = (series, perTick, count) => {
    const out = series.slice();
    for (let i = 0; i < count; i++) out.push(Number((out[out.length - 1] + perTick).toFixed(2)));
    return out;
};

test('the analog expert conditions on the current state, not the average one', () => {
    const base = walk(1400);
    const up = ramp(base, 0.37, 90);
    const down = ramp(base, -0.37, 90);
    const aUp = ai.analogDistribution(up, 1).distribution;
    const aDown = ai.analogDistribution(down, 1).distribution;
    const l1 = aUp.reduce((sum, value, index) => sum + Math.abs(value - aDown[index]), 0);
    // The old standardisation zeroed the current vector, leaving opposite
    // regimes nearly indistinguishable (L1 ≈ 0.05 on this fixture). A
    // working analog replays DIFFERENT history for opposite states.
    assert.ok(l1 > 0.15, `opposite regimes should replay different history (L1 ${l1.toFixed(3)})`);
    // And it should favour the digit each ramp is actually heading to:
    // +0.37/tick advances the last digit by 7 (mod 10), −0.37 by 3.
    const lastDigit = series => Math.round((series[series.length - 1] * 100) % 10);
    assert.ok(aUp[(lastDigit(up) + 7) % 10] > 0.115, 'up-ramp continuation digit should be favoured');
    assert.ok(aDown[(lastDigit(down) + 3) % 10] > 0.115, 'down-ramp continuation digit should be favoured');
});

test('shadow learning trains the experts without touching the win/loss record', () => {
    const brain = ai.defaultBrain();
    const sharp = Array.from({ length: 10 }, (_, index) => (index === 4 ? 0.55 : 0.05));
    const flat = new Array(10).fill(0.1);
    const next = ai.learn(brain, {
        digit: 4,
        shadow: true,
        expertDistributions: [
            { name: 'analog', distribution: sharp },
            { name: 'frequency', distribution: flat },
        ],
    });
    assert.equal(next.trained, brain.trained + 1, 'a shadow sample is still training');
    assert.equal(next.wins, brain.wins, 'shadow samples are not trades');
    assert.equal(next.losses, brain.losses, 'shadow samples are not trades');
    assert.ok(next.experts.analog.weight > next.experts.frequency.weight, 'the expert that called it gains weight');
});

test('the interface targets the settling tick and grades the opening forecast', async () => {
    const source = await readFile(
        new URL(
            '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/Interface/VisionInterface.js',
            import.meta.url
        ),
        'utf8'
    );
    // Expiry is one tick further out than the contract duration (entry is
    // the next tick), so the forecast horizon is duration + 1.
    assert.match(source, /forecastHorizon = Math\.max\(1, Math\.round\(num\(overrides\.horizon \?\? horizonTicks\(\)/);
    assert.match(source, /DEFAULT_HORIZON\)\)\) \+ 1;/);
    // Shadow learning: every forecast filed, graded when its tick prints.
    assert.match(source, /forecastLedger/);
    assert.match(source, /shadow: true/);
    assert.match(source, /trackForecast\(symbol, ticks, plan\)/);
    // Entry snapshot: marked at purchase, graded at settlement.
    assert.match(source, /entrySnapshot/);
    assert.match(source, /visionMarkEntry: async \(\) => \{\s*\n\s*pacer\.mark\(\);\s*\n\s*snapshotEntryPlan\(\)/);
    assert.match(source, /const graded = opening \|\| cached\?\.plan/);
});

test('the regime expert reverses a stretch and refuses to extrapolate a burst', () => {
    const base = walk(1400);
    // A quiet tape parked above its long mean: reversion is the only honest read.
    const quiet = base.slice(0, 1200).map((value, index) => (index > 1100 ? Number((value + 1.6).toFixed(2)) : value));
    const reversion = ai.regimeDistribution(quiet, 5);
    assert.equal(reversion.regime, 'reversion');
    assert.ok(reversion.conviction > 0.3, `a 1.6-point stretch should carry conviction (${reversion.conviction.toFixed(2)})`);
    // The reversion forecast lands below the quote, the momentum forecast above
    // it: the two experts disagree by construction, which is the point of having
    // both. Compare the probability mass below the current digit.
    const below = distribution => {
        const digits = ai.momentumDistribution(quiet, 5);
        const current = Math.round((quiet[quiet.length - 1] * 100) % 10);
        const mass = dist => dist.reduce((acc, p, d) => acc + (d < current ? p : 0), 0);
        return { regime: mass(distribution), momentum: mass(digits), current };
    };
    const split = below(reversion.distribution);
    assert.ok(split.regime >= split.momentum, 'a stretched tape forecasts lower digits than pure momentum');

    // An expanding burst must NOT be extrapolated: the distribution widens out
    // toward uniform instead of chasing the move.
    const burst = walk(1400, { seed: 21 }).slice();
    for (let i = burst.length - 60; i < burst.length; i++) burst[i] = Number((burst[i] + (i % 2 ? 9 : -9)).toFixed(2));
    const expanded = ai.regimeDistribution(burst, 5);
    const entropy = dist => -dist.reduce((acc, p) => acc + (p > 0 ? p * Math.log(p) : 0), 0);
    assert.ok(expanded.conviction >= 0 && expanded.conviction <= 1);
    assert.ok(entropy(expanded.distribution) > 1.5, 'a burst widens the band rather than naming a digit');
});

test('the own record calibrates the estimate instead of vetoing the trade', () => {
    // No record: nothing measured, nothing changed.
    assert.deepEqual(ai.recordCalibration(0, 0, 0.55), { factor: 1, hitRate: null, samples: 0, earned: null });
    // A record below break-even pulls the estimate back toward the anchor...
    const cold = ai.recordCalibration(5, 40, 0.55);
    assert.equal(cold.factor, 0.35);
    assert.equal(cold.earned, false);
    // ...but never parks it: the floor is 0.35, not zero.
    assert.ok(cold.factor > 0);
    // An earned record sharpens it, capped at 1.25.
    assert.equal(ai.recordCalibration(36, 40, 0.55).factor, 1.25);
    // At break-even the factor is exactly 1.
    assert.equal(ai.recordCalibration(22, 40, 0.55).factor, 1);

    const series = walk(1400);
    const coldPlan = ai.planTrade(series, { horizon: 5, brain: { ...ai.defaultBrain(), wins: 5, losses: 35 } });
    assert.equal(coldPlan.hitSamples, 40);
    assert.ok(coldPlan.hitRate < 0.2);
    assert.equal(coldPlan.calibration, 0.35);
    // The lean is still measured and published: significance is a property of
    // the data, not of the record.
    assert.ok(Number.isFinite(coldPlan.tStat));
    assert.match(coldPlan.summary, /own record/);
});
