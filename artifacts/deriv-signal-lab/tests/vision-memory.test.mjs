// Session-stats defaults behind the Vision risk guards.
//
// Regression: `runningProfit` used to be created only by recordTrade, so
// before the first settled contract it was `undefined` — and the shipped
// AI Vision bot gates every entry on the take-profit guard
// (`runningProfit < target`). `undefined < 50` is false, so the guard
// blocked the first entry, no trade ever settled to create the field, and
// the bot sat at "Bot is starting" opening nothing, forever.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getStats,
    loadStats,
    recordTrade,
    resetStats,
} from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/vision-memory.mjs';

test('runningProfit is 0 before any trade, so the profit guard can pass', () => {
    resetStats();
    const stats = getStats();
    assert.equal(stats.runningProfit, 0);
    // Exactly the comparison r_profit_guard makes for the shipped bot (50).
    assert.equal(stats.runningProfit < 50, true);
    // And the loss guard's comparison (30) on a fresh session.
    assert.equal(Math.abs(Math.min(0, stats.runningProfit || 0)) < 30, true);
});

test('every stat the guards read is defined on a fresh session', () => {
    resetStats();
    const stats = getStats();
    for (const key of ['runningProfit', 'streak', 'trades', 'wins', 'losses', 'peakProfit', 'maxDrawdown']) {
        assert.equal(typeof stats[key], 'number', `${key} must start as a number, not undefined`);
        assert.ok(Number.isFinite(stats[key]), `${key} must be finite`);
    }
});

test('loadStats over empty storage keeps the numeric defaults', () => {
    resetStats();
    const stats = loadStats();
    assert.equal(stats.runningProfit, 0);
});

test('recordTrade accumulates running profit from the zero start', () => {
    resetStats();
    recordTrade({ won: true, profit: 0.31 });
    recordTrade({ won: false, profit: -0.35 });
    const stats = getStats();
    assert.ok(Math.abs(stats.runningProfit - -0.04) < 1e-9);
    assert.equal(stats.trades, 2);
    // Still inside the shipped bot's guards, so it keeps trading.
    assert.equal(stats.runningProfit < 50, true);
    assert.equal(Math.abs(Math.min(0, stats.runningProfit)) < 30, true);
});
