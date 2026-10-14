// ENGINE I — Trade validation engine.
//
// The single gate every purchase must pass. No AI answer, no dashboard button
// and no stale snapshot can bypass it: the validation result is computed from
// the live proposal, the risk evaluation and the data-quality finding only.
import type {
  BotMode,
  CandidateRecord,
  DataQualityFinding,
  ReasonCode,
  RiskEvaluation,
  SafetyState,
} from './types.ts';
import { contractEconomics, maximumPossibleLoss, validateProposal, type ProposalExpectation, type ProposalSnapshot } from './expectancy.ts';

export type ValidationCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type TradeValidation = {
  ok: boolean;
  codes: ReasonCode[];
  reasons: string[];
  checks: ValidationCheck[];
  recalculatedEconomics: ReturnType<typeof contractEconomics>;
};

export type TradeValidationInput = {
  decisionId: string;
  candidate: CandidateRecord | null;
  risk: RiskEvaluation;
  safety: SafetyState;
  mode: BotMode;
  dataQuality: DataQualityFinding;
  modelValidated: boolean;
  modelValidationReason: string;
  accountAuthorized: boolean;
  connectionHealthy: boolean;
  proposal: ProposalSnapshot | null;
  expectation: ProposalExpectation | null;
  /** Decision ids that already resulted in a purchase. */
  purchasedDecisionIds: readonly string[];
  purchaseInFlight: boolean;
  now: number;
  maxProposalAgeMs: number;
  minProbabilityEdge: number;
  /**
   * Analysis and paper modes validate everything except the execution gate, so
   * the dashboard can show what a live order *would* have required without
   * ever being allowed to send one.
   */
  dryRun?: boolean;
};

export function validateTrade(input: TradeValidationInput): TradeValidation {
  const checks: ValidationCheck[] = [];
  const reasons: string[] = [];
  const codes: ReasonCode[] = [];
  const record = (id: string, label: string, passed: boolean, detail: string, code?: ReasonCode) => {
    checks.push({ id, label, passed, detail });
    if (!passed) {
      reasons.push(detail);
      if (code) codes.push(code);
    }
    return passed;
  };

  const modeOk = input.mode === 'live' || input.dryRun === true;
  record('mode', 'Execution mode', modeOk, modeOk
    ? input.mode === 'live'
      ? 'Live trading mode is active.'
      : `Simulation check for ${input.mode} mode: the gate is evaluated but no order can be sent.`
    : 'Live purchases require the live-trading mode to be activated by the user.', 'MODE_NOT_EXECUTABLE');
  record('authorization', 'Account authorization', input.accountAuthorized, input.accountAuthorized ? 'A Deriv account is authorized for this session.' : 'No Deriv account is authorized, so no purchase can be sent.', 'ACCOUNT_UNAUTHORIZED');
  record('connection', 'Deriv connection', input.connectionHealthy, input.connectionHealthy ? 'The authenticated Deriv socket is open.' : 'The authenticated Deriv socket is not open.', 'CONNECTION_INTERRUPTED');
  record('safety', 'Safety interlocks', input.safety.canPurchase, input.safety.canPurchase ? 'No safety interlock is active.' : input.safety.autoPauseReasons.join(' ') || 'The bot is stopped or paused.', input.safety.emergencyStop ? 'EMERGENCY_STOP' : 'MANUAL_PAUSE');
  record('data', 'Live tick data', input.dataQuality.fresh && input.dataQuality.precisionVerified, input.dataQuality.fresh && input.dataQuality.precisionVerified ? `${input.dataQuality.validTickCount} live ticks with verified precision.` : input.dataQuality.precisionVerified ? 'The tick stream is stale or interrupted; new trades are disabled until it recovers.' : 'Decimal precision is unverified, so the final digit cannot be trusted.', input.dataQuality.fresh ? 'PRECISION_UNVERIFIED' : 'DATA_STALE');
  record('model', 'Model validation', input.modelValidated, input.modelValidated ? 'The ensemble beat the rolling baseline out of sample.' : input.modelValidationReason || 'No model currently qualifies for execution.', 'MODEL_UNVALIDATED');
  record('candidate', 'Candidate evidence', Boolean(input.candidate), input.candidate ? `${input.candidate.winningCondition}.` : 'No contract candidate had enough evidence to qualify.', 'NO_ELIGIBLE_CANDIDATE');
  record('duplicate', 'Duplicate protection', !input.purchasedDecisionIds.includes(input.decisionId) && !input.purchaseInFlight, input.purchaseInFlight ? 'A purchase is already in flight; waiting for its receipt before any new order.' : input.purchasedDecisionIds.includes(input.decisionId) ? 'This decision already bought a contract.' : 'This decision has not been purchased yet.', input.purchaseInFlight ? 'PURCHASE_UNRECONCILED' : 'DUPLICATE_DECISION');

  let economics: TradeValidation['recalculatedEconomics'] = null;
  if (input.candidate && input.proposal) {
    const check = validateProposal(input.proposal, input.expectation ?? {
      contractType: input.candidate.contractType,
      barrierDigit: input.candidate.barrier,
      symbol: input.candidate.symbol,
      stake: input.candidate.stake ?? input.proposal.askPrice,
      currency: null,
      durationTicks: 0,
    }, { now: input.now, maxAgeMs: input.maxProposalAgeMs });
    record('proposal', 'Proposal validation', check.ok, check.ok ? `Deriv proposal ${input.proposal.quoteId} matches the intended contract.` : check.issues.join(' '), check.reasonCodes[0] ?? 'PROPOSAL_INVALID');
    for (const warning of check.warnings) reasons.push(`Warning: ${warning}`);
    // The expected value is recomputed from the actual proposal, never from an
    // earlier estimate.
    economics = contractEconomics(
      { stake: input.proposal.askPrice, payout: input.proposal.payout },
      input.candidate.estimatedProbability,
      input.candidate.probabilityLowerBound,
      input.minProbabilityEdge,
    );
    const passed = economics !== null && economics.conservativeExpectedValue > 0;
    record('expectancy', 'Expected value', passed, economics === null
      ? 'The proposal payout does not exceed the stake, or the terms could not be read, so no expected value can be computed.'
      : passed
        ? `Expected value ${economics.expectedValue.toFixed(4)} (conservative ${economics.conservativeExpectedValue.toFixed(4)}) against a break-even rate of ${(economics.breakEvenProbability * 100).toFixed(1)}%.`
        : 'The expected value is not positive after accounting for probability uncertainty.', 'EXPECTED_VALUE_NEGATIVE');
  } else {
    record('proposal', 'Proposal validation', false, 'No current Deriv proposal is available for this candidate.', 'PAYOUT_MISSING');
  }

  record('risk', 'Risk limits', input.risk.allowed, input.risk.allowed ? `Maximum possible loss on this purchase is ${maximumPossibleLoss(input.risk.maxPossibleLoss)}.` : input.risk.violations.join(' '), input.risk.reasonCodes[0] ?? 'RISK_LIMITS_PASSED');

  const ok = checks.every((check) => check.passed);
  if (ok) codes.push('TRADE_APPROVED');
  return {
    ok,
    codes: [...new Set(codes)],
    reasons: [...new Set(reasons.filter(Boolean))],
    checks,
    recalculatedEconomics: economics,
  };
}
