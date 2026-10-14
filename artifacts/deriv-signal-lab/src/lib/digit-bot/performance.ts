// ENGINE M — Performance and learning engine.
//
// Records every decision, including the ones that did not trade, and scores the
// probability estimates that were actually made. Live results and analysis
// analysis-only records are stored and reported separately; they are never
// merged into a single "result" without an explicit label.
import { clamp, mean, sum } from '../over-under/math.ts';
import type { DigitObservation } from '../digit-analysis.ts';
import type { BotContractType, BotMode, ContractFamily, PredictionRecord, ReasonCode } from './types.ts';
import { calibrationReport, logLossScore } from './statistics.ts';

export type PredictionDraft = {
  id: string;
  at: number;
  mode: BotMode;
  symbol: string;
  currentDigit: number | null;
  window: number | null;
  modelVersions: string[];
  contractType: BotContractType;
  family: ContractFamily;
  barrier: number | null;
  predictedProbability: number;
  probabilityLowerBound: number;
  probabilityUpperBound: number;
  payout: number | null;
  stake: number | null;
  breakEvenProbability: number | null;
  expectedValue: number | null;
  decision: PredictionRecord['decision'];
  reasonCodes: ReasonCode[];
  reasons: string[];
  traded: boolean;
  passedRiskChecks: boolean;
  contractId: number | null;
};

export function createPredictionRecord(draft: PredictionDraft): PredictionRecord {
  return {
    ...draft,
    resolved: false,
    outcomeDigit: null,
    won: null,
    realizedProfit: null,
    realizedAt: null,
  };
}

/** True when the recorded contract wins on the observed final digit. */
export function contractWins(contractType: BotContractType, barrier: number | null, digit: number): boolean {
  switch (contractType) {
    case 'DIGITEVEN':
      return digit % 2 === 0;
    case 'DIGITODD':
      return digit % 2 === 1;
    case 'DIGITOVER':
      return barrier !== null && digit > barrier;
    case 'DIGITUNDER':
      return barrier !== null && digit < barrier;
    case 'DIGITMATCH':
      return barrier !== null && digit === barrier;
    default:
      return false;
  }
}

export function resolvePrediction(
  record: PredictionRecord,
  resolution: { outcomeDigit: number; profit: number | null; at: number },
): PredictionRecord {
  return {
    ...record,
    resolved: true,
    outcomeDigit: resolution.outcomeDigit,
    won: contractWins(record.contractType, record.barrier, resolution.outcomeDigit),
    realizedProfit: resolution.profit,
    realizedAt: resolution.at,
  };
}

export type PredictionResolution = { record: PredictionRecord; profit: number | null };

/**
 * Resolves predictions that never became trades.
 *
 * A prediction is only scored against a digit that genuinely appeared in the
 * live tick stream at the entry epoch plus the configured duration; if that
 * tick does not exist the record stays pending. This is what keeps the
 * calibration and Brier reporting honest.
 */
export function resolvePendingPredictions(
  records: readonly PredictionRecord[],
  ticks: readonly DigitObservation[],
  durationTicks: number,
): { records: PredictionRecord[]; resolved: PredictionResolution[] } {
  if (!ticks.length) return { records: [...records], resolved: [] };
  const resolved: PredictionResolution[] = [];
  const next = records.map((record) => {
    if (record.resolved) return record;
    const entryIndex = ticks.findIndex((tick) => tick.epoch * 1_000 >= record.at);
    if (entryIndex < 0) return record;
    const settlementIndex = entryIndex + durationTicks;
    if (settlementIndex >= ticks.length) return record;
    const settlement = ticks[settlementIndex];
    const updated = resolvePrediction(record, {
      outcomeDigit: settlement.digit,
      profit: record.realizedProfit,
      at: settlement.epoch * 1_000,
    });
    resolved.push({ record: updated, profit: updated.realizedProfit });
    return updated;
  });
  return { records: next, resolved };
}

