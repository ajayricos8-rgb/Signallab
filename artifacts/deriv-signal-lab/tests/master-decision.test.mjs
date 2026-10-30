// Layer 6 — the unified master decision.
//
// These tests pin the three properties the layer exists for:
//   1. the validity window is MEASURED from edge decay, not a constant;
//   2. the six evidence sources are pooled by measured skill, without letting
//      correlated measurements outvote independent ones;
//   3. the verdict is honest — a decisive call requires a significant edge, a
//      stable decay curve and a reachable entry, and everything else is
//      reported as speculative or no-edge instead of being dressed up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMasterDecision,
  measureValidity,
  oneSidedPValue,
  sourceWeight,
  masterBlocksEntry,
} from '../src/lib/signal-engine/master-decision.ts';
import { forgeVetoed } from '../src/lib/forge/forge.ts';
import {
  effectiveWindowTicks,
  entryWindowMs,
  evaluateEntry,
  isEntryPlan,
} from '../src/lib/signal-engine/entry.ts';
import { analyzeDigitMarket } from '../src/lib/signal-engine/digit-signal.ts';
import { analyzeRiseFallMarket } from '../src/lib/signal-engine/rise-fall-signal.ts';

function prng(seed = 1) {
  let a = 0x9e3779b9;
  let b = 0x243f6a88 + seed;
  let c = 0xb7e15162;
  let d = 0x12345678 ^ (seed * 7919);
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let index = 0; index < 30; index += 1) next();
  return next;
}

function digits(seed, bias) {
  const next = prng(seed);
  return Array.from({ length: 2_000 }, (_, index) => ({
    epoch: 1_700_000_000 + index,
    digit: bias && next() < 0.28 ? 7 : Math.floor(next() * 10),
  }));
}

function quotes(seed, drift = 0) {
  const next = prng(seed);
  let quote = 100;
  return Array.from({ length: 2_000 }, (_, index) => ({
    epoch: 1_700_000_000 + index,
    quote: (quote += next() - 0.5 + drift),
  }));
}

