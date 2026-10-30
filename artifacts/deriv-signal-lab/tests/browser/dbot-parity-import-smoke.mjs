// Mocked browser integration test. Start Signal Lab first, then run:
//   pnpm test:parity:browser
// Deriv REST and WebSockets are intercepted; no real orders can be placed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
      else if (key === 'active_symbols') response.active_symbols = [{ symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index', market_display_name: 'Derived', submarket: 'random_index', submarket_display_name: 'Continuous Indices', pip: 0.01, delay_amount: 0, exchange_is_open: 1, is_trading_suspended: 0, symbol_type: 'stockindex' }];
      else if (key === 'trading_times') response.trading_times = { markets: [{ name: 'Derived', submarkets: [{ name: 'Continuous Indices', symbols: [{ underlying_symbol: 'R_100', symbol: 'R_100', times: { open: ['00:00:00'], close: ['23:59:59'] } }] }] }] };
      else if (key === 'contracts_for') response.contracts_for = { available: ['CALL', 'PUT', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER'].map(contract_type => ({ contract_type, contract_category: contract_type === 'CALL' || contract_type === 'PUT' ? 'callput' : 'digits', contract_category_display: 'Up/Down', display_name: contract_type, market: 'synthetic_index', submarket: 'random_index', underlying_symbol: 'R_100', min_contract_duration: '1t', max_contract_duration: '10t' })) };
      else if (key === 'ticks_history') {
        response.history = { prices, times };
        response.pip_size = 2;
        response.subscription = { id: `sub-${request.req_id}` };
        if (request.subscribe) timers.push(setInterval(() => {
          quote += .01;
          try { send({ msg_type: 'tick', tick: { symbol: 'R_100', quote: Number(quote.toFixed(2)), epoch: Math.floor(Date.now() / 1000), pip_size: 2 }, subscription: { id: `sub-${request.req_id}` } }); } catch { /* closed test socket */ }
        }, 1000));
      } else if (key === 'balance' && isAuth) response.balance = { balance: 10000, currency: 'USD', loginid: account };
      else if (key === 'portfolio') response.portfolio = { contracts: [] };
      else if (key === 'profit_table') response.profit_table = { transactions: [] };
      else if (key === 'proposal_open_contract') response.proposal_open_contract = {};
      else if (key === 'transaction') response.transaction = {};
      else if (key === 'forget_all') response.forget_all = [];
      else if (key === 'proposal' && holdProposals) return;
      else if (key === 'proposal') response.proposal = { id: 'mock', ask_price: 1, payout: 1.9, spot: 100, date_start: now };
      else if (key === 'buy' || key === 'sell') response.error = { code: 'Blocked', message: 'Trading is blocked by the smoke test.' };
      else response[key] = {};
      send(response);
    });
  });
  return { authSockets, dialogs, setDialogAction: action => { dialogAction = action; }, holdProposals: () => { holdProposals = true; } };
}

