import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { sanitizeHedgeOptions } from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/hedge-options.mjs';

const vendor = new URL('../../../vendor/deriv-bot/src/external/bot-skeleton/', import.meta.url);

test('high and low tick hedge legs keep independent selections and reject invalid ticks', () => {
  assert.deepEqual(sanitizeHedgeOptions('TICKHIGH', { prediction: 2, barrierOffset: '+1' }), { prediction: 2 });
  assert.deepEqual(sanitizeHedgeOptions('TICKLOW', { prediction: '5' }), { prediction: 5 });
  for (const prediction of [0, 6, 1.5, 'not a tick']) {
    assert.throws(() => sanitizeHedgeOptions('TICKHIGH', { prediction }), /1 to 5/);
  }
});

test('barrier validation fails rather than silently substituting trade options', () => {
  for (const barrierOffset of ['+0', '--1', '+-1', 'garbage', 'Infinity']) {
    assert.throws(() => sanitizeHedgeOptions('CALL', { barrierOffset }), /Invalid hedge barrier/);
  }
  assert.deepEqual(sanitizeHedgeOptions('PUT', { barrierOffset: '-1.25', prediction: 5 }), { barrierOffset: '-1.25' });
  assert.deepEqual(sanitizeHedgeOptions('DIGITUNDER', { prediction: 4, barrierOffset: '+1' }), { prediction: 4 });
});

test('real proposal and buy builders send only the fields appropriate to each contract', async () => {
  let source = await readFile(new URL('services/tradeEngine/utils/helpers.js', vendor), 'utf8');
  source = source.replace(/^import .*;\s*$/gm, '').replace(/export (const|function) /g, '$1 ');
  const ctx = { WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }, isEmptyObject: value => !value || Object.keys(value).length === 0 };
  vm.runInNewContext(source + '\nthis.builders = { tradeOptionToProposal, tradeOptionToBuy };', ctx);
  const options = { amount: 1, basis: 'stake', currency: 'USD', duration: 5, duration_unit: 't', symbol: 'R_100', prediction: 3, barrierOffset: '+1', secondBarrierOffset: '-1' };
  for (const type of ['TICKHIGH', 'TICKLOW', 'DIGITUNDER', 'CALL', 'ONETOUCH']) {
    const proposal = ctx.builders.tradeOptionToProposal({ ...options, contractTypes: [type] }, 'ref')[0];
    const buy = ctx.builders.tradeOptionToBuy(type, options).parameters;
    for (const payload of [proposal, buy]) {
      if (type.startsWith('TICK')) {
        assert.equal(payload.selected_tick, 3);
        assert.equal('barrier' in payload, false);
        assert.equal('barrier2' in payload, false);
      } else if (type.startsWith('DIGIT')) {
        assert.equal(payload.barrier, 3);
        assert.equal('selected_tick' in payload, false);
        assert.equal('barrier2' in payload, false);
      } else {
        assert.equal(payload.barrier, '+1');
        assert.equal('selected_tick' in payload, false);
      }
    }
  }
});

test('contracts_for recognizes signed integer and decimal offsets', async () => {
  let source = await readFile(new URL('services/api/contracts-for.js', vendor), 'utf8');
  source = source.replace(/^import .*;\s*$/gm, '').replace('export default class ContractsFor', 'class ContractsFor');
  const config = () => ({ BARRIER_TRADE_TYPES: ['higherlower'], BARRIER_CATEGORIES: { euro_non_atm: ['higherlower'] } });
  const ctx = { config };
  vm.runInNewContext(source + '\nthis.ContractsFor = ContractsFor;', ctx);
  const instance = Object.create(ctx.ContractsFor.prototype);
  instance.getContractCategoryByTradeType = () => 'euro_non_atm';
  instance.getDurations = async () => [{ unit: 't' }];
  for (const barrier of ['+1', '-1', '+0.25', '-12.5']) {
    instance.getContractsByTradeType = async () => [{ contract_category: 'euro_non_atm', expiry_type: 'tick', barriers: 1, barrier }];
    const result = await instance.getBarriers('R_100', 'higherlower', 't', ['+', '-']);
    assert.equal(result.values[0], barrier.slice(1));
    assert.equal(result.allow_both_types, true);
  }
});

