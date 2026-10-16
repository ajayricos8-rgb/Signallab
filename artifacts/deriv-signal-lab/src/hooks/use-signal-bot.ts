// Trading bot that runs one finished analysis on the mini bottom trade menu.
//
// Rules (all of them are pure functions in `lib/signal-bot/plan.ts`):
//   * the market, contract, tick duration, number of runs AND the entry the
//     trade should be opened on come from the analysis the user just ran;
//   * the stake, the martingale ladder and how the entry is used (follow it,
//     enter at market, or skip a missed entry) come from the trade dock;
//   * every run is armed on the entry first: the bot waits for the planned
//     quote level (or digit context) while borrowing ticks from the shared
//     public market feed, then buys, then waits for that contract to settle
//     before the next run — a single contract is ever open for the bot;
//   * Stop halts new purchases immediately; a contract already bought is left
//     to expire on Deriv and its row still fills in when Deriv reports it.
//
// Purchases go through the authenticated Deriv session
// (`useDerivTrading`): a live proposal is fetched first, then the buy is sent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { useMarketFeed, type MarketFeedEntry } from '@/components/market-feed-provider';
import { barrierFor, type DerivTradeRequest } from '@/lib/deriv-trading';
import type { TradeContractType, TradeFamily } from '@/lib/trade-draft';
import type { TradeDurationUnit } from '@/lib/trade-duration';
import type { SignalStrength } from '@/lib/signal-engine/confidence';
import {
  evaluateEntry,
  medianTickSpacingMs,
  ticksSince,
  type EntryEvaluation,
  type EntryPlan,
} from '@/lib/signal-engine/entry.ts';
import {
  describeEntryOutcome,
  nextRunDecision,
  planRunEntry,
  resolveMaxRuns,
  sanitizeSignalBotConfig,
  settlementTimeoutMs,
  stakeForRun,
  summarizeBotRuns,
  type RunEntryDecision,
} from '@/lib/signal-bot/plan.ts';
import type {
  SignalBotConfig,
  SignalBotEntryWatch,
  SignalBotRun,
  SignalBotSettlement,
  SignalBotStatus,
  SignalBotStopReason,
} from '@/lib/signal-bot/types.ts';

export type SignalBotPlan = {
  family: TradeFamily;
  symbol: string;
  marketName: string;
  contractType: TradeContractType;
  barrierDigit: number | null;
  duration: number;
  durationUnit: TradeDurationUnit;
  /** Short contract line, e.g. "RISE" or "Over 5". */
  label: string;
  /** Full contract line shown on the bot page, e.g. "RISE · 5 ticks". */
  contractLabel: string;
  confidence: number;
  strength: SignalStrength;
  /** Runs the analysis says this signal is worth. */
  recommendedRuns: number;
  /** When and at what price the analysis says this signal should be traded. */
  entry: EntryPlan;
  ranAt: number;
};

export type SignalBotController = {
  status: SignalBotStatus;
  stopReason: SignalBotStopReason;
  error: string;
  runs: SignalBotRun[];
  summary: ReturnType<typeof summarizeBotRuns>;
  plan: SignalBotPlan | null;
  /** Runs the bot will attempt for this signal. */
  targetRuns: number;
  /** Contract the bot is currently holding, if any. */
  activeContractId: number | null;
  /** Entry the bot is waiting for right now, if any. */
  entryWatch: SignalBotEntryWatch | null;
  running: boolean;
  /** True when the page has something to show and can be reset. */
  hasActivity: boolean;
  start: (plan: SignalBotPlan, config: SignalBotConfig) => void;
  stop: () => void;
  reset: () => void;
};

type Waiter = {
  resolve: (result: SignalBotSettlement) => void;
  timer: number;
};

type EntryWaitResult = {
  status: 'ready' | 'expired' | 'cancelled';
  waitedTicks: number;
  waitedMs: number;
  note: string;
};

