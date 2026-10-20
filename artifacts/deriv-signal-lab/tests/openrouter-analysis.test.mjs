import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAiSelection, buildAiEvidence, reviewScan } from '../src/lib/openrouter-analysis.ts';

const best = {
  label: 'EVEN', probability: 0.51, fairProbability: 0.5, confidence: 53,
  votes: [{ label: 'Markov', value: 0.51, weight: 0.5 }], deep: { confirmation: { status: 'cautious' } },
  precision: { edgeZ: 0.2 }, backtest: { sample: 90, winRate: 0.5 }, research: { validated: false },
  entry: { mode: 'immediate', label: 'Next tick', detail: 'No timing gain', windowTicks: 5, validation: null,
    priceLevel: null, priceCondition: null, contextDigits: null, contextLabel: null, trigger: 'none', reachRate: null, confidence: 40 },
  master: { validity: { ticks: 1, ms: 2000 }, verdict: 'NO_EDGE' },
};
const digit = (symbol) => ({ kind: 'digit', family: 'even-odd', symbol, best: structuredClone(best), sample: 1000, horizon: 5,
  fresh: true, asOfEpoch: 123, state: { regime: 'random' }, aiSynthesis: { verdict: 'cautious' }, account: 'PRIVATE' });
const results = [digit('R_10'), digit('R_100')];
const jobs = [{ kind: 'digit', symbol: 'R_10', input: { ticks: Array.from({ length: 100 }, (_, i) => ({ epoch: i, digit: i % 10 })), settlements: ['PRIVATE'] } }];
const ai = { candidateId: 'candidate-1', model: 'test/model:free', reviewedAt: 100, stance: 'caution',
  analysis: 'No edge', prediction: 'Uncertain', entry: 'Next tick', risks: ['No guarantees'], horizonTicks: 12 };

test('public evidence whitelist includes forecasts, calculations, replay and latest 64 ticks only', () => {
  const input = buildAiEvidence(results, jobs);
  assert.equal(input.candidates[0].recentTicks.length, 64);
  assert.equal(input.candidates[0].recentTicks[0].epoch, 36);
  assert.equal(input.candidates[0].entry.validForTicks, 1);
  assert.equal(input.candidates[0].probability, 0.51);
  assert.equal(input.candidates[0].votes[0].probability, 0.51);
  assert.equal(JSON.stringify(input).includes('PRIVATE'), false);
  assert.equal(input.candidates.length, 2);
});

test('AI influences market selection without mutating probability, entry, verdict or validity', () => {
  const before = structuredClone(results);
  const ranked = applyAiSelection(results, ai);
  assert.equal(ranked[0].symbol, 'R_100');
  assert.deepEqual(results, before);
  assert.equal(ranked[0].best.probability, 0.51);
  assert.equal(ranked[0].best.master.validity.ticks, 1);
  assert.equal(ranked[0].best.master.verdict, 'NO_EDGE');
  assert.equal(ranked[0].best.entry.windowTicks, 5);
  for (const id of ['candidate-99', 'candidate--1', 'NaN', 'candidate-1.5']) {
    assert.throws(() => applyAiSelection(results, { ...ai, candidateId: id }));
  }
});

test('review uses relative API URL, preserves snapshot age and measured limits', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/openrouter/analyze');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.body.includes('PRIVATE'), false);
      return Response.json(ai);
    };
    const reviewed = await reviewScan(results, jobs, 50, new AbortController().signal);
    assert.equal(reviewed.results[0].symbol, 'R_100');
    assert.equal(reviewed.aiReview.snapshotAt, 50);
    assert.equal(reviewed.aiReview.validityTicks, 1);
    assert.equal(reviewed.aiReview.validityMs, 2000);
    assert.equal(reviewed.aiReview.status, 'reviewed');
  } finally { globalThis.fetch = previous; }
});

test('network, quota and malformed model output failures explicitly retain engine-only results', async () => {
  const previous = globalThis.fetch;
  try {
    for (const handler of [
      async () => { throw Error('Network unavailable'); },
      async () => Response.json({ error: 'Rate limited' }, { status: 429 }),
      async () => Response.json({ ...ai, horizonTicks: 999 }),
      async () => Response.json({ ...ai, candidateId: 'candidate-99' }),
    ]) {
      globalThis.fetch = handler;
      const reviewed = await reviewScan(results, jobs, 50, new AbortController().signal);
      assert.equal(reviewed.aiReview.status, 'unavailable');
      assert.deepEqual(reviewed.results, results);
    }
  } finally { globalThis.fetch = previous; }
});

test('cancelled AI review cannot publish a completed result', async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async () => { controller.abort(); throw Error('cancelled'); };
    await assert.rejects(reviewScan(results, jobs, 50, controller.signal), (error) => error.name === 'AbortError');
  } finally { globalThis.fetch = previous; }
});

test('Rise/Fall carries actual direction, probability, horizon and quote evidence', () => {
  const result = { ...digit('R_50'), kind: 'rise-fall', lastEpoch: 123,
    best: { ...best, direction: 'FALL', winEstimate: 0.52, horizon: { value: 5, unit: 'ticks' } } };
  const evidence = buildAiEvidence([result], [{ kind: 'rise-fall', symbol: 'R_50', input: { ticks: [{ epoch: 123, quote: 50.1 }] } }]);
  assert.equal(evidence.candidates[0].family, 'rise-fall');
  assert.equal(evidence.candidates[0].label, 'FALL');
  assert.equal(evidence.candidates[0].probability, 0.52);
  assert.deepEqual(evidence.candidates[0].recentTicks, [{ epoch: 123, quote: 50.1 }]);
});