const hash = (value) => {
  let x = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

const rowsOf = (count) =>
  Array.from({ length: count }, (_, index) => ({ origin: index, exit: index + 1 }));

const baseInput = (overrides = {}) => ({
  family: 'digit',
  label: 'MATCH 7',
  fair: 0.1,
  publishedProbability: 0.14,
  publishedStandardError: 0.012,
  publishedConfidence: 78,
  strength: 'MODERATE',
  sources: [
    { id: 'engines', label: 'Engines', probability: 0.145, skill: 0.03, sample: 400 },
    { id: 'ai', label: 'AI', probability: 0.142, skill: 0.02, sample: 300, familyCredit: 0.6 },
    { id: 'analysis', label: 'Analysis', probability: 0.135, skill: 0.015, sample: 200 },
    { id: 'research', label: 'Research', probability: 0.15, skill: 0.02, sample: 120, familyCredit: 0.8 },
  ],
  validity: {
    rows: rowsOf(240),
    outcome: (row, lag) => (((row.origin + lag) % 10) < 6 ? 1 : 0),
    fair: 0.1,
    maxLag: 8,
  },
  tickSpacingMs: 1_000,
  entry: {
    mode: 'immediate',
    trigger: 'immediate',
    label: 'Immediate entry',
    detail: 'test',
    priceLevel: null,
    priceCondition: null,
    distance: null,
    referenceQuote: null,
    contextDigits: null,
    contextLabel: null,
    windowTicks: 2,
    expectedWaitTicks: 0,
    expectedWaitMs: 0,
    reachRate: null,
    edgeGainPts: 0,
    sample: 100,
    confidence: 55,
    tolerance: null,
    validation: null,
    fill: 'market',
    measured: false,
    evidence: {
      source: 'digit',
      agreeing: 8,
      total: 12,
      signalProbability: 0.14,
      aiProbability: 0.142,
      fairRate: 0.1,
      rule: 'test replay',
      confirmation: { status: 'confirmed', edgePts: 4, decisive: true },
    },
  },
  dataQuality: 0.98,
  marketMeasured: true,
  marketRandom: false,
  structureStable: true,
  confirmed: true,
  contradicted: false,
  ...overrides,
});

// ---- validity -------------------------------------------------------------

test('a flat edge is measured to survive the whole inspected window', () => {
  const validity = measureValidity(
    {
      rows: rowsOf(300),
      // 60% hit rate against a 10% fair rate at every delay.
      outcome: (row, lag) => (hash((row.origin + lag) * 7919) < 0.6 ? 1 : 0),
      fair: 0.1,
      maxLag: 8,
    },
    1_000,
  );
  assert.equal(validity.method, 'measured-decay');
  assert.equal(validity.ticks, 8);
  assert.equal(validity.ms, 8_000);
  assert.equal(validity.stability, 1);
  assert.ok(validity.initialEdgePts > 45);
  assert.ok(validity.finalEdgePts > 45);
  assert.equal(validity.halfLifeTicks, null);
  assert.equal(validity.curve.length, 9);
});

test('the window stops where the edge decays, and reports the half-life', () => {
  const validity = measureValidity(
    {
      rows: rowsOf(300),
      // The edge is real (±20 points) for the first two delayed ticks, then
      // disappears into a fair coin.
      outcome: (row, lag) => (lag <= 2 ? (hash((row.origin + lag) * 7919) < 0.7 ? 1 : 0) : hash((row.origin + lag) * 104729) < 0.5 ? 1 : 0),
      fair: 0.5,
      maxLag: 8,
    },
    1_000,
  );
  assert.equal(validity.ticks, 2);
  assert.equal(validity.halfLifeTicks, 3);
  assert.ok(validity.finalEdgePts > 0);
  assert.equal(validity.ms, 2_000);
});

test('a fair stream has no validity window and never claims one', () => {
  const validity = measureValidity(
    { rows: rowsOf(400), outcome: (row, lag) => (hash((row.origin + lag) * 2654435761) < 0.5 ? 1 : 0), fair: 0.5, maxLag: 8 },
    1_000,
  );
  assert.equal(validity.ticks, 1);
  assert.ok(Math.abs(validity.initialEdgePts) < 5, `edge ${validity.initialEdgePts}`);
  assert.equal(validity.stability, 0);
});

test('too few replayed signals falls back to the next tick instead of guessing', () => {
  const validity = measureValidity(
    { rows: rowsOf(5), outcome: () => 1, fair: 0.5 },
    500,
  );
  assert.equal(validity.method, 'immediate-only');
  assert.equal(validity.ticks, 1);
  assert.equal(validity.ms, 500);
});

// ---- pooling and verdicts -------------------------------------------------

test('source weight rises with measured skill and ignores an unproven source', () => {
  const strong = sourceWeight({ id: 'engines', label: 'E', probability: 0.6, skill: 0.05, sample: 500 });
  const weak = sourceWeight({ id: 'engines', label: 'E', probability: 0.6, skill: 0.005, sample: 500 });
  const unproven = sourceWeight({ id: 'engines', label: 'E', probability: 0.6, skill: 0, sample: 500 });
  const thin = sourceWeight({ id: 'engines', label: 'E', probability: 0.6, skill: 0.05, sample: 10 });
  assert.ok(strong > weak && weak > 0);
  assert.equal(unproven, 0);
  assert.equal(thin, 0);
});

test('a decisive edge is certified, weighted and given a measured window', () => {
  const decision = buildMasterDecision(baseInput());
  assert.equal(decision.verdict, 'TRADE_NOW');
  assert.equal(decision.decisive, true);
  assert.equal(decision.entry.action, 'enter-now');
  assert.ok(decision.conviction > 70, `conviction ${decision.conviction}`);
  assert.ok(decision.edgePts > 3);
  assert.ok(decision.edgeZ !== null && decision.edgeZ > 1.645);
  assert.ok(decision.pValue !== null && decision.pValue < 0.05);
  assert.equal(decision.validity.ticks, 8);
  assert.equal(decision.pooled.sources, 4);
  assert.ok(decision.pooled.probability > 0.1);
  assert.ok(decision.sources.every((source) => source.weight >= 0 && Number.isFinite(source.margin)));
  // The decisive probability must sit between the calibrated chain and the
  // committee, never outside both.
  assert.ok(decision.probability >= Math.min(decision.publishedProbability, decision.pooled.probability) - 1e-12);
  assert.ok(decision.probability <= Math.max(decision.publishedProbability, decision.pooled.probability) + 1e-12);
});

test('no edge is reported as no edge, with a one-tick window and a capped conviction', () => {
  const decision = buildMasterDecision(baseInput({
    publishedProbability: 0.1003,
    publishedStandardError: 0.02,
    publishedConfidence: 48,
    sources: [
      { id: 'engines', label: 'Engines', probability: 0.101, skill: 0.002, sample: 400 },
      { id: 'research', label: 'Research', probability: 0.102, skill: 0.001, sample: 100, familyCredit: 0.8 },
    ],
    validity: {
      rows: rowsOf(300),
      outcome: (row, lag) => (hash((row.origin + lag) * 2654435761) < 0.5 ? 1 : 0),
      fair: 0.1,
      maxLag: 8,
    },
  }));
  assert.equal(decision.verdict, 'NO_EDGE');
  assert.equal(decision.decisive, false);
  assert.equal(decision.entry.action, 'no-edge');
  assert.equal(decision.validity.ticks, 1);
  assert.ok(decision.conviction <= 45, `conviction ${decision.conviction}`);
  assert.match(decision.entry.instruction, /No measured edge/);
});

test('a validated contradiction, including a Forge veto, is a hard NO_EDGE entry block', () => {
  const forgeVeto = forgeVetoed({ decision: 'veto' });
  assert.equal(forgeVeto, true);
  const decision = buildMasterDecision(baseInput({ contradicted: forgeVeto, confirmed: false }));
  assert.equal(decision.verdict, 'NO_EDGE');
  assert.equal(decision.entry.action, 'no-edge');
  assert.equal(decision.decisive, false);
  assert.equal(masterBlocksEntry(decision), true);
  assert.match(decision.reasons.join(' '), /hard: NO_EDGE and entry\.action = no-edge/);

  const tradeable = { ...decision, verdict: 'TRADE_NOW', entry: { ...decision.entry, action: 'enter-now' } };
  assert.equal(masterBlocksEntry(tradeable), false);
});

test('the committee can only nudge the calibrated chain by a bounded amount', () => {
  const decision = buildMasterDecision(baseInput({
    publishedProbability: 0.1,
    publishedStandardError: 0.002,
    sources: [
      { id: 'engines', label: 'E', probability: 0.9, skill: 0.09, sample: 1_000 },
      { id: 'research', label: 'R', probability: 0.9, skill: 0.09, sample: 1_000, familyCredit: 0.8 },
    ],
  }));
  // 0.15 log-odds is at most ~3.75 probability points at even odds; at a 10%
  // fair rate the same cap is smaller in points, but it can never reach 50%.
  assert.ok(decision.probability < 0.3, `probability ${decision.probability}`);
  assert.equal(decision.reconciled, true);
});

test('the decision is deterministic and structured-clone friendly', () => {
  const first = buildMasterDecision(baseInput());
  const second = buildMasterDecision(baseInput());
  assert.deepEqual(first, second);
  const roundTrip = JSON.parse(JSON.stringify(first));
  assert.deepEqual(roundTrip, first);
  assert.equal(oneSidedPValue(1.645) < 0.05, true);
  assert.equal(oneSidedPValue(null), null);
});

test('an entry that earned its wait is taken on the trigger, inside the validity cap', () => {
  const plan = {
    ...baseInput().entry,
    mode: 'pullback',
    trigger: 'quote',
    label: 'Pullback entry',
    priceLevel: 99,
    priceCondition: 'below',
    distance: 1,
    referenceQuote: 100,
    windowTicks: 10,
    expectedWaitTicks: 4,
    expectedWaitMs: 4_000,
    reachRate: 0.8,
    edgeGainPts: 2.5,
    measured: true,
    validation: { sample: 60, gainPts: 2.5, reachRate: 0.8, rate: 0.62, fairRate: 0.5, passed: true, phase: 'out-of-sample' },
    fill: 'limit-with-tolerance',
    tolerance: 0.05,
    validForTicks: 3,
  };
  assert.equal(isEntryPlan(plan), true);
  assert.equal(effectiveWindowTicks(plan), 3);
  assert.equal(entryWindowMs(plan, 1_000), 3_000);
  const expired = evaluateEntry(plan, { quote: 105, digit: null, epoch: 1 }, { elapsedTicks: 3, now: 0, deadline: 10_000 });
  assert.equal(expired.status, 'expired');

  const decision = buildMasterDecision(baseInput({ entry: plan }));
  assert.equal(decision.verdict, 'TRADE_ON_ENTRY');
  assert.equal(decision.entry.action, 'enter-on-trigger');
  assert.equal(decision.entry.validated, true);
  assert.equal(decision.entry.windowTicks, 3);
  assert.equal(decision.entry.windowMs, 3_000);
});

test('a trigger that did not beat buying at the signal is not waited for', () => {
  const plan = {
    ...baseInput().entry,
    mode: 'pullback',
    trigger: 'quote',
    label: 'Pullback entry',
    priceLevel: 99,
    priceCondition: 'below',
    distance: 1,
    referenceQuote: 100,
    windowTicks: 8,
    expectedWaitTicks: 4,
    expectedWaitMs: 4_000,
    edgeGainPts: -0.5,
    measured: true,
    validation: { sample: 40, gainPts: -0.5, reachRate: 0.5, rate: 0.48, fairRate: 0.5, passed: false, phase: 'out-of-sample' },
    fill: 'limit-with-tolerance',
    tolerance: 0.05,
  };
  const decision = buildMasterDecision(baseInput({ entry: plan }));
  assert.equal(decision.entry.action, 'enter-now');
  assert.equal(decision.entry.validated, false);
});

// ---- integration ----------------------------------------------------------

test('a biased digit market produces a certified master decision with a capped entry', () => {
  const analysis = analyzeDigitMarket({
    family: 'matches',
    symbol: 'R_100',
    name: 'Volatility 100',
    horizon: 1,
    ticks: digits(7, true),
    fresh: true,
  });
  const signal = analysis.best;
  assert.equal(signal.master.family, 'digit');
  assert.equal(signal.master.decisive, true);
  assert.ok(signal.master.validity.ticks >= 1);
  assert.ok(signal.master.edgeZ !== null && signal.master.edgeZ > 1.645);
  assert.equal(signal.entry.validForTicks, signal.master.validity.ticks);
  assert.ok(effectiveWindowTicks(signal.entry) <= signal.master.validity.ticks);
  assert.ok(analysis.precisionFit.candidates > 0);
});

test('a fair digit market cannot be certified, however high its confidence looks', () => {
  const analysis = analyzeDigitMarket({
    family: 'matches',
    symbol: 'R_100',
    name: 'Volatility 100',
    horizon: 1,
    ticks: digits(3, false),
    fresh: true,
  });
  const signal = analysis.best;
  assert.equal(signal.master.decisive, false);
  assert.ok(['NO_EDGE', 'SPECULATIVE'].includes(signal.master.verdict));
  assert.ok(signal.master.conviction <= 70);
  assert.equal(signal.entry.validForTicks, signal.master.validity.ticks);
});

test('a rising quote market wires the same master layer into Rise/Fall', () => {
  const analysis = analyzeRiseFallMarket({
    symbol: 'R_100',
    name: 'Volatility 100',
    ticks: quotes(7, 0.12),
    fresh: true,
    horizons: [{ unit: 'ticks', value: 3 }, { unit: 'ticks', value: 5 }],
  });
  const signal = analysis.best;
  assert.equal(signal.master.family, 'rise-fall');
  assert.ok(Number.isFinite(signal.master.edgePts));
  assert.ok(signal.master.validity.ticks >= 1);
  assert.ok(signal.master.sources.some((source) => source.id === 'engines'));
  assert.equal(signal.entry.validForTicks, signal.master.validity.ticks);
  assert.ok(analysis.precisionFit.candidates > 0);
});
