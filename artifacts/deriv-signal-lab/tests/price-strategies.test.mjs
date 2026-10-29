import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PRICE_MODEL_NAMES, arcsinePrior, priceDecision } from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-strategies.mjs';
import {
  adaptiveStake,
  priceContextAllowed,
  priceRiskAllowed,
  resolvePriceContext,
} from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-risk.mjs';

const trend = Array.from({ length: 700 }, (_, i) => 100 + i * 0.01);

/** A Step Index tick stream: fixed ±0.1 steps, the market the presets trade. */
function stepStream(length, bias = 0.5, seed = 7) {
  // splitmix32. A plain LCG's low bits are too correlated to judge an edge: a
  // "fair" LCG stream still handed the ensemble a 44 % "confident" win rate,
  // which is a property of the generator, not of the market.
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
  let price = 1000;
  const out = [price];
  for (let i = 0; i < length; i++) {
    price += random() < bias ? 0.1 : -0.1;
    out.push(Number(price.toFixed(2)));
  }
  return out;
}

/** The realised outcome of a directional window: 1 rise, -1 fall, 0 tie. */
const outcome = (prices, entry, horizon) => Math.sign(prices[entry + horizon] - prices[entry]);

test('High/Low Tick chooses an actual strict extreme of five ticks from historical paths', () => {
  const decision = priceDecision(trend, 'tick', 5, 0.3);
  assert.equal(decision.ready, true);
  assert.equal(decision.side, 1);
  assert.equal(decision.tick, 5);
  assert.equal(decision.horizon, 5);
  assert.ok(decision.samples >= 200 && decision.conditionalSamples >= 20);
  const reversed = priceDecision([...trend].reverse(), 'tick', 5, 0.3);
  assert.equal(reversed.ready, true);
  assert.equal(reversed.side, 1);
  assert.equal(reversed.tick, 1);
  // The decision is explainable: a reason line, a confidence and a mixture.
  assert.match(decision.reason, /HIGH|LOW/);
  assert.ok(decision.confidence > 0 && decision.confidence <= 100);
  assert.deepEqual(decision.models.map(model => model.name), PRICE_MODEL_NAMES);
});

test('rise/fall outcome compares entry to expiry, ties are not wins', () => {
  const up = priceDecision(trend, 'rise', 5, 0.56);
  assert.equal(up.side, 1);
  assert.equal(up.horizon, 5);
  assert.equal(up.ready, true);
  const down = priceDecision([...trend].reverse(), 'rise', 5, 0.56);
  assert.equal(down.side, -1);
  assert.equal(down.ready, true);

  // A flat market is all ties, and a tie is a loss on both sides: it must never
  // publish an entry, and it must say so.
  const flat = priceDecision(Array(700).fill(1), 'rise', 5, 0.56);
  assert.equal(flat.ready, false);
  assert.equal(flat.tieRate, 1);
  assert.match(flat.reason, /tie risk/);
  const flatTick = priceDecision(Array(700).fill(1), 'tick', 5, 0.3);
  assert.equal(flatTick.ready, false);
});

test('no entries for insufficient, malformed, thin or unsupported history', () => {
  assert.equal(priceDecision(trend.slice(0, 255), 'rise', 5, 0.56).ready, false);
  assert.equal(priceDecision([...trend.slice(0, -1), NaN], 'rise', 5, 0.56).ready, false);
  assert.equal(priceDecision(trend, 'rise', 0, 0.56).ready, false);
  assert.equal(priceDecision(trend, 'rise', 11, 0.56).ready, false);
  // Whenever it declines, it must say why — an idle bot that cannot explain
  // itself is indistinguishable from a broken one.
  for (const decision of [
    priceDecision(trend.slice(0, 255), 'rise', 5, 0.56),
    priceDecision(stepStream(900), 'rise', 5, 0.56),
    priceDecision(stepStream(900), 'rise', 4, 0.56),
  ]) {
    assert.equal(decision.ready, false);
    assert.ok(decision.reason.length > 0, 'a declined decision always carries a reason');
  }
});

