import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePriceContext } from '../src/lib/price-context.ts';

function ticksFrom(quotes) {
  return quotes.map((quote, index) => ({ quote, epoch: 1_700_000_000 + index }));
}

test('tick-price indicators withhold values until their lookbacks exist', () => {
  const context = analyzePriceContext(ticksFrom(Array.from({ length: 20 }, (_, index) => 100 + index)));
  assert.equal(context.sampleSize, 20);
  assert.ok(Math.abs(context.ema9 - 115) < 1e-8);
  assert.equal(context.ema21, null);
  assert.equal(context.ema50, null);
  assert.equal(context.rsi14, 100);
  assert.equal(context.macdSignal, null);
  assert.equal(context.realizedVolatility50Percent, null);
  assert.equal(context.asOfEpoch, 1_700_000_019);
});

test('flat quotes produce finite neutral RSI, zero ROC and zero volatility', () => {
  const context = analyzePriceContext(ticksFrom(Array.from({ length: 80 }, () => 100)));
  assert.equal(context.ema9, 100);
  assert.equal(context.ema21, 100);
  assert.equal(context.ema50, 100);
  assert.equal(context.rsi14, 50);
  assert.equal(context.roc14Percent, 0);
  assert.equal(context.realizedVolatility50Percent, 0);
  assert.equal(context.macdLine, 0);
  assert.equal(context.macdSignal, 0);
  assert.equal(context.macdHistogram, 0);
  assert.equal(context.swingStructure, 'insufficient swing history');
  assert.equal(context.latestDelta, 0);
  assert.equal(context.unchangedTickRate50, 1);
  assert.equal(context.normalizedMomentum10, 0);
  assert.equal(context.returnAutocorrelation1, 0);
});

test('rising prices are described by price-only momentum without becoming a digit signal', () => {
  const context = analyzePriceContext(ticksFrom(Array.from({ length: 80 }, (_, index) => 100 + index * 0.25)));
  assert.ok(context.ema9 > context.ema21);
  assert.ok(context.ema21 > context.ema50);
  assert.equal(context.rsi14, 100);
  assert.ok(context.macdLine > 0);
  assert.ok(Number.isFinite(context.macdHistogram));
  assert.ok(context.roc14Percent > 0);
  assert.ok(context.realizedVolatility50Percent > 0);
  assert.equal(context.latestDelta, 0.25);
  assert.ok(context.latestSimpleReturn > 0);
  assert.ok(context.meanReturn20 > 0);
  assert.ok(context.returnVolatility20 > 0);
  assert.equal(context.momentum10, 2.5);
  assert.ok(context.normalizedMomentum10 > 0);
  assert.equal(context.positiveTickRate50, 1);
  assert.equal(context.negativeTickRate50, 0);
  assert.equal(context.unchangedTickRate50, 0);
  assert.equal(context.priceChangeQuantiles50.p50, 0.25);
  assert.ok(context.bollinger20.upper > context.bollinger20.mid);
});

test('invalid and absent observations do not fabricate price indicators', () => {
  const empty = analyzePriceContext([]);
  assert.equal(empty.sampleSize, 0);
  assert.equal(empty.asOfEpoch, null);
  assert.equal(empty.ema9, null);
  assert.equal(empty.rsi14, null);
  assert.equal(empty.macdHistogram, null);
  assert.equal(empty.swingStructure, 'insufficient swing history');

  const invalid = analyzePriceContext([{ quote: Number.NaN, epoch: 1 }, { quote: -1, epoch: 2 }]);
  assert.equal(invalid.sampleSize, 0);
  assert.equal(invalid.ema9, null);
  assert.equal(invalid.roc14Percent, null);
});
