// Auto for Load and Run.
//
// Auto is a one-signal handoff: switch it on before Run Analysis and the bot
// starts the moment a signal is generated; switch it off and the bot only runs
// when the user presses Load and Run. These tests pin the rules that keep that
// promise safe:
//
//   * nothing starts while Auto is off, and nothing starts twice for the same
//     signal (a re-render or a tab switch must not double the order size);
//   * the signal already on screen when Auto is armed is not traded — only the
//     next analysis is;
//   * a running bot is never replaced, and a signal the bot would refuse
//     (no engine entry, not tradeable, stale, no account, bad stake) is
//     skipped once with a reason instead of being fired at Deriv.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_MAX_ANALYSIS_AGE_MS, decideAutoRun } from '../src/lib/signal-bot/auto.ts';

/** Every precondition satisfied, one fresh signal waiting to be handed over. */
const ready = {
  enabled: true,
  runId: 1_700_000_001,
  handoffRunId: 1_700_000_000,
  planReady: true,
  entryReady: true,
  botRunning: false,
  connected: true,
  stakeValid: true,
  analysisAgeMs: 2_000,
};

test('Auto off never starts the bot: Load and Run stays manual', () => {
  const decision = decideAutoRun({ ...ready, enabled: false });
  assert.equal(decision.start, false);
  assert.equal(decision.state, 'manual');
  assert.equal(decision.handoff, false, 'a manual signal must stay available for the button');
  assert.match(decision.note, /press Load and Run/i);
});

test('Auto on with no signal yet waits for Run Analysis instead of doing anything', () => {
  const decision = decideAutoRun({ ...ready, runId: 0, handoffRunId: 0 });
  assert.equal(decision.start, false);
  assert.equal(decision.state, 'armed');
  assert.match(decision.note, /Run Analysis starts the bot/i);
});

test('a freshly generated signal starts the bot exactly once', () => {
  const decision = decideAutoRun(ready);
  assert.equal(decision.start, true);
  assert.equal(decision.handoff, true, 'the signal id must be recorded so it cannot start twice');
  assert.equal(decision.state, 'started');

  // The dock records the handoff; the next evaluation for the SAME signal
  // (a re-render, a settings change, a tab switch) must not start a second run.
  const afterHandoff = decideAutoRun({ ...ready, handoffRunId: ready.runId });
  assert.equal(afterHandoff.start, false);
  assert.equal(afterHandoff.state, 'idle');
  assert.equal(afterHandoff.handoff, false);
});

test('turning Auto on never trades the signal that is already on screen', () => {
  // The dock arms Auto by recording the current signal id as handled, so the
  // rule sees runId === handoffRunId and stays inert until the next analysis.
  const decision = decideAutoRun({ ...ready, handoffRunId: ready.runId });
  assert.equal(decision.start, false);
  assert.equal(decision.state, 'idle');
});

test('a new signal starts even after an earlier one has been handled', () => {
  const next = decideAutoRun({ ...ready, runId: ready.runId + 1, handoffRunId: ready.runId });
  assert.equal(next.start, true);
  assert.equal(next.handoff, true);
});

test('a bot that is already running is never replaced by a new signal', () => {
  const decision = decideAutoRun({ ...ready, botRunning: true });
  assert.equal(decision.start, false);
  assert.equal(decision.state, 'busy');
  assert.equal(decision.handoff, true, 'the signal is skipped for good, not queued behind the run');
  assert.match(decision.note, /still running/i);
});

test('Auto never starts or queues a signal vetoed by the master decision', () => {
  const decision = decideAutoRun({ ...ready, masterVetoed: true });
  assert.equal(decision.start, false);
  assert.equal(decision.handoff, true);
  assert.equal(decision.state, 'master-veto');
  assert.match(decision.note, /master decision vetoed entry \(NO_EDGE\)/i);
  // A vetoed signal remains handled once; it is not retried by a re-render.
  assert.equal(decideAutoRun({ ...ready, masterVetoed: true, handoffRunId: ready.runId }).start, false);
});

test('a signal with no engine entry or no tradeable ticket is skipped with a reason', () => {
  const noEntry = decideAutoRun({ ...ready, entryReady: false });
  assert.equal(noEntry.start, false);
  assert.equal(noEntry.state, 'no-entry');
  assert.equal(noEntry.handoff, true);

  const notTradeable = decideAutoRun({ ...ready, planReady: false });
  assert.equal(notTradeable.start, false);
  assert.equal(notTradeable.state, 'not-tradeable');
  assert.equal(notTradeable.handoff, true);
});

test('Auto never fires without an account or with an unusable stake', () => {
  const disconnected = decideAutoRun({ ...ready, connected: false });
  assert.equal(disconnected.start, false);
  assert.equal(disconnected.state, 'disconnected');
  assert.equal(disconnected.handoff, true);
  assert.match(disconnected.note, /no Deriv account is connected/i);

  const badStake = decideAutoRun({ ...ready, stakeValid: false });
  assert.equal(badStake.start, false);
  assert.equal(badStake.state, 'invalid-stake');
  assert.match(badStake.note, /stake/i);
});

test('an old analysis is refused before the bot has to refuse it', () => {
  const old = decideAutoRun({ ...ready, analysisAgeMs: AUTO_MAX_ANALYSIS_AGE_MS + 1_000 });
  assert.equal(old.start, false);
  assert.equal(old.state, 'stale');
  assert.equal(old.handoff, true);

  // A signal measured valid for a handful of ticks ages out long before the
  // fifteen-minute ceiling; Auto uses the bot's own three-window rule.
  const shortLived = decideAutoRun({ ...ready, analysisAgeMs: 400_000, validityMs: 5_000 });
  assert.equal(shortLived.state, 'stale');
  // …but a long-lived edge is still fine at the same age.
  const longLived = decideAutoRun({ ...ready, analysisAgeMs: 400_000, validityMs: 300_000 });
  assert.equal(longLived.start, true);
});

test('switching Auto off again returns the bot to the manual button', () => {
  assert.equal(decideAutoRun({ ...ready, enabled: false }).start, false);
  // Turning it back on for a signal generated while it was off still waits for
  // the next analysis, because the dock re-baselines on the current signal id.
  const rearmed = decideAutoRun({ ...ready, handoffRunId: ready.runId });
  assert.equal(rearmed.start, false);
  assert.equal(rearmed.state, 'idle');
});

test('the decision is deterministic and never mutates its input', () => {
  const input = { ...ready };
  const snapshot = { ...input };
  assert.deepEqual(decideAutoRun(input), decideAutoRun(input));
  assert.deepEqual(input, snapshot);
});