/**
 * The bug both Step Index presets shipped with: an even horizon on a fixed-step
 * market ties roughly one window in three, every tie loses, and the win
 * probability therefore tops out near a third — under any 56% gate. The old
 * engine could not express that, so it returned "not ready" forever and neither
 * bot ever bought. The measured tie rate now blocks the shape *and explains
 * itself*, while the odd horizon the presets ship clears it.
 */
test('an even horizon on a fixed-step market is refused for tie risk, an odd one is not', () => {
  const prices = stepStream(1200);
  const four = priceDecision(prices, 'rise', 4, 0.56);
  assert.equal(four.ready, false);
  assert.ok(four.tieRate > 0.2, `measured tie rate ${four.tieRate}`);
  assert.match(four.reason, /tie risk/);

  const five = priceDecision(prices, 'rise', 5, 0.56);
  assert.equal(five.tieRate, 0, 'five fixed steps can never sum back to the entry price');

  // Raising the tie ceiling does not make an untradeable shape tradeable: the
  // probability itself cannot reach the gate, which is the honest outcome.
  const permissive = priceDecision(prices, 'rise', 4, 0.56, { maxTie: 1 });
  assert.equal(permissive.ready, false);
  assert.ok(permissive.probability < 0.56, `a 4-tick tie-laden shape stays under the gate (${permissive.probability})`);
});

