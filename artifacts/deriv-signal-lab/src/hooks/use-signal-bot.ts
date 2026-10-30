// Trading bot that runs one finished analysis on the mini bottom trade menu.
//
// Rules (all of them are pure functions in `lib/signal-bot/plan.ts`):
//   * the market, contract, tick duration, number of runs AND the entry the
//     trade should be opened on come from the analysis the user just ran — a
//     plan without the analysis evidence behind it is refused, never guessed;
//   * the stake, the martingale ladder and what happens when the entry never
//     arrives (enter at market as replayed, or skip the run) come from the dock;
//   * every run is armed on the entry first: the bot waits for the planned
//     quote level (or digit context) while borrowing ticks from the shared
//     public market feed, then buys, then waits for that contract to settle
//     before the next run — a single contract is ever open for the bot;
//   * the bot stops itself when the runs run out, when the stop loss trips, or
//     when either take profit target is reached (a number of winning runs or a
//     realised profit amount, both set on the dock and 0 = off);
//   * Stop halts new purchases immediately; a contract already bought is left
//     to expire on Deriv and its row still fills in when Deriv reports it;
//   * the bot trades the signal it was loaded with. The research library's
//     execution gates are advice that travels with the run (and the quoted
//     payout is reported on it) — neither may refuse the purchase, so an
//     analysis always ends in a tradeable Load and Run.
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
import { masterBlocksEntry, type MasterDecision } from '@/lib/signal-engine/master-decision.ts';
import {
  effectiveWindowTicks,
  evaluateEntry,
  isEntryPlan,
  medianTickSpacingMs,
  ticksSince,
  type EntryEvaluation,
  type EntryForgeEvidence,
  type EntryPlan,
} from '@/lib/signal-engine/entry.ts';
import { forgeExecutionGate } from '@/lib/signal-bot/forge-gate.ts';
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

import { quoteEconomics, researchAdvisory } from '@/lib/engine-lab/execution';
import type { ResearchDecision } from '@/lib/engine-lab/types';
import type { ResearchFusion } from '@/lib/engine-lab/fusion';

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
  /** Layer-6 decision: the validity window, verdict and evidence behind it. */
  master?: MasterDecision | null;
  ranAt: number;
  researchDecision?: ResearchDecision | null;
  /** What the 300-engine library contributed to the traded probability. */
  research?: ResearchFusion | null;
  /** Confirmation-layer verdict for this signal, for the bot page. */
  confirmation?: { status: 'confirmed' | 'adjusted' | 'cautious' | 'contradicted'; edgePts: number; decisive: boolean } | null;
  /**
   * Probability the contract was published at. The calibration guard compares
   * the run's settled record against it, so a run that stops matching the
   * measurement ends before it spends a stake proving it.
   */
  probability?: number | null;
};

export type SignalBotController = {
  status: SignalBotStatus;
  stopReason: SignalBotStopReason;
  error: string;
  runs: SignalBotRun[];
  summary: ReturnType<typeof summarizeBotRuns>;
  plan: SignalBotPlan | null;
  /** Settings the current (or last) run was started with. */
  config: SignalBotConfig;
  /** Runs the bot will attempt for this signal. */
  targetRuns: number;
  /** Contract the bot is currently holding, if any. */
  activeContractId: number | null;
  /** Entry the bot is waiting for right now, if any. */
  entryWatch: SignalBotEntryWatch | null;
  running: boolean;
  /** True when the page has something to show and can be reset. */
  hasActivity: boolean;
  start: (
    plan: SignalBotPlan,
    config: SignalBotConfig,
    speed?: 'fast' | 'normal',
    options?: { userOverride?: boolean },
  ) => void;
  stop: () => void;
  reset: () => void;
};

type Waiter = {
  resolve: (result: SignalBotSettlement) => void;
  timer: number;
};

type EntryWaitResult = {
  status: 'ready' | 'expired' | 'missed' | 'cancelled';
  waitedTicks: number;
  waitedMs: number;
  note: string;
};

