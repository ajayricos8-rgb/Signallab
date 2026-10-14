// TICK SELECTION — which of the next five ticks each leg should predict.
//
// The replay walks the verified ticks the feed already holds. For every entry
// tick it looks at the five ticks that followed, and records which position
// (1–5) was the strict highest and which was the strict lowest. Ties are not a
// win for either side, which matches how a tie is treated for a contract that
// needs a single tick to be the extreme.
//
// Each leg then names the position that was the extreme most often. That is a
// description of the collected history, not a forecast: on an independent
// random walk every position is 20% and the chosen position is noise. The
// `z` score says how far the chosen rate sits above that 20% baseline, and the
// automatic selection refuses to name a position unless the score clears the
// operator's threshold. Windows overlap (each tick sits in up to five windows),
// so the nominal standard error is an optimistic reading of the sample.
import {
  HEDGE_BASELINE_RATE,
  HEDGE_TICK_POSITIONS,
  HEDGE_WINDOW_TICKS,
  type HedgeSide,
  type HedgingBotConfig,
  type HedgePrediction,
} from './types.ts';

export type TickQuote = { epoch: number; quote: number };

/**
 * Per-window outcome of the replay. `highPositions[i]` is the 1-based position
 * that was the strict maximum of window `i`, or 0 when no single tick was. The
 * same holds for `lowPositions` and the strict minimum.
 */
export type HedgeReplay = {
  windows: number;
  highPositions: number[];
  lowPositions: number[];
  highCounts: number[];
  lowCounts: number[];
};

export function emptyReplay(): HedgeReplay {
  return {
    windows: 0,
    highPositions: [],
    lowPositions: [],
    highCounts: HEDGE_TICK_POSITIONS.map(() => 0),
    lowCounts: HEDGE_TICK_POSITIONS.map(() => 0),
  };
}

/** Replays the most recent `limit` quotes. Each window is the five ticks after an entry tick. */
export function replayHedgeWindows(quotes: readonly number[], limit: number): HedgeReplay {
  const replay = emptyReplay();
  const start = Math.max(0, quotes.length - Math.max(1, Math.floor(limit)));
  const sample = quotes.slice(start).filter((value) => Number.isFinite(value));
  const last = sample.length - HEDGE_WINDOW_TICKS - 1;
  for (let entry = 0; entry <= last; entry += 1) {
    const window = sample.slice(entry + 1, entry + 1 + HEDGE_WINDOW_TICKS);
    const highPosition = strictExtremePosition(window, 'max');
    const lowPosition = strictExtremePosition(window, 'min');
    replay.windows += 1;
    replay.highPositions.push(highPosition);
    replay.lowPositions.push(lowPosition);
    if (highPosition > 0) replay.highCounts[highPosition - 1] += 1;
    if (lowPosition > 0) replay.lowCounts[lowPosition - 1] += 1;
  }
  return replay;
}

/** 1-based position of the single strict extreme of `window`, or 0 when there is none. */
export function strictExtremePosition(window: readonly number[], kind: 'max' | 'min'): number {
  if (window.length === 0) return 0;
  const target = kind === 'max' ? Math.max(...window) : Math.min(...window);
  let position = 0;
  let count = 0;
  window.forEach((value, index) => {
    if (value === target) {
      count += 1;
      position = index + 1;
    }
  });
  // Two ticks sharing the extreme value means no single tick wins the window.
  return count === 1 ? position : 0;
}

export type TickPositionStat = {
  side: HedgeSide;
  tickPosition: number;
  extremes: number;
  windows: number;
  rate: number | null;
  /** Standard score against the 20% baseline; null when there are no windows. */
  z: number | null;
};

export function tickPositionStats(replay: HedgeReplay, side: HedgeSide): TickPositionStat[] {
  const counts = side === 'HIGH' ? replay.highCounts : replay.lowCounts;
  return HEDGE_TICK_POSITIONS.map((tickPosition, index) => {
    const extremes = counts[index];
    const windows = replay.windows;
    const rate = windows > 0 ? extremes / windows : null;
    return {
      side,
      tickPosition,
      extremes,
      windows,
      rate,
      z: rate === null ? null : standardScore(rate, windows),
    };
  });
}

/** How many standard errors `rate` sits above the 20% baseline, using the nominal binomial error. */
export function standardScore(rate: number, windows: number): number | null {
  if (windows <= 0) return null;
  const error = Math.sqrt((HEDGE_BASELINE_RATE * (1 - HEDGE_BASELINE_RATE)) / windows);
  return error === 0 ? null : (rate - HEDGE_BASELINE_RATE) / error;
}

export type LegChoice = {
  side: HedgeSide;
  /** Null when automatic selection withheld a position; a manual choice is always set. */
  tickPosition: number | null;
  source: 'auto' | 'manual';
  rate: number | null;
  z: number | null;
  windows: number;
  sufficient: boolean;
  note: string;
};

export type JointOutcomes = {
  windows: number;
  bothWin: number;
  onlyHigh: number;
  onlyLow: number;
  neither: number;
};

export type HedgeSelection = {
  windows: number;
  high: LegChoice;
  low: LegChoice;
  /** Joint outcome of the two chosen positions over the replayed windows, or null if either leg is withheld. */
  joint: JointOutcomes | null;
  stats: { high: TickPositionStat[]; low: TickPositionStat[] };
};

