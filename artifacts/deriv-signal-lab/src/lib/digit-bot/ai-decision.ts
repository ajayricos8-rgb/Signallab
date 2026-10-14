// ENGINE F — AI decision engine.
//
// The AI layer compares candidates and explains a recommendation. It is
// structurally impossible for it to invent numbers: an external model answer is
// only accepted when every figure it returns matches a value the statistical
// and contract-analysis engines already produced, and the resulting action must
// still pass the validation and risk engines.
//
// When no external model is configured — the default in this application — the
// deterministic statistical decision path below is used, and the dashboard says
// so instead of implying an AI made the call.
import { clamp, mean } from '../over-under/math.ts';
import type {
  AiDecisionProvider,
  AiDecisionSummary,
  CandidateRecord,
  DataQualityFinding,
  DecisionCycleResult,
  DigitIntelligenceFindings,
  EnsembleFinding,
  ModelEvidence,
  ReasonCode,
  RiskEvaluation,
  SafetyState,
} from './types.ts';

/** Keys that must never leave the browser. */
const FORBIDDEN_KEYS = [
  'pat',
  'token',
  'access_token',
  'personal_access_token',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'password',
  'account_id',
  'accountid',
  'bearer',
  'otp',
];

export type SecretScan = { ok: boolean; offendingKeys: string[] };

/**
 * Recursively checks an outbound payload for credential-shaped keys.
 * Account identifiers, tokens and OTP URLs must never reach a third party.
 */
export function scanForSecrets(value: unknown, path = ''): SecretScan {
  const offendingKeys: string[] = [];
  const walk = (node: unknown, currentPath: string) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${currentPath}[${index}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
        if (FORBIDDEN_KEYS.some((forbidden) => normalized === forbidden.replace(/[^a-z_]/g, ''))) {
          offendingKeys.push(currentPath ? `${currentPath}.${key}` : key);
        }
        walk(child, currentPath ? `${currentPath}.${key}` : key);
      }
      return;
    }
    if (typeof node === 'string' && /^(wss:\/\/|https:\/\/api\.deriv)/i.test(node)) {
      offendingKeys.push(currentPath);
    }
  };
  walk(value, path);
  return { ok: offendingKeys.length === 0, offendingKeys };
}

export type AiFeatureInput = {
  symbol: string;
  quote: number | null;
  lastDigit: number | null;
  digits: DigitIntelligenceFindings | null;
  models: readonly ModelEvidence[];
  ensemble: EnsembleFinding | null;
  candidates: readonly CandidateRecord[];
  dataQuality: DataQualityFinding;
  risk: RiskEvaluation;
  safety: SafetyState;
  mode: string;
  accountCurrency: string;
  balance: number | null;
  durationTicks: number;
};

/**
 * Structured feature object handed to the decision layer. It contains measured
 * values only — no credentials, no account identifiers, no URLs.
 */
