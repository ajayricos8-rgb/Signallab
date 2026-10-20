// OpenRouter browser regression. Public Deriv data and AI inference are mocked;
// the initial Settings check uses the real API. No accounts or orders are used.
import assert from 'node:assert/strict';

import { chromium } from 'playwright-core';
import { reviewRequestSchema } from '../../../api-server/src/lib/openrouter.ts';

const baseUrl = process.env.BROWSER_BASE_URL ?? 'http://127.0.0.1:18781/';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  args: process.env.BROWSER_LAUNCH_ARGS ? JSON.parse(process.env.BROWSER_LAUNCH_ARGS) : ['--no-sandbox', '--disable-dev-shm-usage'],
  headless: true,
});
const timers = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  const tradingRequests = [];
  let reviews = 0;
  let forceFailure = false;
  await page.route('**/api/openrouter/analyze', async (route) => {
    const input = route.request().postDataJSON();
    reviewRequestSchema.parse(input);
    reviews++;
    assert.ok(input.candidates.length > 0);
    const candidate = input.candidates.at(-1);
    assert.ok(candidate.votes.length >= 12);
    assert.ok(candidate.recentTicks.length > 0);
    assert.ok(candidate.entry.validForTicks >= 1);
    assert.equal(input.token, undefined);
    if (forceFailure) return route.fulfill({ status: 429, json: { error: 'Free model quota reached.' } });
    await route.fulfill({ json: {
      candidateId: candidate.id, model: 'browser-test/model:free', reviewedAt: Date.now(), stance: 'caution',
      analysis: `Engine-calculation review for ${candidate.family}. No certified edge.`,
      prediction: 'Uncertain outlook over the next 12 ticks.', entry: candidate.entry.instruction,
      risks: ['Random streams may have no predictable edge.'], horizonTicks: 12,
    } });
  });
  let workers = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', () => { workers += 1; });
  await page.addInitScript(() => localStorage.setItem('signal-lab-trade-dock-collapsed', '1'));

  // Fixed seed, independently chosen from model results. Never shipped to the app.
  let state = 17;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const symbols = ['R_10', 'R_100'];
  const streams = new Map(symbols.map((symbol) => {
    let quote = 100;
    const prices = Array.from({ length: 2000 }, () => { quote += random() - 0.5; return quote.toFixed(2); });
    const end = Math.floor(Date.now() / 1000);
    return [symbol, { prices, times: prices.map((_, index) => end - 1999 + index), quote, end }];
  }));
  await page.routeWebSocket(/api\.derivws\.com/, (socket) => {
    const send = (message) => socket.send(JSON.stringify(message));
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (request.time) {
        send({ msg_type: 'time', req_id: request.req_id, time: Math.floor(Date.now() / 1000) });
      } else if (request.active_symbols) {
        send({ msg_type: 'active_symbols', req_id: request.req_id, active_symbols: symbols.map((symbol) => ({
          symbol, display_name: `Volatility ${symbol.slice(2)} Index`, market: 'synthetic_index', pip: 0.01, exchange_is_open: 1, is_trading_suspended: 0,
        })) });
      } else if (request.ticks_history) {
        const symbol = request.ticks_history;
        const stream = streams.get(symbol);
        assert.ok(stream, 'unexpected requested symbol');
        send({ msg_type: 'history', req_id: request.req_id, pip_size: 2, echo_req: request, history: { prices: stream.prices, times: stream.times } });
        send({ msg_type: 'tick', tick: { symbol, quote: stream.prices.at(-1), epoch: stream.end, pip_size: 2 } });
        timers.push(setInterval(() => {
          stream.quote += random() - 0.5;
          stream.end = Math.floor(Date.now() / 1000);
          send({ msg_type: 'tick', tick: { symbol, quote: stream.quote.toFixed(2), epoch: stream.end, pip_size: 2 } });
        }, 1000));
      } else if (request.contracts_for) {
        send({ msg_type: 'contracts_for', req_id: request.req_id, echo_req: request, contracts_for: {
          available: ['CALL', 'PUT', 'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH'].map((contract_type) => ({
            contract_type, expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t',
          })),
        } });
      } else if (request.proposal || request.buy) {
        tradingRequests.push(request);
      } else if (request.ping) send({ msg_type: 'ping', ping: 'pong' });
    });
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByTestId('button-settings-nav').click();
  const connection = page.getByTestId('openrouter-connection');
  const expectLive = process.env.BROWSER_EXPECT_LIVE_OPENROUTER === '1';
  await connection.getByText(expectLive ? 'Connected' : 'Unavailable', { exact: true }).waitFor({ timeout: 25_000 });
  // The Settings card now has an API-key input for saving the server key; it must never be pre-filled with a secret,
  // and the stored key is shown only as a masked value.
  const keyInput = connection.getByTestId('openrouter-key-input');
  assert.ok((await keyInput.count()) <= 1, 'at most one API-key input should exist');
  if (await keyInput.count() === 1) {
    assert.equal(await keyInput.inputValue(), '', 'API-key input must not be pre-filled with a secret');
    assert.match(await keyInput.getAttribute('placeholder') ?? '', /sk-or-v1/);
  }
  if (connection.locator('[data-testid=\"openrouter-clear-key\"]').count) {
    // Ensure no raw secret leaks in the visible connection text
    const text = await connection.innerText();
    assert.equal(text.includes('sk-or-v1-'), false, 'Raw key must never appear in the UI');
  }
  if (!expectLive) assert.match(await connection.innerText(), /could not be reached|No OpenRouter key/);
  await page.route('**/api/openrouter/status*', (route) => route.fulfill({ json: {
    status: 'connected', configured: true, message: 'Server key verified.', freeModels: 3, checkedAt: Date.now(),
    keySource: 'stored', maskedKey: 'sk-or-v1••••••••', canClearStored: true, envConfigured: false,
  } }));
  await page.getByTestId('openrouter-refresh').click();
  await connection.getByText('Connected', { exact: true }).waitFor();
  assert.match(await connection.innerText(), /3 free models/);
  await page.getByTestId('button-dashboard-nav').click();
  for (const family of ['matches', 'over-under', 'even-odd', 'rise-fall']) {
    await page.getByTestId(`tools-mini-tab-${family}`).click();
    await page.getByTestId('button-run-analysis').click();
    await page.getByTestId('openrouter-review').waitFor({ timeout: 120_000 });
    const card = page.getByTestId('openrouter-review');
    assert.match(await card.innerText(), /browser-test\/model:free/);
    assert.match(await card.innerText(), new RegExp(`Engine-calculation review for ${family}`));
    assert.match(await card.innerText(), /Engine-measured validity/);
    console.log(`PASS ${family}: external AI review combines engines, prediction and entry`);
  }
  forceFailure = true;
  await page.getByTestId('button-run-analysis').click();
  await page.getByTestId('openrouter-review-unavailable').waitFor({ timeout: 120_000 });
  assert.match(await page.getByTestId('openrouter-review-unavailable').innerText(), /Engine-only result/);
  assert.equal(await page.getByTestId('master-decision').count(), 1);
  assert.equal(reviews, 5);
  assert.deepEqual(errors, []);
  assert.deepEqual(tradingRequests, []);
  console.log('PASS Settings connection states, quota fallback, all four tools; no orders and no browser errors');
} finally {
  for (const timer of timers) clearInterval(timer);
  await browser.close();
}
