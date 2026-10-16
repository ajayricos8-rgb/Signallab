// ENGINES F & G — AI decision inputs, contract/barrier selection and the
// adaptive barrier optimizer.
//
// Candidates are generated for every contract the selected market actually
// supports: Even/Odd, every eligible Over/Under barrier and every Matches
// target digit. Each record carries its estimate, its uncertainty, the real
// proposal economics when available, and the full list of rejection reasons.
import { clamp, countsOf, sum } from '../over-under/math.ts';
import type { DigitContractSupport } from '../deriv-digit-metadata.ts';
import type { BotTick } from './types.ts';
import type { CandidateRecord, ContractFamily, EnsembleFinding, BotContractType, DigitIntelligenceFindings, ReasonCode } from './types.ts';
import { FAMILY_OF_CONTRACT, CONTRACT_LABELS } from './types.ts';
import { CREDIBLE_Z, describeEvent, dirichletEventEstimate, probabilityOfEvent, type DigitEvent } from './statistics.ts';
import { barrierDigitsFor, contractEconomics, normalizeMoney, type ProposalSnapshot } from './expectancy.ts';

export const RESEARCH_BARRIER_MIN = 1;
export const RESEARCH_BARRIER_MAX = 8;

/** Stable key for a candidate, also used to match Deriv proposals. */
export function candidateKey(contractType: BotContractType, barrier: number | null): string {
  return barrier === null ? contractType : `${contractType}:${barrier}`;
}

export function eventForCandidate(contractType: BotContractType, barrier: number | null): DigitEvent | null {
  switch (contractType) {
    case 'DIGITEVEN':
      return { kind: 'parity', parity: 0 };
    case 'DIGITODD':
      return { kind: 'parity', parity: 1 };
    case 'DIGITOVER':
      return barrier === null ? null : { kind: 'over', barrier };
    case 'DIGITUNDER':
      return barrier === null ? null : { kind: 'under', barrier };
    case 'DIGITMATCH':
      return barrier === null ? null : { kind: 'match', target: barrier };
    default:
      return null;
  }
}

type SupportDomain = {
  contractType: BotContractType;
  barriers: number[];
  supported: boolean;
};

/**
 * Barriers and target digits derived from Deriv's own `contracts_for` payload.
 * Barriers that cannot win (Over 9, Under 0) are removed here, and the
 * research range is honoured when Deriv reports a wider domain.
 */
export function eligibleBarriers(support: DigitContractSupport, contractType: BotContractType): number[] {
  const reported = support.barriers.length ? support.barriers : Array.from({ length: 10 }, (_, digit) => digit);
  const domain = reported.filter((barrier) => Number.isInteger(barrier) && barrier >= 0 && barrier <= 9);
  if (contractType === 'DIGITOVER') return domain.filter((barrier) => barrier >= 0 && barrier <= 8);
  if (contractType === 'DIGITUNDER') return domain.filter((barrier) => barrier >= 1 && barrier <= 9);
  return domain;
}

export function eligibleTargets(support: DigitContractSupport): number[] {
  const reported = support.targets.length ? support.targets : Array.from({ length: 10 }, (_, digit) => digit);
  return reported.filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9);
}

function supportsTickExpiry(support: DigitContractSupport, durationTicks: number): boolean {
  if (support.expiryType.toLowerCase() !== 'tick') return false;
  if (support.minDuration === null || support.maxDuration === null) {
    // Deriv did not report bounds; the live proposal remains authoritative and
    // the candidate is not blocked on this basis alone.
    return true;
  }
  return durationTicks >= support.minDuration && durationTicks <= support.maxDuration;
}

export function resolveSupportDomain(support: readonly DigitContractSupport[], durationTicks: number): SupportDomain[] {
  const types: BotContractType[] = ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH'];
  return types.map((contractType) => {
    const rows = support.filter((row) => row.contractType === contractType && supportsTickExpiry(row, durationTicks));
    const barriers = new Set<number>();
    for (const row of rows) {
      if (contractType === 'DIGITMATCH') for (const digit of eligibleTargets(row)) barriers.add(digit);
      else for (const barrier of eligibleBarriers(row, contractType)) barriers.add(barrier);
    }
    return { contractType, barriers: [...barriers].sort((left, right) => left - right), supported: rows.length > 0 };
  });
}

