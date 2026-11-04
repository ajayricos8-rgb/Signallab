// Universal data pipeline & core feature store (foundation).
// Normalizes raw tick data into multi-scale sliding windows and computes
// the shared primitives every contract family engine consumes.

export const SLIDING_WINDOWS = [10, 50, 100, 250, 500, 1000, 5000] as const;

export type RawTick = { quote: number | string; epoch: number | string; symbol?: string };

export type Tick = { quote: number; epoch: number; symbol: string; ms: number };

export function normalizeTick(raw: RawTick, fallbackSymbol = ''): Tick | null {
  const quote = Number(raw.quote);
  const epoch = Number(raw.epoch);
  if (!Number.isFinite(quote) || !Number.isFinite(epoch) || quote <= 0 || epoch <= 0) return null;
  return { quote, epoch, symbol: raw.symbol ?? fallbackSymbol, ms: epoch * 1000 };
}

export function normalizeTicks(raw: readonly RawTick[]): Tick[] {
  const out: Tick[] = [];
  for (const r of raw) {
    const t = normalizeTick(r);
    if (t) out.push(t);
  }
  return out.sort((a, b) => a.epoch - b.epoch);
}

/** Last Digit Processor: final decimal digit from a quote string. */
export function lastDigit(quote: number | string): number | null {
  const s = String(quote).trim();
  if (!s) return null;
  // strip trailing non-digits? Keep last digit char.
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const ch = s[i];
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  }
  return null;
}

/** Tick return calculator. */
export function tickReturns(prices: readonly number[]): {
  abs: number[]; pct: number[]; log: number[];
} {
  const abs: number[] = [];
  const pct: number[] = [];
  const log: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const cur = prices[i];
    abs.push(cur - prev);
    pct.push(prev !== 0 ? (cur - prev) / prev : 0);
    log.push(prev > 0 && cur > 0 ? Math.log(cur / prev) : 0);
  }
  return { abs, pct, log };
}

/** Inter-arrival time in ms between consecutive ticks. */
export function interArrivalMs(epochs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < epochs.length; i += 1) {
    out.push((epochs[i] - epochs[i - 1]) * 1000);
  }
  return out;
}

/** Sliding window slice (last N). */
export function windowOf<T>(series: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  return series.slice(Math.max(0, series.length - n));
}

/** Multi-scale windows present in data. */
export function availableWindows(length: number): number[] {
  return SLIDING_WINDOWS.filter((w) => w <= length);
}

export function mean(xs: readonly number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}

export function std(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
