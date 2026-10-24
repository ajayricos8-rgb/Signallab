// Shared contracts for the AI Digit Intelligence & Autonomous Trading Engine.
//
// Every engine in this folder returns a structured `EngineFinding` so the
// dashboard, the decision log and the automated tests can all read the same
// object. Numbers in these structures always originate from measured real
// ticks or from a Deriv proposal; nothing here is a placeholder value.
import type { DigitObservation } from '../digit-analysis.ts';

/** The fourteen coordinated engines described in the project specification. */
export type EngineId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N';

export const ENGINE_NAMES: Record<EngineId, string> = {
  A: 'Live data engine',
  B: 'Digit intelligence engine',
  C: 'Statistical analysis engine',
  D: 'Pattern recognition engine',
  E: 'Probability estimation engine',
  F: 'AI decision engine',
  G: 'Contract and barrier selection engine',
  H: 'Payout and expectancy engine',
  I: 'Trade validation engine',
  J: 'Risk management engine',
  K: 'Execution engine',
  L: 'Live contract monitoring engine',
  M: 'Performance and learning engine',
  N: 'Safety engine',
};

export type EngineStatus = 'ok' | 'degraded' | 'blocked';

/** Structured output shared by every engine. */
export type EngineFinding<T> = {
  engine: EngineId;
  name: string;
  status: EngineStatus;
  /** 0–1 assessment of the input reliability for this engine. */
  dataQuality: number;
  /** 0–1 confidence where the engine makes an estimate; null when it does not. */
  confidence: number | null;
  findings: T;
  reasons: string[];
};

/** A real Deriv tick plus the local receive time used for freshness checks. */
export type BotTick = DigitObservation & { receivedAt: number };

export type ContractFamily = 'even-odd' | 'over-under' | 'matches';

export type BotContractType = 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH';

export const FAMILY_OF_CONTRACT: Record<BotContractType, ContractFamily> = {
  DIGITEVEN: 'even-odd',
  DIGITODD: 'even-odd',
  DIGITOVER: 'over-under',
  DIGITUNDER: 'over-under',
  DIGITMATCH: 'matches',
};

export const CONTRACT_LABELS: Record<BotContractType, string> = {
  DIGITEVEN: 'Even',
  DIGITODD: 'Odd',
  DIGITOVER: 'Over',
  DIGITUNDER: 'Under',
  DIGITMATCH: 'Matches',
};

/**
 * Independent checks kept as machine-readable codes so the decision log can
 * explain exactly why an opportunity was taken or rejected.
 */
export type ReasonCode =
  | 'DATA_VALID'
  | 'DATA_STALE'
  | 'DATA_INSUFFICIENT'
  | 'PRECISION_UNVERIFIED'
  | 'CONTRACT_UNSUPPORTED'
  | 'MODEL_VALIDATED'
  | 'MODEL_UNVALIDATED'
  | 'BETTING_AGAINST_RANDOM'
  | 'EXPECTED_VALUE_POSITIVE'
  | 'EXPECTED_VALUE_NEGATIVE'
  | 'UNCERTAINTY_TOO_WIDE'
  | 'PROBABILITY_BELOW_BREAK_EVEN'
  | 'PAYOUT_ACCEPTABLE'
  | 'PAYOUT_MISSING'
  | 'PAYOUT_UNFAVOURABLE'
  | 'PROPOSAL_MISMATCH'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_INVALID'
  | 'RISK_LIMITS_PASSED'
  | 'STAKE_BELOW_MINIMUM'
  | 'STAKE_ABOVE_MAXIMUM'
  | 'DAILY_LOSS_LIMIT'
  | 'SESSION_LOSS_LIMIT'
  | 'CONSECUTIVE_LOSS_LIMIT'
  | 'DAILY_TRADE_LIMIT'
  | 'SESSION_TRADE_LIMIT'
  | 'SYMBOL_TRADE_LIMIT'
  | 'OPEN_CONTRACT_LIMIT'
  | 'COOLDOWN_ACTIVE'
  | 'MIN_TICKS_BETWEEN_ENTRIES'
  | 'SESSION_DURATION_LIMIT'
  | 'ACCOUNT_UNAVAILABLE'
  | 'BALANCE_DISCREPANCY'
  | 'ACCOUNT_UNAUTHORIZED'
  | 'MANUAL_PAUSE'
  | 'CONNECTION_INTERRUPTED'
  | 'DUPLICATE_DECISION'
  | 'DUPLICATE_PURCHASE_BLOCKED'
  | 'ACTIVE_CONTRACT'
  | 'MODE_NOT_EXECUTABLE'
  | 'LIVE_TRADING_NOT_ACTIVATED'
  | 'PURCHASE_UNRECONCILED'
  | 'AI_DECISION_REJECTED'
  | 'STATISTICAL_FALLBACK'
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'TRADE_APPROVED';

