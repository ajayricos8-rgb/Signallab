// High/Low Tick hedging bot controller.
//
// Connects the engine in `lib/hedging-bot` to the two Deriv connections the app
// already has: the public tick feed (`useDerivDigitFeed`) and the authenticated
// trading session (`useDerivTrading`). Each decision cycle:
//
//   1. replays the verified ticks and picks a tick position for each leg;
//   2. gates the pair (mode, feed, account, limits, streak, balance);
//   3. in live mode, requests a `proposal` for TICKHIGH and TICKLOW together,
//      validates both quotes, applies the expected-value gate, then buys both
//      legs at the same moment;
//   4. settles each leg only from Deriv's own contract report.
//
// Analysis mode records each entry and scores it later. When an account is
// connected it also requests the two proposals so the live payouts are visible.
// Requesting a quote never buys anything, so analysis mode still sends no `buy`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDerivDigitFeed } from '@/hooks/use-deriv-digit-feed';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import type {
  DerivBuyReceipt,
  DerivClosedPosition,
  DerivOpenPosition,
  DerivQuote,
  DerivTradeRequest,
} from '@/lib/deriv-trading';
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
import { evaluatePairEconomics, validateLegProposal, type PairEconomics } from '@/lib/hedging-bot/economics';
import {
  boughtLegs,
  finalizePair,
  isPairOpen,
  legIsSettled,
  legOf,
  pairsToCsv,
  settleLeg,
  summarizePairs,
  summarizePredictions,
  trimPairs,
} from '@/lib/hedging-bot/ledger';
import { evaluateHedgeGate, hedgeSessionMinutesRemaining, sizeLegStake, type HedgeGate } from '@/lib/hedging-bot/risk';
import {
  reconcilePurchase,
  concludeReconciliation,
  type UnreconciledPurchase,
} from '@/lib/hedging-bot/reconcile';
import { resolveHedgePredictions, selectHedgeTicks, type HedgeSelection, type TickQuote } from '@/lib/hedging-bot/selection';
import {
  HEDGE_CONTRACT_TYPES,
  HEDGE_SIDE_LABELS,
  HEDGE_WINDOW_TICKS,
  defaultHedgingBotConfig,
  sanitizeHedgingBotConfig,
  type HedgeDecision,
  type HedgeLeg,
  type HedgePair,
  type HedgePrediction,
  type HedgeSide,
  type HedgingBotConfig,
  type HedgingBotMode,
} from '@/lib/hedging-bot/types';

const MODE_KEY = 'signal-lab-hedging-bot-mode';
const CONFIG_KEY = 'signal-lab-hedging-bot-config';
const PAIRS_KEY = 'signal-lab-hedging-bot-pairs';
const PREDICTIONS_KEY = 'signal-lab-hedging-bot-predictions';

/** An analysis entry that has not resolved within this long is expired, not guessed at. */
const PREDICTION_MAX_PENDING_MS = 10 * 60_000;
/** Minimum spacing between analysis-mode proposal previews. */
const PREVIEW_INTERVAL_MS = 3_000;
/** A purchase reply that timed out may still have reached Deriv (same wording the Rise/Fall bot matches). */
const UNCERTAIN_PURCHASE = /did not confirm the purchase in time|closed before Deriv answered/i;

/** Pause cause for a leg that is open without its partner and could not be sold back. */
const ORPHAN_LEG_REASON = 'A hedge leg is open without its partner and could not be sold back; close it manually before any new pair.';

const LOG_LIMIT = 60;
const PAIR_LIMIT = 300;
const REJECTED_LIMIT = 100;
const PREDICTION_LIMIT = 300;

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

function readMode(): HedgingBotMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'analysis';
  } catch {
    return 'analysis';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Deriv rejected the request.';
}

type PurchaseLock = { inFlight: boolean; unreconciled: UnreconciledPurchase | null };

/** One leg's live price as the bot last saw it. */
export type LegPricing = {
  side: HedgeSide;
  tickPosition: number | null;
  ask: number | null;
  payout: number | null;
  rate: number | null;
  z: number | null;
  issues: string[];
};

/** The most recent pair pricing: an analysis preview, a refused pair, or a bought pair. */
export type PairPricing = {
  at: number;
  symbol: string;
  stake: number | null;
  source: 'preview' | 'purchase' | 'refused';
  high: LegPricing;
  low: LegPricing;
  economics: PairEconomics | null;
  notes: string[];
};

type EntryResult = { executed: boolean; pairId: string | null; message: string };

