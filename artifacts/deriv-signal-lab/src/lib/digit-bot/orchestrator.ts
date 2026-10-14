// Cycle orchestrator — coordinates engines A–N through one shared,
// timestamped market-state object.
//
// The cycle runs in two phases on purpose:
//   phase one  analyses tick data and produces a bounded shortlist,
//   phase two  applies the real Deriv proposals fetched for that shortlist.
//
// Nothing can qualify for a purchase on estimated payouts: phase two is the
// only place a payout, break-even rate or expected value is attached, and the
// AI/statistical decision, the validation engine and the risk engine all run
// after it.
import type { ProposalSnapshot } from './expectancy.ts';
import { contractEconomics } from './expectancy.ts';
import type { DigitContractSupport } from '../deriv-digit-metadata.ts';
import { evaluateRisk, sanitizeRiskConfig, type RiskEvaluationInput } from './risk.ts';
import { assessDataQuality } from './data-engine.ts';
import { analyzeDigitIntelligence } from './digit-intelligence.ts';
import { effectiveSampleSize } from './statistics.ts';
import {
  buildCandidateDrafts,
  finalizeCandidates,
  rankCandidates,
  selectBestCandidate,
  shortlistForProposals,
  summarizeRejections,
  type CandidateDraft,
} from './candidates.ts';
import { needsRefit, trainModelFamily, type ModelReport } from './models.ts';
import { buildAiFeatureObject, evaluateDecision, statisticalDecision } from './ai-decision.ts';
import { validateTrade } from './validation.ts';
import { safetyFinding } from './safety.ts';
import type {
  BotAccountState,
  BotMode,
  BotRiskConfig,
  BotTick,
  CandidateRecord,
  DataQualityFinding,
  DecisionCycleResult,
  DigitIntelligenceFindings,
  EngineFinding,
  EnsembleFinding,
  ModelEvidence,
  MonitoredContract,
  PurchaseOutcome,
  ReasonCode,
  RiskEvaluation,
  SafetyState,
  TradeIntent,
  AiDecisionProvider,
} from './types.ts';
import { ENGINE_NAMES } from './types.ts';

export type DecisionCycleInput = {
  cycleAt: number;
  decisionId: string;
  symbol: string;
  mode: BotMode;
  ticks: BotTick[];
  duplicatesDropped: number;
  clockOffsetMs: number | null;
  precision: number | null;
  feedFresh: boolean;
  feedStatus: string;
  contractSupport: readonly DigitContractSupport[];
  riskConfig: BotRiskConfig;
  account: BotAccountState;
  safety: SafetyState;
  currency: string;
  activeContracts: readonly MonitoredContract[];
  accountAuthorized: boolean;
  connectionHealthy: boolean;
  unreconciledPurchase: PurchaseOutcome | null;
  aiProvider?: AiDecisionProvider | null;
  /** Pre-computed model report; when omitted the cycle trains one itself. */
  modelReport?: ModelReport | null;
  /** Which contract families the user allowed. */
  allowedFamilies?: readonly ('even-odd' | 'over-under' | 'matches')[];
  /** Hard cap on proposals requested per cycle, for rate-limit awareness. */
  maxProposalRequests?: number;
  /** Keep barriers inside the 1–8 range the research tools use. */
  restrictBarriersToResearchRange?: boolean;
};

export type CyclePlan = {
  decisionId: string;
  cycleAt: number;
  symbol: string;
  mode: BotMode;
  durationTicks: number;
  engines: EngineFinding<unknown>[];
  dataQuality: DataQualityFinding;
  digits: DigitIntelligenceFindings | null;
  models: ModelEvidence[];
  ensemble: EnsembleFinding | null;
  drafts: CandidateDraft[];
  shortlist: CandidateRecord[];
  stake: number | null;
  risk: RiskEvaluation;
  safety: SafetyState;
  effectiveSample: number;
  notes: string[];
  /** True when the cycle cannot produce a trade at all, with the reasons why. */
  blocked: boolean;
  blockReasons: string[];
  blockCodes: ReasonCode[];
  modelReport: ModelReport | null;
  config: BotRiskConfig;
};

