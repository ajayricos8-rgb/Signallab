// Tick analysis and the directional-uniformity gate.
//
// Everything here is a pure function of the tick history the app already
// receives, so the same ticks always produce the same verdict. Two independent
// measurements decide whether a pair is allowed:
//
//   1. UNIFORMITY — is the recent tape one-directional at all? Measured from
//      the signs of tick-to-tick moves (up / down / flat): the directional
//      imbalance (a binomial z), sign persistence (does an up tick follow an
//      up tick, or does the tape alternate?), run structure, and how cleanly
//      the market is stepping.
//
//   2. REPLAY — of the historical 4-tick windows on this tape, how often did
//      price end above / below / exactly at its starting quote? That gives the
//      three outcome probabilities a Mafia pair is exposed to (primary wins,
//      cover wins, flat loses both). The probability is measured, never
//      asserted, and it carries its own sample count.
//
// The gate uses both: uniformity says the tape is coherent, the replay says the
// coherence actually survived four ticks often enough to pay for the pair after
// both stakes are subtracted.
import type { MafiaBotConfig, MafiaDirection } from './types.ts';
import { MAFIA_DURATION_TICKS } from './types.ts';

export type PriceTick = { epoch: number; quote: number };

/** Minimum ticks before the replay can speak; below this the bot only observes. */
const MIN_REPLAY_TICKS = MAFIA_DURATION_TICKS + 1;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Normalizes a feed into strictly increasing, finite, positive ticks. Deriv can
 * repeat an epoch across reconnects; the last value wins so no tick is counted
 * twice and no gap is invented.
 */
export function normalizeMafiaTicks(ticks: readonly PriceTick[]): PriceTick[] {
  const byEpoch = new Map<number, number>();
  for (const tick of ticks) {
    if (!tick || !Number.isFinite(tick.epoch) || !Number.isFinite(tick.quote)) continue;
    if (tick.quote <= 0) continue;
    byEpoch.set(tick.epoch, tick.quote);
  }
  return [...byEpoch.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([epoch, quote]) => ({ epoch, quote }));
}

export type MafiaUniformity = {
  available: boolean;
  sampleSize: number;
  window: number;
  upTicks: number;
  downTicks: number;
  flatTicks: number;
  upShare: number;
  downShare: number;
  flatShare: number;
  directionalZ: number;
  persistenceZ: number;
  continuationRate: number | null;
  reversalRate: number | null;
  longestUpRun: number;
  longestDownRun: number;
  /** Longest same-sign run that would be unremarkable on a fair coin. */
  expectedLongestRun: number;
  runScore: number;
  /** Share of moves that used the market's most common step size. */
  stepConsistency: number;
  stepSize: number | null;
  meanAbsoluteStep: number | null;
  netMove: number | null;
  /** 0–1. Above the config's `minUniformity` the tape counts as one-directional. */
  score: number;
  direction: MafiaDirection | null;
  regime: 'trend' | 'chop' | 'mixed';
  reasons: string[];
  reasonCodes: string[];
};

function emptyUniformity(window: number, reasons: string[], reasonCodes: string[]): MafiaUniformity {
  return {
    available: false,
    sampleSize: 0,
    window,
    upTicks: 0,
    downTicks: 0,
    flatTicks: 0,
    upShare: 0,
    downShare: 0,
    flatShare: 0,
    directionalZ: 0,
    persistenceZ: 0,
    continuationRate: null,
    reversalRate: null,
    longestUpRun: 0,
    longestDownRun: 0,
    expectedLongestRun: 0,
    runScore: 0,
    stepConsistency: 0,
    stepSize: null,
    meanAbsoluteStep: null,
    netMove: null,
    score: 0,
    direction: null,
    regime: 'mixed',
    reasons,
    reasonCodes,
  };
}

function modalValue(values: readonly number[]): { value: number | null; count: number } {
  if (!values.length) return { value: null, count: 0 };
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return { value: best, count: bestCount };
}

/**
 * Measures how one-directional the last `config.uniformityWindow` ticks are.
 *
 * `directionalZ` is the binomial z of the up/down split; `persistenceZ` is the
 * z of sign continuation against alternation in the non-flat sequence. Both are
 * needed: a tape can lean up on the count while alternating wildly, which is
 * exactly the tape a four-tick window cancels out in.
 */
