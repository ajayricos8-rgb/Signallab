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

/**
 * Snapshot lifecycle on a live feed.
 *
 * A scan is fitted on up to 2,000 ticks, so a handful of newer ticks does not
 * invalidate the measured structure — but a signal also must not stay presented
 * as current forever. The lifecycle therefore has three honest states:
 *
 *   · `current` — the snapshot still describes the live market. This is the only
 *     state that may pre-fill a trade ticket.
 *   · `aging`   — the market has moved on. The signal, its engine agreement and
 *     its confidence stay visible (they were measured, not guessed) with a
 *     re-run notice, instead of collapsing into a "blocked" error.
 *   · `expired` — too much market has passed for the snapshot to be presented as
 *     anything but history.
 */
export type SnapshotAgeState = 'current' | 'aging' | 'expired' | 'unavailable';

export type SnapshotAge = {
  state: SnapshotAgeState;
  newerTicks: number;
  ageSeconds: number;
  /** Non-empty only for `expired` / `unavailable`: the snapshot is not usable. */
  reason: string;
  /** Non-empty for `aging`: keep showing the signal with this notice. */
  notice: string;
  /** True when the snapshot may pre-fill the trade dock. */
  actionable: boolean;
};

/** Ticks after which a snapshot is aging rather than current. */
const CURRENT_TICK_BUDGET = 20;
/** Seconds of market time after which a snapshot is aging rather than current. */
const CURRENT_SECOND_BUDGET = 60;
/** Hard limits: beyond these the snapshot is history, not a signal. */
const EXPIRED_SECOND_BUDGET = 900;
const EXPIRED_TICK_BUDGET = 900;

export function snapshotAge(asOfEpoch: number, horizon: number, epochs: readonly number[]): SnapshotAge {
  const latest = epochs.at(-1);
  if (latest === undefined || !Number.isFinite(asOfEpoch)) {
    return { state: 'unavailable', newerTicks: 0, ageSeconds: 0, reason: 'The analysis context is unavailable. Run analysis again.', notice: '', actionable: false };
  }
  const newerTicks = epochs.filter((epoch) => epoch > asOfEpoch).length;
  const ageSeconds = Math.max(0, latest - asOfEpoch);
  const tickBudget = Math.max(CURRENT_TICK_BUDGET, horizon);
  if (newerTicks < tickBudget && ageSeconds <= CURRENT_SECOND_BUDGET) {
    return { state: 'current', newerTicks, ageSeconds, reason: '', notice: '', actionable: true };
  }
  if (ageSeconds <= EXPIRED_SECOND_BUDGET && newerTicks < EXPIRED_TICK_BUDGET) {
    return {
      state: 'aging', newerTicks, ageSeconds, reason: '', actionable: false,
      notice: `Snapshot is ${ageSeconds}s old and the market has printed ${newerTicks} newer ticks. The measured signal and confidence still describe that scan — re-run analysis for the current structure before trading.`,
    };
  }
  return {
    state: 'expired', newerTicks, ageSeconds, actionable: false, notice: '',
    reason: 'The market has advanced beyond this analysis snapshot. Run analysis again for the current structure.',
  };
}

/**
 * Reason text for a snapshot that can no longer be presented as a signal.
 * Returns an empty string while the snapshot is current OR aging.
 */
export function snapshotExpiryReason(asOfEpoch: number, horizon: number, epochs: readonly number[]): string {
  return snapshotAge(asOfEpoch, horizon, epochs).reason;
}