function engineFinding<T>(engine: EngineFinding<T>['engine'], status: EngineFinding<T>['status'], dataQuality: number, confidence: number | null, findings: T, reasons: string[]): EngineFinding<T> {
  return { engine, name: ENGINE_NAMES[engine], status, dataQuality, confidence, findings, reasons };
}

/** PHASE ONE — analysis and shortlist, no orders and no network calls. */
export function planCycle(input: DecisionCycleInput): CyclePlan {
  const config = sanitizeRiskConfig(input.riskConfig);
  const durationTicks = config.durationTicks;
  const engines: EngineFinding<unknown>[] = [];
  const notes: string[] = [];
  const blockReasons: string[] = [];
  const blockCodes: ReasonCode[] = [];

  // ENGINE A — live data.
  const dataQuality = assessDataQuality({
    ticks: input.ticks,
    duplicatesDropped: input.duplicatesDropped,
    symbol: input.symbol,
    now: input.cycleAt,
    clockOffsetMs: input.clockOffsetMs,
    maxTickAgeMs: config.maxTickAgeMs,
    precision: input.precision,
    feedFresh: input.feedFresh,
    feedStatus: input.feedStatus,
    connectionHealthy: input.connectionHealthy,
  });
  engines.push(engineFinding('A', dataQuality.fresh ? 'ok' : dataQuality.status === 'insufficient' ? 'degraded' : 'blocked', dataQuality.quality, null, dataQuality, [
    dataQuality.fresh
      ? `${dataQuality.validTickCount} validated live ticks; newest source age ${Math.round(Math.abs(dataQuality.sourceAgeMs ?? 0) / 1_000)}s.`
      : `Tick data is ${dataQuality.status}; new trades stay disabled until the stream recovers.`,
  ]));
  if (!dataQuality.fresh) blockCodes.push(dataQuality.precisionVerified ? 'DATA_STALE' : 'PRECISION_UNVERIFIED');
  if (!dataQuality.precisionVerified) blockReasons.push('Verified decimal precision is unavailable for this symbol, so final digits are not trusted.');

  // ENGINE B — digit intelligence.
  const barriers = Array.from({ length: 8 }, (_, index) => index + 1);
  const digits = input.ticks.length >= 10 ? analyzeDigitIntelligence({ symbol: input.symbol, ticks: input.ticks, windows: config.analysisWindows, barriers }) : null;
  const effectiveSample = effectiveSampleSize(input.ticks.map((tick) => tick.digit));
  engines.push(engineFinding('B', digits ? 'ok' : 'degraded', dataQuality.quality, null, digits, digits
    ? [`${digits.sampleSize} digits analysed across ${digits.windows.filter((window) => window.sample > 0).length} windows; last digit ${digits.lastDigit}.`, ...digits.notes.slice(0, 1)]
    : ['Fewer than ten validated ticks are available, so no digit statistics were produced.']));

  // ENGINES C, D, E — statistical analysis, pattern recognition, probability.
  const existingReport = input.modelReport && !needsRefit(input.modelReport, input.symbol, input.ticks.length, durationTicks) ? input.modelReport : null;
  const modelReport = existingReport ?? (input.ticks.length >= 200
    ? trainModelFamily({ symbol: input.symbol, digits: input.ticks.map((tick) => tick.digit), horizon: durationTicks, now: input.cycleAt })
    : null);
  const models: ModelEvidence[] = modelReport?.models ?? [];
  const ensemble: EnsembleFinding | null = modelReport?.ensemble ?? null;
  engines.push(engineFinding('C', modelReport ? 'ok' : 'degraded', dataQuality.quality, ensemble?.validationSkill ?? null, {
    effectiveSample,
    ensemble: ensemble ? { probabilities: ensemble.probabilities, valid: ensemble.valid } : null,
    windows: digits?.windows.map((window) => ({ window: window.window, sample: window.sample, chiSquarePValue: window.chiSquarePValue })) ?? [],
  }, modelReport
    ? [`Effective sample ${Math.round(effectiveSample)} digits; ensemble validated on ${modelReport.holdoutOrigins} non-overlapping holdout outcomes.`]
    : ['At least 200 validated ticks are required before models are fitted.']));
  if (!ensemble) {
    blockCodes.push('DATA_INSUFFICIENT');
  } else if (!ensemble.valid) {
    blockCodes.push('MODEL_UNVALIDATED');
    blockReasons.push(ensemble.reason);
  }
  engines.push(engineFinding('D', ensemble ? 'ok' : 'blocked', dataQuality.quality, null, { models: models.map((model) => ({ key: model.key, status: model.status, note: model.note })) }, [
    models.length ? `${models.filter((model) => model.status === 'contributing').length} of ${models.length} models contributed weight after tuning.` : 'No pattern model qualified.',
  ]));
  engines.push(engineFinding('E', ensemble?.valid ? 'ok' : ensemble ? 'degraded' : 'blocked', dataQuality.quality, ensemble?.validationSkill ?? null, { ensemble }, ensemble
    ? [ensemble.valid
      ? `Ensemble beat the rolling baseline out of sample: Brier ${ensemble.validationBrier?.toFixed(4)} vs ${ensemble.baselineBrier?.toFixed(4)}.`
      : ensemble.reason]
    : ['No ensemble estimate is available yet.']));

  // ENGINE J — risk (stake + limits) runs before candidates so the candidate
  // stake is the amount the risk engine approved.
  const safety = input.safety;
  const riskInput: RiskEvaluationInput = {
    config,
    account: input.account,
    mode: input.mode,
    safety,
    symbol: input.symbol,
    now: input.cycleAt,
    tickCount: input.ticks.length,
    activeContracts: input.activeContracts,
    purchaseInFlight: input.unreconciledPurchase !== null,
  };
  const risk = evaluateRisk(riskInput);
  engines.push(engineFinding('J', risk.allowed ? 'ok' : 'blocked', 1, null, risk, risk.allowed
    ? [`Risk limits passed; maximum possible loss on the next purchase is ${risk.maxPossibleLoss}.`]
    : risk.violations));

  // ENGINE G — candidate generation for every supported contract.
  const { drafts, notes: candidateNotes } = buildCandidateDrafts({
    symbol: input.symbol,
    ticks: input.ticks,
    support: input.contractSupport,
    durationTicks,
    ensemble,
    digits,
    stake: risk.stake,
    minProbabilityEdge: config.minProbabilityEdge,
    effectiveSample,
    minimumEffectiveSample: config.minEffectiveSample,
    dataQuality: dataQuality.quality,
    modelValidated: ensemble?.valid ?? false,
    precision: input.precision,
    restrictBarriersToResearchRange: input.restrictBarriersToResearchRange ?? false,
  });
  notes.push(...candidateNotes);
  const allowedFamilies = input.allowedFamilies ?? ['even-odd', 'over-under', 'matches'];
  const filtered = drafts.filter((draft) => allowedFamilies.includes(draft.candidate.family));
  const shortlist = shortlistForProposals(filtered.map((draft) => draft.candidate), input.maxProposalRequests ?? 8);
  engines.push(engineFinding('G', filtered.length ? 'ok' : 'blocked', dataQuality.quality, null, {
    evaluated: filtered.length,
    shortlisted: shortlist.map((candidate) => candidate.id),
    families: allowedFamilies,
  }, filtered.length
    ? [`${filtered.length} contract candidates were built across ${allowedFamilies.length} families; ${shortlist.length} were shortlisted for proposals.`]
    : ['No contract candidate is supported for this symbol and tick expiry.']));

  return {
    decisionId: input.decisionId,
    cycleAt: input.cycleAt,
    symbol: input.symbol,
    mode: input.mode,
    durationTicks,
    engines,
    dataQuality,
    digits,
    models,
    ensemble,
    drafts: filtered,
    shortlist,
    stake: risk.stake,
    risk,
    safety,
    effectiveSample,
    notes,
    blocked: blockCodes.length > 0 || risk.stake === null,
    blockReasons,
    blockCodes,
    modelReport,
    config,
  };
}

