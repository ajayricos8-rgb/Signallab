import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PRICE_MODEL_NAMES,
  PRICE_MODEL_VERSION,
  aiBrainReport,
  arcsinePrior,
  entropyOf,
  forecastReport,
  gridStrictPrior,
  hurstExponent,
  labelFidelity,
  marketDna,
  priceDecision,
  reverseEngineerReport,
  strictExtremePrior,
} from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-strategies.mjs';
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
  // A linear ramp has a determined answer: on a rising tape the high prints at
  // tick 5 and the low at tick 1, and the two are equally certain. The bot is
  // allowed to buy either (they are both true statements about the window); what
  // it may not do is name a position that is not the strict extreme.
  const strictlyExtreme = (series, decision, step) => {
    const last = series[series.length - 1];
    const window = Array.from({ length: 5 }, (_, k) => Number((last + step * (k + 1)).toFixed(4)));
    const extreme = decision.side > 0 ? Math.max(...window) : Math.min(...window);
    const unique = window.filter(value => value === extreme).length === 1;
    return unique && window[decision.tick - 1] === extreme;
  };
  const decision = priceDecision(trend, 'tick', 5, 0.3);
  assert.equal(decision.ready, true);
  assert.equal(decision.horizon, 5);
  assert.ok(decision.tick === 1 || decision.tick === 5, 'the ends carry the structure');
  assert.ok(strictlyExtreme(trend, decision, 0.01), 'the chosen position is a strict extreme of the window');
  assert.ok(decision.samples >= 200 && decision.conditionalSamples >= 20);
  const reversed = priceDecision([...trend].reverse(), 'tick', 5, 0.3);
  assert.equal(reversed.ready, true);
  assert.ok(strictlyExtreme([...trend].reverse(), reversed, -0.01), 'and so is the falling-tape answer');
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
  // A 55/45 Step Index: the ensemble should publish entries and those entries
  // should win more often than chance — the model must not be decorative.
  //
  // Pooled over three seeds, for the same reason a lab repeats a measurement:
  // v5's walk-forward replay is honest (a window is only tallied once its last
  // tick has printed), so one 700-tick slice of a 55/45 stream can land at 42 %
  // by luck alone. Pooled, the edge is unambiguous — and the fair stream, which
  // shares the wiring, publishes a couple of dozen reads where the leaning one
  // publishes hundreds.
  let entries = 0;
  let wins = 0;
  let fairReads = 0;
  for (const seed of [11, 12, 13]) {
    const leaning = stepStream(2400, 0.55, seed);
    for (let index = 1200; index < 1900; index += 5) {
      const decision = priceDecision(leaning.slice(index - 999, index + 1), 'rise', 5, 0.56);
      if (!decision.ready) continue;
      entries += 1;
      const result = outcome(leaning, index + 1, 5);
      if ((decision.side > 0 && result > 0) || (decision.side < 0 && result < 0)) wins += 1;
    }
    const fair = stepStream(2400, 0.5, seed);
    for (let index = 1200; index < 1900; index += 5) {
      if (priceDecision(fair.slice(index - 999, index + 1), 'rise', 5, 0.56).ready) fairReads += 1;
    }
  }
  assert.ok(entries > 60, `expected entries on a biased market, got ${entries}`);
  assert.ok(wins / entries > 0.55, `win rate ${(wins / entries).toFixed(3)} must beat chance`);
  assert.ok(
    fairReads * 8 < entries,
    `evidence discriminates (fair ${fairReads} vs leaning ${entries})`
  );

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
  }

  // The horizon is the contract's duration, and every preset ships the
  // tie-free one: five ticks. A four-tick window on a fixed-step index returns
  // to its entry price 37.5% of the time, and a returning window loses both
  // Rise and Fall — measured at about -16 points against the break-even.
  const shippedDuration = xml => {
    const at = xml.indexOf('id="vai_duration">ai duration</field>');
    assert.ok(at > 0, 'ai duration is a declared knob');
    return xml.slice(at).match(/<field name="NUM">([0-9.]+)<\/field>/)[1];
  };
  assert.equal(shippedDuration(tick), '5', 'High/Low Tick is a five-tick contract');
  assert.equal(shippedDuration(rise), '5', 'Rise/Fall stays on the odd, tie-free horizon');
  assert.equal(shippedDuration(hedge), '5', 'the hedge ships the odd, tie-free horizon too');
  // Five ticks ties about one window in a hundred on a measured stream, so the
  // tie gate ships tight: it refuses a shape rather than paying for one. Anyone
  // who wants the four-tick contract can set the duration to 4 and the cap to
  // 0.5, and the entry line will print the tie rate they are paying.
  assert.match(hedge, /<field name="VAR" id="vai_max_tie">ai max tie<\/field>[\s\S]*?<field name="NUM">0\.2<\/field>/);

  // The two Step Index presets keep a cadence: they publish the best read on
  // every tick they can read, and the session brakes — not the edge estimate —
  // are what stop them. The estimate still decides the side, and Kelly still
  // sizes the stake down to the exchange minimum when the edge is thin.
  assert.match(hedge, /<field name="REQUIRE">always<\/field>/, 'the hedge trades on the best read available');
  assert.match(rise, /<field name="REQUIRE">always<\/field>/, 'the Rise/Fall preset trades on the best read available');
  // High/Low Tick keeps the same cadence: the selective posture published ~0
  // entries on live-like ladders, so the sniper buys the best-ranked of ten on
  // every readable cycle and lets Kelly carry the caution. Selectivity is one
  // dropdown flip away ("only with a measured edge" + ai min ev 0.01).
  assert.match(tick, /<field name=\"REQUIRE\">always<\/field>/, 'the sniper trades on the best read available');
  assert.match(tick, /<field name=\"VAR\" id=\"vai_min_ev\">ai min ev<\/field>[\s\S]*?<field name=\"NUM\">0<\/field>/, 'the EV veto ships off in cadence mode');
  assert.match(tick, /<field name=\"VAR\" id=\"vai_min_agreement\">ai min agreement<\/field>[\s\S]*?<field name=\"NUM\">0<\/field>/, 'agreement ships off in cadence mode');
  // Every preset journals which expert is carrying the decision.
  for (const xml of [tick, rise, hedge]) assert.match(xml, /x_price_model_weights/);

  assert.match(tick, /type="x_tick_decision_purchase"/);
  // The v5 layer ships with the sniper: the EV gate that reads the ten-outcome
  // ladder, the entry-slip charge, the DNA floor, the self-audit and league
  // journal lines, and the market scout.
  assert.match(tick, /<field name="VAR" id="vai_min_ev">ai min ev<\/field>/, 'the EV gate is a knob');
  assert.match(tick, /<field name="VAR" id="vai_entry_slip">ai entry slip<\/field>/, 'entry slip is charged');
  assert.match(tick, /<field name="VAR" id="vai_dna_floor">ai dna floor<\/field>/, 'the DNA floor is a knob');
  assert.match(tick, /<value name="MIN_EV">[\s\S]{0,400}?ai min ev<\/field>/, 'the EV gate reaches the engine');
  assert.match(tick, /<value name="SLIP">[\s\S]{0,400}?ai entry slip<\/field>/, 'the slip reaches the engine');
  assert.match(tick, /<field name="PART">stand-down<\/field>/, 'a broken record can stand the bot down');
  assert.match(tick, /<field name="PART">dna-score<\/field>/, 'a market that cannot be measured is not traded');
  assert.match(tick, /type="x_price_dna"/, 'the market DNA is reported');
  assert.match(tick, /type="x_price_league"/, 'the expert league is reported');
  assert.match(tick, /type="x_price_audit"/, 'the bot audits itself');
  assert.match(tick, /type="x_price_payout_table"/, 'the payout ladder is reported');
  // The multi-market scan replaced the one-market scout: every preset reads
  // every market with its own model, then stands on the most suitable one, and
  // the once-a-minute cadence keeps the quality gates from parking the bot.
  for (const [xml, family] of [[tick, 'high-low-tick'], [rise, 'rise-fall'], [hedge, 'rise-fall']]) {
    assert.match(xml, /type="x_market_scan"/, 'the AI scan reads every market');
    assert.match(xml, new RegExp(`<field name="FAMILY">${family}</field>`), `the scan runs the ${family} model`);
    assert.match(xml, /type="x_scan_switch_best"/, 'the scan chooses the market to trade');
    assert.doesNotMatch(xml, /x_price_auto_market/, 'the one-market scout is removed');
    const cycle = xml.slice(xml.indexOf('<block type="tick_analysis"'));
    const scanAt = cycle.indexOf('x_market_scan');
    const decisionAt = cycle.indexOf('x_price_decision');
    assert.ok(scanAt > 0 && scanAt < decisionAt, 'the scan runs before the decision');
    assert.match(xml, /type="x_trade_due"/, 'the entry cadence clock is wired');
    const beforeSection = xml.slice(
      xml.indexOf('<block type="before_purchase"'),
      xml.indexOf('<block type="after_purchase"')
    );
    const cadenceAt = beforeSection.indexOf('x_trade_due');
    assert.ok(cadenceAt > 0, 'the cadence reaches the purchase conditions');
    const cadenceBranch = beforeSection.slice(cadenceAt);
    assert.match(cadenceBranch, /x_price_risk/, 'the cadence branch keeps the risk gate');
    assert.match(cadenceBranch, /ai loss streak/, 'and the losing-streak cool-off');
  }
  // The execution clock ships with the sniper: five ticks is not a duration
  // until the tick rate is known, and the bot says so at start-up.
  assert.match(tick, /type="x_price_clock"/, 'the clock is reported');
  assert.equal((tick.match(/type="x_price_clock"/g) || []).length >= 2, true, 'start-up and every 25 settlements');
  // The v6 APEX layer ships with the sniper: the AI core, the deep
  // reverse-engineering diagnosis, the outcome forecast and the skill floor.
  assert.match(tick, /type="x_price_brain"/, 'the AI core is reported');
  assert.match(tick, /type="x_price_reverse"/, 'the reverse engineering is reported');
  assert.match(tick, /type="x_price_forecast"/, 'the outcome forecast is reported');
  assert.match(tick, /<field name="VAR" id="vai_skill_floor">ai skill floor<\/field>/, 'the skill floor is a knob');
  assert.match(tick, /<field name="PART">skill<\/field>/, 'the blend skill gates the entry');
  assert.match(tick, /High\/Low Tick AI Sniper v6/, 'the sniper reports its version');
  // The other two presets keep the EV gate off (their quotes are a single
  // multiple) but still declare the slip, and neither gains the tick-only knobs.
  for (const xml of [rise, hedge]) {
    assert.match(xml, /<field name="VAR" id="vai_entry_slip">ai entry slip<\/field>/);
    assert.doesNotMatch(xml, /ai dna floor/, 'the DNA gate is a High/Low Tick knob');
    assert.doesNotMatch(xml, /x_price_auto_market/, 'the one-market scout is gone everywhere');
  }
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

test("a rule whose own record is under the break-even is calibrated, not parked", () => {
  const ready = priceDecision(trend, 'tick', 5, 0.3);
  assert.equal(ready.ready, true, 'the trend case is tradeable with no record yet');
  assert.equal(ready.calibration, 1, 'no record means no adjustment');

  // Fewer than 25 graded decisions proves nothing, so nothing is adjusted.
  const thin = priceDecision(trend, 'tick', 5, 0.3, { evidence: { hits: 2, samples: 10 } });
  assert.equal(thin.calibration, 1);

  // A record under the break-even means the estimates are running hot: the
  // vector is pulled back toward the structural anchor by the ratio, which
  // shrinks the edge (and therefore Kelly's stake) without stopping the bot.
  const hot = priceDecision(trend, 'tick', 5, 0.3, { evidence: { hits: 5, samples: 40 } });
  const clean = priceDecision(trend, 'tick', 5, 0.3);
  assert.ok(hot.calibration < 1, `calibration ${hot.calibration}`);
  assert.equal(hot.hitSamples, 40);
  assert.ok(hot.hitRate < 0.2, `record ${hot.hitRate}`);
  assert.ok(
    Math.abs(hot.probability - 0.2) < Math.abs(clean.probability - 0.2),
    'a hot record is pulled toward the anchor',
  );

  // A record at or above the break-even sharpens the estimate instead.
  const earned = priceDecision(trend, 'tick', 5, 0.3, { evidence: { hits: 36, samples: 40 } });
  assert.ok(earned.calibration > 1, `calibration ${earned.calibration}`);
  assert.ok(
    Math.abs(earned.probability - 0.2) >= Math.abs(clean.probability - 0.2),
    'an earned record sharpens the estimate',
  );

  // Strictness is opt-in rather than the default, because a bot that parks
  // itself is indistinguishable from a broken one.
  const strict = priceDecision(trend, 'tick', 5, 0.3, {
    evidence: { hits: 5, samples: 40 },
    evidenceVeto: true,
  });
  assert.equal(strict.ready, false);
  assert.match(strict.reason, /own record/);
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

// ---------------------------------------------------------------------------
// Cadence mode: "on the best read available"
// ---------------------------------------------------------------------------

test('the hedge can trade the best read available, and still measures what it costs', () => {
  const prices = stepStream(1600, 0.5, 21);
  const strict = priceDecision(prices, 'step-hedge', 4, 0, {
    maxTie: 0.45,
    minEdge: 0.004,
    minAgreement: 0.55,
    minConfidence: 55,
    payout: 0.95,
  });
  // A four-tick window on a fixed-step market returns to its entry 37.5 % of
  // the time, so the honest edge on that shape is negative and the strict gate
  // says so rather than trading it.
  assert.equal(strict.tieRate > 0.3, true, `tie rate ${strict.tieRate}`);

  const cadence = priceDecision(prices, 'step-hedge', 4, 0, {
    maxTie: 0.45,
    minEdge: 0,
    minAgreement: 0,
    minConfidence: 0,
    requireEdge: false,
    payout: 0.95,
  });
  assert.equal(cadence.ready, true, 'the preset must be able to open a position every cycle');
  assert.equal(cadence.requireEdge, false);
  assert.ok([1, -1].includes(cadence.side), 'a side is always named');
  // The cost of the cadence is printed, not hidden: the tie rate is part of the
  // journal line the entry emits.
  assert.match(cadence.reason, /tie \d+\.\d%/);
  assert.match(cadence.reason, /4 ticks/);

  // Cadence mode is not a blindfold. A market it cannot read yet still refuses.
  const warming = priceDecision(prices.slice(0, 40), 'step-hedge', 4, 0, {
    maxTie: 0.45,
    requireEdge: false,
  });
  assert.equal(warming.ready, false);
  assert.match(warming.reason, /warming up|thin history/);

  // Nor does it trade a shape that cannot settle a winner: the tie gate stands.
  const refused = priceDecision(prices, 'step-hedge', 4, 0, {
    maxTie: 0.2,
    requireEdge: false,
  });
  assert.equal(refused.ready, false);
  assert.match(refused.reason, /tie risk/);
});

test('cadence mode keeps every readable tick readable, so a hedged pair re-enters after each settlement', () => {
  const prices = stepStream(2400, 0.5, 33);
  const options = {
    // The shipped knobs, exactly: a four-tick step window ties 37.5 % of the
    // time, and the allowed rate sits above that so measurement noise cannot
    // stall a cycle.
    maxTie: 0.5,
    minEdge: 0,
    minAgreement: 0,
    minConfidence: 0,
    requireEdge: false,
    payout: 0.95,
  };
  // Replay: a four-tick contract is open from the entry tick, so the next
  // decision can be made four ticks later. Count how many of those decisions
  // published an entry, i.e. how often the strategy can re-enter immediately.
  let considered = 0;
  let published = 0;
  let open = -1;
  const gaps = [];
  for (let t = 400; t < prices.length - 6; t++) {
    if (open >= 0 && t < open + 4) continue;
    considered++;
    const decision = priceDecision(prices.slice(Math.max(0, t - 399), t + 1), 'step-hedge', 4, 0, options);
    if (!decision.ready) continue;
    if (open >= 0) gaps.push(t - open);
    published++;
    open = t;
  }
  assert.ok(considered > 200);
  assert.ok(published / considered > 0.95, `published on ${published}/${considered} eligible ticks`);
  assert.ok(gaps.length > 100, 'the replay settles many contracts');
  // "At least every three seconds after a contract is closed" is one tick on a
  // two-second market: the bot must not sit out a cycle it could trade.
  const immediate = gaps.filter(gap => gap === 4).length / gaps.length;
  assert.ok(immediate > 0.95, `re-entered on the next tick ${(immediate * 100).toFixed(1)}% of the time`);
});



// ---------------------------------------------------------------------------
// v5 — the tie-aware structural prior, the EV scan, market DNA and the
// integrity of the walk-forward replay
// ---------------------------------------------------------------------------

test('the grid-walk prior is enumerated, not guessed, and the market picks its own structure', () => {
  // A Step Index moves exactly one quote increment per tick, so the strict
  // maximum is not distributed like the continuous arcsine law: enumerating the
  // 32 paths gives 6/22, 4/22, 2/22, 4/22, 6/22 strict windows and a tie in 10
  // of the 32.
  const grid = gridStrictPrior(5);
  assert.equal(grid.h, 5);
  assert.deepEqual(grid.positions.map(value => Math.round(value * 1e3) / 1e3), [0.273, 0.182, 0.091, 0.182, 0.273]);
  assert.equal(Math.round(grid.tieRate * 1e4) / 1e4, 0.3125);

  // No ties at all: the continuous law, exactly as before.
  const continuous = strictExtremePrior(5, 0);
  assert.deepEqual(continuous.map(value => Math.round(value * 1e3) / 1e3), [0.273, 0.156, 0.141, 0.156, 0.273]);
  // Fully tied: the enumerated grid distribution.
  const tied = strictExtremePrior(5, grid.tieRate);
  assert.deepEqual(tied.map(value => Math.round(value * 1e3) / 1e3), [0.273, 0.182, 0.091, 0.182, 0.273]);
  // Halfway is halfway, and every prior is still a distribution.
  const half = strictExtremePrior(5, grid.tieRate / 2);
  // A tie-heavy market pushes the middle position DOWN, not up: the extreme is
  // an end far more often than a continuous walk would suggest.
  assert.ok(half[2] < continuous[2] && half[2] > tied[2], `middle position ${half[2]}`);
  for (const prior of [continuous, half, tied]) {
    assert.ok(Math.abs(prior.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  }
});

test('a tie is missing mass: the win probability is the strict probability, not the conditional one', () => {
  // A Step Index has a tie in about a third of its five-tick windows, and a tie
  // loses on both sides. The engine must therefore report a win probability
  // below its conditional position probability — the v4 bug was reporting the
  // conditional one as if ties could not happen.
  const prices = stepStream(2400, 0.5, 17);
  const decision = priceDecision(prices, 'tick', 5, 0, { maxTie: 0.5, payout: 3 });
  assert.equal(decision.horizon, 5);
  assert.ok(decision.tieRate > 0.25, `measured tie rate ${decision.tieRate}`);
  assert.ok(decision.tieForecast > 0.15, `tie forecast ${decision.tieForecast}`);
  const chosen = decision.side > 0 ? decision.tick - 1 : 5 + decision.tick - 1;
  const conditional = decision.probabilities[chosen];
  assert.ok(
    decision.winProbability < conditional,
    `the win probability (${decision.winProbability}) is below the conditional one (${conditional})`
  );
  assert.ok(
    Math.abs(decision.winProbability / conditional - (1 - decision.tieForecast)) < 1e-9,
    'the discount is exactly one minus the tie forecast'
  );
  assert.equal(decision.evByOutcome.length, 10);
  assert.ok(decision.evByOutcome.some(value => !Number.isFinite(value)) === false);
  // Each side is still a distribution over its own five positions.
  for (const offset of [0, 5]) {
    const mass = decision.probabilities.slice(offset, offset + 5).reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(mass - 1) < 1e-9, `side mass ${mass}`);
  }
  // The DNA of that market says the same thing in structural terms.
  const dna = marketDna(prices);
  assert.equal(dna.phase, 'grid');
  assert.ok(dna.tieHigh > 0.25 && dna.tieHigh < 0.4, `dna tie ${dna.tieHigh}`);
  assert.ok(dna.gridRatio < 2.5, `grid ratio ${dna.gridRatio}`);
  assert.ok(dna.readability > 0 && dna.readability <= 100);
});

test('the EV scan buys the mispriced position, not the likeliest one', () => {
  // The contract is quoted per selected tick, so the ranking must be by
  // expected value once the ladder is known. On a grid walk the ends are the
  // likeliest positions (18.75 %) and the middle is the rarest (6.25 %), so a
  // ladder that pays the middle its fair 15x must win the scan even though the
  // end carries three times the probability — and a fair ladder must not.
  const prices = stepStream(1600, 0.5, 41);
  const middleOverlay = [5.0, 6.0, 22.0, 6.0, 5.0, 0, 0, 0, 0, 0];
  const scan = priceDecision(prices, 'tick', 5, 0, { maxTie: 0.5, payouts: middleOverlay });
  assert.equal(scan.side, 1);
  assert.equal(scan.tick, 3, 'the scan buys the overlay, not the modal position');
  assert.equal(scan.payoutAt, 22);
  assert.ok(scan.ev > 0, `EV ${scan.ev}`);
  assert.ok(scan.fairPayout > 0 && scan.fairPayout < 22);
  // The same market with a fair ladder picks the likeliest position instead.
  const fairLadder = [4.333, 7, 15, 7, 4.333, 0, 0, 0, 0, 0];
  const fairPick = priceDecision(prices, 'tick', 5, 0, { maxTie: 0.5, payouts: fairLadder });
  assert.ok([1, 5].includes(fairPick.tick), `the fair ladder picks an end (${fairPick.tick})`);

  // A quote ladder that is uniformly poor produces no entry when the strategy
  // asks for value: that is the gate that stops a bot paying for a discovery it
  // did not make.
  const poor = new Array(10).fill(1.2);
  const refused = priceDecision(prices, 'tick', 5, 0, { maxTie: 0.5, payouts: poor, minEv: 0.01 });
  assert.equal(refused.ready, false);
  assert.match(refused.reason, /no value/);
  assert.match(refused.reason, /fair \d+\.\d+×/);
});

test('market DNA describes the market it is given, not the one it expects', () => {
  const step = marketDna(stepStream(1600, 0.5, 3));
  assert.equal(step.phase, 'grid');
  assert.ok(step.windows > 500, `windows ${step.windows}`);
  assert.equal(step.strictHigh.length, 5);
  assert.equal(step.positionZ.length, 5);
  // Strict histogram plus ties must account for every window.
  for (const side of [step.strictHigh, step.strictLow]) {
    const covered = side.reduce((sum, value) => sum + value, 0);
    assert.ok(covered <= 1 && covered > 0.5, `strict mass ${covered}`);
  }
  assert.match(step.verdict, /grid/);

  // A fine-grained walk (Gaussian increments, far larger than the quote grid)
  // is the continuous case: ties rare, ends favoured, phase continuous.
  let state = 5;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
  let price = 1000;
  const fine = [price];
  for (let i = 0; i < 1600; i += 1) {
    price = Number((price + gauss() * 1.5).toFixed(2));
    fine.push(price);
  }
  const continuous = marketDna(fine);
  assert.equal(continuous.phase, 'continuous');
  assert.ok(continuous.tieHigh < 0.15, `ties ${continuous.tieHigh}`);
  assert.ok(continuous.strictHigh[0] > continuous.strictHigh[2], 'the ends favour the extreme');
  // A market with no history explains itself instead of inventing a verdict.
  const cold = marketDna([1, 2, 3]);
  assert.equal(cold.windows, 0);
  assert.match(cold.verdict, /warming up/);
});

test('entry slip is charged against the estimate, and a bad record can stand a bot down', () => {
  const clean = priceDecision(trend, 'tick', 5, 0, { entrySlip: 0 });
  const slipped = priceDecision(trend, 'tick', 5, 0, { entrySlip: 2 });
  assert.ok(
    Math.abs(slipped.probability - 0.2) <= Math.abs(clean.probability - 0.2) + 1e-9,
    `slip must shrink toward the anchor (${slipped.probability} vs ${clean.probability})`
  );

  // A record whose whole 90 % interval sits under the break-even is not bad
  // luck, it is a broken estimate: the flag the preset can act on.
  const doomed = priceDecision(trend, 'tick', 5, 0, { evidence: { hits: 2, samples: 80 } });
  assert.equal(doomed.standDown, 1);
  const earned = priceDecision(trend, 'tick', 5, 0, { evidence: { hits: 60, samples: 80 } });
  assert.equal(earned.standDown, 0);
  // Below 40 graded decisions nothing is concluded.
  assert.equal(priceDecision(trend, 'tick', 5, 0, { evidence: { hits: 1, samples: 20 } }).standDown, 0);
});

test('the expert league is scored against the structural anchor, and the version moved to v6', () => {
  assert.equal(PRICE_MODEL_VERSION, 6);
  assert.equal(PRICE_MODEL_NAMES.length, 16);
  assert.deepEqual(PRICE_MODEL_NAMES.slice(-6), ['volatility', 'microtrend', 'range', 'entropy', 'hurst', 'cycle']);
  const decision = priceDecision(stepStream(1600, 0.5, 23), 'tick', 5, 0, { maxTie: 0.5 });
  assert.equal(decision.league.length, PRICE_MODEL_NAMES.length);
  // Sorted by measured skill, best first, and the anchor is always scored so
  // "how much better than the prior is this?" always has an answer.
  for (let i = 1; i < decision.league.length; i += 1) {
    assert.ok(decision.league[i - 1].skill >= decision.league[i].skill);
  }
  assert.ok(Math.abs(decision.league[0].weight - Math.max(...decision.league.map(e => e.weight))) < 1e-12);
  assert.ok(Number.isFinite(decision.skill) && decision.skill <= 1);
  // Certainty folds skill and value into confidence; it can never exceed it by
  // much, and it is always on the same 0-100 scale.
  assert.ok(decision.certainty >= 0 && decision.certainty <= 100);
  assert.ok(decision.confidence >= 0 && decision.confidence <= 100);
});

test('the execution clock turns five ticks into seconds and refuses an impossible fill', () => {
  // A one-second market with a one-second fill: the contract starts a tick late,
  // so half the labels are wrong and the bot must know it.
  const fast = labelFidelity(1, 1);
  assert.equal(fast.expectedLag, 1);
  assert.equal(fast.horizon, 5);
  assert.ok(Math.abs(fast.fidelity - 0.5) < 1e-12, `fidelity ${fast.fidelity}`);
  // A two-second market with a 0.3 s round trip: the window is still the window.
  const comfortable = labelFidelity(2, 0.3);
  assert.ok(comfortable.expectedLag > 0.1 && comfortable.expectedLag < 0.2);
  assert.ok(comfortable.fidelity > 0.9);
  assert.equal(comfortable.horizon, 10, 'five ticks on a 2 s market is a ten-second contract');
  assert.equal(comfortable.concurrent, 5, 'one ticket at a time still means five positions in flight');

  const decision = priceDecision(trend, 'tick', 5, 0, { interval: 2, latency: 0.3 });
  assert.equal(decision.intervalSeconds, 2);
  assert.equal(decision.horizonSeconds, 10);
  assert.ok(decision.stakeable > 0.1 && decision.stakeable < 0.2, `stakeable ${decision.stakeable}`);
  assert.match(decision.reason, /10s/);

  // A fill that cannot land inside the first tick is a different contract, and
  // the bot refuses rather than trading a window it did not score.
  const impossible = priceDecision(trend, 'tick', 5, 0, { interval: 1, latency: 1.2 });
  assert.equal(impossible.ready, false);
  assert.match(impossible.reason, /execution/);
  assert.match(impossible.reason, /window would start late/);
});

test('the EV ladder prices all ten outcomes and buys the mispriced position', () => {
  // Probability says "the ends"; the quote says "the middle is underpriced".
  // Only a per-outcome ladder can tell the difference, and only the ladder can
  // be the thing a bot trades.
  const stream = stepStream(1800, 0.5, 41);
  const payouts = [4, 8, 20, 8, 4, 4, 8, 20, 8, 4];
  const decision = priceDecision(stream, 'tick', 5, 0, { payouts, maxTie: 0.5 });
  assert.equal(decision.evTable.length, 10);
  assert.equal(decision.quoted, 10);
  decision.evTable.forEach((row, index) => {
    assert.equal(row.payout, payouts[index]);
    assert.ok(Math.abs(row.ev - (row.winProbability * (1 + payouts[index]) - 1)) < 1e-12);
    assert.ok(row.fairPayout > 0);
  });
  // The ladder is sorted by expected value, not by probability.
  for (let i = 1; i < decision.ladderRows.length; i += 1) {
    const previous = decision.ladderRows[i - 1].ev;
    const current = decision.ladderRows[i].ev;
    assert.ok(!Number.isFinite(current) || !Number.isFinite(previous) || previous >= current);
  }
  // The chosen outcome is the ladder's head: the biggest expected value in the
  // table, which is a rarer position than the likeliest one — the trade the
  // probability ranking would never have found.
  const bestEv = Math.max(...decision.evTable.map(row => row.ev));
  assert.ok(Math.abs(decision.ev - bestEv) < 1e-12, `chose EV ${decision.ev}, table head ${bestEv}`);
  const chosen = decision.evTable.find(row => row.side === decision.side && row.tick === decision.tick);
  const mostLikely = decision.evTable.reduce((best, row) =>
    row.probability > best.probability ? row : best, decision.evTable[0]);
  assert.ok(chosen.probability <= mostLikely.probability, 'it bought rarity, not likelihood');
  assert.ok(chosen.payout > 4, 'the chosen position pays more than the near-fair ends do');

  // With nothing quoted the engine falls back to ranking by probability, which
  // is the only sane read before quotes arrive.
  const unquoted = priceDecision(stream, 'tick', 5, 0, { maxTie: 0.5 });
  assert.equal(unquoted.quoted, 0);
  assert.ok(unquoted.tick === 1 || unquoted.tick === 5, `fallback picked tick ${unquoted.tick}`);
});

test('the minimum-EV gate names the quote it refused', () => {
  const refused = priceDecision(trend, 'tick', 5, 0, { payouts: new Array(10).fill(2), minEv: 2.5 });
  assert.equal(refused.ready, false);
  assert.match(refused.reason, /no value/);
  assert.match(refused.reason, /quote 2\.00x|fair/);
  // The same decision clears a floor it can actually reach.
  assert.equal(priceDecision(trend, 'tick', 5, 0, { payouts: new Array(10).fill(2), minEv: 0 }).ready, true);
});

test('the market DNA reports sampling bands and the fair multiple of every position', () => {
  const dna = marketDna(stepStream(1800, 0.5, 43));
  assert.equal(dna.phase, 'grid');
  assert.ok(dna.tieHigh > 0.2, `grid-walk ties ${dna.tieHigh}`);
  assert.ok(dna.tieBandHigh.high > dna.tieBandHigh.low, 'the tie rate has an interval');
  assert.ok(dna.tieBandHigh.low > 0.1 && dna.tieBandHigh.high < 0.5, 'but it is a tight one');
  assert.equal(dna.fairPayoutHigh.length, 5);
  assert.ok(dna.fairPayoutHigh.every(value => value > 0));
  // The middle position is the rarest on a grid walk, so it needs the biggest
  // fair multiple; that is the number a quote has to beat.
  assert.ok(dna.fairPayoutHigh[2] > dna.fairPayoutHigh[0]);
  assert.ok(dna.fairPayoutHigh[2] > dna.fairPayoutHigh[1]);
});

test('the runtime wires the clock, the ladder and the v5 report fields', async () => {
  const read = path =>
    readFile(
      new URL(`../../../vendor/deriv-bot/src/external/bot-skeleton/${path}`, import.meta.url),
      'utf8'
    );
  const iface = await read('services/tradeEngine/Interface/VisionInterface.js');
  const blocks = await read('scratch/blocks/Vision Lab/price-strategies.js');
  const toolbox = await readFile(new URL('../src/../', import.meta.url), 'utf8').catch(() => '');
  void toolbox;

  // The clock is measured, not assumed, and reaches the engine.
  assert.match(iface, /const tickClock = \(\) =>/);
  assert.match(iface, /interval: clock\.interval/);
  assert.match(iface, /latency: clock\.latency/);
  assert.match(iface, /priceClock: async \(\) =>/);
  assert.match(iface, /labelFidelity/);
  // The ladder and the per-contract reads the EV scan decides on.
  assert.match(iface, /pricePayoutTable/);
  assert.match(iface, /priceContractEv: async/);
  assert.match(iface, /priceContractFair: async/);
  assert.match(iface, /plan\??\.evTable/);
  // Every new decision slot has a name the blocks can ask for.
  for (const part of ['interval', 'horizon-seconds', 'slip', 'fidelity', 'stakeable', 'quoted', 'ev-lower']) {
    assert.match(iface, new RegExp(`['"]?${part}['"]?: (2[89]|3[0-9])`), `${part} has a slot`);
    assert.match(blocks, new RegExp(`'${part}'`), `${part} is in the dropdown`);
  }
  // The blocks exist and call the interface by name.
  for (const [name, call] of [
    ['x_price_clock', 'Bot.priceClock()'],
    ['x_price_contract_ev', 'Bot.priceContractEv('],
    ['x_price_contract_fair', 'Bot.priceContractFair('],
    ['x_price_brain', 'Bot.priceBrain()'],
    ['x_price_reverse', 'Bot.priceReverse()'],
    ['x_price_forecast', 'Bot.priceForecast()'],
  ]) {
    assert.match(blocks, new RegExp(`type: '${name}'`), name);
    assert.match(blocks, new RegExp(call.replace(/[().]/g, '\\$&')), `${name} calls ${call}`);
  }
  // And they are reachable from the toolbox, or nobody could use them.
  const items = await readFile(
    new URL('../../../vendor/deriv-bot/src/pages/bot-builder/toolbox/toolbox-items.tsx', import.meta.url),
    'utf8'
  );
  for (const name of [
    'x_price_dna',
    'x_price_dna_part',
    'x_price_payout_table',
    'x_price_league',
    'x_price_audit',
    'x_price_brain',
    'x_price_reverse',
    'x_price_forecast',
    'x_price_market_score',
    'x_price_auto_market',
    'x_price_clock',
    'x_price_contract_ev',
    'x_price_contract_fair',
  ]) {
    assert.ok(items.includes(`type='${name}'`), `${name} is in the toolbox`);
  }
  assert.match(items, /<Value name='MIN_EV'>/, 'the EV floor is editable from the toolbox');
  assert.match(items, /<Value name='SLIP'>/, 'the entry slip is editable from the toolbox');
  // The entry-mode switch the presets (and the docs) choose by: without this
  // dropdown the REQUIRE field in the XML never reaches the runtime and every
  // strategy silently runs in edge mode.
  assert.match(blocks, /dropdown[(]'REQUIRE'/, 'the entry-mode dropdown exists on the decision block');
  assert.match(items, /<Field name='REQUIRE'>edge/, 'the toolbox default entry mode is selective');
});

test('the record is calibrated against what the rule claimed, not against the payout', () => {
  // The same realised rate means different things depending on what was
  // published. 60 % over 100 decisions is honest if the bot claimed 60 %, and
  // wishful if it claimed 80 %.
  const honest = priceDecision(trend, 'tick', 5, 0, { evidence: { hits: 60, samples: 100, rate: 0.6, mean: 0.6 } });
  const wishful = priceDecision(trend, 'tick', 5, 0, { evidence: { hits: 60, samples: 100, rate: 0.6, mean: 0.8 } });
  assert.ok(Math.abs(honest.calibration - 1) < 1e-9, `honest calibration ${honest.calibration}`);
  assert.ok(wishful.calibration < 1, `an over-confident record must shrink the estimate (${wishful.calibration})`);
  // And it is applied to the estimate, not just reported.
  assert.ok(wishful.probability <= honest.probability);
  // Without a mean prediction the break-even comparison is still the fallback,
  // so older callers keep the behaviour they had.
  const legacy = priceDecision(trend, 'tick', 5, 0, { evidence: { hits: 20, samples: 100, rate: 0.2 } });
  assert.ok(legacy.calibration >= 0.35 && legacy.calibration <= 1.25);
});

test('the EV gate is a lower bound, not the best of ten noisy bets', () => {
  // Ten quotes, ten probabilities, one argmax: the winner is biased upward by
  // roughly its own noise. The gate therefore compares a one-sigma floor with
  // the minimum EV, and `evZ: 0` restores the naive comparison so the
  // difference between the two is exactly the correction.
  const stream = stepStream(2000, 0.5, 51);
  const fair = [4.33, 7.0, 15.0, 7.0, 4.33];
  const payouts = [...fair, ...fair];
  const naive = priceDecision(stream, 'tick', 5, 0, { payouts, minEv: 0.15, maxTie: 0.5, evZ: 0 });
  const cautious = priceDecision(stream, 'tick', 5, 0, { payouts, minEv: 0.15, maxTie: 0.5, evZ: 1 });
  assert.ok(naive.ev >= 0.15, `the point estimate clears the floor (${naive.ev})`);
  assert.equal(naive.ready, true, 'a naive gate would take this quote');
  assert.ok(cautious.evLower < 0.15, `the floor does not (${cautious.evLower})`);
  assert.equal(cautious.ready, false, 'the corrected gate refuses it');
  assert.match(cautious.reason, /no value/);
  assert.match(cautious.reason, /one-sigma floor/);
  // evLower is the EV minus evZ standard errors, and the table carries both.
  assert.ok(Math.abs(cautious.ev - cautious.evLower - cautious.seEv) < 1e-12);
  assert.equal(cautious.evLower, cautious.evTable.find(row => row.side === cautious.side && row.tick === cautious.tick).evLower);
  // The exchange minimum stake is a floor, never a target: a deflated EV of
  // zero is not stakeable even when the point estimate is positive.
  assert.ok(cautious.evTable.some(row => row.ev > 0 && row.stakeable === false));
});

test('overlapping replay scores are queued until settlement before changing mixture weights', async () => {
  // This is a structural regression test: predictions for overlapping windows
  // must not feed the league until the corresponding outcome has settled.
  const source = await readFile(new URL('../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-strategies.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    const pendingScores = new Map();');
  const end = source.indexOf('    // The moment the pending decision', start);
  assert.ok(start >= 0 && end > start);
  const replay = source.slice(start, end);
  const loop = replay.slice(replay.indexOf('    for (let index = 0; index < rows.length; index++)'));
  assert.ok(loop.indexOf('const liveWeights = mixtureWeights(') < loop.indexOf('pendingScores.set(index,'));
  assert.match(loop, /const settled = index - LAG;\s*if \(settled >= 0\) \{\s*settleScore\(settled\);/);
  assert.match(loop, /settleScore\(index\);\s*advance\(rows\[index\]\);/);
  assert.doesNotMatch(loop, /brierSum\[modelIndex\]\s*\+=/);
});

// ---------------------------------------------------------------------------
// v6 (APEX core) — the deep brain, regime gating, DNA v2 and per-outcome
// calibration
// ---------------------------------------------------------------------------

test('the v6 ensemble fields all sixteen experts and gates the mixture by regime', () => {
  const decision = priceDecision(stepStream(1600, 0.5, 23), 'tick', 5, 0, { maxTie: 0.5 });
  assert.equal(decision.models.length, 16);
  assert.equal(decision.league.length, 16);
  const total = decision.models.reduce((sum, model) => sum + model.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
  // Every expert is scored against the anchor and the league stays sorted.
  for (let i = 1; i < decision.league.length; i += 1) {
    assert.ok(decision.league[i - 1].skill >= decision.league[i].skill);
  }
  assert.ok(decision.models.every(model => Number.isFinite(model.brier) && Number.isFinite(model.skill)));
  // The meta-learner names its regime and says whether the regime board voted.
  assert.ok(['expansion', 'reversion', 'balanced'].includes(decision.meta.regime));
  assert.equal(typeof decision.meta.gated, 'boolean');
  assert.ok(decision.meta.samples >= 0);
  assert.equal(Object.keys(decision.meta.weights).length, 16);
});

test('the deep brain reports its training state and the regime call', () => {
  const decision = priceDecision(stepStream(1600, 0.5, 23), 'tick', 5, 0, { maxTie: 0.5 });
  const brain = decision.brain;
  assert.equal(brain.version, 6);
  assert.equal(brain.experts, 16);
  assert.ok(brain.net.updates > 100, `the net trained on settled windows (${brain.net.updates})`);
  assert.equal(brain.net.hidden, 10);
  assert.ok(Number.isFinite(brain.net.norm) && brain.net.norm >= 0);
  assert.equal(brain.top.length, 3);
  assert.ok(brain.top.every(expert => PRICE_MODEL_NAMES.includes(expert.name)));
  const line = aiBrainReport(decision);
  assert.match(line, /AI core v6/);
  assert.match(line, /regime (expansion|reversion|balanced)/);
  assert.match(line, /updates/);
  assert.match(aiBrainReport(null), /warming up/);
});

test('market DNA v2 measures memory, entropy, spikes, phase and compression', () => {
  const dna = marketDna(stepStream(1600, 0.5, 3));
  assert.equal(dna.phase, 'grid');
  assert.ok(dna.hurst > 0 && dna.hurst < 1, `hurst ${dna.hurst}`);
  assert.ok(dna.entropyHigh >= 0 && dna.entropyHigh <= 1);
  assert.ok(dna.entropyLow >= 0 && dna.entropyLow <= 1);
  assert.ok(dna.jumpRate >= 0 && dna.jumpRate <= 1);
  assert.ok(Math.abs(dna.extremeAutocorr) <= 1);
  assert.ok(dna.tieClustering >= 0 && dna.tieClustering <= 5);
  assert.ok(dna.compression > 0);
  assert.ok(dna.tickSigma > 0);
  // The auto-tuning a grid market implies: a wider EV bound and heavy anchor.
  assert.equal(dna.autoTune.evZ, 1.5);
  assert.ok(dna.autoTune.anchorTrust >= 0.5 && dna.autoTune.anchorTrust <= 1);
  assert.ok(dna.autoTune.note.length > 0);
  const line = reverseEngineerReport(dna);
  assert.match(line, /reverse engineering/);
  assert.match(line, /auto-tune/);
  assert.match(reverseEngineerReport(marketDna([1, 2, 3])), /warming up/);
});

test('a trending walk reads as memory and a calm walk does not', () => {
  // Persistent changes (clumped signs) must score a higher Hurst exponent than
  // an anti-persistent one — the probe has to see memory to be worth its vote.
  const clumped = [];
  let sign = 1;
  let state = 11;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let i = 0; i < 200; i++) {
    if (random() > 0.7) sign = -sign;
    clumped.push(sign * 0.1);
  }
  const alternating = [];
  for (let i = 0; i < 200; i++) alternating.push((i % 2 === 0 ? 1 : -1) * 0.1);
  assert.ok(hurstExponent(clumped) > hurstExponent(alternating), 'persistence outranks alternation');
  assert.ok(entropyOf([10, 0, 0, 0, 0, 0, 0, 0, 0, 0]) < entropyOf([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
});

test('per-outcome calibration shrinks the outcomes that miss and spares the rest', () => {
  const prices = stepStream(1600, 0.5, 23);
  const lane = (hits, samples, mean) => ({ hits, samples, rate: hits / samples, mean });
  // Outcome 0 (high tick 1) claims 25% and realises 8%: over-confident.
  // Outcome 4 (high tick 5) claims 25% and realises 25%: honest.
  const byOutcome = Array.from({ length: 10 }, () => lane(10, 40, 0.25));
  byOutcome[0] = lane(3, 40, 0.25);
  byOutcome[4] = lane(10, 40, 0.25);
  const plain = priceDecision(prices, 'tick', 5, 0, { maxTie: 0.5 });
  const calibrated = priceDecision(prices, 'tick', 5, 0, {
    maxTie: 0.5,
    evidence: { hits: 20, samples: 80, rate: 0.25, mean: 0.25, byOutcome },
  });
  const anchor0 = strictExtremePrior(5, calibrated.tieRate)[0];
  assert.ok(
    Math.abs(calibrated.probabilities[0] - anchor0) < Math.abs(plain.probabilities[0] - anchor0) + 1e-9,
    'the missing outcome is pulled toward the anchor'
  );
  // Both sides are still distributions over their own five positions.
  for (const offset of [0, 5]) {
    const mass = calibrated.probabilities.slice(offset, offset + 5).reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(mass - 1) < 1e-9, `side mass ${mass}`);
  }
});

test('the outcome forecast lists the scan head with probabilities and quotes', () => {
  const payouts = [4, 8, 20, 8, 4, 4, 8, 20, 8, 4];
  const decision = priceDecision(stepStream(1800, 0.5, 41), 'tick', 5, 0, { payouts, maxTie: 0.5 });
  assert.ok(decision.forecast.length >= 2 && decision.forecast.length <= 5);
  assert.ok(decision.forecast.every(row => row.label && Number.isFinite(row.probability)));
  const line = forecastReport(decision);
  assert.match(line, /forecast/);
  assert.match(line, /H3|L3/);
  assert.match(forecastReport(null), /no forecast/);
});
