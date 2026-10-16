import { mean, std, variance, clamp, windowOf } from './core.ts';

// Rise / Fall engines.

export type RiseFallMetrics = {
  speed3: number; speed5: number; speed10: number;
  accel3: number; accel5: number; accel10: number;
  positiveTicks: number; negativeTicks: number; imbalance: number;
  tickTrueRange3: number; tickTrueRange5: number; tickTrueRange10: number;
  ema5: number; ema21: number; emaCross: number;
  rsi: number;
  macd: number; macdSignal: number; macdHist: number;
  bollingerMid: number; bollingerUpper: number; bollingerLower: number; bollingerWidth: number;
  hurst: number;
  fractalDimension: number;
  markovTrend: { pRiseGiven1: number; pRiseGiven2: number; pRiseGiven3: number };
  trendBias: number; // -1..1
};

function ema(series: readonly number[], period: number): number {
  if (!series.length) return 0;
  const a = 2 / (period + 1);
  let v = series[0];
  for (let i = 1; i < series.length; i += 1) v = v + a * (series[i] - v);
  return v;
}

function speed(prices: readonly number[], n: number): number {
  const w = windowOf(prices, n);
  if (w.length < 2) return 0;
  // speed = avg price change per tick (per unit time assumed 1 tick)
  let s = 0;
  for (let i = 1; i < w.length; i += 1) s += w[i] - w[i - 1];
  return s / (w.length - 1);
}

function accel(prices: readonly number[], n: number): number {
  const w = windowOf(prices, n);
  if (w.length < 3) return 0;
  const d1: number[] = [];
  for (let i = 1; i < w.length; i += 1) d1.push(w[i] - w[i - 1]);
  let s = 0;
  for (let i = 1; i < d1.length; i += 1) s += d1[i] - d1[i - 1];
  return s / Math.max(1, d1.length - 1);
}

function tickTrueRange(prices: readonly number[], n: number): number {
  const w = windowOf(prices, n);
  if (!w.length) return 0;
  return Math.max(...w) - Math.min(...w);
}