export type ProbabilitySource = {
  probabilities: number[];
  label: string;
  validated: boolean;
  dispersion: number;
};

/** Picks the probability vector the candidates are built from. */
export function selectProbabilitySource(ensemble: EnsembleFinding | null, fallbackCounts: readonly number[]): ProbabilitySource {
  if (ensemble && ensemble.probabilities.length === 10 && ensemble.probabilities.every((value) => Number.isFinite(value) && value >= 0)) {
    return {
      probabilities: ensemble.probabilities,
      label: 'Ensemble (models A–H, walk-forward validated)',
      validated: ensemble.valid,
      dispersion: ensemble.dispersion,
    };
  }
  const posterior = countsOf(fallbackCounts).map((count) => (count + 0.1) / (sum(countsOf(fallbackCounts)) + 1));
  return {
    probabilities: posterior,
    label: 'Rolling frequency baseline only (no validated ensemble)',
    validated: false,
    dispersion: 0,
  };
}

export type CandidateBuildInput = {
  symbol: string;
  ticks: readonly BotTick[];
  support: readonly DigitContractSupport[];
  durationTicks: number;
  ensemble: EnsembleFinding | null;
  digits: DigitIntelligenceFindings | null;
  stake: number | null;
  minProbabilityEdge: number;
  effectiveSample: number;
  minimumEffectiveSample: number;
  dataQuality: number;
  modelValidated: boolean;
  precision: number | null;
  /** When true, Even/Odd barriers are limited to the 1–8 research range too. */
  restrictBarriersToResearchRange: boolean;
};

export type CandidateDraft = {
  candidate: CandidateRecord;
  /** What the hook must ask Deriv for before this candidate can qualify. */
  proposalRequest: { key: string; contractType: BotContractType; barrier: string | null; barrierDigit: number | null } | null;
};

/**
 * Builds the full candidate set for the current market state.
 *
 * The estimated probability always comes from measured digits. Payouts stay
 * null until Deriv returns a real proposal, which is why eligibility cannot be
 * decided here for candidates that have no quote yet.
 */