export type HedgingBotController = {
  // Controls
  mode: HedgingBotMode;
  setMode: (mode: HedgingBotMode) => void;
  runState: SafetyState['runState'];
  safety: SafetyState;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  runCycleNow: () => void;

  // Configuration
  config: HedgingBotConfig;
  updateConfig: (patch: Partial<HedgingBotConfig>) => void;
  resetConfig: () => void;

  // Market
  symbol: string;
  selectSymbol: (symbol: string) => void;
  symbols: ReturnType<typeof useDerivDigitFeed>['symbols'];
  marketName: string;
  pipSize: number | null;
  precision: number | null;
  quote: number | null;
  tickCount: number;
  feedStatus: string;
  feedFresh: boolean;
  feedError: string;
  precisionError: string;
  contractSupportLoaded: boolean;
  tickContractsSupported: boolean | null;

  // Engine output
  selection: HedgeSelection | null;
  decision: HedgeDecision | null;
  cycleLog: HedgeDecision[];
  cycleRunning: boolean;
  cycleError: string;
  lastCycleAt: number | null;
  risk: HedgeGate | null;
  pricing: PairPricing | null;
  stakePerLeg: number | null;

  // Account, pairs and results
  account: RiseFallAccountState;
  accountType: 'demo' | 'real' | null;
  accountCurrency: string;
  balance: number | null;
  connected: boolean;
  pairs: HedgePair[];
  predictions: HedgePrediction[];
  summary: ReturnType<typeof summarizePairs>;
  predictionSummary: ReturnType<typeof summarizePredictions>;
  pairsCsv: string;
  openPositions: DerivOpenPosition[];
  purchaseInFlight: boolean;
  unreconciledPurchase: boolean;
  sessionMinutesRemaining: number | null;

  // Actions
  closeLeg: (pairId: string, side: HedgeSide) => Promise<void>;
  clearTradeLog: () => void;
};

/** A leg that has not been bought yet, carrying only what the selection decided. */
function pendingLeg(side: HedgeSide, tickPosition: number, rate: number | null, stake: number, status: HedgeLeg['status'] = 'pending'): HedgeLeg {
  return {
    side,
    contractType: HEDGE_CONTRACT_TYPES[side],
    tickPosition,
    contractId: null,
    stake,
    askPrice: null,
    payout: null,
    historicalRate: rate,
    status,
    profit: null,
    exitSpot: null,
    settledAt: null,
    longcode: null,
  };
}

function legPricing(
  side: HedgeSide,
  choice: LegChoice,
  proposal: { ask: number; payout: number | null } | null,
  issues: string[],
): LegPricing {
  return {
    side,
    tickPosition: choice.tickPosition,
    ask: proposal?.ask ?? null,
    payout: proposal?.payout ?? null,
    rate: choice.rate,
    z: choice.z,
    issues,
  };
}

type LegChoice = HedgeSelection['high'];

function legIssues(
  result: PromiseSettledResult<DerivQuote>,
  stake: number,
  now: number,
  maxAgeMs: number,
  offset: number | null,
  side: HedgeSide,
): string[] {
  if (result.status === 'rejected') return [`${HEDGE_SIDE_LABELS[side]}: ${errorText(result.reason)}`];
  return validateLegProposal({ proposal: result.value, stake, now, maxAgeMs, serverClockOffsetMs: offset })
    .issues.map((issue) => `${HEDGE_SIDE_LABELS[side]}: ${issue}`);
}