function rsi(prices: readonly number[], n: number): number {
  const w = windowOf(prices, n + 1);
  if (w.length < 2) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i < w.length; i += 1) {
    const d = w[i] - w[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / (w.length - 1);
  const avgLoss = losses / (w.length - 1);
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function bollinger(prices: readonly number[], n: number, k = 2): { mid: number; upper: number; lower: number; width: number } {
  const w = windowOf(prices, n);
  const mid = mean(w);
  const s = std(w);
  return { mid, upper: mid + k * s, lower: mid - k * s, width: 2 * k * s };
}

/** Hurst exponent via R/S analysis. */
export function hurstExponent(series: readonly number[]): number {
  const n = series.length;
  if (n < 20) return 0.5;
  const lags = [Math.floor(n / 4), Math.floor(n / 2), n];
  const rs: number[] = [];
  const logLag: number[] = [];
  for (const lag of lags) {
    if (lag < 8) continue;
    const chunks = Math.floor(n / lag);
    if (chunks < 1) continue;
    let rsSum = 0;
    for (let c = 0; c < chunks; c += 1) {
      const chunk = series.slice(c * lag, (c + 1) * lag);
      const m = mean(chunk);
      const deviations: number[] = [];
      let cum = 0;
      let maxCum = -Infinity, minCum = Infinity;
      for (const x of chunk) {
        const d = x - m;
        deviations.push(d);
        cum += d;
        if (cum > maxCum) maxCum = cum;
        if (cum < minCum) minCum = cum;
      }
      const r = maxCum - minCum;
      const s = std(chunk);
      if (s > 0) rsSum += r / s;
    }
    rs.push(rsSum / chunks);
    logLag.push(Math.log(lag));
  }
  if (rs.length < 2) return 0.5;
  // slope of log(rs) vs log(lag)
  const logRs = rs.map((v) => Math.log(Math.max(1e-9, v)));
  const nPts = logRs.length;
  const mx = logLag.reduce((a, b) => a + b, 0) / nPts;
  const my = logRs.reduce((a, b) => a + b, 0) / nPts;
  let num = 0, den = 0;
  for (let i = 0; i < nPts; i += 1) {
    num += (logLag[i] - mx) * (logRs[i] - my);
    den += (logLag[i] - mx) ** 2;
  }
  const slope = den > 0 ? num / den : 0.5;
  return clamp(slope, 0, 1);
}

/** Fractal dimension index (Higuchi). */
export function fractalDimension(series: readonly number[]): number {
  const n = series.length;
  if (n < 10) return 1.5;
  const kMax = Math.floor(n / 2);
  const lk: number[] = [];
  const logK: number[] = [];
  for (let k = 1; k <= kMax; k += 1) {
    let sumL = 0;
    for (let m = 0; m < k; m += 1) {
      let l = 0;
      const maxI = Math.floor((n - 1 - m) / k);
      for (let i = 1; i <= maxI; i += 1) {
        l += Math.abs(series[m + i * k] - series[m + (i - 1) * k]);
      }
      const norm = (n - 1) / (maxI * k);
      sumL += (l * norm) / k;
    }
    const avgL = sumL / k;
    if (avgL > 0) {
      lk.push(Math.log(avgL));
      logK.push(Math.log(1 / k));
    }
  }
  if (lk.length < 2) return 1.5;
  // slope of log L(k) vs log(1/k)
  const nPts = lk.length;
  const mx = logK.reduce((a, b) => a + b, 0) / nPts;
  const my = lk.reduce((a, b) => a + b, 0) / nPts;
  let num = 0, den = 0;
  for (let i = 0; i < nPts; i += 1) {
    num += (logK[i] - mx) * (lk[i] - my);
    den += (logK[i] - mx) ** 2;
  }
  const slope = den > 0 ? num / den : 1.5;
  return clamp(slope, 1, 2);
}

export function analyzeRiseFall(prices: readonly number[]): RiseFallMetrics {
  const p = prices;
  // markov trend continuation: consecutive up ticks
  const ups: boolean[] = [];
  for (let i = 1; i < p.length; i += 1) ups.push(p[i] > p[i - 1]);
  const countSeq = (len: number): { rise: number; total: number } => {
    let rise = 0, total = 0;
    for (let i = len; i < ups.length; i += 1) {
      let ok = true;
      for (let j = 0; j < len; j += 1) if (!ups[i - 1 - j]) { ok = false; break; }
      if (ok) { total += 1; if (ups[i]) rise += 1; }
    }
    return { rise, total };
  };
  const m1 = countSeq(1); const m2 = countSeq(2); const m3 = countSeq(3);
  const markovTrend = {
    pRiseGiven1: m1.total ? m1.rise / m1.total : 0.5,
    pRiseGiven2: m2.total ? m2.rise / m2.total : 0.5,
    pRiseGiven3: m3.total ? m3.rise / m3.total : 0.5,
  };
  // imbalance over windows
  const last50 = windowOf(p, 50);
  let pos = 0, neg = 0;
  for (let i = 1; i < last50.length; i += 1) {
    const d = last50[i] - last50[i - 1];
    if (d > 0) pos += 1; else if (d < 0) neg += 1;
  }
  const macdSeries = (series: readonly number[]) => {
    const fast = ema(series, 12); // not series ema path; use last
    return fast;
  };
  const fastArr = emaPath(p, 12);
  const slowArr = emaPath(p, 26);
  const macdArr = fastArr.map((v, i) => v - slowArr[i]);
  const signalArr = emaPath(macdArr, 9);
  const bb = bollinger(p, 20);
  const trendBias = clamp((markovTrend.pRiseGiven1 - 0.5) * 2 + (ema(p, 5) - ema(p, 21)) / Math.max(1e-9, std(windowOf(p, 50))), -1, 1);
  return {
    speed3: speed(p, 3), speed5: speed(p, 5), speed10: speed(p, 10),
    accel3: accel(p, 3), accel5: accel(p, 5), accel10: accel(p, 10),
    positiveTicks: pos, negativeTicks: neg, imbalance: (pos - neg) / Math.max(1, pos + neg),
    tickTrueRange3: tickTrueRange(p, 3), tickTrueRange5: tickTrueRange(p, 5), tickTrueRange10: tickTrueRange(p, 10),
    ema5: ema(p, 5), ema21: ema(p, 21), emaCross: ema(p, 5) - ema(p, 21),
    rsi: rsi(p, 14),
    macd: macdArr.at(-1) ?? 0, macdSignal: signalArr.at(-1) ?? 0, macdHist: (macdArr.at(-1) ?? 0) - (signalArr.at(-1) ?? 0),
    bollingerMid: bb.mid, bollingerUpper: bb.upper, bollingerLower: bb.lower, bollingerWidth: bb.width,
    hurst: hurstExponent(p),
    fractalDimension: fractalDimension(p),
    markovTrend,
    trendBias,
  };
}

function emaPath(series: readonly number[], period: number): number[] {
  if (!series.length) return [];
  const a = 2 / (period + 1);
  const out: number[] = [];
  let v = series[0];
  for (const x of series) { v = v + a * (x - v); out.push(v); }
  return out;
}
