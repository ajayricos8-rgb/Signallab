// forgeAllAnglesReport — the forge inventories every angle it weighed.
//
// These tests pin that the forged model's analysis accounts for ALL angles:
// engines, baseline, prior, market structure, knowledge, AI, research and
// neural — and reports which were measured and which way each leans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeAllAnglesReport } from '../src/lib/forge/forge.ts';

const angle = (overrides = {}) => ({
  domain: 'engines',
  label: 'engine ensemble',
  measured: true,
  verdict: 'neutral',
  ...overrides,
});

test('reports full coverage when every named angle was measured', () => {
  const report = forgeAllAnglesReport({
    angles: [
      angle({ label: 'engine ensemble', verdict: 'supports' }),
      angle({ label: 'rolling baseline', domain: 'calculations', verdict: 'supports' }),
      angle({ label: 'analysis prior', domain: 'calculations', verdict: 'neutral' }),
      angle({ label: 'market volatility', domain: 'market-structure', verdict: 'opposes' }),
      angle({ label: 'digit entropy', domain: 'market-structure', verdict: 'supports' }),
    ],
    forgeValidated: true,
    forgeDecision: 'confirm',
    forgedEdgePts: 8,
  });
  assert.equal(report.angleCount, 5);
  assert.equal(report.measuredCount, 5);
  assert.equal(report.coverage, 1);
  assert.equal(report.supportCount, 3);
  assert.equal(report.opposeCount, 1);
  assert.equal(report.supportShare, 0.6);
  assert.equal(report.dominantVerdict, 'supports');
  assert.match(report.summary, /weighed 5 of 5 angles/);
  assert.match(report.summary, /confirmed the call/);
});

test('reports partial coverage when some angles had no data', () => {
  const report = forgeAllAnglesReport({
    angles: [
      angle({ label: 'engine ensemble', measured: true, verdict: 'supports' }),
      angle({ label: 'AI forecast', domain: 'ai', measured: false, verdict: 'unmeasured' }),
      angle({ label: 'research ensemble', domain: 'research', measured: false, verdict: 'unmeasured' }),
      angle({ label: 'neural forecast', domain: 'neural', measured: false, verdict: 'unmeasured' }),
    ],
    forgeValidated: true,
    forgeDecision: 'confirm',
    forgedEdgePts: 4,
  });
  assert.equal(report.angleCount, 4);
  assert.equal(report.measuredCount, 1);
  assert.equal(report.coverage, 0.25);
  assert.equal(report.supportShare, 1);
  assert.equal(report.dominantVerdict, 'supports');
  assert.match(report.summary, /weighed 1 of 4 angles/);
});

test('an unvalidated forge carries no weight whatever the angles say', () => {
  const report = forgeAllAnglesReport({
    angles: [angle({ label: 'engine ensemble', verdict: 'supports' })],
    forgeValidated: false,
    forgeDecision: 'inert',
    forgedEdgePts: 12,
  });
  assert.equal(report.forgeValidated, false);
  assert.equal(report.dominantVerdict, 'supports');
  assert.match(report.summary, /did not clear its out-of-sample gate/);
  assert.match(report.summary, /carries no weight/);
});

test('a validated veto reports a contrary read', () => {
  const report = forgeAllAnglesReport({
    angles: [
      angle({ label: 'engine ensemble', verdict: 'supports' }),
      angle({ label: 'market structure', domain: 'market-structure', verdict: 'opposes' }),
      angle({ label: 'AI forecast', domain: 'ai', verdict: 'opposes' }),
    ],
    forgeValidated: true,
    forgeDecision: 'veto',
    forgedEdgePts: -9,
  });
  assert.equal(report.dominantVerdict, 'opposes');
  assert.equal(report.forgeDecision, 'veto');
  assert.match(report.summary, /validated a contrary read/);
  assert.match(report.summary, /entry is vetoed/);
});

test('a trim reports the measured disagreement', () => {
  const report = forgeAllAnglesReport({
    angles: [
      angle({ label: 'engine ensemble', verdict: 'supports' }),
      angle({ label: 'research ensemble', domain: 'research', verdict: 'opposes' }),
    ],
    forgeValidated: true,
    forgeDecision: 'trim',
    forgedEdgePts: -3,
  });
  assert.equal(report.supportShare, 0.5);
  assert.match(report.summary, /trimmed the call/);
});

test('a tie between supporting and opposing angles reads as mixed', () => {
  const report = forgeAllAnglesReport({
    angles: [
      angle({ label: 'engine ensemble', verdict: 'supports' }),
      angle({ label: 'research ensemble', domain: 'research', verdict: 'opposes' }),
    ],
    forgeValidated: true,
    forgeDecision: 'inert',
    forgedEdgePts: 0,
  });
  assert.equal(report.dominantVerdict, 'mixed');
  assert.equal(report.supportShare, 0.5);
});

test('no measured angles reads as unmeasured', () => {
  const report = forgeAllAnglesReport({
    angles: [
      angle({ label: 'AI forecast', domain: 'ai', measured: false, verdict: 'unmeasured' }),
      angle({ label: 'neural forecast', domain: 'neural', measured: false, verdict: 'unmeasured' }),
    ],
    forgeValidated: true,
    forgeDecision: 'inert',
    forgedEdgePts: 0,
  });
  assert.equal(report.measuredCount, 0);
  assert.equal(report.coverage, 0);
  assert.equal(report.supportShare, null);
  assert.equal(report.dominantVerdict, 'unmeasured');
  assert.match(report.summary, /none/);
});

test('the report never mutates its input', () => {
  const angles = [angle({ label: 'engine ensemble', verdict: 'supports' })];
  const snapshot = JSON.parse(JSON.stringify(angles));
  const input = { angles, forgeValidated: true, forgeDecision: 'confirm', forgedEdgePts: 5 };
  forgeAllAnglesReport(input);
  assert.deepEqual(angles, snapshot);
  assert.deepEqual(input.angles, snapshot);
});
