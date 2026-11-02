export type DigitObservation = {
  symbol: string;
  quote: number;
  epoch: number;
  pipSize: number;
  precision: number;
  digit: number;
};

export type DigitWindowStats = {
  window: number;
  sample: number;
  counts: number[];
  frequencies: Array<number | null>;
  weightedFrequencies: Array<number | null>;
  topDigit: number | null;
  leastObservedDigit: number | null;
  entropyBits: number | null;
  normalizedEntropy: number | null;
  evenCount: number;
  oddCount: number;
  evenRate: number | null;
  oddRate: number | null;
  gapsSinceAppearance: Array<number | null>;
};

export type DigitAnalysis = {
  sampleSize: number;
  windows: DigitWindowStats[];
  digitCounts: number[];
  digitFrequencies: Array<number | null>;
  weightedFrequencies: Array<number | null>;
  transitionCounts: number[][];
  transitionProbabilities: Array<Array<number | null>>;
  secondOrderTransitionCounts: number[][][];
  secondOrderTransitionProbabilities: Array<Array<Array<number | null>>>;
  /** One-vs-rest Wilson intervals; not simultaneous family-wise intervals. */
  digitIntervals95: Array<{ lower: number; upper: number } | null>;
  bayesianDigitProbabilities: number[];
  conditionalEntropyBits: number | null;
  mutualInformationBits: number | null;
  parityCounts: [number, number];
  parityTransitions: number[][];
  lastDigit: number | null;
  currentDigitRun: number;
  currentParityRun: number;
  entropyBits: number | null;
  normalizedEntropy: number | null;
  mostFrequentDigit: number | null;
  leastObservedDigit: number | null;
};

export type DigitContractCandidate =
  | { family: 'over-under'; contractType: 'DIGITOVER' | 'DIGITUNDER'; barrier: number }
  | { family: 'even-odd'; contractType: 'DIGITEVEN' | 'DIGITODD' }
  | { family: 'matches'; contractType: 'DIGITMATCH'; targetDigit: number };

export type HistoricalContractOutcomes = {
  candidate: DigitContractCandidate;
  durationTicks: number;
  sample: number;
  hits: number;
  misses: number;
  barrierEqual: number;
  empiricalHitRate: number | null;
  wilson95: { lower: number; upper: number } | null;
  smoothedHistoricalHitRate: number | null;
  contextSample: number;
  contextDigit: number | null;
  contextParity: 0 | 1 | null;
};

const DIGITS = 10;
const WINDOWS = [10, 20, 30, 50, 100, 250, 500, 1_000] as const;
const DEFAULT_DIRICHLET_ALPHA = 0.5;

function isDigit(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 9;
}

/** Return displayed decimal places for a verified power-of-ten pip size, else null. */
export function precisionFromPipSize(pipSize: number): number | null {
  if (!Number.isFinite(pipSize) || pipSize <= 0) return null;
  const exponent = Math.log10(pipSize);
  const roundedExponent = Math.round(exponent);
  const expectedPipSize = 10 ** roundedExponent;
  if (!Number.isFinite(expectedPipSize) || expectedPipSize <= 0) return null;
  if (Math.abs(pipSize - expectedPipSize) > expectedPipSize * 1e-12) return null;
  const precision = Math.max(0, -roundedExponent);
  return precision <= 12 ? precision : null;
}

function decimalScaledInteger(value: number, decimalPlaces: number): bigint | null {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 12) return null;
  const source = value.toString().toLowerCase();
  const [mantissa, exponentSource] = source.split('e');
  const exponent = exponentSource === undefined ? 0 : Number(exponentSource);
  if (!Number.isInteger(exponent)) return null;
  const [whole, fraction = ''] = mantissa.split('.');
  if (!/^\d+$/.test(whole) || (fraction && !/^\d+$/.test(fraction))) return null;

  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + exponent;
  const scaledEnd = decimalPosition + decimalPlaces;
  if (scaledEnd < 0) return null;
  if (scaledEnd < digits.length && /[1-9]/.test(digits.slice(scaledEnd))) return null;
  const scaledDigits = scaledEnd >= digits.length
    ? `${digits}${'0'.repeat(scaledEnd - digits.length)}`
    : digits.slice(0, scaledEnd);
  try {
    return BigInt(scaledDigits || '0');
  } catch {
    return null;
  }
}

