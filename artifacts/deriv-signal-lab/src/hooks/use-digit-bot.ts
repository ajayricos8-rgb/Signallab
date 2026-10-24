// Digit-bot controller: connects the engine layer in `lib/digit-bot` to the
// application's existing Deriv connections.
//
// Two connections are reused, neither is replaced or reconfigured:
//   * the public market-data feed (`useDerivDigitFeed`) supplies real ticks,
//     symbol metadata and contract support;
//   * the authenticated trading session (`useDerivTrading`) supplies proposals,
//     purchases, balances, positions, settlements and the account type.
//
// Every decision is computed by the pure engine modules; this hook only moves
// data between them, drives the decision cycle and persists non-secret operator
// settings in the browser. No token, account identifier or WebSocket URL is
// ever stored by, or sent on behalf of, the bot.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDerivDigitFeed } from '@/hooks/use-deriv-digit-feed';
import { BOT_CYCLE_MIN_SPACING_MS, shouldStartBotCycle, useBotCycleTrigger } from '@/hooks/use-bot-cycle-trigger';
import { configNeedsReset, markConfigVersion } from '@/lib/bot-config-version';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import type { DerivTradeRequest } from '@/lib/deriv-trading';
import { supportedTradeTicks } from '@/lib/trade-duration';
import { TickBuffer } from '@/lib/digit-bot/data-engine';
import {
  createAccountState,
  defaultRiskConfig,
  type ContractFamily,
  type BotAccountState,
  type BotMode,
  type BotRiskConfig,
  type BotRunState,
  type CandidateRecord,
  type DataQualityFinding,
  type DecisionCycleResult,
  type DigitIntelligenceFindings,
  type MonitoredContract,
  type PredictionRecord,
  type PurchaseOutcome,
  type RiskEvaluation,
  type SafetyState,
  type TradeIntent,
} from '@/lib/digit-bot/types';
import {
  applyPurchase,
  applySettlement,
  beginSession,
  entriesRemaining,
  reconcileBalance,
  rollTradingDay,
  sanitizeRiskConfig,
  sessionMinutesRemaining,
} from '@/lib/digit-bot/risk';
import {
  clearAutoPause,
  createSafetyState,
  pauseBot,
  registerAutoPause,
  resumeBot,
  startBot,
  stopBot,
} from '@/lib/digit-bot/safety';
import { completeCycle, planCycle, type CyclePlan } from '@/lib/digit-bot/orchestrator';
import {
  abandonInFlight,
  applyContractUpdate,
  beginPurchase,
  completePurchase,
  createExecutionState,
  failPurchase,
  nextDecisionId,
  reconcileWithPortfolio,
  upsertMonitoredContract,
  type ExecutionState,
  type Settlement,
} from '@/lib/digit-bot/execution';
import { validateProposal, type ProposalSnapshot } from '@/lib/digit-bot/expectancy';
import {
  createPredictionRecord,
  pruneRecords,
  resolvePendingPredictions,
  separateByMode,
  summarizePerformance,
  walkForwardReport,
  type PerformanceMetrics,
} from '@/lib/digit-bot/performance';

const MODE_KEY = 'signal-lab-digit-bot-mode';
const SELECTION_KEY = 'signal-lab-digit-bot-selection';
const CONFIG_KEY = 'signal-lab-digit-bot-risk-config';
const RECORDS_KEY = 'signal-lab-digit-bot-predictions';
const HISTORY_LIMIT = 40;
const RECORD_LIMIT = 400;
const PROPOSAL_LIMIT = 8;

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

function readMode(): BotMode {
  try {
    const value = window.localStorage.getItem(MODE_KEY);
    // Only analysis and live exist; any stored legacy value (e.g. the removed
    // simulated mode) falls back to the non-executing analysis mode.
    return value === 'live' ? 'live' : 'analysis';
  } catch {
    return 'analysis';
  }
}

export type CycleLogEntry = {
  decisionId: string;
  cycleAt: number;
  durationMs: number;
  action: DecisionCycleResult['action'];
  actionLabel: string;
  mode: BotMode;
  symbol: string;
  reasonCodes: string[];
  reasons: string[];
  contract: string | null;
  stake: number | null;
  expectedValue: number | null;
  probability: number | null;
  breakEvenProbability: number | null;
  executed: boolean;
  error: string | null;
};

