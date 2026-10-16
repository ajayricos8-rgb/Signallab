import { mean, clamp } from './core.ts';

export type OverUnderMetrics = {
  digitFrequencies: number[]; // 10
  cumulative: { barrier: number; under: number; over: number }[];
  zScores: number[];
  chiSquare: number; chiSquareP: number | null;
  shannonEntropy: number; normalizedEntropy: number;
  kde: number[]; // smoothed density per digit 0..9
};

function chiSquareP9(x: number): number {
  if (x <= 0) return 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(Math.sqrt(x / 2)));
  const tail = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x / 2);
  return clamp(tail, 0, 1);
}

export function analyzeOverUnder(digits: readonly number[]): OverUnderMetrics {
  const d = digits.filter((x) => Number.isInteger(x) && x >= 0 && x <= 9);
  const n = d.length || 1;
  const counts = Array(10).fill(0);
  for (const x of d) counts[x] += 1;
  const freqs = counts.map((c) => c / n);
  const expected = n / 10;
  const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  // cumulative
  const cumulative: { barrier: number; under: number; over: number }[] = [];
  for (let b = 0; b <= 9; b += 1) {
    let under = 0;
    for (let i = 0; i < b; i += 1) under += counts[i];
    let over = 0;
    for (let i = b + 1; i <= 9; i += 1) over += counts[i];
    cumulative.push({ barrier: b, under: under / n, over: over / n });
  }
  const zScores = counts.map((c) => (c - expected) / Math.sqrt(n * 0.1 * 0.9));
  // shannon entropy
  let h = 0;
  for (const f of freqs) if (f > 0) h -= f * Math.log2(f);
  // KDE over digit positions: gaussian kernel on digit index
  const bandwidth = 0.8;
  const kde = Array.from({ length: 10 }, (_, x) => {
    let s = 0;
    for (const dd of d) {
      const diff = (dd - x) / bandwidth;
      s += Math.exp(-0.5 * diff * diff);
    }
    return s / (n * bandwidth * Math.sqrt(2 * Math.PI));
  });
  // normalize kde
  const ksum = kde.reduce((a, b) => a + b, 0);
  const knorm = ksum > 0 ? kde.map((v) => v / ksum) : kde;
  return {
    digitFrequencies: freqs,
    cumulative,
    zScores,
    chiSquare: chi2,
    chiSquareP: n >= 50 ? chiSquareP9(chi2) : null,
    shannonEntropy: h,
    normalizedEntropy: h / Math.log2(10),
    kde: knorm,
  };
}
