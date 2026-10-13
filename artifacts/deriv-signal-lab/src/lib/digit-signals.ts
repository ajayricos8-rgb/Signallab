import { evaluateHistoricalContract, supportedTickDurations, type DigitAnalysis, type DigitContractCandidate, type DigitObservation, type HistoricalContractOutcomes } from './digit-analysis.ts';
import type { DigitContractSupport, DigitMarketSymbol } from './deriv-digit-metadata.ts';

export type DigitFamily = 'over-under' | 'even-odd' | 'matches';
export type RankedCandidate = {
  contract: DigitContractCandidate;
  outcomes: HistoricalContractOutcomes;
  baseline: HistoricalContractOutcomes;
  label: string;
};

export const MINIMUM_DIGIT_TICKS = 500;
const MINIMUM_CONDITIONAL_OUTCOMES = 100;
export const FAMILY_CONTRACTS: Record<DigitFamily, string[]> = {
  'over-under': ['DIGITOVER', 'DIGITUNDER'],
  'even-odd': ['DIGITEVEN', 'DIGITODD'],
  matches: ['DIGITMATCH'],
};

type DigitRankingFeed = {
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
): { candidates: RankedCandidate[]; reason: string } {
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
    if (outcomes.sample < MINIMUM_CONDITIONAL_OUTCOMES || outcomes.smoothedHistoricalHitRate === null || baseline.empiricalHitRate === null) return;
    ranked.push({ contract, outcomes, baseline, label: candidateLabel(contract) });
  };

  if (family === 'over-under') {
    for (const contractType of FAMILY_CONTRACTS[family]) {
      for (const support of supportsAtDuration.filter((item) => item.contractType === contractType)) {
        for (const barrier of support.barriers) {
          if (!Number.isInteger(barrier) || barrier < 0 || barrier > 9) continue;
          if (contractType === 'DIGITOVER' && barrier >= 9) continue;
          if (contractType === 'DIGITUNDER' && barrier <= 0) continue;
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
  uniqueRanked.sort((left, right) => {
    const rateDifference = (right.outcomes.smoothedHistoricalHitRate ?? -Infinity) - (left.outcomes.smoothedHistoricalHitRate ?? -Infinity);
    return rateDifference || right.outcomes.sample - left.outcomes.sample || left.label.localeCompare(right.label);
  });
  if (!uniqueRanked.length) {
    if (family === 'over-under' && !supportsAtDuration.some((support) => support.barriers.length > 0)) {
      return { candidates: [], reason: 'Deriv did not provide a verifiable barrier list for this expiry; the engine will not guess barrier limits.' };
    }
    if (family === 'matches' && !supportsAtDuration.some((support) => support.targets.length > 0)) {
      return { candidates: [], reason: 'The valid Matches target-digit domain could not be verified for this contract response.' };
    }
    return { candidates: [], reason: `No candidate had ${MINIMUM_CONDITIONAL_OUTCOMES} conditional historical outcomes at ${selectedDuration} ticks.` };
  }
  return { candidates: uniqueRanked, reason: '' };
}


