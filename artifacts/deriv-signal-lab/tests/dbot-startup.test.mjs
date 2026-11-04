import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [pkg, app, panel, engine, shellMain, dbotApp, dbotContent, dbotRoot, builder, host, recovery, routeError] = await Promise.all([
  read('../../../package.json'),
  read('../../../src/App.tsx'),
  read('../../../src/components/dbot-space/workspace-panel.tsx'),
  read('../../../src/components/dbot-space/engine.ts'),
  read('../../../src/main.tsx'),
  read('../../../vendor/deriv-bot/src/app/App.tsx'),
  read('../../../vendor/deriv-bot/src/app/app-content.jsx'),
  read('../../../vendor/deriv-bot/src/app/app-root.tsx'),
  read('../../../vendor/deriv-bot/src/main.tsx'),
  read('../../../vendor/deriv-bot/src/services/signallab-host.ts'),
  read('../../../vendor/deriv-bot/src/services/chunk-recovery.ts'),
  read('../../../vendor/deriv-bot/src/app/route-error.tsx'),
]);

test('DBot builds before dev/production and is the initial host tab', () => {
  assert.match(pkg, /"predev":\s*"node scripts\/build-dbot\.mjs"/);
  assert.match(pkg, /"build:app":\s*"node scripts\/build-dbot\.mjs && vite build/);
  assert.match(app, /useState<WorkspaceTab>\('dbot-space'\)/);
  assert.match(app, /const \[dbotMounted\] = useState\(true\)/);
  // The frame URL carries the reload counter, so a reload can never be answered
  // from a cached copy of an older workspace document.
  assert.match(
    panel,
    /src=\{`\$\{import\.meta\.env\.BASE_URL\}dbot\/index\.html\?v=\$\{frameRevision\}#bot_builder`\}/,
  );
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
  assert.match(engine, /case 'workspace-error': \{[\s\S]{0,400}?setReady\(false\)/);
});

test('a workspace document that never loads is reported, not looped', () => {
  // `alive` is posted from the frame before React exists, so the shell can tell
  // "still booting" from "this document never ran DBot" — a stale cached copy
  // or a host shell served in place of the frame. The second case gets a short
  // leash and a reload with a fresh URL instead of another silent 30s cycle.
  assert.match(host, /post\(\{ type: 'alive', build: loadedBuild\(\) \}\)/);
  assert.match(host, /BOOT_WATCHDOG_MS/);
  assert.match(engine, /case 'alive': \{/);
  assert.match(engine, /DOCUMENT_TIMEOUT_MS = 12_000/);
  assert.match(engine, /const silent = !frameAlive\.current;/);
  assert.match(engine, /A cached copy may be blocking it/);
  // The user's own Reload must get its automatic retry back.
  assert.match(engine, /reload: retryWorkspace,/);
  // A stale root-scoped service worker from an early build is dropped on boot.
  assert.match(shellMain, /getRegistrations\(\)/);
  assert.match(shellMain, /unregister\(\)/);
});

test('the iframe shows startup progress and DBot announces readiness after boot', () => {
  assert.match(panel, /data-testid="dbot-initializing"/);
  assert.match(panel, /Starting DBot workspace/);
  assert.match(dbotContent, /connectSignalLabBridge\(\)/);
  assert.match(dbotContent, /markWorkspaceMounted\(\)/);
  assert.match(host, /type: 'ready'/);
  assert.match(host, /export function markWorkspaceMounted/);
  // The shell asks again instead of giving a slow frame a single chance.
  assert.match(engine, /HELLO_RETRY_MS/);
  assert.match(engine, /hostHello\(\)/);
  // A hanging Deriv socket or remote-config request must not hold the loader.
  assert.match(dbotContent, /BOOT_DEADLINE_MS/);
  assert.match(dbotRoot, /TMB_CHECK_DEADLINE_MS/);
  assert.match(builder, /installSignalLabHost\(\)/);
  assert.match(builder, /ReactDOM\.createRoot\(document\.getElementById\('root'\)!\)\.render\(<AuthWrapper \/>\)/);
});
