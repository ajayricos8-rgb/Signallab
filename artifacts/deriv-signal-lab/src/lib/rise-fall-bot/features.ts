// FEATURE ENGINE — turns the newest verified ticks into the numbers the
// decision engine reads.
//
// This is the port of the reference script's `extract_features`, with one
// change that matters across markets: every threshold-facing value is also
// expressed in verified pips of the selected symbol, so a momentum edge means
// the same thing on Volatility 100 and on a 1-second index. No value here is
// estimated or filled in — too few ticks returns `null`, never a guess.
import type { RiseFallConfig, RiseFallFeatures } from './types.ts';

/** Converts a price distance into pips using Deriv's verified pip size. */
export function priceToPips(value: number, pipSize: number | null): number | null {
  if (!Number.isFinite(value) || pipSize === null || !Number.isFinite(pipSize) || pipSize <= 0) return null;
  return value / pipSize;
}

/** Converts pips into a price distance for the selected symbol. */
export function pipsToPrice(pips: number, pipSize: number | null): number | null {
  if (!Number.isFinite(pips) || pipSize === null || !Number.isFinite(pipSize) || pipSize <= 0) return null;
  return pips * pipSize;
}

export function diffsOf(prices: readonly number[]): number[] {
  const diffs: number[] = [];
  for (let index = 1; index < prices.length; index += 1) {
    const difference = prices[index] - prices[index - 1];
    if (Number.isFinite(difference)) diffs.push(difference);
  }
  return diffs;
}

function trailingStreak(diffs: readonly number[]): { direction: 'up' | 'down' | 'flat'; length: number } {
  if (!diffs.length) return { direction: 'flat', length: 0 };
  const last = diffs[diffs.length - 1];
  const direction: 'up' | 'down' | 'flat' = last > 0 ? 'up' : last < 0 ? 'down' : 'flat';
  let length = 0;
  for (let index = diffs.length - 1; index >= 0; index -= 1) {
    const value = diffs[index];
    const same = direction === 'up' ? value > 0 : direction === 'down' ? value < 0 : value === 0;
    if (!same) break;
    length += 1;
  }
  return { direction, length };
}

function meanAbsolute(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + Math.abs(value), 0) / values.length;
}

/**
 * Reads the newest `tickWindow` quotes. Returns `null` until at least five
 * comparable ticks exist — the decision engine treats that as "no features",
 * which can only ever produce a WAIT.
 */
export function extractFeatures(
  quotes: readonly number[],
  config: RiseFallConfig,
  pipSize: number | null,
  now: number = Date.now(),
): RiseFallFeatures | null {
  const clean = quotes.filter((quote) => Number.isFinite(quote) && quote > 0);
  if (clean.length < 5) return null;
  const prices = clean.slice(-Math.max(5, config.tickWindow));
  const diffs = diffsOf(prices);
  if (diffs.length < 4) return null;

  const up = diffs.filter((difference) => difference > 0).length;
  const down = diffs.filter((difference) => difference < 0).length;
  const flat = diffs.length - up - down;
  const momentumWindow = diffs.slice(-Math.max(1, Math.min(config.momentumTicks, diffs.length)));
  const volatilityWindow = diffs.slice(-Math.max(1, Math.min(config.volatilityTicks, diffs.length)));
  const momentum = momentumWindow.reduce((total, value) => total + value, 0);
  const volatility = meanAbsolute(volatilityWindow);
  const lastMove = diffs[diffs.length - 1];
  const streak = trailingStreak(diffs);

  return {
    sample: prices.length,
    price: prices[prices.length - 1],
    upRatio: up / diffs.length,
    downRatio: down / diffs.length,
    flatRatio: flat / diffs.length,
    momentum,
    momentumPips: priceToPips(momentum, pipSize) ?? momentum,
    volatility,
    volatilityPips: priceToPips(volatility, pipSize) ?? volatility,
    lastMove,
    lastMovePips: priceToPips(lastMove, pipSize) ?? lastMove,
    streakDirection: streak.direction,
    streakLength: streak.length,
    computedAt: now,
  };
}

/** Momentum edge required right now, in pips, after any adaptive scaling. */
export function effectiveMomentumThresholdPips(config: RiseFallConfig, volatilityPips: number): number {
  if (!config.adaptiveThresholds) return config.momentumThresholdPips;
  const scaled = config.adaptiveMultiple * Math.abs(volatilityPips);
  return Number.isFinite(scaled) ? Math.max(config.momentumThresholdPips, scaled) : config.momentumThresholdPips;
}
