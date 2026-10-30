import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Load the actual block modules in an isolated browser-like context. There is
// intentionally no global `localize`: block modules must import translations
// themselves, just as they do in the production Blockly bundle.
async function loadMarketScanBlocks() {
  const blockly = {
    Blocks: {},
    Colours: {},
    Categories: { Vision_Analysis: 'vision-analysis' },
    JavaScript: {
      javascriptGenerator: {
        forBlock: {},
        ORDER_ATOMIC: 0,
        valueToCode: (block, name) => block.inputs?.[name] ?? '',
      },
    },
  };
  const context = vm.createContext({ window: { Blockly: blockly } });
  const root = new URL('../src/external/bot-skeleton/scratch/blocks/Vision%20Lab/', import.meta.url);
  const sourceModule = async name => new vm.SourceTextModule(await readFile(new URL(name, root), 'utf8'), {
    context,
    identifier: name,
  });
  const factory = await sourceModule('factory.js');
  const colours = await sourceModule('colour.js');
  const scan = await sourceModule('market-scan.js');
  const translations = new vm.SyntheticModule(['localize'], function () {
    this.setExport('localize', text => `translated: ${text}`);
  }, { context });
  const utils = new vm.SyntheticModule(['modifyContextMenu'], function () {
    this.setExport('modifyContextMenu', () => {});
  }, { context });

  await scan.link(specifier => {
    const modules = {
      './factory': factory,
      './colour': colours,
      '@deriv-com/translations': translations,
      '../../utils': utils,
    };
    assert.ok(modules[specifier], `Unexpected module: ${specifier}`);
    return modules[specifier];
  });
  await scan.evaluate();
  return blockly;
}

test('the AI market-scan module initializes and registers translated blocks and generators', async () => {
  const blockly = await loadMarketScanBlocks();
  const expectedTypes = [
    'x_market_scan', 'x_scan_switch_best', 'x_scan_stand_best', 'x_scan_best',
    'x_scan_score', 'x_scan_rank', 'x_scan_count', 'x_scan_summary',
    'x_trade_due', 'x_seconds_since_trade',
  ];
  const generator = blockly.JavaScript.javascriptGenerator;
  for (const type of expectedTypes) {
    assert.ok(blockly.Blocks[type], `${type} must be registered`);
    assert.equal(typeof generator.forBlock[type], 'function', `${type} must generate code`);
    assert.match(blockly.Blocks[type].definition().message0, /^translated: /);
    assert.match(blockly.Blocks[type].meta().display_name, /^translated: /);
  }
  const scanDefinition = blockly.Blocks.x_market_scan.definition();
  const family = scanDefinition.args0.find(arg => arg.name === 'FAMILY');
  assert.deepEqual(Array.from(family.options, option => Array.from(option)), [
    ['translated: Even / Odd', 'even-odd'],
    ['translated: Over / Under', 'over-under'],
    ['translated: High / Low Tick', 'high-low-tick'],
    ['translated: Rise / Fall', 'rise-fall'],
  ]);

  const block = { getFieldValue: name => name === 'FAMILY' ? 'even-odd' : null };
  assert.equal(generator.forBlock.x_market_scan(block), 'Bot.marketScan("even-odd", 5, 1.95, 1, 8, 0.35);\n');
  assert.equal(generator.forBlock.x_scan_stand_best(block), 'Bot.scanSwitchBest(25, 3, 25);\n');
  assert.equal(generator.forBlock.x_scan_switch_best(block)[0], 'Bot.scanSwitchBest(25, 3, 25)');
  assert.equal(generator.forBlock.x_scan_score(block)[0], 'Bot.scanScore("")');
  assert.equal(generator.forBlock.x_trade_due(block)[0], 'Bot.tradeDue(60)');
});
