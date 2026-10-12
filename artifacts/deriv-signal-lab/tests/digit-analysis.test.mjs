import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDigits,
  evaluateHistoricalContract,
  extractFinalDigit,
  precisionFromPipSize,
  supportedTickDurations,
} from '../src/lib/digit-analysis.ts';

const observation = (digit, index, symbol = 'TEST') => ({
  symbol,
  quote: digit,
  epoch: 1_700_000_000 + index,
  pipSize: 1,
  precision: 0,
  digit,
});

test('precision is derived only from verified power-of-ten pip sizes', () => {
  assert.equal(precisionFromPipSize(0.01), 2);
  assert.equal(precisionFromPipSize(0.001), 3);
  assert.equal(precisionFromPipSize(1), 0);
  assert.equal(precisionFromPipSize(0), null);
  assert.equal(precisionFromPipSize(Number.NaN), null);
  assert.equal(precisionFromPipSize(0.25), null);
  assert.equal(precisionFromPipSize(0.0100000001), null);
  assert.equal(precisionFromPipSize(1e-13), null);
});

test('decimal-safe digit extraction respects each symbol precision and trailing zeros', () => {
  assert.equal(extractFinalDigit(123.45, 0.01), 5);
  assert.equal(extractFinalDigit(12.3, 0.01), 0);
  assert.equal(extractFinalDigit(1.23, 0.001), 0);
  assert.equal(extractFinalDigit(1.234, 0.01), null);
  assert.equal(extractFinalDigit(1e-7, 1e-7), 1);
  assert.equal(extractFinalDigit(-1.23, 0.01), null);
  assert.equal(extractFinalDigit(1.23, 0.25), null);
});

test('digit distribution keeps all ten digits and classifies zero as even', () => {
  const analysis = analyzeDigits([0, 1, 2, 2, 9]);
  assert.equal(analysis.sampleSize, 5);
  assert.deepEqual(analysis.digitCounts, [1, 1, 2, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(analysis.parityCounts, [3, 2]);
  assert.equal(analysis.mostFrequentDigit, 2);
  assert.equal(analysis.digitFrequencies[7], 0);
  assert.equal(analysis.windows.find((window) => window.window === 10)?.sample, 5);
  assert.ok(analysis.normalizedEntropy >= 0 && analysis.normalizedEntropy <= 1);
});

test('empty digit windows remain unavailable rather than fabricating a distribution', () => {
  const analysis = analyzeDigits([]);
  assert.equal(analysis.sampleSize, 0);
  assert.equal(analysis.lastDigit, null);
  assert.ok(analysis.digitFrequencies.every((value) => value === null));
  assert.equal(analysis.entropyBits, null);
  assert.equal(analysis.mostFrequentDigit, null);
});

test('strict Over/Under boundaries, equality losses, parity and Matches targets settle correctly', () => {
  const ticks = [0, 0, 1, 0, 0, 9].map(observation);
  const context = { digit: 0 };
  const overZero = evaluateHistoricalContract(ticks, { family: 'over-under', contractType: 'DIGITOVER', barrier: 0 }, 1, context);
  const underOne = evaluateHistoricalContract(ticks, { family: 'over-under', contractType: 'DIGITUNDER', barrier: 1 }, 1, context);
  const overZeroBaseline = evaluateHistoricalContract(ticks, { family: 'over-under', contractType: 'DIGITOVER', barrier: 0 }, 1);
  assert.equal(overZeroBaseline.sample, 5);
  assert.equal(overZeroBaseline.empiricalHitRate, 0.4);
  assert.equal(overZero.sample, 4);
  assert.equal(overZero.hits, 2);
  assert.equal(overZero.empiricalHitRate, 0.5);
  assert.ok(overZero.wilson95.lower < 0.5 && overZero.wilson95.upper > 0.5);
  assert.equal(overZero.barrierEqual, 2);
  assert.equal(underOne.hits, 2);
  assert.equal(underOne.barrierEqual, 1);

  const even = evaluateHistoricalContract(ticks, { family: 'even-odd', contractType: 'DIGITEVEN' }, 1, { parity: 0 });
  assert.equal(even.contextParity, 0);
  assert.equal(even.sample, 4);
  assert.equal(even.hits, 2);

  for (let targetDigit = 0; targetDigit <= 9; targetDigit += 1) {
    const match = evaluateHistoricalContract(ticks, { family: 'matches', contractType: 'DIGITMATCH', targetDigit }, 1, context);
    assert.equal(match.sample, 4);
    assert.equal(match.hits, ticks.slice(1).filter((_, index) => ticks[index].digit === 0 && ticks[index + 1].digit === targetDigit).length);
  }
});

test('uncertainty intervals remain unavailable without outcome samples', () => {
  const outcome = evaluateHistoricalContract([], { family: 'matches', contractType: 'DIGITMATCH', targetDigit: 0 }, 1);
  assert.equal(outcome.sample, 0);
  assert.equal(outcome.empiricalHitRate, null);
  assert.equal(outcome.wilson95, null);
  assert.equal(outcome.smoothedHistoricalHitRate, null);
});

test('transition counts and smoothed rows preserve support counts', () => {
  const analysis = analyzeDigits([0, 2, 1, 0]);
  assert.equal(analysis.transitionCounts[0][2], 1);
  assert.equal(analysis.transitionCounts[2][1], 1);
  assert.equal(analysis.transitionCounts[1][0], 1);
  assert.equal(analysis.transitionProbabilities[9][0], null);
  assert.ok(Math.abs(analysis.transitionProbabilities[0].reduce((sum, value) => sum + (value ?? 0), 0) - 1) < 1e-12);
});

test('duration ranges are used only when finite integer bounds are available', () => {
  assert.deepEqual(supportedTickDurations(1, 4), [1, 2, 3, 4]);
  assert.deepEqual(supportedTickDurations(null, 4), []);
  assert.deepEqual(supportedTickDurations(1, 101), []);
  assert.deepEqual(supportedTickDurations(3.5, 5), []);
});
