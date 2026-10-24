// Mafia bot controller.
//
// Wires the engine in `lib/mafia-bot` to the two Deriv connections the app
// already has: the public tick feed (`useDerivDigitFeed`) and the authenticated
// trading session (`useDerivTrading`). Each cycle:
//
//   1. keeps the feed on a Step index — the bot's only universe;
//   2. analyses the ticks for directional uniformity and replays the 4-tick
//      windows, including the windows where nothing moved;
//   3. prices both legs with `proposal` requests (CALL and PUT, 4 ticks), then
//      applies the sizing, break-even, expected-value and risk gates;
//   4. in live mode buys both legs together, in the same tick;
//   5. settles each leg only from Deriv's own report.
//
// Analysis mode requests the same quotes and records the same decision, so the
// numbers on screen are real; it simply never sends a `buy`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDerivDigitFeed } from '@/hooks/use-deriv-digit-feed';
import { BOT_CYCLE_MIN_SPACING_MS, shouldStartBotCycle, useBotCycleTrigger } from '@/hooks/use-bot-cycle-trigger';
import { configNeedsReset, markConfigVersion } from '@/lib/bot-config-version';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import type { DerivBuyReceipt, DerivClosedPosition, DerivOpenPosition, DerivQuote, DerivTradeRequest } from '@/lib/deriv-trading';
import {
  clearAutoPause,
  createSafetyState,
  pauseBot,
  registerAutoPause,
  resumeBot,
  startBot,
  stopBot,
} from '@/lib/digit-bot/safety';
import type { SafetyState } from '@/lib/digit-bot/types';
import {
  applyPurchase,
  applySettlement,
  beginSession,
  reconcileBalance,
  rollTradingDay,
  setOpenExposure,
  type SettlementOutcome,
} from '@/lib/rise-fall-bot/risk';
import { createRiseFallAccountState, type RiseFallAccountState } from '@/lib/rise-fall-bot/types';
import { validateLegProposal } from '@/lib/hedging-bot/economics';
import {
  analyseMafiaMarket,
  replayGatedOutcomes,
  verdictOnUniformity,
  type MafiaAnalysis,
  type MafiaGatedReplay,
} from '@/lib/mafia-bot/analysis';
import {
  evaluateMafiaEntry,
  mafiaSessionStop,
  type MafiaDecisionInput,
  type MafiaEvaluation,
  type MafiaRiskSnapshot,
} from '@/lib/mafia-bot/decision';
import { evaluatePairEconomics, sizeMafiaPair, type MafiaPairEconomics, type MafiaSizing } from '@/lib/mafia-bot/economics';
import {
  applyLegPurchase,
  applyLegQuote,
  boughtLegs,
  finalizeMafiaPair,
  isPairOpen,
  legIsSettled,
  legOf,
  mafiaPairsToCsv,
  makeMafiaPair,
  rejectMafiaPair,
  settleMafiaLeg,
  summarizeMafiaPairs,
  summarizeMafiaPredictions,
  trimMafiaPairs,
} from '@/lib/mafia-bot/ledger';
import {
  MAFIA_DURATION_TICKS,
  defaultMafiaBotConfig,
  oppositeDirection,
  sanitizeMafiaBotConfig,
  type MafiaBotConfig,
  type MafiaDecision,
  type MafiaLegSide,
  type MafiaMode,
  type MafiaPair,
  type MafiaPrediction,
} from '@/lib/mafia-bot/types';
import { isStepIndexMarket, resolveMafiaSymbol, stepIndexMarkets } from '@/lib/mafia-bot/universe';

const MODE_KEY = 'signal-lab-mafia-bot-mode';
const CONFIG_KEY = 'signal-lab-mafia-bot-config';
const PAIRS_KEY = 'signal-lab-mafia-bot-pairs';
const PREDICTIONS_KEY = 'signal-lab-mafia-bot-predictions';

const LOG_LIMIT = 60;
const PAIR_LIMIT = 300;
const REJECTED_LIMIT = 100;
const PREDICTION_LIMIT = 400;
/** A prediction whose window has not printed by this age is expired, never guessed. */
const PREDICTION_MAX_PENDING_MS = 10 * 60_000;
/** Quotes are reused for this long before another preview is requested. */
// Reusing a quote saves a round trip, but a four-tick pair priced from a quote
// that is already two ticks old is not the pair the analysis measured. One
// second keeps the single-flight cycle fast without pricing off stale terms.
const QUOTE_TTL_MS = 1_000;

const UNCERTAIN_PURCHASE = /did not confirm the purchase in time|closed before Deriv answered/i;
const ORPHAN_LEG_REASON = 'A Mafia leg is open without its partner; close it manually before any new pair.';
const UNRECONCILED_REASON = 'A Mafia purchase has no receipt; it must be reconciled with the account before any new pair.';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing: the value still lives in memory for this session.
  }
}

function readMode(): MafiaMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'analysis';
  } catch {
    return 'analysis';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Deriv rejected the request.';
}

/** Money without a currency symbol: the hook has no formatter of its own. */
function moneyText(value: number): string {
  return value.toFixed(2);
}

/** One leg of the pricing preview. */
export type MafiaLegPricing = {
  side: MafiaLegSide;
  direction: 'CALL' | 'PUT';
  ask: number | null;
  payout: number | null;
  issues: string[];
};

export type MafiaPricing = {
  at: number;
  symbol: string;
  primary: MafiaLegPricing;
  cover: MafiaLegPricing;
  economics: MafiaPairEconomics | null;
  notes: string[];
};

type CycleResult = { executed: boolean; pairId: string | null; message: string };

export type MafiaBotController = {
  // Controls
  mode: MafiaMode;
  setMode: (mode: MafiaMode) => void;
  runState: SafetyState['runState'];
  safety: SafetyState;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  runCycleNow: () => void;

  // Configuration
  config: MafiaBotConfig;
  updateConfig: (patch: Partial<MafiaBotConfig>) => void;
  resetConfig: () => void;

  // Market
  symbol: string;
  selectSymbol: (symbol: string) => void;
  stepMarkets: ReturnType<typeof stepIndexMarkets>;
  marketName: string;
  symbolAllowed: boolean;
  precision: number | null;
  quote: number | null;
  tickCount: number;
  feedStatus: string;
  feedFresh: boolean;
  feedError: string;
  precisionError: string;
  contractsLoaded: boolean;
  riseFallSupported: boolean | null;

  // Engine output
  analysis: MafiaAnalysis;
  gated: MafiaGatedReplay;
  evaluation: MafiaEvaluation | null;
  decision: MafiaDecision | null;
  cycleLog: MafiaDecision[];
  cycleRunning: boolean;
  cycleError: string;
  lastCycleAt: number | null;
  pricing: MafiaPricing | null;
  sizing: MafiaSizing | null;
  economics: MafiaPairEconomics | null;
  evidence: number | null;
  breakEven: number | null;
  sessionStopReason: string | null;

  // Account and results
  account: RiseFallAccountState;
  accountType: 'demo' | 'real' | null;
  accountCurrency: string;
  balance: number | null;
  connected: boolean;
  pairs: MafiaPair[];
  predictions: MafiaPrediction[];
  summary: ReturnType<typeof summarizeMafiaPairs>;
  predictionSummary: ReturnType<typeof summarizeMafiaPredictions>;
  /** Totals for pairs bought in the current session only. */
  sessionSummary: ReturnType<typeof summarizeMafiaPairs>;
  pairsCsv: string;
  openPositions: DerivOpenPosition[];
  purchaseInFlight: boolean;
  unreconciledPurchase: boolean;
  sessionMinutesRemaining: number | null;

  // Actions
  closeLeg: (pairId: string, side: MafiaLegSide) => Promise<void>;
  clearTradeLog: () => void;
};

