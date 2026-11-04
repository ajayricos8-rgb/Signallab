// Pure helpers for the shared multi-market Deriv feed used by every tool.
// No sockets or React here, so the parsing and merge rules are unit-testable.
import { extractFinalDigit, precisionFromPipSize } from './digit-analysis.ts';
import { parseFiniteNumber, parseInteger, type DigitMarketSymbol } from './deriv-digit-metadata.ts';

export const FEED_HISTORY_LIMIT = 2_000;
export const FEED_STALE_AFTER_MS = 15_000;

/** One validated tick. `digit` is null when the pip precision is unknown. */
export type FeedTick = { epoch: number; quote: number; digit: number | null };

export type ScanMarket = {
  symbol: string;
  name: string;
  pipSize: number | null;
  precision: number | null;
  exchangeOpen: boolean | null;
  tradingSuspended: boolean | null;
};

const VOLATILITY_PATTERN = /^(?:R_(\d+)|1HZ(\d+)V)$/;

const fallback = (symbol: string, name: string): ScanMarket => ({ symbol, name, pipSize: null, precision: null, exchangeOpen: null, tradingSuspended: null });

/** Used when Deriv's active-symbol list is unavailable. */
export const FALLBACK_SCAN_MARKETS: ScanMarket[] = [
  fallback('R_10', 'Volatility 10 Index'),
  fallback('R_25', 'Volatility 25 Index'),
  fallback('R_50', 'Volatility 50 Index'),
  fallback('R_75', 'Volatility 75 Index'),
  fallback('R_100', 'Volatility 100 Index'),
  fallback('1HZ10V', 'Volatility 10 (1s) Index'),
  fallback('1HZ15V', 'Volatility 15 (1s) Index'),
  fallback('1HZ25V', 'Volatility 25 (1s) Index'),
  fallback('1HZ30V', 'Volatility 30 (1s) Index'),
  fallback('1HZ50V', 'Volatility 50 (1s) Index'),
  fallback('1HZ75V', 'Volatility 75 (1s) Index'),
  fallback('1HZ90V', 'Volatility 90 (1s) Index'),
  fallback('1HZ100V', 'Volatility 100 (1s) Index'),
];

/** Continuous volatility indices: the markets every tool scans. */
export function isScanMarket(symbol: string): boolean {
  return VOLATILITY_PATTERN.test(symbol);
}

function scanOrder(symbol: string): [number, number] {
  const match = VOLATILITY_PATTERN.exec(symbol);
  if (!match) return [2, 0];
  return match[1] !== undefined ? [0, Number(match[1])] : [1, Number(match[2])];
}

export function compareScanMarkets(left: string, right: string): number {
  const [leftGroup, leftNumber] = scanOrder(left);
  const [rightGroup, rightNumber] = scanOrder(right);
  return leftGroup - rightGroup || leftNumber - rightNumber || left.localeCompare(right);
}

/** Volatility indices from Deriv's active-symbol list, in a stable order. */
export function selectScanMarkets(symbols: readonly DigitMarketSymbol[]): ScanMarket[] {
  const picked = symbols
    .filter((item) => isScanMarket(item.symbol))
    .map((item) => ({
      symbol: item.symbol,
      name: item.name && item.name !== item.symbol ? item.name : FALLBACK_SCAN_MARKETS.find((market) => market.symbol === item.symbol)?.name ?? item.symbol,
      pipSize: item.pipSize,
      precision: item.precision,
      exchangeOpen: item.exchangeOpen,
      tradingSuspended: item.tradingSuspended,
    }))
    .sort((left, right) => compareScanMarkets(left.symbol, right.symbol));
  return picked.length ? picked : FALLBACK_SCAN_MARKETS;
}

/**
 * Tick and history responses report `pip_size` as decimal places (e.g. 2);
 * active symbols report the minimum move (e.g. 0.01). Both become a pip size.
 */