export function measureUniformity(ticks: readonly PriceTick[], config: MafiaBotConfig): MafiaUniformity {
  const window = config.uniformityWindow;
  const clean = normalizeMafiaTicks(ticks);
  if (clean.length < 3) {
    return emptyUniformity(window, ['Waiting for tick history.'], ['NO_TICKS']);
  }

  const used = clean.slice(-window);
  const signs: number[] = [];
  const magnitudes: number[] = [];
  let upTicks = 0;
  let downTicks = 0;
  let flatTicks = 0;
  let longestUpRun = 0;
  let longestDownRun = 0;
  let run = 0;

  for (let index = 1; index < used.length; index += 1) {
    const delta = used[index].quote - used[index - 1].quote;
    const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    magnitudes.push(Math.abs(delta));
    if (sign > 0) upTicks += 1;
    else if (sign < 0) downTicks += 1;
    else flatTicks += 1;
    if (sign === 0) {
      run = 0;
      continue;
    }
    signs.push(sign);
    if (run !== 0 && Math.sign(run) === sign) run += sign;
    else run = sign;
    if (run > 0) longestUpRun = Math.max(longestUpRun, run);
    else longestDownRun = Math.max(longestDownRun, -run);
  }

  const directionalTotal = upTicks + downTicks;
  const diffs = used.length - 1;
  const upShare = upTicks / diffs;
  const downShare = downTicks / diffs;
  const flatShare = flatTicks / diffs;
  const directionalZ = directionalTotal > 0 ? (upTicks - downTicks) / Math.sqrt(directionalTotal) : 0;

  let continuation = 0;
  let reversal = 0;
  for (let index = 1; index < signs.length; index += 1) {
    if (signs[index] === signs[index - 1]) continuation += 1;
    else reversal += 1;
  }
  const transitions = continuation + reversal;
  const continuationRate = transitions ? continuation / transitions : null;
  const reversalRate = transitions ? reversal / transitions : null;
  const persistenceZ = transitions ? (continuation - reversal) / Math.sqrt(transitions) : 0;

  // A fair coin's longest same-sign run among n moves is about log2(n); a run
  // meaningfully longer than that is structural, not luck.
  const expectedLongestRun = signs.length > 1 ? Math.log2(signs.length) : 0;
  const observedLongestRun = Math.max(longestUpRun, longestDownRun);
  const runScore = clamp01((observedLongestRun - expectedLongestRun) / 3);

  const stepMode = modalValue(magnitudes);
  const stepConsistency = magnitudes.length ? stepMode.count / magnitudes.length : 0;
  const meanAbsoluteStep = magnitudes.length
    ? magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length
    : null;
  const netMove = used.length > 1 ? used[used.length - 1].quote - used[0].quote : null;

  // The score weights the count imbalance, the persistence, and the run shape.
  // Direction is only meaningful when the count and the persistence agree:
  // leaning up while alternating is not a trend.
  const dominant = upTicks === downTicks ? null : upTicks > downTicks ? 'CALL' : 'PUT';
  const agrees = dominant !== null && (dominant === 'CALL' ? persistenceZ >= 0 : persistenceZ <= 0);
  const score = dominant === null || !agrees
    ? 0
    : clamp01(0.45 * clamp01(Math.abs(directionalZ) / 3)
      + 0.35 * clamp01(Math.abs(persistenceZ) / 3)
      + 0.2 * runScore);

  const regime: MafiaUniformity['regime'] = persistenceZ >= 1
    ? 'trend'
    : persistenceZ <= -1
      ? 'chop'
      : 'mixed';

  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  if (flatShare > 0.1) {
    reasons.push(`${(flatShare * 100).toFixed(1)}% of ticks were flat — four-tick windows on a flat tape settle level and lose both legs.`);
    reasonCodes.push('FLAT_TAPE');
  }
  if (regime === 'chop') {
    reasons.push('The tape alternates direction more than it persists — a four-tick window tends to cancel out.');
    reasonCodes.push('CHOPPY_TAPE');
  }
  if (dominant !== null && !agrees) {
    reasons.push('Count leans one way but the tape keeps reversing — the lean is not a trend.');
    reasonCodes.push('LEAN_WITHOUT_PERSISTENCE');
  }
  if (stepConsistency > 0 && stepConsistency < 0.8) {
    reasons.push(`Only ${(stepConsistency * 100).toFixed(0)}% of moves used the modal step size — the tape is not stepping cleanly.`);
    reasonCodes.push('IRREGULAR_STEPS');
  }
  if (!reasons.length) {
    reasons.push(dominant === null
      ? 'Up and down ticks are balanced — no direction to trade.'
      : `Tape is ${regime === 'trend' ? 'persistently' : 'leaning'} ${dominant === 'CALL' ? 'up' : 'down'} (score ${score.toFixed(2)}).`);
    reasonCodes.push(dominant === null ? 'BALANCED' : 'UNIFORM');
  }

  return {
    available: true,
    sampleSize: used.length,
    window,
    upTicks,
    downTicks,
    flatTicks,
    upShare,
    downShare,
    flatShare,
    directionalZ,
    persistenceZ,
    continuationRate,
    reversalRate,
    longestUpRun,
    longestDownRun,
    expectedLongestRun,
    runScore,
    stepConsistency,
    stepSize: stepMode.value,
    meanAbsoluteStep,
    netMove,
    score,
    direction: dominant !== null && agrees ? dominant : null,
    regime,
    reasons,
    reasonCodes,
  };
}