/** Extract the final displayed decimal digit using the symbol's verified pip precision. */
export function extractFinalDigit(quote: number, pipSize: number): number | null {
  const precision = precisionFromPipSize(pipSize);
  if (precision === null || !Number.isFinite(quote) || quote < 0) return null;
  const scaled = decimalScaledInteger(quote, precision);
  if (scaled === null) return null;
  const digit = Number(scaled % 10n);
  return isDigit(digit) ? digit : null;
}

function countDigits(digits: number[]): number[] {
  const counts = Array.from({ length: DIGITS }, () => 0);
  for (const digit of digits) if (isDigit(digit)) counts[digit] += 1;
  return counts;
}

function normalizeCounts(counts: number[]): Array<number | null> {
  const sample = counts.reduce((sum, count) => sum + count, 0);
  return counts.map((count) => sample > 0 ? count / sample : null);
}

function recencyWeightedFrequencies(digits: number[], decay = 0.985): Array<number | null> {
  if (!digits.length) return Array.from({ length: DIGITS }, () => null);
  const weights = Array.from({ length: digits.length }, (_, index) => decay ** (digits.length - 1 - index));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return Array.from({ length: DIGITS }, () => null);
  const weighted = Array.from({ length: DIGITS }, () => 0);
  digits.forEach((digit, index) => {
    if (isDigit(digit)) weighted[digit] += weights[index];
  });
  return weighted.map((value) => value / totalWeight);
}

function distributionSummary(digits: number[]): {
  counts: number[];
  frequencies: Array<number | null>;
  weightedFrequencies: Array<number | null>;
  entropyBits: number | null;
  normalizedEntropy: number | null;
  topDigit: number | null;
  leastObservedDigit: number | null;
  evenCount: number;
  oddCount: number;
  evenRate: number | null;
  oddRate: number | null;
  gapsSinceAppearance: Array<number | null>;
} {
  const valid = digits.filter(isDigit);
  const counts = countDigits(valid);
  const sample = valid.length;
  const frequencies = normalizeCounts(counts);
  const entropyBits = sample > 0
    ? frequencies.reduce<number>((entropy, probability) => probability === null || probability === 0 ? entropy : entropy - probability * Math.log2(probability), 0)
    : null;
  const topDigit = sample > 0 ? counts.indexOf(Math.max(...counts)) : null;
  const leastObservedDigit = sample > 0 ? counts.indexOf(Math.min(...counts)) : null;
  const evenCount = counts[0] + counts[2] + counts[4] + counts[6] + counts[8];
  const oddCount = counts[1] + counts[3] + counts[5] + counts[7] + counts[9];
  const gapsSinceAppearance = Array.from({ length: DIGITS }, (_, digit) => {
    const index = valid.lastIndexOf(digit);
    return index < 0 ? null : valid.length - 1 - index;
  });
  return {
    counts,
    frequencies,
    weightedFrequencies: recencyWeightedFrequencies(valid),
    entropyBits,
    normalizedEntropy: entropyBits === null ? null : entropyBits / Math.log2(DIGITS),
    topDigit,
    leastObservedDigit,
    evenCount,
    oddCount,
    evenRate: sample > 0 ? evenCount / sample : null,
    oddRate: sample > 0 ? oddCount / sample : null,
    gapsSinceAppearance,
  };
}