/**
 * The bot only ever operates in `analysis` (predicts, never orders) or `live`
 * (sends real purchases to the authorized Deriv demo or real account). There
 * is no simulated execution mode: every position the bot opens is a live one.
 */
export type BotMode = 'analysis' | 'live';
export type BotRunState = 'idle' | 'running' | 'paused' | 'stopped';

export type StakeMode = 'fixed' | 'percent';

export type BotRiskConfig = {
  stakeMode: StakeMode;
  /** Fixed stake in account currency, used in `fixed` mode. */
  fixedStake: number;
  /** Percentage of the current balance used in `percent` mode. */
  percentOfBalance: number;
  minStake: number;
  maxStake: number;
  /** Hard ceiling on any single stake as a share of the live balance. */
  maxStakeShareOfBalance: number;
  maxDailyLoss: number;
  maxSessionLoss: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  maxEntriesPerSession: number;
  maxTradesPerSymbol: number;
  maxOpenContracts: number;
  minTicksBetweenEntries: number;
  cooldownAfterContractMs: number;
  maxSessionMinutes: number;
  /** Required margin of the probability lower bound over the break-even rate. */
  minProbabilityEdge: number;
  /** Minimum effective sample size before a model may qualify for execution. */
  minEffectiveSample: number;
  /** Analysis windows, in ticks, recalculated on every cycle. */
  analysisWindows: number[];
  /** Tick expiry used for proposals. */
  durationTicks: number;
  /** How often the decision cycle may run. */
  decisionIntervalMs: number;
  /** Longest accepted age of the newest tick, in milliseconds. */
  maxTickAgeMs: number;
};

export function defaultRiskConfig(): BotRiskConfig {
  return {
    stakeMode: 'fixed',
    fixedStake: 0.35,
    percentOfBalance: 0.5,
    minStake: 0.35,
    maxStake: 5,
    maxStakeShareOfBalance: 2,
    maxDailyLoss: 10,
    maxSessionLoss: 5,
    maxConsecutiveLosses: 3,
    maxDailyTrades: 40,
    maxEntriesPerSession: 20,
    maxTradesPerSymbol: 12,
    maxOpenContracts: 1,
    minTicksBetweenEntries: 1,
    cooldownAfterContractMs: 1_000,
    maxSessionMinutes: 120,
    minProbabilityEdge: 0.01,
    minEffectiveSample: 500,
    analysisWindows: [25, 50, 100, 250, 500, 1_000],
    durationTicks: 1,
    decisionIntervalMs: 500,
    maxTickAgeMs: 15_000,
  };
}

/** Authoritative accounting. `null` means "unknown", never "zero". */
export type BotAccountState = {
  accountId: string | null;
  accountType: 'demo' | 'real' | null;
  currency: string;
  initialBalance: number | null;
  currentBalance: number | null;
  totalStaked: number;
  realizedPnl: number;
  openExposure: number;
  sessionPnl: number;
  dailyPnl: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  longestLosingStreak: number;
  tradesToday: number;
  tradesThisSession: number;
  tradesBySymbol: Record<string, number>;
  peakEquity: number | null;
  maxDrawdown: number;
  sessionStartedAt: number | null;
  dayKey: string | null;
  lastEntryTickCount: number | null;
  lastSettlementAt: number | null;
  /** Signed difference between the locally derived balance and Deriv's. */
  balanceDiscrepancy: number | null;
  lastReconciledAt: number | null;
  /**
   * Settled profit already applied locally but not yet reflected in an
   * authoritative balance reading. Used to reconcile without guessing.
   */
  expectedBalanceDelta: number;
};

export function createAccountState(): BotAccountState {
  return {
    accountId: null,
    accountType: null,
    currency: '',
    initialBalance: null,
    currentBalance: null,
    totalStaked: 0,
    realizedPnl: 0,
    openExposure: 0,
    sessionPnl: 0,
    dailyPnl: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    longestLosingStreak: 0,
    tradesToday: 0,
    tradesThisSession: 0,
    tradesBySymbol: {},
    peakEquity: null,
    maxDrawdown: 0,
    sessionStartedAt: null,
    dayKey: null,
    lastEntryTickCount: null,
    lastSettlementAt: null,
    balanceDiscrepancy: null,
    lastReconciledAt: null,
    expectedBalanceDelta: 0,
  };
}

