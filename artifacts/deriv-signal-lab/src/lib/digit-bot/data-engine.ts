// ENGINE A — Live data engine.
//
// Owns the rolling tick buffer built from the application's existing Deriv
// market-data subscription. It never invents a tick: when the stream stalls the
// engine reports staleness and every downstream gate stays closed until real
// ticks resume.
import type { DigitObservation } from '../digit-analysis.ts';
import { clamp, mean, sum } from '../over-under/math.ts';
import type { BotTick, DataQualityFinding } from './types.ts';

export type TickAddResult = { added: boolean; duplicate: boolean; reason: string };

/**
 * Rolling, de-duplicated tick buffer.
 *
 * A tick's identity is `epoch:quote:digit`. Deriv subscriptions can replay the
 * newest tick after a reconnect, and the decision cycle must never treat the
 * same market observation as two separate observations.
 */
export class TickBuffer {
  capacity: number;
  private ticks: BotTick[] = [];
  private seen = new Set<string>();
  private duplicatesDropped = 0;

  constructor(capacity = 5_000) {
    this.capacity = Math.max(100, Math.floor(capacity));
  }

  static keyOf(tick: Pick<BotTick, 'epoch' | 'quote' | 'digit'>): string {
    return `${tick.epoch}:${tick.quote}:${tick.digit}`;
  }

  add(observation: DigitObservation, receivedAt: number): TickAddResult {
    if (!Number.isFinite(observation.quote) || !Number.isFinite(observation.epoch) || observation.epoch <= 0) {
      return { added: false, duplicate: false, reason: 'The observation has no usable quote or timestamp.' };
    }
    if (!Number.isInteger(observation.digit) || observation.digit < 0 || observation.digit > 9) {
      return { added: false, duplicate: false, reason: 'The observation has no validated final digit.' };
    }
    const key = TickBuffer.keyOf(observation);
    if (this.seen.has(key)) {
      this.duplicatesDropped += 1;
      return { added: false, duplicate: true, reason: 'This tick was already processed.' };
    }
    const tick: BotTick = { ...observation, receivedAt };
    this.seen.add(key);
    const last = this.ticks.at(-1);
    if (last && tick.epoch < last.epoch) {
      // Out-of-order delivery: insert in epoch order so windows stay chronological.
      const index = this.ticks.findIndex((existing) => existing.epoch > tick.epoch);
      this.ticks.splice(index === -1 ? this.ticks.length : index, 0, tick);
    } else {
      this.ticks.push(tick);
    }
    this.evict();
    return { added: true, duplicate: false, reason: '' };
  }

  private evict(): void {
    if (this.ticks.length <= this.capacity) return;
    const removed = this.ticks.splice(0, this.ticks.length - this.capacity);
    for (const tick of removed) this.seen.delete(TickBuffer.keyOf(tick));
  }

  list(symbol?: string): BotTick[] {
    return symbol ? this.ticks.filter((tick) => tick.symbol === symbol) : [...this.ticks];
  }

  window(symbol: string, count: number): BotTick[] {
    const rows = this.list(symbol);
    return count >= rows.length ? rows : rows.slice(-count);
  }

  latest(symbol?: string): BotTick | null {
    const rows = this.list(symbol);
    return rows.at(-1) ?? null;
  }

  size(): number {
    return this.ticks.length;
  }

  duplicateCount(): number {
    return this.duplicatesDropped;
  }

  hasSymbol(symbol: string): boolean {
    return this.ticks.some((tick) => tick.symbol === symbol);
  }

  /** Drops the history of one symbol after a reconnect or a symbol switch. */
  reset(symbol?: string): void {
    if (!symbol) {
      this.ticks = [];
      this.seen.clear();
      return;
    }
    const kept = this.ticks.filter((tick) => tick.symbol !== symbol);
    for (const tick of this.ticks) if (tick.symbol === symbol) this.seen.delete(TickBuffer.keyOf(tick));
    this.ticks = kept;
  }
}

/** True when the newest valid digit ticks are an unbroken chronological run. */
export function isChronological(ticks: readonly BotTick[]): boolean {
  for (let index = 1; index < ticks.length; index += 1) {
    if (ticks[index].epoch < ticks[index - 1].epoch) return false;
  }
  return true;
}

