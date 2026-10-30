import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const preset = new URL('../src/lib/bot-store/bots/high-low-tick-sniper.xml', import.meta.url);
const generator = new URL('../scripts/presets/gen_presets.py', import.meta.url);

test('High/Low Tick ELSE branches retain the purchase and all other statements', () => {
  const script = `
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
n = {'x': 'http://www.w3.org/1999/xhtml'}
ifs = root.findall('.//x:block[@type="controls_if"]', n)
for block in ifs:
    if block.find("x:statement[@name='ELSE']", n) is not None:
        mutation = block.find('x:mutation', n)
        assert mutation is not None and mutation.get('else') == '1', block.get('id')
outer = root.find('.//x:block[@id="b0193"]', n)
inner = outer.find("x:statement[@name='ELSE']/x:block[@id='b0192']", n)
assert inner is not None
buy = inner.find("x:statement[@name='DO0']//x:block[@type='x_tick_decision_purchase']", n)
assert buy is not None and buy.get('id') == 'b0160'
assert inner.find("x:statement[@name='ELSE']", n) is not None
assert inner.find("x:value[@name='IF0']//x:block[@type='x_price_risk']", n) is not None
assert root.find('.//x:block[@id="b0218"]/x:mutation', n).get('else') == '1'
`;
  execFileSync('python3', ['-c', script, preset.pathname]);
});

test('the checked-in sniper matches its existing preset generator', () => {
  const script = `import sys; sys.path.insert(0, sys.argv[1]); from gen_presets import build,TICK_SNIPER; print(build(TICK_SNIPER), end='')`;
  const generated = execFileSync('python3', ['-c', script, new URL('.', generator).pathname], { encoding: 'utf8' });
  assert.equal(readFileSync(preset, 'utf8'), generated);
});
