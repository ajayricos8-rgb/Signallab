import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKOV_PLAN_PARTS,
  markovPlan,
  markovRead,
  markovReport,
} from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/markov-chain.mjs';

/**
 * A Step Index-like tape: exactly one quote increment per tick, direction drawn
 * from a deterministic generator. `persist` is P(the next step keeps its
 * direction); 0.5 is a fair walk, which is what a Step index actually is.
 */
function stepStream({ length = 2000, persist = 0.5, seed = 7, step = 0.1, start = 1000 } = {}) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
  let price = start;
  let direction = 1;
  const out = [price];
  for (let index = 0; index < length; index++) {
    direction = random() < persist ? direction : -direction;
    price += direction * step;
    out.push(Number(price.toFixed(2)));
  }
  return out;
}

const read4 = (prices, extra = {}) =>
  markovRead(prices, { order: 3, memory: 400, horizon: 4, payout: 0.95, minSamples: 120, ...extra });

test('a fair four-tick step walk lands on the enumerated structure, not a flat guess', () => {
  // A long fit window: a 400-tick sample carries a real directional imbalance,
  // and the structural read is about the walk, not about that imbalance.
  const read = read4(stepStream({ length: 4000, persist: 0.5, seed: 21 }), { memory: 2000 });
  assert.equal(read.ready, 1);
  // Enumerating the 16 four-step +/-1 paths: 5 up, 5 down and 6 ties, so the
  // unconditional read has to sit on 31.25 / 31.25 / 37.5 %.
  assert.ok(Math.abs(read.baseUp - 0.3125) < 0.03, `base up ${read.baseUp}`);
  assert.ok(Math.abs(read.baseTie - 0.375) < 0.03, `base tie ${read.baseTie}`);
  assert.ok(Math.abs(read.baseUp + read.baseDown + read.baseTie - 1) < 1e-5, 'the projection is a distribution');
  // And the tie tax is real: a strict contract at a 0.95 payout needs 51.3 %.
  assert.ok(read.breakEven > 0.51 && read.breakEven < 0.52);
  assert.ok(read.edge < 0, 'an unconditioned fair walk cannot clear break-even with ties charged as losses');
});

test('the chain carries the horizon exactly, so ties grow with the contract length', () => {
  const prices = stepStream({ length: 3000, persist: 0.5, seed: 33 });
  const two = markovRead(prices, { horizon: 2, memory: 2000, minSamples: 120 });
  const four = markovRead(prices, { horizon: 4, memory: 2000, minSamples: 120 });
  const six = markovRead(prices, { horizon: 6, memory: 2000, minSamples: 120 });
  const odd = markovRead(prices, { horizon: 3, memory: 2000, minSamples: 120 });
  assert.equal(two.horizon, 2);
  assert.equal(six.horizon, 6);
  // On a one-increment grid the net displacement has the parity of the horizon:
  // an even horizon can tie, an odd one cannot, and the enumerated masses are
  // 1/2, 6/16 and 20/64 for two, four and six ticks.
  assert.ok(Math.abs(two.tie - 0.5) < 0.03, `two-tick tie ${two.tie}`);
  assert.ok(Math.abs(four.tie - 0.375) < 0.04, `four-tick tie ${four.tie}`);
  assert.ok(Math.abs(six.tie - 0.3125) < 0.04, `six-tick tie ${six.tie}`);
  assert.ok(odd.tie < 0.02, `an odd horizon cannot tie (got ${odd.tie})`);
  [two, four, six, odd].forEach(read => {
    assert.ok(Math.abs(read.up + read.down + read.tie - 1) < 1e-5, `${read.horizon}-tick distribution sums to 1`);
  });
});

test('a persistent tape is read as persistent, and its tie tax falls', () => {
  const read = read4(stepStream({ length: 3000, persist: 0.75, seed: 5 }));
  assert.equal(read.ready, 1);
  // Step-to-step continuation is measurable, and the chain's own table is
  // significantly different from the independent one.
  assert.ok(read.persistence > 0.2, `persistence ${read.persistence}`);
  assert.ok(read.chi2p < 0.01, `independence p ${read.chi2p}`);
  assert.ok(read.readability > 60, `readability ${read.readability}`);
  // A trending walk revisits its entry less often, which is the only honest
  // way a four-tick strict contract becomes playable.
  assert.ok(read.tie < 0.34, `tie ${read.tie}`);
});