export function useHedgingBot(): HedgingBotController {
  const feed = useDerivDigitFeed();
  const trading = useDerivTrading();

  const [mode, setModeState] = useState<HedgingBotMode>(readMode);
  const [config, setConfig] = useState<HedgingBotConfig>(() => sanitizeHedgingBotConfig(readJson<Partial<HedgingBotConfig>>(CONFIG_KEY, {})));
  const [safety, setSafety] = useState<SafetyState>(createSafetyState);
  const [account, setAccount] = useState<RiseFallAccountState>(createRiseFallAccountState);
  const [decision, setDecision] = useState<HedgeDecision | null>(null);
  const [cycleLog, setCycleLog] = useState<HedgeDecision[]>([]);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [cycleError, setCycleError] = useState('');
  const [lastCycleAt, setLastCycleAt] = useState<number | null>(null);
  const [risk, setRisk] = useState<HedgeGate | null>(null);
  const [pricing, setPricing] = useState<PairPricing | null>(null);
  const [pairs, setPairs] = useState<HedgePair[]>(() => readJson<HedgePair[]>(PAIRS_KEY, []));
  const [predictions, setPredictions] = useState<HedgePrediction[]>(() => readJson<HedgePrediction[]>(PREDICTIONS_KEY, []));
  const [purchase, setPurchase] = useState<PurchaseLock>({ inFlight: false, unreconciled: null });

  const accountRef = useRef(account);
  const configRef = useRef(config);
  const modeRef = useRef(mode);
  const safetyRef = useRef(safety);
  const pairsRef = useRef(pairs);
  const predictionsRef = useRef(predictions);
  const purchaseRef = useRef(purchase);
  const tradingRef = useRef(trading);
  const feedRef = useRef(feed);
  const busyRef = useRef(false);
  const lastCycleRef = useRef(0);
  const lastPreviewRef = useRef(0);
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const runCycleRef = useRef<() => Promise<void>>(async () => {});

  accountRef.current = account;
  configRef.current = config;
  modeRef.current = mode;
  safetyRef.current = safety;
  pairsRef.current = pairs;
  predictionsRef.current = predictions;
  purchaseRef.current = purchase;
  tradingRef.current = trading;
  feedRef.current = feed;

  useEffect(() => {
    // Set on every mount, not only once: React StrictMode runs this effect twice in development.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    writeJson(CONFIG_KEY, config);
  }, [config]);

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

  const commitPairs = useCallback((next: HedgePair[]) => {
    const trimmed = trimPairs(next, PAIR_LIMIT, REJECTED_LIMIT);
    pairsRef.current = trimmed;
    setPairs(trimmed);
  }, []);

  const commitPurchase = useCallback((next: PurchaseLock) => {
    purchaseRef.current = next;
    setPurchase(next);
  }, []);

  const nextDecisionId = useCallback((now: number, symbol: string) => {
    sequenceRef.current += 1;
    return `hd-${now.toString(36)}-${sequenceRef.current}-${symbol}`;
  }, []);

  /** Sells back legs whose partner never existed. A failed sell is surfaced as a pause, never ignored. */
  const unwindLegs = useCallback((contractIds: number[]) => {
    for (const contractId of contractIds) {
      tradingRef.current.sellContract(contractId).catch(() => {
        setSafety((current) => registerAutoPause(current, ORPHAN_LEG_REASON, modeRef.current));
      });
    }
  }, []);

  // The selection is recomputed whenever a tick arrives or a selection setting changes.
  const selection = useMemo<HedgeSelection | null>(() => {
    if (!feed.ticks.length) return null;
    return selectHedgeTicks(feed.ticks.map((tick) => tick.quote), config);
  }, [feed.ticks, config]);

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
      if (trading.status !== 'connected') next = registerAutoPause(next, 'The authenticated Deriv trading connection is not open.', currentMode);
      else next = clearAutoPause(next, (reason) => reason.startsWith('The authenticated Deriv'), currentMode);
      if (feed.status === 'error' || feed.status === 'reconnecting') next = registerAutoPause(next, 'The public market-data feed is reconnecting; new pairs are paused until ticks resume.', currentMode);
      else next = clearAutoPause(next, (reason) => reason.startsWith('The public market-data feed'), currentMode);
      if (trading.activeAccount === null) next = registerAutoPause(next, 'No Deriv account is authorized for trading.', currentMode);
      else next = clearAutoPause(next, (reason) => reason.startsWith('No Deriv account'), currentMode);
      if (!feed.fresh && feed.status === 'live') next = registerAutoPause(next, 'The live tick stream is stale; new pairs wait until genuine ticks resume.', currentMode);
      else next = clearAutoPause(next, (reason) => reason.startsWith('The live tick stream is stale'), currentMode);
      return next;
    });
  }, [trading.status, trading.activeAccount, feed.status, feed.fresh]);

  /**
   * Applies the account's latest positions to the pairs: settlements, and the
   * advance of an unreconciled purchase. Pure decisions come from the engine
   * modules; this function only writes the results into state.
   */
  const syncWithAccount = useCallback((positions: readonly DerivOpenPosition[], closed: readonly DerivClosedPosition[], now: number) => {
    let rows = pairsRef.current;
    let ledger = accountRef.current;
    let changed = false;

    const settle = (pairId: string, side: HedgeSide, profit: number, exitSpot: number | null, settledAt: number) => {
      const index = rows.findIndex((pair) => pair.id === pairId);
      if (index === -1) return;
      const pair = rows[index];
      const leg = legOf(pair, side);
      if (leg.contractId === null || legIsSettled(leg)) return;
      const outcome: SettlementOutcome = profit > 0 ? 'win' : profit < 0 ? 'loss' : 'push';
      ledger = applySettlement(ledger, { stake: leg.stake, profit, outcome, now: settledAt });
      const updated = settleLeg(pair, side, { profit, exitSpot, settledAt });
      const next = updated.netProfit !== null ? { ...updated, balanceAfter: ledger.balance } : updated;
      rows = rows.map((row, at) => (at === index ? next : row));
      changed = true;
    };

    for (const pair of rows) {
      if (pair.status === 'rejected') continue;
      for (const side of ['HIGH', 'LOW'] as const) {
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

    const purchaseNow = purchaseRef.current.unreconciled;
    if (purchaseNow) {
      const result = reconcilePurchase({ pairs: rows, purchase: purchaseNow, positions, now });
      rows = [...result.pairs];
      changed = true;
      if (result.resolved) {
        commitPurchase({ inFlight: false, unreconciled: null });
        setSafety((current) => clearAutoPause(current, (reason) => reason.startsWith('A purchase request may have reached Deriv'), modeRef.current));
        unwindLegs(result.unwind);
      } else {
        commitPurchase({ inFlight: purchaseRef.current.inFlight, unreconciled: { ...purchaseNow, missing: result.missing } });
      }
    }

    // The orphan pause lifts once no partial pair still holds an unsettled leg.
    const orphanOpen = rows.some((pair) => pair.status === 'partial' && boughtLegs(pair).some((leg) => !legIsSettled(leg)));
    if (!orphanOpen) {
      setSafety((current) => (current.autoPauseReasons.includes(ORPHAN_LEG_REASON)
        ? clearAutoPause(current, (reason) => reason === ORPHAN_LEG_REASON, modeRef.current)
        : current));
    }

    if (!changed) return;
    const exposure = rows
      .flatMap((pair) => boughtLegs(pair))
      .filter((leg) => !legIsSettled(leg))
      .reduce((total, leg) => total + leg.stake, 0);
    commitPairs(rows);
    commitAccount(setOpenExposure(ledger, exposure));
  }, [commitAccount, commitPairs, commitPurchase, unwindLegs]);

  // ---- live positions, settlements and reconciliation ------------------------
  useEffect(() => {
    if (!trading.openPositions.length && !trading.closedPositions.length && !purchaseRef.current.unreconciled) return;
    syncWithAccount(trading.openPositions, trading.closedPositions, Date.now());
  }, [trading.openPositions, trading.closedPositions, syncWithAccount]);

  // A purchase whose reply never came back is re-checked on a timer, so it resolves
  // even when Deriv sends no new portfolio data.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!purchaseRef.current.unreconciled) return;
      syncWithAccount(tradingRef.current.openPositions, tradingRef.current.closedPositions, Date.now());
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [syncWithAccount]);

  // ---- score the analysis predictions ---------------------------------------
  useEffect(() => {
    if (!feed.ticks.length || !predictionsRef.current.some((row) => !row.resolved && !row.expired)) return;
    const observations: TickQuote[] = feed.ticks.map((tick) => ({ epoch: tick.epoch, quote: tick.quote }));
    const { rows, changed } = resolveHedgePredictions(predictionsRef.current, observations, Date.now(), PREDICTION_MAX_PENDING_MS);
    if (!changed) return;
    predictionsRef.current = rows;
    setPredictions(rows);
  }, [feed.ticks]);

  // ---- proposals --------------------------------------------------------------
  /** Requests one proposal per leg at the same time. Quotes only: nothing is bought. */
  const requestPair = useCallback(async (symbol: string, currency: string, stake: number, highTick: number, lowTick: number) => {
    const highRequest: DerivTradeRequest = {
      contractType: HEDGE_CONTRACT_TYPES.HIGH,
      symbol,
      currency,
      stake,
      duration: HEDGE_WINDOW_TICKS,
      durationUnit: 't',
      barrier: null,
      selectedTick: highTick,
    };
    const lowRequest: DerivTradeRequest = { ...highRequest, contractType: HEDGE_CONTRACT_TYPES.LOW, selectedTick: lowTick };
    const [high, low] = await Promise.allSettled([trading.requestQuote(highRequest), trading.requestQuote(lowRequest)]);
    return { highRequest, lowRequest, high, low };
  }, [trading]);

  /** Analysis-mode preview: shows live payouts and expected value without buying. */
  const previewPair = useCallback(async (symbol: string, currency: string, stake: number, current: HedgeSelection, cfg: HedgingBotConfig, now: number) => {
    if (current.high.tickPosition === null || current.low.tickPosition === null) return;
    const { high, low } = await requestPair(symbol, currency, stake, current.high.tickPosition, current.low.tickPosition);
    if (!mountedRef.current) return;
    const offset = feedRef.current.serverClockOffsetMs;
    const highOk = high.status === 'fulfilled' ? high.value : null;
    const lowOk = low.status === 'fulfilled' ? low.value : null;
    const economics = highOk && lowOk
      ? evaluatePairEconomics({
        high: { askPrice: highOk.askPrice, payout: highOk.payout, winRate: current.high.rate },
        low: { askPrice: lowOk.askPrice, payout: lowOk.payout, winRate: current.low.rate },
        joint: current.joint,
      })
      : null;
    lastPreviewRef.current = now;
    setPricing({
      at: now,
      symbol,
      stake,
      source: 'preview',
      high: legPricing('HIGH', current.high, highOk ? { ask: highOk.askPrice, payout: highOk.payout } : null, legIssues(high, stake, now, cfg.maxTickAgeMs, offset, 'HIGH')),
      low: legPricing('LOW', current.low, lowOk ? { ask: lowOk.askPrice, payout: lowOk.payout } : null, legIssues(low, stake, now, cfg.maxTickAgeMs, offset, 'LOW')),
      economics,
      notes: economics ? [economics.note] : ['Analysis preview: a payout is shown once both proposals arrive.'],
    });
  }, [requestPair]);

  /** Buys both legs at the same moment, or records why the pair was not opened. */
  const executePair = useCallback(async (options: {
    decisionId: string;
    symbol: string;
    currency: string;
    stake: number;
    current: HedgeSelection;
    cfg: HedgingBotConfig;
  }): Promise<EntryResult> => {
    const { decisionId, symbol, currency, stake, current, cfg } = options;
    const highTick = current.high.tickPosition ?? 0;
    const lowTick = current.low.tickPosition ?? 0;
    const notes: string[] = [];

    const refuse = (message: string, record?: HedgePair): EntryResult => {
      if (record) commitPairs([...pairsRef.current, record]);
      return { executed: false, pairId: record?.id ?? null, message };
    };

    if (purchaseRef.current.inFlight) return refuse('A pair purchase is already in progress on this account.');
    if (purchaseRef.current.unreconciled) return refuse('A previous purchase has not been reconciled with Deriv yet.');
    if (!currency) return refuse('Deriv has not reported the account currency, so the pair cannot be priced.');
    if (!Number.isFinite(stake) || stake <= 0) return refuse('The risk manager did not produce a usable stake.');

    commitPurchase({ inFlight: true, unreconciled: null });
    const release = () => commitPurchase({ inFlight: false, unreconciled: purchaseRef.current.unreconciled });
    const refusedRecord = (note: string, status: HedgePair['status'] = 'rejected'): HedgePair => ({
      id: decisionId,
      at: Date.now(),
      symbol,
      mode: 'live',
      status,
      high: pendingLeg('HIGH', highTick, current.high.rate, stake, 'rejected'),
      low: pendingLeg('LOW', lowTick, current.low.rate, stake, 'rejected'),
      entrySpot: null,
      expectedValue: null,
      netProfit: null,
      balanceAfter: null,
      settledAt: null,
      note,
    });

    const { highRequest, lowRequest, high, low } = await requestPair(symbol, currency, stake, highTick, lowTick);
    if (!mountedRef.current) {
      release();
      return refuse('The bot stopped while Deriv was quoting.');
    }

    const now = Date.now();
    const offset = feedRef.current.serverClockOffsetMs;
    const highQuote = high.status === 'fulfilled' ? high.value : null;
    const lowQuote = low.status === 'fulfilled' ? low.value : null;
    const issues = [
      ...legIssues(high, stake, now, cfg.maxTickAgeMs, offset, 'HIGH'),
      ...legIssues(low, stake, now, cfg.maxTickAgeMs, offset, 'LOW'),
    ];
    const pricingNow = (source: PairPricing['source'], economics: PairEconomics | null): PairPricing => ({
      at: now,
      symbol,
      stake,
      source,
      high: legPricing('HIGH', current.high, highQuote ? { ask: highQuote.askPrice, payout: highQuote.payout } : null, legIssues(high, stake, now, cfg.maxTickAgeMs, offset, 'HIGH')),
      low: legPricing('LOW', current.low, lowQuote ? { ask: lowQuote.askPrice, payout: lowQuote.payout } : null, legIssues(low, stake, now, cfg.maxTickAgeMs, offset, 'LOW')),
      economics,
      notes,
    });

    if (issues.length || !highQuote || !lowQuote) {
      release();
      const message = issues.join(' ') || 'Deriv did not return both proposals.';
      setPricing(pricingNow('refused', null));
      return refuse(message, refusedRecord(`Refused before purchase: ${message}`));
    }

    const economics = evaluatePairEconomics({
      high: { askPrice: highQuote.askPrice, payout: highQuote.payout, winRate: current.high.rate },
      low: { askPrice: lowQuote.askPrice, payout: lowQuote.payout, winRate: current.low.rate },
      joint: current.joint,
    });
    notes.push(economics.note);

    if (cfg.requirePositiveExpectedValue) {
      let refusal: string | null = null;
      if (economics.returnOnStake === null || economics.expectedValue === null) {
        refusal = 'The pair could not be priced (missing payout or historical rate), so the expected-value gate refuses it.';
      } else if (!current.high.sufficient || !current.low.sufficient) {
        refusal = 'The tick statistics are too thin for the expected-value gate, so the pair was refused.';
      } else if (economics.returnOnStake < cfg.minExpectedValue) {
        refusal = `Pair expected value ${economics.returnOnStake.toFixed(4)} per unit staked is below the required ${cfg.minExpectedValue.toFixed(4)}; nothing was bought.`;
      }
      if (refusal) {
        release();
        setPricing(pricingNow('refused', economics));
        return refuse(refusal, { ...refusedRecord(refusal), expectedValue: economics.expectedValue });
      }
    } else {
      notes.push('Expected-value gate is off: the pair is bought without a positive-EV requirement.');
    }

    // Both purchases leave in the same tick. Each reply is matched to its request by req_id.
    const [highBuy, lowBuy] = await Promise.allSettled([
      tradingRef.current.confirmBuy(highQuote, highRequest),
      tradingRef.current.confirmBuy(lowQuote, lowRequest),
    ]);
    const bookedAt = Date.now();
    const highReceipt = highBuy.status === 'fulfilled' ? highBuy.value : null;
    const lowReceipt = lowBuy.status === 'fulfilled' ? lowBuy.value : null;
    const highError = highBuy.status === 'rejected' ? errorText(highBuy.reason) : null;
    const lowError = lowBuy.status === 'rejected' ? errorText(lowBuy.reason) : null;
    const highUnknown = highError !== null && UNCERTAIN_PURCHASE.test(highError);
    const lowUnknown = lowError !== null && UNCERTAIN_PURCHASE.test(lowError);

    const bookLeg = (side: HedgeSide, quote: DerivQuote, receipt: DerivBuyReceipt | null, unknown: boolean, tick: number, rate: number | null): HedgeLeg => {
      if (!receipt) return pendingLeg(side, tick, rate, stake, unknown ? 'pending' : 'rejected');
      return {
        side,
        contractType: HEDGE_CONTRACT_TYPES[side],
        tickPosition: tick,
        contractId: receipt.contractId,
        stake: receipt.buyPrice,
        askPrice: quote.askPrice,
        payout: receipt.payout ?? quote.payout,
        historicalRate: rate,
        status: 'open',
        profit: null,
        exitSpot: null,
        settledAt: null,
        longcode: receipt.longcode,
      };
    };
    const highLeg = bookLeg('HIGH', highQuote, highReceipt, highUnknown, highTick, current.high.rate);
    const lowLeg = bookLeg('LOW', lowQuote, lowReceipt, lowUnknown, lowTick, current.low.rate);

    // Record the purchases the account confirmed against the ledger.
    if (highReceipt) commitAccount(applyPurchase(accountRef.current, { stake: highReceipt.buyPrice, now: bookedAt }));
    if (lowReceipt) commitAccount(applyPurchase(accountRef.current, { stake: lowReceipt.buyPrice, now: bookedAt }));

    const base: HedgePair = {
      id: decisionId,
      at: bookedAt,
      symbol,
      mode: 'live',
      status: 'open',
      high: highLeg,
      low: lowLeg,
      entrySpot: highQuote.spot,
      expectedValue: economics.expectedValue,
      netProfit: null,
      balanceAfter: (highReceipt ?? lowReceipt)?.balanceAfter ?? null,
      settledAt: null,
      note: notes.join(' '),
    };

    // Some purchase replies never arrived: the pair waits for the account to say what happened.
    if (highUnknown || lowUnknown) {
      const missing: HedgeSide[] = [];
      if (highUnknown && !highReceipt) missing.push('HIGH');
      if (lowUnknown && !lowReceipt) missing.push('LOW');
      commitPairs([...pairsRef.current, { ...base, status: 'unreconciled', note: `${base.note} Purchase reply not received for ${missing.map((side) => HEDGE_SIDE_LABELS[side]).join(' and ')}; reconciling with the account before any new pair.`.trim() }]);
      commitPurchase({ inFlight: false, unreconciled: { pairId: decisionId, at: bookedAt, symbol, missing } });
      setSafety((current) => registerAutoPause(current, 'A purchase request may have reached Deriv without a receipt; it must be reconciled before any new pair.', modeRef.current));
      setPricing(pricingNow('purchase', economics));
      return refuse(`Purchase reply not received: ${[highError, lowError].filter(Boolean).join(' ')}`);
    }

    if (highReceipt && lowReceipt) {
      commitPairs([...pairsRef.current, base]);
      release();
      setPricing(pricingNow('purchase', economics));
      notes.push(`Deriv confirmed contracts ${highReceipt.contractId} (High Tick) and ${lowReceipt.contractId} (Low Tick).`);
      return { executed: true, pairId: decisionId, message: '' };
    }

    // One leg was refused. A pair with one leg is not a hedge, so the bought leg is sold back.
    const concluded = concludeReconciliation({ ...base, note: `${base.note} ${[highError, lowError].filter(Boolean).join(' ')}`.trim() }, bookedAt);
    commitPairs([...pairsRef.current, concluded.pair]);
    release();
    unwindLegs(concluded.unwind);
    setPricing(pricingNow('purchase', economics));
    const reason = [highError, lowError].filter(Boolean).join(' ') || 'Deriv refused both purchases.';
    return refuse(reason);
  }, [commitAccount, commitPairs, commitPurchase, requestPair, unwindLegs]);

  // ---- the decision cycle ----------------------------------------------------
  const runCycle = useCallback(async () => {
    if (busyRef.current) return;
    const safetyState = safetyRef.current;
    if (safetyState.runState !== 'running') return;
    const cfg = configRef.current;
    const currentMode = modeRef.current;
    const startedAt = Date.now();
    if (startedAt - lastCycleRef.current < cfg.decisionIntervalMs * 0.8) return;
    const symbol = feed.selectedSymbol;
    const observations = feed.ticks;
    if (!symbol || !observations.length) return;

    busyRef.current = true;
    lastCycleRef.current = startedAt;
    setCycleRunning(true);
    const decisionId = nextDecisionId(startedAt, symbol);

    try {
      const current = selectHedgeTicks(observations.map((tick) => tick.quote), cfg);
      const accountSnapshot = accountRef.current;
      const reasons: string[] = [current.high.note, current.low.note];
      const sizing = sizeLegStake(cfg, accountSnapshot.balance);
      if (sizing.note) reasons.push(sizing.note);
      const openPairs = pairsRef.current.filter(isPairOpen).length;
      const tickContractsSupported = feed.contractsLoaded
        ? feed.contracts.some((contract) => contract.contractType === HEDGE_CONTRACT_TYPES.HIGH)
          && feed.contracts.some((contract) => contract.contractType === HEDGE_CONTRACT_TYPES.LOW)
        : null;
      const gate = evaluateHedgeGate({
        config: cfg,
        account: accountSnapshot,
        pairs: pairsRef.current,
        mode: currentMode,
        runState: safetyState.runState,
        manualPause: safetyState.manualPause,
        autoPauseReasons: safetyState.autoPauseReasons,
        accountAuthorized: trading.activeAccount !== null,
        connectionHealthy: trading.status === 'connected',
        feedFresh: feed.fresh,
        feedStatus: feed.status,
        tickContractsSupported,
        tickCount: observations.length,
        openPairs,
        unreconciled: purchaseRef.current.unreconciled !== null,
        purchaseInFlight: purchaseRef.current.inFlight,
        stake: sizing.stake,
        now: startedAt,
      });
      reasons.push(...gate.notes);

      // Every entry is recorded once, in both modes, so the hit rates describe the
      // rule rather than only the pairs the gate happened to allow.
      const latest = observations[observations.length - 1];
      const pairReady = current.high.tickPosition !== null && current.low.tickPosition !== null;
      if (pairReady) {
        const alreadyRecorded = predictionsRef.current.some((row) => row.entryEpoch === latest.epoch && row.entryQuote === latest.quote && row.symbol === symbol);
        if (!alreadyRecorded) {
          const prediction: HedgePrediction = {
            id: decisionId,
            at: startedAt,
            symbol,
            entryEpoch: latest.epoch,
            entryQuote: latest.quote,
            highTick: current.high.tickPosition as number,
            lowTick: current.low.tickPosition as number,
            highRate: current.high.rate,
            lowRate: current.low.rate,
            resolved: false,
            expired: false,
            highWon: null,
            lowWon: null,
            resolvedAt: null,
          };
          predictionsRef.current = [...predictionsRef.current, prediction].slice(-PREDICTION_LIMIT);
          setPredictions(predictionsRef.current);
        }
      }

      const pairLabel = `High Tick ${current.high.tickPosition ?? '—'} / Low Tick ${current.low.tickPosition ?? '—'}`;
      let action: HedgeDecision['action'] = 'WAIT';
      let actionLabel = 'Waiting for tick statistics';
      const codes: string[] = [...gate.codes];
      if (pairReady) actionLabel = `Pair ready · ${pairLabel}`;

      if (!pairReady) {
        action = 'WAIT';
      } else if (currentMode !== 'live') {
        action = 'WAIT';
        actionLabel = `Pair ${pairLabel} · analysis mode`;
        reasons.push('Analysis-only mode records the pair and scores it later; no order is sent.');
        codes.push('ANALYSIS_MODE');
        // Showing live payouts requests two quotes and never sends a buy.
        const currency = trading.currency || accountSnapshot.currency;
        const previewReady = trading.activeAccount !== null && trading.status === 'connected' && currency !== '';
        if (previewReady && sizing.stake !== null && startedAt - lastPreviewRef.current >= PREVIEW_INTERVAL_MS) {
          try {
            await previewPair(symbol, currency, sizing.stake, current, cfg, startedAt);
          } catch (failure) {
            reasons.push(`Proposal preview failed: ${errorText(failure)}`);
          }
        }
      } else if (!gate.allowed) {
        action = 'BLOCKED';
        actionLabel = 'Blocked · pair not opened';
        reasons.push(...gate.violations);
      } else {
        action = 'TRADE';
        actionLabel = `Buy pair · ${pairLabel}`;
      }

      let executed = false;
      let pairId: string | null = null;
      let error: string | null = null;
      if (action === 'TRADE' && sizing.stake !== null) {
        const result = await executePair({
          decisionId,
          symbol,
          currency: accountSnapshot.currency || trading.currency,
          stake: sizing.stake,
          current,
          cfg,
        });
        executed = result.executed;
        pairId = result.pairId;
        if (executed) {
          actionLabel = `Bought pair · ${pairLabel}`;
          codes.push('ORDER_SENT');
        } else {
          action = 'BLOCKED';
          actionLabel = 'Blocked at purchase · pair not opened';
          error = result.message || 'The pair was not sent.';
          reasons.push(error);
          codes.push('PURCHASE_REFUSED');
        }
      }
      if (!mountedRef.current) return;

      const cycleDecision: HedgeDecision = {
        id: decisionId,
        at: startedAt,
        symbol,
        mode: currentMode,
        action,
        actionLabel,
        reasons: [...new Set(reasons)],
        reasonCodes: [...new Set(codes)],
        highTick: current.high.tickPosition,
        lowTick: current.low.tickPosition,
        stake: sizing.stake,
        executed,
        pairId,
        error,
      };
      setRisk(gate);
      setDecision(cycleDecision);
      setCycleLog((items) => [cycleDecision, ...items].slice(0, LOG_LIMIT));
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
        highTick: null,
        lowTick: null,
        stake: null,
        executed: false,
        pairId: null,
        error: message,
      }, ...items].slice(0, LOG_LIMIT));
      if (purchaseRef.current.inFlight) commitPurchase({ inFlight: false, unreconciled: purchaseRef.current.unreconciled });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCycleRunning(false);
    }
  }, [commitPurchase, executePair, feed.contracts, feed.contractsLoaded, feed.fresh, feed.selectedSymbol, feed.status, feed.ticks, nextDecisionId, previewPair, trading]);

  runCycleRef.current = runCycle;

  useEffect(() => {
    if (safety.runState !== 'running') return undefined;
    const interval = window.setInterval(() => {
      void runCycleRef.current();
    }, config.decisionIntervalMs);
    void runCycleRef.current();
    return () => window.clearInterval(interval);
  }, [safety.runState, config.decisionIntervalMs]);

  // ---- operator controls -----------------------------------------------------
  const start = useCallback(() => {
    const now = Date.now();
    commitAccount(beginSession(rollTradingDay(accountRef.current, now), now));
    setSafety((current) => startBot(current, modeRef.current));
    lastCycleRef.current = 0;
    void runCycleRef.current();
  }, [commitAccount]);

  const pause = useCallback(() => setSafety((current) => pauseBot(current, modeRef.current)), []);
  const resume = useCallback(() => setSafety((current) => resumeBot(current, modeRef.current)), []);
  const stop = useCallback(() => {
    // Stopping blocks new pairs only. Legs Deriv already accepted keep being monitored.
    setSafety((current) => stopBot(current, modeRef.current, { now: Date.now(), by: 'user' }));
  }, []);

  const runCycleNow = useCallback(() => {
    lastCycleRef.current = 0;
    void runCycleRef.current();
  }, []);

  const setMode = useCallback((next: HedgingBotMode) => {
    setModeState(next);
    setSafety((current) => stopBot(current, next, { now: Date.now(), by: 'user' }));
  }, []);

  const updateConfig = useCallback((patch: Partial<HedgingBotConfig>) => {
    setConfig((current) => sanitizeHedgingBotConfig({ ...current, ...patch }));
  }, []);

  const resetConfig = useCallback(() => setConfig(sanitizeHedgingBotConfig(defaultHedgingBotConfig())), []);

  const closeLeg = useCallback(async (pairId: string, side: HedgeSide) => {
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

  const summary = useMemo(() => summarizePairs(pairs), [pairs]);
  const predictionSummary = useMemo(() => summarizePredictions(predictions), [predictions]);
  const pairsCsv = useMemo(() => pairsToCsv(pairs), [pairs]);
  const latestTick = feed.ticks.at(-1) ?? null;
  const stakePerLeg = useMemo(() => sizeLegStake(config, account.balance).stake, [config, account.balance]);

  return useMemo<HedgingBotController>(() => ({
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
    symbols: feed.symbols,
    marketName: feed.selectedMarket?.name ?? '',
    pipSize: feed.selectedMarket?.pipSize ?? null,
    precision: feed.selectedMarket?.precision ?? null,
    quote: latestTick?.quote ?? null,
    tickCount: feed.ticks.length,
    feedStatus: feed.status,
    feedFresh: feed.fresh,
    feedError: feed.feedError || feed.contractError,
    precisionError: feed.precisionError,
    contractSupportLoaded: feed.contractsLoaded,
    tickContractsSupported: feed.contractsLoaded
      ? feed.contracts.some((contract) => contract.contractType === HEDGE_CONTRACT_TYPES.HIGH)
        && feed.contracts.some((contract) => contract.contractType === HEDGE_CONTRACT_TYPES.LOW)
      : null,

    selection,
    decision,
    cycleLog,
    cycleRunning,
    cycleError,
    lastCycleAt,
    risk,
    pricing,
    stakePerLeg,

    account,
    accountType: trading.activeAccount?.accountType ?? null,
    accountCurrency: trading.currency || trading.activeAccount?.currency || '',
    balance: trading.balance,
    connected: trading.status === 'connected',
    pairs,
    predictions,
    summary,
    predictionSummary,
    pairsCsv,
    openPositions: trading.openPositions,
    purchaseInFlight: purchase.inFlight,
    unreconciledPurchase: purchase.unreconciled !== null,
    sessionMinutesRemaining: hedgeSessionMinutesRemaining(config, account, Date.now()),

    closeLeg,
    clearTradeLog,
  }), [
    account, closeLeg, clearTradeLog, config, cycleError, cycleLog, cycleRunning, decision, feed.contractError,
    feed.contracts, feed.contractsLoaded, feed.feedError, feed.fresh, feed.precisionError, feed.selectedMarket?.name,
    feed.selectedMarket?.pipSize, feed.selectedMarket?.precision, feed.selectedSymbol, feed.setSelectedSymbol,
    feed.status, feed.symbols, feed.ticks.length, latestTick?.quote, lastCycleAt, mode, pairs, pairsCsv, pause,
    predictionSummary, predictions, pricing, purchase, resetConfig, resume, risk, runCycleNow, safety, selection,
    setMode, start, stop, stakePerLeg, summary, trading.activeAccount?.accountType, trading.activeAccount?.currency,
    trading.balance, trading.currency, trading.openPositions, trading.status, updateConfig,
  ]);
}
