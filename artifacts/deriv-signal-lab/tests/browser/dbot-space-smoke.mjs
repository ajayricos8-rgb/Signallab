// Mocked browser integration test. Start Signal Lab first, then run:
//   pnpm test:dbot:browser
// Deriv REST and WebSockets are intercepted; no real orders can be placed.
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

async function loadPreset(page, bot, strategy = 'D_ALEMBERT') {
  await page.getByTestId('dbot-view-store').click();
  await page.getByTestId(`dbot-use-${strategy}`).click();
  await bot.getByText('Quick strategy', { exact: false }).first().waitFor({ timeout: 20_000 });
  await bot.locator('input[name=profit]').fill('10');
  await bot.locator('input[name=loss]').fill('10');
  await bot.getByTestId('qs-load-button').click();
  await bot.getByTestId('qs-load-button').waitFor({ state: 'hidden', timeout: 20_000 });
  await page.waitForTimeout(500);
  const count = await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length);
  assert.ok(count > 20, 'the preset must load its real strategy blocks');
}

try {
  // Tablet-sized iframe exercises the native mobile/tablet wizard layout.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const mock = await mockDeriv(page);
  const bot = await openWorkspace(page);

  // The draggable AI launcher is wired to the live Blockly catalog. Build and
  // load generated XML into the real workspace, then verify the custom gate
  // and generated risk procedure survive Blockly's XML importer.
  await page.getByTestId('dbot-ai-launcher').click();
  await page.getByTestId('dbot-ai-panel').waitFor();
  await page.getByTestId('dbot-ai-registry-status').getByText('READY', { exact: true }).waitFor({ timeout: 20_000 });
  const aiRegistry = await bot.evaluate(() => ({
    gate: Boolean(window.Blockly.Blocks.signal_lab_analysis_gate),
    gateGenerator: Boolean(window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_analysis_gate),
    vision: Boolean(window.Blockly.Blocks.vision_analyse && window.Blockly.JavaScript.javascriptGenerator.forBlock.vision_analyse),
  }));
  assert.deepEqual(aiRegistry, { gate: true, gateGenerator: true, vision: true }, 'AI and Signal Lab blocks need both definitions and generators registered');
  await page.getByTestId('dbot-ai-chat-input').fill('Build a fall bot on R_100 with stake 0.5, currency is USD, 2 ticks, max 3 trades, stop loss 4, profit target 6, and create a block called "Scan Guard".');
  await page.getByTestId('dbot-ai-chat-send').click();
  await page.getByTestId('dbot-ai-built-strategy').waitFor();
  await page.getByTestId('dbot-ai-load-strategy').click();
  await page.getByTestId('dbot-notice').getByText(/is on the canvas/i).waitFor({ timeout: 20_000 });
  const generatedWorkspace = await bot.evaluate(() => {
    const workspace = window.Blockly.derivWorkspace;
    const blocks = workspace.getAllBlocks(false);
    const gate = blocks.find(block => block.type === 'signal_lab_analysis_gate');
    return {
      types: blocks.map(block => block.type),
      gateFields: gate ? {
        family: gate.getFieldValue('FAMILY'),
        symbol: gate.getFieldValue('SYMBOL'),
        contractType: gate.getFieldValue('CONTRACT_TYPE'),
        barrier: String(gate.getFieldValue('BARRIER')),
        targetDigit: String(gate.getFieldValue('TARGET_DIGIT')),
      } : null,
      gateCode: gate ? window.Blockly.JavaScript.javascriptGenerator.blockToCode(gate)[0] : '',
    };
  });
  for (const type of ['signal_lab_analysis_gate', 'procedures_defreturn', 'procedures_callreturn', 'total_profit', 'total_runs', 'purchase']) {
    assert.ok(generatedWorkspace.types.includes(type), `generated Blockly XML must load registered block ${type}`);
  }
  assert.deepEqual(generatedWorkspace.gateFields, {
    family: 'rise-fall', symbol: 'R_100', contractType: 'PUT', barrier: '0', targetDigit: '0',
  });
  assert.match(generatedWorkspace.gateCode, /Bot\.getSignalLabAnalysisGate\("rise-fall", "R_100", "", "PUT", 0, 0\)/);
  assert.equal(requests.some(request => request.buy || request.sell), false, 'loading AI blocks must never place an order');
  await page.getByTestId('dbot-ai-tab-analysis').click();
  const analysisFamilies = await page.getByTestId('dbot-ai-family-select').locator('option').evaluateAll(options => options.map(option => option.value));
  assert.deepEqual(analysisFamilies, ['rise-fall', 'over-under', 'even-odd', 'matches']);
  await page.getByTestId('dbot-ai-family-select').selectOption('matches');
  assert.equal(await page.getByTestId('dbot-ai-duration').isVisible(), true, 'digit families expose contract expiry controls');
  await page.getByTestId('dbot-ai-family-select').selectOption('rise-fall');
  await page.getByTestId('dbot-ai-run-analysis').click();
  await page.getByTestId('dbot-ai-best-market').waitFor({ timeout: 90_000 });
  assert.match(await page.getByTestId('dbot-ai-best-market').innerText(), /R_100/);
  assert.equal(await page.getByTestId('dbot-ai-market-ranking').isVisible(), true, 'AI Analysis must rank the markets returned by its family engine');
  await page.getByTestId('dbot-ai-close').click();

  const initial = await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length);
  assert.ok(initial >= 4, 'starter or generated blocks must be present');
  assert.equal(await bot.evaluate(() => sessionStorage.getItem('signal-lab-dbot-auth_info')), null);
  assert.equal(mock.authSockets.length, 0, 'stale standalone auth must not reconnect automatically');

  await bot.getByText('Utility', { exact: true }).click();
  await bot.getByText('Logic', { exact: true }).click();
  const flyout = bot.locator('.flyout [data-testid=flyout-block-workspace] .blocklyDraggable').first();
  await flyout.waitFor();
  const from = await flyout.boundingBox();
  const canvas = await bot.locator('#scratch_div > .injectionDiv').boundingBox();
  assert.ok(from && canvas);
  await page.mouse.move(from.x + 30, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width - 100, canvas.y + canvas.height - 160, { steps: 25 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dragged = await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length);
  assert.ok(dragged > initial, 'dragging a Blockly flyout block must add it to the workspace');

  await page.getByTestId('dbot-view-store').click();
  await page.getByTestId('dbot-store-search').fill('reverse');
  assert.equal(await page.locator('[data-testid^="dbot-strategy-"]').count(), 2);
  await page.getByTestId('dbot-store-search').fill('');
  await page.getByTestId('dbot-use-D_ALEMBERT').click();
  await bot.getByTestId('qs-load-button').waitFor();
  assert.match(await bot.locator('.quick-strategy__wrapper').innerText(), /D.Alembert/i);

  // Cancelling navigation preserves the wizard and its unsaved inputs.
  mock.setDialogAction('dismiss');
  await page.getByTestId('dbot-view-chart').click();
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId('dbot-view-builder').getAttribute('aria-selected'), 'true');
  assert.equal(await bot.getByTestId('qs-load-button').isVisible(), true);
  mock.setDialogAction('accept');
  await bot.locator('input[name=profit]').fill('10');
  await bot.locator('input[name=loss]').fill('10');
  await bot.getByTestId('qs-load-button').click();
  await bot.getByTestId('qs-load-button').waitFor({ state: 'hidden', timeout: 20_000 });
  await page.waitForTimeout(500);
  const loaded = await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length);
  assert.ok(loaded > 20, 'Load should populate the workspace without running it');
  assert.ok(mock.dialogs.some(message => /replaces the blocks/i.test(message)));

  await page.getByTestId('button-dashboard-nav').click();
  await page.getByTestId('button-dbot-space-nav').click();
  assert.equal(await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length), loaded, 'switching app tabs must not reload the iframe');

  await page.getByTestId('dbot-view-chart').click();
  await bot.locator('canvas:visible').first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  assert.ok(await bot.locator('canvas:visible').count() >= 2, 'the chart must render its canvases');
  assert.ok(requests.some(request => request.ticks_history && request.subscribe), 'chart should subscribe to tick updates');
  const manifest = await page.request.get(new URL('dbot/assets/FontManifest.json', baseUrl).href);
  assert.match(manifest.headers()['content-type'], /json/);
  await page.getByTestId('dbot-view-builder').click();

  await page.getByTestId('button-settings-nav').click();
  await page.getByTestId('deriv-pat-input').fill('test-only-token');
  await page.getByTestId('button-deriv-connect').click();
  await page.getByTestId('deriv-connection-status').getByText('Connected').first().waitFor({ timeout: 20_000 });
  await page.getByTestId('button-dbot-space-nav').click();
  // No click: opening the space after connecting must link the account itself.
  await page.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC123456/).waitFor({ timeout: 30_000 });
  assert.ok(mock.authSockets.length >= 2, 'the parent and DBot must use separate authenticated sockets');
  assert.equal(await bot.evaluate(() => sessionStorage.getItem('signal-lab-dbot-auth_info')), null, 'the bridge must not copy the PAT into vendor auth storage');

  // Signal Lab's ticks and account are shared with the workspace, and the
  // Signal Lab block group is registered and generates the runtime calls.
  await page.getByTestId('dbot-shared-data').getByText(/markets · [0-9,]+ ticks shared/).waitFor({ timeout: 20_000 });
  const bridge = await bot.evaluate(() => {
    const types = ['signal_lab_last_tick', 'signal_lab_ticks', 'signal_lab_last_digit', 'signal_lab_tick_change', 'signal_lab_balance', 'signal_lab_open_positions', 'signal_lab_profit', 'signal_lab_account', 'signal_lab_connected'];
    const missing = types.filter(type => !window.Blockly.Blocks[type]);
    const block = window.Blockly.derivWorkspace.newBlock('signal_lab_last_tick');
    const markets = block.getField('MARKET_LIST').getOptions(true).map(option => option[1]);
    const code = window.Blockly.JavaScript.javascriptGenerator.blockToCode(block)[0];
    block.dispose();
    return { missing, markets, code };
  });
  assert.deepEqual(bridge.missing, [], 'every Signal Lab block must be registered');
  // The mock advertises one symbol, so the dropdown proves the parent snapshot
  // replaced the static fallback list.
  assert.deepEqual(bridge.markets, ['R_100'], 'the market list must come from the Signal Lab snapshot');
  assert.equal(bridge.code, 'Bot.getSignalLabLastTick("R_100")', 'the block must call the Signal Lab runtime');

  // Hold mock quotes so the strategy can enter the running state without
  // issuing a buy, then verify socket loss immediately stops the interpreter.
  mock.holdProposals();
  await page.evaluate(() => window.scrollBy(0, Math.max(0, document.querySelector('[data-testid=dbot-frame]').getBoundingClientRect().bottom - window.innerHeight + 100)));
  await bot.locator('#db-animation__run-button:visible').last().click();
  await bot.locator('#db-animation__stop-button:visible').first().waitFor({ timeout: 10_000 });

  // A dropped child socket must stop the bot and the link must come back by
  // itself, without the user pressing anything.
  await mock.authSockets.at(-1).close({ code: 1000, reason: 'test-disconnect' });
  await bot.locator('#db-animation__stop-button:visible').first().waitFor({ state: 'hidden', timeout: 10_000 });
  await page.getByTestId('dbot-notice').getByText(/connection closed/i).waitFor({ timeout: 10_000 });
  await page.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC123456/).waitFor({ timeout: 30_000 });

  // A reload must not retain a stale authenticated state in the parent, and the
  // link is re-established automatically once the workspace is ready again.
  await bot.evaluate(() => window.location.reload());
  await page.getByTestId('dbot-notice').getByText(/reloaded/i).waitFor({ timeout: 20_000 });
  await page.getByTestId('dbot-workspace-status').getByText('Workspace ready').waitFor({ timeout: 60_000 });
  await page.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC123456/).waitFor({ timeout: 30_000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('signal-lab-test-preserve')), 'local');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('signal-lab-test-preserve')), 'session');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('signal-lab-deriv-pat')), 'test-only-token');

  // Switching the Signal Lab account moves the link with it, again by itself.
  await page.getByTestId('button-settings-nav').click();
  await page.getByTestId('deriv-account-select').selectOption('VRTC222222');
  await page.getByTestId('deriv-connection-status').getByText('Connected').first().waitFor({ timeout: 20_000 });
  await page.getByTestId('button-dbot-space-nav').click();
  await page.getByTestId('dbot-notice').getByText(/changed or disconnected/i).waitFor({ timeout: 10_000 });
  await page.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC222222/).waitFor({ timeout: 30_000 });
  // Unlinking is the one manual action; it pauses automatic linking.
  await page.getByTestId('dbot-disconnect-account').click();
  await page.getByTestId('dbot-account-status').getByText('Linking paused').waitFor();
  await page.waitForTimeout(2_000);
  assert.match(await page.getByTestId('dbot-account-status').innerText(), /Linking paused/, 'a paused link must not reconnect itself');
  await page.getByTestId('dbot-connect-account').click();
  await page.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC222222/).waitFor({ timeout: 30_000 });
  await page.close();

  // Mobile: the real toolbox and its accessible add control, followed by Load.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mockDeriv(mobile);
  const mobileBot = await openWorkspace(mobile, true);
  const mobileInitial = await mobileBot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length);
  await mobileBot.getByTestId('db-toolbox-mobile-toggle').click();
  await mobileBot.getByText('Utility', { exact: true }).click();
  await mobileBot.getByText('Logic', { exact: true }).click();
  await mobileBot.getByTestId('dt_flyout__add_controls_if').click();
  assert.ok(await mobileBot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length) > mobileInitial);
  await loadPreset(mobile, mobileBot);
  await mobile.close();

  // Wide desktop also uses Deriv's separate desktop wizard.
  const wide = await browser.newPage({ viewport: { width: 1900, height: 1100 } });
  await mockDeriv(wide);
  const wideBot = await openWorkspace(wide);
  await loadPreset(wide, wideBot, 'MARTINGALE');
  await wide.close();

  assert.equal(requests.some(request => request.buy || request.sell), false, 'no buy or sell may be sent by these tests');
  assert.deepEqual(errors, [], 'browser pages should not throw uncaught errors');
  console.log('DBot smoke passed: desktop drag, chart, store, safe preset loading, mobile blocks, iframe persistence, automatic account linking, and the Signal Lab data bridge.');
} finally {
  for (const timer of timers) clearInterval(timer);
  await browser.close();
}