export type PerformanceMetrics = {
  sample: number;
  resolved: number;
  traded: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netProfit: number;
  grossStake: number;
  returnOnStake: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  maximumDrawdown: number;
  longestLosingStreak: number;
  averageExpectedValue: number | null;
  brier: number | null;
  logLoss: number | null;
  calibrationError: number | null;
  /** Brier score of the baseline (1/10 per digit is not applicable here, so
      the unmodified event probability is used as the reference). */
  baselineBrier: number | null;
  skill: number | null;
};

function emptyMetrics(): PerformanceMetrics {
  return {
    sample: 0,
    resolved: 0,
    traded: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    netProfit: 0,
    grossStake: 0,
    returnOnStake: null,
    averageWin: null,
    averageLoss: null,
    maximumDrawdown: 0,
    longestLosingStreak: 0,
    averageExpectedValue: null,
    brier: null,
    logLoss: null,
    calibrationError: null,
    baselineBrier: null,
    skill: null,
  };
}

export function summarizePerformance(records: readonly PredictionRecord[]): PerformanceMetrics {
  const metrics = emptyMetrics();
  metrics.sample = records.length;
  const scored = records.filter((record) => record.resolved && record.won !== null);
  metrics.resolved = scored.length;
  metrics.traded = records.filter((record) => record.traded).length;
  if (!scored.length) return metrics;

  const predictions = scored.map((record) => clamp(record.predictedProbability, 1e-9, 1 - 1e-9));
  const outcomes = scored.map((record) => record.won === true);
  metrics.brier = mean(predictions.map((probability, index) => (probability - Number(outcomes[index])) ** 2));
  metrics.logLoss = mean(predictions.map((probability, index) => logLossScore([1 - probability, probability], outcomes[index] ? 1 : 0)));
  metrics.calibrationError = calibrationReport(predictions, outcomes).expectedCalibrationError;
  const baseline = clamp(mean(outcomes.map((outcome) => (outcome ? 1 : 0))), 1e-9, 1 - 1e-9);
  metrics.baselineBrier = mean(outcomes.map((outcome) => (baseline - Number(outcome)) ** 2));
  metrics.skill = metrics.baselineBrier > 1e-9 ? 1 - (metrics.brier ?? 0) / metrics.baselineBrier : null;

  const traded = scored.filter((record) => record.traded);
  metrics.wins = traded.filter((record) => record.realizedProfit !== null && record.realizedProfit > 0).length;
  metrics.losses = traded.filter((record) => record.realizedProfit !== null && record.realizedProfit <= 0).length;
  const settledTrades = traded.filter((record) => record.realizedProfit !== null);
  metrics.winRate = settledTrades.length ? metrics.wins / settledTrades.length : null;
  metrics.netProfit = sum(settledTrades.map((record) => record.realizedProfit ?? 0));
  metrics.grossStake = sum(settledTrades.map((record) => record.stake ?? 0));
  metrics.returnOnStake = metrics.grossStake > 0 ? metrics.netProfit / metrics.grossStake : null;
  const wins = settledTrades.filter((record) => (record.realizedProfit ?? 0) > 0).map((record) => record.realizedProfit!);
  const losses = settledTrades.filter((record) => (record.realizedProfit ?? 0) <= 0).map((record) => record.realizedProfit!);
  metrics.averageWin = wins.length ? mean(wins) : null;
  metrics.averageLoss = losses.length ? mean(losses) : null;

  const ordered = [...settledTrades].sort((left, right) => (left.realizedAt ?? left.at) - (right.realizedAt ?? right.at));
  let equity = 0;
  let peak = 0;
  let streak = 0;
  for (const record of ordered) {
    equity += record.realizedProfit ?? 0;
    peak = Math.max(peak, equity);
    metrics.maximumDrawdown = Math.max(metrics.maximumDrawdown, peak - equity);
    streak = (record.realizedProfit ?? 0) > 0 ? 0 : streak + 1;
    metrics.longestLosingStreak = Math.max(metrics.longestLosingStreak, streak);
  }
  const expectedValues = records.map((record) => record.expectedValue).filter((value): value is number => value !== null && Number.isFinite(value));
  metrics.averageExpectedValue = expectedValues.length ? mean(expectedValues) : null;
  return metrics;
}