export type SelectionMode = 'auto' | 'manual';

export type DigitBotController = {
  mode: BotMode;
  selectionMode: SelectionMode;
  setSelectionMode: (mode: SelectionMode) => void;
  manualFamily: ContractFamily;
  setManualFamily: (family: ContractFamily) => void;
  setMode: (mode: BotMode) => void;
  runState: BotRunState;
  riskConfig: BotRiskConfig;
  updateRiskConfig: (patch: Partial<BotRiskConfig>) => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;

  symbol: string;
  selectSymbol: (symbol: string) => void;
  symbols: ReturnType<typeof useDerivDigitFeed>['symbols'];
  marketName: string;
  supportedTickExpiries: number[];
  contractSupportLoaded: boolean;
  quote: number | null;
  precision: number | null;
  lastDigit: number | null;
  tickCount: number;
  dataQuality: DataQualityFinding | null;
  digits: DigitIntelligenceFindings | null;
  decision: DecisionCycleResult | null;
  cycleLog: CycleLogEntry[];
  cycleRunning: boolean;
  cycleError: string;
  lastCycleAt: number | null;

  candidates: CandidateRecord[];
  risk: RiskEvaluation | null;
  account: BotAccountState;
  contracts: MonitoredContract[];
  outcomes: PurchaseOutcome[];
  safety: SafetyState;
  metrics: PerformanceMetrics;
  analysisMetrics: PerformanceMetrics;
  walkForward: ReturnType<typeof walkForwardReport> | null;
  hasMixedDatasets: boolean;
  accountType: 'demo' | 'real' | null;
  accountCurrency: string;
  connected: boolean;
  feedStatus: string;
  feedFresh: boolean;
  entriesRemaining: number;
  sessionMinutesRemaining: number | null;
  records: PredictionRecord[];
};

function toProposalSnapshot(quote: {
  id: string;
  askPrice: number;
  payout: number | null;
  spot: number | null;
  spotTime: number | null;
  dateStart: number | null;
  dateExpiry: number | null;
  longcode: string | null;
}): ProposalSnapshot {
  return {
    quoteId: quote.id,
    askPrice: quote.askPrice,
    payout: quote.payout,
    spot: quote.spot,
    spotTime: quote.spotTime,
    dateStart: quote.dateStart,
    dateExpiry: quote.dateExpiry,
    longcode: quote.longcode,
    receivedAt: Date.now(),
  };
}

