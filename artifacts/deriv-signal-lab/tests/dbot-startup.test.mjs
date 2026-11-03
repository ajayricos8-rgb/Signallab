import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [pkg, app, panel, dbotApp, dbotContent, builder] = await Promise.all([
  read('../../../package.json'),
  read('../../../src/App.tsx'),
  read('../../../src/components/dbot-space/workspace-panel.tsx'),
  read('../../../vendor/deriv-bot/src/app/App.tsx'),
  read('../../../vendor/deriv-bot/src/app/app-content.jsx'),
  read('../../../vendor/deriv-bot/src/main.tsx'),
]);

test('DBot builds before dev/production and is the initial host tab', () => {
  assert.match(pkg, /"predev":\s*"node scripts\/build-dbot\.mjs"/);
  assert.match(pkg, /"build:app":\s*"node scripts\/build-dbot\.mjs && vite build/);
  assert.match(app, /useState<WorkspaceTab>\('dbot-space'\)/);
  assert.match(app, /const \[dbotMounted\] = useState\(true\)/);
  assert.match(panel, /src=\{`\$\{import\.meta\.env\.BASE_URL\}dbot\/index\.html#bot_builder`\}/);
});

test('the iframe shows startup progress and DBot announces readiness after boot', () => {
  assert.match(panel, /data-testid="dbot-initializing"/);
  assert.match(panel, /Starting DBot workspace/);
  assert.match(dbotContent, /connectSignalLabBridge\(\)/);
  assert.match(dbotContent, /type: 'ready'/);
  assert.match(dbotApp, /RouterProvider router=\{router\}/);
  assert.match(builder, /ReactDOM\.createRoot\(document\.getElementById\('root'\)!\)\.render\(<AuthWrapper \/>\)/);
});