function wilson95(hits: number, sample: number): { lower: number; upper: number } | null {
  if (sample <= 0) return null;
  const z = 1.959963984540054;
  const observed = hits / sample;
  const denominator = 1 + z * z / sample;
  const center = (observed + z * z / (2 * sample)) / denominator;
  const radius = z * Math.sqrt(observed * (1 - observed) / sample + z * z / (4 * sample * sample)) / denominator;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

export function analyzeDigits(input: Array<number | Pick<DigitObservation, 'digit'>>): DigitAnalysis {
  const digits = input
    .map((item) => typeof item === 'number' ? item : item.digit)
    .filter(isDigit)
    .slice(-1_000);
  const overall = distributionSummary(digits);
  const windows = WINDOWS.map((window) => {
    const windowDigits = digits.slice(-window);
    const stats = distributionSummary(windowDigits);
    return {
      window,
      sample: windowDigits.length,
      counts: stats.counts,
      frequencies: stats.frequencies,
      weightedFrequencies: stats.weightedFrequencies,
      topDigit: stats.topDigit,
      leastObservedDigit: stats.leastObservedDigit,
      entropyBits: stats.entropyBits,
      normalizedEntropy: stats.normalizedEntropy,
      evenCount: stats.evenCount,
      oddCount: stats.oddCount,
      evenRate: stats.evenRate,
      oddRate: stats.oddRate,
      gapsSinceAppearance: stats.gapsSinceAppearance,
    } satisfies DigitWindowStats;
  });

  const transitionCounts = Array.from({ length: DIGITS }, () => Array.from({ length: DIGITS }, () => 0));
  const parityTransitions = Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => 0));
  for (let index = 1; index < digits.length; index += 1) {
    transitionCounts[digits[index - 1]][digits[index]] += 1;
    parityTransitions[digits[index - 1] % 2][digits[index] % 2] += 1;
  }
  const transitionProbabilities = transitionCounts.map((row) => {
    const rowSample = row.reduce((sum, count) => sum + count, 0);
    return row.map((count) => rowSample > 0 ? (count + DEFAULT_DIRICHLET_ALPHA) / (rowSample + DIGITS * DEFAULT_DIRICHLET_ALPHA) : null);
  });
  const secondOrderTransitionCounts = Array.from({ length: DIGITS }, () =>
    Array.from({ length: DIGITS }, () => Array.from({ length: DIGITS }, () => 0)));
  for (let index = 2; index < digits.length; index += 1) {
    secondOrderTransitionCounts[digits[index - 2]][digits[index - 1]][digits[index]] += 1;
  }
  const secondOrderTransitionProbabilities = secondOrderTransitionCounts.map((previousDigitRows) =>
    previousDigitRows.map((row) => {
      const rowSample = row.reduce((sum, count) => sum + count, 0);
      // Sparse second-order contexts stay unavailable rather than looking certain.
      return rowSample >= 5
        ? row.map((count) => (count + DEFAULT_DIRICHLET_ALPHA) / (rowSample + DIGITS * DEFAULT_DIRICHLET_ALPHA))
        : row.map(() => null);
    }));
  const transitionSampleByDigit = transitionCounts.map((row) => row.reduce((sum, count) => sum + count, 0));
  const conditionalEntropyBits = digits.length > 1
    ? transitionCounts.reduce((weightedEntropy, row, previousDigit) => {
      const rowSample = transitionSampleByDigit[previousDigit];
      if (!rowSample) return weightedEntropy;
      const rowEntropy = row.reduce((entropy, count) => {
        if (!count) return entropy;
        const probability = count / rowSample;
        return entropy - probability * Math.log2(probability);
      }, 0);
      return weightedEntropy + (rowSample / (digits.length - 1)) * rowEntropy;
    }, 0)
    : null;
  const mutualInformationBits = conditionalEntropyBits === null || overall.entropyBits === null
    ? null : Math.max(0, overall.entropyBits - conditionalEntropyBits);
  const posteriorTotal = digits.length + DIGITS * DEFAULT_DIRICHLET_ALPHA;
  const bayesianDigitProbabilities = overall.counts.map((count) => (count + DEFAULT_DIRICHLET_ALPHA) / posteriorTotal);
  const digitIntervals95 = overall.counts.map((count) => wilson95(count, digits.length));
  const validTransitionDigits = digits;
  const currentDigitRun = validTransitionDigits.length
    ? (() => {
      let length = 1;
      for (let index = validTransitionDigits.length - 2; index >= 0 && validTransitionDigits[index] === validTransitionDigits.at(-1); index -= 1) length += 1;
      return length;
    })()
    : 0;
  const currentParityRun = validTransitionDigits.length
    ? (() => {
      const parity = validTransitionDigits.at(-1)! % 2;
      let length = 1;
      for (let index = validTransitionDigits.length - 2; index >= 0 && validTransitionDigits[index] % 2 === parity; index -= 1) length += 1;
      return length;
    })()
    : 0;

  return {
    sampleSize: digits.length,
    windows,
    digitCounts: overall.counts,
    digitFrequencies: overall.frequencies,
    weightedFrequencies: overall.weightedFrequencies,
    transitionCounts,
    transitionProbabilities,
    secondOrderTransitionCounts,
    secondOrderTransitionProbabilities,
    digitIntervals95,
    bayesianDigitProbabilities,
    conditionalEntropyBits,
    mutualInformationBits,
    parityCounts: [overall.evenCount, overall.oddCount],
    parityTransitions,
    lastDigit: digits.at(-1) ?? null,
    currentDigitRun,
    currentParityRun,
    entropyBits: overall.entropyBits,
    normalizedEntropy: overall.normalizedEntropy,
    mostFrequentDigit: overall.topDigit,
    leastObservedDigit: overall.leastObservedDigit,
  };
}