test('an anti-persistent tape is read the other way round', () => {
  const read = read4(stepStream({ length: 3000, persist: 0.2, seed: 9 }));
  assert.ok(read.persistence < -0.4, `persistence ${read.persistence}`);
  // Mean-reverting tape returns to its entry more often: ties rise.
  assert.ok(read.tie > 0.34, `tie ${read.tie}`);
});

test('the read refuses to publish from a thin chain and names why', () => {
  const warming = read4(stepStream({ length: 2, seed: 2 }));
  assert.equal(warming.ready, 0);
  assert.match(warming.reason, /warming up/);

  const thin = read4(stepStream({ length: 40, seed: 2 }));
  assert.equal(thin.ready, 0);
  assert.match(thin.reason, /thin chain/);
  assert.equal(thin.side, 0, 'no side is named without evidence');

  const short = markovRead(stepStream({ length: 400, seed: 2 }), { memory: 200, minSamples: 400 });
  assert.equal(short.ready, 0, 'the sample floor is the caller’s, not the module’s');
});

test('the tie ceiling is enforced as a measured gate, not an assumption', () => {
  const fair = read4(stepStream({ length: 3000, persist: 0.5, seed: 17 }), { maxTie: 0.2 });
  assert.equal(fair.tieOk, 0);
  assert.match(fair.reason, /tie risk/);
  const tolerant = read4(stepStream({ length: 3000, persist: 0.5, seed: 17 }), { maxTie: 0.5 });
  assert.equal(tolerant.tieOk, 1);
});

test('flat ticks are handled: a band turns unchanged quotes into a flat step', () => {
  const prices = [100, 100, 100.1, 100.1, 100.2, 100.1, 100.1, 100.0];
  const withBand = markovRead(prices, { order: 2, horizon: 2, band: 0.15, minSamples: 1, priorWeight: 1 });
  assert.ok(Number.isFinite(withBand.up));
  assert.ok(Math.abs(withBand.up + withBand.down + withBand.tie - 1) < 1e-5);
});

test('the plan and the journal line carry the same numbers', () => {
  const read = read4(stepStream({ length: 1200, persist: 0.7, seed: 4 }));
  const plan = markovPlan(read);
  assert.equal(plan.length, Object.keys(MARKOV_PLAN_PARTS).length);
  assert.equal(plan[MARKOV_PLAN_PARTS.ready], read.ready);
  assert.equal(plan[MARKOV_PLAN_PARTS.side], read.side);
  assert.equal(plan[MARKOV_PLAN_PARTS.up], read.up);
  assert.equal(plan[MARKOV_PLAN_PARTS.tie], read.tie);
  assert.equal(plan[MARKOV_PLAN_PARTS.edge], read.edge);
  assert.equal(plan[MARKOV_PLAN_PARTS['break-even']], read.breakEven);
  assert.equal(plan[MARKOV_PLAN_PARTS['state-samples']], read.stateSamples);
  assert.equal(plan[MARKOV_PLAN_PARTS.horizon], 4);
  plan.forEach(value => assert.equal(Number.isFinite(value), true));

  const line = markovReport(read);
  assert.match(line, /MARKOV 3rd-order 4-tick/);
  assert.match(line, /tie \d+\.\d%/);
  assert.match(line, /break-even \d+\.\d%/);
  assert.match(line, /readability \d+\/100/);
  assert.match(markovReport(null), /no read yet/);
  assert.match(markovReport({ ready: 0, reason: 'thin chain' }), /thin chain/);
});

test('the same ticks always produce the same read, and the past is never re-read', () => {
  const prices = stepStream({ length: 1500, persist: 0.6, seed: 77 });
  const first = read4(prices);
  const second = read4(prices.slice());
  assert.deepEqual(first, second, 'the model is a pure function of the tick list');

  // Reading a prefix must equal reading it after a longer tape is truncated,
  // which is what the live runtime does as the tick list rolls.
  const prefix = prices.slice(0, 900);
  assert.deepEqual(read4(prefix), read4(prefix.slice()));
});
