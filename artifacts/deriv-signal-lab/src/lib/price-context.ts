import type { DigitObservation } from './digit-analysis';

export type PriceContextAnalysis = {
  sampleSize: number;
  asOfEpoch: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  rsi14: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  roc14Percent: number | null;
  realizedVolatility50Percent: number | null;
  swingStructure: 'higher-highs / higher-lows' | 'lower-highs / lower-lows' | 'mixed' | 'insufficient swing history';
  recentSwingHighs: number[];
  recentSwingLows: number[];
};

function emaSeries(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array.from({ length: values.length }, () => null);
  if (values.length < period) return output;
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = ema;
  const alpha = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    ema = alpha * values[index] + (1 - alpha) * ema;
    output[index] = ema;
  }
  return output;
}

function calculateRsi(values: number[], period: number): number | null {
  if (values.length <= period) return null;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

function logReturnVolatility(values: number[], window: number): number | null {
  if (values.length <= window) return null;
  const recent = values.slice(-(window + 1));
  if (recent.some((value) => value <= 0)) return null;
  const returns = recent.slice(1).map((value, index) => Math.log(value / recent[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
  return Number.isFinite(variance) ? Math.sqrt(variance) * 100 : null;
}

function findRecentSwings(values: number[], radius: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = radius; index < values.length - radius; index += 1) {
    const value = values[index];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= radius; offset += 1) {
      if (values[index - offset] >= value || values[index + offset] >= value) isHigh = false;
      if (values[index - offset] <= value || values[index + offset] <= value) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push(value);
    if (isLow) lows.push(value);
  }
  return { highs: highs.slice(-2), lows: lows.slice(-2) };
}

function classifySwingStructure(highs: number[], lows: number[]): PriceContextAnalysis['swingStructure'] {
  if (highs.length < 2 || lows.length < 2) return 'insufficient swing history';
  const [previousHigh, latestHigh] = highs;
  const [previousLow, latestLow] = lows;
  if (latestHigh > previousHigh && latestLow > previousLow) return 'higher-highs / higher-lows';
  if (latestHigh < previousHigh && latestLow < previousLow) return 'lower-highs / lower-lows';
  return 'mixed';
}

/**
 * Calculate price-only, tick-indexed context from validated Deriv observations.
 * These indicators are intentionally not consumed by the digit outcome ranking.
 */
export function analyzePriceContext(observations: Array<Pick<DigitObservation, 'quote' | 'epoch'>>): PriceContextAnalysis {
  const valid = observations.filter((item) => Number.isFinite(item.quote) && item.quote >= 0 && Number.isInteger(item.epoch) && item.epoch > 0).slice(-1_000);
  const values = valid.map(({ quote }) => quote);
  const ema9 = emaSeries(values, 9);
  const ema21 = emaSeries(values, 21);
  const ema50 = emaSeries(values, 50);
  const macdFast = emaSeries(values, 12);
  const macdSlow = emaSeries(values, 26);
  const macdValues: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (macdFast[index] !== null && macdSlow[index] !== null) macdValues.push(macdFast[index]! - macdSlow[index]!);
  }
  const macdSignal = emaSeries(macdValues, 9);
  const line = macdValues.at(-1) ?? null;
  const signal = macdSignal.at(-1) ?? null;
  const swings = findRecentSwings(values.slice(-250), 3);
  const latestQuote = values.at(-1);
  const rocBase = values.length > 14 ? values[values.length - 15] : null;
  const roc14Percent = latestQuote !== undefined && rocBase !== null && rocBase !== 0
    ? ((latestQuote / rocBase) - 1) * 100
    : null;

  return {
    sampleSize: values.length,
    asOfEpoch: valid.at(-1)?.epoch ?? null,
    ema9: ema9.at(-1) ?? null,
    ema21: ema21.at(-1) ?? null,
    ema50: ema50.at(-1) ?? null,
    rsi14: calculateRsi(values, 14),
    macdLine: line,
    macdSignal: signal,
    macdHistogram: line !== null && signal !== null ? line - signal : null,
    roc14Percent,
    realizedVolatility50Percent: logReturnVolatility(values, 50),
    swingStructure: classifySwingStructure(swings.highs, swings.lows),
    recentSwingHighs: swings.highs,
    recentSwingLows: swings.lows,
  };
}
