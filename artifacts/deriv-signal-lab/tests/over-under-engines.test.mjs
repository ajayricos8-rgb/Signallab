import test from 'node:test';
import assert from 'node:assert/strict';
import { runOverUnderEnsemble, RESEARCH_BARRIERS } from '../src/lib/over-under/ensemble.ts';
import { chiSquareP9, distributionStats, lzComplexity } from '../src/lib/over-under/math.ts';

const contracts = ['DIGITOVER', 'DIGITUNDER'].flatMap((contractType) =>
  RESEARCH_BARRIERS.map((barrier) => ({ family: 'over-under', contractType, barrier })),
);
const ticksOf = (digits) => digits.map((digit, index) => ({ symbol: 'R_100', digit, epoch: 1_700_000_000 + index }));

function seededRandomDigits(count, seed = 420) {
  let state = seed >>> 0;
  return Array.from({ length: count }, () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor((state / 4294967296) * 10);
  });
}

test('a deterministic cycle is learnable and can qualify a barrier inside 1–8', () => {
  const digits = Array.from({ length: 1000 }, (_, index) => (index * 7 + 2) % 10);
  const report = runOverUnderEnsemble(ticksOf(digits), 1, contracts);
  assert.ok(report.selected, 'expected a qualifying candidate on a perfectly repeating cycle');
  assert.ok(report.selected.contract.barrier >= 1 && report.selected.contract.barrier <= 8);
  assert.equal(report.selected.eligible, true);
  assert.ok(report.validation.passed);
  assert.equal(report.engines.length, 12);
  assert.deepEqual(new Set(report.engines.map((engine) => engine.family)), new Set(['markov', 'frequency', 'information', 'streaks', 'trend', 'patterns', 'time-series', 'ml']));
  for (const engine of report.engines) {
    if (engine.probabilities) {
      assert.equal(engine.probabilities.length, 10);
      assert.ok(engine.probabilities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
      assert.ok(Math.abs(engine.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-8);
    }
    assert.ok(Number.isFinite(engine.weight) && engine.weight >= 0);
  }
  assert.equal(report.diagnostics.structure.status, 'stable');
  assert.ok(report.engines.some((engine) => engine.weight > 0));
  // Chronology: tuning and holdout never overlap the training partition.
  assert.ok(report.validation.firstTuningOrigin >= report.validation.trainSample);
  assert.ok(report.validation.firstHoldoutOrigin > report.validation.lastTuningTarget);
});

test('a pseudo-random stream does not produce a qualified barrier', () => {
  const report = runOverUnderEnsemble(ticksOf(seededRandomDigits(2000)), 1, contracts);
  assert.equal(report.selected, null);
  assert.notEqual(report.reason, '');
  assert.ok(report.candidates.every((candidate) => candidate.contract.barrier >= 1 && candidate.contract.barrier <= 8));
});

test('a completed scan still publishes a best-ranked signal with engine votes and factors', () => {
  const report = runOverUnderEnsemble(ticksOf(seededRandomDigits(2000)), 1, contracts);
  // Nothing qualifies on noise, yet the scan must answer rather than go silent.
  assert.ok(report.signal, 'every completed scan publishes a signal');
  assert.equal(report.signal.qualified, false);
  assert.equal(report.signal.candidate, report.candidates[0]);
  assert.match(report.signal.label, /^(OVER|UNDER) [1-8]$/);
  assert.equal(report.signal.enginesTotal, 12);
  assert.equal(report.signal.enginesAgreed, report.candidates[0].votes.filter((vote) => vote.stance === 'support').length);
  assert.ok(report.signal.enginesAgreed <= report.signal.enginesTotal);
  assert.ok(report.signal.familiesAgreed <= report.signal.familiesTotal);
  assert.ok(report.signal.reasons.length > 0, 'an unqualified signal must explain its gates');
  for (const candidate of report.candidates) {
    assert.equal(candidate.votes.length, 12, 'every fitted model votes on every barrier');
    assert.ok(candidate.factors.length >= 6);
    for (const vote of candidate.votes) {
      assert.ok(['support', 'oppose', 'neutral'].includes(vote.stance));
      assert.ok(vote.strength >= 0 && vote.strength <= 1);
      assert.ok(vote.weight >= 0);
      assert.ok(vote.detail.length > 0);
    }
    for (const factor of candidate.factors) {
      assert.ok(factor.score >= 0 && factor.score <= 1);
      assert.ok(factor.weight > 0);
    }
  }
  // A qualifying stream publishes a gate-qualified signal.
  const cycleReport = runOverUnderEnsemble(ticksOf(Array.from({ length: 1000 }, (_, index) => (index * 7 + 2) % 10)), 1, contracts);
  assert.ok(cycleReport.signal);
  assert.equal(cycleReport.signal.qualified, true);
  assert.deepEqual(cycleReport.signal.contract, cycleReport.selected.contract);
});

test('the ensemble streams progress from validation through to the published signal', () => {
  const steps = [];
  runOverUnderEnsemble(ticksOf(seededRandomDigits(1200)), 1, contracts, (percent, phase) => steps.push({ percent, phase }));
  assert.ok(steps.length >= 8, 'fitting and evaluation must report several phases');
  assert.ok(steps.every((step) => step.percent >= 0 && step.percent <= 100 && step.phase.length > 0));
  assert.ok(steps[steps.length - 1].percent >= 95);
  const percents = steps.map((step) => step.percent);
  // Progress never runs backwards while a single scan is in flight.
  assert.ok(percents.every((percent, index) => index === 0 || percent >= percents[index - 1]), 'progress must be monotonic');
  assert.ok(steps.some((step) => /LSTM/i.test(step.phase)), 'local model training is reported');
  assert.ok(steps.some((step) => /held-out/i.test(step.phase)), 'chronological validation is reported');
});

test('research input validation rejects short, disordered or out-of-range requests', () => {
  assert.throws(() => runOverUnderEnsemble(ticksOf(seededRandomDigits(100)), 1, contracts), /500/);
  const disordered = ticksOf(seededRandomDigits(600));
  disordered[10] = { ...disordered[10], epoch: disordered[9].epoch - 5 };
  assert.throws(() => runOverUnderEnsemble(disordered, 1, contracts), /chronological/);
  assert.throws(
    () => runOverUnderEnsemble(ticksOf(seededRandomDigits(600)), 1, [{ family: 'over-under', contractType: 'DIGITOVER', barrier: 9 }]),
    /1 to 8/,
  );
  assert.throws(() => runOverUnderEnsemble(ticksOf(seededRandomDigits(600)), 0, contracts), /horizon/);
});

test('distribution statistics match the uniform null and known chi-square tail', () => {
  const uniform = distributionStats(Array.from({ length: 1000 }, (_, index) => index % 10));
  assert.equal(uniform.chiSquare, 0);
  assert.equal(uniform.chiSquareP, 1);
  assert.ok(Math.abs(uniform.normalizedEntropy - 1) < 1e-9);
  // Chi-square with 9 df: the 95th percentile is about 16.919.
  assert.ok(Math.abs(chiSquareP9(16.919) - 0.05) < 0.002);
  const biased = distributionStats(Array.from({ length: 1000 }, () => 3));
  assert.ok(biased.chiSquareP < 0.0001);
  assert.equal(biased.zScores[3] > 20, true);
});

test('LZ78 compressibility separates repetition from noise without claiming exact Kolmogorov complexity', () => {
  const repeating = lzComplexity(Array.from({ length: 500 }, (_, index) => index % 3));
  const random = lzComplexity(seededRandomDigits(500, 7));
  assert.ok(repeating.ratio < random.ratio);
  assert.ok(repeating.phrases < 500);
});


test('a changed transition regime blocks every barrier even with a uniform histogram', () => {
  const digits = [...Array.from({ length: 800 }, (_, i) => i % 10), ...Array.from({ length: 200 }, (_, i) => (i * 7) % 10)];
  const report = runOverUnderEnsemble(ticksOf(digits), 1, contracts);
  assert.equal(report.diagnostics.structure.status, 'shifted');
  assert.equal(report.selected, null);
  assert.ok(report.candidates.every((candidate) => !candidate.eligible && candidate.reasons.some((reason) => reason.includes('market structure'))));
});
