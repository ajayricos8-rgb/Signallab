// Structural pins for the Step Index 4-Tick Hedge preset.
//
// The bot is a Blockly document, so the test reads the XML rather than
// executing it: the contract, the horizon, the hedge legs and the cadence are
// the four things that must not drift. The store registration is pinned too,
// because a preset that is not imported is not in the bot store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const xmlPath = new URL('../../../src/lib/bot-store/bots/step-index-4t-hedge.xml', import.meta.url);
const storePath = new URL('../../../src/components/dbot-space/bot-store.ts', import.meta.url);

const xml = await readFile(xmlPath, 'utf8');
const store = await readFile(storePath, 'utf8');

function statement(name) {
  const match = xml.match(new RegExp(`<statement name="${name}">([\\s\\S]*?)</statement>`));
  assert.ok(match, `statement ${name} exists`);
  return match[1];
}

function block(type, source = xml) {
  return source.match(new RegExp(`<block type="${type}"[\\s\\S]*?</block>`))?.[0] ?? '';
}

test('the preset is a four-tick Step Index Rise/Fall contract', () => {
  assert.match(xml, /<field name="MARKET_LIST">volidx<\/field>/);
  assert.match(xml, /<field name="SUBMARKET_LIST">step_index<\/field>/);
  assert.match(xml, /<field name="SYMBOL_LIST">stpRNG<\/field>/);
  assert.match(xml, /<field name="TRADETYPECAT_LIST">callput<\/field>/);
  assert.match(xml, /<field name="TRADETYPE_LIST">callput<\/field>/);
  assert.match(xml, /<field name="TYPE_LIST">both<\/field>/);
  assert.match(xml, /<field name="DURATIONTYPE_LIST">t<\/field>/);

  const init = statement('INITIALIZATION');
  const duration = init.match(/<field name="VAR" id="vai_duration">ai duration<\/field>[\s\S]*?<field name="NUM">([^<]+)<\/field>/);
  assert.ok(duration, 'ai duration is initialised');
  assert.equal(Number(duration[1]), 4, 'the contract is four ticks');

  const options = statement('SUBMARKET');
  assert.match(options, /<field name="DURATIONTYPE_LIST">t<\/field>/);
  assert.match(options, /<field name="VAR" id="vai_duration">ai duration<\/field>/);
});

test('the AI pricing block reads the tick list over the traded horizon', () => {
  const decision = xml;
  assert.match(decision, /<field name="MODE">rise-fall<\/field>/);
  assert.match(decision, /<field name="REQUIRE">always<\/field>/);
  assert.match(decision, /<block type="ticks"/);
  assert.match(decision, /<field name="VAR" id="vai_duration">ai duration<\/field>/);
  assert.match(decision, /<field name="NUM">0<\/field>/);
  assert.match(decision, /<field name="NUM">1<\/field>/);
});

test('the hedge buys both directions and risk-checks the pair', () => {
  const hedges = [...xml.matchAll(/<block type="hedge_purchase"[\s\S]*?<\/block>/g)].map(match => match[0]);
  assert.equal(hedges.length, 2, 'one hedge block per direction');
  const pairs = hedges.map(hedge => ({
    main: hedge.match(/<field name="PURCHASE_LIST">([^<]+)<\/field>/)?.[1],
    cover: hedge.match(/<field name="HEDGE_LIST">([^<]+)<\/field>/)?.[1],
  }));
  assert.deepEqual(pairs, [
    { main: 'CALL', cover: 'PUT' },
    { main: 'PUT', cover: 'CALL' },
  ]);
  assert.match(xml, /<field name="VAR" id="vhedge_ratio">hedge ratio<\/field>/);

  const risk = xml;
  for (const input of ['STAKE', 'LEGS', 'BASELINE', 'LOSS', 'TARGET', 'PERCENT']) {
    assert.match(risk, new RegExp(`<value name="${input}">`), `risk block has ${input}`);
  }
  assert.match(risk, /<field name="VAR" id="vhedge_legs">hedge legs<\/field>/);
});

test('the cadence guarantees a measured entry pace without bypassing risk', () => {
  const init = statement('INITIALIZATION');
  const cadence = init.match(/<field name="VAR" id="vai_cadence">ai cadence<\/field>[\s\S]*?<field name="NUM">([^<]+)<\/field>/);
  assert.ok(cadence, 'ai cadence is initialised');
  assert.equal(Number(cadence[1]), 20, 'the cadence is 20 seconds');

  const due = block('x_trade_due');
  assert.match(due, /<value name="SECONDS">/);
  assert.match(due, /<field name="VAR" id="vai_cadence">ai cadence<\/field>/);

  const before = statement('BEFOREPURCHASE_STACK');
  assert.match(before, /<block type="x_trade_due"/);
  assert.match(before, /<block type="x_price_risk"/);
  assert.match(before, /<field name="OP">OR<\/field>/);
  assert.match(before, /<field name="OP">AND<\/field>/);

  // The cadence may stand aside the quality gate, but it is still inside the
  // AND that carries the risk block: no cadence bypasses the money gate.
  const riskIndex = before.indexOf('<block type="x_price_risk"');
  const cadenceIndex = before.indexOf('<block type="x_trade_due"');
  assert.ok(riskIndex > 0 && cadenceIndex > 0);
  assert.match(before.slice(0, riskIndex), /<field name="OP">AND<\/field>/);
});

test('the bot loops after settlement and stops at a session brake', () => {
  assert.match(xml, /<block type="trade_again"/);
  const after = xml;
  assert.match(after, /<block type="x_session_profit"/);
  assert.match(after, /<field name="VAR" id="vtake_profit">take profit<\/field>/);
  assert.match(after, /<field name="VAR" id="vstop_loss">stop loss<\/field>/);
  assert.match(after, /<block type="trade_again"/);
});

test('the preset is registered in the bot store', () => {
  assert.match(store, /import stepIndex4THedgeXml from '@\/lib\/bot-store\/bots\/step-index-4t-hedge\.xml\?raw'/);
  assert.match(store, /id: 'STEP_INDEX_4T_HEDGE'/);
  assert.match(store, /name: 'Step Index 4-Tick Hedge AI'/);
  assert.match(store, /xml: stepIndex4THedgeXml/);
  assert.match(store, /category: 'AI'/);
});
