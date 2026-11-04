import { autocorrelation, mean, percentile, standardDeviation, sum } from '../signal-engine/stats.ts';
import type { LabContract, LabHorizon, LabTick } from './types.ts';

export { mean, standardDeviation, sum } from '../signal-engine/stats.ts';
export const finite = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) ? value : null;
export const ratio = (numerator: number, denominator: number) => denominator !== 0 ? finite(numerator / denominator) : null;
export const last = (values: readonly number[]) => values.at(-1) ?? 0;
export const quantile = (values: readonly number[], fraction: number) => percentile(values, fraction);
export const differences = (values: readonly number[]) => values.slice(1).map((value, index) => value - values[index]);
export const entropy = (probabilities: readonly number[]) => -sum(probabilities.map((p) => p > 0 ? p * Math.log2(p) : 0));
export const counts = (values: readonly number[], size: number) => {
  const result = Array<number>(size).fill(0);
  for (const value of values) if (Number.isInteger(value) && value >= 0 && value < size) result[value] += 1;
  return result;
};
export function distribution(values: readonly number[], size: number, prior = 0): number[] {
  const observed = counts(values, size);
  const total = sum(observed) + prior;
  return observed.map((value) => total ? (value + prior / size) / total : 1 / size);
}
export function weightedDistribution(values: readonly number[], size: number, exponential = false): number[] {
  const result = Array<number>(size).fill(0);
  values.forEach((value, index) => { result[value] += exponential ? 2 ** (-(values.length - 1 - index) / 50) : (index + 1) / values.length; });
  const total = sum(result);
  return result.map((value) => total ? value / total : 1 / size);
}
export function transitions(values: readonly number[], size: number): number[][] {
  const table = Array.from({ length: size }, () => Array<number>(size).fill(0));
  for (let index = 1; index < values.length; index += 1) table[values[index - 1]][values[index]] += 1;
  return table;
}
export function normalizeRows(matrix: readonly (readonly number[])[], prior = 1): number[][] {
  return matrix.map((row) => {
    const total = sum(row) + prior * row.length;
    return row.map((value) => total ? (value + prior) / total : 1 / row.length);
  });
}
export function advanceMarkov(matrix: readonly (readonly number[])[], state: number, horizon: number): number[] {
  let probabilities: number[] = matrix.map((_, index) => index === state ? 1 : 0);
  for (let tick = 0; tick < horizon; tick += 1) {
    probabilities = matrix.map((_, to) => sum(probabilities.map((p, from) => p * matrix[from][to])));
  }
  return probabilities;
}
export function contextDistribution(values: readonly number[], size: number, order = 2): { probabilities: number[]; sample: number } {
  const context = values.slice(-order);
  const next: number[] = [];
  for (let index = order; index < values.length; index += 1) {
    if (context.every((value, position) => values[index - order + position] === value)) next.push(values[index]);
  }
  return { probabilities: distribution(next, size, 20), sample: next.length };
}
export function patternCounts(values: readonly number[], order: number): Map<string, number> {
  const table = new Map<string, number>();
  for (let index = order - 1; index < values.length; index += 1) {
    const key = values.slice(index - order + 1, index + 1).join(',');
    table.set(key, (table.get(key) ?? 0) + 1);
  }
  return table;
}
export function rankedPatterns(values: readonly number[], order: number): [string, number][] {
  return [...patternCounts(values, order)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
export function runs(values: readonly number[]): Array<{ state: number; length: number }> {
  const result: Array<{ state: number; length: number }> = [];
  for (const state of values) {
    const previous = result.at(-1);
    if (previous?.state === state) previous.length += 1;
    else result.push({ state, length: 1 });
  }
  return result;
}
export function gapData(values: readonly number[], size: number) {
  const previous = Array<number | null>(size).fill(null);
  const intervals = Array.from({ length: size }, () => [] as number[]);
  values.forEach((state, index) => {
    if (previous[state] !== null) intervals[state].push(index - previous[state]!);
    previous[state] = index;
  });
  return { intervals, gaps: previous.map((index) => index === null ? null : values.length - 1 - index) };
}
export function fanoFactor(values: readonly number[], state: number, blockSize = 20): number | null {
  const blocks: number[] = [];
  for (let start = 0; start + blockSize <= values.length; start += blockSize) blocks.push(values.slice(start, start + blockSize).filter((value) => value === state).length);
  return blocks.length >= 2 ? ratio(standardDeviation(blocks) ** 2, mean(blocks)) : null;
}
export function correlation(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 3) return null;
  const lm = mean(left); const rm = mean(right);
  let numerator = 0; let lv = 0; let rv = 0;
  left.forEach((value, index) => { const a = value - lm; const b = right[index] - rm; numerator += a * b; lv += a * a; rv += b * b; });
  const denominator = Math.sqrt(lv * rv);
  return denominator > 1e-15 ? Math.max(-1, Math.min(1, numerator / denominator)) : null;
}
export function pacf(values: readonly number[], lags = 5): number[] {
  const rho = [1, ...Array.from({ length: lags }, (_, i) => autocorrelation(values, i + 1) ?? 0)];
  let phi: number[] = [];
  let residual = 1;
  const output: number[] = [];
  for (let lag = 1; lag <= lags; lag += 1) {
    const reflection = residual > 1e-12 ? (rho[lag] - sum(phi.map((p, index) => p * rho[lag - index - 1]))) / residual : 0;
    const next = phi.map((p, index) => p - reflection * phi[phi.length - 1 - index]);
    next.push(Math.max(-1, Math.min(1, reflection)));
    phi = next;
    residual *= 1 - reflection ** 2;
    output.push(phi.at(-1)!);
  }
  return output;
}
export function slope(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const center = (values.length - 1) / 2;
  const y = mean(values);
  let top = 0; let bottom = 0;
  values.forEach((value, index) => { top += (index - center) * (value - y); bottom += (index - center) ** 2; });
  return ratio(top, bottom);
}
export function efficiency(values: readonly number[]): number | null {
  return values.length > 1 ? ratio(Math.abs(last(values) - values[0]), sum(differences(values).map(Math.abs))) : null;
}
export function ema(values: readonly number[], period: number): Array<number | null> {
  const output = Array<number | null>(values.length).fill(null);
  if (values.length < period) return output;
  let current = mean(values.slice(0, period));
  output[period - 1] = current;
  for (let index = period; index < values.length; index += 1) { current += 2 / (period + 1) * (values[index] - current); output[index] = current; }
  return output;
}
export function rsi(values: readonly number[], period = 14): Array<number | null> {
  const output = Array<number | null>(values.length).fill(null);
  if (values.length <= period) return output;
  const changes = differences(values);
  let gain = mean(changes.slice(0, period).map((value) => Math.max(0, value)));
  let loss = mean(changes.slice(0, period).map((value) => Math.max(0, -value)));
  const read = () => gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  output[period] = read();
  for (let index = period; index < changes.length; index += 1) {
    gain = (gain * (period - 1) + Math.max(0, changes[index])) / period;
    loss = (loss * (period - 1) + Math.max(0, -changes[index])) / period;
    output[index + 1] = read();
  }
  return output;
}
export function macd(values: readonly number[]) {
  const fast = ema(values, 12); const slow = ema(values, 26);
  const line = values.map((_, index) => fast[index] !== null && slow[index] !== null ? fast[index]! - slow[index]! : null);
  const valid = line.filter((value): value is number => value !== null);
  const signals = ema(valid, 9);
  const signal = [...Array<number | null>(values.length - valid.length).fill(null), ...signals];
  const histogram = line.map((value, index) => value !== null && signal[index] !== null ? value - signal[index]! : null);
  return { line, signal, histogram };
}
export type Candle = { epoch: number; open: number; high: number; low: number; close: number; ticks: number };
/** Exclude the first (possibly partial) bucket and the open last bucket. Never fill absent candles. */
export function closedCandles(ticks: readonly LabTick[], seconds = 60): Candle[] {
  const valid = ticks.filter((tick): tick is LabTick & { quote: number } => Number.isFinite(tick.quote) && Number.isFinite(tick.epoch));
  if (!valid.length) return [];
  const firstBucket = Math.floor(valid[0].epoch / seconds) * seconds;
  const lastBucket = Math.floor(valid.at(-1)!.epoch / seconds) * seconds;
  const bars = new Map<number, Candle>();
  for (const tick of valid) {
    const epoch = Math.floor(tick.epoch / seconds) * seconds;
    if (epoch === lastBucket || (epoch === firstBucket && valid[0].epoch !== firstBucket)) continue;
    const bar = bars.get(epoch);
    if (bar) { bar.high = Math.max(bar.high, tick.quote); bar.low = Math.min(bar.low, tick.quote); bar.close = tick.quote; bar.ticks += 1; }
    else bars.set(epoch, { epoch, open: tick.quote, high: tick.quote, low: tick.quote, close: tick.quote, ticks: 1 });
  }
  return [...bars.values()];
}
export function atr(bars: readonly Candle[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const ranges = bars.slice(1).map((bar, index) => Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index].close), Math.abs(bar.low - bars[index].close)));
  let value = mean(ranges.slice(0, period));
  for (let index = period; index < ranges.length; index += 1) value = (value * (period - 1) + ranges[index]) / period;
  return value;
}
export function kpss(values: readonly number[]): { statistic: number | null; lags: number; stationary: boolean | null } {
  const n = values.length;
  const lags = Math.floor(4 * (n / 100) ** 0.25);
  if (n < 30) return { statistic: null, lags, stationary: null };
  const center = mean(values);
  const centered = values.map((value) => value - center);
  let longVariance = sum(centered.map((value) => value ** 2)) / n;
  for (let lag = 1; lag <= lags; lag += 1) {
    let covariance = 0;
    for (let index = lag; index < n; index += 1) covariance += centered[index] * centered[index - lag];
    longVariance += 2 * (1 - lag / (lags + 1)) * covariance / n;
  }
  let cumulative = 0; let squares = 0;
  for (const value of centered) { cumulative += value; squares += cumulative ** 2; }
  const statistic = longVariance > 1e-15 ? squares / (n ** 2 * longVariance) : null;
  return { statistic, lags, stationary: statistic === null ? null : statistic < 0.463 };
}
export function eventWins(contract: LabContract, state: number): boolean {
  if (contract.family === 'matches') return state === contract.targetDigit;
  if (contract.family === 'even-odd') return state % 2 === (contract.contractType === 'DIGITEVEN' ? 0 : 1);
  if (contract.family === 'over-under') return contract.contractType === 'DIGITOVER' ? state > contract.barrier : state < contract.barrier;
  return state === (contract.direction === 'RISE' ? 0 : 1); // quote state 2 = flat, loss on BOTH
}
export function project(probabilities: readonly number[], contract: LabContract): number {
  return sum(probabilities.map((p, state) => eventWins(contract, state) ? p : 0));
}
export function normalizeTicks(ticks: readonly LabTick[]): LabTick[] {
  const unique = new Map<number, LabTick>();
  for (const tick of ticks) {
    if (!Number.isFinite(tick.epoch) || tick.epoch < 0) continue;
    const quote = Number.isFinite(tick.quote) && tick.quote! > 0 ? tick.quote : undefined;
    const digit = Number.isInteger(tick.digit) && tick.digit! >= 0 && tick.digit! <= 9 ? tick.digit : undefined;
    if (quote !== undefined || digit !== undefined) unique.set(tick.epoch, { epoch: tick.epoch, quote, digit });
  }
  return [...unique.values()].sort((a, b) => a.epoch - b.epoch);
}
/** For time contracts use observed timestamp exits, never an average tick-rate conversion. */
export function horizonExits(epochs: readonly number[], horizon: LabHorizon): number[] {
  if (!Number.isInteger(horizon.value) || horizon.value < 1 || (horizon.unit !== 'ticks' && horizon.unit !== 'minutes')) throw new Error('Invalid research horizon.');
  if (horizon.unit === 'ticks') return epochs.map((_, index) => index + horizon.value < epochs.length ? index + horizon.value : -1);
  let cursor = 0;
  return epochs.map((epoch, origin) => {
    cursor = Math.max(cursor, origin + 1);
    while (cursor < epochs.length && epochs[cursor] < epoch + 60 * horizon.value) cursor += 1;
    return cursor < epochs.length ? cursor : -1;
  });
}
