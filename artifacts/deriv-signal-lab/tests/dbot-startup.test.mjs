import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [pkg, app, shell, frameHost, shellMain, dbotApp, dbotContent, dbotRoot, builder, host, recovery, routeError, authUtils, apiBase] = await Promise.all([
  read('../../../package.json'),
  read('../../../src/App.tsx'),
  read('../../../src/components/dbot-space/index.tsx'),
  read('../../../src/components/dbot-space/frame-host.ts'),
  read('../../../src/main.tsx'),
  read('../../../vendor/deriv-bot/src/app/App.tsx'),
  read('../../../vendor/deriv-bot/src/app/app-content.jsx'),
  read('../../../vendor/deriv-bot/src/app/app-root.tsx'),
  read('../../../vendor/deriv-bot/src/main.tsx'),
  read('../../../vendor/deriv-bot/src/services/signallab-host.ts'),
  read('../../../vendor/deriv-bot/src/services/chunk-recovery.ts'),
  read('../../../vendor/deriv-bot/src/app/route-error.tsx'),
  read('../../../vendor/deriv-bot/src/utils/auth-utils.ts'),
  read('../../../vendor/deriv-bot/src/external/bot-skeleton/services/api/api-base.ts'),
]);

test('DBot builds before dev/production and fills the app', () => {
  assert.match(pkg, /"predev":\s*"node scripts\/build-dbot\.mjs"/);
  assert.match(pkg, /"build:app":\s*"node scripts\/build-dbot\.mjs && vite build/);
  // The workspace *is* the app now: no shell navigation to hide it behind.
  assert.match(app, /<DbotSpace analysisRequest=\{analysisRequest\} \/>/);
  assert.match(app, /data-testid="workspace-root"/);
  assert.doesNotMatch(app, /workspaceTabs|bottom-navigation/);
  // The frame URL carries the reload counter, so a reload can never be answered
  // from a cached copy of an older workspace document.
  assert.match(shell, /const WORKSPACE_URL = `\$\{import\.meta\.env\.BASE_URL\}dbot\/index\.html`/);
  assert.match(shell, /src=\{`\$\{WORKSPACE_URL\}\?v=\$\{frame\.frameRevision\}`\}/);
});

test('the workspace is a sub-application route, not the host root', () => {
  // The iframe loads `/dbot/index.html`: without a basename the route tree only
  // matched `/`, nothing mounted, `ready` never arrived and the shell reported
  // "DBot did not become ready". Guard both halves of that fix.
  assert.match(dbotApp, /createBrowserRouter\(/);
  assert.match(dbotApp, /\{ basename, errorElement: <RouteError \/> \}/);
  assert.ok(dbotApp.includes('index.html'), 'the document name is stripped before the router runs');
  assert.ok(dbotApp.includes('history.replaceState'), 'the pathname is normalised to the sub-application base');
  assert.match(dbotApp, /RouterProvider router=\{router\}/);
});

test('a stale chunk recovers instead of ending on a stack trace', () => {
  // A page loaded just before a deploy asks for a chunk that only exists in the
  // other version; webpack raises ChunkLoadError and React Router used to print
  // it over the whole workspace. One bounded reload fixes it.
  assert.match(recovery, /ChunkLoadError/);
  assert.match(recovery, /recoverFromChunkFailure/);
  assert.match(recovery, /RETRY_WINDOW_MS/);
  assert.match(builder, /installChunkRecovery\(\)/);
  assert.match(host, /clearChunkRecoveryGuard\(\)/);
  assert.match(routeError, /useRouteError/);
  assert.match(routeError, /Reload workspace/);
  // A frame that fails after `ready` must lose the ready flag, so the shell's
  // overlay and its Reload button come back.
  assert.match(frameHost, /case 'workspace-error':[\s\S]{0,200}?setReady\(false\)/);
});

test('a workspace that keeps restarting is stopped, not watched', () => {
  // Two bounds: the frame budgets its own reloads, and the shell counts frame
  // boots. Whichever fires first, the panel ends on the Reload card instead of
  // cycling. This is the regression the user hit twice.
  assert.match(frameHost, /MAX_AUTO_RELOADS = 2/);
  assert.match(frameHost, /MAX_FRAME_BOOTS = 3/);
  assert.match(frameHost, /boots \+= 1/);
  assert.match(frameHost, /The DBot workspace keeps restarting/);
  // A restart only refills the frame's budget once the workspace has been up
  // for the stable window — clearing it on every mount was the loop.
  assert.match(recovery, /RELOAD_BUDGET = 2/);
  assert.match(recovery, /STABLE_AFTER_MS = 60_000/);
  assert.match(recovery, /isReloadBudgetExhausted/);
  assert.match(frameHost, /STABLE_RUN_MS = 60_000/);
  // Embedded, an authentication failure clears storage instead of reloading.
  assert.match(authUtils, /const mayReload = \(\) => !isEmbeddedWorkspace\(\);/);
  assert.match(authUtils, /if \(is_reload && mayReload\(\)\)/);
  assert.match(apiBase, /!isEmbeddedWorkspace\(\) && Cookies\.get\('logged_state'\) === 'true'/);
});

test('a workspace document that never loads is reported, not looped', () => {
  // `alive` is posted from the frame before React exists, so the shell can tell
  // "still booting" from "this document never ran DBot" — a stale cached copy
  // or a host shell served in place of the frame. The second case gets a short
  // leash and a reload with a fresh URL instead of another silent 30s cycle.
  assert.match(host, /post\(\{ type: 'alive', build: loadedBuild\(\) \}\)/);
  assert.match(host, /BOOT_WATCHDOG_MS/);
  assert.match(frameHost, /case 'alive':/);
  assert.match(frameHost, /DOCUMENT_TIMEOUT_MS = 12_000/);
  assert.match(frameHost, /alive: false/);
  assert.match(frameHost, /did not load\. Reload it to fetch a fresh copy/);
  // The user's own Reload must get its automatic retry back.
  assert.match(frameHost, /autoReloads = 0/);
  assert.match(frameHost, /boots = 0/);
  // A stale root-scoped service worker from an early build is dropped on boot.
  assert.match(shellMain, /getRegistrations\(\)/);
  assert.match(shellMain, /unregister\(\)/);
});

test('the iframe shows startup progress and DBot announces readiness after boot', () => {
  assert.match(shell, /data-testid="dbot-workspace-overlay"/);
  assert.match(shell, /Connecting the workspace/);
  assert.match(dbotContent, /connectSignalLabBridge\(\)/);
  assert.match(dbotContent, /markWorkspaceMounted\(\)/);
  assert.match(host, /type: 'ready'/);
  assert.match(host, /export function markWorkspaceMounted/);
  // The shell asks again instead of giving a slow frame a single chance.
  assert.match(frameHost, /HELLO_RETRY_MS/);
  assert.match(frameHost, /hostHello\(\)/);
  // A hanging Deriv socket or remote-config request must not hold the loader.
  assert.match(dbotContent, /BOOT_DEADLINE_MS/);
  assert.match(dbotRoot, /TMB_CHECK_DEADLINE_MS/);
  assert.match(builder, /installSignalLabHost\(\)/);
  assert.match(builder, /ReactDOM\.createRoot\(document\.getElementById\('root'\)!\)\.render\(<AuthWrapper \/>\)/);
});

test('the shell is a thin host around the upstream builder', async () => {
  // The builder itself must be the cloned upstream app, not a re-implementation:
  // the shell may only own the frame lifecycle, the protocol and the layout.
  const vendorPackage = await read('../../../vendor/deriv-bot/package.json');
  assert.match(vendorPackage, /"private": true/);
  assert.match(shell, /useDbotFrame\(\)/);
  assert.match(shell, /<DbotAiCopilot/);
  assert.match(frameHost, /postMessage\(payload, window\.location\.origin\)/);
  assert.match(frameHost, /event\.origin !== window\.location\.origin/);
  assert.doesNotMatch(shell, /blockly/i, 'the shell does not ship its own block engine');
});
