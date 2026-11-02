import { mean } from './core.ts';

export type MatchesMetrics = {
  drought: number[]; // ticks since last appearance per digit
  maxDrought: number[];
  geometricWaiting: { digit: number; p: number; probWithinK: (k: number) => number }[];
  recurrenceIntervals: { digit: number; mean: number; median: number; max: number; count: number }[];
  transitionMatrix: number[][]; // 10x10
  higherOrderPatterns: { pattern: string; count: number }[];
  autocorrelation: number[]; // lags 1..50
  fftPeaks: { freq: number; magnitude: number }[];
  permutationEntropy: number;
};

function isDigit(x: number) { return Number.isInteger(x) && x >= 0 && x <= 9; }

export function analyzeMatches(digits: readonly number[]): MatchesMetrics {
  const d = digits.filter(isDigit);
  const n = d.length;
  // drought: ticks since last appearance
  const lastSeen = Array(10).fill(-1);
  const drought = Array(10).fill(n); // if never seen, n
  const maxDroughtArr = Array(10).fill(0);
  // track max drought by scanning
  const curDrought = Array(10).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let digit = 0; digit < 10; digit += 1) {
      if (d[i] === digit) { if (curDrought[digit] > maxDroughtArr[digit]) maxDroughtArr[digit] = curDrought[digit]; curDrought[digit] = 0; }
      else curDrought[digit] += 1;
    }
  }
  for (let digit = 0; digit < 10; digit += 1) {
    const idx = d.lastIndexOf(digit);
    drought[digit] = idx < 0 ? n : n - 1 - idx;
    if (curDrought[digit] > maxDroughtArr[digit]) maxDroughtArr[digit] = curDrought[digit];
  }
  // geometric waiting time
  const counts = Array(10).fill(0);
  for (const x of d) counts[x] += 1;
  const geometricWaiting = Array.from({ length: 10 }, (_, digit) => {
    const p = n ? counts[digit] / n : 0.1;
    return { digit, p, probWithinK: (k: number) => 1 - Math.pow(1 - p, Math.max(0, k)) };
  });
  // recurrence intervals
  const recurrenceIntervals = Array.from({ length: 10 }, (_, digit) => {
    const positions: number[] = [];
    for (let i = 0; i < n; i += 1) if (d[i] === digit) positions.push(i);
    const intervals: number[] = [];
    for (let i = 1; i < positions.length; i += 1) intervals.push(positions[i] - positions[i - 1]);
    const sorted = [...intervals].sort((a, b) => a - b);
    const med = sorted.length ? (sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0;
    return { digit, mean: intervals.length ? mean(intervals) : 0, median: med, max: intervals.length ? Math.max(...intervals) : 0, count: intervals.length };
  });
  // 10x10 transition matrix
  const tm = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < n; i += 1) tm[d[i - 1]][d[i]] += 1;
  const tmNorm = tm.map((row) => {
    const s = row.reduce((a, b) => a + b, 0);
    return s ? row.map((c) => c / s) : row.map(() => 0.1);
  });
  // higher-order patterns (length 3)
  const patCounts: Record<string, number> = {};
  for (let i = 0; i + 3 <= n; i += 1) {
    const pat = d.slice(i, i + 3).join('');
    patCounts[pat] = (patCounts[pat] ?? 0) + 1;
  }
  const higherOrderPatterns = Object.entries(patCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([pattern, count]) => ({ pattern, count }));
  // autocorrelation lags 1..50
  const acf: number[] = [];
  const m = mean(d);
  const v = d.reduce((s, x) => s + (x - m) ** 2, 0);
  for (let lag = 1; lag <= 50; lag += 1) {
    if (lag >= n) { acf.push(0); continue; }
    let c = 0;
    for (let i = 0; i < n - lag; i += 1) c += (d[i] - m) * (d[i + lag] - m);
    acf.push(v > 0 ? c / v : 0);
  }
  // FFT (simple DFT) on digit series, find top peaks
  const N = n;
  const magnitudes: { freq: number; mag: number }[] = [];
  // limit to first 256 for performance
  const series = d.slice(-256);
  const M = series.length;
  for (let k = 0; k < Math.floor(M / 2); k += 1) {
    let re = 0, im = 0;
    for (let t = 0; t < M; t += 1) {
      const angle = (2 * Math.PI * k * t) / M;
      re += series[t] * Math.cos(angle);
      im -= series[t] * Math.sin(angle);
    }
    magnitudes.push({ freq: k / M, mag: Math.sqrt(re * re + im * im) / M });
  }
  const fftPeaks = magnitudes
    .map((m, i) => ({ freq: m.freq, magnitude: m.mag }))
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 5);
  // permutation entropy (order 3)
  const order = 3;
  const patterns: Record<string, number> = {};
  let total = 0;
  for (let i = 0; i + order <= n; i += 1) {
    const chunk = d.slice(i, i + order);
    // ordinal pattern
    const indexed = chunk.map((v, idx) => ({ v, idx })).sort((a, b) => a.v - b.v);
    const pat = indexed.map((x) => x.idx).join('');
    patterns[pat] = (patterns[pat] ?? 0) + 1;
    total += 1;
  }
  let pe = 0;
  for (const c of Object.values(patterns)) {
    const p = c / Math.max(1, total);
    if (p > 0) pe -= p * Math.log2(p);
  }
  const maxPE = Math.log2(factorial(order));
  const permutationEntropy = maxPE > 0 ? pe / maxPE : 0;
  return {
    drought, maxDrought: maxDroughtArr,
    geometricWaiting, recurrenceIntervals,
    transitionMatrix: tmNorm,
    higherOrderPatterns, autocorrelation: acf,
    fftPeaks, permutationEntropy,
  };
}

function factorial(n: number): number { let r = 1; for (let i = 2; i <= n; i += 1) r *= i; return r; }