const PAUSE_BETWEEN_RUNS_MS = 600;
const ENTRY_POLL_MS = 250;
const UNKNOWN_RESULT = 'Deriv did not report a result for this contract.';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Deriv rejected the order.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function useSignalBot(): SignalBotController {
  const trading = useDerivTrading();
  const feed = useMarketFeed();
  const tradingRef = useRef(trading);
  tradingRef.current = trading;
  const feedRef = useRef(feed);
  feedRef.current = feed;

  const [status, setStatus] = useState<SignalBotStatus>('idle');
  const [stopReason, setStopReason] = useState<SignalBotStopReason>(null);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<SignalBotRun[]>([]);
  const [plan, setPlan] = useState<SignalBotPlan | null>(null);
  const [targetRuns, setTargetRuns] = useState(0);
  const [activeContractId, setActiveContractId] = useState<number | null>(null);
  const [entryWatch, setEntryWatch] = useState<SignalBotEntryWatch | null>(null);

  const generationRef = useRef(0);
  const runningRef = useRef(false);
  const waitersRef = useRef(new Map<number, Waiter>());
  const mountedRef = useRef(true);
  const configRef = useRef<SignalBotConfig>(sanitizeSignalBotConfig(null));

  useEffect(() => () => {
    mountedRef.current = false;
    generationRef.current += 1;
    runningRef.current = false;
    for (const waiter of waitersRef.current.values()) {
      window.clearTimeout(waiter.timer);
      waiter.resolve({ status: 'cancelled', profit: null, note: '' });
    }
    waitersRef.current.clear();
  }, []);

  /** The newest feed entry for a market, straight from the live buffer. */
  const marketEntry = useCallback(
    (symbol: string): MarketFeedEntry | undefined => feedRef.current.getSnapshot().find((entry) => entry.symbol === symbol),
    [],
  );

  const applySettlement = useCallback((contractId: number, result: SignalBotSettlement) => {
    if (!mountedRef.current) return;
    setRuns((current) =>
      current.map((run) =>
        run.contractId === contractId && run.status === 'open'
          ? {
              ...run,
              status: result.status === 'unknown' ? 'unknown' : result.status === 'won' ? 'won' : 'lost',
              profit: result.profit,
              settledAt: Date.now(),
              note: result.note || run.note,
            }
          : run,
      ),
    );
  }, []);

  /** Resolves the loop's promise and closes the row with whatever Deriv said. */
  const settleWaiter = useCallback(
    (contractId: number, result: SignalBotSettlement) => {
      const waiter = waitersRef.current.get(contractId);
      if (!waiter) return;
      window.clearTimeout(waiter.timer);
      waitersRef.current.delete(contractId);
      // A cancelled wait means Stop was pressed: the row stays open so the
      // result still lands when Deriv reports the contract.
      if (result.status !== 'cancelled') applySettlement(contractId, result);
      waiter.resolve(result);
    },
    [applySettlement],
  );

  const waitForSettlement = useCallback(
    (contractId: number, timeoutMs: number) =>
      new Promise<SignalBotSettlement>((resolve) => {
        const timer = window.setTimeout(() => {
          settleWaiter(contractId, { status: 'unknown', profit: null, note: UNKNOWN_RESULT });
        }, timeoutMs);
        waitersRef.current.set(contractId, { resolve, timer });
      }),
    [settleWaiter],
  );

  // Deriv streams contract updates into the session's positions; this turns the
  // first settled row for a bought contract into the run's result.
  useEffect(() => {
    if (!waitersRef.current.size) return;
    for (const contractId of [...waitersRef.current.keys()]) {
      const closed = trading.closedPositions.find((row) => row.contractId === contractId);
      const open = trading.openPositions.find((row) => row.contractId === contractId);
      const settled = closed ?? (open && (open.isSold || open.isExpired) ? open : null);
      if (!settled) continue;
      const profit = settled.profit;
      if (profit === null) {
        settleWaiter(contractId, { status: 'unknown', profit: null, note: UNKNOWN_RESULT });
        continue;
      }
      settleWaiter(contractId, {
        status: profit > 0 ? 'won' : 'lost',
        profit,
        note: '',
      });
    }
  }, [settleWaiter, trading.closedPositions, trading.openPositions]);

  // Backstop: while a contract is open, ask the account for its state in case
  // the stream missed the settlement.
  useEffect(() => {
    if (status !== 'running' || activeContractId === null) return;
    const timer = window.setInterval(() => tradingRef.current.refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [activeContractId, status]);

  /**
   * Waits for the entry the analysis planned on this run, reading ticks from the
   * shared public feed. Resolves `ready` when the trigger fires, `expired` when
   * the tick or the wall-clock window closes, and `cancelled` when the run is
   * stopped, reset or unmounted mid-wait.
   */
  const waitForEntry = useCallback(
    async (
      generation: number,
      decision: RunEntryDecision,
      context: { symbol: string; runIndex: number; armedAtEpoch: number | null; wait: boolean; fallback: 'market' | 'skip' },
    ): Promise<EntryWaitResult> => {
      if (!context.wait) {
        setEntryWatch(null);
        return { status: 'ready', waitedTicks: 0, waitedMs: 0, note: '' };
      }
      const armedAt = Date.now();
      const update = (evaluation: EntryEvaluation, quote: number | null) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setEntryWatch({
          runIndex: context.runIndex,
          status: evaluation.status,
          reason: evaluation.reason,
          label: decision.entry.label,
          mode: decision.entry.mode,
          priceLevel: decision.entry.priceLevel,
          priceCondition: decision.entry.priceCondition,
          contextLabel: decision.entry.contextLabel,
          quote,
          distance: evaluation.distance,
          elapsedTicks: evaluation.elapsedTicks,
          remainingTicks: evaluation.remainingTicks,
          remainingMs: evaluation.remainingMs,
          windowTicks: decision.entry.windowTicks,
        });
      };

      while (true) {
        if (!mountedRef.current || generation !== generationRef.current) {
          return { status: 'cancelled', waitedTicks: 0, waitedMs: Date.now() - armedAt, note: '' };
        }
        const entry = marketEntry(context.symbol);
        const latest = entry?.ticks.at(-1) ?? null;
        const elapsedTicks = ticksSince(entry?.ticks ?? [], context.armedAtEpoch);
        const evaluation = evaluateEntry(
          decision.entry,
          { quote: latest?.quote ?? null, digit: latest?.digit ?? null, epoch: latest?.epoch ?? null },
          { elapsedTicks, now: Date.now(), deadline: decision.deadline },
        );
        update(evaluation, latest?.quote ?? null);
        if (evaluation.status === 'ready')
          return {
            status: 'ready',
            waitedTicks: elapsedTicks,
            waitedMs: Date.now() - armedAt,
            note: evaluation.reason,
          };
        if (evaluation.status === 'expired')
          return {
            status: 'expired',
            waitedTicks: elapsedTicks,
            waitedMs: Date.now() - armedAt,
            note: evaluation.reason,
          };
        await sleep(ENTRY_POLL_MS);
      }
    },
    [marketEntry],
  );

  const finish = useCallback((generation: number, reason: Exclude<SignalBotStopReason, null>) => {
    if (generation !== generationRef.current) return; // stopped, reset or replaced
    runningRef.current = false;
    if (!mountedRef.current) return;
    setActiveContractId(null);
    setEntryWatch(null);
    setStopReason(reason);
    setStatus(reason === 'runs' ? 'completed' : reason === 'error' ? 'error' : 'stopped');
  }, []);

  const start = useCallback(
    (nextPlan: SignalBotPlan, rawConfig: SignalBotConfig) => {
      const session = tradingRef.current;
      if (runningRef.current) return;
      if (session.status !== 'connected') {
        setStatus('error');
        setStopReason('error');
        setError('Connect your Deriv account before running the bot.');
        return;
      }
      const config = sanitizeSignalBotConfig(rawConfig);
      configRef.current = config;
      generationRef.current += 1;
      const generation = generationRef.current;
      runningRef.current = true;

      const target = resolveMaxRuns(config, nextPlan.recommendedRuns);
      setPlan(nextPlan);
      setTargetRuns(target);
      setRuns([]);
      setError('');
      setStopReason(null);
      setActiveContractId(null);
      setEntryWatch(null);
      setStatus('running');

      const requestFor = (stake: number): DerivTradeRequest => ({
        contractType: nextPlan.contractType,
        symbol: nextPlan.symbol,
        currency: session.currency || session.activeAccount?.currency || '',
        stake,
        duration: nextPlan.duration,
        durationUnit: nextPlan.durationUnit,
        barrier: barrierFor(nextPlan.contractType, nextPlan.barrierDigit),
      });

      void (async () => {
        let streak = 0;
        let started = 0;
        while (true) {
          const decision = nextRunDecision({
            status: 'running',
            runsStarted: started,
            targetRuns: target,
            lossStreak: streak,
            config,
          });
          if (!decision.buy) {
            finish(generation, decision.reason ?? 'runs');
            return;
          }
          if (generation !== generationRef.current) return;
          if (tradingRef.current.status !== 'connected') {
            setError('The Deriv trading connection dropped.');
            finish(generation, 'error');
            return;
          }

          const ladder = stakeForRun(config, streak);
          const index = started + 1;
          const request = requestFor(ladder.stake);
          started += 1;

          // 1. Arm the entry for this run. The level is re-based on the live
          //    quote, so every run waits for the same measured move.
          const feedEntry = marketEntry(nextPlan.symbol);
          const latest = feedEntry?.ticks.at(-1) ?? null;
          const entryDecision = planRunEntry({
            config,
            entry: nextPlan.entry,
            quote: latest?.quote ?? null,
            tickSpacingMs: medianTickSpacingMs(feedEntry?.ticks ?? []),
            now: Date.now(),
          });
          setRuns((current) => [
            ...current,
            {
              index,
              contractId: null,
              contractLabel: nextPlan.contractLabel,
              marketCode: nextPlan.symbol,
              stake: ladder.stake,
              payout: null,
              martingaleStep: ladder.step,
              status: entryDecision.wait ? 'waiting' : 'open',
              profit: null,
              openedAt: entryDecision.wait ? null : Date.now(),
              settledAt: null,
              entryTicks: null,
              note: entryDecision.note,
            },
          ]);

          // 2. Wait for the entry the analysis planned.
          const entryOutcome = await waitForEntry(generation, entryDecision, {
            symbol: nextPlan.symbol,
            runIndex: index,
            armedAtEpoch: latest?.epoch ?? null,
            wait: entryDecision.wait,
            fallback: entryDecision.fallback,
          });
          if (entryOutcome.status === 'cancelled') {
            // Stopped or reset mid-wait: the run never bought anything.
            return;
          }
          if (entryOutcome.status === 'expired' && entryDecision.fallback === 'skip') {
            setRuns((current) =>
              current.map((run) =>
                run.index === index && run.status === 'waiting'
                  ? {
                      ...run,
                      status: 'skipped',
                      settledAt: Date.now(),
                      entryTicks: entryOutcome.waitedTicks,
                      note: describeEntryOutcome({ status: 'expired', waitedTicks: entryOutcome.waitedTicks, fallback: 'skip' }),
                    }
                  : run,
              ),
            );
            setEntryWatch(null);
            await sleep(PAUSE_BETWEEN_RUNS_MS);
            if (generation !== generationRef.current) return;
            continue;
          }
          if (generation !== generationRef.current) return;

          const entryNote = describeEntryOutcome({
            status: entryOutcome.status,
            waitedTicks: entryOutcome.waitedTicks,
            fallback: entryDecision.fallback,
          });

          // 3. Buy the signal at the entry the analysis planned.
          let contractId: number | null = null;
          try {
            const quote = await tradingRef.current.requestQuote(request);
            if (generation !== generationRef.current) return;
            const receipt = await tradingRef.current.confirmBuy(quote, request);
            if (generation !== generationRef.current) {
              // Stop was pressed mid-purchase: the contract exists and is left
              // to expire on its own.
              return;
            }
            contractId = receipt.contractId;
            setRuns((current) =>
              current.map((run) =>
                run.index === index
                  ? {
                      ...run,
                      contractId,
                      stake: receipt.buyPrice ?? ladder.stake,
                      payout: receipt.payout,
                      status: 'open',
                      openedAt: Date.now(),
                      entryTicks: entryOutcome.waitedTicks,
                      note: [entryNote, ladder.step > 0 ? `Martingale step ${ladder.step}.` : ''].filter(Boolean).join(' '),
                    }
                  : run,
              ),
            );
            setActiveContractId(contractId);
            setEntryWatch(null);
          } catch (cause) {
            const message = errorText(cause);
            setRuns((current) =>
              current.map((run) =>
                run.index === index
                  ? {
                      ...run,
                      status: 'failed',
                      settledAt: Date.now(),
                      entryTicks: entryOutcome.waitedTicks,
                      note: message,
                    }
                  : run,
              ),
            );
            setEntryWatch(null);
            setError(message);
            finish(generation, 'error');
            return;
          }

          const result = await waitForSettlement(contractId, settlementTimeoutMs(nextPlan.duration, nextPlan.durationUnit));
          setActiveContractId(null);
          if (generation !== generationRef.current) return;
          if (result.status === 'lost') streak += 1;
          else if (result.status === 'won') streak = 0;
          await sleep(PAUSE_BETWEEN_RUNS_MS);
          if (generation !== generationRef.current) return;
        }
      })();
    },
    [finish, marketEntry, waitForEntry, waitForSettlement],
  );

  const stop = useCallback(() => {
    if (!runningRef.current) return;
    generationRef.current += 1;
    runningRef.current = false;
    if (!mountedRef.current) return;
    setActiveContractId(null);
    setStopReason('manual');
    setStatus('stopped');
    setEntryWatch(null);
    // A run that was still waiting for its entry never bought anything, so it
    // is closed as skipped rather than left hanging.
    setRuns((current) =>
      current.map((run) =>
        run.status === 'waiting'
          ? { ...run, status: 'skipped', settledAt: Date.now(), note: 'Stopped before the entry arrived.' }
          : run,
      ),
    );
    // Unblock the loop but keep watching: the open contract still settles and
    // its row is filled in when Deriv reports it.
    for (const [contractId, waiter] of [...waitersRef.current]) {
      waiter.resolve({ status: 'cancelled', profit: null, note: '' });
      waitersRef.current.set(contractId, { ...waiter, resolve: () => {} });
    }
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    runningRef.current = false;
    for (const waiter of waitersRef.current.values()) {
      window.clearTimeout(waiter.timer);
      waiter.resolve({ status: 'cancelled', profit: null, note: '' });
    }
    waitersRef.current.clear();
    setRuns([]);
    setError('');
    setStopReason(null);
    setStatus('idle');
    setPlan(null);
    setTargetRuns(0);
    setActiveContractId(null);
    setEntryWatch(null);
  }, []);

  const summary = useMemo(() => summarizeBotRuns(runs, configRef.current), [runs]);

  return {
    status,
    stopReason,
    error,
    runs,
    summary,
    plan,
    targetRuns,
    activeContractId,
    entryWatch,
    running: status === 'running',
    hasActivity: runs.length > 0 || status !== 'idle',
    start,
    stop,
    reset,
  };
}