/** Median spacing between consecutive ticks, used as the gap reference. */
export function medianSpacingMs(ticks: readonly BotTick[]): number | null {
  if (ticks.length < 5) return null;
  const deltas: number[] = [];
  for (let index = 1; index < ticks.length; index += 1) {
    const delta = (ticks[index].epoch - ticks[index - 1].epoch) * 1_000;
    if (delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return null;
  const sorted = [...deltas].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export type GapReport = { gapsDetected: number; maxGapMs: number | null; referenceSpacingMs: number | null; missingTicksEstimate: number | null };

/**
 * Counts interruptions in the tick stream. A gap is spacing larger than
 * three times the observed median, so the check adapts to each symbol's tick
 * rate instead of assuming a fixed one.
 */
export function detectGaps(ticks: readonly BotTick[]): GapReport {
  const reference = medianSpacingMs(ticks);
  if (reference === null || ticks.length < 5) {
    return { gapsDetected: 0, maxGapMs: null, referenceSpacingMs: reference, missingTicksEstimate: null };
  }
  const threshold = reference * 3 + 1_000;
  let gaps = 0;
  let maxGap = 0;
  let missingEstimate = 0;
  for (let index = 1; index < ticks.length; index += 1) {
    const delta = (ticks[index].epoch - ticks[index - 1].epoch) * 1_000;
    if (delta > threshold) {
      gaps += 1;
      maxGap = Math.max(maxGap, delta);
      missingEstimate += Math.max(0, Math.round(delta / reference) - 1);
    }
  }
  return { gapsDetected: gaps, maxGapMs: gaps ? maxGap : (reference ?? null), referenceSpacingMs: reference, missingTicksEstimate: missingEstimate };
}

export type DataQualityInput = {
  ticks: readonly BotTick[];
  duplicatesDropped: number;
  symbol: string;
  /** Local wall clock at assessment time. */
  now: number;
  /** Deriv server time minus local time, in ms, when known. */
  clockOffsetMs: number | null;
  /** Largest accepted age of the newest tick. */
  maxTickAgeMs: number;
  /** Verified decimal precision for the symbol, or null when unverifiable. */
  precision: number | null;
  /** Live feed freshness as reported by the subscription hook. */
  feedFresh: boolean;
  /** Subscription state reported by the existing hook. */
  feedStatus: string;
  /** True when the trading socket itself is down. */
  connectionHealthy: boolean;
};

/**
 * Data quality gate. Returns `fresh: false` whenever the numbers behind a
 * decision cannot be trusted, which is what disables new trades.
 */
export function assessDataQuality(input: DataQualityInput): DataQualityFinding {
  const ticks = input.ticks;
  const latest = ticks.at(-1) ?? null;
  const validTickCount = ticks.length;
  const precisionVerified = input.precision !== null && ticks.every((tick) => tick.precision === input.precision);
  const receiveAgeMs = latest ? input.now - latest.receivedAt : null;
  const sourceAgeMs = latest && input.clockOffsetMs !== null ? input.now + input.clockOffsetMs - latest.epoch * 1_000 : null;
  const gaps = detectGaps(ticks);

  const connectionBroken = !input.connectionHealthy;
  const feedBroken = input.feedStatus === 'error' || input.feedStatus === 'connecting' || input.feedStatus === 'reconnecting';
  const staleByReceive = receiveAgeMs === null || Math.abs(receiveAgeMs) > input.maxTickAgeMs;
  const staleBySource = sourceAgeMs === null || Math.abs(sourceAgeMs) > input.maxTickAgeMs;
  const interruptions = gaps.gapsDetected;
  const interrupted = interruptions > 0 && gaps.maxGapMs !== null && gaps.maxGapMs > input.maxTickAgeMs * 2;

  let status: DataQualityFinding['status'];
  if (connectionBroken || feedBroken || !latest) status = 'interrupted';
  else if (staleByReceive || staleBySource || interrupted) status = 'stale';
  else if (validTickCount < 50) status = 'insufficient';
  else status = 'live';

  const fresh = status === 'live' && input.feedFresh && precisionVerified;

  const sampleScore = clamp(validTickCount / 500, 0, 1);
  const freshnessScore = status === 'live' ? 1 : staleByReceive || staleBySource ? 0 : 0.35;
  const gapScore = clamp(1 - interruptions / Math.max(5, ticks.length / 200), 0, 1);
  const precisionScore = precisionVerified ? 1 : 0;
  const quality = clamp(
    0.4 * freshnessScore + 0.25 * sampleScore + 0.15 * gapScore + 0.2 * precisionScore,
    0,
    1,
  );

  return {
    status,
    fresh,
    tickCount: validTickCount,
    validTickCount,
    duplicatesDropped: input.duplicatesDropped,
    gapsDetected: interruptions,
    precisionVerified,
    requestedPrecision: input.precision,
    lastTickEpoch: latest?.epoch ?? null,
    lastTickAt: latest?.receivedAt ?? null,
    sourceAgeMs,
    receiveAgeMs,
    maxGapMs: gaps.maxGapMs,
    quality,
  };
}

export type WindowSlice = { window: number; digits: number[]; ticks: BotTick[]; complete: boolean };

/**
 * Analysis windows. `complete` is false when fewer genuine ticks exist than
 * the window asks for, so a 1,000-tick window can never be presented as if it
 * held 1,000 observations.
 */
export function buildWindows(ticks: readonly BotTick[], windows: readonly number[]): WindowSlice[] {
  const ordered = [...ticks].sort((left, right) => left.epoch - right.epoch);
  return [...windows]
    .filter((window) => Number.isInteger(window) && window > 0)
    .sort((left, right) => left - right)
    .map((window) => {
      const slice = ordered.slice(-window);
      return { window, digits: slice.map((tick) => tick.digit), ticks: slice, complete: slice.length >= window };
    });
}

/** Summary of the newest ticks, used by the dashboard's market-status panel. */
export function tickRecencySummary(ticks: readonly BotTick[]): { last10: number[]; lastDigit: number | null; meanGapMs: number | null } {
  const last10 = ticks.slice(-10).map((tick) => tick.digit);
  const deltas: number[] = [];
  for (let index = 1; index < Math.min(ticks.length, 100); index += 1) {
    deltas.push((ticks[ticks.length - index].epoch - ticks[ticks.length - index - 1].epoch) * 1_000);
  }
  const recent = ticks.slice(-100);
  const spacing = recent.length > 1
    ? mean(recent.slice(1).map((tick, index) => (tick.epoch - recent[index].epoch) * 1_000).filter((delta) => delta > 0))
    : null;
  return { last10, lastDigit: last10.at(-1) ?? null, meanGapMs: spacing };
}

/** Total number of genuine digits available for analysis. */
export function availableDigitCount(ticks: readonly BotTick[]): number {
  return sum(ticks.map(() => 1));
}