export function buildAiFeatureObject(input: AiFeatureInput): Record<string, unknown> {
  const windows = input.digits?.windows ?? [];
  return {
    symbol: input.symbol,
    current_quote: input.quote,
    latest_last_digit: input.lastDigit,
    duration_ticks: input.durationTicks,
    mode: input.mode,
    currency: input.accountCurrency,
    balance: input.balance,
    digit_frequencies: windows.map((window) => ({
      window: window.window,
      sample: window.sample,
      frequencies: window.frequencies,
      baseline_deviation: window.baselineDeviation,
      even_rate: window.evenRate,
      odd_rate: window.oddRate,
      chi_square: window.chiSquare,
      chi_square_p_value: window.chiSquarePValue,
      normalized_entropy: window.normalizedEntropy,
      gaps_since_appearance: window.gapsSinceAppearance,
    })),
    rolling_statistics: input.digits ? {
      sample_size: input.digits.sampleSize,
      parity_counts: input.digits.parityCounts,
      current_digit_run: input.digits.streaks.currentDigitRun,
      current_parity_run: input.digits.streaks.currentParityRun,
      longest_parity_run: input.digits.streaks.longestParityRun,
      recency_vs_long_term: input.digits.recency.recentVsLongTerm,
      exponentially_weighted: input.digits.recency.ewma,
      entropy_bits: input.digits.entropyBits,
      normalized_entropy: input.digits.normalizedEntropy,
    } : null,
    transition_summary: input.digits ? {
      current_row: input.digits.transitions.currentRow,
      current_row_sample: input.digits.transitions.currentRowSample,
      pair_sample: input.digits.transitions.pairSample,
      pair_probabilities: input.digits.transitions.pairProbabilities,
    } : null,
    distribution_test: input.digits ? input.digits.distribution : null,
    model_evidence: input.models.map((model) => ({
      key: model.key,
      label: model.label,
      kind: model.kind,
      status: model.status,
      weight: model.weight,
      support: model.support,
      tuning_brier: model.tuningBrier,
      validation_brier: model.validationBrier,
      baseline_brier: model.baselineBrier,
      skill: model.skill,
      calibration_error: model.validationCalibrationError,
    })),
    ensemble: input.ensemble ? {
      probabilities: input.ensemble.probabilities,
      baseline_probabilities: input.ensemble.baselineProbabilities,
      agreement: input.ensemble.agreement,
      dispersion: input.ensemble.dispersion,
      supporting_models: input.ensemble.supportingModels,
      validated: input.ensemble.valid,
      validation_skill: input.ensemble.validationSkill,
      improvement_lower_bound: input.ensemble.improvementLower,
    } : null,
    candidates: input.candidates.map((candidate) => ({
      id: candidate.id,
      family: candidate.family,
      contract_type: candidate.contractType,
      barrier: candidate.barrier,
      winning_condition: candidate.winningCondition,
      estimated_probability: candidate.estimatedProbability,
      probability_lower_bound: candidate.probabilityLowerBound,
      probability_upper_bound: candidate.probabilityUpperBound,
      uncertainty: candidate.uncertainty,
      payout: candidate.payout,
      stake: candidate.stake,
      break_even_probability: candidate.breakEvenProbability,
      expected_value: candidate.expectedValue,
      conservative_expected_value: candidate.conservativeExpectedValue,
      eligible: candidate.eligible,
      rejection_reasons: candidate.rejectionReasons,
    })),
    data_quality: input.dataQuality,
    risk_state: {
      allowed: input.risk.allowed,
      stake: input.risk.stake,
      max_possible_loss: input.risk.maxPossibleLoss,
      violations: input.risk.violations,
      limits: input.risk.limits,
    },
    safety_state: {
      run_state: input.safety.runState,
      emergency_stop: input.safety.emergencyStop,
      manual_pause: input.safety.manualPause,
      auto_pause_reasons: input.safety.autoPauseReasons,
    },
  };
}

export type ExternalDecision = {
  action: 'TRADE' | 'NO_TRADE';
  contract_type: string;
  barrier: number | null;
  estimated_win_probability: number;
  break_even_probability: number;
  expected_value: number;
  stake: number;
  reason_codes: string[];
};

export type ExternalDecisionValidation = {
  ok: boolean;
  issues: string[];
  decision: ExternalDecision | null;
  matchedCandidate: CandidateRecord | null;
};