export type GroupedMetrics = { key: string; label: string; metrics: PerformanceMetrics };

export function groupPerformance(records: readonly PredictionRecord[], keyOf: (record: PredictionRecord) => string): GroupedMetrics[] {
  const groups = new Map<string, PredictionRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, label: key, metrics: summarizePerformance(rows) }))
    .sort((left, right) => right.metrics.sample - left.metrics.sample || left.key.localeCompare(right.key));
}

export function performanceBySymbol(records: readonly PredictionRecord[]): GroupedMetrics[] {
  return groupPerformance(records, (record) => record.symbol);
}

export function performanceByFamily(records: readonly PredictionRecord[]): GroupedMetrics[] {
  return groupPerformance(records, (record) => record.family);
}

export function performanceByContract(records: readonly PredictionRecord[]): GroupedMetrics[] {
  return groupPerformance(records, (record) => (record.barrier === null ? record.contractType : `${record.contractType} ${record.barrier}`));
}

export function performanceByWindow(records: readonly PredictionRecord[]): GroupedMetrics[] {
  return groupPerformance(records, (record) => (record.window === null ? 'window unknown' : `${record.window} ticks`));
}

export function performanceByModelSet(records: readonly PredictionRecord[]): GroupedMetrics[] {
  return groupPerformance(records, (record) => (record.modelVersions.length ? record.modelVersions.join('+') : 'no models'));
}

export type ModeSeparation = {
  live: PredictionRecord[];
  analysis: PredictionRecord[];
  /** True when at least two datasets exist and must be labelled separately. */
  requiresLabel: boolean;
};

/** Splits records by operating mode so live results are never mixed in. */
export function separateByMode(records: readonly PredictionRecord[]): ModeSeparation {
  const live = records.filter((record) => record.mode === 'live');
  const analysis = records.filter((record) => record.mode === 'analysis');
  return { live, analysis, requiresLabel: [live, analysis].filter((rows) => rows.length > 0).length > 1 };
}

export type WalkForwardReport = {
  firstHalf: PerformanceMetrics;
  secondHalf: PerformanceMetrics;
  splitAt: number | null;
  note: string;
};

/**
 * Time-ordered walk-forward report. Records are split chronologically rather
 * than randomly, so a model cannot be credited for information it would not
 * have had at the time.
 */
export function walkForwardReport(records: readonly PredictionRecord[]): WalkForwardReport {
  const ordered = [...records].sort((left, right) => left.at - right.at);
  if (ordered.length < 20) {
    return {
      firstHalf: summarizePerformance(ordered),
      secondHalf: emptyMetrics(),
      splitAt: null,
      note: 'At least twenty scored predictions are required before a chronological comparison is meaningful.',
    };
  }
  const split = Math.floor(ordered.length / 2);
  return {
    firstHalf: summarizePerformance(ordered.slice(0, split)),
    secondHalf: summarizePerformance(ordered.slice(split)),
    splitAt: ordered[split]?.at ?? null,
    note: 'The two halves are non-overlapping in time. A model is only reported as improving when the later half holds up.',
  };
}

/** Retention helper so long sessions do not grow the log without bound. */
export function pruneRecords(records: readonly PredictionRecord[], limit = 500): PredictionRecord[] {
  if (records.length <= limit) return [...records];
  const settled = records.filter((record) => record.traded);
  const rest = records.filter((record) => !record.traded);
  const keepSettled = settled.slice(-Math.min(settled.length, Math.floor(limit * 0.6)));
  const keepRest = rest.slice(-(limit - keepSettled.length));
  return [...keepSettled, ...keepRest].sort((left, right) => left.at - right.at);
}
