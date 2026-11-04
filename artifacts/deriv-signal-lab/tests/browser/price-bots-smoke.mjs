// Mocked browser integration test. Start Signal Lab first, then run:
//   pnpm test:dbot:browser
// Deriv REST and WebSockets are intercepted; no real orders can be placed.
//
// The preset store this file used to exercise was removed with the old DBot
// Space builder (the workspace is now the cloned upstream app, and strategies
// reach the canvas through the AI copilot). What remains is the wiring that is
// still ours: the workspace boots in its iframe behind the shell, the Signal Lab
// tabs sit in its tab bar, and the PAT dialog connects the account.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const baseUrl = process.env.BROWSER_BASE_URL ?? 'http://127.0.0.1:18781/';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  args: process.env.BROWSER_LAUNCH_ARGS ? JSON.parse(process.env.BROWSER_LAUNCH_ARGS) : ['--no-sandbox', '--disable-dev-shm-usage'],
  headless: true,
});
const timers = [];
const errors = [];
const requests = [];

async function mockDeriv(page) {
  const authSockets = [];
  let dialogAction = 'accept';
  let holdProposals = false;
  const dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    void (dialogAction === 'dismiss' ? dialog.dismiss() : dialog.accept());
  });
  await page.addInitScript(() => {
    localStorage.setItem('signal-lab-trade-dock-collapsed', '1');
    localStorage.setItem('signal-lab-theme', 'dark');
    localStorage.setItem('dbot_settings', JSON.stringify({ bot_builder_token: 1, onboard_tour_token: 1 }));
    localStorage.setItem('signal-lab-test-preserve', 'local');
    sessionStorage.setItem('signal-lab-test-preserve', 'session');
    // Old standalone credentials must not be restored inside the embedded frame.
    sessionStorage.setItem('signal-lab-dbot-auth_info', JSON.stringify({ access_token: 'stale-token' }));
  });
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' };
  await page.route(/https:\/\/api\.derivws\.com\/trading\/v1\/options\/accounts/, async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 200, headers, body: '' });
    if (request.url().includes('/otp')) {
      const account = request.url().match(/accounts\/([^/]+)\/otp/)?.[1];
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ data: { url: `wss://api.derivws.com/trading/v1/options/ws/authenticated?account=${account}` } }) });
    }
    return route.fulfill({ status: 200, headers, body: JSON.stringify({ data: ['VRTC123456', 'VRTC222222'].map(account_id => ({ account_id, balance: '10000', currency: 'USD', group: 'demo', status: 'active', account_type: 'demo' })) }) });
  });
  const now = Math.floor(Date.now() / 1000);
  const prices = Array.from({ length: 1000 }, (_, i) => Number((100 + Math.sin(i / 8) + i / 1000).toFixed(2)));
  const times = prices.map((_, i) => now - 999 + i);
  let quote = 100;
  await page.routeWebSocket(/deriv(?:ws)?\.com/, socket => {
    const isAuth = socket.url().includes('/authenticated');
    const account = new URL(socket.url()).searchParams.get('account') ?? 'VRTC123456';
    if (isAuth) authSockets.push(socket);
    const send = data => socket.send(JSON.stringify(data));
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      requests.push(request);
      const key = Object.keys(request).find(item => !['req_id', 'subscribe', 'passthrough'].includes(item));
      const response = { msg_type: key, req_id: request.req_id, echo_req: request };
      if (key === 'time') response.time = Math.floor(Date.now() / 1000);
      else if (key === 'ping') response.ping = 'pong';
      else if (key === 'active_symbols') response.active_symbols = [{ symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index', submarket_display_name: 'Continuous Indices', pip: 0.01, delay_amount: 0, exchange_is_open: 1, is_trading_suspended: 0, symbol_type: 'stockindex' }, { symbol: 'stpRNG', display_name: 'Step 100 Index', market: 'synthetic_index', market_display_name: 'Derived', submarket: 'step_index', submarket_display_name: 'Step Indices', pip: 0.1, delay_amount: 0, exchange_is_open: 1, is_trading_suspended: 0, symbol_type: 'stockindex' }];
      else if (key === 'trading_times') response.trading_times = { markets: [{ name: 'Derived', submarkets: [{ name: 'Continuous Indices', symbols: [{ underlying_symbol: 'R_100', symbol: 'R_100', times: { open: ['00:00:00'], close: ['23:59:59'] } }] }] }] };
      else if (key === 'contracts_for') response.contracts_for = { available: ['CALL', 'PUT', 'TICKHIGH', 'TICKLOW', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER'].map(contract_type => ({ contract_type, contract_category: contract_type === 'CALL' || contract_type === 'PUT' ? 'callput' : contract_type.startsWith('TICK') ? 'highlowticks' : 'digits', contract_category_display: 'Up/Down', display_name: contract_type, market: 'synthetic_index', submarket: 'random_index', underlying_symbol: 'R_100', min_contract_duration: '1t', max_contract_duration: '10t' })) };
      else if (key === 'ticks_history') {
        response.history = { prices, times };
        response.pip_size = 2;
        response.subscription = { id: `sub-${request.req_id}` };
        if (request.subscribe) timers.push(setInterval(() => {
          quote += .05;
          try { send({ msg_type: 'tick', tick: { symbol: 'R_100', quote: Number(quote.toFixed(2)), epoch: Math.floor(Date.now() / 1000), pip_size: 2 }, subscription: { id: `sub-${request.req_id}` } }); } catch { /* closed test socket */ }
        }, 1000));
      } else if (key === 'balance' && isAuth) response.balance = { balance: 10000, currency: 'USD', loginid: account };
      else if (key === 'portfolio') response.portfolio = { contracts: [] };
      else if (key === 'profit_table') response.profit_table = { transactions: [] };
      else if (key === 'proposal_open_contract') response.proposal_open_contract = {};
      else if (key === 'transaction') response.transaction = {};
      else if (key === 'forget_all') response.forget_all = [];
      else if (key === 'proposal' && holdProposals) return;
      else if (key === 'proposal') {
        // A High/Low Tick quote is per selected_tick, and the v5 sniper buys the
        // position whose quote beats its probability. A realistic ladder is
        // therefore *deliberately overpaid* here: this is a wiring test (every
        // buy is rejected by the mock), not a market test, and a fair quote
        // would — correctly — leave the bot refusing to trade.
        const selected = Number(request.selected_tick);
        const payout = selected >= 1 && selected <= 5 ? 21 : 1.9;
        response.proposal = { id: 'mock', ask_price: 1, payout, spot: 100, date_start: now, selected_tick: selected || undefined };
      }
      else if (key === 'buy' || key === 'sell') response.error = { code: 'Blocked', message: 'Trading is blocked by the smoke test.' };
      else response[key] = {};
      send(response);
    });
  });
  return { authSockets, dialogs, setDialogAction: action => { dialogAction = action; }, holdProposals: () => { holdProposals = true; } };
}

async function openWorkspace(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  // The workspace is the app: no shell navigation, no tab to click first.
  await page.getByTestId('dbot-space').waitFor({ timeout: 60_000 });
  const bot = page.frames().find(frame => frame.url().includes('/dbot/'));
  assert.ok(bot, 'the bundled Deriv application must load in an iframe');
  await bot.getByText('Trade parameters', { exact: false }).first().waitFor({ timeout: 60_000 });
  return bot;
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await mockDeriv(page);
  const bot = await openWorkspace(page);

  // The Signal Lab tabs live in the workspace tab bar, next to Tutorials.
  assert.ok(await bot.locator('#id-tutorials').count(), 'Tutorials tab');
  assert.ok(await bot.locator('#id-signal-lab-history').count(), 'Trade history tab');
  assert.ok(await bot.locator('#id-signal-lab-settings').count(), 'Settings tab');

  // Settings tab → the shell docks the PAT panel under the tab bar.
  await bot.locator('#id-signal-lab-settings').click();
  await page.getByTestId('dbot-host-panel-settings').waitFor({ timeout: 20_000 });
  await page.getByTestId('deriv-pat-input').fill('test-only-token');
  await page.getByTestId('button-deriv-connect').click();
  await page.getByTestId('deriv-connection-status').getByText('Connected').first().waitFor({ timeout: 20_000 });

  // Connected: the workspace header shows the Demo/Real switch and the balance.
  await bot.locator('[data-testid="signal-lab-account-bar"]').waitFor({ timeout: 20_000 });
  assert.ok(await bot.locator('[data-testid="signal-lab-balance"]').count(), 'balance beside the toggle');

  // Back to the builder; the canvas is usable again.
  await page.getByTestId('dbot-host-panel-back').click();
  await bot.getByText('Trade parameters', { exact: false }).first().waitFor({ timeout: 20_000 });

  await page.close();
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('DBot smoke: workspace boots in its frame, Signal Lab tabs dock, PAT connect links the account.');
} finally {
  for (const timer of timers) clearInterval(timer);
  await browser.close();
}
