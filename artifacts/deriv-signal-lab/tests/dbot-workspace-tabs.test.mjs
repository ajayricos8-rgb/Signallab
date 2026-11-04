// The Signal Lab tabs live inside the workspace's own tab bar.
//
// Trade history and Settings used to be shell routes. The workspace is the app
// now, so they are tabs beside Tutorials, their panels dock under that tab bar,
// and the PAT dialog answers the workspace's own Log in button. These pins keep
// the three halves — frame tabs, host protocol, shell layout — in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [frameMain, frameConstants, frameHeader, accountBar, frameHostService, protocol, shell, frameHost, app] = await Promise.all([
  read('../../../vendor/deriv-bot/src/pages/main/main.tsx'),
  read('../../../vendor/deriv-bot/src/constants/bot-contents.ts'),
  read('../../../vendor/deriv-bot/src/components/layout/header/header.tsx'),
  read('../../../vendor/deriv-bot/src/components/signal-lab-account-bar/signal-lab-account-bar.tsx'),
  read('../../../vendor/deriv-bot/src/services/signallab-host.ts'),
  read('../../../src/components/dbot-space/protocol.ts'),
  read('../../../src/components/dbot-space/index.tsx'),
  read('../../../src/components/dbot-space/frame-host.ts'),
  read('../../../src/App.tsx'),
]);

test('Trade history and Settings are tabs in the workspace tab bar', () => {
  assert.match(frameConstants, /SIGNAL_LAB_HISTORY: 4/);
  assert.match(frameConstants, /SIGNAL_LAB_SETTINGS: 5/);
  assert.match(frameConstants, /'id-signal-lab-history'/);
  assert.match(frameConstants, /'id-signal-lab-settings'/);
  // They must come after Tutorials, inside the same <Tabs> tree.
  const tutorials = frameMain.indexOf("id='id-tutorials'");
  const history = frameMain.indexOf("id='id-signal-lab-history'");
  const settings = frameMain.indexOf("id='id-signal-lab-settings'");
  const tabsClose = frameMain.indexOf('</Tabs>');
  assert.ok(tutorials > 0 && tutorials < history && history < settings && settings < tabsClose);
  assert.match(frameMain, /i18n_default_text='Trade history'/);
  assert.match(frameMain, /i18n_default_text='Settings'/);
});

test('the workspace tells the shell which panel to dock, and where', () => {
  assert.match(frameMain, /postHostView\('history'\)/);
  assert.match(frameMain, /postHostView\('settings'\)/);
  assert.match(frameMain, /postHostView\(null\)/);
  assert.match(frameMain, /reportTabsGeometry\(tabs\.getBoundingClientRect\(\)\.bottom\)/);
  assert.match(frameHostService, /export function postHostView/);
  assert.match(frameHostService, /export function reportTabsGeometry/);
  // The shell's `navigate` message has to move the frame's own tabs.
  assert.match(frameMain, /addEventListener\('signal-lab:navigate'/);
  assert.match(frameHostService, /'signal-lab:navigate'/);
});

test('the shell protocol understands the new workspace messages', () => {
  for (const type of ['host-view', 'tabs-geometry', 'login-request', 'account-mode']) {
    assert.ok(protocol.includes(`case '${type}'`), `protocol parses ${type}`);
  }
  assert.match(protocol, /export type HostView = 'history' \| 'settings' \| null;/);
  assert.match(protocol, /export type AccountMode = 'real' \| 'demo';/);
  assert.match(frameHost, /case 'host-view':/);
  assert.match(frameHost, /case 'tabs-geometry':/);
  assert.match(frameHost, /case 'login-request':/);
  assert.match(frameHost, /case 'account-mode':/);
  // Switching mode asks the host session for an account of that type.
  assert.match(frameHost, /tradingRef\.current\.selectAccount\(target\.accountId\)/);
});

test('the shell docks the host panel under the workspace tab bar', () => {
  assert.match(shell, /style=\{\{ top: frame\.tabsBottom \|\| DEFAULT_TABS_BOTTOM \}\}/);
  assert.match(shell, /data-testid={`dbot-host-panel-\$\{hostView\}`\}/);
  assert.match(shell, /<TradeHistoryPanel \/>/);
  assert.match(shell, /<SettingsPanel \/>/);
  assert.match(shell, /frame\.showTab\("builder"\)/);
  // A reload must not leave a stale panel over a fresh workspace.
  assert.match(frameHost, /setHostView\(null\)/);
});

test('the workspace Log in button opens the PAT dialog', () => {
  assert.match(frameHeader, /if \(isEmbeddedWorkspace\(\)\) \{\s*requestHostLogin\(\);/);
  assert.match(frameHostService, /export function requestHostLogin/);
  assert.match(shell, /frame\.loginRequest > 0/);
  assert.match(shell, /data-testid="dbot-login-dialog"/);
  assert.match(shell, /<DerivConnectionCard \/>/);
  // Sign up has no OAuth journey inside the workspace.
  assert.match(frameHeader, /\{!isEmbeddedWorkspace\(\) && \(/);
});

test('after connecting, the workspace header shows the mode toggle and balance', () => {
  assert.match(accountBar, /data-testid='signal-lab-account-bar'/);
  assert.match(accountBar, /signal-lab-mode-\$\{option_type\}/);
  assert.match(accountBar, /data-testid='signal-lab-balance'/);
  assert.match(accountBar, /requestAccountMode\(option_type\)/);
  // It is a view of the shell's snapshot, never a second source of truth.
  assert.match(accountBar, /getSignalLabAccount\(\)/);
  assert.match(accountBar, /subscribeSignalLabBridge/);
  assert.match(frameHeader, /<SignalLabAccountBar \/>/);
  assert.match(frameHostService, /export function requestAccountMode/);
});

test('the app opens straight into the fullscreen workspace', () => {
  assert.match(app, /h-\[100dvh\] w-full overflow-hidden/);
  assert.match(app, /data-testid="workspace-root"/);
  assert.match(app, /<DbotSpace analysisRequest=\{analysisRequest\} \/>/);
  // No shell sidebar, header or bottom tab bar left to hide the workspace.
  assert.doesNotMatch(app, /<aside/);
  assert.doesNotMatch(app, /bottom-navigation/);
  // The theme control survives as a floating button over the workspace.
  assert.match(app, /data-testid="button-theme-toggle"/);
  // And the frame fills the viewport.
  assert.match(shell, /ws-shell/);
});
