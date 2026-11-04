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

test('a blocked third-party script is never mistaken for a chunk', () => {
  // Ad blockers routinely kill analytics and survey tags. Treating one of those
  // as a stale chunk reloaded the workspace over and over, which is what made a
  // perfectly loaded builder restart itself.
  const script_event = (src) => ({ target: { tagName: 'SCRIPT', src } });
  assert.equal(recovery.isScriptChunkFailure(script_event('https://www.googletagmanager.com/gtm.js?id=GTM-123')), false);
  assert.equal(recovery.isScriptChunkFailure(script_event('https://survey.survicate.com/workspaces/x/web_surveys.js')), false);
  assert.equal(recovery.isScriptChunkFailure(script_event('https://cdn.example.com/anything.js')), false);
  assert.equal(recovery.isScriptChunkFailure(script_event('https://signal-lab.test/dbot/static/js/async/776.99ea02af.js')), true);
  assert.equal(recovery.isScriptChunkFailure(script_event('/dbot/static/js/index.abc123.js')), true);
  assert.equal(recovery.isScriptChunkFailure(script_event('')), false);
});

test('a chunk failure reloads the frame at most twice, then it stops', () => {
  // Reloading is a bounded recovery, never a restart loop: a workspace that dies
  // again right after a restart must end on the error boundary instead of
  // reloading forever (which is exactly what the shell used to do).
  store.clear();
  reloads = 0;

  assert.equal(recovery.recoverFromChunkFailure(), true, 'first failure reloads');
  assert.equal(reloads, 1);
  assert.equal(recovery.recoverFromChunkFailure(), false, 'inside the retry window it does not loop');
  assert.equal(reloads, 1);

  // Past the retry window the second attempt is allowed…
  store.set('signal-lab:dbot:chunk-reload', String(Date.now() - 60_000));
  assert.equal(recovery.recoverFromChunkFailure(), true);
  assert.equal(reloads, 2);

  // …and then the budget is spent: no third reload, no loop.
  store.set('signal-lab:dbot:chunk-reload', String(Date.now() - 60_000));
  assert.equal(recovery.recoverFromChunkFailure(), false);
  assert.equal(reloads, 2);
  assert.equal(recovery.isReloadBudgetExhausted(), true);
});

test('a workspace that stays up gets its restarts back', () => {
  store.clear();
  reloads = 0;
  assert.equal(recovery.recoverFromChunkFailure(), true);
  assert.equal(recovery.isReloadBudgetExhausted(), false, 'one of two used');

  // The workspace has now been up longer than the stable window: mounting
  // clears the guard and refills the budget, so a later deploy can recover.
  store.set('signal-lab:dbot:chunk-reloads-at', String(Date.now() - 120_000));
  recovery.clearChunkRecoveryGuard();
  assert.equal(recovery.isReloadBudgetExhausted(), false);
  store.set('signal-lab:dbot:chunk-reload', String(Date.now() - 60_000));
  assert.equal(recovery.recoverFromChunkFailure(), true);
  assert.equal(reloads, 2);

  // A mount right after a restart must NOT clear the guard — that is the loop.
  store.clear();
  reloads = 0;
  recovery.clearChunkRecoveryGuard();
  assert.equal(recovery.recoverFromChunkFailure(), true);
  recovery.clearChunkRecoveryGuard();
  store.set('signal-lab:dbot:chunk-reload', String(Date.now() - 60_000));
  assert.equal(recovery.recoverFromChunkFailure(), true, 'second restart still allowed');
  recovery.clearChunkRecoveryGuard();
  store.set('signal-lab:dbot:chunk-reload', String(Date.now() - 60_000));
  assert.equal(recovery.recoverFromChunkFailure(), false, 'budget survives a remount');
});
