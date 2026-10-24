// Rise/Fall bot controller: connects the engine layer in `lib/rise-fall-bot`
// to the application's two existing Deriv connections.
//
//   * the public market-data feed (`useDerivDigitFeed`) supplies the verified
//     ticks, symbol metadata and Deriv-reported contract durations;
//   * the authenticated trading session (`useDerivTrading`) supplies proposals,
//     purchases, balances, open positions and settlements.
//
// Neither connection is replaced or reconfigured: the bot sends `proposal` →
// `buy` for CALL/PUT exactly like the trade dock does, and it reads positions
// back from the same portfolio and contract streams. Every rule lives in the
// pure engine modules; this hook only moves data, drives the decision cycle,
// keeps the single-flight purchase lock and persists non-secret operator
// settings in the browser. No token, account id or socket URL is stored here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDerivDigitFeed } from '@/hooks/use-deriv-digit-feed';
import { BOT_CYCLE_MIN_SPACING_MS, shouldStartBotCycle, useBotCycleTrigger } from '@/hooks/use-bot-cycle-trigger';
import { configNeedsReset, markConfigVersion } from '@/lib/bot-config-version';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import type { DerivOpenPosition, DerivQuote, DerivTradeRequest } from '@/lib/deriv-trading';
import { draftDurationIssue, supportedTradeTicks } from '@/lib/trade-duration';
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
import { decideDirection } from '@/lib/rise-fall-bot/decision';
import { evaluateProposalEconomics, evaluateSignalEvidence, validateRiseFallQuote } from '@/lib/rise-fall-bot/evidence';
import { extractFeatures } from '@/lib/rise-fall-bot/features';
import {
  resolvePredictions,
  summarizePredictions,
  summarizeTrades,
  tradesToCsv,
  type TickPoint,
} from '@/lib/rise-fall-bot/performance';
import {
  applyPurchase,
  applySettlement,
  beginSession,
  computeStakePlan,
  evaluateRiskGate,
  reconcileBalance,
  rollTradingDay,
  sessionMinutesRemaining,
  setOpenExposure,
  tradesRemaining,
  type SettlementOutcome,
} from '@/lib/rise-fall-bot/risk';
import {
  createRiseFallAccountState,
  defaultRiseFallConfig,
  RISE_FALL_LABELS,
  sanitizeRiseFallConfig,
  type MonitoredRiseFallContract,
  type ProposalEconomics,
  type RiseFallAccountState,
  type RiseFallBotMode,
  type RiseFallConfig,
  type RiseFallDecision,
  type RiseFallDirection,
  type RiseFallFeatures,
  type RiseFallPrediction,
  type RiseFallRule,
  type RiseFallTradeRecord,
  type RiskGate,
  type SignalEvidence,
} from '@/lib/rise-fall-bot/types';

const MODE_KEY = 'signal-lab-rise-fall-bot-mode';
const CONFIG_KEY = 'signal-lab-rise-fall-bot-config';
const TRADES_KEY = 'signal-lab-rise-fall-bot-trades';
const PREDICTIONS_KEY = 'signal-lab-rise-fall-bot-predictions';

/** How long an unconfirmed purchase is matched against the account's portfolio. */
const UNRECONCILED_TIMEOUT_MS = 20_000;

const LOG_LIMIT = 60;
const RECORD_LIMIT = 300;
const PREDICTION_LIMIT = 300;
const CONTRACT_LIMIT = 40;

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

function readMode(): RiseFallBotMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'analysis';
  } catch {
    return 'analysis';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Deriv rejected the request.';
}

/** The single-flight purchase lock, including the unreconciled-order state. */
type PurchaseLock = {
  inFlight: boolean;
  unreconciled: { decisionId: string; at: number; symbol: string; direction: RiseFallDirection; stake: number } | null;
};

type EntryResult = {
  executed: boolean;
  contractId: number | null;
  message: string;
  notes: string[];
  economics: ProposalEconomics | null;
};

export type RiseFallBotController = {
  // Controls
  mode: RiseFallBotMode;
  setMode: (mode: RiseFallBotMode) => void;
  runState: SafetyState['runState'];
  safety: SafetyState;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** Forces one decision cycle immediately, ignoring the cadence guard. */
  runCycleNow: () => void;

  // Configuration
  config: RiseFallConfig;
  updateConfig: (patch: Partial<RiseFallConfig>) => void;
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
  supportedTickExpiries: number[];
  contractSupportLoaded: boolean;

  // Engine output
  features: RiseFallFeatures | null;
  decision: RiseFallDecision | null;
  cycleLog: RiseFallDecision[];
  cycleRunning: boolean;
  cycleError: string;
  lastCycleAt: number | null;
  risk: RiskGate | null;
  nextStake: number | null;
  martingaleStep: number;

  // Account, positions and results
  account: RiseFallAccountState;
  accountType: 'demo' | 'real' | null;
  accountCurrency: string;
  balance: number | null;
  connected: boolean;
  contracts: MonitoredRiseFallContract[];
  accountOpenPositions: DerivOpenPosition[];
  records: RiseFallTradeRecord[];
  predictions: RiseFallPrediction[];
  tradeSummary: ReturnType<typeof summarizeTrades>;
  predictionSummary: ReturnType<typeof summarizePredictions>;
  tradeLogCsv: string;
  purchaseInFlight: boolean;
  unreconciledPurchase: boolean;
  sessionMinutesRemaining: number | null;
  tradesRemaining: number | null;

  // Actions
  closeContract: (contractId: number) => Promise<void>;
  clearTradeLog: () => void;
};

