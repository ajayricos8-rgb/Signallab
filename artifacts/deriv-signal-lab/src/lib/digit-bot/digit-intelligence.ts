// ENGINE B — Digit intelligence engine.
//
// Measures the frequencies, transitions, streaks and recency of the ten final
// digits. Every value here is an *observation* about the sample that exists
// right now. Nothing in this module claims a digit is "due", and no gate in
// the bot is allowed to depend on such a claim.
import { clamp, countsOf, mean, sum, UNIFORM } from '../over-under/math.ts';
import { jensenShannon } from '../over-under/structure.ts';
import type { BotTick, DigitIntelligenceFindings, DigitWindowFinding, StreakFinding, TransitionFinding } from './types.ts';
import { buildWindows } from './data-engine.ts';
import {
  chiSquareUniform,
  dirichletMean,
  effectiveSampleSize,
  ewmaDigitProbabilities,
  entropyBits,
  normalizedEntropy,
  pairFollowProbabilities,
  transitionCounts,
  transitionProbabilities,
} from './statistics.ts';

/** 95th percentile of the chi-square distribution with nine degrees of freedom. */
export const CHI_SQUARE_95_DF9 = 16.919;

export const DIGIT_BASELINE = 0.1;

function windowFinding(window: number, digits: number[]): DigitWindowFinding {
  const counts = countsOf(digits);
  const posterior = dirichletMean(counts);
  const sample = digits.length;
  const parity = digits.reduce<[number, number]>((accumulator, digit) => {
    if (digit % 2 === 0) accumulator[0] += 1;
    else accumulator[1] += 1;
    return accumulator;
  }, [0, 0]);
  const chiSquare = chiSquareUniform(counts);
  const frequencies = sample > 0 ? counts.map((count) => count / sample) : counts.map(() => null);
  const gaps = Array.from({ length: 10 }, (_, digit) => {
    const index = digits.lastIndexOf(digit);
    return index < 0 ? null : digits.length - 1 - index;
  });
  return {
    window,
    sample,
    counts,
    frequencies,
    posterior,
    baselineDeviation: frequencies.map((frequency) => (frequency === null ? 0 : frequency - DIGIT_BASELINE)),
    evenRate: sample > 0 ? parity[0] / sample : null,
    oddRate: sample > 0 ? parity[1] / sample : null,
    entropyBits: sample > 0 ? entropyBits(posterior) : null,
    normalizedEntropy: sample > 0 ? normalizedEntropy(posterior) : null,
    chiSquare: chiSquare.statistic,
    chiSquarePValue: chiSquare.pValue,
    gapsSinceAppearance: gaps,
  };
}

