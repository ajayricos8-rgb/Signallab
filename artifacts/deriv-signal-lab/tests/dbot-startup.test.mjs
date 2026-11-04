import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [pkg, app, panel, engine, dbotApp, dbotContent, dbotRoot, builder, host] = await Promise.all([
  read('../../../package.json'),
  read('../../../src/App.tsx'),
  read('../../../src/components/dbot-space/workspace-panel.tsx'),
  read('../../../src/components/dbot-space/engine.ts'),
  read('../../../vendor/deriv-bot/src/app/App.tsx'),
  read('../../../vendor/deriv-bot/src/app/app-content.jsx'),
  read('../../../vendor/deriv-bot/src/app/app-root.tsx'),
  read('../../../vendor/deriv-bot/src/main.tsx'),
  read('../../../vendor/deriv-bot/src/services/signallab-host.ts'),
]);

test('DBot builds before dev/production and is the initial host tab', () => {
  assert.match(pkg, /"predev":\s*"node scripts\/build-dbot\.mjs"/);
  assert.match(pkg, /"build:app":\s*"node scripts\/build-dbot\.mjs && vite build/);
  assert.match(app, /useState<WorkspaceTab>\('dbot-space'\)/);
  assert.match(app, /const \[dbotMounted\] = useState\(true\)/);
  assert.match(panel, /src=\{`\$\{import\.meta\.env\.BASE_URL\}dbot\/index\.html#bot_builder`\}/);
});

test('the workspace is a sub-application route, not the host root', () => {
  // The iframe loads `/dbot/index.html`: without a basename the route tree only
  // matched `/`, nothing mounted, `ready` never arrived and the shell reported
  // "DBot did not become ready". Guard both halves of that fix.
  assert.match(dbotApp, /createBrowserRouter\(/);
  assert.match(dbotApp, /\{ basename \}/);
  assert.ok(dbotApp.includes('index.html'), 'the document name is stripped before the router runs');
  assert.ok(dbotApp.includes('history.replaceState'), 'the pathname is normalised to the sub-application base');
  assert.match(dbotApp, /RouterProvider router=\{router\}/);
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