test('purchaseHedge forwards separate tick predictions and validates both before buying', async () => {
  let source = await readFile(new URL('services/tradeEngine/trade/Purchase.js', vendor), 'utf8');
  source = source.replace(/^import .*;\s*$/gm, '').replace('export default Engine =>', 'this.Purchase = Engine =>');
  const sends = [];
  const ctx = {
    sanitizeHedgeOptions,
    BEFORE_PURCHASE: 'before',
    api_base: { api: { send: async request => { sends.push(request); return { buy: { contract_id: sends.length, transaction_id: sends.length, buy_price: 1 } }; } } },
    tradeOptionToBuy: (type, options) => ({ type, options }),
    doUntilDone: fn => fn(),
    contractStatus: () => {}, info: () => {}, log: () => {},
    LogTypes: { PURCHASE: 'purchase', ERROR: 'error' },
    purchaseSuccessful: () => ({}),
  };
  vm.runInNewContext(source, ctx);
  const engine = new (ctx.Purchase(class {}))();
  engine.store = { getState: () => ({ scope: 'before' }), dispatch: () => {} };
  engine.tradeOptions = { amount: 1, prediction: 1, barrierOffset: '+9' };
  engine.accountInfo = { loginid: 'demo' };
  engine.updateAndReturnTotalRuns = () => 1;
  await engine.purchaseHedge('TICKHIGH', 'TICKLOW', { prediction: 2 }, { prediction: 4 });
  assert.equal(sends.length, 2);
  assert.equal(sends[0].options.prediction, 2);
  assert.equal(sends[1].options.prediction, 4);
  assert.equal('barrierOffset' in sends[0].options, false);
  assert.throws(() => engine.purchaseHedge('TICKHIGH', 'TICKLOW', { prediction: 3 }, { prediction: 9 }), /1 to 5/);
  assert.equal(sends.length, 2, 'neither leg is sent when one selection is invalid');
});

test('hedge block exposes tick predictions and updates only untouched defaults for each leg', async () => {
  let source = await readFile(new URL('scratch/blocks/Binary/Before Purchase/hedge_purchase.js', vendor), 'utf8');
  source = source.replace(/^import .*;\s*$/gm, '');
  const pending = [];
  const contracts = { getBarriers: (symbol, type, unit, signs) => new Promise(resolve => pending.push({ symbol, signs: [...signs], resolve })) };
  const ctx = {
    window: { Blockly: { Blocks: {}, JavaScript: { javascriptGenerator: { forBlock: {} } } } },
    ApiHelpers: { instance: { contracts_for: contracts } },
    runIrreversibleEvents: fn => fn(),
  };
  vm.runInNewContext(source + '\nthis.settings = legSettingsFor;', ctx);
  assert.equal(ctx.settings('highlowticks').prediction, true);
  const block = ctx.window.Blockly.Blocks.hedge_purchase;
  const shadow = value => ({ value, isShadow: () => true, getFieldValue() { return this.value; }, setFieldValue(v) { this.value = v; } });
  const first = shadow('1');
  const second = shadow('1');
  const subject = {
    workspace: {},
    defaultBarrierTargets_: { BARRIEROFFSET: { block: first, value: '1' }, HEDGE_BARRIEROFFSET: { block: second, value: '1' } },
    getFieldValue: name => name === 'HEDGE_BARRIEROFFSETTYPE_LIST' ? '-' : '+',
    getInput: name => ({ connection: { targetBlock: () => name === 'BARRIEROFFSET' ? first : second } }),
  };
  const definition = { getChildByType: type => type === 'trade_definition_market' ? { getFieldValue: () => 'R_100' } : { getFieldValue: () => 't' } };
  block.applyDefaultBarriers.call(subject, definition, 'higherlower', true);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signs[0], '+');
  assert.equal(pending[1].signs[0], '-');
  // A user edit during the metadata request must not be clobbered.
  second.value = '4';
  pending[0].resolve({ values: ['2'] }); pending[1].resolve({ values: ['3'] });
  await Promise.resolve();
  assert.equal(first.value, '2');
  assert.equal(second.value, '4');
  // A loaded XML shadow, even one with value 1, is not our generated shadow.
  subject.defaultBarrierTargets_.BARRIEROFFSET.block = shadow('1');
  first.value = '1';
  block.applyDefaultBarriers.call(subject, definition, 'higherlower', false);
  pending[2].resolve({ values: ['5'] }); pending[3].resolve({ values: ['5'] });
  await Promise.resolve();
  assert.equal(first.value, '1');
});
