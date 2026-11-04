import { countsOf, normalize, smooth, sum } from './math.ts';

/** Bounded symmetric divergence in bits. Descriptive, not a significance test. */
export function jensenShannon(left: readonly number[], right: readonly number[]): number {
  const p = normalize(left);
  const q = normalize(right);
  return sum(p.map((value, index) => {
    const midpoint = (value + q[index]) / 2;
    return (value > 0 ? value * Math.log2(value / midpoint) / 2 : 0)
      + (q[index] > 0 ? q[index] * Math.log2(q[index] / midpoint) / 2 : 0);
  }));
}

function transitions(digits: readonly number[]) {
  const rows = Array.from({ length: 10 }, () => Array<number>(10).fill(0));
  for (let i = 1; i < digits.length; i += 1) rows[digits[i - 1]][digits[i]] += 1;
  return rows;
}

/** Compare disjoint fitted history and recent live context, including ordering.
 * Fixed conservative thresholds are safety heuristics, not optimized on holdout.
 * A uniform marginal histogram can hide a completely different transition cycle.
 */
export function marketStructure(training: readonly number[], recent: readonly number[]) {
  const reference = training.slice(-500);
  const current = recent.slice(-200);
  const enoughData = reference.length >= 100 && current.length >= 100;
  const marginalDivergence = jensenShannon(smooth(countsOf(reference)), smooth(countsOf(current)));
  const before = transitions(reference);
  const after = transitions(current);
  const comparableRows = before.map((row, digit) => ({
    support: sum(after[digit]),
    usable: sum(row) >= 10 && sum(after[digit]) >= 10,
    divergence: jensenShannon(smooth(row), smooth(after[digit])),
  })).filter((row) => row.usable);
  const comparableTransitions = sum(comparableRows.map((row) => row.support));
  const transitionDivergence = comparableTransitions >= 50
    ? sum(comparableRows.map((row) => row.support * row.divergence)) / comparableTransitions : null;
  const shifted = enoughData && (marginalDivergence > 0.12 || (transitionDivergence !== null && transitionDivergence > 0.25));
  return {
    referenceSample: reference.length, recentSample: current.length,
    marginalDivergence, transitionDivergence, comparableTransitions,
    marginalThreshold: 0.12, transitionThreshold: 0.25,
    status: !enoughData ? 'insufficient' as const : shifted ? 'shifted' as const : 'stable' as const,
  };
}

/** Keep snapshot signals from remaining actionable indefinitely on a live feed. */
export function snapshotExpiryReason(asOfEpoch: number, horizon: number, epochs: readonly number[]): string {
  const latest = epochs.at(-1);
  if (latest === undefined || !Number.isFinite(asOfEpoch)) return 'The analysis context is unavailable. Run analysis again.';
  const newerTicks = epochs.filter((epoch) => epoch > asOfEpoch).length;
  if (latest - asOfEpoch > 60 || newerTicks >= Math.max(20, horizon)) {
    return 'The market has advanced beyond this analysis snapshot. Run analysis again for the current structure.';
  }
  return '';
}
