import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/', import.meta.url);

test('session ledger tracks settled trades independently of account statistics and sends exact limit events', async () => {
  let totals = await readFile(new URL('trade/Total.js', root), 'utf8');
  totals = totals.replace(/^import .*;\s*$/gm, '').replace('export default Engine =>', 'this.withTotals = Engine =>');
  const messages = [];
  const context = {
    getRoundedNumber: value => Math.round(value * 100) / 100,
    globalObserver: { register() {} }, info() {}, log() {},
    LogTypes: { PROFIT: 'profit', LOST: 'lost' },
    window: { parent: { postMessage: (...args) => messages.push(args) }, location: { origin: 'https://signal.test' } },
  };
  vm.runInNewContext(totals, context);
  class Engine { constructor() { this.accountInfo = { loginid: 'VRTC1', currency: 'USD' }; this.tradeOptions = { currency: 'USD' }; } }
  const engine = new (context.withTotals(Engine))();
  engine.updateAndReturnTotalRuns();
  engine.updateTotals({ sell_price: 110, buy_price: 100, currency: 'USD' });
  assert.equal(engine.signalLabSessionProfit, 10);
  assert.equal(engine.signalLabSessionRuns, 1);

  let api = await readFile(new URL('Interface/SignalLabInterface.js', root), 'utf8');
  api = api.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*/, '').replace('export default getSignalLabInterface;', 'this.getSignalLabInterface = getSignalLabInterface;');
  vm.runInNewContext(api, context);
  const bot = context.getSignalLabInterface(engine);
  await bot.signalLabStartSession();
  assert.equal(await bot.signalLabSessionProfit(), 0);
  assert.equal(await bot.signalLabSessionRuns(), 0);
  assert.equal(engine.getTotalProfit(false), 10, 'starting a session must not erase account-wide statistics');
  engine.updateAndReturnTotalRuns();
  engine.updateTotals({ sell_price: 20, buy_price: 35, currency: 'USD' });
  engine.clearStatistics();
  assert.equal(await bot.signalLabSessionProfit(), -15, 'clearing account statistics must not erase the active session');
  assert.equal(await bot.signalLabSessionRuns(), 1);
  engine.updateAndReturnTotalRuns();
  engine.updateTotals({ sell_price: 30, buy_price: 20, currency: 'USD' });
  assert.equal(await bot.signalLabSessionProfit(), -5);
  assert.equal(await bot.signalLabSessionRuns(), 2);
  await bot.signalLabNotifySessionStop('stop-loss', -5);
  assert.equal(messages.length, 1);
  assert.deepEqual({ ...messages[0][0] }, { source: 'signal-lab-dbot', type: 'session-limit-hit', reason: 'stop-loss', profit: -5, currency: 'USD' });
  assert.equal(messages[0][1], 'https://signal.test');
  await bot.signalLabNotifySessionStop('bad', -5);
  await bot.signalLabNotifySessionStop('stop-loss', Infinity);
  assert.equal(messages.length, 1);
});
