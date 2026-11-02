import { mean, clamp } from './core.ts';

// Even / Odd engines.

export type EvenOddMetrics = {
  parityProportion50: { even: number; odd: number };
  parityProportion100: { even: number; odd: number };
  parityProportion500: { even: number; odd: number };
  chiSquare: number; chiSquareP: number | null;
  wilsonEven: { lower: number; upper: number };
  wilsonOdd: { lower: number; upper: number };
  currentStreak: { parity: 'even' | 'odd'; length: number };
  maxEvenStreak: number; maxOddStreak: number;
  alternationRatio: number;
  waldWolfowitz: { z: number; p: number };
  markovTransitions: { evenToEven: number; evenToOdd: number; oddToEven: number; oddToOdd: number };
  higherOrder: Record<string, { even: number; odd: number; total: number }>;
};

function parity(d: number): 0 | 1 { return d % 2 === 0 ? 0 : 1; }

function proportions(digits: readonly number[]) {
  let e = 0, o = 0;
  for (const d of digits) if (d % 2 === 0) e += 1; else o += 1;
  const n = e + o;
  return { even: n ? e / n : 0.5, odd: n ? o / n : 0.5 };
}

function chiSquareP9(x: number): number {
  // reuse simple survival approx
  if (x <= 0) return 1;
  // chi-square df=1 survival
  // p = erfc(sqrt(x/2))
  const t = 1 / (1 + 0.3275911 * Math.abs(Math.sqrt(x / 2)));
  const tail = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x / 2);
  return clamp(tail, 0, 1);
}

function wilson(hits: number, n: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const z = 1.959963984540054;
  const p = hits / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const radius = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

export function analyzeEvenOdd(digits: readonly number[]): EvenOddMetrics {
  const d = digits.filter((x) => Number.isInteger(x) && x >= 0 && x <= 9);
  const p50 = proportions(d.slice(-50));
  const p100 = proportions(d.slice(-100));
  const p500 = proportions(d.slice(-500));
  // chi-square 2-cell
  const n = d.length;
  const expected = n / 2;
  const evenCount = d.filter((x) => x % 2 === 0).length;
  const oddCount = n - evenCount;
  const chi2 = ((evenCount - expected) ** 2 / expected) + ((oddCount - expected) ** 2 / expected);
  // streaks
  let curParity: 'even' | 'odd' = d.length ? (d[d.length - 1] % 2 === 0 ? 'even' : 'odd') : 'even';
  let curLen = 0;
  for (let i = d.length - 1; i >= 0; i -= 1) {
    const p = d[i] % 2 === 0 ? 'even' : 'odd';
    if (p !== curParity) break;
    curLen += 1;
  }
  let maxE = 0, maxO = 0, run = 0, runParity: 'even' | 'odd' | null = null;
  for (const x of d) {
    const p = x % 2 === 0 ? 'even' : 'odd';
    if (p === runParity) run += 1; else { run = 1; runParity = p; }
    if (p === 'even') maxE = Math.max(maxE, run); else maxO = Math.max(maxO, run);
  }
  // alternation ratio: switches / (n-1)
  let switches = 0;
  for (let i = 1; i < d.length; i += 1) if (parity(d[i]) !== parity(d[i - 1])) switches += 1;
  const alternationRatio = d.length > 1 ? switches / (d.length - 1) : 0.5;
  // Wald-Wolfowitz runs test
  const runs: number[] = [];
  let r = 1;
  for (let i = 1; i < d.length; i += 1) {
    if (parity(d[i]) === parity(d[i - 1])) r += 1;
    else { runs.push(r); r = 1; }
  }
  if (d.length) runs.push(r);
  const n1 = evenCount, n2 = oddCount;
  const R = runs.length;
  const expectedRuns = (2 * n1 * n2) / Math.max(1, n1 + n2) + 1;
  const varRuns = (2 * n1 * n2 * (2 * n1 * n2 - n1 - n2)) / (Math.max(1, (n1 + n2) ** 2 * (n1 + n2 - 1)));
  const z = varRuns > 0 ? (R - expectedRuns) / Math.sqrt(varRuns) : 0;
  // p-value two-sided approx
  const pVal = 2 * (1 - normalCdf(Math.abs(z)));
  // markov transitions
  let ee = 0, eo = 0, oe = 0, oo = 0;
  for (let i = 1; i < d.length; i += 1) {
    const a = parity(d[i - 1]), b = parity(d[i]);
    if (a === 0 && b === 0) ee += 1;
    else if (a === 0 && b === 1) eo += 1;
    else if (a === 1 && b === 0) oe += 1;
    else oo += 1;
  }
  const norm = (x: number, y: number) => (x + y) ? x / (x + y) : 0.5;
  // higher-order: sequences of parity length up to 3
  const higherOrder: Record<string, { even: number; odd: number; total: number }> = {};
  for (let order = 1; order <= 3; order += 1) {
    for (let i = order; i < d.length; i += 1) {
      const ctx = d.slice(i - order, i).map((x) => (x % 2 === 0 ? 'E' : 'O')).join('');
      const key = `${order}:${ctx}`;
      if (!higherOrder[key]) higherOrder[key] = { even: 0, odd: 0, total: 0 };
      if (d[i] % 2 === 0) higherOrder[key].even += 1; else higherOrder[key].odd += 1;
      higherOrder[key].total += 1;
    }
  }
  return {
    parityProportion50: p50, parityProportion100: p100, parityProportion500: p500,
    chiSquare: chi2, chiSquareP: n >= 20 ? chiSquareP9(chi2) : null,
    wilsonEven: wilson(evenCount, n), wilsonOdd: wilson(oddCount, n),
    currentStreak: { parity: curParity, length: curLen },
    maxEvenStreak: maxE, maxOddStreak: maxO,
    alternationRatio,
    waldWolfowitz: { z, p: pVal },
    markovTransitions: { evenToEven: norm(ee, eo), evenToOdd: norm(eo, ee), oddToEven: norm(oe, oo), oddToOdd: norm(oo, oe) },
    higherOrder,
  };
}

function normalCdf(x: number): number {
  // Abramowitz
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-x * x / 2) * (t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  return x >= 0 ? 1 - p : p;
}
