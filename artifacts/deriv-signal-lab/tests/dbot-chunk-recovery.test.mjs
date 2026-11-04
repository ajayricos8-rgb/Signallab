// Chunk-load recovery: a page loaded just before a deploy asks for a chunk from
// the other version, webpack raises `ChunkLoadError`, and the workspace used to
// die on React Router's stack trace. The frame must reload once — and only once
// inside the retry window, so a genuinely missing file cannot become a loop.
//
// The module is dependency-free, so a small fake window is enough to exercise it.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
let reloads = 0;

globalThis.window = {
  location: {
    origin: 'https://signal-lab.test',
    reload: () => {
      reloads += 1;
    },
  },
  sessionStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
};

const recovery = await import('../../../vendor/deriv-bot/src/services/chunk-recovery.ts');

test('webpack, ESM and script-tag chunk failures are all recognised', () => {
  assert.equal(recovery.isChunkLoadFailure(new Error('Loading chunk 776 failed.')), true);
  assert.equal(recovery.isChunkLoadFailure({ name: 'ChunkLoadError', message: '(error: https://x/y.js)' }), true);
  assert.equal(recovery.isChunkLoadFailure(new Error('Failed to fetch dynamically imported module: /a.js')), true);
  assert.equal(recovery.isChunkLoadFailure('Loading CSS chunk 4 failed.'), true);
  assert.equal(recovery.isChunkLoadFailure(new Error('Importing a module script failed.')), true);
  // Ordinary runtime failures are not chunk failures and must not reload.
  assert.equal(recovery.isChunkLoadFailure(new Error('Cannot read properties of undefined')), false);
  assert.equal(recovery.isChunkLoadFailure(null), false);
  assert.equal(recovery.isChunkLoadFailure('boom'), false);
});

test('a chunk failure reloads the frame exactly once inside the retry window', () => {
  store.clear();
  reloads = 0;

  assert.equal(recovery.recoverFromChunkFailure(), true, 'first failure reloads');
  assert.equal(reloads, 1);

  assert.equal(recovery.recoverFromChunkFailure(), false, 'a second failure must not loop');
  assert.equal(reloads, 1);

  // A workspace that booted clears the guard, so a later deploy can recover too.
  recovery.clearChunkRecoveryGuard();
  assert.equal(recovery.recoverFromChunkFailure(), true);
  assert.equal(reloads, 2);
});

test('the retry window expires, so a new deploy is recovered again', () => {
  store.clear();
  reloads = 0;
  recovery.clearChunkRecoveryGuard();
  assert.equal(recovery.recoverFromChunkFailure(), true);
  const first = Number(store.get('signal-lab:dbot:chunk-reload'));
  assert.ok(first > 0, 'the attempt is timestamped');

  // Simulate a page that has been open for longer than the window.
  store.set('signal-lab:dbot:chunk-reload', String(Date.now() - 60_000));
  assert.equal(recovery.recoverFromChunkFailure(), true);
  assert.equal(reloads, 2);
});