const PROBABILITY_TOLERANCE = 5e-4;
const MONEY_TOLERANCE = 0.01;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberField(source: Record<string, unknown>, key: string): number | null {
  const raw = source[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

/**
 * Validates an external decision against the engine outputs.
 *
 * Every numeric field must reproduce a candidate value that the statistical
 * and expectancy engines already computed. A plausible-looking invented number
 * is rejected, and the statistical decision is used instead.
 */
export function validateExternalDecision(raw: unknown, candidates: readonly CandidateRecord[], expectedStake: number | null): ExternalDecisionValidation {
  const issues: string[] = [];
  const record = asRecord(raw);
  if (!record) return { ok: false, issues: ['The model did not return a structured decision object.'], decision: null, matchedCandidate: null };
  const action = typeof record.action === 'string' ? record.action.toUpperCase() : '';
  if (action !== 'TRADE' && action !== 'NO_TRADE') {
    return { ok: false, issues: [`The model returned an unsupported action "${String(record.action)}".`], decision: null, matchedCandidate: null };
  }
  const reasonCodes = Array.isArray(record.reason_codes) ? record.reason_codes.filter((code): code is string => typeof code === 'string') : [];
  if (action === 'NO_TRADE') {
    return {
      ok: true,
      issues: [],
      decision: {
        action: 'NO_TRADE',
        contract_type: typeof record.contract_type === 'string' ? record.contract_type : '',
        barrier: numberField(record, 'barrier'),
        estimated_win_probability: numberField(record, 'estimated_win_probability') ?? 0,
        break_even_probability: numberField(record, 'break_even_probability') ?? 0,
        expected_value: numberField(record, 'expected_value') ?? 0,
        stake: numberField(record, 'stake') ?? 0,
        reason_codes: reasonCodes,
      },
      matchedCandidate: null,
    };
  }

  const contractType = typeof record.contract_type === 'string' ? record.contract_type : '';
  const barrier = numberField(record, 'barrier');
  const candidate = candidates.find((row) =>
    row.contractType === contractType
    && (row.barrier === null ? barrier === null : barrier !== null && Math.abs(row.barrier - barrier) < 1e-9)) ?? null;
  if (!candidate) {
    issues.push('The model named a contract that is not among the evaluated candidates.');
  } else if (!candidate.eligible) {
    issues.push('The model selected a candidate that the validation engine rejected.');
  }

  const probability = numberField(record, 'estimated_win_probability');
  const breakEven = numberField(record, 'break_even_probability');
  const expectedValue = numberField(record, 'expected_value');
  const stake = numberField(record, 'stake');
  if (candidate) {
    if (probability === null || Math.abs(probability - candidate.estimatedProbability) > PROBABILITY_TOLERANCE) {
      issues.push('The estimated win probability does not match the statistical engine output.');
    }
    if (candidate.breakEvenProbability === null || breakEven === null || Math.abs(breakEven - candidate.breakEvenProbability) > PROBABILITY_TOLERANCE) {
      issues.push('The break-even probability does not match the expectancy engine output.');
    }
    if (candidate.expectedValue === null || expectedValue === null || Math.abs(expectedValue - candidate.expectedValue) > MONEY_TOLERANCE) {
      issues.push('The expected value does not match the expectancy engine output.');
    }
  }
  if (stake === null || expectedStake === null || Math.abs(stake - expectedStake) > MONEY_TOLERANCE) {
    issues.push('The stake does not match the amount the risk engine approved.');
  }

  if (issues.length || !candidate) return { ok: false, issues, decision: null, matchedCandidate: candidate };
  // Reaching this point means every figure was compared against an engine
  // output above, so the values are known numbers.
  const verifiedProbability = probability as number;
  const verifiedBreakEven = breakEven as number;
  const verifiedExpectedValue = expectedValue as number;
  const verifiedStake = stake as number;
  return {
    ok: true,
    issues,
    decision: {
      action: 'TRADE',
      contract_type: contractType,
      barrier,
      estimated_win_probability: verifiedProbability,
      break_even_probability: verifiedBreakEven,
      expected_value: verifiedExpectedValue,
      stake: verifiedStake,
      reason_codes: reasonCodes,
    },
    matchedCandidate: candidate,
  };
}

/**
 * Deterministic decision used when no external model answered, or when the
 * external answer failed validation. It never invents a trade.
 */
export function statisticalDecision(candidates: readonly CandidateRecord[], context: { modelValidated: boolean; modelReason: string; dataFresh: boolean }): {
  action: 'TRADE' | 'NO_TRADE';
  selected: CandidateRecord | null;
  reasonCodes: ReasonCode[];
  reasons: string[];
} {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (!eligible.length) {
    const codes = new Set<ReasonCode>();
    for (const candidate of candidates) for (const code of candidate.reasonCodes) codes.add(code);
    const reasonCodes: ReasonCode[] = [...codes];
    reasonCodes.push('NO_ELIGIBLE_CANDIDATE');
    const topReasons = candidates[0]?.rejectionReasons ?? ['No contract candidate was available for this market.'];
    return {
      action: 'NO_TRADE',
      selected: null,
      reasonCodes: [...new Set(reasonCodes)],
      reasons: ['No candidate offered a positive expected value with acceptable uncertainty.', ...topReasons.slice(0, 3)],
    };
  }
  if (!context.modelValidated) {
    return {
      action: 'NO_TRADE',
      selected: null,
      reasonCodes: ['MODEL_UNVALIDATED'],
      reasons: [context.modelReason || 'The model did not establish out-of-sample skill, so the bot will not trade on its own estimate.'],
    };
  }
  if (!context.dataFresh) {
    return {
      action: 'NO_TRADE',
      selected: null,
      reasonCodes: ['DATA_STALE'],
      reasons: ['The live tick stream is not fresh; no trade is placed while the data cannot be trusted.'],
    };
  }
  const best = [...eligible].sort((left, right) => right.score - left.score)[0];
  const reasons = [
    `${best.winningCondition}.`,
    `Estimated probability ${(best.estimatedProbability * 100).toFixed(2)}% with a conservative bound of ${(best.probabilityLowerBound * 100).toFixed(2)}% against a break-even rate of ${(best.breakEvenProbability! * 100).toFixed(2)}%.`,
    `Expected value ${best.expectedValue!.toFixed(4)} per ${best.stake} staked; conservative value ${best.conservativeExpectedValue!.toFixed(4)}.`,
    'The models beat the rolling-frequency baseline out of sample, so the estimate is treated as a measured edge rather than an observation.',
  ];
  return {
    action: 'TRADE',
    selected: best,
    reasonCodes: ['DATA_VALID', 'MODEL_VALIDATED', 'EXPECTED_VALUE_POSITIVE'],
    reasons,
  };
}

export type AiEvaluation = {
  summary: AiDecisionSummary;
  selected: CandidateRecord | null;
  features: Record<string, unknown>;
};

export type AiEvaluationInput = {
  provider: AiDecisionProvider | null;
  candidates: readonly CandidateRecord[];
  modelValidated: boolean;
  modelReason: string;
  dataFresh: boolean;
  expectedStake: number | null;
  features: Record<string, unknown>;
};

/**
 * Runs the decision layer. The returned selection is a *recommendation*: the
 * validation and risk engines still have the final say, and the selected
 * candidate is re-checked against the live proposal before any purchase.
 */
export async function evaluateDecision(input: AiEvaluationInput): Promise<AiEvaluation> {
  const fallbackContext = { modelValidated: input.modelValidated, modelReason: input.modelReason, dataFresh: input.dataFresh };
  if (!input.provider) {
    const fallback = statisticalDecision(input.candidates, fallbackContext);
    return {
      summary: {
        source: 'statistical-fallback',
        action: fallback.action,
        reasonCodes: fallback.reasonCodes,
        reasons: fallback.reasons,
        rejectedExternalReason: null,
        providerConfigured: false,
        secretsExcluded: true,
      },
      selected: fallback.selected,
      features: input.features,
    };
  }

  const scan = scanForSecrets(input.features);
  if (!scan.ok) {
    const fallback = statisticalDecision(input.candidates, fallbackContext);
    return {
      summary: {
        source: 'statistical-fallback',
        action: fallback.action,
        reasonCodes: [...fallback.reasonCodes],
        reasons: [fallback.reasons[0], 'The AI feature object was blocked because it contained credential-shaped fields; nothing was sent externally.'],
        rejectedExternalReason: `Blocked fields: ${scan.offendingKeys.join(', ')}`,
        providerConfigured: true,
        secretsExcluded: true,
      },
      selected: fallback.selected,
      features: input.features,
    };
  }

  let raw: unknown;
  try {
    raw = await input.provider(input.features);
  } catch (error) {
    const fallback = statisticalDecision(input.candidates, fallbackContext);
    return {
      summary: {
        source: 'statistical-fallback',
        action: fallback.action,
        reasonCodes: [...fallback.reasonCodes, 'STATISTICAL_FALLBACK'],
        reasons: [fallback.reasons[0], `The external model was unavailable (${error instanceof Error ? error.message : 'unknown error'}), so the statistical decision was used.`],
        rejectedExternalReason: 'The external model did not answer.',
        providerConfigured: true,
        secretsExcluded: true,
      },
      selected: fallback.selected,
      features: input.features,
    };
  }

  const validation = validateExternalDecision(raw, input.candidates, input.expectedStake);
  if (!validation.ok) {
    const fallback = statisticalDecision(input.candidates, fallbackContext);
    return {
      summary: {
        source: 'statistical-fallback',
        action: fallback.action,
        reasonCodes: [...fallback.reasonCodes, 'AI_DECISION_REJECTED'],
        reasons: [fallback.reasons[0], `The external recommendation was rejected: ${validation.issues.join(' ')}`],
        rejectedExternalReason: validation.issues.join(' '),
        providerConfigured: true,
        secretsExcluded: true,
      },
      selected: fallback.selected,
      features: input.features,
    };
  }

  if (validation.decision?.action === 'NO_TRADE') {
    return {
      summary: {
        source: 'external-model',
        action: 'NO_TRADE',
        reasonCodes: ['NO_ELIGIBLE_CANDIDATE'],
        reasons: ['The AI layer returned NO_TRADE after reviewing the measured candidates.', ...validation.decision.reason_codes],
        rejectedExternalReason: null,
        providerConfigured: true,
        secretsExcluded: true,
      },
      selected: null,
      features: input.features,
    };
  }

  const matched = validation.matchedCandidate;
  return {
    summary: {
      source: 'external-model',
      action: 'TRADE',
      reasonCodes: ['DATA_VALID', 'MODEL_VALIDATED', 'EXPECTED_VALUE_POSITIVE'],
      reasons: [
        `The AI layer selected ${matched?.winningCondition ?? 'a candidate'} using engine-supplied figures only.`,
        ...(validation.decision?.reason_codes ?? []),
      ],
      rejectedExternalReason: null,
      providerConfigured: true,
      secretsExcluded: true,
    },
    selected: matched,
    features: input.features,
  };
}

/** Compact description used by the dashboard's AI panel. */
export function describeDecision(result: Pick<DecisionCycleResult, 'action' | 'reasonCodes' | 'reasons' | 'selected'>): { headline: string; detail: string[] } {
  const headline = result.action === 'TRADE'
    ? `TRADE · ${result.selected?.winningCondition ?? 'selected contract'}`
    : result.action === 'BLOCKED'
      ? 'BLOCKED'
      : 'NO TRADE';
  return { headline, detail: result.reasons };
}

/** Mean model agreement, surfaced on the dashboard as "model agreement". */
export function modelAgreement(ensemble: EnsembleFinding | null): number | null {
  if (!ensemble) return null;
  return clamp(ensemble.agreement, 0, 1);
}

export function averageUncertainty(candidates: readonly CandidateRecord[]): number | null {
  if (!candidates.length) return null;
  return mean(candidates.map((candidate) => candidate.uncertainty));
}