export function useDigitBot(): DigitBotController {
  const feed = useDerivDigitFeed();
  const trading = useDerivTrading();

  const [mode, setModeState] = useState<BotMode>(readMode);
  const [riskConfig, setRiskConfig] = useState<BotRiskConfig>(() => sanitizeRiskConfig(
    configNeedsReset(CONFIG_KEY) ? defaultRiskConfig() : readJson<BotRiskConfig>(CONFIG_KEY, defaultRiskConfig()),
  ));
  const [safety, setSafety] = useState<SafetyState>(createSafetyState);
  const [account, setAccount] = useState<BotAccountState>(createAccountState);
  const [decision, setDecision] = useState<DecisionCycleResult | null>(null);
  const [candidates, setCandidates] = useState<CandidateRecord[]>([]);
  const [risk, setRisk] = useState<RiskEvaluation | null>(null);
  const [cycleLog, setCycleLog] = useState<CycleLogEntry[]>([]);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [cycleError, setCycleError] = useState('');
  const [lastCycleAt, setLastCycleAt] = useState<number | null>(null);
  const [contracts, setContracts] = useState<MonitoredContract[]>([]);
  const [outcomes, setOutcomes] = useState<PurchaseOutcome[]>([]);
  const [records, setRecords] = useState<PredictionRecord[]>(() => readJson<PredictionRecord[]>(RECORDS_KEY, []));
  const [selectionMode, setSelectionModeState] = useState<SelectionMode>(() => readJson<SelectionMode>(SELECTION_KEY, 'auto'));
  const [manualFamily, setManualFamilyState] = useState<ContractFamily>(() => readJson<ContractFamily>(`${SELECTION_KEY}-family`, 'even-odd'));
  const [dataQuality, setDataQuality] = useState<DataQualityFinding | null>(null);
  const [digits, setDigits] = useState<DigitIntelligenceFindings | null>(null);
  const [tickCount, setTickCount] = useState(0);
  const [, forceTick] = useState(0);

  const bufferRef = useRef(new TickBuffer(5_000));
  const executionRef = useRef<ExecutionState>(createExecutionState());
  const accountRef = useRef(account);
  const safetyRef = useRef(safety);
  const modeRef = useRef(mode);
  const configRef = useRef(riskConfig);
  const recordsRef = useRef(records);
  const modelReportRef = useRef<CyclePlan['modelReport']>(null);
  const busyRef = useRef(false);
  /** A tick arrived while a cycle was pricing; re-run once it finishes. */
  const pendingCycleRef = useRef(false);
  const lastCycleRef = useRef(0);
  const mountedRef = useRef(true);
  const runCycleRef = useRef<(options?: { force?: boolean }) => Promise<void>>(async () => {});
  const selectionModeRef = useRef(selectionMode);
  const manualFamilyRef = useRef(manualFamily);

  accountRef.current = account;
  safetyRef.current = safety;
  modeRef.current = mode;
  configRef.current = riskConfig;
  recordsRef.current = records;
  selectionModeRef.current = selectionMode;
  manualFamilyRef.current = manualFamily;

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    writeJson(CONFIG_KEY, riskConfig);
  }, [riskConfig]);

  // One-time migration marker: the defaults just applied are the shape future
  // edits start from.
  useEffect(() => {
    markConfigVersion(CONFIG_KEY);
  }, []);

  useEffect(() => {
    writeJson(SELECTION_KEY, selectionMode);
    if (typeof window !== 'undefined') writeJson(`${SELECTION_KEY}-family`, manualFamily);
  }, [selectionMode, manualFamily]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Storage is optional; the mode is still held in memory.
    }
  }, [mode]);

  useEffect(() => {
    writeJson(RECORDS_KEY, records.slice(-RECORD_LIMIT));
  }, [records]);

  const trackContract = useCallback((update: MonitoredContract) => {
    executionRef.current = { ...executionRef.current, contracts: upsertMonitoredContract(executionRef.current.contracts, update) };
    setContracts([...executionRef.current.contracts]);
  }, []);

  const creditSettlement = useCallback((settlement: Settlement, at: number) => {
    if (settlement.profit === null) return;
    setAccount((current) => applySettlement(current, { contractId: settlement.contractId, stake: settlement.stake, profit: settlement.profit, symbol: settlement.symbol }, at));
  }, []);

  /** Buys a contract after re-quoting it against the live Deriv proposal. */
  const executeLiveEntry = useCallback(async (intent: TradeIntent): Promise<boolean> => {
    const now = Date.now();
    const started = beginPurchase(executionRef.current, intent, now);
    executionRef.current = started.state;
    if (!started.ok) {
      setOutcomes((current) => [{
        status: 'rejected' as const,
        decisionId: intent.decisionId,
        contractId: null,
        buyPrice: null,
        payout: null,
        balanceAfter: null,
        message: started.message,
        at: now,
      }, ...current].slice(0, HISTORY_LIMIT));
      return false;
    }
    const request: DerivTradeRequest = {
      contractType: intent.contractType,
      symbol: intent.symbol,
      currency: intent.currency,
      stake: intent.stake,
      duration: intent.duration,
      durationUnit: intent.durationUnit,
      barrier: intent.barrier,
    };
    let response;
    try {
      response = await trading.requestQuote(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deriv did not answer the quote request.';
      const failed = failPurchase(executionRef.current, intent, message, Date.now(), { uncertain: false });
      executionRef.current = failed.state;
      setOutcomes((current) => [failed.outcome, ...current].slice(0, HISTORY_LIMIT));
      return false;
    }
    const proposal = toProposalSnapshot(response);
    const check = validateProposal(proposal, {
      contractType: intent.contractType,
      barrierDigit: intent.barrierDigit,
      symbol: intent.symbol,
      stake: intent.stake,
      currency: intent.currency || null,
      durationTicks: intent.duration,
    }, { now: Date.now(), maxAgeMs: 20_000 });
    if (!check.ok) {
      const failed = failPurchase(executionRef.current, intent, check.issues.join(' '), Date.now(), { uncertain: false });
      executionRef.current = failed.state;
      setOutcomes((current) => [failed.outcome, ...current].slice(0, HISTORY_LIMIT));
      return false;
    }
    try {
      const receipt = await trading.confirmBuy(response, request);
      const completed = completePurchase(executionRef.current, intent, receipt, Date.now());
      executionRef.current = completed.state;
      setContracts([...completed.state.contracts]);
      setOutcomes((current) => [completed.outcome, ...current].slice(0, HISTORY_LIMIT));
      setAccount((current) => applyPurchase(current, {
        stake: receipt.buyPrice,
        symbol: intent.symbol,
        now: Date.now(),
        tickCount: bufferRef.current.size(),
      }));
      setRecords((current) => current.map((record) => (record.id === intent.decisionId
        ? { ...record, traded: true, contractId: receipt.contractId, stake: receipt.buyPrice, payout: receipt.payout ?? record.payout, passedRiskChecks: true }
        : record)));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deriv did not confirm the purchase.';
      // A timed-out purchase may still have reached Deriv, so it stays
      // unreconciled until the account confirms what actually happened.
      const uncertain = /did not confirm the purchase in time|closed before Deriv answered/i.test(message);
      const failed = failPurchase(executionRef.current, intent, message, Date.now(), { uncertain });
      executionRef.current = failed.state;
      setOutcomes((current) => [failed.outcome, ...current].slice(0, HISTORY_LIMIT));
      if (uncertain) {
        setSafety((current) => registerAutoPause(current, 'A purchase request may have reached Deriv without a receipt; it must be reconciled before any new order.', modeRef.current));
      }
      return false;
    }
  }, [trading]);

  const runCycle = useCallback(async (options?: { force?: boolean }) => {
    if (busyRef.current) {
      // A cycle is already pricing. The tick that just arrived would otherwise be
      // dropped and the entry would wait for the next one, so it is re-run as soon
      // as the current cycle releases the lock.
      pendingCycleRef.current = true;
      return;
    }
    const currentMode = modeRef.current;
    const config = configRef.current;
    const forced = options?.force === true;
    if (!forced && safetyRef.current.runState !== 'running') return;
    const startedAt = Date.now();
    // A new tick is the event that starts a cycle. The floor only stops the same
    // tick being evaluated twice, so an entry is never left waiting a full
    // decision interval after its conditions are met.
    if (!shouldStartBotCycle({ now: startedAt, lastCycleAt: lastCycleRef.current, minSpacingMs: BOT_CYCLE_MIN_SPACING_MS, force: forced })) return;
    const symbol = feed.selectedSymbol;
    if (!symbol) return;
    const ticks = bufferRef.current.window(symbol, config.analysisWindows.at(-1) ?? 1_000);
    if (!ticks.length) return;
    const accountSnapshot = accountRef.current;
    if (!accountSnapshot.sessionStartedAt) return;

    busyRef.current = true;
    lastCycleRef.current = startedAt;
    setCycleRunning(true);
    const { state: advanced, decisionId } = nextDecisionId(executionRef.current, startedAt, symbol);
    executionRef.current = advanced;

    try {
      const plan = planCycle({
        cycleAt: startedAt,
        decisionId,
        symbol,
        mode: currentMode,
        ticks,
        duplicatesDropped: bufferRef.current.duplicateCount(),
        clockOffsetMs: feed.serverClockOffsetMs,
        precision: feed.selectedMarket?.precision ?? null,
        feedFresh: feed.fresh,
        feedStatus: feed.status,
        contractSupport: feed.contracts,
        riskConfig: config,
        account: accountSnapshot,
        // The scheduler only runs while the bot is running, so the state below
        // is normally already 'running'. It is not overwritten unconditionally:
        // a manual pause or an automatic pause has to reach the gate, otherwise
        // the decision log would claim a check that never ran.
        safety: {
          ...safetyRef.current,
          runState: forced ? 'running' : safetyRef.current.runState,
          manualPause: forced ? false : safetyRef.current.manualPause,
        },
        currency: accountSnapshot.currency,
        activeContracts: executionRef.current.contracts,
        accountAuthorized: trading.activeAccount !== null,
        connectionHealthy: trading.status === 'connected',
        unreconciledPurchase: executionRef.current.unreconciled,
        // Manual selection restricts the evaluated families; the validation
        // engine still decides whether the chosen family may actually trade.
        allowedFamilies: selectionModeRef.current === 'manual' ? [manualFamilyRef.current] : ['even-odd', 'over-under', 'matches'],
      });
      modelReportRef.current = plan.modelReport;
      setDataQuality(plan.dataQuality);
      setDigits(plan.digits);
      setRisk(plan.risk);

      const quotes: Record<string, ProposalSnapshot> = {};
      if (trading.status === 'connected' && plan.shortlist.length) {
        // Requested in parallel: waiting for each proposal in turn added the
        // round-trip of every candidate to the cycle, and a shortlist of five
        // could push the decision past the next tick entirely.
        const requested = plan.shortlist.slice(0, PROPOSAL_LIMIT);
        const responses = await Promise.all(requested.map(async (candidate) => {
          try {
            const response = await trading.requestQuote({
              contractType: candidate.contractType,
              symbol,
              currency: accountSnapshot.currency,
              stake: plan.risk.stake ?? config.fixedStake,
              duration: plan.durationTicks,
              durationUnit: 't',
              barrier: candidate.barrier === null ? null : String(candidate.barrier),
            });
            return { candidate, response };
          } catch {
            // A rejected quote simply leaves that candidate without economics;
            // the expectancy engine reports a missing payout instead of
            // inventing one.
            return null;
          }
        }));
        if (!mountedRef.current) return;
        for (const entry of responses) {
          if (!entry) continue;
          quotes[entry.candidate.id] = toProposalSnapshot(entry.response);
        }
      }

      const result = await completeCycle(plan, {
        quotes,
        account: accountSnapshot,
        currency: accountSnapshot.currency,
        accountAuthorized: trading.activeAccount !== null,
        connectionHealthy: trading.status === 'connected',
        purchasedDecisionIds: executionRef.current.purchasedDecisionIds,
        purchaseInFlight: executionRef.current.unreconciled !== null,
      });
      if (!mountedRef.current) return;
      setDecision(result);
      setCandidates(result.candidates);
      setLastCycleAt(result.cycleAt);

      const tracked = result.selected ?? result.candidates.find((candidate) => candidate.proposalVerified) ?? result.candidates[0] ?? null;
      if (tracked) {
        const record = createPredictionRecord({
          id: decisionId,
          at: result.cycleAt,
          mode: currentMode,
          symbol,
          currentDigit: result.digits?.lastDigit ?? null,
          window: result.digits?.windows.at(-1)?.window ?? null,
          modelVersions: result.models.filter((model) => model.status === 'contributing').map((model) => `${model.key}`),
          contractType: tracked.contractType,
          family: tracked.family,
          barrier: tracked.barrier,
          predictedProbability: tracked.estimatedProbability,
          probabilityLowerBound: tracked.probabilityLowerBound,
          probabilityUpperBound: tracked.probabilityUpperBound,
          payout: tracked.payout,
          stake: tracked.stake,
          breakEvenProbability: tracked.breakEvenProbability,
          expectedValue: tracked.expectedValue,
          decision: result.action,
          reasonCodes: result.reasonCodes,
          reasons: result.reasons,
          traded: false,
          passedRiskChecks: plan.risk.allowed,
          contractId: null,
        });
        setRecords((current) => pruneRecords([...current, record], RECORD_LIMIT));
      }

      let executed = false;
      // Only live mode can produce an executable intent, and every intent
      // becomes a real Deriv order on the authorized demo or real account.
      if (result.intent && currentMode === 'live') {
        executed = await executeLiveEntry(result.intent);
      }
      if (!mountedRef.current) return;

      setCycleLog((current) => [{
        decisionId,
        cycleAt: result.cycleAt,
        durationMs: Date.now() - startedAt,
        action: result.action,
        actionLabel: result.actionLabel,
        mode: currentMode,
        symbol,
        reasonCodes: result.reasonCodes,
        reasons: result.reasons,
        contract: tracked?.winningCondition ?? null,
        stake: result.intent?.stake ?? tracked?.stake ?? null,
        expectedValue: tracked?.expectedValue ?? null,
        probability: tracked?.estimatedProbability ?? null,
        breakEvenProbability: tracked?.breakEvenProbability ?? null,
        executed,
        error: null,
      }, ...current].slice(0, HISTORY_LIMIT));
      setCycleError('');
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : 'The decision cycle failed.';
      setCycleError(message);
      setCycleLog((current) => [{
        decisionId,
        cycleAt: startedAt,
        durationMs: Date.now() - startedAt,
        action: 'BLOCKED' as const,
        actionLabel: 'Cycle error',
        mode: modeRef.current,
        symbol,
        reasonCodes: ['STATISTICAL_FALLBACK'],
        reasons: [message],
        contract: null,
        stake: null,
        expectedValue: null,
        probability: null,
        breakEvenProbability: null,
        executed: false,
        error: message,
      }, ...current].slice(0, HISTORY_LIMIT));
      if (executionRef.current.inFlight) {
        executionRef.current = abandonInFlight(executionRef.current, message, Date.now());
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCycleRunning(false);
      if (pendingCycleRef.current) {
        pendingCycleRef.current = false;
        // Unforced: the spacing floor still keeps a slow cycle from looping.
        void runCycleRef.current();
      }
    }
  }, [executeLiveEntry, feed.contracts, feed.fresh, feed.selectedMarket?.precision, feed.selectedSymbol, feed.serverClockOffsetMs, feed.status, trading]);

  runCycleRef.current = runCycle;

  // ---- live ticks into the rolling buffer ------------------------------------
  useEffect(() => {
    if (!feed.ticks.length) return;
    let added = false;
    for (const observation of feed.ticks) {
      const result = bufferRef.current.add(observation, Date.now());
      added = added || result.added;
    }
    if (added && mountedRef.current) {
      setTickCount(bufferRef.current.list(feed.selectedSymbol).length);
      forceTick((value) => value + 1);
    }
  }, [feed.ticks, feed.selectedSymbol]);

  useEffect(() => {
    bufferRef.current.reset();
    setContracts([...executionRef.current.contracts]);
    setDataQuality(null);
    setDigits(null);
    setTickCount(0);
  }, [feed.selectedSymbol]);

  // ---- account mapping -------------------------------------------------------
  useEffect(() => {
    const currency = trading.currency || trading.activeAccount?.currency || '';
    setAccount((current) => rollTradingDay({
      ...current,
      accountId: trading.activeAccount?.accountId ?? null,
      accountType: trading.activeAccount?.accountType ?? null,
      currency: currency || current.currency,
    }, Date.now()));
  }, [trading.activeAccount, trading.currency]);

  useEffect(() => {
    const reported = trading.balance;
    if (reported === null) return;
    setAccount((current) => {
      const reconciliation = reconcileBalance(current, reported, { now: Date.now() });
      if (reconciliation.unexplained) {
        setSafety((state) => registerAutoPause(state, `Balance check: ${reconciliation.note}`, modeRef.current));
      } else {
        setSafety((state) => clearAutoPause(state, (reason) => reason.startsWith('Balance check:'), modeRef.current));
      }
      return reconciliation.account;
    });
  }, [trading.balance]);

  // ---- connection and authorization interlocks -------------------------------
  useEffect(() => {
    const tradingDown = trading.status !== 'connected';
    const feedDown = feed.status === 'error' || feed.status === 'reconnecting';
    const unauthorized = trading.activeAccount === null;
    setSafety((current) => {
      let next = current;
      if (tradingDown) next = registerAutoPause(next, 'The authenticated Deriv trading connection is not open.', modeRef.current);
      else next = clearAutoPause(next, (reason) => reason.startsWith('The authenticated Deriv'), modeRef.current);
      if (feedDown) next = registerAutoPause(next, 'The public market-data feed is reconnecting; new trades are paused until ticks resume.', modeRef.current);
      else next = clearAutoPause(next, (reason) => reason.startsWith('The public market-data feed'), modeRef.current);
      if (unauthorized) next = registerAutoPause(next, 'No Deriv account is authorized for trading.', modeRef.current);
      else next = clearAutoPause(next, (reason) => reason.startsWith('No Deriv account'), modeRef.current);
      return next;
    });
  }, [trading.status, trading.activeAccount, feed.status]);

  // ---- contract monitoring and settlement reconciliation ---------------------
  useEffect(() => {
    if (!trading.openPositions.length && !trading.closedPositions.length) return;
    const now = Date.now();
    const pipSize = feed.selectedMarket?.pipSize ?? null;
    let settled = false;
    for (const position of trading.openPositions) {
      const update = applyContractUpdate(executionRef.current, position, { now, pipSize, mode: modeRef.current });
      executionRef.current = update.state;
      if (update.settled && update.contract) {
        settled = true;
        creditSettlement(update.settled, now);
      }
    }
    for (const closed of trading.closedPositions) {
      const existing = executionRef.current.contracts.find((contract) => contract.contractId === closed.contractId);
      if (!existing || existing.settledProfit !== null || closed.profit === null) continue;
      settled = true;
      executionRef.current = {
        ...executionRef.current,
        contracts: executionRef.current.contracts.map((contract) => (contract.contractId === closed.contractId
          ? { ...contract, isSold: true, status: 'sold', profit: closed.profit, settledProfit: closed.profit, settledAt: closed.sellTime ? closed.sellTime * 1_000 : now }
          : contract)),
      };
      creditSettlement({ contractId: closed.contractId, stake: existing.stake, profit: closed.profit, symbol: closed.symbol, exitDigit: existing.exitDigit }, closed.sellTime ? closed.sellTime * 1_000 : now);
    }

    const reconciliation = reconcileWithPortfolio(executionRef.current, trading.openPositions, { now, mode: modeRef.current });
    executionRef.current = reconciliation.state;
    if (reconciliation.resolved) {
      setOutcomes((current) => [reconciliation.resolved!, ...current].slice(0, HISTORY_LIMIT));
      setSafety((current) => clearAutoPause(current, (reason) => reason.startsWith('A purchase request may have reached Deriv'), modeRef.current));
    }
    setContracts([...reconciliation.state.contracts]);

    if (settled) {
      for (const contract of executionRef.current.contracts) {
        if (!contract.isSold || contract.settledProfit === null || contract.exitDigit === null) continue;
        setRecords((current) => current.map((record) => (record.contractId === contract.contractId && !record.resolved
          ? { ...record, resolved: true, outcomeDigit: contract.exitDigit, won: contract.settledProfit! > 0, realizedProfit: contract.settledProfit, realizedAt: contract.settledAt }
          : record)));
      }
    }
  }, [trading.openPositions, trading.closedPositions, feed.selectedMarket?.pipSize, creditSettlement]);

  // ---- resolve predictions that never became trades --------------------------
  useEffect(() => {
    const ticks = bufferRef.current.list();
    if (ticks.length < 2) return;
    setRecords((current) => {
      const pending = current.filter((record) => !record.traded && !record.resolved);
      if (!pending.length) return current;
      const { records: resolvedRows, resolved } = resolvePendingPredictions(pending, ticks, configRef.current.durationTicks);
      if (!resolved.length) return current;
      const byId = new Map(resolvedRows.map((record) => [record.id, record]));
      return current.map((record) => byId.get(record.id) ?? record);
    });
  }, [feed.ticks]);

  // ---- cycle scheduler -------------------------------------------------------
  // Tick-driven, with the configured interval as the watchdog for a quiet feed.
  useBotCycleTrigger({
    enabled: safety.runState === 'running',
    tickEpoch: feed.ticks.at(-1)?.epoch ?? null,
    watchdogMs: riskConfig.decisionIntervalMs,
    run: () => { void runCycleRef.current(); },
  });

  // ---- controls --------------------------------------------------------------
  const start = useCallback(() => {
    const now = Date.now();
    // Written to the ref as well as to state: the forced first cycle below reads
    // the ref, and a session that only exists in the next render would make it
    // return before evaluating anything.
    const started = beginSession(rollTradingDay(accountRef.current, now), now);
    accountRef.current = started;
    setAccount(started);
    setSafety((current) => startBot(current, modeRef.current));
    lastCycleRef.current = 0;
    // Forced so the first cycle runs with the state Start just committed; an
    // unforced call would see the stale safety ref and do nothing.
    void runCycleRef.current({ force: true });
  }, []);

  const pause = useCallback(() => setSafety((current) => pauseBot(current, modeRef.current)), []);
  const resume = useCallback(() => setSafety((current) => resumeBot(current, modeRef.current)), []);
  const stop = useCallback(() => {
    // Stopping blocks new purchases. Contracts Deriv already accepted keep
    // being monitored and are never reported as cancelled.
    setSafety((current) => stopBot(current, modeRef.current, { now: Date.now(), by: 'user' }));
  }, []);

  const setSelectionMode = useCallback((next: SelectionMode) => setSelectionModeState(next), []);
  const setManualFamily = useCallback((next: ContractFamily) => setManualFamilyState(next), []);

  const setMode = useCallback((next: BotMode) => {
    setModeState(next);
    setSafety((current) => stopBot(current, next, { now: Date.now(), by: 'user' }));
  }, []);

  const updateRiskConfig = useCallback((patch: Partial<BotRiskConfig>) => {
    setRiskConfig((current) => sanitizeRiskConfig({ ...current, ...patch }));
  }, []);

  const metrics = useMemo(() => summarizePerformance(records.filter((record) => record.mode === 'live')), [records]);
  const analysisMetrics = useMemo(() => summarizePerformance(records.filter((record) => record.mode === 'analysis')), [records]);
  const walkForward = useMemo(() => (records.filter((record) => record.mode !== 'analysis').length >= 20 ? walkForwardReport(records.filter((record) => record.mode !== 'analysis')) : null), [records]);
  const hasMixedDatasets = useMemo(() => separateByMode(records).requiresLabel, [records]);
  // Tick expiries Deriv actually reports for this symbol's digit contracts.
  const supportedTickExpiries = useMemo(() => {
    const types = ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH'];
    const values = new Set<number>();
    for (const type of types) for (const ticks of supportedTradeTicks(feed.contracts, type)) values.add(ticks);
    return [...values].sort((left, right) => left - right);
  }, [feed.contracts]);

  const latestTick = bufferRef.current.latest(feed.selectedSymbol) ?? null;

  return useMemo<DigitBotController>(() => ({
    mode,
    setMode,
    selectionMode,
    setSelectionMode,
    manualFamily,
    setManualFamily,
    runState: safety.runState,
    riskConfig,
    updateRiskConfig,
    start,
    pause,
    resume,
    stop,
    symbol: feed.selectedSymbol,
    selectSymbol: feed.setSelectedSymbol,
    symbols: feed.symbols,
    marketName: feed.selectedMarket?.name ?? '',
    supportedTickExpiries,
    contractSupportLoaded: feed.contractsLoaded,
    quote: latestTick?.quote ?? null,
    precision: feed.selectedMarket?.precision ?? null,
    lastDigit: latestTick?.digit ?? null,
    tickCount,
    dataQuality,
    digits,
    decision,
    cycleLog,
    cycleRunning,
    cycleError,
    lastCycleAt,
    candidates,
    risk,
    account,
    contracts,
    outcomes,
    safety,
    metrics,
    analysisMetrics,
    walkForward,
    hasMixedDatasets,
    accountType: trading.activeAccount?.accountType ?? null,
    accountCurrency: trading.currency || trading.activeAccount?.currency || '',
    connected: trading.status === 'connected',
    feedStatus: feed.status,
    feedFresh: feed.fresh,
    entriesRemaining: entriesRemaining(riskConfig, account),
    sessionMinutesRemaining: sessionMinutesRemaining(riskConfig, account, Date.now()),
    records,
  }), [
    account, analysisMetrics, candidates, cycleError, cycleLog, cycleRunning, dataQuality, decision, digits,
    feed.selectedMarket?.name, feed.selectedSymbol, feed.status, feed.fresh, hasMixedDatasets,
    lastCycleAt, latestTick?.digit, latestTick?.quote, metrics, mode, outcomes, pause, records,
    resume, risk, riskConfig, safety, selectionMode, manualFamily, setManualFamily, setMode,
    setSelectionMode, start, stop, tickCount, trading, updateRiskConfig, walkForward, contracts,
    supportedTickExpiries, feed.symbols, feed.setSelectedSymbol, feed.contractsLoaded,
  ]);
}