export type MafiaReplay = {
  available: boolean;
  samples: number;
  /** Contract length replayed, in ticks. */
  durationTicks: number;
  riseProbability: number | null;
  fallProbability: number | null;
  /** Probability the four-tick window ends exactly where it started. */
  flatProbability: number | null;
  /** Rise/fall hit rate of the measured direction, or null without a direction. */
  directionProbability: number | null;
  direction: MafiaDirection | null;
  meanAbsoluteMove: number | null;
  reasons: string[];
  reasonCodes: string[];
};

/**
 * Replays every historical `durationTicks` window and counts how often price
 * ended above, below, or exactly at its starting quote.
 *
 * This is the honest measurement of what a Mafia pair is exposed to: unlike the
 * usual Rise/Fall "hit rate" it keeps the flat windows visible, because on Step
 * indices a level four-tick window is a real third outcome that loses both
 * legs.
 */
export function replayDirectionOutcomes(
  ticks: readonly PriceTick[],
  durationTicks: number,
  limit: number,
  direction: MafiaDirection | null,
): MafiaReplay {
  const clean = normalizeMafiaTicks(ticks);
  const duration = Math.max(1, Math.round(durationTicks));
  const usable = clean.slice(-Math.max(limit, duration + 1));
  const samples = usable.length - duration;
  const base: MafiaReplay = {
    available: false,
    samples: 0,
    durationTicks: duration,
    riseProbability: null,
    fallProbability: null,
    flatProbability: null,
    directionProbability: null,
    direction,
    meanAbsoluteMove: null,
    reasons: [],
    reasonCodes: [],
  };
  if (usable.length < MIN_REPLAY_TICKS || samples < 1) {
    return { ...base, reasons: ['Not enough ticks to replay a four-tick window.'], reasonCodes: ['NO_REPLAY'] };
  }

  let rise = 0;
  let fall = 0;
  let flat = 0;
  let absoluteMoves = 0;
  for (let index = 0; index + duration < usable.length; index += 1) {
    const delta = usable[index + duration].quote - usable[index].quote;
    absoluteMoves += Math.abs(delta);
    if (delta > 0) rise += 1;
    else if (delta < 0) fall += 1;
    else flat += 1;
  }
  const total = rise + fall + flat;
  const riseProbability = total ? rise / total : null;
  const fallProbability = total ? fall / total : null;
  const flatProbability = total ? flat / total : null;
  const directionProbability = direction === null
    ? null
    : direction === 'CALL'
      ? riseProbability
      : fallProbability;

  const reasons = [`Replayed ${total} four-tick windows: ${rise} ended up, ${fall} down, ${flat} level.`];
  const reasonCodes = ['REPLAY_OK'];
  if (flat > 0) {
    reasons.push(`${flat} of ${total} windows were level — those are the windows where both legs lose.`);
    reasonCodes.push('FLAT_WINDOWS');
  }
  return {
    available: true,
    samples: total,
    durationTicks: duration,
    riseProbability,
    fallProbability,
    flatProbability,
    directionProbability,
    direction,
    meanAbsoluteMove: total ? absoluteMoves / total : null,
    reasons,
    reasonCodes,
  };
}

export type MafiaAnalysis = {
  at: number;
  symbol: string;
  tickCount: number;
  lastTick: PriceTick | null;
  lastTickAgeMs: number | null;
  uniformity: MafiaUniformity;
  replay: MafiaReplay;
};

/**
 * The bot's read of the market: uniformity, then the four-tick replay scored for
 * whichever direction the uniformity picked.
 */
export function analyseMafiaMarket(
  ticks: readonly PriceTick[],
  config: MafiaBotConfig,
  options: { symbol: string; now: number },
): MafiaAnalysis {
  const clean = normalizeMafiaTicks(ticks);
  const uniformity = measureUniformity(clean, config);
  const replay = replayDirectionOutcomes(
    clean,
    MAFIA_DURATION_TICKS,
    config.replayTicks,
    uniformity.direction,
  );
  const lastTick = clean.length ? clean[clean.length - 1] : null;
  return {
    at: options.now,
    symbol: options.symbol,
    tickCount: clean.length,
    lastTick,
    lastTickAgeMs: lastTick === null ? null : Math.max(0, options.now - lastTick.epoch * 1_000),
    uniformity,
    replay,
  };
}

export type UniformityVerdict = {
  passes: boolean;
  reasons: string[];
  reasonCodes: string[];
  /** The single most important blocking reason, for the one-line log entry. */
  headline: string;
};