export function buildCandidateDrafts(input: CandidateBuildInput): { drafts: CandidateDraft[]; notes: string[] } {
  const notes: string[] = [];
  const digits = input.digits;
  const allDigits = input.ticks.map((tick) => tick.digit);
  const counts = countsOf(allDigits);
  const source = selectProbabilitySource(input.ensemble, allDigits);
  const domains = resolveSupportDomain(input.support, input.durationTicks);
  const unsupported = domains.filter((domain) => !domain.supported).map((domain) => CONTRACT_LABELS[domain.contractType]);
  if (unsupported.length) notes.push(`Deriv did not report these contract types for the selected symbol and tick expiry: ${unsupported.join(', ')}.`);
  if (!domains.some((domain) => domain.supported)) {
    notes.push('No digit contract was reported for this symbol, so no candidate could be evaluated.');
    return { drafts: [], notes };
  }

  const drafts: CandidateDraft[] = [];
  for (const domain of domains) {
    if (!domain.supported) continue;
    const barriers: Array<number | null> = domain.contractType === 'DIGITEVEN' || domain.contractType === 'DIGITODD'
      ? [null]
      : domain.barriers;
    for (const barrier of barriers) {
      const event = eventForCandidate(domain.contractType, barrier);
      if (!event) continue;
      if (domain.contractType === 'DIGITOVER' || domain.contractType === 'DIGITUNDER') {
        if (input.restrictBarriersToResearchRange && (barrier === null || barrier < RESEARCH_BARRIER_MIN || barrier > RESEARCH_BARRIER_MAX)) continue;
      }
      if (barrierDigitsFor(domain.contractType, barrier) === null) {
        notes.push(`${CONTRACT_LABELS[domain.contractType]} ${barrier} is outside the domain Deriv can settle, so it was not evaluated.`);
        continue;
      }
      const posterior = dirichletEventEstimate(counts, event, { z: CREDIBLE_Z });
      const rawProbability = probabilityOfEvent(source.probabilities, event);
      // Uncertainty combines the posterior spread over the winning digits with
      // the disagreement between the fitted models.
      const dispersionInProbability = source.dispersion / 2;
      const uncertainty = Math.sqrt(posterior.standardDeviation ** 2 + dispersionInProbability ** 2);
      const probability = clamp(rawProbability, 0, 1);
      const lower = clamp(probability - CREDIBLE_Z * uncertainty, 0, 1);
      const upper = clamp(probability + CREDIBLE_Z * uncertainty, 0, 1);
      const key = candidateKey(domain.contractType, barrier);
      const reasons: string[] = [];
      const reasonCodes: ReasonCode[] = [];
      if (input.effectiveSample < input.minimumEffectiveSample) {
        reasons.push(`The effective sample of ${Math.round(input.effectiveSample)} digits is below the required ${input.minimumEffectiveSample}.`);
        reasonCodes.push('DATA_INSUFFICIENT');
      }
      if (input.precision === null) {
        reasons.push('Verified decimal precision is unavailable, so the final digit cannot be trusted.');
        reasonCodes.push('PRECISION_UNVERIFIED');
      }
      if (lower <= 0.1 && (domain.contractType === 'DIGITOVER' || domain.contractType === 'DIGITUNDER')) {
        reasons.push('The strict-boundary event cannot win often enough to be tradable at any realistic payout.');
        reasonCodes.push('BETTING_AGAINST_RANDOM');
      }

      const candidate: CandidateRecord = {
        id: key,
        family: FAMILY_OF_CONTRACT[domain.contractType],
        contractType: domain.contractType,
        symbol: input.symbol,
        barrier,
        targetDigit: domain.contractType === 'DIGITMATCH' ? barrier : null,
        winningCondition: describeEvent(event, CONTRACT_LABELS[domain.contractType]),
        estimatedProbability: probability,
        probabilityLowerBound: lower,
        probabilityUpperBound: upper,
        uncertainty,
        effectiveSample: input.effectiveSample,
        payout: null,
        stake: input.stake,
        netProfitIfWon: null,
        netLossIfLost: input.stake === null ? null : normalizeMoney(-input.stake),
        breakEvenProbability: null,
        expectedValue: null,
        conservativeExpectedValue: null,
        returnOnStake: null,
        dataQuality: input.dataQuality,
        modelValidated: source.validated,
        riskValidated: false,
        proposalVerified: false,
        eligible: false,
        rejectionReasons: reasons,
        reasonCodes,
        score: Number.NEGATIVE_INFINITY,
      };
      drafts.push({
        candidate,
        proposalRequest: {
          key,
          contractType: domain.contractType,
          barrier: barrier === null ? null : String(barrier),
          barrierDigit: barrier,
        },
      });
    }
  }
  return { drafts, notes };
}

/**
 * Applies real Deriv proposal terms to the drafts and decides eligibility.
 * This is the only place a payout, break-even rate or expected value is set.
 */
