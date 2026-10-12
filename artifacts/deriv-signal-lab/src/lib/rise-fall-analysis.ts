export type MarketTick = { epoch: number; quote: number };
export type Direction = 'Bullish' | 'Bearish' | 'Neutral' | 'Unavailable';
export type Bias = 'RISE' | 'FALL' | 'WAIT';

export type WindowRead = {
  window: number;
  score: number | null;
  direction: Direction;
  up: number;
  down: number;
  flat: number;
};

export type HistoricalOutcomes = {
  horizon: number;
  sample: number;
  rise: number;
  fall: number;
  unchanged: number;
};

export type RiseFallAnalysis = {
  tickCount: number;
  currentQuote: number | null;
  windows: WindowRead[];
  trendScore: number;
  dowScore: number;
  dowStructure: string;
  momentumScore: number;
  biasScore: number;
  bias: Bias;
  entryState: string;
  rsi14: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  macdHistogram: number | null;
  roc20: number | null;
  averageTickMove14: number | null;
  shortVolatility: number | null;
  longVolatility: number | null;
  volatilityRatio: number | null;
  volatilityRegime: string;
  upPercent100: number | null;
  downPercent100: number | null;
  unchangedPercent100: number | null;
  latestStreak: string;
  historical: HistoricalOutcomes;
  lastEpoch: number | null;
};

const WINDOWS = [20, 50, 100, 250, 500] as const;
const clamp = (value: number, min = -1, max = 1) => Math.min(max, Math.max(min, value));

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values)!;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function exponentialAverage(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let current = values[0];
  for (let index = 1; index < values.length; index += 1) {
    current = alpha * values[index] + (1 - alpha) * current;
  }
  return current;
}

function exponentialSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(alpha * values[index] + (1 - alpha) * result[index - 1]);
  }
  return result;
}

function calculateRsi(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let index = prices.length - period; index < prices.length; index += 1) {
    const change = prices[index] - prices[index - 1];
    if (change > 0) gains += change;
    else if (change < 0) losses -= change;
  }
  const averageGain = gains / period;
  const averageLoss = losses / period;
  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function readWindow(prices: number[], window: number): WindowRead {
  if (prices.length < window) {
    return { window, score: null, direction: 'Unavailable', up: 0, down: 0, flat: 0 };
  }
  const values = prices.slice(-window);
  let up = 0;
  let down = 0;
  let flat = 0;
  let totalMovement = 0;
  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    totalMovement += Math.abs(change);
    if (change > 0) up += 1;
    else if (change < 0) down += 1;
    else flat += 1;
  }
  const score = totalMovement === 0 ? 0 : clamp((values.at(-1)! - values[0]) / totalMovement);
  const direction: Direction = score > 0.12 ? 'Bullish' : score < -0.12 ? 'Bearish' : 'Neutral';
  return { window, score, direction, up, down, flat };
}

function classifySwings(prices: number[]): { label: string; score: number } {
  const radius = 2;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = radius; index < prices.length - radius; index += 1) {
    const value = prices[index];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= radius; offset += 1) {
      if (value <= prices[index - offset] || value <= prices[index + offset]) isHigh = false;
      if (value >= prices[index - offset] || value >= prices[index + offset]) isLow = false;
    }
    if (isHigh) highs.push(value);
    if (isLow) lows.push(value);
  }
  if (highs.length < 2 || lows.length < 2) return { label: 'Not enough confirmed swing points', score: 0 };
  const higherHigh = highs.at(-1)! > highs.at(-2)!;
  const higherLow = lows.at(-1)! > lows.at(-2)!;
  const lowerHigh = highs.at(-1)! < highs.at(-2)!;
  const lowerLow = lows.at(-1)! < lows.at(-2)!;
  if (higherHigh && higherLow) return { label: 'Higher highs and higher lows', score: 1 };
  if (lowerHigh && lowerLow) return { label: 'Lower highs and lower lows', score: -1 };
  return { label: 'Mixed / transitional structure', score: 0 };
}

