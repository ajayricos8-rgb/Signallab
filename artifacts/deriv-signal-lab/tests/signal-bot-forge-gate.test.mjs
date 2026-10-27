// Load and Run execution guard — the forged model embedded in the bot.
//
// These tests pin the contract that the bot never starts on a forge veto and
// never buys a run the forged model reads against the call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeExecutionGate } from '../src/lib/signal-bot/forge-gate.ts';

const fair = 0.5;

const forged = (overrides = {}) => ({
  modelProbability: 0.62,
  validated: true,
  skill: 0.15,
  sample: 200,
  decision: 'confirm',
  edgePts: 12,
  contributionPts: 4,
  ...overrides,
});

const baseInput = (overrides = {}) => ({
  forge: forged(),
  masterVetoed: false,
  entryTimingMeasured: true,
  entryReadyNow: true,
  analysisAgeMs: 5_000,
  validityMs: 60_000,
  fair,
  ...overrides,
});

test('a master veto blocks Load and Run regardless of the forge', () => {
  const result = forgeExecutionGate(baseInput({ masterVetoed: true, forge: forged({ decision: 'confirm' }) }));
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /NO_EDGE/);
  assert.equal(result.forgeDecision, 'confirm');
});

test('a validated forge veto blocks the bot from starting', () => {
  const result = forgeExecutionGate(baseInput({ forge: forged({ decision: 'veto', modelProbability: 0.4 }) }));
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /contrary/);
  assert.equal(result.forgeDecision, 'veto');
});

test('no forged model trades the analysis entry unguided', () => {
  const result = forgeExecutionGate(baseInput({ forge: null }));
  assert.equal(result.decision, 'proceed');
  assert.match(result.reason, /without a forge opinion/);
  assert.equal(result.forgeDecision, null);
});

test('an unvalidated forge never blocks', () => {
  const result = forgeExecutionGate(baseInput({ forge: forged({ validated: false, decision: 'inert', weight: 0 }) }));
  assert.equal(result.decision, 'proceed');
  assert.match(result.reason, /not yet validated/);
});

test('missing or non-finite forge probabilities use the existing neutral fallback', () => {
  for (const modelProbability of [null, NaN, Infinity]) {
    const result = forgeExecutionGate(
      baseInput({ forge: forged({ validated: false, decision: 'inert', modelProbability }) }),
    );
    assert.equal(result.decision, 'proceed');
    assert.match(result.reason, /50\.0% vs 50\.0% fair/);
  }
});

test('a validated forge veto still blocks when its probability is missing', () => {
  const result = forgeExecutionGate(baseInput({ forge: forged({ decision: 'veto', modelProbability: null }) }));
  assert.equal(result.decision, 'block');
});

test('a validated forge that supports the call proceeds', () => {
  const result = forgeExecutionGate(baseInput({ forge: forged({ decision: 'confirm', modelProbability: 0.66 }) }));
  assert.equal(result.decision, 'proceed');
  assert.match(result.reason, /supports the call/);
});

test('a validated forge that reads against the call skips the run at purchase time', () => {
  const result = forgeExecutionGate(
    baseInput({ forge: forged({ decision: 'trim', modelProbability: 0.4, edgePts: -10 }) }),
  );
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /against the call/);
  assert.match(result.reason, /skipping this run/);
});

test('a forge that reads against the call but is not yet ready to buy does not skip', () => {
  const result = forgeExecutionGate(
    baseInput({ entryReadyNow: false, forge: forged({ decision: 'trim', modelProbability: 0.4 }) }),
  );
  assert.equal(result.decision, 'proceed');
});

test('a forge near fair is neutral, not contradicting', () => {
  const result = forgeExecutionGate(baseInput({ forge: forged({ modelProbability: 0.502 }) }));
  assert.equal(result.decision, 'proceed');
  assert.match(result.reason, /neutral/);
});

test('an edge below fair but inside the noise floor is not contradicting', () => {
  const result = forgeExecutionGate(baseInput({ forge: forged({ modelProbability: 0.498 }) }));
  assert.equal(result.decision, 'proceed');
});

test('the gate never mutates its input', () => {
  const input = baseInput();
  const snapshot = JSON.parse(JSON.stringify(input));
  forgeExecutionGate(input);
  assert.deepEqual(input, snapshot);
});

test('the decision is deterministic', () => {
  const input = baseInput();
  assert.deepEqual(forgeExecutionGate(input), forgeExecutionGate(input));
});
