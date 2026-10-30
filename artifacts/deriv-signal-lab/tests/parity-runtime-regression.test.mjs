import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parityQuotesFresh } from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/parity-quote-safety.mjs';

const engine = new URL('../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/', import.meta.url);

test('the engine passes verified market precision to parity, not the price model', async () => {
  const source = await readFile(new URL('Interface/VisionInterface.js', engine), 'utf8');
  const parity = source.slice(source.indexOf('parityDecision: async'), source.indexOf('parityDecisionPart:', source.indexOf('parityDecision: async')));
  const price = source.slice(source.indexOf('priceDecision: async'), source.indexOf('priceDecisionPart:', source.indexOf('priceDecision: async')));
  assert.match(parity, /if \(pipSize === null\)/);
  assert.match(parity, /parityDecision\(list, duration, num\(threshold, 0\),\s*\{\s*pipSize,/);
  assert.doesNotMatch(price, /\bpipSize\s*,/);
});

test('parity proposals are published before unrelated slow contracts finish', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const requests = [];
  globalThis.__mockPayoutApi = { api: { send: async request => {
    requests.push(request);
    if (!request.contract_type.startsWith('DIGITEV') && request.contract_type !== 'DIGITODD') await blocked;
    return { proposal: { payout: 1.95, ask_price: 1 } };
  } } };
  let source = await readFile(new URL('utils/vision-payouts.js', engine), 'utf8');
  source = source.replace("import { api_base } from '../../api/api-base';", 'const api_base = globalThis.__mockPayoutApi;')
    .replace("'./vision-ai.mjs'", JSON.stringify(new URL('utils/vision-ai.mjs', engine).href))
    .replace("'./parity-strategies.mjs'", JSON.stringify(new URL('utils/parity-strategies.mjs', engine).href));
  const payouts = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  // Parity slots must not make an incomplete Over/Under ladder look complete.
  const ladder = new payouts.PayoutTable('test');
  ladder.setParity('even', 1.95);
  ladder.setParity('odd', 1.95);
  for (let b = 0; b < 8; b++) { ladder.set('over', b, 2); ladder.set('under', b + 1, 2); }
  assert.equal(ladder.complete, false);
  ladder.set('over', 8, 2);
  ladder.set('under', 9, 2);
  assert.equal(ladder.complete, true);
  const options = { symbol: 'R_TEST', duration: 5, durationUnit: 't', currency: 'USD', amount: 1 };
  const pending = payouts.ensurePayouts(options);
  try {
    // Allow the first two responses to resolve while the other batch members
    // stay blocked; this does not wait for the complete payout ladder.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests.slice(0, 2).map(r => r.contract_type), ['DIGITEVEN', 'DIGITODD']);
    assert.equal(parityQuotesFresh(payouts.peekPayouts(options)), true);
    const result = await pending; // the four-second first-quote budget expires
    assert.equal(parityQuotesFresh(result), true);
    assert.equal(result, payouts.payoutSnapshot(options).table);
  } finally {
    release();
    await payouts.refreshPayouts(options);
    delete globalThis.__mockPayoutApi;
  }
});