const NORMAL_PAUSE_BETWEEN_RUNS_MS = 600;
const FAST_PAUSE_BETWEEN_RUNS_MS = 100;
const NORMAL_ENTRY_POLL_MS = 250;
const FAST_ENTRY_POLL_MS = 50;
/** A quote older than this cannot trigger an entry (seconds). */
const ENTRY_STALE_AFTER_MS = 5_000;
/** An analysis older than this must be re-run before the bot trades it. */
const MAX_ANALYSIS_AGE_MS = 15 * 60_000;
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
  const [config, setConfig] = useState<SignalBotConfig>(sanitizeSignalBotConfig(null));
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
      context: { symbol: string; runIndex: number; armedAtEpoch: number | null; wait: boolean; fallback: 'market' | 'skip'; pollMs: number },
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
          windowTicks: effectiveWindowTicks(decision.entry),
        });
      };

      while (true) {
        if (!mountedRef.current || generation !== generationRef.current) {
          return { status: 'cancelled', waitedTicks: 0, waitedMs: Date.now() - armedAt, note: '' };
        }
        const entry = marketEntry(context.symbol);
        const latest = entry?.ticks.at(-1) ?? null;
        const elapsedTicks = ticksSince(entry?.ticks ?? [], context.armedAtEpoch);
        // A stale quote is not a live trigger. Waiting on the last known print
        // would enter at a level the market may have left long ago, so the bot
        // holds its fire until the feed proves the price again.
        if (entry && entry.receiveAgeMs !== null && Math.abs(entry.receiveAgeMs) > ENTRY_STALE_AFTER_MS) {
          update(
            {
              status: 'waiting',
              reason: `Waiting for a fresh tick — the last quote is ${(Math.abs(entry.receiveAgeMs) / 1_000).toFixed(1)}s old.`,
              distance: null,
              elapsedTicks,
              remainingTicks: Math.max(0, effectiveWindowTicks(decision.entry) - elapsedTicks),
              remainingMs: Math.max(0, decision.deadline - Date.now()),
            },
            latest?.quote ?? null,
          );
          await sleep(context.pollMs);
          continue;
        }
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
        if (evaluation.status === 'expired' || evaluation.status === 'missed')
          return {
            status: evaluation.status,
            waitedTicks: elapsedTicks,
            waitedMs: Date.now() - armedAt,
            note: evaluation.reason,
          };
        await sleep(context.pollMs);
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
    // Hitting the run count or a take profit target is a finished run; the
    // stop loss and a manual stop are not.
    setStatus(reason === 'runs' || reason === 'take-profit' ? 'completed' : reason === 'error' ? 'error' : 'stopped');
  }, []);

  const start = useCallback(
    (
      nextPlan: SignalBotPlan,
      rawConfig: SignalBotConfig,
      speed: 'fast' | 'normal' = 'normal',
      // The user pressed Load and Run BY HAND and confirmed they want to trade
      // this candidate even though the master measured no decisive edge (or
      // the forged model vetoed, or the measured validity window has passed).
      // Automation never sets this: Auto still refuses NO_EDGE signals. The
      // 15-minute analysis ceiling below is NOT overridable — by then the
      // entry levels themselves are stale prices, and re-running the analysis
      // takes seconds.
      options: { userOverride?: boolean } = {},
    ) => {
      const userOverride = options.userOverride === true;
      const session = tradingRef.current;
      if (runningRef.current) return;
      // Defense in depth: without an explicit, confirmed user override the
      // final execution hook enforces the master's hard veto too.
      if (!userOverride && masterBlocksEntry(nextPlan.master)) {
        setStatus('error');
        setStopReason('error');
        setError('The master decision vetoed this entry (NO_EDGE). Run Analysis again before Load and Run.');
        return;
      }
      if (session.status !== 'connected') {
        setStatus('error');
        setStopReason('error');
        setError('Connect your Deriv account before running the bot.');
        return;
      }
      // The bot trades the analysis, so the entry has to be one the engine
      // produced. A signal without it (an analysis restored from before the
      // entry layer, or a hand-made plan) is refused rather than guessed at.
      if (!isEntryPlan(nextPlan.entry)) {
        setStatus('error');
        setStopReason('error');
        setError('This signal carries no entry from the engine analysis. Run Analysis again, then Load and Run.');
        return;
      }
      // An analysis is a snapshot: its measured level and window age with the
      // market. The bot refuses to trade numbers that old instead of silently
      // re-using them.
      if (Number.isFinite(nextPlan.ranAt) && nextPlan.ranAt > 0 && Date.now() - nextPlan.ranAt > MAX_ANALYSIS_AGE_MS) {
        setStatus('error');
        setStopReason('error');
        setError(`This analysis is ${Math.round((Date.now() - nextPlan.ranAt) / 60_000)} minutes old. Run Analysis again so the bot trades a current entry.`);
        return;
      }
      // Layer 6 measured how long this edge survives. A signal the analysis
      // says is valid for a handful of ticks must not be armed minutes later,
      // so the bot refuses an old snapshot well before the 15-minute ceiling.
      // The floor keeps ordinary "analyse, then configure the dock" use intact.
      const validityMs = nextPlan.master?.validity.ms ?? 0;
      const staleAfterMs = Math.max(120_000, validityMs * 3);
      if (!userOverride && validityMs > 0 && Number.isFinite(nextPlan.ranAt) && nextPlan.ranAt > 0 && Date.now() - nextPlan.ranAt > staleAfterMs) {
        setStatus('error');
        setStopReason('error');
        setError(
          `This signal was measured valid for ~${Math.max(1, Math.round(validityMs / 1_000))}s and the analysis is ${Math.round((Date.now() - nextPlan.ranAt) / 1_000)}s old. Run Analysis again so the bot arms a current edge.`,
        );
        return;
      }
      // Layer 8 execution guard: the forged model is embedded in Load and Run.
      // A validated forge veto refuses to start the bot at all, so the bot
      // never enters a market the forged model has measured against the call.
      const forgeGate = forgeExecutionGate({
        forge: nextPlan.entry.evidence.forge ?? null,
        masterVetoed: masterBlocksEntry(nextPlan.master),
        entryTimingMeasured: Boolean(nextPlan.entry.measured && nextPlan.entry.trigger !== 'immediate'),
        entryReadyNow: false,
        analysisAgeMs: Number.isFinite(nextPlan.ranAt) && nextPlan.ranAt > 0 ? Date.now() - nextPlan.ranAt : null,
        validityMs,
        fair: nextPlan.entry.evidence.fairRate,
      });
      if (!userOverride && forgeGate.decision === 'block') {
        setStatus('error');
        setStopReason('error');
        setError(forgeGate.reason);
        return;
      }
      // A NO_EDGE master's validity collapses to a single tick, which the
      // digit/rise-fall builders write into entry.validForTicks — so even a
      // confirmed user override would watch its entry expire before the first
      // poll and never buy. The user explicitly chose to trade this candidate
      // now, so arm it with a usable 60-tick floor (the same floor the DBot
      // analysis snapshot uses); the entry trigger itself is unchanged.
      if (userOverride) {
        nextPlan = {
          ...nextPlan,
          entry: {
            ...nextPlan.entry,
            windowTicks: Math.max(60, Math.round(nextPlan.entry.windowTicks) || 0),
            validForTicks: Math.max(60, Math.round(nextPlan.entry.validForTicks ?? 0) || 0),
          },
        };
      }
      const config = sanitizeSignalBotConfig(rawConfig);
      // Fast mode reduces local scheduling delay only; feed, proposal and buy latency remain network/Deriv-bound.
      const pollMs = speed === 'fast' ? FAST_ENTRY_POLL_MS : NORMAL_ENTRY_POLL_MS;
      const pauseBetweenRunsMs = speed === 'fast' ? FAST_PAUSE_BETWEEN_RUNS_MS : NORMAL_PAUSE_BETWEEN_RUNS_MS;
      configRef.current = config;
      generationRef.current += 1;
      const generation = generationRef.current;
      runningRef.current = true;

      const target = resolveMaxRuns(config, nextPlan.recommendedRuns);
      setPlan(nextPlan);
      setConfig(config);
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

      const researchNote = researchAdvisory(nextPlan.researchDecision) ?? '';

      void (async () => {
        let streak = 0;
        let started = 0;
        // Take profit progress is tracked on the loop's own settlement results
        // (not React state) so the decision before the next purchase is exact.
        let wins = 0;
        let settled = 0;
        let realisedProfit = 0;
        // The probability the bot was handed. Every settled run is a Bernoulli
        // draw from it, which is what the calibration guard tests.
        const published = Number.isFinite(nextPlan.probability ?? NaN) ? (nextPlan.probability as number) : null;
        while (true) {
          const decision = nextRunDecision({
            status: 'running',
            runsStarted: started,
            targetRuns: target,
            lossStreak: streak,
            profit: realisedProfit,
            wins,
            config,
            calibration: published !== null ? { published, settled } : null,
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
            pollMs,
          });
          if (entryOutcome.status === 'cancelled') {
            // Stopped or reset mid-wait: the run never bought anything.
            return;
          }
          if ((entryOutcome.status === 'expired' || entryOutcome.status === 'missed') && entryDecision.fallback === 'skip') {
            setRuns((current) =>
              current.map((run) =>
                run.index === index && run.status === 'waiting'
                  ? {
                      ...run,
                      status: 'skipped',
                      settledAt: Date.now(),
                      entryTicks: entryOutcome.waitedTicks,
                      note: describeEntryOutcome({ status: entryOutcome.status as 'expired' | 'missed', waitedTicks: entryOutcome.waitedTicks, fallback: 'skip' }),
                    }
                  : run,
              ),
            );
            setEntryWatch(null);
            await sleep(pauseBetweenRunsMs);
            if (generation !== generationRef.current) return;
            continue;
          }
          if (generation !== generationRef.current) return;
          const resolvedStatus = entryOutcome.status;
          const entryNote = describeEntryOutcome({
            status: resolvedStatus,
            waitedTicks: entryOutcome.waitedTicks,
            fallback: entryDecision.fallback,
          });

          // The feed can die between the trigger and the purchase. Buying on a
          // quote the platform can no longer verify is worse than missing the
          // run, so the run is failed without a contract.
          const freshEntry = marketEntry(nextPlan.symbol);
          const freshTick = freshEntry?.ticks.at(-1) ?? null;
          if (freshEntry && freshEntry.receiveAgeMs !== null && Math.abs(freshEntry.receiveAgeMs) > ENTRY_STALE_AFTER_MS) {
            setRuns((current) =>
              current.map((run) =>
                run.index === index && run.status === 'waiting'
                  ? {
                      ...run,
                      status: 'failed',
                      settledAt: Date.now(),
                      entryTicks: entryOutcome.waitedTicks,
                      note: 'The live feed went stale before the order, so no contract was bought. Run Analysis again.',
                    }
                  : run,
              ),
            );
            setEntryWatch(null);
            await sleep(pauseBetweenRunsMs);
            if (generation !== generationRef.current) return;
            continue;
          }

          // Layer 8 execution guard: the forged model has the last word on this
          // run's entry. When it reads the market against the call, skip the
          // run instead of buying at a bad moment.
          const runForgeGate = forgeExecutionGate({
            forge: nextPlan.entry.evidence.forge ?? null,
            masterVetoed: false,
            entryTimingMeasured: Boolean(nextPlan.entry.measured && nextPlan.entry.trigger !== 'immediate'),
            entryReadyNow: true,
            analysisAgeMs: Number.isFinite(nextPlan.ranAt) && nextPlan.ranAt > 0 ? Date.now() - nextPlan.ranAt : null,
            validityMs,
            fair: nextPlan.entry.evidence.fairRate,
          });
          // A confirmed user override trades the loaded signal as-is: the
          // forge's per-run skip/block becomes a note on the run rather than
          // a silent veto the user already accepted at start.
          if (!userOverride && runForgeGate.decision === 'skip') {
            setRuns((current) =>
              current.map((run) =>
                run.index === index
                  ? {
                      ...run,
                      status: 'skipped',
                      settledAt: Date.now(),
                      entryTicks: entryOutcome.waitedTicks,
                      note: runForgeGate.reason,
                    }
                  : run,
              ),
            );
            setEntryWatch(null);
            await sleep(pauseBetweenRunsMs);
            if (generation !== generationRef.current) return;
            continue;
          }
          if (!userOverride && runForgeGate.decision === 'block') {
            setStatus('error');
            setStopReason('error');
            setError(runForgeGate.reason);
            finish(generation, 'stopped');
            return;
          }

          // 3. Buy the signal at the entry the analysis planned.
          let contractId: number | null = null;
          try {
            const quote = await tradingRef.current.requestQuote(request);
            if (generation !== generationRef.current) return;
            // The quoted payout is reported, never a veto: the bot trades the
            // signal it was loaded with and the estimate below break-even is
            // shown on the run so the user can judge it.
            const economics = quoteEconomics(nextPlan.entry.evidence.signalProbability, quote.askPrice, quote.payout);
            const economicsNote = economics.allowed ? '' : economics.reason;
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
                      // The research advice is constant for the run, so it is
                      // printed once (on the first contract) instead of on
                      // every row; the payout check can differ per proposal.
                      note: [entryNote, ladder.step > 0 ? `Martingale step ${ladder.step}.` : '', economicsNote, index === 1 ? researchNote : ''].filter(Boolean).join(' '),
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
          if (result.status === 'lost') { streak += 1; settled += 1; }
          else if (result.status === 'won') {
            streak = 0;
            wins += 1;
            settled += 1;
          }
          // An unknown result has no profit to bank; only what Deriv reported
          // moves the take profit total.
          if (result.profit !== null && Number.isFinite(result.profit)) {
            realisedProfit = Math.round((realisedProfit + result.profit) * 1e6) / 1e6;
          }
          await sleep(pauseBetweenRunsMs);
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
    config,
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