function wilsonInterval95(hits: number, sample: number): { lower: number; upper: number } | null {
  if (!Number.isInteger(sample) || sample <= 0 || !Number.isInteger(hits) || hits < 0 || hits > sample) return null;
  const z = 1.959963984540054;
  const rate = hits / sample;
  const zSquared = z * z;
  const denominator = 1 + zSquared / sample;
  const center = (rate + zSquared / (2 * sample)) / denominator;
  const radius = (z * Math.sqrt((rate * (1 - rate) / sample) + (zSquared / (4 * sample * sample)))) / denominator;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

export function evaluateHistoricalContract(
  observations: DigitObservation[],
  candidate: DigitContractCandidate,
  durationTicks: number,
  context: { digit?: number; parity?: 0 | 1 } | null = null,
  alpha = DEFAULT_DIRICHLET_ALPHA,
): HistoricalContractOutcomes {
  if (!Number.isInteger(durationTicks) || durationTicks < 1) throw new Error('Duration must be a positive whole number of ticks');
  if (context?.digit !== undefined && !isDigit(context.digit)) throw new Error('Context digit must be an integer from 0 to 9');
  if (context?.parity !== undefined && context.parity !== 0 && context.parity !== 1) throw new Error('Context parity must be even (0) or odd (1)');
  if (!Number.isFinite(alpha) || alpha <= 0) throw new Error('Smoothing alpha must be positive');
  if (candidate.family === 'over-under' && (!isDigit(candidate.barrier) || (candidate.contractType !== 'DIGITOVER' && candidate.contractType !== 'DIGITUNDER'))) {
    throw new Error('Over/Under requires a supported integer barrier and contract type');
  }
  if (candidate.family === 'matches' && (!isDigit(candidate.targetDigit) || candidate.contractType !== 'DIGITMATCH')) {
    throw new Error('Matches target must be an integer from 0 to 9');
  }
  if (candidate.family === 'even-odd' && candidate.contractType !== 'DIGITEVEN' && candidate.contractType !== 'DIGITODD') {
    throw new Error('Even/Odd requires DIGITEVEN or DIGITODD');
  }

  const sampleEnd = observations.length - durationTicks;
  const sampleStart = Math.max(0, observations.length - 2_000);
  let sample = 0;
  let hits = 0;
  let barrierEqual = 0;
  for (let index = sampleStart; index < sampleEnd; index += 1) {
    const entry = observations[index];
    if (context?.digit !== undefined && entry.digit !== context.digit) continue;
    if (context?.parity !== undefined && entry.digit % 2 !== context.parity) continue;
    const finalDigit = observations[index + durationTicks]?.digit;
    if (!isDigit(finalDigit)) continue;
    sample += 1;
    if (candidate.family === 'over-under') {
      if (finalDigit === candidate.barrier) barrierEqual += 1;
      const won = candidate.contractType === 'DIGITOVER'
        ? finalDigit > candidate.barrier
        : finalDigit < candidate.barrier;
      if (won) hits += 1;
    } else if (candidate.family === 'even-odd') {
      const isEven = finalDigit % 2 === 0;
      if ((candidate.contractType === 'DIGITEVEN' && isEven) || (candidate.contractType === 'DIGITODD' && !isEven)) hits += 1;
    } else if (finalDigit === candidate.targetDigit) {
      hits += 1;
    }
  }
  const misses = sample - hits;
  return {
    candidate,
    durationTicks,
    sample,
    hits,
    misses,
    barrierEqual,
    empiricalHitRate: sample > 0 ? hits / sample : null,
    wilson95: wilsonInterval95(hits, sample),
    smoothedHistoricalHitRate: sample > 0 ? (hits + alpha) / (sample + 2 * alpha) : null,
    contextSample: sample,
    contextDigit: context?.digit ?? null,
    contextParity: context?.parity ?? null,
  };
}

export function supportedTickDurations(minDuration: number | null, maxDuration: number | null, maxOptions = 100): number[] {
  if (!Number.isInteger(minDuration) || !Number.isInteger(maxDuration) || minDuration! < 1 || maxDuration! < minDuration! || maxDuration! - minDuration! + 1 > maxOptions) return [];
  return Array.from({ length: maxDuration! - minDuration! + 1 }, (_, index) => minDuration! + index);
}
