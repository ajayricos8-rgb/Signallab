// Small, deterministic numerical primitives shared by the local research models.
export const UNIFORM = Array.from({ length: 10 }, () => 0.1);
export const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
export const mean = (values: readonly number[]) => values.length ? sum(values) / values.length : 0;
export const variance = (values: readonly number[]) => {
  const center = mean(values);
  return mean(values.map((value) => (value - center) ** 2));
};

export function normalize(values: readonly number[]): number[] {
  const clean = values.map((value) => Number.isFinite(value) ? Math.max(0, value) : 0);
  const total = sum(clean);
  return total > 0 ? clean.map((value) => value / total) : values.map(() => 1 / values.length);
}

export function countsOf(digits: readonly number[]): number[] {
  const counts = Array<number>(10).fill(0);
  for (const digit of digits) counts[digit] += 1;
  return counts;
}

export function smooth(counts: readonly number[], prior = UNIFORM, strength = 10): number[] {
  return normalize(counts.map((count, index) => count + strength * prior[index]));
}

export function mix(left: readonly number[], right: readonly number[], leftWeight: number): number[] {
  return normalize(left.map((value, index) => value * leftWeight + right[index] * (1 - leftWeight)));
}

export function softmax(logits: readonly number[]): number[] {
  const maximum = Math.max(...logits);
  return normalize(logits.map((value) => Math.exp(clamp(value - maximum, -60, 0))));
}

export function entropy(probabilities: readonly number[]): number {
  return -sum(probabilities.map((p) => p > 0 ? p * Math.log2(p) : 0));
}

// LZ78 dictionary coding estimate, NOT the uncomputable Kolmogorov complexity.
// Includes pointer + symbol costs. A value above one means no compression.
export function lzComplexity(digits: readonly number[]): { phrases: number; ratio: number } {
  if (!digits.length) return { phrases: 0, ratio: 1 };
  const dictionary = new Set<string>();
  let phrase = '';
  let bits = 0;
  for (const digit of digits) {
    phrase += String(digit);
    if (!dictionary.has(phrase)) {
      bits += Math.ceil(Math.log2(dictionary.size + 1)) + Math.log2(10);
      dictionary.add(phrase);
      phrase = '';
    }
  }
  if (phrase) bits += Math.ceil(Math.log2(dictionary.size + 1));
  return { phrases: dictionary.size, ratio: bits / (digits.length * Math.log2(10)) };
}

function erfc(x: number): number {
  // Abramowitz & Stegun approximation; absolute error below 1.5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const tail = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? tail : 2 - tail;
}

export function normalCdf(x: number): number { return 0.5 * erfc(-x / Math.SQRT2); }

/** Chi-square survival probability for the ten-digit uniform null (df = 9). */
export function chiSquareP9(statistic: number): number {
  if (statistic <= 0) return 1;
  const x = statistic / 2;
  let q = erfc(Math.sqrt(x));
  let gamma = Math.sqrt(Math.PI);
  for (let a = 0.5; a < 4.5; a += 1) {
    gamma *= a;
    q += Math.exp(a * Math.log(x) - x - Math.log(gamma));
  }
  return clamp(q, 0, 1);
}

export function distributionStats(digits: readonly number[]) {
  const counts = countsOf(digits);
  const n = digits.length;
  const expected = n / 10;
  const chiSquare = n ? sum(counts.map((count) => (count - expected) ** 2 / expected)) : null;
  const frequencies = n ? counts.map((count) => count / n) : null;
  return {
    sample: n, counts, frequencies, chiSquare,
    // With <5 expected observations/cell the asymptotic p-value is withheld.
    chiSquareP: n >= 50 && chiSquare !== null ? chiSquareP9(chiSquare) : null,
    zScores: counts.map((count) => n ? (count - expected) / Math.sqrt(n * 0.1 * 0.9) : null),
    entropyBits: frequencies ? entropy(frequencies) : null,
    normalizedEntropy: frequencies ? entropy(frequencies) / Math.log2(10) : null,
    compression: lzComplexity(digits),
  };
}

/** Discretized Gaussian: edge buckets absorb tails, every digit remains possible. */
export function gaussianDigits(center: number, deviation: number): number[] {
  const sd = Math.max(0.35, deviation);
  const mu = clamp(center, 0, 9);
  return normalize(UNIFORM.map((_, digit) => {
    const upper = digit === 9 ? 1 : normalCdf((digit + 0.5 - mu) / sd);
    const lower = digit === 0 ? 0 : normalCdf((digit - 0.5 - mu) / sd);
    return Math.max(1e-7, upper - lower);
  }));
}

export function propagate(state: readonly number[], transition: readonly number[][], steps: number): number[] {
  let next = [...state];
  for (let step = 0; step < steps; step += 1) {
    next = normalize(next.map((_, to) => sum(next.map((probability, from) => probability * transition[from][to]))));
  }
  return next;
}

export function brier(probabilities: readonly number[], target: number): number {
  return sum(probabilities.map((p, digit) => (p - Number(digit === target)) ** 2));
}

export function improvementSummary(improvements: readonly number[], z = 1.96) {
  const average = mean(improvements);
  const standardError = improvements.length > 1 ? Math.sqrt(variance(improvements) / (improvements.length - 1)) : Infinity;
  return { mean: average, standardError, lower: average - z * standardError };
}

/** Ridge least squares with pivoted elimination; intercept is weakly regularized. */
export function regress(features: readonly number[][], targets: readonly number[], ridge = 1): number[] {
  const width = features[0]?.length ?? 0;
  const matrix = Array.from({ length: width }, (_, row) => Array.from({ length: width + 1 }, (_, column) => row === column ? (row === 0 ? 1e-6 : ridge) : 0));
  features.forEach((row, index) => {
    for (let j = 0; j < width; j += 1) {
      matrix[j][width] += row[j] * targets[index];
      for (let k = 0; k < width; k += 1) matrix[j][k] += row[j] * row[k];
    }
  });
  for (let column = 0; column < width; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < width; row += 1) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    if (Math.abs(divisor) < 1e-12) continue;
    for (let k = column; k <= width; k += 1) matrix[column][k] /= divisor;
    for (let row = 0; row < width; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let k = column; k <= width; k += 1) matrix[row][k] -= factor * matrix[column][k];
    }
  }
  return matrix.map((row) => Number.isFinite(row[width]) ? row[width] : 0);
}

export const dot = (left: readonly number[], right: readonly number[]) => sum(left.map((value, index) => value * right[index]));

export function seededRandom(seed = 73129) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
