import { evaluateHistoricalContract, supportedTickDurations, type DigitAnalysis, type DigitContractCandidate, type DigitObservation, type HistoricalContractOutcomes } from './digit-analysis.ts';
import type { DigitContractSupport, DigitMarketSymbol } from './deriv-digit-metadata.ts';
import { assessExpectedValue, discountedEdgeProbability, evidenceReliability, type EvAssessment } from './ev-confidence.ts';
import { runOverUnderEnsemble, type OverUnderCandidateScore, type OverUnderReport } from './over-under/ensemble.ts';

export type DigitFamily = 'over-under' | 'even-odd' | 'matches';
export type RankedCandidate = {
  contract: DigitContractCandidate;
  outcomes: HistoricalContractOutcomes;
  baseline: HistoricalContractOutcomes;
  label: string;
  ensemble?: OverUnderCandidateScore;
  /**
   * EV-derived confidence behind this candidate. For Over/Under it is the
   * ensemble's own assessment; for Even/Odd and Matches it is computed from the
   * conditioned historical rate against the zero-margin fair price of the
   * contract's all-history baseline.
   */
  ev: EvAssessment | null;
};

export type DigitRankingResult = { candidates: RankedCandidate[]; reason: string; overUnder?: OverUnderReport };

export const MINIMUM_DIGIT_TICKS = 500;
const MINIMUM_CONDITIONAL_OUTCOMES = 100;
export const FAMILY_CONTRACTS: Record<DigitFamily, string[]> = {
  'over-under': ['DIGITOVER', 'DIGITUNDER'],
  'even-odd': ['DIGITEVEN', 'DIGITODD'],
  matches: ['DIGITMATCH'],
};

export type DigitRankingFeed = {
  selectedMarket: DigitMarketSymbol | null;
  contractsLoaded: boolean;
  historyLoaded: boolean;
  fresh: boolean;
  precisionError: string;
  ticks: DigitObservation[];
  contracts: DigitContractSupport[];
};

export function candidateLabel(candidate: DigitContractCandidate): string {
  if (candidate.family === 'over-under') return `${candidate.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${candidate.barrier}`;
  if (candidate.family === 'even-odd') return candidate.contractType === 'DIGITEVEN' ? 'EVEN' : 'ODD';
  return `MATCH ${candidate.targetDigit}`;
}

export function contractDisplayLabel(candidate: DigitContractCandidate): string {
  return candidate.family === 'over-under' ? `${candidateLabel(candidate)} · strict barrier` : candidateLabel(candidate);
}

function familySupports(feed: DigitRankingFeed, contractType: string): DigitContractSupport[] {
  return feed.contracts.filter((contract) => contract.contractType === contractType && contract.expiryType.toLowerCase() === 'tick');
}

/**
 * EV assessment for one conditioned historical candidate. The reference rate is
 * the contract's own all-history hit rate — the zero-margin fair price the
 * research surface assumes — and the conservative probability discounts the
 * condition's edge by its sampling error before the expected value is taken.
 */
function assessHistoricalCandidate(
  family: DigitFamily,
  outcomes: HistoricalContractOutcomes,
  baseline: HistoricalContractOutcomes,
): EvAssessment | null {
  const probability = outcomes.smoothedHistoricalHitRate;
  if (probability === null) return null;
  const observed = baseline.empiricalHitRate;
  const uniformReference = family === 'even-odd' ? 0.5 : family === 'matches' ? 0.1 : null;
  const referenceProbability = observed !== null && observed > 0.001 && observed < 0.999
    ? observed
    : uniformReference;
  if (referenceProbability === null) return null;
  const conservative = discountedEdgeProbability({
    probability,
    referenceProbability,
    sample: outcomes.sample,
    referenceSample: baseline.sample,
  }) ?? probability;
  const reliability = evidenceReliability({ sample: outcomes.sample, sampleTarget: 200, structureStable: true });
  return assessExpectedValue({ probability, referenceProbability, conservativeProbability: conservative, reliability });
}

/** Highest expected value first: the ranking is the EV ranking, not the hit rate. */
function expectedValueOf(candidate: RankedCandidate): number {
  const ev = candidate.ev;
  if (!ev) return -Infinity;
  return ev.conservativeExpectedValuePerStake ?? ev.expectedValuePerStake;
}

function conditionalContext(family: DigitFamily, latestDigit: number | null): { digit?: number; parity?: 0 | 1 } | null {
  if (latestDigit === null) return null;
  if (family === 'even-odd') return { parity: (latestDigit % 2) as 0 | 1 };
  return { digit: latestDigit };
}