export function useRiseFallBot(): RiseFallBotController {
  const feed = useDerivDigitFeed();
  const trading = useDerivTrading();

  const [mode, setModeState] = useState<RiseFallBotMode>(readMode);
  const [config, setConfig] = useState<RiseFallConfig>(() => sanitizeRiseFallConfig(
    configNeedsReset(CONFIG_KEY) ? {} : readJson<Partial<RiseFallConfig>>(CONFIG_KEY, {}),
  ));
  const [safety, setSafety] = useState<SafetyState>(createSafetyState);
  const [account, setAccount] = useState<RiseFallAccountState>(createRiseFallAccountState);
  const [features, setFeatures] = useState<RiseFallFeatures | null>(null);
  const [decision, setDecision] = useState<RiseFallDecision | null>(null);
  const [cycleLog, setCycleLog] = useState<RiseFallDecision[]>([]);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [cycleError, setCycleError] = useState('');
  const [lastCycleAt, setLastCycleAt] = useState<number | null>(null);
  const [risk, setRisk] = useState<RiskGate | null>(null);
  const [contracts, setContracts] = useState<MonitoredRiseFallContract[]>([]);
  const [records, setRecords] = useState<RiseFallTradeRecord[]>(() => readJson<RiseFallTradeRecord[]>(TRADES_KEY, []));
  const [predictions, setPredictions] = useState<RiseFallPrediction[]>(() => readJson<RiseFallPrediction[]>(PREDICTIONS_KEY, []));
  const [purchase, setPurchase] = useState<PurchaseLock>({ inFlight: false, unreconciled: null });

  const accountRef = useRef(account);
  const configRef = useRef(config);
  const modeRef = useRef(mode);
  const safetyRef = useRef(safety);
  const contractsRef = useRef<MonitoredRiseFallContract[]>([]);
  const recordsRef = useRef(records);
  const predictionsRef = useRef(predictions);
  const purchaseRef = useRef(purchase);
  const busyRef = useRef(false);
  /** A tick arrived while a cycle was pricing; re-run once it finishes. */
  const pendingCycleRef = useRef(false);
  const lastCycleRef = useRef(0);
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const runCycleRef = useRef<(options?: { force?: boolean }) => Promise<void>>(async () => {});

  accountRef.current = account;
  configRef.current = config;
  modeRef.current = mode;
  safetyRef.current = safety;
  recordsRef.current = records;
  predictionsRef.current = predictions;
  purchaseRef.current = purchase;

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    writeJson(CONFIG_KEY, config);
  }, [config]);

  // One-time migration marker: the defaults just applied are the shape future
  // edits start from.
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
    writeJson(TRADES_KEY, records.slice(-RECORD_LIMIT));
  }, [records]);

  useEffect(() => {
    writeJson(PREDICTIONS_KEY, predictions.slice(-PREDICTION_LIMIT));
  }, [predictions]);

  const commitAccount = useCallback((next: RiseFallAccountState) => {
    accountRef.current = next;
    setAccount(next);
  }, []);

  const commitContracts = useCallback((next: MonitoredRiseFallContract[]) => {
    const trimmed = next.slice(0, CONTRACT_LIMIT);
    contractsRef.current = trimmed;
    setContracts(trimmed);
  }, []);

  const commitRecords = useCallback((next: RiseFallTradeRecord[]) => {
    const trimmed = next.slice(-RECORD_LIMIT);
    recordsRef.current = trimmed;
    setRecords(trimmed);
  }, []);

  const commitPurchase = useCallback((next: PurchaseLock) => {
    purchaseRef.current = next;
    setPurchase(next);
  }, []);

  const nextDecisionId = useCallback((now: number, symbol: string) => {
    sequenceRef.current += 1;
    return `rf-${now.toString(36)}-${sequenceRef.current}-${symbol}`;
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
      if (trading.status !== 'connected') next = registerAutoPause(next, 'The authenticated Deriv trading connection is not open.', currentMode);
      else next = clearAutoPause(next, (reason) => reason.startsWith('The authenticated Deriv'), currentMode);
      if (feed.status === 'error' || feed.status === 'reconnecting') next = registerAutoPause(next, 'The public market-data feed is reconnecting; new trades are paused until ticks resume.', currentMode);
      else next = clearAutoPause(next, (reason) => reason.startsWith('The public market-data feed'), currentMode);
      if (trading.activeAccount === null) next = registerAutoPause(next, 'No Deriv account is authorized for trading.', currentMode);
      else next = clearAutoPause(next, (reason) => reason.startsWith('No Deriv account'), currentMode);
      if (!feed.fresh && feed.status === 'live') next = registerAutoPause(next, 'The live tick stream is stale; new purchases wait until genuine ticks resume.', currentMode);
      else next = clearAutoPause(next, (reason) => reason.startsWith('The live tick stream is stale'), currentMode);
      return next;
    });
  }, [trading.status, trading.activeAccount, feed.status, feed.fresh]);

  // ---- live positions, settlements and reconciliation ------------------------
  useEffect(() => {
    const positions = trading.openPositions;
    const closed = trading.closedPositions;
    if (!positions.length && !closed.length) return;
    const now = Date.now();
    let contracts = contractsRef.current;
    let account = accountRef.current;
    let records = recordsRef.current;
    let changed = false;

    const settle = (contractId: number, profit: number, exitSpot: number | null, settledAt: number) => {
      const index = contracts.findIndex((contract) => contract.contractId === contractId);
      if (index === -1) return;
      const contract = contracts[index];
      if (contract.settledProfit !== null) return;
      const outcome: SettlementOutcome = profit > 0 ? 'win' : profit < 0 ? 'loss' : 'push';
      const settledContract: MonitoredRiseFallContract = {
        ...contract,
        isSold: true,
        status: 'sold',
        profit,
        settledProfit: profit,
        settledAt,
        exitSpot: exitSpot ?? contract.exitSpot,
        lastUpdateAt: now,
      };
      contracts = contracts.map((row, at) => (at === index ? settledContract : row));
      account = applySettlement(account, { stake: contract.stake, profit, outcome, now: settledAt });
      records = records.map((record) => (record.contractId === contractId && record.status === 'open'
        ? {
          ...record,
          status: outcome === 'win' ? 'won' as const : outcome === 'loss' ? 'lost' as const : 'push' as const,
          profit,
          settledAt,
          exitSpot: settledContract.exitSpot,
          balanceAfter: account.balance,
          sessionPnl: account.sessionPnl,
          dailyPnl: account.dailyPnl,
          note: record.note || (outcome === 'push' ? 'Exit level equalled the entry level; Deriv returned the stake.' : ''),
        }
        : record));
      changed = true;
    };

    for (const position of positions) {
      const index = contracts.findIndex((contract) => contract.contractId === position.contractId);
      if (index === -1) continue;
      if (position.isSold && position.profit !== null) {
        settle(position.contractId, position.profit, position.exitSpot, now);
        continue;
      }
      const previous = contracts[index];
      const updated: MonitoredRiseFallContract = {
        ...previous,
        payout: position.payout ?? previous.payout,
        entrySpot: position.entrySpot ?? previous.entrySpot,
        currentSpot: position.currentSpot ?? previous.currentSpot,
        profit: position.profit ?? previous.profit,
        tickCount: position.tickCount ?? previous.tickCount,
        tickPassed: position.tickPassed ?? previous.tickPassed,
        expiryTime: position.expiryTime ?? previous.expiryTime,
        status: position.status ?? previous.status,
        longcode: position.longcode ?? previous.longcode,
        isValidToSell: position.isValidToSell,
        isSold: false,
        lastUpdateAt: now,
      };
      contracts = contracts.map((row, at) => (at === index ? updated : row));
      changed = true;
    }

    for (const row of closed) {
      const tracked = contracts.find((contract) => contract.contractId === row.contractId);
      if (!tracked || tracked.settledProfit !== null) continue;
      settle(row.contractId, row.profit, null, row.sellTime ? row.sellTime * 1_000 : now);
    }

    // A purchase whose receipt never arrived is matched to the contract it
    // produced, so the bot never sends a second order for one decision.
    const unreconciled = purchaseRef.current.unreconciled;
    if (unreconciled) {
      const match = positions.find((position) => !position.isSold
        && !contracts.some((contract) => contract.contractId === position.contractId)
        && position.symbol === unreconciled.symbol
        && (position.contractType === unreconciled.direction || position.contractType === null)
        && position.buyTime !== null
        && Math.abs(position.buyTime * 1_000 - unreconciled.at) <= 180_000);
      if (match) {
        contracts = [{
          contractId: match.contractId,
          decisionId: unreconciled.decisionId,
          direction: unreconciled.direction,
          symbol: unreconciled.symbol,
          currency: match.currency ?? account.currency,
          stake: match.buyPrice ?? unreconciled.stake,
          payout: match.payout,
          entrySpot: match.entrySpot,
          currentSpot: match.currentSpot,
          exitSpot: null,
          profit: match.profit,
          tickCount: match.tickCount,
          tickPassed: match.tickPassed,
          expiryTime: match.expiryTime,
          status: match.status ?? 'open',
          longcode: match.longcode,
          isSold: false,
          isValidToSell: match.isValidToSell,
          settledProfit: null,
          settledAt: null,
          openedAt: unreconciled.at,
          lastUpdateAt: now,
          mode: modeRef.current,
        }, ...contracts];
        records = records.map((record) => (record.id === unreconciled.decisionId
          ? { ...record, contractId: match.contractId, stake: match.buyPrice ?? record.stake, payout: match.payout ?? record.payout, status: 'open' as const, note: `Reconciled with contract ${match.contractId} on the account.` }
          : record));
        commitPurchase({ inFlight: false, unreconciled: null });
        setSafety((current) => clearAutoPause(current, (reason) => reason.startsWith('A purchase request may have reached Deriv'), modeRef.current));
        changed = true;
      } else if (now - unreconciled.at > UNRECONCILED_TIMEOUT_MS && !positions.some((position) => !position.isSold && position.symbol === unreconciled.symbol)) {
        // The account has had time to report its portfolio and shows no open
        // contract for that symbol, so the order never reached Deriv.
        records = records.map((record) => (record.id === unreconciled.decisionId && record.status === 'unreconciled'
          ? { ...record, status: 'rejected' as const, note: 'The account reported no open contract for this order; nothing was bought.' }
          : record));
        commitPurchase({ inFlight: false, unreconciled: null });
        setSafety((current) => clearAutoPause(current, (reason) => reason.startsWith('A purchase request may have reached Deriv'), modeRef.current));
        changed = true;
      }
    }

    if (!changed) return;
    const openExposure = contracts.filter((contract) => !contract.isSold).reduce((total, contract) => total + contract.stake, 0);
    commitContracts(contracts);
    commitRecords(records);
    commitAccount(setOpenExposure(account, openExposure));
  }, [trading.openPositions, trading.closedPositions, commitAccount, commitContracts, commitPurchase, commitRecords]);

  // ---- stale unconfirmed purchase -------------------------------------------
  // The portfolio effect above only runs when Deriv sends new position data. An
  // unconfirmed purchase that produced nothing at all would otherwise block the
  // bot forever, so the same check runs on a timer against the latest snapshot.
  const openPositionsRef = useRef<DerivOpenPosition[]>(trading.openPositions);
  openPositionsRef.current = trading.openPositions;
  useEffect(() => {
    const interval = window.setInterval(() => {
      const unreconciled = purchaseRef.current.unreconciled;
      if (!unreconciled) return;
      const now = Date.now();
      if (now - unreconciled.at <= UNRECONCILED_TIMEOUT_MS) return;
      if (openPositionsRef.current.some((position) => !position.isSold && position.symbol === unreconciled.symbol)) return;
      commitPurchase({ inFlight: false, unreconciled: null });
      commitRecords(recordsRef.current.map((record) => (record.id === unreconciled.decisionId && record.status === 'unreconciled'
        ? { ...record, status: 'rejected' as const, note: 'The account reported no open contract for this order; nothing was bought.' }
        : record)));
      setSafety((current) => clearAutoPause(current, (reason) => reason.startsWith('A purchase request may have reached Deriv'), modeRef.current));
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [commitPurchase, commitRecords]);

  // ---- live feature refresh --------------------------------------------------
  // Features are recomputed on every verified tick, so the panel shows what the
  // engine reads right now even while the bot is stopped or in analysis mode.
  useEffect(() => {
    if (!feed.ticks.length) {
      setFeatures(null);
      return;
    }
    const quotes = feed.ticks.map((tick) => tick.quote);
    setFeatures(extractFeatures(quotes, configRef.current, feed.selectedMarket?.pipSize ?? null, Date.now()));
  }, [feed.ticks, feed.selectedMarket?.pipSize]);

  // ---- score the signals that were never traded ------------------------------
  useEffect(() => {
    const symbol = feed.selectedSymbol;
    if (!symbol || feed.ticks.length < 2) return;
    const observations: TickPoint[] = feed.ticks.map((tick) => ({ epoch: tick.epoch, quote: tick.quote }));
    const pending = predictionsRef.current.filter((row) => !row.resolved && !row.expired);
    if (!pending.length) return;
    const { rows, resolved } = resolvePredictions(predictionsRef.current, observations, symbol, Date.now());
    if (!resolved) return;
    predictionsRef.current = rows;
    setPredictions(rows);
  }, [feed.ticks, feed.selectedSymbol]);

  /** Buys one CALL/PUT contract on the authorized account, or explains why not. */
  const executeEntry = useCallback(async (options: {
    decisionId: string;
    direction: RiseFallDirection;
    rule: RiseFallRule;
    symbol: string;
    stake: number;
    step: number;
    config: RiseFallConfig;
    currency: string;
    evidence: SignalEvidence | null;
    features: RiseFallFeatures | null;
  }): Promise<EntryResult> => {
    const { decisionId, direction, rule, symbol, stake, step, config: entryConfig, currency, evidence, features: entryFeatures } = options;
    const notes: string[] = [];
    const refuse = (message: string): EntryResult => ({ executed: false, contractId: null, message, notes, economics: null });

    if (purchaseRef.current.inFlight) return refuse('A purchase is already in progress on this account.');
    if (purchaseRef.current.unreconciled) return refuse('A previous purchase has not been reconciled with Deriv yet.');
    if (!currency) return refuse('Deriv has not reported the account currency, so the order cannot be priced.');
    if (!Number.isFinite(stake) || stake <= 0) return refuse('The risk manager did not produce a usable stake.');

    const request: DerivTradeRequest = {
      contractType: direction,
      symbol,
      currency,
      stake,
      duration: entryConfig.duration,
      durationUnit: entryConfig.durationUnit,
      barrier: null,
    };

    commitPurchase({ inFlight: true, unreconciled: purchaseRef.current.unreconciled });

    let quote: DerivQuote;
    try {
      quote = await trading.requestQuote(request);
    } catch (error) {
      commitPurchase({ inFlight: false, unreconciled: purchaseRef.current.unreconciled });
      const message = errorText(error);
      commitRecords([...recordsRef.current, rejectedRecord(decisionId, options, message)]);
      return { executed: false, contractId: null, message, notes, economics: null };
    }
    if (!mountedRef.current) {
      commitPurchase({ inFlight: false, unreconciled: purchaseRef.current.unreconciled });
      return refuse('The bot stopped while Deriv was quoting.');
    }

    const check = validateRiseFallQuote({
      askPrice: quote.askPrice,
      payout: quote.payout,
      stake,
      spot: quote.spot,
      spotTime: quote.spotTime,
      now: Date.now(),
      maxAgeMs: entryConfig.maxTickAgeMs,
      serverClockOffsetMs: feed.serverClockOffsetMs,
    });
    if (!check.ok) {
      commitPurchase({ inFlight: false, unreconciled: purchaseRef.current.unreconciled });
      const message = check.issues.join(' ');
      commitRecords([...recordsRef.current, rejectedRecord(decisionId, options, message)]);
      return { executed: false, contractId: null, message, notes, economics: null };
    }

    const economics = evaluateProposalEconomics({
      askPrice: quote.askPrice,
      payout: quote.payout,
      stake,
      winRate: evidence?.winRate ?? null,
      pushRate: evidence?.pushRate ?? null,
    });
    notes.push(`Live proposal: cost ${quote.askPrice.toFixed(2)} ${currency}, payout ${quote.payout === null ? '—' : quote.payout.toFixed(2)} ${currency}, break-even ${economics ? `${(economics.breakEvenProbability * 100).toFixed(1)}%` : 'unknown'}.`);
    if (economics && evidence?.sufficient && economics.returnOnStake !== null) {
      notes.push(`Expected value ${economics.returnOnStake.toFixed(4)} per unit staked, from ${evidence.occurrences} historical firing(s) of this rule at the ${evidence.horizonTicks}-tick horizon.`);
    }
    if (entryConfig.requirePositiveExpectedValue) {
      if (economics && evidence?.sufficient && economics.returnOnStake !== null && economics.returnOnStake < entryConfig.minExpectedValue) {
        commitPurchase({ inFlight: false, unreconciled: purchaseRef.current.unreconciled });
        const message = `Expected value ${economics.returnOnStake.toFixed(4)} per unit staked is below the required ${entryConfig.minExpectedValue.toFixed(4)}; the purchase was refused.`;
        commitRecords([...recordsRef.current, rejectedRecord(decisionId, options, message)]);
        return { executed: false, contractId: null, message, notes, economics };
      }
      if (!evidence?.sufficient) {
        notes.push(`Expected-value gate withheld: ${evidence?.occurrences ?? 0} historical firing(s) of this rule, fewer than the required ${entryConfig.minEvidenceSample}. No edge is assumed either way.`);
      }
    }

    try {
      const receipt = await trading.confirmBuy(quote, request);
      const now = Date.now();
      const contract: MonitoredRiseFallContract = {
        contractId: receipt.contractId,
        decisionId,
        direction,
        symbol,
        currency,
        stake: receipt.buyPrice,
        payout: receipt.payout,
        entrySpot: quote.spot,
        currentSpot: quote.spot,
        exitSpot: null,
        profit: null,
        tickCount: entryConfig.durationUnit === 't' ? entryConfig.duration : null,
        tickPassed: 0,
        expiryTime: quote.dateExpiry,
        status: 'open',
        longcode: receipt.longcode,
        isSold: false,
        isValidToSell: false,
        settledProfit: null,
        settledAt: null,
        openedAt: (receipt.purchaseTime ?? receipt.startTime ?? now / 1_000) * 1_000,
        lastUpdateAt: now,
        mode: modeRef.current,
      };
      commitContracts([contract, ...contractsRef.current]);
      const accountAfter = applyPurchase(accountRef.current, { stake: receipt.buyPrice, now });
      commitAccount(accountAfter);
      const record: RiseFallTradeRecord = {
        id: decisionId,
        at: now,
        settledAt: null,
        mode: modeRef.current,
        symbol,
        direction,
        rule,
        stake: receipt.buyPrice,
        step,
        payout: receipt.payout,
        contractId: receipt.contractId,
        entrySpot: quote.spot,
        exitSpot: null,
        status: 'open',
        profit: null,
        balanceAfter: receipt.balanceAfter ?? accountAfter.balance,
        sessionPnl: accountAfter.sessionPnl,
        dailyPnl: accountAfter.dailyPnl,
        momentumPips: entryFeatures?.momentumPips ?? null,
        volatilityPips: entryFeatures?.volatilityPips ?? null,
        winRateEstimate: evidence?.winRate ?? null,
        expectedValue: economics?.returnOnStake ?? null,
        note: notes.join(' '),
      };
      commitRecords([...recordsRef.current, record]);
      commitPurchase({ inFlight: false, unreconciled: null });
      notes.push(`Deriv confirmed contract ${receipt.contractId} for ${receipt.buyPrice.toFixed(2)} ${currency}.`);
      return { executed: true, contractId: receipt.contractId, message: '', notes, economics };
    } catch (error) {
      const message = errorText(error);
      // A timed-out purchase may still have reached Deriv, so it stays
      // unreconciled until the account itself confirms what happened.
      const uncertain = /did not confirm the purchase in time|closed before Deriv answered/i.test(message);
      commitPurchase({
        inFlight: false,
        unreconciled: uncertain ? { decisionId, at: Date.now(), symbol, direction, stake } : purchaseRef.current.unreconciled,
      });
      if (uncertain) {
        setSafety((current) => registerAutoPause(current, 'A purchase request may have reached Deriv without a receipt; it must be reconciled before any new order.', modeRef.current));
      }
      commitRecords([...recordsRef.current, {
        ...rejectedRecord(decisionId, options, message),
        status: uncertain ? 'unreconciled' as const : 'rejected' as const,
      }]);
      return { executed: false, contractId: null, message, notes, economics };
    }
  }, [commitAccount, commitContracts, commitPurchase, commitRecords, feed.serverClockOffsetMs, trading]);

  // ---- the decision cycle ----------------------------------------------------
  const runCycle = useCallback(async (options?: { force?: boolean }) => {
    if (busyRef.current) {
      // A cycle is already pricing. The tick that just arrived would otherwise be
      // dropped and the entry would wait for the next one, so it is re-run as soon
      // as the current cycle releases the lock.
      pendingCycleRef.current = true;
      return;
    }
    const safetyState = safetyRef.current;
    const forced = options?.force === true;
    if (!forced && safetyState.runState !== 'running') return;
    const entryConfig = configRef.current;
    const currentMode = modeRef.current;
    const startedAt = Date.now();
    // Dedupe only. A new tick starts the cycle; the old rule waited a whole
    // decision interval, which is exactly the delay that missed entries.
    if (!shouldStartBotCycle({ now: startedAt, lastCycleAt: lastCycleRef.current, minSpacingMs: BOT_CYCLE_MIN_SPACING_MS, force: forced })) return;
    const symbol = feed.selectedSymbol;
    const observations = feed.ticks;
    if (!symbol || !observations.length) return;

    busyRef.current = true;
    lastCycleRef.current = startedAt;
    setCycleRunning(true);
    const decisionId = nextDecisionId(startedAt, symbol);
    const quotes = observations.map((tick) => tick.quote);
    const pipSize = feed.selectedMarket?.pipSize ?? null;

    try {
      const cycleFeatures = extractFeatures(quotes, entryConfig, pipSize, startedAt);
      const verdict = decideDirection(cycleFeatures, entryConfig);
      const horizonTicks = entryConfig.durationUnit === 't' ? entryConfig.duration : null;
      const evidence = verdict.direction
        ? evaluateSignalEvidence({ quotes, config: entryConfig, direction: verdict.direction, pipSize, horizonTicks })
        : null;
      const accountSnapshot = accountRef.current;
      const openContracts = contractsRef.current.filter((contract) => !contract.isSold).length;
      const gate = evaluateRiskGate({
        config: entryConfig,
        account: accountSnapshot,
        mode: currentMode,
        // A forced cycle is the one Start just triggered: the safety ref still
        // holds the pre-Start state, so treating it as stopped would throw away
        // the first opportunity after the operator pressed Start.
        runState: forced ? 'running' : safetyState.runState,
        autoPauseReasons: safetyState.autoPauseReasons,
        manualPause: forced ? false : safetyState.manualPause,
        accountAuthorized: trading.activeAccount !== null,
        connectionHealthy: trading.status === 'connected',
        feedFresh: feed.fresh,
        feedStatus: feed.status,
        tickCount: observations.length,
        openContracts,
        unreconciledPurchase: purchaseRef.current.unreconciled !== null,
        purchaseInFlight: purchaseRef.current.inFlight,
        now: startedAt,
      });

      const reasons = [...verdict.reasons];
      const codes = [...verdict.reasonCodes];
      if (evidence) {
        reasons.push(evidence.note);
        codes.push(evidence.sufficient ? 'EVIDENCE_SUFFICIENT' : 'EVIDENCE_THIN');
      }
      // Deriv's `contracts_for` response does not list Rise/Fall expiries for
      // every market — the trade dock treats them as unverified for the same
      // reason. When the report exists it is authoritative; when it does not,
      // the live proposal decides, and a rejected proposal never becomes an
      // order because the buy is sent against the proposal id.
      const durationReported = verdict.direction === null
        ? false
        : feed.contracts.some((contract) => contract.contractType === verdict.direction);
      const durationIssue = verdict.direction
        ? draftDurationIssue(entryConfig.duration, entryConfig.durationUnit, verdict.direction, feed.contracts, feed.contractsLoaded && durationReported)
        : '';
      if (durationIssue) {
        reasons.push(durationIssue);
        codes.push('DURATION_UNSUPPORTED');
      } else if (verdict.direction && feed.contractsLoaded && !durationReported) {
        reasons.push(`Deriv has not reported ${verdict.direction} expiries for ${symbol}; the live proposal is the authority on this duration.`);
        codes.push('DURATION_UNVERIFIED');
      }
      reasons.push(...gate.notes);

      let action: RiseFallDecision['action'] = 'WAIT';
      let actionLabel = 'No signal';
      if (!verdict.direction) {
        action = 'WAIT';
        actionLabel = 'No signal';
      } else if (currentMode !== 'live') {
        action = 'WAIT';
        actionLabel = `Signal ${RISE_FALL_LABELS[verdict.direction]} · analysis mode`;
        reasons.push('Analysis-only mode records the signal and scores it later; no order is sent.');
        codes.push('ANALYSIS_MODE');
      } else if (durationIssue || !gate.allowed) {
        action = 'BLOCKED';
        actionLabel = `Blocked · ${RISE_FALL_LABELS[verdict.direction]}`;
        reasons.push(...gate.violations);
        codes.push(...gate.codes);
        if (durationIssue) codes.push('DURATION_UNSUPPORTED');
      } else {
        action = 'TRADE';
        actionLabel = `Buy ${RISE_FALL_LABELS[verdict.direction]}`;
      }

      // An unscored signal is recorded in both modes so the calibration figures
      // describe the rule, not only the orders that happened to be allowed.
      if (verdict.direction && horizonTicks !== null) {
        const entryEpoch = observations[observations.length - 1].epoch;
        const alreadyRecorded = predictionsRef.current.some((row) => row.entryEpoch === entryEpoch && row.symbol === symbol);
        if (!alreadyRecorded) {
          const prediction: RiseFallPrediction = {
            id: decisionId,
            at: startedAt,
            symbol,
            direction: verdict.direction,
            rule: verdict.rule,
            entryEpoch,
            entryQuote: quotes[quotes.length - 1],
            horizonTicks,
            stake: gate.stake,
            winRateEstimate: evidence?.winRate ?? null,
            resolved: false,
            expired: false,
            exitQuote: null,
            outcome: null,
            resolvedAt: null,
          };
          predictionsRef.current = [...predictionsRef.current, prediction].slice(-PREDICTION_LIMIT);
          setPredictions(predictionsRef.current);
        }
      }

      let executed = false;
      let contractId: number | null = null;
      let error: string | null = null;
      if (action === 'TRADE' && verdict.direction) {
        const result = await executeEntry({
          decisionId,
          direction: verdict.direction,
          rule: verdict.rule,
          symbol,
          stake: gate.stake ?? entryConfig.baseStake,
          step: gate.step,
          config: entryConfig,
          currency: accountSnapshot.currency || trading.currency,
          evidence,
          features: cycleFeatures,
        });
        executed = result.executed;
        contractId = result.contractId;
        reasons.push(...result.notes);
        if (executed) {
          actionLabel = `Bought ${RISE_FALL_LABELS[verdict.direction]}`;
          codes.push('ORDER_SENT');
        } else {
          action = 'BLOCKED';
          actionLabel = `Blocked at purchase · ${RISE_FALL_LABELS[verdict.direction]}`;
          error = result.message || 'The purchase was not sent.';
          reasons.push(error);
          codes.push('PURCHASE_REFUSED');
        }
      }
      if (!mountedRef.current) return;

      const cycleDecision: RiseFallDecision = {
        id: decisionId,
        at: startedAt,
        symbol,
        mode: currentMode,
        action,
        actionLabel,
        direction: verdict.direction,
        rule: verdict.rule,
        reasons: [...new Set(reasons)],
        reasonCodes: [...new Set(codes)],
        features: cycleFeatures,
        evidence,
        stake: verdict.direction ? gate.stake : null,
        step: gate.step,
        executed,
        contractId,
        error,
      };
      setFeatures(cycleFeatures);
      setRisk(gate);
      setDecision(cycleDecision);
      setCycleLog((current) => [cycleDecision, ...current].slice(0, LOG_LIMIT));
      setLastCycleAt(startedAt);
      setCycleError('');
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : 'The decision cycle failed.';
      setCycleError(message);
      setCycleLog((current) => [{
        id: decisionId,
        at: startedAt,
        symbol,
        mode: currentMode,
        action: 'BLOCKED' as const,
        actionLabel: 'Cycle error',
        direction: null,
        rule: 'none' as RiseFallRule,
        reasons: [message],
        reasonCodes: ['CYCLE_ERROR'],
        features: null,
        evidence: null,
        stake: null,
        step: 0,
        executed: false,
        contractId: null,
        error: message,
      }, ...current].slice(0, LOG_LIMIT));
      if (purchaseRef.current.inFlight) commitPurchase({ inFlight: false, unreconciled: purchaseRef.current.unreconciled });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCycleRunning(false);
      if (pendingCycleRef.current) {
        pendingCycleRef.current = false;
        // Unforced: the spacing floor still keeps a slow cycle from looping.
        void runCycleRef.current();
      }
    }
  }, [commitPurchase, executeEntry, feed.contracts, feed.contractsLoaded, feed.fresh, feed.selectedMarket?.pipSize, feed.selectedSymbol, feed.status, feed.ticks, nextDecisionId, trading]);

  runCycleRef.current = runCycle;

  // Tick-driven: the newest tick is the event that can change the decision.
  // The configured interval is the watchdog for a quiet feed, not the latency.
  useBotCycleTrigger({
    enabled: safety.runState === 'running',
    tickEpoch: feed.ticks.at(-1)?.epoch ?? null,
    watchdogMs: config.decisionIntervalMs,
    run: () => { void runCycleRef.current(); },
  });

  // ---- operator controls -----------------------------------------------------
  const start = useCallback(() => {
    const now = Date.now();
    commitAccount(beginSession(rollTradingDay(accountRef.current, now), now));
    setSafety((current) => startBot(current, modeRef.current));
    lastCycleRef.current = 0;
    // Forced: the safety ref still holds the pre-Start state, so an unforced
    // cycle would return immediately and the first entry would wait a tick.
    void runCycleRef.current({ force: true });
  }, [commitAccount]);

  const pause = useCallback(() => setSafety((current) => pauseBot(current, modeRef.current)), []);
  const resume = useCallback(() => setSafety((current) => resumeBot(current, modeRef.current)), []);
  const stop = useCallback(() => {
    // Stopping blocks new purchases only. Contracts Deriv already accepted keep
    // being monitored and are never reported as cancelled.
    setSafety((current) => stopBot(current, modeRef.current, { now: Date.now(), by: 'user' }));
  }, []);

  const runCycleNow = useCallback(() => {
    lastCycleRef.current = 0;
    void runCycleRef.current({ force: true });
  }, []);

  const setMode = useCallback((next: RiseFallBotMode) => {
    setModeState(next);
    setSafety((current) => stopBot(current, next, { now: Date.now(), by: 'user' }));
  }, []);

  const updateConfig = useCallback((patch: Partial<RiseFallConfig>) => {
    setConfig((current) => sanitizeRiseFallConfig({ ...current, ...patch }));
  }, []);

  const resetConfig = useCallback(() => setConfig(sanitizeRiseFallConfig(defaultRiseFallConfig())), []);

  const closeContract = useCallback(async (contractId: number) => {
    await trading.sellContract(contractId);
  }, [trading]);

  const clearTradeLog = useCallback(() => {
    commitRecords([]);
    setPredictions([]);
    predictionsRef.current = [];
  }, [commitRecords]);

  const stakePlan = useMemo(() => computeStakePlan(config, account), [config, account]);
  const tradeSummary = useMemo(() => summarizeTrades(records), [records]);
  const predictionSummary = useMemo(() => summarizePredictions(predictions), [predictions]);
  const tradeLogCsv = useMemo(() => tradesToCsv(records), [records]);
  const supportedTickExpiries = useMemo(() => {
    const values = new Set<number>([
      ...supportedTradeTicks(feed.contracts, 'CALL'),
      ...supportedTradeTicks(feed.contracts, 'PUT'),
    ]);
    return [...values].sort((left, right) => left - right);
  }, [feed.contracts]);

  const latest = feed.ticks.at(-1) ?? null;

  return useMemo<RiseFallBotController>(() => ({
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
    quote: latest?.quote ?? null,
    tickCount: feed.ticks.length,
    feedStatus: feed.status,
    feedFresh: feed.fresh,
    feedError: feed.feedError || feed.contractError,
    precisionError: feed.precisionError,
    supportedTickExpiries,
    contractSupportLoaded: feed.contractsLoaded,

    features,
    decision,
    cycleLog,
    cycleRunning,
    cycleError,
    lastCycleAt,
    risk,
    nextStake: stakePlan.stake,
    martingaleStep: stakePlan.step,

    account,
    accountType: trading.activeAccount?.accountType ?? null,
    accountCurrency: trading.currency || trading.activeAccount?.currency || '',
    balance: trading.balance,
    connected: trading.status === 'connected',
    contracts,
    accountOpenPositions: trading.openPositions,
    records,
    predictions,
    tradeSummary,
    predictionSummary,
    tradeLogCsv,
    purchaseInFlight: purchase.inFlight,
    unreconciledPurchase: purchase.unreconciled !== null,
    sessionMinutesRemaining: sessionMinutesRemaining(config, account, Date.now()),
    tradesRemaining: tradesRemaining(config, account),

    closeContract,
    clearTradeLog,
  }), [
    account, closeContract, config, contracts, cycleError, cycleLog, cycleRunning, decision, features,
    feed.contractError, feed.contractsLoaded, feed.feedError, feed.precisionError, feed.selectedMarket?.name,
    feed.selectedMarket?.pipSize, feed.selectedMarket?.precision, feed.selectedSymbol, feed.setSelectedSymbol,
    feed.status, feed.fresh, feed.symbols, feed.ticks.length, latest?.quote, mode, pause, predictions,
    predictionSummary, purchase, records, resetConfig, resume, risk, runCycleNow, safety, setMode, stakePlan, start, stop,
    supportedTickExpiries, tradeLogCsv, tradeSummary, trading.activeAccount?.accountType, trading.balance,
    trading.currency, trading.openPositions, trading.status, updateConfig,
  ]);
}

/** A purchase that never reached Deriv is still logged, with the reason. */
function rejectedRecord(
  decisionId: string,
  options: {
    direction: RiseFallDirection;
    rule: RiseFallRule;
    symbol: string;
    stake: number;
    step: number;
    evidence: SignalEvidence | null;
    features: RiseFallFeatures | null;
  },
  message: string,
): RiseFallTradeRecord {
  return {
    id: decisionId,
    at: Date.now(),
    settledAt: null,
    mode: 'live',
    symbol: options.symbol,
    direction: options.direction,
    rule: options.rule,
    stake: options.stake,
    step: options.step,
    payout: null,
    contractId: null,
    entrySpot: null,
    exitSpot: null,
    status: 'rejected',
    profit: null,
    balanceAfter: null,
    sessionPnl: 0,
    dailyPnl: 0,
    momentumPips: options.features?.momentumPips ?? null,
    volatilityPips: options.features?.volatilityPips ?? null,
    winRateEstimate: options.evidence?.winRate ?? null,
    expectedValue: null,
    note: message,
  };
}