export function finalizeCandidates(
  drafts: readonly CandidateDraft[],
  proposals: Record<string, ProposalSnapshot>,
  config: { minProbabilityEdge: number },
): CandidateRecord[] {
  return drafts.map((draft) => {
    const candidate = draft.candidate;
    const proposal = proposals[draft.proposalRequest?.key ?? candidate.id];
    if (!proposal) {
      return {
        ...candidate,
        eligible: false,
        rejectionReasons: [...candidate.rejectionReasons, 'No current Deriv proposal was retrieved for this candidate.'],
        reasonCodes: [...candidate.reasonCodes, 'PAYOUT_MISSING'],
      };
    }
    const stake = proposal.askPrice;
    const economics = contractEconomics(
      { stake, payout: proposal.payout },
      candidate.estimatedProbability,
      candidate.probabilityLowerBound,
      config.minProbabilityEdge,
    );
    if (!economics) {
      return {
        ...candidate,
        payout: proposal.payout,
        stake,
        eligible: false,
        rejectionReasons: [...candidate.rejectionReasons, 'The proposal could not be converted into a payout and stake pair.'],
        reasonCodes: [...candidate.reasonCodes, 'PAYOUT_MISSING'],
      };
    }
    const reasons = [...candidate.rejectionReasons];
    const reasonCodes = [...candidate.reasonCodes];
    if (economics.conservativeProbability < economics.breakEvenProbability) {
      reasons.push(`The conservative probability ${(economics.conservativeProbability * 100).toFixed(1)}% is below the break-even rate ${(economics.breakEvenProbability * 100).toFixed(1)}%.`);
      reasonCodes.push('PROBABILITY_BELOW_BREAK_EVEN');
    }
    if (economics.conservativeProbability - economics.breakEvenProbability < config.minProbabilityEdge) {
      reasons.push(`The probability edge is below the configured minimum of ${(config.minProbabilityEdge * 100).toFixed(2)} percentage points.`);
      reasonCodes.push('UNCERTAINTY_TOO_WIDE');
    }
    if (economics.conservativeExpectedValue <= 0) {
      reasons.push('The expected value is not positive once probability uncertainty is taken into account.');
      reasonCodes.push('EXPECTED_VALUE_NEGATIVE');
    } else if (economics.expectedValue <= 0) {
      reasons.push('The central expected value is not positive at the quoted payout.');
      reasonCodes.push('EXPECTED_VALUE_NEGATIVE');
    } else {
      reasonCodes.push('EXPECTED_VALUE_POSITIVE');
    }
    if (candidate.probabilityUpperBound - candidate.probabilityLowerBound > 0.5) {
      reasons.push('The probability interval is wider than 50 percentage points, which is too uncertain to act on.');
      reasonCodes.push('UNCERTAINTY_TOO_WIDE');
    }
    const stakeWithinBalance = candidate.stake === null || Math.abs(stake - candidate.stake) <= Math.max(0.005, candidate.stake * 1e-4);
    if (!stakeWithinBalance) {
      reasons.push('The proposal stake differs from the stake that passed the risk checks.');
      reasonCodes.push('PROPOSAL_MISMATCH');
    }
    const uniqueReasons = [...new Set(reasons)];
    const uniqueCodes = [...new Set(reasonCodes)];
    // Uncertainty-aware score: conservative return per unit risked, penalised
    // for model disagreement. Never a raw win-rate ranking.
    const score = economics.conservativeReturnOnStake - 0.5 * candidate.uncertainty;
    return {
      ...candidate,
      stake,
      payout: economics.payout,
      netProfitIfWon: economics.netProfitIfWon,
      netLossIfLost: economics.netLossIfLost,
      breakEvenProbability: economics.breakEvenProbability,
      expectedValue: economics.expectedValue,
      conservativeExpectedValue: economics.conservativeExpectedValue,
      returnOnStake: economics.returnOnStake,
      proposalVerified: true,
      eligible: uniqueReasons.length === 0,
      rejectionReasons: uniqueReasons,
      reasonCodes: uniqueCodes,
      score,
    };
  });
}

/** Orders candidates: eligible first, then by uncertainty-aware score. */
export function rankCandidates(candidates: readonly CandidateRecord[]): CandidateRecord[] {
  return [...candidates].sort((left, right) =>
    Number(right.eligible) - Number(left.eligible)
    || right.score - left.score
    || right.conservativeExpectedValue! - left.conservativeExpectedValue!
    || left.id.localeCompare(right.id));
}

export function selectBestCandidate(candidates: readonly CandidateRecord[]): CandidateRecord | null {
  return rankCandidates(candidates).find((candidate) => candidate.eligible) ?? null;
}

/**
 * Chooses which candidates deserve a proposal request. Deriv is asked about a
 * bounded number of contracts per cycle to stay inside rate limits, and the
 * shortlist mixes the strongest estimates with the widest coverage so a high
 * probability/low payout contract cannot crowd out every alternative.
 */
export function shortlistForProposals(candidates: readonly CandidateRecord[], limit = 8): CandidateRecord[] {
  const byProbability = [...candidates].sort((left, right) => right.probabilityLowerBound - left.probabilityLowerBound);
  const picked = new Map<string, CandidateRecord>();
  const families: ContractFamily[] = ['even-odd', 'over-under', 'matches'];
  for (const family of families) {
    const best = byProbability.find((candidate) => candidate.family === family);
    if (best) picked.set(best.id, best);
  }
  for (const candidate of byProbability) {
    if (picked.size >= limit) break;
    picked.set(candidate.id, candidate);
  }
  return [...picked.values()];
}

export function summarizeRejections(candidates: readonly CandidateRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const code of candidate.reasonCodes) {
      if (candidate.eligible) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([code, count]) => `${code} · ${count} candidate${count === 1 ? '' : 's'}`);
}