function chooseLeg(
  side: HedgeSide,
  stats: TickPositionStat[],
  config: HedgingBotConfig,
  windows: number,
): LegChoice {
  const manual = side === 'HIGH' ? config.manualHighTick : config.manualLowTick;
  if (!config.autoSelectTicks) {
    const picked = stats.find((stat) => stat.tickPosition === manual) ?? null;
    return {
      side,
      tickPosition: manual,
      source: 'manual',
      rate: picked?.rate ?? null,
      z: picked?.z ?? null,
      windows,
      sufficient: windows >= config.minSelectionWindows,
      note: windows >= config.minSelectionWindows
        ? `Manual choice: tick ${manual}.`
        : `Manual choice: tick ${manual}, but only ${windows} replay window(s) exist (${config.minSelectionWindows} recommended).`,
    };
  }

  if (windows < config.minSelectionWindows) {
    return {
      side,
      tickPosition: null,
      source: 'auto',
      rate: null,
      z: null,
      windows,
      sufficient: false,
      note: `Auto selection withheld: ${windows} replay window(s), ${config.minSelectionWindows} needed.`,
    };
  }

  // Highest rate wins; ties go to the earliest position so the choice is stable.
  const best = stats.reduce((top, stat) => (stat.extremes > top.extremes ? stat : top), stats[0]);
  if (best.z === null || best.z < config.minTickEdgeZ) {
    return {
      side,
      tickPosition: null,
      source: 'auto',
      rate: best.rate,
      z: best.z,
      windows,
      sufficient: false,
      note: `Auto selection withheld: the strongest position (tick ${best.tickPosition}, ${best.rate === null ? '—' : `${(best.rate * 100).toFixed(1)}%`}) does not clear the ${config.minTickEdgeZ.toFixed(2)} standard-score threshold over the 20% baseline.`,
    };
  }
  return {
    side,
    tickPosition: best.tickPosition,
    source: 'auto',
    rate: best.rate,
    z: best.z,
    windows,
    sufficient: true,
    note: `Auto selection: tick ${best.tickPosition} was the ${side === 'HIGH' ? 'highest' : 'lowest'} tick in ${best.extremes} of ${windows} windows.`,
  };
}

/** Joint frequency of the two chosen positions across the same windows. */
export function jointOutcomes(replay: HedgeReplay, highPosition: number, lowPosition: number): JointOutcomes {
  let bothWin = 0;
  let onlyHigh = 0;
  let onlyLow = 0;
  let neither = 0;
  for (let index = 0; index < replay.windows; index += 1) {
    const highWon = replay.highPositions[index] === highPosition;
    const lowWon = replay.lowPositions[index] === lowPosition;
    if (highWon && lowWon) bothWin += 1;
    else if (highWon) onlyHigh += 1;
    else if (lowWon) onlyLow += 1;
    else neither += 1;
  }
  return { windows: replay.windows, bothWin, onlyHigh, onlyLow, neither };
}

/** Selects the tick positions for both legs from the most recent ticks. */
export function selectHedgeTicks(quotes: readonly number[], config: HedgingBotConfig): HedgeSelection {
  const replay = replayHedgeWindows(quotes, config.selectionTicks);
  const highStats = tickPositionStats(replay, 'HIGH');
  const lowStats = tickPositionStats(replay, 'LOW');
  const high = chooseLeg('HIGH', highStats, config, replay.windows);
  const low = chooseLeg('LOW', lowStats, config, replay.windows);
  const joint = high.tickPosition !== null && low.tickPosition !== null
    ? jointOutcomes(replay, high.tickPosition, low.tickPosition)
    : null;
  return {
    windows: replay.windows,
    high,
    low,
    joint,
    stats: { high: highStats, low: lowStats },
  };
}

/**
 * Scores analysis-mode predictions against the ticks that followed each entry.
 * A prediction is matched by its entry tick (epoch and quote) and resolves only
 * once all five following ticks are in the buffer. An entry that has rolled out
 * of the buffer, or never resolves within `maxPendingMs`, is expired rather than
 * guessed at.
 */
export function resolveHedgePredictions(
  rows: readonly HedgePrediction[],
  observations: readonly TickQuote[],
  now: number,
  maxPendingMs: number,
): { rows: HedgePrediction[]; changed: boolean } {
  let changed = false;
  const next = rows.map((row) => {
    if (row.resolved || row.expired) return row;
    const index = observations.findIndex((tick) => tick.epoch === row.entryEpoch && tick.quote === row.entryQuote);
    if (index === -1) {
      if (now - row.at > maxPendingMs) {
        changed = true;
        return { ...row, expired: true };
      }
      return row;
    }
    if (index + HEDGE_WINDOW_TICKS >= observations.length) return row;
    const window = observations.slice(index + 1, index + 1 + HEDGE_WINDOW_TICKS).map((tick) => tick.quote);
    changed = true;
    return {
      ...row,
      resolved: true,
      highWon: strictExtremePosition(window, 'max') === row.highTick,
      lowWon: strictExtremePosition(window, 'min') === row.lowTick,
      resolvedAt: now,
    };
  });
  return { rows: next, changed };
}