export function runResearchRanking(
  family: DigitFamily,
  feed: DigitRankingFeed,
  analysis: DigitAnalysis,
  selectedDuration: number | null,
): DigitRankingResult {
  const latestDigit = analysis.lastDigit;
  if (!feed.selectedMarket) return { candidates: [], reason: 'No selected symbol metadata is available.' };
  if (!feed.contractsLoaded) return { candidates: [], reason: 'Waiting for Deriv to verify the selected symbol’s available contracts.' };
  if (!feed.historyLoaded || feed.ticks.length < MINIMUM_DIGIT_TICKS) {
    return { candidates: [], reason: `At least ${MINIMUM_DIGIT_TICKS} validated digit ticks are required.` };
  }
  if (!feed.fresh) return { candidates: [], reason: 'Live tick freshness is not confirmed; this scan is not eligible.' };
  if (feed.precisionError || feed.selectedMarket.precision === null) {
    return { candidates: [], reason: feed.precisionError || 'Verified decimal precision is unavailable.' };
  }
  if (feed.selectedMarket.tradingSuspended === true) return { candidates: [], reason: 'Deriv reports that trading is suspended for this symbol.' };
  if (feed.selectedMarket.exchangeOpen === false) return { candidates: [], reason: 'Deriv reports that the selected market is closed.' };
  if (latestDigit === null) return { candidates: [], reason: 'No validated final digit is available.' };
  if (selectedDuration === null) return { candidates: [], reason: 'Choose a tick expiry reported by Deriv; the engine does not infer a duration.' };
  if (!Number.isInteger(selectedDuration) || selectedDuration < 1) {
    return { candidates: [], reason: 'The selected tick expiry is invalid.' };
  }

  const context = conditionalContext(family, latestDigit);
  if (!context) return { candidates: [], reason: 'The current digit context is unavailable.' };
  const supportedContracts = FAMILY_CONTRACTS[family].flatMap((contractType) => familySupports(feed, contractType));
  if (!supportedContracts.length) return { candidates: [], reason: 'Deriv did not report the required digit contract for this symbol.' };
  const supportsAtDuration = supportedContracts.filter((support) =>
    supportedTickDurations(support.minDuration, support.maxDuration).includes(selectedDuration),
  );
  if (!supportsAtDuration.length) {
    return { candidates: [], reason: `Deriv did not report ${selectedDuration} ticks as a supported expiry for this contract family.` };
  }

  const ranked: RankedCandidate[] = [];
  const addCandidate = (contract: DigitContractCandidate, support: DigitContractSupport) => {
    if (!supportedTickDurations(support.minDuration, support.maxDuration).includes(selectedDuration)) return;
    const outcomes = evaluateHistoricalContract(feed.ticks, contract, selectedDuration, context);
    const baseline = evaluateHistoricalContract(feed.ticks, contract, selectedDuration);
    if (family !== 'over-under' && (outcomes.sample < MINIMUM_CONDITIONAL_OUTCOMES || outcomes.smoothedHistoricalHitRate === null || baseline.empiricalHitRate === null)) return;
    ranked.push({
      contract, outcomes, baseline, label: candidateLabel(contract),
      ev: family === 'over-under' ? null : assessHistoricalCandidate(family, outcomes, baseline),
    });
  };

  if (family === 'over-under') {
    for (const contractType of FAMILY_CONTRACTS[family]) {
      for (const support of supportsAtDuration.filter((item) => item.contractType === contractType)) {
        for (const barrier of support.barriers) {
          // Research is strictly limited to the requested 1–8 domain, even
          // when Deriv also allows edge barriers for a manual contract.
          if (!Number.isInteger(barrier) || barrier < 1 || barrier > 8) continue;
          addCandidate({ family, contractType: contractType as 'DIGITOVER' | 'DIGITUNDER', barrier }, support);
        }
      }
    }
  } else if (family === 'even-odd') {
    for (const contractType of FAMILY_CONTRACTS[family]) {
      for (const support of supportsAtDuration.filter((item) => item.contractType === contractType)) {
        addCandidate({ family, contractType: contractType as 'DIGITEVEN' | 'DIGITODD' }, support);
      }
    }
  } else {
    for (const support of supportsAtDuration.filter((item) => item.contractType === 'DIGITMATCH')) {
      for (const targetDigit of support.targets) {
        if (!Number.isInteger(targetDigit) || targetDigit < 0 || targetDigit > 9) continue;
        addCandidate({ family, contractType: 'DIGITMATCH', targetDigit }, support);
      }
    }
  }

  const uniqueRanked = [...new Map(ranked.map((candidate) => {
    const contract = candidate.contract;
    const discriminator = contract.family === 'over-under'
      ? `${contract.contractType}:${contract.barrier}`
      : contract.family === 'matches'
        ? `${contract.contractType}:${contract.targetDigit}`
        : contract.contractType;
    return [`${contract.family}:${discriminator}:${candidate.outcomes.durationTicks}`, candidate];
  })).values()];
  if (family === 'over-under') {
    if (!uniqueRanked.length) return { candidates: [], reason: 'Deriv did not report any supported barrier in the required 1–8 research range at this expiry.' };
    const contracts = uniqueRanked.map((candidate) => candidate.contract).filter((contract) => contract.family === 'over-under');
    const overUnder = runOverUnderEnsemble(feed.ticks, selectedDuration, contracts);
    const candidates = overUnder.candidates.map((score) => ({
      ...uniqueRanked.find((candidate) => candidate.contract.family === 'over-under' && candidate.contract.contractType === score.contract.contractType && candidate.contract.barrier === score.contract.barrier)!,
      ensemble: score,
      ev: score.ev,
    }));
    return { candidates, reason: overUnder.reason, overUnder };
  }

  uniqueRanked.sort((left, right) => {
    const valueDifference = expectedValueOf(right) - expectedValueOf(left);
    if (Number.isFinite(valueDifference) && valueDifference !== 0) return valueDifference;
    const rateDifference = (right.outcomes.smoothedHistoricalHitRate ?? -Infinity) - (left.outcomes.smoothedHistoricalHitRate ?? -Infinity);
    return rateDifference || right.outcomes.sample - left.outcomes.sample || left.label.localeCompare(right.label);
  });
  if (!uniqueRanked.length) {
    if (family === 'matches' && !supportsAtDuration.some((support) => support.targets.length > 0)) {
      return { candidates: [], reason: 'The valid Matches target-digit domain could not be verified for this contract response.' };
    }
    return { candidates: [], reason: `No candidate had ${MINIMUM_CONDITIONAL_OUTCOMES} conditional historical outcomes at ${selectedDuration} ticks.` };
  }
  return { candidates: uniqueRanked, reason: '' };
}


