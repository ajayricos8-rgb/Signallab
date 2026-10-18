// Browser regression with a mocked PUBLIC market-data socket. No account,
// credentials, proposal or purchase is used. Start pnpm dev before this script.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const baseUrl = process.env.BROWSER_BASE_URL ?? 'http://127.0.0.1:18781/';
const screenshotDirectory = process.env.BROWSER_SCREENSHOT_DIR;
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
  await page.getByTestId('rise-fall-scope-select').locator('option[value="R_100"]').waitFor({ state: 'attached' });
  // The catalog works even before there is a finished analysis.
  await page.getByTestId('engine-search').fill('#300');
  assert.equal(await page.getByTestId('engine-300').isVisible(), true);
  await page.getByTestId('engine-search').fill('');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await page.getByTestId('engine-16').isVisible(), true);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();

  for (const family of ['matches', 'over-under', 'even-odd', 'rise-fall']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByTestId(`tools-mini-tab-${family}`).click();
    const started = Date.now();
    await page.getByTestId('button-run-analysis').click();
    await page.getByTestId('export-engine-audit').waitFor({ timeout: 90_000 });
    const downloaded = page.waitForEvent('download');
    await page.getByTestId('export-engine-audit').click();
    const download = await downloaded;
    const audit = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(audit.family, family);
    assert.equal(audit.readings.length, 300);
    assert.equal(audit.definitions.length, 300);
    assert.equal(Object.values(audit.counts).reduce((sum, count) => sum + count, 0), 300);
    assert.ok(audit.sample.digits > 0 && audit.sample.quotes > 0);
    assert.equal(audit.readings[264].status, 'unavailable');
    assert.equal(audit.counts.alias, 2);
    assert.ok(audit.research.rows.every((row, index) => !index || row.origin >= audit.research.rows[index - 1].exit));

    const alternate = audit.symbol === 'R_100' ? 'R_10' : 'R_100';
    await page.getByTestId(`ranking-row-${alternate}`).click();
    const alternateDownloaded = page.waitForEvent('download');
    await page.getByTestId('export-engine-audit').click();
    const alternateDownload = await alternateDownloaded;
    const alternateAudit = JSON.parse(await readFile(await alternateDownload.path(), 'utf8'));
    assert.equal(alternateAudit.symbol, alternate, 'inspector/export must follow the selected market');
    assert.equal(alternateAudit.readings.length, 300);
    await page.getByTestId(`ranking-row-${audit.symbol}`).click();

    await page.getByTestId('engine-category').selectOption('Backtesting & Performance');
    await page.getByTestId('engine-search').fill('265');
    await page.getByTestId('engine-265').locator('summary').first().click();
    assert.match(await page.getByTestId('engine-265').innerText(), /No actual settled/);
    await page.getByTestId('engine-search').fill('');
    await page.getByTestId('engine-category').selectOption('all');
    await page.getByTestId('engine-status').selectOption('alias');
    assert.equal(await page.getByTestId('engine-166').isVisible(), true);
    assert.equal(await page.getByTestId('engine-228').isVisible(), true);
    await page.getByTestId('engine-status').selectOption('all');

    // Load and Run is a real button: the research gates are advice, never a veto.
    assert.equal(await page.getByTestId(`button-load-and-run-${family}`).isEnabled(), true, `${family} Load and Run must be usable after an analysis`);
    assert.equal(await page.getByTestId(`button-load-and-run-${family}`).innerText(), 'Load and Run');
    if (await page.getByTestId('trade-dock-body').isVisible()) await page.getByTestId('trade-dock-toggle').click();
    await page.getByText('Model weights, contribution and held-out performance', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('engine-search').fill('142');
    await page.getByTestId('engine-142').locator('summary').first().click();
    await page.getByTestId('engine-search').fill('287');
    await page.getByTestId('engine-287').locator('summary').first().click();
    await page.getByTestId('engine-287').getByText('Inspect values / matrix', { exact: true }).click();
    await page.getByTestId('engine-search').scrollIntoViewIfNeeded();
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.equal(widths.document, widths.viewport, `${family} mobile horizontal page overflow`);
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: `${screenshotDirectory}/${family}-mobile.png` });
    }
    await page.getByTestId('engine-search').fill('');
    console.log(`${family}: 300 entries, worker result, market switching, exports, filters, matrix and mobile layout passed (${Date.now() - started}ms).`);
  }
  assert.ok(workers > 0, 'production Web Worker path must be exercised');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  assert.deepEqual(tradingRequests, [], 'test must never quote or purchase a trade');
  console.log('All four tool smoke checks passed. No trading requests were made.');
} finally {
  for (const timer of timers) clearInterval(timer);
  await browser.close();
}