function percentageReturns(prices: number[], count: number): number[] {
  const start = Math.max(1, prices.length - count);
  const returns: number[] = [];
  for (let index = start; index < prices.length; index += 1) {
    const previous = prices[index - 1];
    if (previous > 0) returns.push(((prices[index] - previous) / previous) * 100);
  }
  return returns;
}

function historicalOutcomes(prices: number[], horizon: number): HistoricalOutcomes {
  const sampleEnd = prices.length - horizon;
  const sampleStart = Math.max(0, prices.length - 500);
  let rise = 0;
  let fall = 0;
  let unchanged = 0;
  for (let index = sampleStart; index < sampleEnd; index += 1) {
    const start = prices[index];
    const finish = prices[index + horizon];
    if (finish > start) rise += 1;
    else if (finish < start) fall += 1;
    else unchanged += 1;
  }
  return { horizon, sample: rise + fall + unchanged, rise, fall, unchanged };
}

function latestStreak(prices: number[]): string {
  if (prices.length < 2) return 'No movement yet';
  const lastChange = Math.sign(prices.at(-1)! - prices.at(-2)!);
  if (lastChange === 0) return 'Latest quote unchanged';
  let length = 0;
  for (let index = prices.length - 1; index > 0; index -= 1) {
    const change = Math.sign(prices[index] - prices[index - 1]);
    if (change !== lastChange) break;
    length += 1;
  }
  return `${length} ${lastChange > 0 ? 'up' : 'down'} tick${length === 1 ? '' : 's'}`;
}