function legPricing(
  side: MafiaLegSide,
  direction: 'CALL' | 'PUT',
  quote: DerivQuote | null,
  issues: string[],
): MafiaLegPricing {
  return {
    side,
    direction,
    ask: quote?.askPrice ?? null,
    payout: quote?.payout ?? null,
    issues,
  };
}

function quoteIssues(
  result: PromiseSettledResult<DerivQuote>,
  stake: number,
  now: number,
  maxAgeMs: number,
  offset: number | null,
  label: string,
): string[] {
  if (result.status === 'rejected') return [`${label}: ${errorText(result.reason)}`];
  return validateLegProposal({ proposal: result.value, stake, now, maxAgeMs, serverClockOffsetMs: offset })
    .issues.map((issue) => `${label}: ${issue}`);
}

/**
 * Resolves the recorded predictions against the ticks that followed.
 *
 * A prediction is settled by the first tick at or after `entryEpoch + 4`, so it
 * describes the same window a pair would have held. Ticks that never arrive are
 * expired rather than assumed.
 */
function resolveMafiaPredictions(
  rows: readonly MafiaPrediction[],
  ticks: readonly { epoch: number; quote: number }[],
  now: number,
): { rows: MafiaPrediction[]; changed: boolean } {
  const pending = rows.filter((row) => row.outcome === null);
  if (!pending.length || !ticks.length) return { rows: [...rows], changed: false };
  const sorted = [...ticks].sort((left, right) => left.epoch - right.epoch);
  let changed = false;
  const next = rows.map((row) => {
    if (row.outcome !== null) return row;
    const target = row.entryEpoch + MAFIA_DURATION_TICKS;
    const exit = sorted.find((tick) => tick.epoch >= target);
    if (!exit) {
      if (now - row.at > PREDICTION_MAX_PENDING_MS) {
        changed = true;
        return { ...row, resolvedAt: now };
      }
      return row;
    }
    const delta = exit.quote - row.entryQuote;
    const outcome = delta === 0
      ? 'flat' as const
      : (row.direction === 'CALL' ? delta > 0 : delta < 0)
        ? 'primary' as const
        : 'cover' as const;
    changed = true;
    return { ...row, exitEpoch: exit.epoch, exitQuote: exit.quote, outcome, resolvedAt: now };
  });
  return { rows: next, changed };
}

