// The PRO -tool area is intentionally an empty host-side tab. Pin the shell
// wiring so later DBot iframe changes cannot make it navigate away or expose a
// placeholder feature before it is ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../../../src/components/dbot-space/index.tsx', import.meta.url), 'utf8');
const protocol = await readFile(new URL('../../../src/components/dbot-space/protocol.ts', import.meta.url), 'utf8');
const panel = await readFile(new URL('../../../src/components/dbot-space/workspace-panel.tsx', import.meta.url), 'utf8');

test('DBot Space exposes an empty PRO -tool host tab without changing iframe navigation', () => {
  assert.match(index, /id: 'pro-tool', label: 'PRO -tool', icon: Wrench/);
  assert.match(index, /view === 'pro-tool' && <div data-testid="dbot-pro-tool" \/>/);
  assert.match(protocol, /WorkspaceTab \| 'store' \| 'tools' \| 'pro-tool'/);
  assert.match(panel, /view === 'store' \|\| view === 'tools' \|\| view === 'pro-tool'/);
});