export function pipSizeFromResponse(value: unknown): number | null {
  const parsed = parseFiniteNumber(value);
  if (parsed === null || parsed < 0) return null;
  if (Number.isInteger(parsed) && parsed <= 12) return 10 ** -parsed;
  return precisionFromPipSize(parsed) === null ? null : parsed;
}

/** Prefer verified metadata when it agrees; otherwise trust the response's own precision. */
export function resolvePipSize(metadataPipSize: number | null, responsePipSize: unknown): number | null {
  const fromResponse = pipSizeFromResponse(responsePipSize);
  if (metadataPipSize !== null && fromResponse !== null) {
    return Math.abs(metadataPipSize - fromResponse) <= metadataPipSize * 1e-9 ? metadataPipSize : fromResponse;
  }
  return metadataPipSize ?? fromResponse;
}

export function toFeedTick(quoteValue: unknown, epochValue: unknown, pipSize: number | null): FeedTick | null {
  const quote = parseFiniteNumber(quoteValue);
  const epoch = parseInteger(epochValue);
  if (quote === null || epoch === null || quote <= 0 || epoch <= 0) return null;
  return { epoch, quote, digit: pipSize === null ? null : extractFinalDigit(quote, pipSize) };
}

export function historyToTicks(prices: readonly unknown[], times: readonly unknown[], pipSize: number | null): FeedTick[] {
  const ticks: FeedTick[] = [];
  const count = Math.min(prices.length, times.length);
  for (let index = 0; index < count; index += 1) {
    const tick = toFeedTick(prices[index], times[index], pipSize);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

/** Chronological merge keyed by epoch (newest data wins), bounded to `limit`. */
export function mergeTicks(current: readonly FeedTick[], incoming: readonly FeedTick[], limit = FEED_HISTORY_LIMIT): FeedTick[] {
  if (!incoming.length) return current.length > limit ? current.slice(-limit) : [...current];
  const last = current.at(-1);
  // Fast path for a single live tick that extends the series.
  if (incoming.length === 1 && (!last || incoming[0].epoch > last.epoch)) {
    const next = current.length >= limit ? current.slice(current.length - limit + 1) : [...current];
    next.push(incoming[0]);
    return next;
  }
  const byEpoch = new Map<number, FeedTick>();
  for (const tick of current) byEpoch.set(tick.epoch, tick);
  for (const tick of incoming) byEpoch.set(tick.epoch, tick);
  return [...byEpoch.values()].sort((left, right) => left.epoch - right.epoch).slice(-limit);
}

export type Freshness = { fresh: boolean; receiveAgeMs: number | null; sourceAgeMs: number | null };

/**
 * A market is fresh when a live tick arrived recently. The server-clock check
 * is applied when Deriv's time is known, with a wider tolerance for jitter.
 */
export function marketFreshness(lastLiveTickAt: number | null, lastEpoch: number | null, now: number, serverClockOffsetMs: number | null): Freshness {
  const receiveAgeMs = lastLiveTickAt === null ? null : now - lastLiveTickAt;
  const sourceAgeMs = lastEpoch === null || serverClockOffsetMs === null ? null : now + serverClockOffsetMs - lastEpoch * 1_000;
  const fresh = receiveAgeMs !== null
    && Math.abs(receiveAgeMs) <= FEED_STALE_AFTER_MS
    && (sourceAgeMs === null || Math.abs(sourceAgeMs) <= 2 * FEED_STALE_AFTER_MS);
  return { fresh, receiveAgeMs, sourceAgeMs };
}

/** Digit ticks for analysis: only ticks whose final digit was verified. */
export function digitTicksOf(ticks: readonly FeedTick[]): Array<{ epoch: number; digit: number }> {
  const output: Array<{ epoch: number; digit: number }> = [];
  for (const tick of ticks) if (tick.digit !== null) output.push({ epoch: tick.epoch, digit: tick.digit });
  return output;
}
