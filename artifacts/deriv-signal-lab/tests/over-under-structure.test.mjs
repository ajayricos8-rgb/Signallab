import test from 'node:test';
import assert from 'node:assert/strict';
import { jensenShannon, marketStructure, snapshotExpiryReason } from '../src/lib/over-under/structure.ts';
import { canApplyRecommendation } from '../src/lib/trade-draft.ts';

const cycle = (length, step = 1) => Array.from({ length }, (_, index) => (index * step) % 10);

test('Jensen–Shannon divergence is symmetric, bounded and zero for identical distributions', () => {
  assert.equal(jensenShannon([1, 0], [1, 0]), 0);
  assert.equal(jensenShannon([1, 0], [0, 1]), 1);
  assert.equal(jensenShannon([3, 7], [6, 4]), jensenShannon([6, 4], [3, 7]));
});

test('structure checks stationary cycles and detects both balance and ordering changes', () => {
  const stable = marketStructure(cycle(600), cycle(200));
  assert.equal(stable.status, 'stable');
  // Different sample sizes receive different smoothing; still well below the gate.
  assert.ok(stable.transitionDivergence < 0.05);
  const shiftedBalance = marketStructure(cycle(600), Array(200).fill(9));
  assert.equal(shiftedBalance.status, 'shifted');
  assert.ok(shiftedBalance.marginalDivergence > shiftedBalance.marginalThreshold);
  const shiftedOrdering = marketStructure(cycle(600), cycle(200, 7));
  assert.equal(shiftedOrdering.status, 'shifted');
  assert.equal(shiftedOrdering.marginalDivergence, 0);
  assert.ok(shiftedOrdering.transitionDivergence > shiftedOrdering.transitionThreshold);
});

test('structure checks withhold confidence for small samples or unsupported transition rows', () => {
  assert.equal(marketStructure(cycle(50), cycle(200)).status, 'insufficient');
  const sparseRows = marketStructure(cycle(600), cycle(100));
  assert.ok(Number.isFinite(sparseRows.marginalDivergence));
  assert.ok(sparseRows.comparableTransitions <= 99);
});

test('snapshot signals expire after the tick budget or a minute of market advancement', () => {
  assert.equal(snapshotExpiryReason(1000, 1, [999, 1000, 1001]), '');
  assert.match(snapshotExpiryReason(1000, 1, Array.from({ length: 20 }, (_, i) => 1001 + i)), /advanced/);
  assert.equal(snapshotExpiryReason(1000, 30, Array.from({ length: 20 }, (_, i) => 1001 + i)), '');
  assert.match(snapshotExpiryReason(1000, 1, [1061]), /advanced/);
  assert.match(snapshotExpiryReason(1000, 1, []), /unavailable/);
});

test('analysis-to-ticket handoff accepts only current-market supported barriers 1–8', () => {
  const recommendation = { symbol: 'R_100', contractType: 'DIGITOVER', barrier: 5, horizon: 3 };
  assert.equal(canApplyRecommendation(recommendation, 'over-under', 'R_100', [1, 3]), true);
  for (const barrier of [0, 9, -1, 1.5, NaN]) {
    assert.equal(canApplyRecommendation({ ...recommendation, barrier }, 'over-under', 'R_100', [3]), false);
  }
  assert.equal(canApplyRecommendation(recommendation, 'even-odd', 'R_100', [3]), false);
  assert.equal(canApplyRecommendation(recommendation, 'over-under', 'R_50', [3]), false);
  assert.equal(canApplyRecommendation(recommendation, 'over-under', 'R_100', [1]), false);
  assert.equal(canApplyRecommendation(null, 'over-under', 'R_100', [3]), false);
});