export function useMafiaBot(): MafiaBotController {
  const feed = useDerivDigitFeed();
  const trading = useDerivTrading();

  const [mode, setModeState] = useState<MafiaMode>(readMode);
  const [config, setConfig] = useState<MafiaBotConfig>(() => sanitizeMafiaBotConfig(
    configNeedsReset(CONFIG_KEY) ? {} : readJson<Partial<MafiaBotConfig>>(CONFIG_KEY, {}),
  ));
  const [safety, setSafety] = useState<SafetyState>(createSafetyState);
  const [account, setAccount] = useState<RiseFallAccountState>(createRiseFallAccountState);
  const [evaluation, setEvaluation] = useState<MafiaEvaluation | null>(null);
  const [decision, setDecision] = useState<MafiaDecision | null>(null);
  const [cycleLog, setCycleLog] = useState<MafiaDecision[]>([]);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [cycleError, setCycleError] = useState('');
  const [lastCycleAt, setLastCycleAt] = useState<number | null>(null);
  const [pricing, setPricing] = useState<MafiaPricing | null>(null);
  const [pairs, setPairs] = useState<MafiaPair[]>(() => readJson<MafiaPair[]>(PAIRS_KEY, []));
  const [predictions, setPredictions] = useState<MafiaPrediction[]>(() => readJson<MafiaPrediction[]>(PREDICTIONS_KEY, []));
  const [inFlight, setInFlight] = useState(false);

  const accountRef = useRef(account);
  const configRef = useRef(config);
  const modeRef = useRef(mode);
  const safetyRef = useRef(safety);
  const pairsRef = useRef(pairs);
  const predictionsRef = useRef(predictions);
  const tradingRef = useRef(trading);
  const feedRef = useRef(feed);
  const busyRef = useRef(false);
  /** A tick arrived while a cycle was pricing; re-run once it finishes. */
  const pendingCycleRef = useRef(false);
  const inFlightRef = useRef(false);
  const unreconciledRef = useRef(false);
  const mountedRef = useRef(true);
  const lastCycleRef = useRef(0);
  const sequenceRef = useRef(0);
  const runCycleRef = useRef<(options?: { force?: boolean }) => Promise<void>>(async () => {});
  // The last priced pair, kept only while it is fresh AND was priced for the same
  // direction and stakes. A cached quote is a quote, never a reconstruction.
  const quoteCacheRef = useRef<{
    at: number;
    symbol: string;
    direction: 'CALL' | 'PUT';
    primaryStake: number;
    coverStake: number;
    primary: DerivQuote;
    cover: DerivQuote;
  } | null>(null);
  // A one-second clock keeps the displayed tick age and session timer honest
  // between ticks, without re-running the engine on a timer.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  accountRef.current = account;
  configRef.current = config;
  modeRef.current = mode;
  safetyRef.current = safety;
  pairsRef.current = pairs;
  predictionsRef.current = predictions;
  tradingRef.current = trading;
  feedRef.current = feed;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    writeJson(CONFIG_KEY, config);
  }, [config]);

  // The reset above is one-time: from here on, whatever the operator edits is
  // what the next load keeps.
  useEffect(() => {
    markConfigVersion(CONFIG_KEY);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Storage is optional; the mode is still held in memory.
    }
  }, [mode]);

  useEffect(() => {
    writeJson(PAIRS_KEY, pairs);
  }, [pairs]);

  useEffect(() => {
    writeJson(PREDICTIONS_KEY, predictions.slice(-PREDICTION_LIMIT));
  }, [predictions]);

  const commitAccount = useCallback((next: RiseFallAccountState) => {
    accountRef.current = next;
    setAccount(next);
  }, []);

  const commitPairs = useCallback((next: MafiaPair[]) => {
    const trimmed = trimMafiaPairs(next, PAIR_LIMIT, REJECTED_LIMIT);
    pairsRef.current = trimmed;
    setPairs(trimmed);
  }, []);

  const setPurchaseInFlight = useCallback((next: boolean) => {
    inFlightRef.current = next;
    setInFlight(next);
  }, []);

  const nextDecisionId = useCallback((now: number, symbol: string) => {
    sequenceRef.current += 1;
    return `mf-${now.toString(36)}-${sequenceRef.current}-${symbol}`;
  }, []);

  // ---- account mapping ------------------------------------------------------
  useEffect(() => {
    const currency = trading.currency || trading.activeAccount?.currency || '';
    commitAccount(rollTradingDay({
      ...accountRef.current,
      accountId: trading.activeAccount?.accountId ?? null,
      accountType: trading.activeAccount?.accountType ?? null,
      currency: currency || accountRef.current.currency,
    }, Date.now()));
  }, [trading.activeAccount, trading.currency, commitAccount]);

  useEffect(() => {
    if (trading.balance === null) return;
    commitAccount(reconcileBalance(accountRef.current, trading.balance));
  }, [trading.balance, commitAccount]);

  // ---- connection and feed interlocks ---------------------------------------
  useEffect(() => {
    const currentMode = modeRef.current;
    setSafety((current) => {
      let next = current;
      const rule = (reason: string, active: boolean) => {
        const prefix = reason.slice(0, 40);
        next = active
          ? registerAutoPause(next, reason, currentMode)
          : clearAutoPause(next, (existing) => existing.startsWith(prefix), currentMode);
      };
      rule('The authenticated Deriv trading connection is not open.', trading.status !== 'connected');
      rule('No Deriv account is authorized for trading.', trading.activeAccount === null);
      rule('The public market-data feed is reconnecting; new pairs are paused until ticks resume.', feed.status === 'error' || feed.status === 'reconnecting');
      rule('The live tick stream is stale; new pairs wait until genuine ticks resume.', !feed.fresh && feed.status === 'live');
      return next;
    });
  }, [trading.status, trading.activeAccount, feed.status, feed.fresh]);

  /**
   * Keeps the feed on a Step index.
   *
   * The Mafia bot trades step indices only, and the shared feed remembers the
   * last symbol the operator picked. Rather than trading whatever is selected,
   * the bot moves the feed to a Step index on entry and says so in the log.
   */
  const stepMarkets = useMemo(() => stepIndexMarkets(feed.symbols), [feed.symbols]);
  useEffect(() => {
    if (!stepMarkets.length) return;
    if (isStepIndexMarket(feed.selectedSymbol, feed.selectedMarket?.name)) return;
    feed.setSelectedSymbol(stepMarkets[0].symbol);
  }, [feed.selectedSymbol, feed.selectedMarket?.name, feed.setSelectedSymbol, stepMarkets]);

  // ---- market analysis ------------------------------------------------------
  // The gated replay scores up to 1 200 historical windows, which costs tens of
  // milliseconds. Both the panel and the cycle read the same answer for the same
  // tick, so it is computed once per tick and reused instead of twice — the
  // duplicate pass was pure latency in front of the purchase.
  const gatedCacheRef = useRef<{ key: string; result: MafiaGatedReplay } | null>(null);
  const gatedFor = useCallback((ticks: readonly { epoch: number; quote: number }[], cfg: MafiaBotConfig, symbol: string) => {
    const last = ticks[ticks.length - 1];
    const key = [
      symbol,
      ticks.length,
      last?.epoch ?? 0,
      cfg.replayTicks,
      cfg.uniformityWindow,
      cfg.minUniformity,
      cfg.minUniformityZ,
      cfg.minDirectionSamples,
    ].join(':');
    if (gatedCacheRef.current?.key === key) return gatedCacheRef.current.result;
    const result = replayGatedOutcomes(ticks, cfg);
    gatedCacheRef.current = { key, result };
    return result;
  }, []);
  const symbolAllowed = isStepIndexMarket(feed.selectedSymbol, feed.selectedMarket?.name);
  const analysis = useMemo(() => analyseMafiaMarket(
    feed.ticks.map((tick) => ({ epoch: tick.epoch, quote: tick.quote })),
    config,
    { symbol: feed.selectedSymbol, now: clock },
  ), [feed.ticks, config, feed.selectedSymbol, clock]);
  const gated = useMemo(() => gatedFor(
    feed.ticks.map((tick) => ({ epoch: tick.epoch, quote: tick.quote })),
    config,
    feed.selectedSymbol,
  ), [feed.ticks, config, feed.selectedSymbol, gatedFor]);

  // ---- score the predictions ------------------------------------------------
  useEffect(() => {
    if (!feed.ticks.length || !predictionsRef.current.some((row) => row.outcome === null)) return;
    const result = resolveMafiaPredictions(predictionsRef.current, feed.ticks, Date.now());
    if (!result.changed) return;
    predictionsRef.current = result.rows;
    setPredictions(result.rows);
  }, [feed.ticks]);

  // ---- settlement -----------------------------------------------------------
  const syncWithAccount = useCallback((positions: readonly DerivOpenPosition[], closed: readonly DerivClosedPosition[], now: number) => {
    let rows = pairsRef.current;
    let ledger = accountRef.current;
    let changed = false;

    const settle = (pairId: string, side: MafiaLegSide, profit: number, exitSpot: number | null, settledAt: number) => {
      const index = rows.findIndex((pair) => pair.id === pairId);
      if (index === -1) return;
      const pair = rows[index];
      const leg = legOf(pair, side);
      if (leg.contractId === null || legIsSettled(leg)) return;
      const outcome: SettlementOutcome = profit > 0 ? 'win' : profit < 0 ? 'loss' : 'push';
      ledger = applySettlement(ledger, { stake: leg.stake, profit, outcome, now: settledAt });
      const updated = settleMafiaLeg(pair, side, { profit, exitSpot, settledAt });
      const next = updated.netProfit !== null ? { ...updated, balanceAfter: ledger.balance } : updated;
      rows = rows.map((row, at) => (at === index ? next : row));
      changed = true;
    };

    /**
     * Recovers legs whose buy reply never arrived.
     *
     * A contract is adopted only when the account reports one on the same symbol,
     * with the same contract type, a buy price matching the leg's stake to the
     * cent, and a buy time inside the pair's window — and only when no other pair
     * already claims that contract id. Anything less certain stays unreconciled.
     */
    const claimed = new Set<number>();
    for (const pair of rows) {
      for (const leg of boughtLegs(pair)) if (leg.contractId !== null) claimed.add(leg.contractId);
    }
    rows = rows.map((pair) => {
      if (pair.status !== 'unreconciled') return pair;
      const adopt = (side: MafiaLegSide): MafiaPair => {
        const leg = legOf(pair, side);
        if (leg.contractId !== null) return pair;
        const match = positions.find((position) => !claimed.has(position.contractId)
          && !position.isSold
          && position.symbol === pair.symbol
          && (position.contractType === null || position.contractType === leg.contractType)
          && position.buyPrice !== null
          && Math.abs(position.buyPrice - leg.stake) <= 0.01
          && position.buyTime !== null
          && Math.abs(position.buyTime * 1_000 - pair.at) <= 120_000);
        if (!match) return pair;
        claimed.add(match.contractId);
        changed = true;
        const updated: MafiaPair = applyLegPurchase(pair, side, {
          contractId: match.contractId,
          buyPrice: match.buyPrice ?? leg.stake,
          payout: match.payout,
          balanceAfter: null,
          startTime: match.buyTime,
          longcode: match.longcode,
        });
        return { ...updated, entrySpot: updated.entrySpot ?? match.entrySpot, note: `${updated.note} Leg adopted from the account after a missing purchase reply.`.trim() };
      };
      let next = adopt('primary');
      next = adopt('cover');
      if (next.primary.contractId !== null && next.cover.contractId !== null) {
        return { ...next, status: 'open' };
      }
      return next;
    });

    for (const pair of rows) {
      if (pair.status === 'rejected') continue;
      for (const side of ['primary', 'cover'] as const) {
        const leg = legOf(pair, side);
        if (leg.contractId === null || legIsSettled(leg)) continue;
        const live = positions.find((position) => position.contractId === leg.contractId);
        if (live && live.isSold && live.profit !== null) {
          settle(pair.id, side, live.profit, live.exitSpot, now);
          continue;
        }
        const row = closed.find((item) => item.contractId === leg.contractId);
        if (row) settle(pair.id, side, row.profit, null, row.sellTime ? row.sellTime * 1_000 : now);
      }
    }

    if (!changed) return;
    const exposure = rows
      .flatMap((pair) => boughtLegs(pair))
      .filter((leg) => !legIsSettled(leg))
      .reduce((total, leg) => total + leg.stake, 0);
    commitPairs(rows);
    commitAccount(setOpenExposure(ledger, exposure));
  }, [commitAccount, commitPairs]);

  useEffect(() => {
    if (!trading.openPositions.length && !trading.closedPositions.length) return;
    syncWithAccount(trading.openPositions, trading.closedPositions, Date.now());
  }, [trading.openPositions, trading.closedPositions, syncWithAccount]);

  /** The unreconciled pause lifts only when no pair is still waiting on Deriv. */
  useEffect(() => {
    const stuck = pairs.some((pair) => pair.status === 'unreconciled');
    if (stuck) {
      unreconciledRef.current = true;
      return;
    }
    unreconciledRef.current = false;
    setSafety((current) => clearAutoPause(current, (reason) => reason === UNRECONCILED_REASON, modeRef.current));
  }, [pairs]);

  /** An orphaned leg (partner never bought) pauses new pairs until it is closed. */
  useEffect(() => {
    const orphan = pairs.some((pair) => pair.status === 'partial' && boughtLegs(pair).some((leg) => !legIsSettled(leg)));
    setSafety((current) => (orphan
      ? registerAutoPause(current, ORPHAN_LEG_REASON, modeRef.current)
      : clearAutoPause(current, (reason) => reason === ORPHAN_LEG_REASON, modeRef.current)));
  }, [pairs]);

  // ---- risk snapshot --------------------------------------------------------
  const sessionPairs = useMemo(() => {
    const startedAt = account.sessionStartedAt;
    return startedAt === null ? [] : pairs.filter((pair) => pair.at >= startedAt);
  }, [pairs, account.sessionStartedAt]);

  const sessionSummary = useMemo(() => summarizeMafiaPairs(sessionPairs), [sessionPairs]);
  const summary = useMemo(() => summarizeMafiaPairs(pairs), [pairs]);
  const predictionSummary = useMemo(() => summarizeMafiaPredictions(predictions), [predictions]);
  const pairsCsv = useMemo(() => mafiaPairsToCsv(pairs), [pairs]);

  const risk = useMemo<MafiaRiskSnapshot>(() => ({
    balance: account.balance ?? trading.balance,
    dailyNet: account.dailyPnl,
    sessionNet: sessionSummary.realisedProfit,
    openPairs: pairs.filter(isPairOpen).length,
    pairsThisSession: sessionPairs.filter((pair) => pair.status !== 'rejected' && boughtLegs(pair).length > 0).length,
    consecutiveLosingPairs: sessionSummary.currentLosingStreak,
    sessionStartedAt: account.sessionStartedAt,
    lastPairAt: sessionPairs.filter((pair) => pair.status !== 'rejected').at(-1)?.at ?? null,
  }), [account.balance, account.dailyPnl, account.sessionStartedAt, trading.balance, pairs, sessionPairs, sessionSummary]);

  const sessionStopReason = useMemo(
    () => mafiaSessionStop({ config, risk, now: Date.now() }),
    [config, risk],
  );

  // ---- proposals ------------------------------------------------------------
  /** The two requests a pair consists of. Deterministic, so they can be rebuilt. */
  const legRequests = useCallback((
    symbol: string,
    currency: string,
    primaryStake: number,
    coverStake: number,
    direction: 'CALL' | 'PUT',
  ) => {
    const base: Omit<DerivTradeRequest, 'contractType' | 'stake'> = {
      symbol,
      currency,
      duration: MAFIA_DURATION_TICKS,
      durationUnit: 't',
      barrier: null,
      selectedTick: null,
    };
    return {
      primaryRequest: { ...base, contractType: direction, stake: primaryStake } as DerivTradeRequest,
      coverRequest: { ...base, contractType: oppositeDirection(direction), stake: coverStake } as DerivTradeRequest,
    };
  }, []);

  /** Requests both legs' quotes together. Nothing is bought by this. */
  const requestQuotes = useCallback(async (
    symbol: string,
    currency: string,
    primaryStake: number,
    coverStake: number,
    direction: 'CALL' | 'PUT',
  ) => {
    const { primaryRequest, coverRequest } = legRequests(symbol, currency, primaryStake, coverStake, direction);
    const [primary, cover] = await Promise.allSettled([
      trading.requestQuote(primaryRequest),
      trading.requestQuote(coverRequest),
    ]);
    return { primaryRequest, coverRequest, primary, cover };
  }, [legRequests, trading]);

  /** Prices the pair without buying: used every cycle, in both modes. */
  const previewQuotes = useCallback(async (
    symbol: string,
    currency: string,
    direction: 'CALL' | 'PUT',
    sizing: MafiaSizing,
    now: number,
  ): Promise<{
    quotes: { primaryAsk: number | null; coverAsk: number | null; primaryPayout: number | null; coverPayout: number | null } | null;
    primaryQuote: DerivQuote | null;
    coverQuote: DerivQuote | null;
    pricing: MafiaPricing;
  }> => {
    const result = await requestQuotes(symbol, currency, sizing.primaryStake, sizing.coverStake, direction);
    const offset = feedRef.current.serverClockOffsetMs;
    const primaryQuote = result.primary.status === 'fulfilled' ? result.primary.value : null;
    const coverQuote = result.cover.status === 'fulfilled' ? result.cover.value : null;
    const primaryLabel = direction === 'CALL' ? 'Rise leg' : 'Fall leg';
    const coverLabel = direction === 'CALL' ? 'Fall leg' : 'Rise leg';
    const primaryIssues = quoteIssues(result.primary, sizing.primaryStake, now, configRef.current.maxTickAgeMs, offset, primaryLabel);
    const coverIssues = quoteIssues(result.cover, sizing.coverStake, now, configRef.current.maxTickAgeMs, offset, coverLabel);
    const nextPricing: MafiaPricing = {
      at: now,
      symbol,
      primary: legPricing('primary', direction, primaryQuote, primaryIssues),
      cover: legPricing('cover', oppositeDirection(direction), coverQuote, coverIssues),
      economics: null,
      notes: [],
    };
    if (!primaryQuote || !coverQuote) {
      nextPricing.notes.push([...primaryIssues, ...coverIssues].join(' ') || 'Deriv did not return both proposals.');
      return { quotes: null, primaryQuote, coverQuote, pricing: nextPricing };
    }
    if (primaryIssues.length || coverIssues.length) {
      nextPricing.notes.push([...primaryIssues, ...coverIssues].join(' '));
      return { quotes: null, primaryQuote, coverQuote, pricing: nextPricing };
    }
    return {
      quotes: {
        primaryAsk: primaryQuote.askPrice,
        coverAsk: coverQuote.askPrice,
        primaryPayout: primaryQuote.payout,
        coverPayout: coverQuote.payout,
      },
      primaryQuote,
      coverQuote,
      pricing: nextPricing,
    };
  }, [requestQuotes]);

  // ---- execution ------------------------------------------------------------
  /**
   * Buys both legs back to back, in the same tick.
   *
   * There is no stagger: the two `buy` messages leave together and each reply is
   * matched to its own request. If one leg is refused the bought leg is sold
   * back, because a single leg is not the position this bot's analysis priced.
   */
  const executePair = useCallback(async (options: {
    decisionId: string;
    symbol: string;
    currency: string;
    direction: 'CALL' | 'PUT';
    primaryQuote: DerivQuote;
    coverQuote: DerivQuote;
    primaryRequest: DerivTradeRequest;
    coverRequest: DerivTradeRequest;
    sizing: MafiaSizing;
    analysis: MafiaAnalysis;
    evaluation: MafiaEvaluation;
  }): Promise<CycleResult> => {
    const { decisionId, symbol, currency, direction, primaryQuote, coverQuote, primaryRequest, coverRequest, sizing, analysis: snapshot, evaluation: priced } = options;
    if (inFlightRef.current) return { executed: false, pairId: null, message: 'A pair purchase is already in progress.' };
    if (unreconciledRef.current) return { executed: false, pairId: null, message: 'A previous purchase is still unreconciled with Deriv.' };
    if (!currency) return { executed: false, pairId: null, message: 'Deriv has not reported the account currency.' };

    setPurchaseInFlight(true);
    const pair = makeMafiaPair({
      id: decisionId,
      at: Date.now(),
      symbol,
      mode: 'live',
      direction,
      primaryStake: sizing.primaryStake,
      coverStake: sizing.coverStake,
      uniformity: snapshot.uniformity.score,
      probability: priced.measured,
      breakEven: priced.breakEven,
      expectedValue: priced.economics?.expectedValue ?? null,
      note: `Four-tick pair, both legs bought together. Break-even ${priced.breakEven === null ? '—' : `${(priced.breakEven * 100).toFixed(1)}%`}, evidence ${priced.evidence === null ? '—' : `${(priced.evidence * 100).toFixed(1)}%`}.`,
    });

    const [primaryBuy, coverBuy] = await Promise.allSettled([
      tradingRef.current.confirmBuy(primaryQuote, primaryRequest),
      tradingRef.current.confirmBuy(coverQuote, coverRequest),
    ]);
    if (!mountedRef.current) {
      setPurchaseInFlight(false);
      return { executed: false, pairId: null, message: 'The bot closed while Deriv was buying.' };
    }

    const bookedAt = Date.now();
    const primaryReceipt: DerivBuyReceipt | null = primaryBuy.status === 'fulfilled' ? primaryBuy.value : null;
    const coverReceipt: DerivBuyReceipt | null = coverBuy.status === 'fulfilled' ? coverBuy.value : null;
    const primaryError = primaryBuy.status === 'rejected' ? errorText(primaryBuy.reason) : null;
    const coverError = coverBuy.status === 'rejected' ? errorText(coverBuy.reason) : null;
    const uncertain = (primaryError !== null && UNCERTAIN_PURCHASE.test(primaryError))
      || (coverError !== null && UNCERTAIN_PURCHASE.test(coverError));

    let booked = applyLegQuote(pair, 'primary', { askPrice: primaryQuote.askPrice, payout: primaryQuote.payout });
    booked = applyLegQuote(booked, 'cover', { askPrice: coverQuote.askPrice, payout: coverQuote.payout });
    if (primaryReceipt) {
      booked = applyLegPurchase(booked, 'primary', primaryReceipt);
      commitAccount(applyPurchase(accountRef.current, { stake: primaryReceipt.buyPrice, now: bookedAt }));
    }
    if (coverReceipt) {
      booked = applyLegPurchase(booked, 'cover', coverReceipt);
      commitAccount(applyPurchase(accountRef.current, { stake: coverReceipt.buyPrice, now: bookedAt }));
    }
    booked = { ...booked, entrySpot: primaryQuote.spot ?? coverQuote.spot ?? null, at: bookedAt };

    if (primaryReceipt && coverReceipt) {
      const startSkew = primaryReceipt.startTime !== null && coverReceipt.startTime !== null
        ? Math.abs(primaryReceipt.startTime - coverReceipt.startTime)
        : null;
      const note = startSkew !== null && startSkew > 1
        ? `Entry ticks differ by ${startSkew}s — the legs did not enter on the same tick, so this pair is not the hedged position the analysis priced.`
        : 'Both legs entered on the same tick.';
      commitPairs([...pairsRef.current, { ...booked, note: `${booked.note} ${note}`.trim() }]);
      setPurchaseInFlight(false);
      return {
        executed: true,
        pairId: decisionId,
        message: `Deriv confirmed contracts ${primaryReceipt.contractId} (${direction === 'CALL' ? 'Rise' : 'Fall'}) and ${coverReceipt.contractId} (${direction === 'CALL' ? 'Fall' : 'Rise'})${startSkew !== null && startSkew > 1 ? ` — entry ticks differ by ${startSkew}s` : ''}.`,
      };
    }

    if (uncertain) {
      unreconciledRef.current = true;
      setSafety((current) => registerAutoPause(current, UNRECONCILED_REASON, modeRef.current));
      commitPairs([...pairsRef.current, {
        ...booked,
        status: 'unreconciled',
        note: `${booked.note} Purchase reply not received: ${[primaryError, coverError].filter(Boolean).join(' ')}`.trim(),
      }]);
      setPurchaseInFlight(false);
      return { executed: false, pairId: decisionId, message: [primaryError, coverError].filter(Boolean).join(' ') };
    }

    // One leg refused: a single leg is not a hedge, so the survivor is sold back.
    const survivor = primaryReceipt?.contractId ?? coverReceipt?.contractId ?? null;
    const rejected = rejectMafiaPair(booked, `Pair not opened: ${[primaryError, coverError].filter(Boolean).join(' ')}`.trim());
    commitPairs([...pairsRef.current, survivor === null ? rejected : { ...rejected, status: 'partial' }]);
    setPurchaseInFlight(false);
    if (survivor !== null) {
      tradingRef.current.sellContract(survivor).catch(() => {
        setSafety((current) => registerAutoPause(current, ORPHAN_LEG_REASON, modeRef.current));
      });
    }
    return { executed: false, pairId: decisionId, message: [primaryError, coverError].filter(Boolean).join(' ') || 'Deriv refused both purchases.' };
  }, [commitAccount, commitPairs, setPurchaseInFlight]);

  // ---- the decision cycle ---------------------------------------------------
  const runCycle = useCallback(async (options?: { force?: boolean }) => {
    if (busyRef.current) {
      // A cycle is already pricing. The tick that just arrived would otherwise be
      // dropped and the entry would wait for the next one, so it is re-run as soon
      // as the current cycle releases the lock.
      pendingCycleRef.current = true;
      return;
    }
    const forced = options?.force === true;
    if (!forced && safetyRef.current.runState !== 'running') return;
    const cfg = configRef.current;
    const currentMode = modeRef.current;
    const startedAt = Date.now();
    // Only dedupe: a new tick is the event that starts a cycle, so the floor is
    // milliseconds, not the whole decision interval it used to wait for.
    if (!shouldStartBotCycle({ now: startedAt, lastCycleAt: lastCycleRef.current, minSpacingMs: BOT_CYCLE_MIN_SPACING_MS, force: forced })) return;
    const symbol = feedRef.current.selectedSymbol;
    const observations = feedRef.current.ticks;
    if (!symbol || !observations.length) return;

    busyRef.current = true;
    lastCycleRef.current = startedAt;
    setCycleRunning(true);
    const decisionId = nextDecisionId(startedAt, symbol);

    try {
      const nowAnalysis = analyseMafiaMarket(
        observations.map((tick) => ({ epoch: tick.epoch, quote: tick.quote })),
        cfg,
        { symbol, now: startedAt },
      );
      const nowGated = gatedFor(
        observations.map((tick) => ({ epoch: tick.epoch, quote: tick.quote })),
        cfg,
        symbol,
      );
      const sizing = sizeMafiaPair(cfg, { balance: risk.balance, consecutiveLosingPairs: risk.consecutiveLosingPairs });

      // Every uniformity pass is recorded once, in both modes, so the hit rate
      // describes the gate rather than only the pairs the money rules allowed.
      const latest = observations[observations.length - 1];
      const gatedDirection = nowAnalysis.uniformity.direction;
      if (gatedDirection !== null && verdictOnUniformity(nowAnalysis.uniformity, cfg).passes && !sizing.blocked) {
        const already = predictionsRef.current.some((row) => row.entryEpoch === latest.epoch && row.symbol === symbol);
        if (!already) {
          const prediction: MafiaPrediction = {
            id: decisionId,
            at: startedAt,
            symbol,
            entryEpoch: latest.epoch,
            entryQuote: latest.quote,
            direction: gatedDirection,
            uniformity: nowAnalysis.uniformity.score,
            probability: nowGated.winRate,
            exitEpoch: null,
            exitQuote: null,
            outcome: null,
            resolvedAt: null,
          };
          predictionsRef.current = [...predictionsRef.current, prediction].slice(-PREDICTION_LIMIT);
          setPredictions(predictionsRef.current);
        }
      }

      // Price both legs before deciding, in both modes. Quotes never buy, and
      // the pair that is bought uses exactly the quotes this cycle priced — no
      // second round trip once uniformity has fired.
      let quotes: MafiaDecisionInput['quotes'] = null;
      let priced: {
        at: number;
        direction: 'CALL' | 'PUT';
        primaryStake: number;
        coverStake: number;
        primary: DerivQuote;
        cover: DerivQuote;
      } | null = null;
      const direction = nowAnalysis.uniformity.direction;
      if (direction !== null && !sizing.blocked) {
        const currency = trading.currency || accountRef.current.currency;
        const canQuote = Boolean(currency) && trading.activeAccount !== null && trading.status === 'connected';
        if (canQuote) {
          const cached = quoteCacheRef.current;
          const reusable = cached !== null
            && cached.symbol === symbol
            && cached.direction === direction
            && cached.primaryStake === sizing.primaryStake
            && cached.coverStake === sizing.coverStake
            && startedAt - cached.at < QUOTE_TTL_MS;
          if (reusable && cached) {
            quotes = {
              primaryAsk: cached.primary.askPrice,
              coverAsk: cached.cover.askPrice,
              primaryPayout: cached.primary.payout,
              coverPayout: cached.cover.payout,
            };
            priced = {
              at: cached.at,
              direction,
              primaryStake: cached.primaryStake,
              coverStake: cached.coverStake,
              primary: cached.primary,
              cover: cached.cover,
            };
            setPricing({
              at: cached.at,
              symbol,
              primary: legPricing('primary', direction, cached.primary, []),
              cover: legPricing('cover', oppositeDirection(direction), cached.cover, []),
              economics: null,
              notes: ['Quotes from the previous cycle, still inside their freshness window.'],
            });
          } else {
            try {
              const preview = await previewQuotes(symbol, currency, direction, sizing, startedAt);
              if (preview.primaryQuote && preview.coverQuote) {
                quoteCacheRef.current = {
                  at: startedAt,
                  symbol,
                  direction,
                  primaryStake: sizing.primaryStake,
                  coverStake: sizing.coverStake,
                  primary: preview.primaryQuote,
                  cover: preview.coverQuote,
                };
              }
              quotes = preview.quotes;
              if (preview.primaryQuote && preview.coverQuote) {
                priced = {
                  at: startedAt,
                  direction,
                  primaryStake: sizing.primaryStake,
                  coverStake: sizing.coverStake,
                  primary: preview.primaryQuote,
                  cover: preview.coverQuote,
                };
              }
              setPricing(preview.pricing);
            } catch (failure) {
              quotes = null;
              setPricing(null);
              setCycleError(errorText(failure));
            }
          }
        }
      }

      // The safety interlock is part of the gate, not an afterthought: an
      // auto-pause cause (a dropping feed, a missing account, an unresolved
      // purchase) blocks the pair even if the market and money rules allow it.
      const autoPauseReasons = safetyRef.current.autoPauseReasons;
      const result = evaluateMafiaEntry({
        now: startedAt,
        symbol,
        mode: currentMode,
        config: cfg,
        running: forced || safetyRef.current.runState === 'running',
        paused: !forced && autoPauseReasons.length > 0,
        analysis: nowAnalysis,
        gated: nowGated,
        risk,
        quotes,
        stopReason: autoPauseReasons[0]
          ?? sessionStopReason
          ?? (unreconciledRef.current ? UNRECONCILED_REASON : null),
      });

      let finalDecision = result.decision;
      if (finalDecision.action === 'TRADE') {
        if (!symbolAllowed) {
          finalDecision = {
            ...finalDecision,
            action: 'BLOCKED',
            actionLabel: 'Blocked · market is not a Step index',
            reasons: [...finalDecision.reasons, `${symbol} is not a Step index. The Mafia bot trades step indices only.`],
            reasonCodes: [...finalDecision.reasonCodes, 'NOT_STEP_INDEX'],
          };
        } else if (result.sizing === null) {
          finalDecision = { ...finalDecision, action: 'BLOCKED', actionLabel: 'Blocked · no stake plan' };
        } else if (currentMode !== 'live') {
          finalDecision = {
            ...finalDecision,
            actionLabel: 'Would buy both legs · analysis mode',
            reasons: [...finalDecision.reasons, 'Analysis mode: both legs were priced and the pair passed every gate; no order was sent.'],
            reasonCodes: [...finalDecision.reasonCodes, 'ANALYSIS_MODE'],
          };
        } else if (inFlightRef.current) {
          finalDecision = { ...finalDecision, action: 'WAIT', actionLabel: 'Waiting · a purchase is in flight', reasonCodes: [...finalDecision.reasonCodes, 'PURCHASE_IN_FLIGHT'] };
        } else {
          // Buy on the quotes this cycle already priced. Only a missing or stale
          // price costs another round trip, so uniformity fires straight into the
          // two purchases instead of waiting for a second quote.
          const currency = trading.currency || accountRef.current.currency;
          const buyDirection = finalDecision.direction ?? nowAnalysis.uniformity.direction ?? 'CALL';
          const reusablePair = priced !== null
            && priced.direction === buyDirection
            && priced.primaryStake === result.sizing.primaryStake
            && priced.coverStake === result.sizing.coverStake
            && startedAt - priced.at <= QUOTE_TTL_MS;
          const fresh = reusablePair
            ? null
            : await requestQuotes(symbol, currency, result.sizing.primaryStake, result.sizing.coverStake, buyDirection);
          const primaryQuote = reusablePair ? (priced?.primary ?? null) : (fresh && fresh.primary.status === 'fulfilled' ? fresh.primary.value : null);
          const coverQuote = reusablePair ? (priced?.cover ?? null) : (fresh && fresh.cover.status === 'fulfilled' ? fresh.cover.value : null);
          const buyRequests = legRequests(symbol, currency, result.sizing.primaryStake, result.sizing.coverStake, buyDirection);
          if (!primaryQuote || !coverQuote) {
            const primaryIssue = fresh && fresh.primary.status === 'rejected' ? errorText(fresh.primary.reason) : 'no Rise quote';
            const coverIssue = fresh && fresh.cover.status === 'rejected' ? errorText(fresh.cover.reason) : 'no Fall quote';
            const message = [!primaryQuote ? primaryIssue : '', !coverQuote ? coverIssue : '']
              .filter(Boolean)
              .join(' ');
            finalDecision = {
              ...finalDecision,
              action: 'BLOCKED',
              actionLabel: 'Blocked at purchase · no quotes',
              reasons: [...finalDecision.reasons, message || 'Deriv did not return both proposals.'],
              reasonCodes: [...finalDecision.reasonCodes, 'QUOTES_MISSING'],
              error: message || null,
            };
          } else {
            // The fresh quotes must still clear the break-even; a pair is never
            // bought on a price that only existed in the previous cycle.
            const refreshed = evaluatePairEconomics({
              primaryStake: result.sizing.primaryStake,
              coverStake: result.sizing.coverStake,
              primaryAsk: primaryQuote.askPrice,
              coverAsk: coverQuote.askPrice,
              primaryPayout: primaryQuote.payout,
              coverPayout: coverQuote.payout,
              probability: result.measured,
              flatProbability: nowAnalysis.replay.flatProbability,
            });
            const stillClears = !refreshed.paysLessThanCost
              && refreshed.breakEvenProbability !== null
              && result.evidence !== null
              && result.evidence >= refreshed.breakEvenProbability;
            // A pair whose winning leg cannot cover both stakes is never bought,
            // whatever the gate setting. The evidence test only applies when the
            // expected-value gate is on.
            const mustBlock = refreshed.paysLessThanCost || (config.requirePositiveExpectedValue && !stillClears);
            const spotAge = reusablePair && priced !== null ? startedAt - priced.at : 0;
            if (mustBlock) {
              finalDecision = {
                ...finalDecision,
                action: 'BLOCKED',
                actionLabel: refreshed.paysLessThanCost ? 'Blocked · payout moved' : 'Blocked · price moved before entry',
                reasons: [
                  ...finalDecision.reasons,
                  refreshed.paysLessThanCost
                    ? `The fresh quotes no longer let either leg cover the pair cost of ${moneyText(refreshed.totalCost)}; nothing was bought.`
                    : `The fresh quotes need a ${((refreshed.breakEvenProbability ?? 1) * 100).toFixed(1)}% hit rate, which the ${((result.evidence ?? 0) * 100).toFixed(1)}% evidence does not cover. Nothing was bought.`,
                ],
                reasonCodes: [...finalDecision.reasonCodes, 'PRICE_CHANGED'],
                error: 'The quotes changed between the decision and the purchase.',
              };
            } else {
              const executed = await executePair({
                decisionId,
                symbol,
                currency,
                direction: buyDirection,
                primaryQuote,
                coverQuote,
                primaryRequest: buyRequests.primaryRequest,
                coverRequest: buyRequests.coverRequest,
                sizing: result.sizing,
                analysis: nowAnalysis,
                evaluation: result,
              });
              if (executed.executed) {
                finalDecision = {
                  ...finalDecision,
                  actionLabel: 'Bought both legs · 4 ticks',
                  executed: true,
                  pairId: executed.pairId,
                  reasons: [...finalDecision.reasons, executed.message, spotAge > 0 ? `Entry priced ${(spotAge / 1_000).toFixed(1)}s before the purchase.` : 'Entry priced and bought in the same cycle.'],
                  reasonCodes: [...finalDecision.reasonCodes, 'ORDER_SENT'],
                };
              } else {
                finalDecision = {
                  ...finalDecision,
                  action: 'BLOCKED',
                  actionLabel: 'Blocked at purchase · pair not opened',
                  executed: false,
                  pairId: executed.pairId,
                  error: executed.message || 'The pair was not sent.',
                  reasons: [...finalDecision.reasons, executed.message].filter(Boolean),
                  reasonCodes: [...finalDecision.reasonCodes, 'PURCHASE_REFUSED'],
                };
              }
            }
          }
        }
      }
      if (!mountedRef.current) return;

      setEvaluation({ ...result, decision: finalDecision });
      setDecision(finalDecision);
      setPricing((current) => (current === null || result.economics === null ? current : { ...current, economics: result.economics }));
      setCycleLog((items) => [finalDecision, ...items].slice(0, LOG_LIMIT));
      setLastCycleAt(startedAt);
      setCycleError('');
    } catch (failure) {
      if (!mountedRef.current) return;
      const message = failure instanceof Error ? failure.message : 'The decision cycle failed.';
      setCycleError(message);
      setCycleLog((items) => [{
        id: decisionId,
        at: startedAt,
        symbol,
        mode: currentMode,
        action: 'BLOCKED' as const,
        actionLabel: 'Cycle error',
        reasons: [message],
        reasonCodes: ['CYCLE_ERROR'],
        direction: null,
        uniformity: null,
        probability: null,
        primaryStake: null,
        coverStake: null,
        executed: false,
        pairId: null,
        error: message,
      }, ...items].slice(0, LOG_LIMIT));
      setPurchaseInFlight(false);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCycleRunning(false);
      if (pendingCycleRef.current) {
        pendingCycleRef.current = false;
        // Unforced: the spacing floor still keeps a slow cycle from looping.
        void runCycleRef.current();
      }
    }
  }, [executePair, legRequests, nextDecisionId, previewQuotes, requestQuotes, risk, sessionStopReason, symbolAllowed]);

  runCycleRef.current = runCycle;

  // Every new tick starts a cycle, with the configured interval acting as the
  // watchdog for a quiet feed instead of as the entry latency.
  useBotCycleTrigger({
    enabled: safety.runState === 'running',
    tickEpoch: feed.ticks.at(-1)?.epoch ?? null,
    watchdogMs: config.decisionIntervalMs,
    run: () => { void runCycleRef.current(); },
  });

  // ---- operator controls ----------------------------------------------------
  const start = useCallback(() => {
    const now = Date.now();
    quoteCacheRef.current = null;
    commitAccount(beginSession(rollTradingDay(accountRef.current, now), now));
    setSafety((current) => startBot(current, modeRef.current));
    lastCycleRef.current = 0;
    // The first cycle runs now: the safety ref still holds the pre-Start state,
    // so it has to be forced rather than waiting for the next tick.
    void runCycleRef.current({ force: true });
  }, [commitAccount]);

  const pause = useCallback(() => setSafety((current) => pauseBot(current, modeRef.current)), []);
  const resume = useCallback(() => {
    // A pending reconciliation cannot be cleared by pressing resume: it clears
    // itself when the account reports the missing legs.
    setSafety((current) => resumeBot(current, modeRef.current));
  }, []);
  const stop = useCallback(() => {
    setSafety((current) => stopBot(current, modeRef.current, { now: Date.now(), by: 'user' }));
  }, []);

  const runCycleNow = useCallback(() => {
    lastCycleRef.current = 0;
    void runCycleRef.current({ force: true });
  }, []);

  const setMode = useCallback((next: MafiaMode) => {
    setModeState(next);
    setSafety((current) => stopBot(current, next, { now: Date.now(), by: 'user' }));
  }, []);

  const updateConfig = useCallback((patch: Partial<MafiaBotConfig>) => {
    setConfig((current) => sanitizeMafiaBotConfig({ ...current, ...patch }));
  }, []);

  const resetConfig = useCallback(() => setConfig(sanitizeMafiaBotConfig(defaultMafiaBotConfig())), []);

  const closeLeg = useCallback(async (pairId: string, side: MafiaLegSide) => {
    const pair = pairsRef.current.find((row) => row.id === pairId);
    if (!pair) return;
    const leg = legOf(pair, side);
    if (leg.contractId === null || legIsSettled(leg)) return;
    await tradingRef.current.sellContract(leg.contractId);
  }, []);

  const clearTradeLog = useCallback(() => {
    commitPairs([]);
    setPredictions([]);
    predictionsRef.current = [];
  }, [commitPairs]);

  const latestTick = feed.ticks.at(-1) ?? null;
  const currency = trading.currency || trading.activeAccount?.currency || '';
  const sessionMinutesRemaining = config.maxSessionMinutes > 0 && account.sessionStartedAt !== null
    ? Math.max(0, config.maxSessionMinutes - Math.floor((clock - account.sessionStartedAt) / 60_000))
    : null;

  const controller = useMemo<MafiaBotController>(() => {
    const riseFallSupported = feed.contractsLoaded
      ? feed.contracts.some((contract) => contract.contractType === 'CALL')
        && feed.contracts.some((contract) => contract.contractType === 'PUT')
      : null;
    return {
      mode,
      setMode,
      runState: safety.runState,
      safety,
      start,
      pause,
      resume,
      stop,
      runCycleNow,

      config,
      updateConfig,
      resetConfig,

      symbol: feed.selectedSymbol,
      selectSymbol: feed.setSelectedSymbol,
      stepMarkets,
      marketName: feed.selectedMarket?.name ?? '',
      symbolAllowed,
      precision: feed.selectedMarket?.precision ?? null,
      quote: latestTick?.quote ?? null,
      tickCount: feed.ticks.length,
      feedStatus: feed.status,
      feedFresh: feed.fresh,
      feedError: feed.feedError || feed.contractError,
      precisionError: feed.precisionError,
      contractsLoaded: feed.contractsLoaded,
      riseFallSupported,

      analysis,
      gated,
      evaluation,
      decision,
      cycleLog,
      cycleRunning,
      cycleError,
      lastCycleAt,
      pricing,
      sizing: evaluation?.sizing ?? null,
      economics: evaluation?.economics ?? null,
      evidence: evaluation?.evidence ?? null,
      breakEven: evaluation?.breakEven ?? null,
      sessionStopReason,

      account,
      accountType: trading.activeAccount?.accountType ?? null,
      accountCurrency: currency,
      balance: trading.balance,
      connected: trading.status === 'connected',
      pairs,
      predictions,
      summary,
      predictionSummary,
      sessionSummary,
      pairsCsv,
      openPositions: trading.openPositions,
      purchaseInFlight: inFlight,
      unreconciledPurchase: pairs.some((pair) => pair.status === 'unreconciled'),
      sessionMinutesRemaining,

      closeLeg,
      clearTradeLog,
    };
  }, [
    account, analysis, clearTradeLog, closeLeg, config, currency, cycleError, cycleLog, cycleRunning,
    decision, evaluation, feed.contractError, feed.contracts, feed.contractsLoaded, feed.feedError,
    feed.fresh, feed.precisionError, feed.selectedMarket?.name, feed.selectedMarket?.precision,
    feed.selectedSymbol, feed.setSelectedSymbol, feed.status, feed.ticks.length, gated, inFlight,
    lastCycleAt, latestTick?.quote, mode, pairs, pairsCsv, pause, predictionSummary, predictions,
    pricing, resetConfig, resume, runCycleNow, safety, sessionMinutesRemaining,
    sessionStopReason, sessionSummary, setMode, start, stepMarkets, stop, summary, symbolAllowed,
    trading.activeAccount?.accountType, trading.activeAccount?.currency, trading.balance,
    trading.currency, trading.openPositions, trading.status, updateConfig,
  ]);

  return controller;
}