/**
 * The uniformity gate. A tape passes only when it has a direction AND that
 * direction is carried by the same statistics that produced the score: the
 * count imbalance clears `minUniformityZ`, the sign persistence clears it in
 * the same direction, and the combined score clears `minUniformity`.
 *
 * Each failure names itself so the log explains a WAIT instead of hiding it.
 */
export function verdictOnUniformity(uniformity: MafiaUniformity, config: MafiaBotConfig): UniformityVerdict {
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const reject = (code: string, reason: string) => {
    reasonCodes.push(code);
    reasons.push(reason);
  };

  if (!uniformity.available) {
    reject('NO_UNIFORMITY', 'Tick history is too short to score the tape.');
  } else {
    if (uniformity.direction === null) {
      reject('NO_DIRECTION', uniformity.reasons[0] ?? 'The tape has no coherent direction.');
    }
    if (uniformity.score < config.minUniformity) {
      reject('UNIFORMITY_BELOW_MIN', `Uniformity ${uniformity.score.toFixed(2)} is below the ${config.minUniformity.toFixed(2)} floor.`);
    }
    if (uniformity.direction !== null) {
      const signedZ = uniformity.direction === 'CALL' ? uniformity.directionalZ : -uniformity.directionalZ;
      if (signedZ < config.minUniformityZ) {
        reject('DIRECTIONAL_Z_LOW', `Directional z ${signedZ.toFixed(2)} is below ${config.minUniformityZ.toFixed(2)}.`);
      }
      if (uniformity.persistenceZ < config.minUniformityZ) {
        reject('PERSISTENCE_Z_LOW', `Sign persistence z ${uniformity.persistenceZ.toFixed(2)} is below ${config.minUniformityZ.toFixed(2)} — ticks are reversing, not trending.`);
      }
      if (uniformity.sampleSize < Math.min(20, config.uniformityWindow)) {
        reject('WINDOW_SHORT', `Only ${uniformity.sampleSize} ticks in the ${config.uniformityWindow}-tick window.`);
      }
    }
  }

  return {
    passes: reasons.length === 0,
    reasons,
    reasonCodes,
    headline: reasons[0] ?? 'Uniform direction confirmed.',
  };
}

export type MafiaGatedReplay = {
  available: boolean;
  /** Gated entries whose four ticks have fully printed. */
  samples: number;
  /** Entries examined (gated entries plus entries still inside their window). */
  evaluated: number;
  /** Share of gated entries whose measured direction won its four-tick window. */
  winRate: number | null;
  /** Share that settled exactly level — both legs lost. */
  flatRate: number | null;
  reasons: string[];
  reasonCodes: string[];
};

/**
 * Replays the GATE, not just the market.
 *
 * Only windows where the uniformity gate would have passed are counted, and the
 * outcome is scored for the direction the gate pointed at. That answers the
 * question that actually matters before buying: when this rule says "trade
 * rise", how often does price finish higher four ticks later? The estimate is
 * in-sample, so callers must haircut it for its sample size before treating it
 * as a probability (see `evidenceProbability`).
 */
export function replayGatedOutcomes(
  ticks: readonly PriceTick[],
  config: MafiaBotConfig,
  durationTicks: number = MAFIA_DURATION_TICKS,
): MafiaGatedReplay {
  const clean = normalizeMafiaTicks(ticks).slice(-Math.max(config.replayTicks, config.uniformityWindow + durationTicks + 1));
  const duration = Math.max(1, Math.round(durationTicks));
  const minimumWindow = Math.min(20, config.uniformityWindow);
  let wins = 0;
  let flats = 0;
  let samples = 0;
  let evaluated = 0;

  // The newest entry cannot be scored until its window prints, so the loop
  // stops `duration` ticks short and never counts an open window as a win.
  for (let index = minimumWindow; index + duration < clean.length; index += 1) {
    const windowTicks = clean.slice(Math.max(0, index - config.uniformityWindow + 1), index + 1);
    const uniformity = measureUniformity(windowTicks, config);
    if (!uniformity.direction) continue;
    if (!verdictOnUniformity(uniformity, config).passes) continue;
    evaluated += 1;
    const delta = clean[index + duration].quote - clean[index].quote;
    const won = uniformity.direction === 'CALL' ? delta > 0 : delta < 0;
    const flat = delta === 0;
    samples += 1;
    if (flat) flats += 1;
    else if (won) wins += 1;
  }

  const available = samples > 0;
  return {
    available,
    samples,
    evaluated,
    winRate: available ? wins / samples : null,
    flatRate: available ? flats / samples : null,
    reasons: available
      ? [`The gate fired ${evaluated} times in the replay; ${samples} of those four-tick windows have printed, and ${wins} went the gated way (${flats} flat).`]
      : [`The gate has not fired often enough in the replay to measure itself (${evaluated} entries examined).`],
    reasonCodes: available ? ['GATED_REPLAY_OK'] : ['GATED_REPLAY_EMPTY'],
  };
}
