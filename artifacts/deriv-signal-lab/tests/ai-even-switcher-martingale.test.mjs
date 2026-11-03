// Structural and integrity tests for the AI Even/Odd Switcher bot with Martingale,
// Take Profit, Stop Loss, and Journal Notifications.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const xmlPath = new URL('../../../src/lib/bot-store/bots/ai-even-switcher.xml', import.meta.url);
const storePath = new URL('../../../src/components/dbot-space/bot-store.ts', import.meta.url);

const xml = await readFile(xmlPath, 'utf8');
const store = await readFile(storePath, 'utf8');

function section(type) {
  const start = xml.indexOf(`<block type="${type}"`);
  assert.ok(start !== -1, `block ${type} exists`);
  const end = xml.indexOf('</block>\n<block', start);
  return xml.slice(start, end !== -1 ? end : xml.length);
}

test('the preset declares martingale, take profit and stop loss variables', () => {
  assert.match(xml, /<variable type="" id="vmartingale_multiplier">martingale multiplier<\/variable>/);
  assert.match(xml, /<variable type="" id="vmartingale_steps">martingale steps<\/variable>/);
  assert.match(xml, /<variable type="" id="vai_ladder_step">ai ladder step<\/variable>/);
  assert.match(xml, /<variable type="" id="vtake_profit">take profit<\/variable>/);
  assert.match(xml, /<variable type="" id="vstop_loss">stop loss<\/variable>/);
});

test('INITIALIZATION configures martingale ladder, take profit and stop loss defaults', () => {
  const init = section('trade_definition');
  assert.match(init, /<field name="VAR" id="vmartingale_multiplier">martingale multiplier<\/field>[\s\S]*?<field name="NUM">2<\/field>/);
  assert.match(init, /<field name="VAR" id="vmartingale_steps">martingale steps<\/field>[\s\S]*?<field name="NUM">3<\/field>/);
  assert.match(init, /<field name="VAR" id="vai_ladder_step">ai ladder step<\/field>[\s\S]*?<field name="NUM">0<\/field>/);
  assert.match(init, /<field name="VAR" id="vtake_profit">take profit<\/field>[\s\S]*?<field name="NUM">50<\/field>/);
  assert.match(init, /<field name="VAR" id="vstop_loss">stop loss<\/field>[\s\S]*?<field name="NUM">30<\/field>/);
});

test('AFTERPURCHASE handles win by resetting ladder and notifying journal', () => {
  const after = section('after_purchase');
  assert.match(after, /<field name="CHECK_RESULT">win<\/field>/);
  assert.match(after, /Trade won! Martingale ladder reset to base stake\./);
});

test('AFTERPURCHASE handles loss with progression ladder, step cap, max stake cap and notifications', () => {
  const after = section('after_purchase');
  assert.match(after, /<field name="CHECK_RESULT">loss<\/field>/);
  assert.match(after, /Martingale ladder reached max progression steps and reset to base stake\./);
  assert.match(after, /Trade lost: next martingale stake capped at max stake ceiling\./);
  assert.match(after, /Trade lost: multiplying stake for martingale recovery\./);
});

test('AFTERPURCHASE session brakes gate take profit and stop loss with dedicated notifications', () => {
  const after = section('after_purchase');
  assert.match(after, /<field name="VAR" id="vtake_profit">take profit<\/field>/);
  assert.match(after, /<field name="VAR" id="vstop_loss">stop loss<\/field>/);
  assert.match(after, /Take profit target reached! Bot session completed successfully\./);
  assert.match(after, /Stop loss limit reached! Bot halted to protect capital\./);
});

test('XML is well-formed and deserializable by Blockly', () => {
  const script = `import xml.etree.ElementTree as ET, sys
root = ET.parse(sys.argv[1]).getroot()
ns = {"x": "http://www.w3.org/1999/xhtml"}
for block in root.findall(".//x:block[@type='controls_if']", ns):
    if block.find("x:statement[@name='ELSE']", ns) is not None:
        mutation = block.find("x:mutation", ns)
        assert mutation is not None and mutation.get("else") == "1", block.get("id")
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script, xmlPath.pathname]));
});

test('bot store description is consistent with new risk controls', () => {
  assert.match(store, /id: 'AI_EVEN_SWITCHER'/);
  assert.match(store, /Martingale progression with configurable multiplier, steps, take profit and stop loss session brakes/);
});