async function openWorkspace(page, mobile = false) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByTestId(mobile ? 'tab-dbot-space' : 'button-dbot-space-nav').click();
  await page.getByTestId('dbot-workspace-status').getByText('Workspace ready').waitFor({ timeout: 60_000 });
  const bot = page.frames().find(frame => frame.url().includes('/dbot/'));
  assert.ok(bot, 'the bundled Deriv application must load in an iframe');
  await bot.getByText('Trade parameters', { exact: false }).first().waitFor({ timeout: 20_000 });
  return bot;
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await mockDeriv(page);
  const bot = await openWorkspace(page);
  // Load the shipped Even/Odd strategy through the real store bridge and
  // DBot importer. A registry-only or XML text test cannot catch jsonInit
  // errors or missing IF/ELSE mutations that silently discard a buy branch.
  const parityXml = await readFile(new URL('../../src/lib/bot-store/bots/ai-even-switcher.xml', import.meta.url), 'utf8');
  const parityRegistry = await bot.evaluate(xml => {
    const root = new DOMParser().parseFromString(xml, 'application/xml');
    const types = [...new Set([...root.querySelectorAll('block')].map(block => block.getAttribute('type')))];
    return types.filter(type => !window.Blockly.Blocks[type]);
  }, parityXml);
  assert.deepEqual(parityRegistry, [], 'every preset block must be registered in the embedded workspace');
  await page.getByTestId('dbot-view-store').click();
  await page.getByTestId('dbot-use-AI_EVEN_SWITCHER').click();
  await page.getByTestId('dbot-notice').getByText(/AI Even\/Odd Switcher is on the canvas/i).waitFor({ timeout: 20_000 });
  const parityWorkspace = await bot.evaluate(xml => {
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    const expected = [...document.querySelectorAll('block')];
    const workspace = window.Blockly.derivWorkspace;
    const discrepancies = [];
    for (const node of expected) {
      const id = node.getAttribute('id');
      const block = workspace.getBlockById(id);
      if (!block) { discrepancies.push(`${id}: missing`); continue; }
      let parent = node.parentElement;
      while (parent && parent.tagName.toLowerCase() !== 'block') parent = parent.parentElement;
      const expectedParent = parent?.getAttribute('id') ?? null;
      if ((block.getParent()?.id ?? null) !== expectedParent) discrepancies.push(`${id}: disconnected`);
    }
    const blocks = workspace.getAllBlocks(false);
    const decisions = blocks.filter(block => block.type === 'x_parity_decision');
    const purchases = blocks.filter(block => block.type === 'purchase');
    const custom = [...new Set(expected.map(node => node.getAttribute('type')).filter(type => type.startsWith('x_')))];
    return {
      expected: expected.length,
      actual: blocks.length,
      discrepancies,
      missingGenerators: custom.filter(type => !window.Blockly.JavaScript.javascriptGenerator.forBlock[type]),
      sides: purchases.map(block => block.getFieldValue('PURCHASE_LIST')).sort(),
      decisionModes: decisions.map(block => block.getFieldValue('REQUIRE')),
      decisionCode: decisions.map(block => window.Blockly.JavaScript.javascriptGenerator.blockToCode(block)[0]),
      parts: blocks.filter(block => block.type === 'x_parity_decision_part').map(block => block.getFieldValue('PART')),
      beforeCode: window.Blockly.JavaScript.javascriptGenerator.blockToCode(blocks.find(block => block.type === 'before_purchase')),
    };
  }, parityXml);
  assert.equal(parityWorkspace.actual, parityWorkspace.expected, 'all preset blocks must survive import');
  assert.deepEqual(parityWorkspace.discrepancies, [], 'every preset block must remain connected to its original parent');
  assert.deepEqual(parityWorkspace.missingGenerators, [], 'custom blocks must have code generators');
  assert.deepEqual(parityWorkspace.sides, ['DIGITEVEN', 'DIGITODD']);
  assert.deepEqual(parityWorkspace.decisionModes, ['edge', 'edge']);
  for (const code of parityWorkspace.decisionCode) assert.match(code, /Bot\.parityDecision\(.*"edge"/);
  assert.ok(parityWorkspace.parts.includes('payout-live'), 'the fresh-quote gate must survive import');
  assert.match(parityWorkspace.beforeCode, /Bot\.purchase\('DIGITEVEN'\)/);
  assert.match(parityWorkspace.beforeCode, /Bot\.purchase\('DIGITODD'\)/);
  assert.match(parityWorkspace.beforeCode, /Bot\.parityRisk\(/);
  assert.equal(requests.some(request => request.buy || request.sell), false, 'loading a bot must never place an order');

  assert.deepEqual(errors, [], 'loading the preset must not cause uncaught browser errors');
  console.log('Even/Odd store import passed: all blocks, connections, generators, both sides and gates survived.');
} finally {
  for (const timer of timers) clearInterval(timer);
  await browser.close();
}