test('the ensemble is adaptive: weights normalise and an uninformative expert decays', () => {
  const step = priceDecision(stepStream(1200), 'rise', 5, 0.01);
  const total = step.models.reduce((sum, model) => sum + model.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
  const weight = name => step.models.find(model => model.name === name).weight;
  // On a fixed-step random market a drift forecast carries no information, so
  // the multiplicative-weights step must not let it outvote the empirical
  // experts together. (Comparing single experts pins one seed's noise: the
  // frequency and drift Brier scores differ in the third decimal on a fair
  // stream, which is not a property worth asserting.)
  const empirical = weight('frequency') + weight('transition') + weight('recent') + weight('anchor');
  assert.ok(empirical > weight('drift') * 2, `empirical ${empirical} vs drift ${weight('drift')}`);
  assert.ok(weight('drift') <= 0.4, `an uninformative expert stays a minority (drift ${weight('drift')})`);
  assert.ok(step.models.every(model => Number.isFinite(model.brier)));
  assert.ok(step.probabilities.every(value => value >= 0 && value <= 1));
  assert.ok(Number.isFinite(step.stderr) && step.stderr >= 0);
});

test('a real edge is found and a fair market is not forced', () => {
  // 55/45 Step Index: the ensemble should publish entries and those entries
  // should win more often than chance — the model must not be decorative.
  const prices = stepStream(2400, 0.55, 11);
  let entries = 0;
  let wins = 0;
  for (let index = 1200; index < 1900; index += 5) {
    const decision = priceDecision(prices.slice(index - 999, index + 1), 'rise', 5, 0.56);
    if (!decision.ready) continue;
    entries += 1;
    const result = outcome(prices, index + 1, 5);
    if ((decision.side > 0 && result > 0) || (decision.side < 0 && result < 0)) wins += 1;
  }
  assert.ok(entries > 25, `expected entries on a biased market, got ${entries}`);
  assert.ok(wins / entries > 0.5, `win rate ${(wins / entries).toFixed(3)} must beat chance`);

  // Flat-stake freedom is not forced either: a fair market may simply decline.
  const fair = priceDecision(stepStream(1200), 'rise', 5, 0.99);
  assert.equal(fair.ready, false);
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
  // A small account is not a broken bot: when the balance percentage is below
  // Deriv's 0.35 minimum stake, the minimum is still tradeable — but no more.
  const small = { ...config, legs: 1, stake: 0.35, baseline: 0, balance: 5, sessionProfit: 0 };
  assert.equal(priceRiskAllowed(small), true, 'the exchange minimum is tradeable on a 5 USD balance');
  assert.equal(priceRiskAllowed({ ...small, stake: 0.7 }), false, 'and nothing larger is');
  assert.equal(priceRiskAllowed({ ...small, legs: 2 }), true, 'a pair of minimum stakes fits the same floor');
  assert.equal(priceRiskAllowed({ ...small, legs: 2, stake: 0.4 }), false);
});

test('the contract duration is the model horizon, so a stale horizon cannot freeze a bot', () => {
  const step = { symbol: 'stpRNG', duration: 5, duration_unit: 't' };
  const rise = { contractTypes: ['CALL', 'PUT'] };
  const resolved = resolvePriceContext('rise', 4, step, rise);
  assert.equal(resolved.ok, true, 'a horizon that disagrees with Trade options is resolved, not refused');
  assert.equal(resolved.horizon, 5, 'the contract that will settle governs the replay');
  assert.equal(resolvePriceContext('step-hedge', 4, step, rise).horizon, 5);
  assert.equal(priceContextAllowed('rise', 4, step, rise), true);

  // Hard refusals: wrong unit, wrong family, wrong market for the pair.
  assert.equal(resolvePriceContext('rise', 5, { ...step, duration_unit: 'm' }, rise).ok, false);
  assert.equal(resolvePriceContext('step-hedge', 5, { ...step, symbol: 'R_100' }, rise).ok, false);
  assert.equal(resolvePriceContext('rise', 5, step, { contractTypes: ['CALL'] }).ok, false);
  assert.equal(resolvePriceContext('rise', 12, { ...step, duration: 12 }, rise).ok, false);
  assert.equal(resolvePriceContext('rise', 5, { ...step, duration: 4.5 }, rise).ok, false);
  assert.equal(resolvePriceContext('tick', 5, { ...step, symbol: 'R_100', duration: 4 }, { contractTypes: ['TICKHIGH', 'TICKLOW'] }).ok, false);
  assert.equal(
    resolvePriceContext('tick', 5, { symbol: 'R_100', duration: 5, duration_unit: 't' }, { contractTypes: ['TICKHIGH', 'TICKLOW'] }).ok,
    true
  );
  assert.match(resolvePriceContext('step-hedge', 5, { ...step, symbol: 'R_100' }, rise).reason, /Step index/);
});

test('adaptive stake follows the edge, floors at the exchange minimum and de-risks', () => {
  const base = { payout: 0.95, base: 0.35, fraction: 0.1, balance: 1000, maxPercent: 5, maxStake: 0 };
  const edge = adaptiveStake({ ...base, probability: 0.62 });
  const coin = adaptiveStake({ ...base, probability: 0.5 });
  assert.ok(edge > coin, `an edge must size up (${edge} vs ${coin})`);
  assert.equal(coin, 0.35, 'no edge stakes the flat unit');
  assert.ok(coin >= 0.35, 'never below the exchange minimum');
  assert.ok(adaptiveStake({ ...base, probability: 0.9, maxStake: 2.8 }) <= 2.8, 'never above the configured cap');
  assert.ok(adaptiveStake({ ...base, probability: 0.9, balance: 100 }) <= 5 + 1e-9, 'capped by the balance percent');
  assert.ok(adaptiveStake({ ...base, probability: 0.62, drawdown: 6 }) < edge, 'a losing session de-risks');
  assert.ok(adaptiveStake({ ...base, probability: 0.62, balance: 0 }) >= 0.35, 'an unreadable balance still sizes at the floor');
  assert.ok(adaptiveStake({ ...base, probability: 0.62, balance: 3 }) <= 3, 'never stakes more than the balance');
});

/** The preset wiring, exactly as the XML runs it: flat stake, break-even gate,
 *  confidence and agreement minimums, risk gate, loss-only ladder. */
function runPreset(prices, { mode = 'rise', legs = 1, threshold = 0.56, minConfidence = 60, minAgreement = 0.6, balance = 10000, lossLimit = 10 } = {}) {
  let entries = 0;
  let reads = 0;
  let firstEntry = null;
  let stake = 0.35;
  let sessionProfit = 0;
  let lossCount = 0;
  for (let index = 300; index < prices.length; index++) {
    const plan = priceDecision(prices.slice(0, index), mode, 5, threshold, { maxTie: 0.2, minAgreement });
    if (!plan.ready) continue;
    reads += 1;
    if (plan.confidence < minConfidence) continue;
    if (!priceRiskAllowed({ stake, legs, baseline: 0, loss: lossLimit, target: 10, percent: 5, balance, sessionProfit })) continue;
    entries += 1;
    if (firstEntry === null) firstEntry = index;
    const won = plan.side === 1 ? prices[index + 5] > prices[index] : prices[index + 5] < prices[index];
    sessionProfit = won ? sessionProfit + stake * 0.95 : sessionProfit - stake;
    lossCount = won ? 0 : lossCount + 1;
    // Loss-only ladder, capped at "max stake", reset on a win and past the cap.
    stake = won || lossCount >= 3 ? 0.35 : Math.min(2.8, stake * 2);
  }
  return { entries, reads, firstEntry };
}

test('the presets open positions when a step market really leans, and hold when it does not', () => {
  // Same length, same seed, same wiring — only the step bias differs. Two
  // takeaways are pinned here: the shipped shape *does* reach a purchase on a
  // Step index (it used to be refused before purchase because the model horizon
  // and the contract duration disagreed), and it does not manufacture entries on
  // a fair one.
  const fair = runPreset(stepStream(900, 0.5, 7));
  const leaning = runPreset(stepStream(900, 0.58, 7));

  assert.ok(leaning.firstEntry !== null, 'a leaning step market produces a purchase');
  assert.ok(leaning.entries >= 15, `a leaning market keeps trading (got ${leaning.entries})`);
  assert.ok(fair.entries < leaning.entries, 'a fair market is traded far less than a leaning one');
  assert.ok(leaning.reads >= 8 * Math.max(fair.reads, 1), `evidence discriminates (fair ${fair.reads} vs leaning ${leaning.reads})`);
  // The hedge preset reads the same evidence with two legs at risk, so it must
  // still pass the risk gate at the shipped stake.
  const hedge = runPreset(stepStream(900, 0.58, 7), { mode: 'step-hedge', legs: 2 });
  assert.ok(hedge.entries > 0, 'the hedged pair clears the risk gate on its own market');
  assert.ok(hedge.entries <= leaning.entries, 'both legs at risk can never unlock more entries than one');
});

test('store presets trade an odd horizon, gate on evidence and explain their skips', async () => {
  const root = new URL('../src/lib/bot-store/bots/', import.meta.url);
  const tick = await readFile(new URL('high-low-tick-sniper.xml', root), 'utf8');
  const rise = await readFile(new URL('rise-fall-ensemble.xml', root), 'utf8');
  const hedge = await readFile(new URL('step-rise-fall-hedge.xml', root), 'utf8');

  for (const xml of [tick, rise, hedge]) {
    for (const name of ['trade_definition', 'before_purchase', 'after_purchase', 'x_price_decision', 'x_price_risk', 'trade_again']) {
      assert.ok(xml.includes(`type="${name}"`), name);
    }
    // Evidence gates and a journal line are part of every preset.
    assert.match(xml, /x_price_decision_part/);
    assert.match(xml, /x_price_reason/);
    assert.match(xml, /type="notify"/);
    assert.match(xml, /<field name="PART">confidence<\/field>/);
    assert.match(xml, /<field name="PART">ready<\/field>/);
    // A ready plan that the money gate holds is still explained — otherwise a
    // bot with a live edge and a stake it cannot afford looks identical to a
    // bot that found nothing.
    assert.match(xml, /AI is ready but the entry gate held it/);
    assert.match(xml, /name="MAX_TIE"/);
    assert.match(xml, /name="MIN_AGREEMENT"/);
    assert.match(xml, /max tie/);
    assert.match(xml, /min agreement/);
    assert.match(xml, /min confidence/);
    // Risk limits, and a stake that is measured rather than carried.
    assert.match(xml, /baseline profit/);
    assert.match(xml, /loss limit/);
    assert.match(xml, /profit target/);
    assert.match(xml, /type="x_price_stake"/, 'the stake is sized from the measured edge');
    assert.match(
      xml,
      /<value name="PROBABILITY">[\s\S]{0,120}?<block type="x_price_decision_part"[\s\S]{0,120}?<field name="PART">probability<\/field>/,
      'the stake is sized from the decision probability'
    );
    assert.match(xml, /<field name="VAR" id="vai_payout">ai payout<\/field>/, 'payout drives the break-even');
    assert.match(xml, /<field name="VAR" id="vai_kelly_fraction">ai kelly fraction<\/field>/, 'the Kelly fraction is a knob');
    assert.match(xml, /<field name="VAR" id="vai_max_stake">ai max stake<\/field>/, 'max stake caps the size');
    // No martingale: the settled result may feed the cool-off counter, but it
    // may never resize the stake — every size comes from the next measurement,
    // which is why there is no ladder state and no profit-chasing multiplier.
    const after = xml.slice(xml.indexOf('<block type="after_purchase"'));
    const settled = after.slice(0, after.indexOf('</statement>'));
    assert.match(settled, /contract_check_result/, 'the cool-off counter follows the settled contract');
    assert.doesNotMatch(settled, /id="vstake">stake</, 'a settled contract never resizes the stake');
    assert.doesNotMatch(xml, /multiplier/, 'no multiplier knob');
    assert.doesNotMatch(xml, /loss count/, 'no ladder state');
    assert.doesNotMatch(xml, /rStakeStep/, 'no ladder step block');
    // Every horizon is five ticks: odd, tie-free on Step Index, and the
    // shortest tick contract High/Low Tick is sold in.
    assert.match(xml, /<field name="VAR" id="vai_duration">ai duration<\/field>[\s\S]*?<field name="NUM">5<\/field>/, 'duration 5');
  }

  assert.match(tick, /type="x_tick_decision_purchase"/);
  assert.match(tick, /<field name="MODE">tick<\/field>/);
  assert.match(tick, /<field name="SYMBOL_LIST">R_100<\/field>/);

  assert.match(rise, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(rise, /<field name="PURCHASE_LIST">PUT<\/field>/);
  assert.match(rise, /<field name="MODE">rise<\/field>/);
  assert.match(rise, /<field name="SUBMARKET_LIST">step_index<\/field>/);
  assert.match(rise, /<field name="SYMBOL_LIST">stpRNG<\/field>/);

  assert.match(hedge, /<field name="SYMBOL_LIST">stpRNG<\/field>/);
  assert.match(hedge, /<field name="MODE">step-hedge<\/field>/);
  assert.match(hedge, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(hedge, /<field name="HEDGE_LIST">PUT<\/field>/);
  // The hedge is partial, so the risk gate takes the pair's exposure multiplier
  // (main leg + "ai hedge ratio" of it) rather than a hard-coded 2.
  assert.match(hedge, /<value name="LEGS">[\s\S]{0,160}?id="vai_legs">ai legs<\/field>/, 'the pair risk-checks both legs');
  assert.match(hedge, /id="vai_legs">ai legs<\/field>[\s\S]{0,200}?<field name="NUM">1\.25<\/field>/, 'both legs are inside the exposure multiplier');
  assert.match(hedge, /<value name="HEDGE_STAKE">[\s\S]{0,160}?id="vai_hedge_ratio">ai hedge ratio<\/field>/, 'the hedge leg is ratio-sized, not equal-staked');

  // The shipped shapes must pass the context gate the bots rely on.
  assert.equal(priceContextAllowed('rise', 5, { symbol: 'stpRNG', duration: 5, duration_unit: 't' }, { contractTypes: ['CALL', 'PUT'] }), true);
  assert.equal(priceContextAllowed('step-hedge', 5, { symbol: 'stpRNG', duration: 5, duration_unit: 't' }, { contractTypes: ['CALL', 'PUT'] }), true);
  assert.equal(priceContextAllowed('tick', 5, { symbol: 'R_100', duration: 5, duration_unit: 't' }, { contractTypes: ['TICKHIGH', 'TICKLOW'] }), true);
});

// ---------------------------------------------------------------------------
// The High/Low Tick scale, the arcsine anchor and the evidence gate
// ---------------------------------------------------------------------------

test('the arcsine prior is the enumerated five-tick distribution, not a flat guess', () => {
  const prior = arcsinePrior(5);
  assert.equal(prior.length, 5);
  assert.equal(Math.round(prior.reduce((sum, value) => sum + value, 0) * 1e6) / 1e6, 1);
  // Enumerating the 32 five-tick paths: tick 1 and tick 5 hold a strict extreme
  // in 6 of them, the middle tick in 2, and 10 windows share an extreme.
  assert.deepEqual(prior.map(value => Math.round(value * 1e3) / 1e3), [0.273, 0.156, 0.141, 0.156, 0.273]);
});

test('each High/Low Tick side is normalised over its own five positions', () => {
  // The contract is priced as "which position holds the high", one bet of five
  // outcomes. Normalising over ten joint outcomes halved every probability and
  // made a payout-aware gate unreachable; that is the bug this pins.
  const decision = priceDecision(stepStream(1200, 0.5, 5), 'tick', 5, 0, { maxTie: 0.35 });
  assert.equal(decision.horizon, 5);
  const high = decision.probabilities.slice(0, 5).reduce((sum, value) => sum + value, 0);
  const low = decision.probabilities.slice(5).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(high - 1) < 1e-9, `high side sums to ${high}`);
  assert.ok(Math.abs(low - 1) < 1e-9, `low side sums to ${low}`);
  // A random walk leaves the ends likeliest, so the pick sits on an end tick
  // far more often than not.
  const picks = [];
  const prices = stepStream(1400, 0.5, 9);
  for (let i = 900; i < prices.length - 8; i += 20) {
    const read = priceDecision(prices.slice(i - 899, i + 1), 'tick', 5, 0, { maxTie: 0.35 });
    if (read.ready) picks.push(read.tick);
  }
  assert.ok(picks.length > 10, 'the tick read publishes decisions');
  const ends = picks.filter(tick => tick === 1 || tick === 5).length;
  assert.ok(ends / picks.length > 0.5, `ends chosen ${ends}/${picks.length}`);
});

test('a rule whose own graded record is under the break-even stops trading', () => {
  const ready = priceDecision(trend, 'tick', 5, 0.3);
  assert.equal(ready.ready, true, 'the trend case is tradeable with no record yet');

  // Fewer than 25 graded decisions proves nothing, so the gate stays open.
  assert.equal(priceDecision(trend, 'tick', 5, 0.3, { evidence: { hits: 2, samples: 10 } }).ready, true);

  const hot = priceDecision(trend, 'tick', 5, 0.3, { evidence: { hits: 5, samples: 40 } });
  assert.equal(hot.ready, false, 'a 12.5 % record against a 20 % break-even must not trade');
  assert.match(hot.reason, /own record/);
  // It is a veto, not a blindfold: the models were ready and the caller still
  // grades what they said, so the record can recover.
  assert.equal(hot.modelReady, true);
  assert.equal(hot.hitSamples, 40);

  const recovered = priceDecision(trend, 'tick', 5, 0.3, { evidence: { hits: 38, samples: 40 } });
  assert.equal(recovered.ready, true, 'a record above the break-even trades again');
});

test('the confidence floor is applied inside the engine, so grading matches trading', () => {
  const decision = priceDecision(trend, 'tick', 5, 0.3, { minConfidence: 100 });
  assert.equal(decision.ready, false);
  assert.match(decision.reason, /confidence .* floor/);
  // Nothing is graded for a decision the engine never published.
  assert.equal(decision.modelReady, false);
});

test('the tick break-even is one chance in five when no payout is quoted', () => {
  const decision = priceDecision(trend, 'tick', 5, 0.3);
  assert.equal(Math.round(decision.breakEven * 1e6) / 1e6, 0.2);
  // With a live payout of 3.5 the break-even is 1/(1+payout), the same rule the
  // directional strategies use.
  const priced = priceDecision(trend, 'tick', 5, 0.3, { payout: 3.5 });
  assert.equal(Math.round(priced.breakEven * 1e6) / 1e6, Math.round((1 / 4.5) * 1e6) / 1e6);
});
