import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { priceDecision } from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-strategies.mjs';
import { priceContextAllowed, priceRiskAllowed } from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-risk.mjs';

const trend = Array.from({length: 700}, (_, i) => 100 + i * 0.01);

test('High/Low Tick chooses an actual strict extreme of five ticks from historical paths', () => {
  const decision = priceDecision(trend, 'tick', 5, 0.30);
  assert.equal(decision.ready, true);
  assert.equal(decision.side, 1);
  assert.equal(decision.tick, 5);
  assert.equal(decision.horizon, 5);
  assert.ok(decision.samples >= 200 && decision.conditionalSamples >= 20);
  const reversed = priceDecision([...trend].reverse(), 'tick', 5, 0.30);
  assert.equal(reversed.ready, true);
  assert.equal(reversed.side, 1);
  assert.equal(reversed.tick, 1);
});

test('rise/fall outcome compares entry to expiry, ties are not wins', () => {
  const up = priceDecision(trend, 'rise', 4, 0.56);
  assert.equal(up.side, 1); assert.equal(up.horizon, 4); assert.equal(up.ready, true);
  const down = priceDecision([...trend].reverse(), 'rise', 4, 0.56);
  assert.equal(down.side, -1); assert.equal(down.ready, true);
  const flat = priceDecision(Array(700).fill(1), 'rise', 4, 0.56);
  assert.equal(flat.ready, false); assert.equal(flat.probability, 0);
  const tick = priceDecision(Array(700).fill(1), 'tick', 5, 0.3);
  assert.equal(tick.ready, false); assert.equal(tick.probability, 0);
});

test('no entries for insufficient, malformed, thin or unsupported history', () => {
  assert.equal(priceDecision(trend.slice(0, 255), 'rise', 4, .56).ready, false);
  assert.equal(priceDecision([...trend.slice(0, -1), NaN], 'rise', 4, .56).ready, false);
  assert.equal(priceDecision(trend, 'rise', 0, .56).ready, false);
  assert.equal(priceDecision(trend, 'rise', 11, .56).ready, false);
  const differentCurrentState = [...trend.slice(0, -2), trend.at(-1) + 1, trend.at(-1)];
  assert.equal(priceDecision(differentCurrentState, 'rise', 4, .56).ready, false);
});

test('risk gate counts both legs, fails closed on invalid balance and stops at limits', () => {
  const config = { stake: 1, legs: 2, baseline: 4, loss: 10, target: 5, percent: 5, balance: 100, sessionProfit: 4 };
  assert.equal(priceRiskAllowed(config), true);
  assert.equal(priceRiskAllowed({ ...config, balance: NaN }), false);
  assert.equal(priceRiskAllowed({ ...config, balance: 20 }), false);
  assert.equal(priceRiskAllowed({ ...config, sessionProfit: -4.5 }), false); // only 1.5 left, pair risks 2
  assert.equal(priceRiskAllowed({ ...config, sessionProfit: 9 }), false);
  assert.equal(priceRiskAllowed({ ...config, hedgeIncomplete: true }), false);
  assert.equal(priceRiskAllowed({ ...config, legs: 3 }), false);
});

test('strategy context refuses wrong family, duration, market or units', () => {
  const step = { symbol: 'stpRNG', duration: 4, duration_unit: 't' };
  const rise = { contractTypes: ['CALL', 'PUT'] };
  assert.equal(priceContextAllowed('step-hedge', 4, step, rise), true);
  assert.equal(priceContextAllowed('step-hedge', 4, { ...step, duration: 5 }, rise), false);
  assert.equal(priceContextAllowed('step-hedge', 4, { ...step, symbol: 'R_100' }, rise), false);
  assert.equal(priceContextAllowed('step-hedge', 4, { ...step, duration_unit: 'm' }, rise), false);
  assert.equal(priceContextAllowed('step-hedge', 4, step, { contractTypes: ['CALL'] }), false);
  assert.equal(priceContextAllowed('tick', 5, { ...step, duration: 5 }, { contractTypes: ['TICKHIGH', 'TICKLOW'] }), true);
});

test('store files contain actual strategy blocks and the step bot is four ticks', async () => {
  const root = new URL('../src/lib/bot-store/bots/', import.meta.url);
  const tick = await readFile(new URL('high-low-tick-sniper.xml', root), 'utf8');
  const rise = await readFile(new URL('rise-fall-ensemble.xml', root), 'utf8');
  const hedge = await readFile(new URL('step-rise-fall-hedge.xml', root), 'utf8');
  for (const xml of [tick, rise, hedge]) {
    for (const name of ['trade_definition', 'before_purchase', 'after_purchase', 'x_price_decision', 'x_price_risk', 'trade_again']) assert.ok(xml.includes(`type="${name}"`), name);
    assert.match(xml, /baseline profit/); assert.match(xml, /loss limit/); assert.match(xml, /profit target/);
  }
  assert.match(tick, /type="x_tick_decision_purchase"/);
  assert.match(tick, /<field name="MODE">tick<\/field>/);
  assert.match(rise, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(rise, /<field name="PURCHASE_LIST">PUT<\/field>/);
  assert.match(hedge, /<field name="SYMBOL_LIST">stpRNG<\/field>/);
  assert.match(hedge, /<field name="MODE">step-hedge<\/field>/);
  assert.match(hedge, /<field name="HEDGE_LIST">PUT<\/field>/);
  assert.match(hedge, /<field name="NUM">4<\/field>/);
});