export function analyzeRiseFall(ticks: MarketTick[], expiryTicks: number): RiseFallAnalysis {
  const safeTicks = ticks.filter((tick) => Number.isFinite(tick.epoch) && Number.isFinite(tick.quote) && tick.epoch > 0 && tick.quote > 0);
  const prices = safeTicks.map(({ quote }) => quote);
  const windows = WINDOWS.map((window) => readWindow(prices, window));
  const windowScore = (window: number) => windows.find((item) => item.window === window)?.score ?? 0;
  const availableWindowWeight = WINDOWS.reduce((sum, window) => sum + (windows.find((item) => item.window === window)?.score !== null ? 1 : 0), 0);
  const trendScore = availableWindowWeight
    ? clamp(WINDOWS.reduce((sum, window) => sum + windowScore(window), 0) / availableWindowWeight)
    : 0;

  const ema9 = exponentialAverage(prices, 9);
  const ema21 = exponentialAverage(prices, 21);
  const ema50 = exponentialAverage(prices, 50);
  const rsi14 = calculateRsi(prices, 14);
  const fastEmaSeries = exponentialSeries(prices, 12);
  const slowEmaSeries = exponentialSeries(prices, 26);
  const macdLine = fastEmaSeries.map((fast, index) => fast - slowEmaSeries[index]);
  const macdSignal = exponentialAverage(macdLine, 9);
  const macdHistogram = macdLine.length >= 34 && macdSignal !== null ? macdLine.at(-1)! - macdSignal : null;
  const roc20 = prices.length >= 21 && prices.at(-21)! !== 0
    ? ((prices.at(-1)! - prices.at(-21)!) / prices.at(-21)!) * 100
    : null;
  const recentPrices = prices.slice(-15);
  const recentMoves = recentPrices.slice(1).map((price, index) => price - recentPrices[index]);
  const averageTickMove14 = recentMoves.length ? mean(recentMoves.map(Math.abs)) : null;
  const emaScore = ema9 !== null && ema21 !== null && averageTickMove14 && averageTickMove14 > 0
    ? Math.tanh((ema9 - ema21) / (averageTickMove14 * 4))
    : 0;
  const rsiScore = rsi14 === null ? 0 : clamp((rsi14 - 50) / 35);
  const macdScore = macdHistogram !== null && averageTickMove14 && averageTickMove14 > 0
    ? Math.tanh(macdHistogram / (averageTickMove14 * 5))
    : 0;
  const momentumScore = clamp(0.3 * rsiScore + 0.3 * emaScore + 0.2 * macdScore + 0.2 * windowScore(20));

  const shortVolatility = standardDeviation(percentageReturns(prices, 20));
  const longVolatility = standardDeviation(percentageReturns(prices, 100));
  const volatilityRatio = shortVolatility !== null && longVolatility !== null && longVolatility > 0
    ? shortVolatility / longVolatility
    : null;
  const swing = classifySwings(prices.slice(-500));
  const dowScore = clamp(0.55 * swing.score + 0.25 * windowScore(250) + 0.2 * windowScore(100));
  const broadDirection = windows.find((item) => item.window === 250)?.direction ?? 'Unavailable';
  const intermediateDirection = windows.find((item) => item.window === 100)?.direction ?? 'Unavailable';
  const shortDirection = windows.find((item) => item.window === 20)?.direction ?? 'Unavailable';

  let entryState = 'Waiting for enough history';
  if (broadDirection !== 'Unavailable' && intermediateDirection !== 'Unavailable') {
    if (broadDirection !== 'Neutral' && intermediateDirection !== 'Neutral' && broadDirection !== intermediateDirection) {
      entryState = 'Conflicted timeframes';
    } else if (broadDirection === intermediateDirection && broadDirection !== 'Neutral' && shortDirection !== broadDirection) {
      entryState = 'Pullback / counter-move';
    } else if (broadDirection === intermediateDirection && broadDirection === shortDirection && broadDirection !== 'Neutral') {
      const aligned = broadDirection === 'Bullish'
        ? ema9 !== null && prices.at(-1)! >= ema9
        : ema9 !== null && prices.at(-1)! <= ema9;
      entryState = aligned ? 'Directional alignment (unconfirmed)' : 'Waiting for entry trigger';
    } else {
      entryState = 'No aligned entry setup';
    }
  }

  let volatilityRegime = 'Insufficient history';
  if (volatilityRatio !== null) {
    if (volatilityRatio >= 1.5) volatilityRegime = 'Volatility expansion';
    else if (volatilityRatio <= 0.67) volatilityRegime = 'Volatility contraction';
    else if (Math.abs(trendScore) >= 0.4) volatilityRegime = 'Directional movement';
    else volatilityRegime = 'Range / mixed';
  }

  const last100 = prices.slice(-100);
  let up = 0;
  let down = 0;
  let unchanged = 0;
  for (let index = 1; index < last100.length; index += 1) {
    const change = last100[index] - last100[index - 1];
    if (change > 0) up += 1;
    else if (change < 0) down += 1;
    else unchanged += 1;
  }
  const directionalCount = up + down + unchanged;
  const biasScore = clamp(0.4 * dowScore + 0.35 * trendScore + 0.25 * momentumScore);
  const bias: Bias = biasScore >= 0.18 ? 'RISE' : biasScore <= -0.18 ? 'FALL' : 'WAIT';
  const expiry = Math.max(1, Math.min(50, Math.floor(expiryTicks) || 1));

  return {
    tickCount: prices.length,
    currentQuote: prices.at(-1) ?? null,
    windows,
    trendScore,
    dowScore,
    dowStructure: swing.label,
    momentumScore,
    biasScore,
    bias,
    entryState,
    rsi14,
    ema9,
    ema21,
    ema50,
    macdHistogram,
    roc20,
    averageTickMove14,
    shortVolatility,
    longVolatility,
    volatilityRatio,
    volatilityRegime,
    upPercent100: directionalCount ? (up / directionalCount) * 100 : null,
    downPercent100: directionalCount ? (down / directionalCount) * 100 : null,
    unchangedPercent100: directionalCount ? (unchanged / directionalCount) * 100 : null,
    latestStreak: latestStreak(prices),
    historical: historicalOutcomes(prices, expiry),
    lastEpoch: safeTicks.at(-1)?.epoch ?? null,
  };
}