function longestRun(digits: readonly number[], predicate: (digit: number) => boolean): number {
  let longest = 0;
  let current = 0;
  for (const digit of digits) {
    if (predicate(digit)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function currentRun(digits: readonly number[], predicate: (digit: number) => boolean): number {
  let length = 0;
  for (let index = digits.length - 1; index >= 0 && predicate(digits[index]); index -= 1) length += 1;
  return length;
}

function streakFinding(digits: readonly number[], barriers: readonly number[]): StreakFinding {
  const latest = digits.at(-1) ?? null;
  const parityPredicate = (digit: number) => (latest === null ? false : digit % 2 === latest % 2);
  const evenStreak = currentRun(digits, (digit) => digit % 2 === 0);
  const oddStreak = currentRun(digits, (digit) => digit % 2 === 1);
  return {
    currentDigitRun: latest === null ? 0 : currentRun(digits, (digit) => digit === latest),
    longestDigitRun: longestRun(digits, (digit) => digit === (modeOf(digits) ?? digit)),
    currentParityRun: digits.length ? currentRun(digits, parityPredicate) : 0,
    longestParityRun: Math.max(longestRun(digits, (digit) => digit % 2 === 0), longestRun(digits, (digit) => digit % 2 === 1)),
    currentEvenStreak: evenStreak,
    currentOddStreak: oddStreak,
    barrierStreaks: barriers.map((barrier) => {
      const side = latest === null ? 'equal' : latest > barrier ? 'over' : latest < barrier ? 'under' : 'equal';
      const length = side === 'equal' ? currentRun(digits, (digit) => digit === barrier) : currentRun(digits, (digit) => (side === 'over' ? digit > barrier : digit < barrier));
      return { barrier, side: side as 'over' | 'under' | 'equal', length };
    }),
  };
}

function modeOf(digits: readonly number[]): number | null {
  if (!digits.length) return null;
  const counts = countsOf(digits);
  let best = 0;
  for (let digit = 1; digit < counts.length; digit += 1) if (counts[digit] > counts[best]) best = digit;
  return best;
}

export type DigitIntelligenceInput = {
  symbol: string;
  ticks: readonly BotTick[];
  windows: readonly number[];
  barriers: readonly number[];
};

/**
 * Builds the complete digit-intelligence finding for the current market state.
 * Windows that hold fewer genuine ticks than requested report their real
 * sample size; a short window is never padded.
 */
export function analyzeDigitIntelligence(input: DigitIntelligenceInput): DigitIntelligenceFindings {
  const ticks = [...input.ticks].sort((left, right) => left.epoch - right.epoch);
  const digits = ticks.map((tick) => tick.digit);
  const slices = buildWindows(ticks, input.windows);
  const windows = slices.map((slice) => windowFinding(slice.window, slice.digits));
  const counts = countsOf(digits);
  const countsMatrix = transitionCounts(digits);
  const probabilities = transitionProbabilities(countsMatrix);
  const pairs = pairFollowProbabilities(digits);
  const latest = digits.at(-1) ?? null;
  const latestTick = ticks.at(-1) ?? null;
  const chiSquare = chiSquareUniform(counts);
  const posterior = dirichletMean(counts);
  const uniformDivergence = digits.length >= 30 ? jensenShannon(posterior, UNIFORM) : 0;
  const deviations = posterior.map((probability) => probability - DIGIT_BASELINE);
  const maxDeviationPoints = deviations.reduce((largest, value) => (Math.abs(value) > Math.abs(largest) ? value : largest), 0);
  const longWindow = windows.find((window) => window.window === 1_000) ?? windows.at(-1) ?? null;
  const shortWindow = windows.find((window) => window.window === 25) ?? windows[0] ?? null;

  const transitions: TransitionFinding = {
    counts: countsMatrix,
    probabilities,
    sample: Math.max(0, digits.length - 1),
    currentRow: latest === null ? null : probabilities[latest],
    currentRowSample: latest === null ? 0 : sum(countsMatrix[latest]),
    pairCounts: Object.fromEntries(Object.entries(pairs.keys).map(([key, row]) => [key, row.reduce((total, value) => total + value, 0)])),
    pairProbabilities: pairs.current ?? Array.from({ length: 10 }, () => DIGIT_BASELINE),
    pairSample: pairs.sample,
  };

  const recentVsLongTerm = Array.from({ length: 10 }, (_, digit) => {
    const recent = shortWindow && shortWindow.sample > 0 ? (shortWindow.counts[digit] / shortWindow.sample) : DIGIT_BASELINE;
    const long = longWindow && longWindow.sample > 0 ? (longWindow.counts[digit] / longWindow.sample) : DIGIT_BASELINE;
    return recent - long;
  });

  const gaps = Array.from({ length: 10 }, (_, digit) => {
    const index = digits.lastIndexOf(digit);
    return index < 0 ? null : digits.length - 1 - index;
  });

  return {
    symbol: input.symbol,
    sampleSize: digits.length,
    windows,
    lastDigit: latest,
    lastQuote: latestTick?.quote ?? null,
    transitions,
    streaks: streakFinding(digits, input.barriers),
    recency: {
      gaps,
      recentVsLongTerm,
      ewma: ewmaDigitProbabilities(digits),
    },
    parityCounts: [counts[0] + counts[2] + counts[4] + counts[6] + counts[8], counts[1] + counts[3] + counts[5] + counts[7] + counts[9]],
    distribution: {
      chiSquare: chiSquare.statistic,
      chiSquarePValue: chiSquare.pValue,
      degreesOfFreedom: chiSquare.degreesOfFreedom,
      criticalValue: CHI_SQUARE_95_DF9,
      significantAt95: chiSquare.statistic !== null && chiSquare.statistic > CHI_SQUARE_95_DF9,
      uniformDivergenceBits: uniformDivergence,
      maxDeviationPoints,
    },
    entropyBits: digits.length ? entropyBits(posterior) : null,
    normalizedEntropy: digits.length ? normalizedEntropy(posterior) : null,
    notes: [
      'A digit appearing more often in this sample does not make it more likely on the next tick.',
      'A digit missing for a long time is not "due"; recency is recorded as a feature, never as a reason to enter.',
      'Frequencies describe the window that produced them and are recomputed from live ticks on every cycle.',
    ],
  };
}

/** Effective number of independent observations behind the current sample. */
export function digitEffectiveSample(ticks: readonly BotTick[]): number {
  return effectiveSampleSize(ticks.map((tick) => tick.digit));
}

/** Mean absolute deviation of the observed frequencies from the 10% baseline. */
export function meanBaselineDeviation(ticks: readonly BotTick[]): number {
  if (!ticks.length) return 0;
  const counts = countsOf(ticks.map((tick) => tick.digit));
  const frequencies = counts.map((count) => count / ticks.length);
  return mean(frequencies.map((frequency) => Math.abs(frequency - DIGIT_BASELINE)));
}

/** Descriptive streak ceiling: how long a run of this length is on average. */
export function expectedRunLength(probability: number): number | null {
  if (!(probability > 0) || probability >= 1) return null;
  return clamp(1 / (1 - probability), 1, 1e6);
}
