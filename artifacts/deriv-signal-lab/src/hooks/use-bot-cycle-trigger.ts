// Shared cycle scheduler for the premium bots.
//
// The bots used to evaluate on a fixed timer, so a condition that appeared just
// after a cycle waited a whole interval before anything happened — up to two or
// three seconds on the default settings. A spread that closes in one tick is a
// missed entry.
//
// This scheduler is tick-driven: a new tick is the event that can change a
// decision, so each new tick starts a cycle. A minimum spacing keeps a burst of
// ticks (or a reconnect replay) from firing duplicate cycles, and a watchdog
// keeps evaluating on a quiet feed. `force` runs a cycle immediately, used when
// the operator presses Start or Run cycle now — including the first cycle after
// Start, which previously no-oped because the safety state had not been
// committed to the ref yet.
import { useCallback, useEffect, useRef } from 'react';

/**
 * Floor between two cycles, in milliseconds.
 *
 * It only exists to deduplicate: every decision cycle costs a handful of
 * `proposal` requests, so the same tick must not be evaluated twice. It is well
 * below the tick rate of every synthetic index the bots offer.
 */
export const BOT_CYCLE_MIN_SPACING_MS = 200;

/** Whether a cycle may start now. Pure, so the rule is testable without React. */
export function shouldStartBotCycle(input: {
  now: number;
  lastCycleAt: number;
  minSpacingMs: number;
  force?: boolean;
}): boolean {
  if (input.force) return true;
  const spacing = Number.isFinite(input.minSpacingMs) ? Math.max(0, input.minSpacingMs) : 0;
  return input.now - input.lastCycleAt >= spacing;
}

export type BotCycleTrigger = {
  /** Runs a cycle now, bypassing the spacing floor. */
  fireNow: () => void;
};

/**
 * Starts a cycle on every new tick, on a watchdog interval, and on demand.
 *
 * `run` is called through a ref, so a caller may pass a freshly created closure
 * each render without re-subscribing the scheduler.
 */
export function useBotCycleTrigger(input: {
  enabled: boolean;
  /** Epoch of the newest tick, or null before the first tick arrives. */
  tickEpoch: number | null;
  /** Watchdog: evaluate this often even when the feed is quiet. */
  watchdogMs: number;
  run: () => void;
  minSpacingMs?: number;
}): BotCycleTrigger {
  const { enabled, tickEpoch, watchdogMs, run, minSpacingMs = BOT_CYCLE_MIN_SPACING_MS } = input;
  const runRef = useRef(run);
  const lastRunAtRef = useRef(0);
  const lastEpochRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  runRef.current = run;
  enabledRef.current = enabled;

  const fire = useCallback((force: boolean) => {
    if (!enabledRef.current) return;
    const now = Date.now();
    if (!shouldStartBotCycle({ now, lastCycleAt: lastRunAtRef.current, minSpacingMs, force })) return;
    lastRunAtRef.current = now;
    runRef.current();
  }, [minSpacingMs]);

  // A new tick is the event: the moment the tape changes, the bot re-decides.
  useEffect(() => {
    if (!enabled || tickEpoch === null) return;
    if (lastEpochRef.current === tickEpoch) return;
    lastEpochRef.current = tickEpoch;
    fire(false);
  }, [enabled, tickEpoch, fire]);

  // Entering the running state resets the dedupe so the first tick after Start
  // is evaluated rather than compared with an epoch from before the stop.
  useEffect(() => {
    if (!enabled) {
      lastEpochRef.current = null;
      lastRunAtRef.current = 0;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const interval = window.setInterval(() => fire(false), Math.max(250, watchdogMs));
    return () => window.clearInterval(interval);
  }, [enabled, watchdogMs, fire]);

  return { fireNow: useCallback(() => fire(true), [fire]) };
}
