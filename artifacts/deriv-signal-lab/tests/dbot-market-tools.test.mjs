import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRiskScenario, summarizeDigits } from '../src/lib/dbot-market-tools.ts';

test('digit monitor counts only verified digits in the selected window', () => {
  const ticks = [1, 2, null, 0, 7].map((digit, index) => ({ digit, quote: 100, epoch: index + 1 }));
  const result = summarizeDigits(ticks, 4);
  assert.equal(result.considered, 4);
  assert.equal(result.sample, 3);
  assert.equal(result.even, 2);
  assert.equal(result.odd, 1);
  assert.equal(result.counts[0], 1);
  assert.equal(result.counts[1], 0);
  assert.equal(result.lastDigit, 7);
  assert.equal(summarizeDigits([{ digit: null, quote: 1, epoch: 1 }], 100).lastDigit, null);
  assert.equal(summarizeDigits([], 100).sample, 0);
});

test('scenario calculates full-loss progression and total-payout break even', () => {
  const result = calculateRiskScenario({ balance: 10, stake: 1, multiplier: 2, losses: 4, payout: 1.95 });
  assert.deepEqual(result.ladder.map(row => row.stake), [1, 2, 4, 8]);
  assert.deepEqual(result.ladder.map(row => row.cumulative), [1, 3, 7, 15]);
  assert.deepEqual(result.ladder.map(row => row.affordable), [true, true, true, false]);
  assert.equal(result.totalLoss, 15);
  assert.equal(result.percentBalance, 150);
  assert.ok(Math.abs(result.breakEvenPercent - 51.28205128) < 1e-7);
  assert.equal(result.payoutBelowStake, false);
  assert.equal(calculateRiskScenario({ balance: 10, stake: 1, multiplier: 1, losses: 1, payout: 0.9 }).payoutBelowStake, true);
  assert.equal(calculateRiskScenario({ balance: 10, stake: 1, multiplier: 1, losses: 1, payout: 1 }).breakEvenPercent, 100);
  assert.equal(calculateRiskScenario({ balance: 10, stake: 1, multiplier: 1, losses: 1, payout: 1 }).payoutBelowStake, false);
});

test('scenario rejects invalid and extreme inputs rather than inventing values', () => {
  const base = { balance: 10, stake: 1, multiplier: 2, losses: 4, payout: 1.95 };
  for (const change of [{ balance: 0 }, { stake: NaN }, { multiplier: 0.5 }, { multiplier: 11 }, { losses: 0 }, { losses: 2.5 }, { losses: 13 }, { payout: Infinity }]) {
    assert.equal(calculateRiskScenario({ ...base, ...change }), null);
  }
});
