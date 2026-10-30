// Mocked browser integration test. Start Signal Lab first, then run:
//   pnpm test:dbot:browser
// For the focused startup regression, run pnpm test:dbot-startup:browser.
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
    return route.fulfill({ status: 200, headers, body: JSON.stringify({ data: [...['VRTC123456', 'VRTC222222'].map(account_id => ({ account_id, balance: '10000', currency: 'USD', group: 'demo', status: 'active', account_type: 'demo' })), { account_id: 'CR123456', balance: '10000', currency: 'USD', group: 'real', status: 'active', account_type: 'real' }] }) });
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
        // Deriv replies to ticks_history with a `history` message.
        response.msg_type = 'history';
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
      else if ((key === 'proposal' || key === 'buy') && holdProposals) return;
      else if (key === 'proposal') response.proposal = { id: 'mock', ask_price: 1, payout: 1.9, spot: 100, date_start: now };
      else if (key === 'buy' || key === 'sell') response.error = { code: 'Blocked', message: 'Trading is blocked by the smoke test.' };
      else response[key] = {};
      send(response);
    });
  });
  return { authSockets, dialogs, setDialogAction: action => { dialogAction = action; }, holdProposals: () => { holdProposals = true; } };
}

async function openWorkspace(page, mobile = false, navigate = true) {
  if (navigate) await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByTestId(mobile ? 'tab-dbot-space' : 'button-dbot-space-nav').click();
  const status = page.getByTestId('dbot-workspace-status');
  await status.getByText(/Workspace ready|Workspace needs reload/).waitFor({ timeout: 60_000 });
  if ((await status.innerText()).includes('Workspace needs reload')) {
    const notice = await page.getByTestId('dbot-notice').innerText();
    assert.fail(`DBot failed to initialize: ${notice}`);
  }
  const bot = page.frames().find(frame => frame.url().includes('/dbot/'));
  assert.ok(bot, 'the bundled Deriv application must load in an iframe');
  await bot.getByText('Trade parameters', { exact: false }).first().waitFor({ timeout: 20_000 });
  assert.equal(await bot.getByTestId('blockly-load-error').count(), 0, 'workspace initialization must not fail');
  await bot.getByTestId('blockly-loader').waitFor({ state: 'hidden' });
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

async function runSmoke() {
  // Tablet-sized iframe exercises the native mobile/tablet wizard layout.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const mock = await mockDeriv(page);
  const bot = await openWorkspace(page);

  // These modules are evaluated during Blockly startup. A missing translation
  // import used to abort the entire workspace, not just the scan blocks.
  const marketScan = await bot.evaluate(() => {
    const Blockly = window.Blockly;
    const generator = Blockly.JavaScript.javascriptGenerator;
    const types = [
      'x_market_scan', 'x_scan_switch_best', 'x_scan_stand_best', 'x_scan_best',
      'x_scan_score', 'x_scan_rank', 'x_scan_count', 'x_scan_summary',
      'x_trade_due', 'x_seconds_since_trade',
    ];
    const missing = types.filter(type => !Blockly.Blocks[type] || !generator.forBlock[type]);
    const block = Blockly.derivWorkspace.newBlock('x_market_scan');
    const families = block.getField('FAMILY').getOptions(false).map(option => option[1]);
    const code = generator.blockToCode(block);
    block.dispose();
    return { missing, families, code };
  });
  assert.deepEqual(marketScan.missing, [], 'all AI market-scan blocks and generators must load');
  assert.deepEqual(marketScan.families, ['even-odd', 'over-under', 'high-low-tick', 'rise-fall']);
  assert.match(marketScan.code, /Bot\.marketScan\("even-odd", 5, 1\.95, 1, 8, 0\.35\);/);

  if (process.argv.includes('--startup-only')) {
    // Load a shipped AI bot that uses these scan blocks, without running it.
    await page.getByTestId('dbot-view-store').click();
    await page.getByTestId('dbot-use-HIGH_LOW_TICK_SNIPER').click();
    await page.getByTestId('dbot-notice').getByText(/High\/Low Tick AI Sniper v6 is on the canvas/i).waitFor({ timeout: 30_000 });
    const loadedTypes = await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).map(block => block.type));
    assert.ok(loadedTypes.includes('x_market_scan'), 'the shipped AI bot must load its scan block');
    assert.ok(loadedTypes.includes('x_scan_switch_best'), 'the shipped AI bot must load its market switch block');

    // The workspace must also start when an account is connected, and recover
    // and re-link correctly if the embedded frame is reloaded.
    await page.getByTestId('button-settings-nav').click();
    await page.getByTestId('deriv-pat-input').fill('test-only-token');
    await page.getByTestId('button-deriv-connect').click();
    await page.getByTestId('deriv-connection-status').getByText('Connected').first().waitFor({ timeout: 20_000 });
    await page.getByTestId('button-dbot-space-nav').click();
    await page.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC123456/).waitFor({ timeout: 30_000 });
    await bot.evaluate(() => window.location.reload());
    await page.getByTestId('dbot-notice').getByText(/reloaded/i).waitFor({ timeout: 20_000 });
    await page.getByTestId('dbot-workspace-status').getByText('Workspace ready').waitFor({ timeout: 60_000 });
    await page.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC123456/).waitFor({ timeout: 30_000 });
    assert.equal(await bot.getByTestId('blockly-load-error').count(), 0);
    assert.ok(await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).some(block => block.type === 'x_market_scan')),
      'the saved AI bot should be restored after reloading the workspace');
    await page.close();

    // Match the case where Signal Lab is already connected before DBot opens.
    const connected = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await mockDeriv(connected);
    await connected.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await connected.getByTestId('button-settings-nav').click();
    await connected.getByTestId('deriv-pat-input').fill('test-only-token');
    await connected.getByTestId('button-deriv-connect').click();
    await connected.getByTestId('deriv-connection-status').getByText('Connected').first().waitFor({ timeout: 20_000 });
    await openWorkspace(connected, false, false);
    await connected.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC123456/).waitFor({ timeout: 30_000 });
    await connected.close();

    // Check a fresh mobile workspace can open and load a real strategy too.
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mockDeriv(mobile);
    const mobileBot = await openWorkspace(mobile, true);
    await loadPreset(mobile, mobileBot);
    await mobile.close();
    assert.equal(requests.some(request => request.buy || request.sell), false, 'startup and loading must not trade');
    assert.deepEqual(errors, [], 'browser pages should not throw uncaught errors');
    console.log('DBot startup passed: desktop and mobile workspaces, scan blocks, safe preset loading, account link and reload.');
    return;
  }

  // The draggable AI launcher is wired to the live Blockly catalog. Build and
  // load generated XML into the real workspace, then verify the risk procedure
  // survives import and that the analysis gate can generate code separately.
  await page.getByTestId('dbot-open-analysis').click();
  await page.getByTestId('dbot-ai-panel').waitFor();
  assert.equal(await page.getByTestId('dbot-ai-tab-analysis').getAttribute('aria-selected'), 'true', 'the direct entry opens AI Analysis');
  assert.equal(await page.getByTestId('dbot-ai-tab-research').count(), 0, 'the former research tab must not be present');
  assert.equal(await page.getByTestId('tab-tools').count(), 0, 'the former Tools tab must not be present');
  await page.getByTestId('dbot-ai-tab-builder').click();
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
    const types = workspace.getAllBlocks(false).map(block => block.type);
    const gate = workspace.newBlock('signal_lab_analysis_gate');
    gate.setFieldValue('PUT', 'CONTRACT_TYPE');
    gate.setFieldValue('analysis-1', 'ANALYSIS_ID');
    const gateFields = {
      family: gate.getFieldValue('FAMILY'),
      symbol: gate.getFieldValue('SYMBOL'),
      contractType: gate.getFieldValue('CONTRACT_TYPE'),
      barrier: String(gate.getFieldValue('BARRIER')),
      targetDigit: String(gate.getFieldValue('TARGET_DIGIT')),
      analysisId: gate.getFieldValue('ANALYSIS_ID'),
    };
    const gateCode = window.Blockly.JavaScript.javascriptGenerator.blockToCode(gate)[0];
    gate.dispose();
    return { types, gateFields, gateCode };
  });
  for (const type of ['procedures_defreturn', 'procedures_callreturn', 'total_profit', 'total_runs', 'purchase']) {
    assert.ok(generatedWorkspace.types.includes(type), `generated Blockly XML must load registered block ${type}`);
  }
  // A prompt has no analysis snapshot; adding an empty analysis gate would
  // make its entry permanently impossible. Analysis-backed strategies do use it.
  assert.ok(!generatedWorkspace.types.includes('signal_lab_analysis_gate'));
  assert.deepEqual(generatedWorkspace.gateFields, {
    family: 'rise-fall', symbol: 'R_100', contractType: 'PUT', barrier: '0', targetDigit: '0', analysisId: 'analysis-1',
  });
  assert.match(generatedWorkspace.gateCode, /Bot\.getSignalLabAnalysisGate\("rise-fall", "R_100", "analysis-1", "PUT", 0, 0\)/);
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
  assert.equal(await page.getByTestId('dbot-strategy-REVERSE_MARTINGALE').count(), 1);
  assert.equal(await page.getByTestId('dbot-strategy-REVERSE_D_ALEMBERT').count(), 1);
  assert.equal(await page.getByTestId('dbot-strategy-MARTINGALE').count(), 0);
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

  // Settings retains every Base section below the original settings controls.
  for (const id of ['button-base-nav', 'button-premium-bots-nav', 'tab-base', 'tab-premium-bots']) {
    assert.equal(await page.getByTestId(id).count(), 0, `${id} must not appear in navigation`);
  }
  await page.getByTestId('button-settings-nav').click();
  const settingsOrder = await page.getByTestId('settings-workspace').evaluate(element =>
    [...element.children].map(child => child.getAttribute('data-testid')),
  );
  assert.deepEqual(settingsOrder, ['settings-panel', 'forge-base-workspace']);
  for (const id of ['base-live-market', 'base-knowledge-library', 'base-market-atlas', 'base-randomness-challenge', 'base-live-forecast', 'base-model-honesty']) {
    assert.equal(await page.getByTestId(id).count(), 1, `${id} must remain in Settings`);
  }
  await page.getByTestId('base-knowledge-search').fill('no-such-lesson-xyz');
  await page.getByText('No knowledge entries match those filters.').waitFor();
  await page.getByTestId('base-knowledge-search').fill('');
  await page.waitForFunction(() => !document.querySelector('[data-testid="button-run-rng-audit"]').disabled, null, { timeout: 20_000 });
  await page.getByTestId('button-run-rng-audit').click();
  await page.getByTestId('rng-audit-results').waitFor();
  await page.getByTestId('button-base-open-analysis').click();
  await page.getByTestId('dbot-ai-analysis').waitFor();
  assert.equal(await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length), loaded, 'the Base shortcut must not reload the iframe');
  await page.getByTestId('dbot-ai-close').click();

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
    const types = ['signal_lab_last_tick', 'signal_lab_ticks', 'signal_lab_last_digit', 'signal_lab_tick_change', 'signal_lab_balance', 'signal_lab_open_positions', 'signal_lab_profit', 'signal_lab_account', 'signal_lab_connected', 'signal_lab_scan_markets', 'signal_lab_scan_best', 'signal_lab_scan_score', 'signal_lab_scan_rank', 'signal_lab_scan_count', 'signal_lab_scan_tradeable', 'signal_lab_hedge_legs', 'signal_lab_hedge_pairs', 'signal_lab_hedge_balanced', 'signal_lab_hedge_count', 'signal_lab_hedge_profit', 'signal_lab_virtual_buy', 'signal_lab_virtual_settle', 'signal_lab_virtual_reset', 'signal_lab_virtual_profit', 'signal_lab_virtual_runs', 'signal_lab_virtual_wins', 'signal_lab_virtual_open', 'signal_lab_virtual_balance'];
    const missing = types.filter(type => !window.Blockly.Blocks[type]);
    const block = window.Blockly.derivWorkspace.newBlock('signal_lab_last_tick');
    const markets = block.getField('MARKET_LIST').getOptions(true).map(option => option[1]);
    const code = window.Blockly.JavaScript.javascriptGenerator.blockToCode(block)[0];
    block.dispose();
    const generator = (type, mutate) => {
      const instance = window.Blockly.derivWorkspace.newBlock(type);
      if (mutate) mutate(instance);
      const generated = window.Blockly.JavaScript.javascriptGenerator.blockToCode(instance);
      instance.dispose();
      return Array.isArray(generated) ? generated[0] : generated;
    };
    return {
      missing,
      markets,
      code,
      scanMarkets: generator('signal_lab_scan_markets'),
      scanBest: generator('signal_lab_scan_best'),
      scanScore: generator('signal_lab_scan_score'),
      hedgeLegs: generator('signal_lab_hedge_legs'),
      virtualBuy: generator('signal_lab_virtual_buy'),
      virtualProfit: generator('signal_lab_virtual_profit'),
    };
  });
  assert.deepEqual(bridge.missing, [], 'every Signal Lab block must be registered');
  // The mock advertises one symbol, so the dropdown proves the parent snapshot
  // replaced the static fallback list.
  assert.deepEqual(bridge.markets, ['R_100'], 'the market list must come from the Signal Lab snapshot');
  assert.equal(bridge.code, 'Bot.getSignalLabLastTick("R_100")', 'the block must call the Signal Lab runtime');
  // The all-markets scan, hedging and virtual blocks emit their own runtime calls.
  assert.match(bridge.scanMarkets, /Bot\.signalLabScanMarkets\("rise-fall", 20, 0\.05\);/);
  assert.equal(bridge.scanBest, 'Bot.signalLabScanBest()');
  assert.equal(bridge.scanScore, 'Bot.signalLabScanScore("R_100")');
  assert.equal(bridge.hedgeLegs, 'Bot.signalLabHedgeLegs("R_100")');
  assert.match(bridge.virtualBuy, /Bot\.signalLabVirtualBuy\("R_100", "rise", 1, 1\.9, 5\);/);
  assert.equal(bridge.virtualProfit, 'Bot.signalLabVirtualProfit()');

  // Hold mock quotes and buy responses so no mocked order can complete. Re-scan
  // after linking the account to use a fresh, exact analysis snapshot.
  mock.holdProposals();
  // Exercise the former weak-edge confirmation deterministically, without
  // relying on the model's verdict for the generated tick fixture.
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          const master = event.data?.type === 'result' && event.data.result?.best?.master;
          if (master) { master.verdict = 'NO_EDGE'; master.entry.action = 'no-edge'; }
        });
      }
    };
  });
  await page.getByTestId('dbot-open-analysis').click();
  await page.getByTestId('dbot-ai-run-analysis').click();
  await page.getByTestId('dbot-ai-best-market').waitFor({ timeout: 90_000 });
  await page.getByTestId('dbot-ai-weak-edge').waitFor({ state: 'visible' });
  await page.getByTestId('dbot-ai-load-analysis').waitFor({ state: 'visible' });
  await page.getByTestId('dbot-ai-load-and-run').waitFor({ state: 'visible' });
  await page.getByTestId('dbot-ai-immediate-run-warning').getByText(/replaces the current blocks without asking/i).waitFor();

  // A load-only action must retain the separate unsaved-work confirmation.
  const beforeLoadOnly = await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length);
  const beforeLoadOnlyDialogs = mock.dialogs.length;
  mock.setDialogAction('dismiss');
  const loadOnlyDialog = page.waitForEvent('dialog');
  await page.getByTestId('dbot-ai-load-analysis').click();
  const dialog = await loadOnlyDialog;
  // The dialog handler records the cancellation; no workspace should be replaced.
  assert.match(dialog.message(), /Replace the strategy in the workspace/i);
  assert.equal(mock.dialogs.length, beforeLoadOnlyDialogs + 1);
  assert.equal(await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).length), beforeLoadOnly);

  // Dismiss any unexpected prompt: an accidental confirmation would cancel the
  // run, making this fail instead of silently accepting it.
  const beforeRunDialogs = mock.dialogs.length;
  await page.getByTestId('dbot-ai-load-and-run').click();
  await bot.locator('#db-animation__stop-button:visible').first().waitFor({ timeout: 20_000 });
  assert.deepEqual(mock.dialogs.slice(beforeRunDialogs), [], 'Load and Run must not show either confirmation');
  assert.ok(await bot.evaluate(() => window.Blockly.derivWorkspace.getAllBlocks(false).some(block => block.type === 'signal_lab_analysis_gate')), 'the selected analysis must be loaded as gated Blockly XML');
  assert.equal(requests.some(request => request.sell), false, 'the test must not sell a position');
  mock.setDialogAction('accept');
  await page.getByTestId('dbot-ai-close').click();

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

  // The immediate start must also work on a real-account selection. This is
  // still entirely mocked; quotes and buys are held and no Deriv order is sent.
  await page.getByTestId('dbot-toggle-real').click();
  await page.getByTestId('dbot-account-status').getByText(/Auto-linked · CR123456/).waitFor({ timeout: 30_000 });
  await page.getByTestId('dbot-open-analysis').click();
  await page.getByTestId('dbot-ai-run-analysis').click();
  await page.getByTestId('dbot-ai-best-market').waitFor({ timeout: 90_000 });
  await page.getByTestId('dbot-ai-immediate-run-warning').getByText(/REAL account with real money/).waitFor();
  const realRunDialogs = mock.dialogs.length;
  mock.setDialogAction('dismiss');
  await page.getByTestId('dbot-ai-load-and-run').click();
  await bot.locator('#db-animation__stop-button:visible').first().waitFor({ timeout: 20_000 });
  assert.deepEqual(mock.dialogs.slice(realRunDialogs), [], 'a real-account Load and Run must not prompt');
  mock.setDialogAction('accept');
  await page.getByTestId('dbot-ai-close').click();
  await bot.locator('#db-animation__stop-button:visible').first().dispatchEvent('click');
  await bot.locator('#db-animation__stop-button:visible').first().waitFor({ state: 'hidden', timeout: 10_000 });

  // Switching the Signal Lab account moves the link with it, again by itself.
  // Record bridge messages because the disconnect notice may be replaced by
  // the automatic reconnect notice before the Settings screen is closed.
  await bot.evaluate(() => {
    window.__dbotTestSwitchMessages = [];
    window.addEventListener('message', event => {
      if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.source !== 'signal-lab') return;
      if (event.data.type === 'disconnect-account' || event.data.type === 'connect-account') {
        window.__dbotTestSwitchMessages.push({ type: event.data.type, grantId: event.data.grantId, accountId: event.data.accountId });
      }
    });
  });
  await page.getByTestId('button-settings-nav').click();
  await page.getByTestId('deriv-account-select').selectOption('VRTC222222');
  await page.getByTestId('deriv-connection-status').getByText('Connected').first().waitFor({ timeout: 20_000 });
  await page.getByTestId('button-dbot-space-nav').click();
  // The resulting link must name the new account, and the old grant must have
  // been revoked before the new one was sent to the workspace.
  await page.getByTestId('dbot-account-status').getByText(/Auto-linked · VRTC222222/).waitFor({ timeout: 30_000 });
  const switchMessages = await bot.evaluate(() => window.__dbotTestSwitchMessages);
  const revokedIndex = switchMessages.findIndex(message => message.type === 'disconnect-account');
  const linkedIndex = switchMessages.findIndex(message => message.type === 'connect-account' && message.accountId === 'VRTC222222');
  assert.ok(revokedIndex >= 0 && linkedIndex > revokedIndex, 'account switches must revoke the previous grant before linking');
  assert.notEqual(switchMessages[revokedIndex].grantId, switchMessages[linkedIndex].grantId);
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
  for (const id of ['button-base-nav', 'button-premium-bots-nav', 'tab-base', 'tab-premium-bots']) {
    assert.equal(await mobile.getByTestId(id).count(), 0, `${id} must not appear on mobile`);
  }
  await mobile.getByTestId('tab-settings').click();
  await mobile.getByTestId('forge-base-workspace').waitFor();
  await mobile.getByTestId('button-base-open-analysis').click();
  await mobile.getByTestId('dbot-ai-analysis').waitFor();
  await mobile.getByTestId('dbot-ai-close').click();
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

  assert.equal(requests.some(request => request.sell), false, 'the tests must not sell a position');
  // All WebSockets are mocked, and buy responses are held during Load and Run;
  // no order can reach Deriv even if the interpreter attempts a buy.
  assert.deepEqual(errors, [], 'browser pages should not throw uncaught errors');
  console.log('DBot smoke passed: desktop drag, chart, store, safe preset loading, mobile blocks, iframe persistence, automatic account linking, and the Signal Lab data bridge.');
}

try {
  await runSmoke();
} finally {
  for (const timer of timers) clearInterval(timer);
  await browser.close();
}