export type DataQualityFinding = {
  status: 'live' | 'stale' | 'interrupted' | 'insufficient';
  fresh: boolean;
  tickCount: number;
  validTickCount: number;
  duplicatesDropped: number;
  gapsDetected: number;
  precisionVerified: boolean;
  requestedPrecision: number | null;
  lastTickEpoch: number | null;
  lastTickAt: number | null;
  sourceAgeMs: number | null;
  receiveAgeMs: number | null;
  /** Largest observed spacing between consecutive ticks, in ms. */
  maxGapMs: number | null;
  quality: number;
};

export type DigitWindowFinding = {
  window: number;
  sample: number;
  counts: number[];
  frequencies: Array<number | null>;
  /** Posterior mean probabilities under a Dirichlet-multinomial model. */
  posterior: number[];
  baselineDeviation: number[];
  evenRate: number | null;
  oddRate: number | null;
  entropyBits: number | null;
  normalizedEntropy: number | null;
  chiSquare: number | null;
  chiSquarePValue: number | null;
  gapsSinceAppearance: Array<number | null>;
};

export type TransitionFinding = {
  counts: number[][];
  probabilities: number[][];
  sample: number;
  /** Transition row for the newest digit, already smoothed. */
  currentRow: number[] | null;
  currentRowSample: number;
  pairCounts: Record<string, number>;
  pairProbabilities: number[];
  pairSample: number;
};

export type StreakFinding = {
  currentDigitRun: number;
  longestDigitRun: number;
  currentParityRun: number;
  longestParityRun: number;
  currentEvenStreak: number;
  currentOddStreak: number;
  barrierStreaks: Array<{ barrier: number; side: 'over' | 'under' | 'equal'; length: number }>;
};

export type DigitIntelligenceFindings = {
  symbol: string;
  sampleSize: number;
  windows: DigitWindowFinding[];
  lastDigit: number | null;
  lastQuote: number | null;
  transitions: TransitionFinding;
  streaks: StreakFinding;
  recency: {
    gaps: Array<number | null>;
    recentVsLongTerm: number[];
    ewma: number[];
  };
  parityCounts: [number, number];
  distribution: {
    chiSquare: number | null;
    chiSquarePValue: number | null;
    degreesOfFreedom: number;
    criticalValue: number;
    significantAt95: boolean;
    uniformDivergenceBits: number;
    maxDeviationPoints: number;
  };
  entropyBits: number | null;
  normalizedEntropy: number | null;
  /** Explicit reminders that observed frequency is not a forecast. */
  notes: string[];
};

export type ModelEvidence = {
  key: string;
  label: string;
  kind: 'statistical' | 'ml' | 'pattern';
  /** Probabilities for the next digit, or null when the model abstained. */
  probabilities: number[] | null;
  support: number;
  trainingSample: number;
  tuningSample: number;
  tuningBrier: number | null;
  tuningLogLoss: number | null;
  tuningCalibrationError: number | null;
  validationSample: number;
  validationBrier: number | null;
  validationLogLoss: number | null;
  validationCalibrationError: number | null;
  baselineBrier: number | null;
  skill: number | null;
  improvementLower: number | null;
  weight: number;
  status: 'contributing' | 'no-skill' | 'sparse';
  note: string;
};

export type EnsembleFinding = {
  symbol: string;
  probabilities: number[];
  baselineProbabilities: number[];
  baselineWeight: number;
  agreement: number;
  dispersion: number;
  supportingModels: number;
  horizon: number;
  valid: boolean;
  validationSkill: number | null;
  validationBrier: number | null;
  baselineBrier: number | null;
  improvementLower: number | null;
  reason: string;
};

export type CandidateRecord = {
  /** Stable key: family + contract type + barrier/target. */
  id: string;
  family: ContractFamily;
  contractType: BotContractType;
  symbol: string;
  barrier: number | null;
  targetDigit: number | null;
  winningCondition: string;
  estimatedProbability: number;
  probabilityLowerBound: number;
  probabilityUpperBound: number;
  uncertainty: number;
  effectiveSample: number;
  payout: number | null;
  stake: number | null;
  netProfitIfWon: number | null;
  netLossIfLost: number | null;
  breakEvenProbability: number | null;
  expectedValue: number | null;
  conservativeExpectedValue: number | null;
  returnOnStake: number | null;
  dataQuality: number;
  modelValidated: boolean;
  riskValidated: boolean;
  proposalVerified: boolean;
  eligible: boolean;
  rejectionReasons: string[];
  reasonCodes: ReasonCode[];
  score: number;
};

