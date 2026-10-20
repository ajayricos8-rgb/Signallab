import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterService, reviewRequestSchema } from '../src/lib/openrouter.ts';

const SECRET = 'test-private-key-not-a-real-key';
const model = (id, prompt = '0', completion = '0') => ({ id, pricing: { prompt, completion }, architecture: { output_modalities: ['text'] } });
const catalog = { data: [model('paid/model', '1', '1'), model('mislabelled:free', '1'), model('a/model:free'), model('b/model:free')] };
const decision = {
  candidateId: 'candidate-0', stance: 'caution', analysis: 'No measured predictive edge; engine votes conflict.',
  prediction: 'Random digit outcomes remain uncertain across the next 12 ticks.',
  entry: 'Use the measured trigger only inside its existing window.', risks: ['No guaranteed outcome.'], horizonTicks: 12,
};
const input = { candidates: [{
  id: 'candidate-0', symbol: 'R_100', family: 'even-odd', label: 'EVEN', horizon: '5 ticks',
  probability: 0.5, fairProbability: 0.5, confidence: 40, fresh: true, lastEpoch: 1_700_000_000, sample: 1000,
  votes: [{ label: 'Markov', probability: 0.5, weight: 1 }], confirmation: 'cautious', edgeZ: 0,
  backtest: { sample: 100, rate: 0.5 }, research: 'No edge', analysisState: 'Random', localSynthesis: 'Cautious',
  entry: { mode: 'immediate', instruction: 'next tick', windowTicks: 5, validForTicks: 1, validation: 'no timing gain',
    priceLevel: null, priceCondition: null, contextDigits: null, contextLabel: null, trigger: 'none', reachRate: null, confidence: 40 },
  recentTicks: [{ epoch: 1_700_000_000, digit: 2 }],
}] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function harness(handler, pick = () => 0) {
  const calls = [];
  const service = new OpenRouterService(() => SECRET, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return json(catalog);
    if (url.endsWith('/key')) return json({ data: { label: SECRET } });
    return handler(url, options, calls);
  }, pick);
  return { service, calls };
}

test('unconfigured status does not call network or expose configuration secrets', async () => {
  const service = new OpenRouterService(() => undefined, () => { throw Error('must not run'); });
  assert.equal((await service.status()).status, 'not_configured');
  await assert.rejects(service.review(input), /not configured/);
});

test('connection authenticates, filters zero-cost :free text models, caches safely', async () => {
  const { service, calls } = harness(() => json({}));
  const status = await service.status();
  assert.equal(status.status, 'connected');
  assert.equal(status.freeModels, 2);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  await service.status();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${SECRET}`);
});

test('random free model is actually invoked with evidence and zero paid fallback budget', async () => {
  const { service, calls } = harness(() => json({ choices: [{ message: { content: JSON.stringify(decision) } }] }), (max) => max - 1);
  const review = await service.review(reviewRequestSchema.parse(input));
  assert.equal(review.model, 'b/model:free');
  assert.equal(review.horizonTicks, 12);
  assert.equal(JSON.stringify(review).includes(SECRET), false);
  const request = JSON.parse(calls.at(-1).options.body);
  assert.equal(request.model, review.model);
  assert.deepEqual(request.provider.max_price, { prompt: 0, completion: 0 });
  assert.equal(request.provider.data_collection, 'deny');
  assert.deepEqual(JSON.parse(request.messages[1].content), input);
  assert.match(request.messages[0].content, /must NOT extend measured validity/);
});

test('busy provider retries a DIFFERENT free model, no paid models used', async () => {
  let attempts = 0;
  const { service, calls } = harness(() => ++attempts === 1
    ? json({ error: { message: 'provider quota' } }, 429)
    : json({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(decision)}\n\`\`\`` } }] }));
  assert.equal((await service.review(input)).model, 'b/model:free');
  const models = calls.filter((call) => call.url.endsWith('/chat/completions')).map((call) => JSON.parse(call.options.body).model);
  assert.deepEqual(models, ['a/model:free', 'b/model:free']);
});

test('auth errors redact provider bodies and do not retry', async () => {
  const { service, calls } = harness(() => json({ error: { message: SECRET } }, 401));
  await assert.rejects(service.review(input), (error) => {
    assert.match(error.message, /authentication/);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  assert.equal(calls.filter((call) => call.url.endsWith('/chat/completions')).length, 1);
});

test('unreachable provider produces truthful unavailable status, not connected', async () => {
  const service = new OpenRouterService(() => SECRET, async () => { throw Error(`network debug ${SECRET}`); });
  const status = await service.status();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});

test('malformed, hallucinated candidates, wrong horizon and embedded errors are rejected', async () => {
  for (const payload of [
    { choices: [{ message: { content: 'not json' } }] },
    { choices: [{ message: { content: JSON.stringify({ ...decision, candidateId: 'made-up' }) } }] },
    { choices: [{ message: { content: JSON.stringify({ ...decision, horizonTicks: 500 }) } }] },
    { error: { message: SECRET } },
    { choices: [{ message: { content: null } }] },
  ]) {
    const { service } = harness(() => json(payload));
    await assert.rejects(service.review(input), (error) => !error.message.includes(SECRET));
  }
});

test('missing free models never falls back to paid model', async () => {
  const service = new OpenRouterService(() => SECRET, async () => json({ data: [model('paid', '1', '1')] }));
  await assert.rejects(service.review(input), /No free text models/);
});

test('schema bounds payload size, disallows NaN and strips unknown private fields', () => {
  assert.equal(reviewRequestSchema.safeParse({ candidates: [] }).success, false);
  assert.equal(reviewRequestSchema.safeParse({ candidates: Array(21).fill(input.candidates[0]) }).success, false);
  assert.equal(reviewRequestSchema.safeParse({ candidates: [{ ...input.candidates[0], probability: NaN }] }).success, false);
  const parsed = reviewRequestSchema.parse({ ...input, token: SECRET, candidates: [{ ...input.candidates[0], account: SECRET }] });
  assert.equal(JSON.stringify(parsed).includes(SECRET), false);
});

test('global quota caps protect shared server key', async () => {
  const { service } = harness(() => json({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  for (let i = 0; i < 12; i++) await service.review(input);
  await assert.rejects(service.review(input), (error) => error.code === 429);
});

test('caller cancellation prevents an analysis request', async () => {
  const controller = new AbortController();
  controller.abort();
  const { service, calls } = harness(() => { throw Error('must not call model'); });
  await assert.rejects(service.review(input, controller.signal));
  assert.equal(calls.filter((call) => call.url.endsWith('/chat/completions')).length, 0);
});
