import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parityQuotesFresh } from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/parity-quote-safety.mjs';
import { parityDna, parityDecision } from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/parity-strategies.mjs';

const now = 1_000_000;
const quotes = { even: 1.95, odd: 1.94, parityAt: { even: now - 10, odd: now - 20 } };
test('both prices need independent, recent timestamps', () => {
  assert.equal(parityQuotesFresh(quotes, now), true);
  assert.equal(parityQuotesFresh(null, now), false);
  assert.equal(parityQuotesFresh({ ...quotes, odd: 0 }, now), false);
  assert.equal(parityQuotesFresh({ ...quotes, parityAt: { even: now - 10 } }, now), false);
  assert.equal(parityQuotesFresh({ ...quotes, parityAt: { even: now - 10, odd: now - 300_000 } }, now), false);
  assert.equal(parityQuotesFresh({ ...quotes, parityAt: { even: now + 1, odd: now } }, now), false);
  assert.equal(parityQuotesFresh({ ...quotes, parityAt: {} }, now), false);
});
test('explicit pip size retains trailing zeros in digit analysis', () => {
  const tape = Array.from({ length: 200 }, (_, i) => 100 + (i % 10) / 100);
  const actual = parityDna(tape, { pipSize: 3 });
  assert.equal(actual.pipSize, 3);
  assert.equal(actual.evenShare, 1);
  assert.equal(parityDecision(tape, 5, 0, { pipSize: 3 }).dna.pipSize, 3);
});
test('runtime fails closed without precision and never counts cached partial quotes as live', async () => {
  const file = await readFile(new URL('../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/Interface/VisionInterface.js', import.meta.url), 'utf8');
  assert.match(file, /if \(pipSize === null\)/);
  assert.match(file, /const freshQuotes = parityQuotesFresh\(table\)/);
  assert.match(file, /payoutLive: freshQuotes \? 1 : 0/);
  assert.match(file, /Number\(stake\) \* Number\(legs\) <= Number\(balance\) \* Number\(percent\) \/ 100/);
  assert.match(file, /entry\.forecastHorizon/);
});