export type RiskEvaluation = {
  allowed: boolean;
  stake: number | null;
  maxPossibleLoss: number;
  projectedDailyLoss: number;
  projectedSessionLoss: number;
  violations: string[];
  reasonCodes: ReasonCode[];
  limits: {
    dailyLoss: number;
    sessionLoss: number;
    consecutiveLosses: number;
    dailyTrades: number;
    sessionTrades: number;
    symbolTrades: number;
    openContracts: number;
  };
  notes: string[];
};

export type SafetyState = {
  runState: BotRunState;
  manualPause: boolean;
  autoPauseReasons: string[];
  reasonCodes: ReasonCode[];
  canPurchase: boolean;
  lastStopAt: number | null;
  lastStopBy: 'user' | 'system' | null;
};

export type TradeIntent = {
  decisionId: string;
  family: ContractFamily;
  contractType: BotContractType;
  symbol: string;
  stake: number;
  duration: number;
  durationUnit: 't';
  barrier: string | null;
  barrierDigit: number | null;
  currency: string;
  mode: BotMode;
  createdAt: number;
  reasonCodes: ReasonCode[];
};

export type PurchaseOutcome = {
  status: 'confirmed' | 'rejected' | 'timeout' | 'unreconciled';
  decisionId: string;
  contractId: number | null;
  buyPrice: number | null;
  payout: number | null;
  balanceAfter: number | null;
  message: string;
  at: number;
};

export type MonitoredContract = {
  contractId: number;
  decisionId: string | null;
  contractType: string | null;
  symbol: string | null;
  currency: string | null;
  buyPrice: number | null;
  payout: number | null;
  stake: number | null;
  barrierDigit: number | null;
  entrySpot: number | null;
  exitSpot: number | null;
  currentSpot: number | null;
  entryDigit: number | null;
  exitDigit: number | null;
  profit: number | null;
  status: string | null;
  purchaseTime: number | null;
  expiryTime: number | null;
  isSold: boolean;
  lastUpdateAt: number;
  /** Deriv's authoritative settlement result once the contract is sold. */
  settledProfit: number | null;
  settledAt: number | null;
  mode: BotMode;
};

export type AiDecisionSummary = {
  source: 'statistical-fallback' | 'external-model';
  action: 'TRADE' | 'NO_TRADE';
  reasonCodes: ReasonCode[];
  reasons: string[];
  /** Set when an external model answered but its numbers failed validation. */
  rejectedExternalReason: string | null;
  providerConfigured: boolean;
  /** True when no account secret was included in any outbound payload. */
  secretsExcluded: boolean;
};

export type DecisionCycleResult = {
  decisionId: string;
  cycleAt: number;
  symbol: string;
  mode: BotMode;
  action: 'TRADE' | 'NO_TRADE' | 'BLOCKED';
  actionLabel: string;
  reasonCodes: ReasonCode[];
  reasons: string[];
  intent: TradeIntent | null;
  candidates: CandidateRecord[];
  selected: CandidateRecord | null;
  risk: RiskEvaluation;
  engines: EngineFinding<unknown>[];
  digits: DigitIntelligenceFindings | null;
  models: ModelEvidence[];
  ensemble: EnsembleFinding | null;
  ai: AiDecisionSummary;
  durationTicks: number;
};

/** Optional external AI hook. It receives measured features only. */
export type AiDecisionProvider = (
  features: Record<string, unknown>,
) => Promise<unknown>;

export type PredictionRecord = {
  id: string;
  at: number;
  mode: BotMode;
  symbol: string;
  currentDigit: number | null;
  window: number | null;
  modelVersions: string[];
  family: ContractFamily;
  contractType: BotContractType;
  barrier: number | null;
  predictedProbability: number;
  probabilityLowerBound: number;
  probabilityUpperBound: number;
  payout: number | null;
  stake: number | null;
  breakEvenProbability: number | null;
  expectedValue: number | null;
  decision: 'TRADE' | 'NO_TRADE' | 'BLOCKED';
  reasonCodes: ReasonCode[];
  reasons: string[];
  traded: boolean;
  passedRiskChecks: boolean;
  contractId: number | null;
  resolved: boolean;
  outcomeDigit: number | null;
  won: boolean | null;
  realizedProfit: number | null;
  realizedAt: number | null;
};

export type SessionSnapshot = {
  mode: BotMode;
  runState: BotRunState;
  currency: string;
  balance: number | null;
  sessionPnl: number;
  dailyPnl: number;
  openExposure: number;
  tradesToday: number;
  tradesThisSession: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  maxDrawdown: number;
  entriesRemaining: number;
  sessionMinutesRemaining: number | null;
};