/** What the caller must fetch from Deriv before phase two. */
export function proposalRequestsFor(plan: CyclePlan): Array<{ key: string; contractType: string; barrier: string | null; currency: string }> {
  return plan.shortlist
    .map((candidate) => ({ key: candidate.id, contractType: candidate.contractType, barrier: candidate.barrier === null ? null : String(candidate.barrier), currency: '' }))
    .filter((request) => request.contractType.length > 0);
}

export type CycleCompletionInput = {
  quotes: Record<string, ProposalSnapshot>;
  account: BotAccountState;
  currency: string;
  accountAuthorized: boolean;
  connectionHealthy: boolean;
  purchasedDecisionIds: readonly string[];
  purchaseInFlight: boolean;
  aiProvider?: AiDecisionProvider | null;
  /** Quote freshness window applied by the validation engine. */
  maxProposalAgeMs?: number;
};

/**
 * PHASE TWO — applies real proposal terms, then runs the AI decision engine,
 * the expectancy engine, the validation engine and the safety engine.
 */
export async function completeCycle(plan: CyclePlan, input: CycleCompletionInput): Promise<DecisionCycleResult> {
  const candidates = rankCandidates(finalizeCandidates(plan.drafts, input.quotes, { minProbabilityEdge: plan.config.minProbabilityEdge }));
  const best = selectBestCandidate(candidates);
  const engines = [...plan.engines];
  const modelValidated = plan.ensemble?.valid ?? false;
  const modelReason = plan.ensemble?.reason ?? 'No model report has been produced yet.';

  // ENGINE H — expectancy over the real proposals.
  engines.push(engineFinding('H', best ? 'ok' : 'degraded', plan.dataQuality.quality, null, {
    quoted: candidates.filter((candidate) => candidate.proposalVerified).length,
    eligible: candidates.filter((candidate) => candidate.eligible).length,
    best: best ? {
      id: best.id,
      stake: best.stake,
      payout: best.payout,
      breakEvenProbability: best.breakEvenProbability,
      expectedValue: best.expectedValue,
      conservativeExpectedValue: best.conservativeExpectedValue,
    } : null,
    rejections: summarizeRejections(candidates),
  }, best
    ? [`${best.winningCondition}: expected value ${best.expectedValue?.toFixed(4)} on a stake of ${best.stake} with a break-even rate of ${(best.breakEvenProbability! * 100).toFixed(2)}%.`]
    : ['No candidate produced a positive expected value with acceptable uncertainty.']));

  // ENGINE F — AI decision layer (statistical fallback when no model configured).
  const expectedStake = plan.risk.stake;
  const features = buildAiFeatureObject({
    symbol: plan.symbol,
    quote: plan.digits?.lastQuote ?? null,
    lastDigit: plan.digits?.lastDigit ?? null,
    digits: plan.digits,
    models: plan.models,
    ensemble: plan.ensemble,
    candidates,
    dataQuality: plan.dataQuality,
    risk: plan.risk,
    safety: plan.safety,
    mode: plan.mode,
    accountCurrency: input.currency,
    balance: input.account.currentBalance,
    durationTicks: plan.durationTicks,
  });
  const evaluation = await evaluateDecision({
    provider: input.aiProvider ?? null,
    candidates,
    modelValidated,
    modelReason,
    dataFresh: plan.dataQuality.fresh,
    expectedStake,
    features,
  });
  const selection = evaluation.selected ?? (evaluation.summary.action === 'TRADE' ? best : null);
  engines.push(engineFinding('F', evaluation.summary.action === 'TRADE' ? 'ok' : 'degraded', plan.dataQuality.quality, null, evaluation.summary, evaluation.summary.reasons));

  const reasonCodes: ReasonCode[] = [...evaluation.summary.reasonCodes];
  const reasons: string[] = [...evaluation.summary.reasons];
  let action: DecisionCycleResult['action'] = evaluation.summary.action === 'TRADE' && selection ? 'TRADE' : 'NO_TRADE';
  let intent: TradeIntent | null = null;

  if (plan.blocked) {
    action = plan.mode === 'analysis' ? (selection ? 'TRADE' : 'NO_TRADE') : 'BLOCKED';
    if (plan.mode !== 'analysis') {
      reasons.push(...plan.blockReasons, ...plan.risk.violations);
      reasonCodes.push(...plan.blockCodes);
    }
  }

  // ENGINE I — validation. `dryRun` keeps analysis decisions inspectable
  // while making it structurally impossible to send an order from analysis
  // mode: only live mode can produce an executable intent.
  const dryRun = plan.mode !== 'live';
  if (action === 'TRADE' && selection) {
    const expectation = {
      contractType: selection.contractType,
      barrierDigit: selection.barrier,
      symbol: selection.symbol,
      stake: selection.stake ?? plan.risk.stake ?? 0,
      currency: input.currency || null,
      durationTicks: plan.durationTicks,
    };
    const proposal = input.quotes[selection.id] ?? null;
    const validation = validateTrade({
      decisionId: plan.decisionId,
      candidate: selection,
      risk: plan.risk,
      safety: plan.safety,
      mode: plan.mode,
      dataQuality: plan.dataQuality,
      modelValidated,
      modelValidationReason: modelReason,
      accountAuthorized: input.accountAuthorized,
      connectionHealthy: input.connectionHealthy,
      proposal,
      expectation,
      purchasedDecisionIds: input.purchasedDecisionIds,
      purchaseInFlight: input.purchaseInFlight,
      now: plan.cycleAt,
      maxProposalAgeMs: input.maxProposalAgeMs ?? 20_000,
      minProbabilityEdge: plan.config.minProbabilityEdge,
      dryRun,
    });
    engines.push(engineFinding('I', validation.ok ? 'ok' : 'blocked', plan.dataQuality.quality, null, {
      checks: validation.checks,
      economics: validation.recalculatedEconomics,
    }, validation.ok ? ['Every validation gate passed against the live proposal.'] : validation.reasons));
    if (!validation.ok) {
      action = plan.mode === 'analysis' ? 'TRADE' : 'BLOCKED';
      reasonCodes.push(...validation.codes);
      reasons.push(...validation.reasons);
      intent = null;
    } else if (plan.mode !== 'analysis') {
      intent = {
        decisionId: plan.decisionId,
        family: selection.family,
        contractType: selection.contractType,
        symbol: selection.symbol,
        stake: selection.stake ?? plan.risk.stake ?? 0,
        duration: plan.durationTicks,
        durationUnit: 't',
        barrier: selection.barrier === null ? null : String(selection.barrier),
        barrierDigit: selection.barrier,
        currency: input.currency,
        mode: plan.mode,
        createdAt: plan.cycleAt,
        reasonCodes: [...new Set([...reasonCodes, 'TRADE_APPROVED' as ReasonCode])],
      };
      reasonCodes.push('TRADE_APPROVED');
    }
  } else if (action === 'TRADE') {
    action = 'NO_TRADE';
    reasons.push('No candidate was recommended, so no order was prepared.');
  }

  if (plan.mode === 'analysis' && action === 'TRADE' && selection) {
    reasons.push('Analysis-only mode: the contract above is displayed as a recommendation and no order is sent.');
  }

  // ENGINE N — safety interlocks are reported last so nothing is hidden.
  const safety = plan.safety;
  engines.push(safetyFinding(safety, plan.mode));

  if (action !== 'TRADE') {
    reasons.push(...summarizeRejections(candidates).slice(0, 2));
  }

  return {
    decisionId: plan.decisionId,
    cycleAt: plan.cycleAt,
    symbol: plan.symbol,
    mode: plan.mode,
    action,
    actionLabel: action === 'TRADE'
      ? `${selection?.winningCondition ?? 'Trade'} · ${plan.mode === 'live' ? 'live order prepared' : 'recommendation only'}`
      : action === 'BLOCKED'
        ? 'Blocked'
        : 'No trade',
    reasonCodes: [...new Set(reasonCodes)],
    reasons: [...new Set(reasons.filter(Boolean))],
    intent,
    candidates,
    selected: selection,
    risk: plan.risk,
    engines,
    digits: plan.digits,
    models: plan.models,
    ensemble: plan.ensemble,
    ai: evaluation.summary,
    durationTicks: plan.durationTicks,
  };
}

/** Convenience helper for tests and the analysis path. */
export async function runDecisionCycle(input: DecisionCycleInput, quotes: Record<string, ProposalSnapshot>, completion: Omit<CycleCompletionInput, 'quotes'>): Promise<DecisionCycleResult> {
  const plan = planCycle(input);
  return completeCycle(plan, { ...completion, quotes });
}

/** Recomputes expectancy for a hypothetical stake without a live proposal. */
export function previewEconomics(stake: number, payout: number, probability: number, conservative: number, minimumEdge: number) {
  return contractEconomics({ stake, payout }, probability, conservative, minimumEdge);
}
