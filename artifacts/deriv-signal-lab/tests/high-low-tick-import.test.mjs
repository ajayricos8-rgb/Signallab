import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const preset = new URL('../src/lib/bot-store/bots/high-low-tick-sniper.xml', import.meta.url);
const generator = new URL('../scripts/presets/gen_presets.py', import.meta.url);

test('High/Low Tick ELSE branches retain the purchase and all other statements', () => {
  // Structural, not positional: the preset generator rewrites the whole file,
  // so an assertion keyed to a block id would fail on every regeneration even
  // when the wiring is identical. What must hold is that the contract is
  // purchased from inside the "ready" ELSE branch, behind the risk gate, and
  // that every ELSE branch carries the mutation Blockly needs to load it.
  const script = `
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
n = {'x': 'http://www.w3.org/1999/xhtml'}
ifs = root.findall('.//x:block[@type="controls_if"]', n)
for block in ifs:
    if block.find("x:statement[@name='ELSE']", n) is not None:
        mutation = block.find('x:mutation', n)
        assert mutation is not None and mutation.get('else') == '1', block.get('id')

before = root.find('.//x:block[@type="before_purchase"]', n)
assert before is not None
inner = [
    block for block in before.findall('.//x:block[@type="controls_if"]', n)
    if block.find("x:statement[@name='DO0']//x:block[@type='x_tick_decision_purchase']", n) is not None
]
assert len(inner) == 1, 'exactly one branch can buy'
inner = inner[0]
assert inner.find("x:statement[@name='ELSE']", n) is not None, 'the buy branch has an else'
assert inner.find("x:value[@name='IF0']//x:block[@type='x_price_risk']", n) is not None, 'the risk gate sits in the buy branch'
# ... and that branch is the ELSE of the outer "model is/ is not ready" IF, so a
# ready plan reaches the purchase instead of being skipped.
outer = [
    block for block in before.findall('.//x:block[@type="controls_if"]', n)
    if block is not inner
    and block.find("x:statement[@name='ELSE']//x:block[@id='%s']" % inner.get('id'), n) is not None
]
assert len(outer) == 1, 'the buy branch is the ELSE of the ready check'

# The multi-market scan runs before the decision, and the once-a-minute
# cadence is ORed into the entry gate.
tick = root.find('.//x:block[@type="tick_analysis"]', n)
scan = tick.find(".//x:block[@type='x_market_scan']", n)
decision = tick.find(".//x:block[@type='x_price_decision']", n)
assert scan is not None and decision is not None
order = [block.get('id') for block in tick.iter('{http://www.w3.org/1999/xhtml}block')]
assert order.index(scan.get('id')) < order.index(decision.get('id')), 'the scan runs first'
assert tick.find(".//x:block[@type='x_scan_switch_best']", n) is not None
assert before.find(".//x:block[@type='x_trade_due']", n) is not None
`;
  execFileSync('python3', ['-c', script, preset.pathname]);
});

test('the checked-in sniper matches its existing preset generator', () => {
  const script = `import sys; sys.path.insert(0, sys.argv[1]); from gen_presets import build,TICK_SNIPER; print(build(TICK_SNIPER), end='')`;
  const generated = execFileSync('python3', ['-c', script, new URL('.', generator).pathname], { encoding: 'utf8' });
  assert.equal(readFileSync(preset, 'utf8'), generated);
});
