// Start Signal Lab first. All Deriv sockets are mocked; no real trades are placed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const timers = [];
const requests = [];
await page.routeWebSocket(/deriv(?:ws)?\.com/, socket => {
  socket.onMessage(raw => {
    const request = JSON.parse(String(raw));
    requests.push(request);
    const send = data => socket.send(JSON.stringify({ req_id: request.req_id, echo_req: request, ...data }));
    const now = Math.floor(Date.now() / 1000);
    if (request.time) send({ msg_type: 'time', time: now });
    else if (request.active_symbols) send({ msg_type: 'active_symbols', active_symbols: [{ symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index', submarket: 'random_index', pip: 0.01, exchange_is_open: 1, is_trading_suspended: 0 }] });
    else if (request.ticks_history) {
      const symbol = request.ticks_history;
      send({ msg_type: 'history', history: { prices: Array.from({ length: 100 }, (_, i) => i % 2 ? 100.13 : 100.12), times: Array.from({ length: 100 }, (_, i) => now - 100 + i) }, pip_size: 2, subscription: { id: `sub-${symbol}` } });
      if (request.subscribe) timers.push(setInterval(() => send({ msg_type: 'tick', tick: { symbol, quote: 100.12, epoch: Math.floor(Date.now() / 1000), pip_size: 2 } }), 500));
    } else if (request.contracts_for) send({ msg_type: 'contracts_for', contracts_for: { available: [] } });
    else if (request.ping) send({ msg_type: 'ping', ping: 'pong' });
  });
});
try {
  await page.goto(process.env.BROWSER_BASE_URL || 'http://127.0.0.1:18781/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('button-dbot-space-nav').click();
  await page.locator('[data-testid="dbot-frame"]').evaluate(frame => { window.__testFrame = frame; });
  await page.getByTestId('dbot-view-tools').click();
  const desk = page.getByTestId('dbot-market-tools');
  await desk.waitFor();
  await page.getByTestId('dbot-market-R_100').getByText('Live', { exact: true }).waitFor({ timeout: 15000 });
  assert.match(await page.getByTestId('dbot-digit-detail').innerText(), /100 verified of 100 ticks/);
  assert.match(await desk.innerText(), /51\.28%/);
  await desk.getByLabel('Consecutive losses').fill('2');
  assert.match(await desk.innerText(), /Total simulated loss\s+3/);
  await desk.getByLabel('Initial stake').fill('');
  await page.getByRole('alert').getByText(/Enter positive balance/).waitFor();
  await page.getByTestId('dbot-view-builder').click();
  assert.equal(await page.locator('[data-testid="dbot-frame"]').evaluate(frame => frame === window.__testFrame), true, 'switching views must not reload the bot iframe');
  assert.equal(requests.some(request => request.buy || request.sell), false, 'monitoring and calculator must not place orders');
  console.log('DBot Digits & risk smoke passed; iframe preserved and no orders sent.');
} finally {
  timers.forEach(clearInterval);
  await browser.close();
}
