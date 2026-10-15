import { evaluateHistoricalContract, supportedTickDurations, type DigitAnalysis, type DigitContractCandidate, type DigitObservation, type HistoricalContractOutcomes } from './digit-analysis.ts';
import type { DigitContractSupport, DigitMarketSymbol } from './deriv-digit-metadata.ts';
import { runOverUnderEnsemble, type OverUnderCandidateScore, type OverUnderContract, type OverUnderReport } from './over-under/ensemble.ts';
import { buildConsensus, clamp01, pickMajority, type ConsensusSignal, type EngineVote } from './engine-consensus.ts';
import { evenOddCouncil, matchesCouncil, overUnderAiVote, overUnderCouncil } from './digit-engines.ts';

export type DigitFamily = 'over-under' | 'even-odd' | 'matches';
export type RankedCandidate = {
  contract: DigitContractCandidate;
  outcomes: HistoricalContractOutcomes;
  baseline: HistoricalContractOutcomes;
  label: string;
  ensemble?: OverUnderCandidateScore;
};

export type DigitRankingResult = {
  candidates: RankedCandidate[];
  reason: string;
  /** Always present after a completed scan with at least one candidate. */
  signal: ConsensusSignal | null;
  overUnder?: OverUnderReport;
};

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

function conditionalContext(family: DigitFamily, latestDigit: number | null): { digit?: number; parity?: 0 | 1 } | null {
  if (latestDigit === null) return null;
  if (family === 'even-odd') return { parity: (latestDigit % 2) as 0 | 1 };
  return { digit: latestDigit };
}

/** Evidence bonus (0..1) blended into the consensus confidence score. */
function outcomeEvidence(candidate: RankedCandidate): number {
  const conditioned = candidate.outcomes.empiricalHitRate;
  const baseline = candidate.baseline.empiricalHitRate;
  const lift = conditioned !== null && baseline !== null ? conditioned - baseline : 0;
  const sampleFactor = clamp01(candidate.outcomes.sample / 250);
  return clamp01(0.35 + lift * 3 + 0.25 * sampleFactor);
}

function overUnderSignal(overUnder: OverUnderReport): ConsensusSignal | null {
  const top = overUnder.selected ?? overUnder.candidates[0] ?? null;
  if (!top) return null;
  const contract: OverUnderContract = top.contract;
  const label = `${contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${contract.barrier}`;
  const votes: EngineVote[] = [...overUnderCouncil(overUnder, contract), overUnderAiVote(overUnder, contract)];
  const evidence = top.eligible
    ? clamp01(0.55 + Math.max(0, top.validationSkill ?? 0))
    : clamp01(0.3 + Math.max(0, top.lift) * 4 + (top.agreement - 0.5) * 0.4);
  return buildConsensus(votes, label, {
    evidence,
    note: top.eligible
      ? 'All chronological held-out gates passed for this barrier.'
      : top.reasons[0] ?? 'Barrier leads the ranking on baseline-relative evidence.',
  });
}

export function runResearchRanking(
  family: DigitFamily,
  feed: DigitRankingFeed,
  analysis: DigitAnalysis,
  selectedDuration: number | null,
  onProgress?: (percent: number, stage: string) => void,
): DigitRankingResult {
  const report = (percent: number, stage: string) => onProgress?.(Math.max(0, Math.min(100, Math.round(percent))), stage);
  report(6, 'Validating market data');
  const latestDigit = analysis.lastDigit;
  const blocked = (reason: string): DigitRankingResult => ({ candidates: [], reason, signal: null });
  if (!feed.selectedMarket) return blocked('No selected symbol metadata is available.');
  if (!feed.contractsLoaded) return blocked('Waiting for Deriv to verify the selected symbol’s available contracts.');
  if (!feed.historyLoaded || feed.ticks.length < MINIMUM_DIGIT_TICKS) {
    return blocked(`At least ${MINIMUM_DIGIT_TICKS} validated digit ticks are required.`);
  }
  if (!feed.fresh) return blocked('Live tick freshness is not confirmed; this scan is not eligible.');
  if (feed.precisionError || feed.selectedMarket.precision === null) {
    return blocked(feed.precisionError || 'Verified decimal precision is unavailable.');
  }
  if (feed.selectedMarket.tradingSuspended === true) return blocked('Deriv reports that trading is suspended for this symbol.');
  if (feed.selectedMarket.exchangeOpen === false) return blocked('Deriv reports that the selected market is closed.');
  if (latestDigit === null) return blocked('No validated final digit is available.');
  if (selectedDuration === null) return blocked('Choose a tick expiry reported by Deriv; the engine does not infer a duration.');
  if (!Number.isInteger(selectedDuration) || selectedDuration < 1) {
    return blocked('The selected tick expiry is invalid.');
  }

  const context = conditionalContext(family, latestDigit);
  if (!context) return blocked('The current digit context is unavailable.');
  const supportedContracts = FAMILY_CONTRACTS[family].flatMap((contractType) => familySupports(feed, contractType));
  if (!supportedContracts.length) return blocked('Deriv did not report the required digit contract for this symbol.');
  const supportsAtDuration = supportedContracts.filter((support) =>
    supportedTickDurations(support.minDuration, support.maxDuration).includes(selectedDuration),
  );
  if (!supportsAtDuration.length) {
    return blocked(`Deriv did not report ${selectedDuration} ticks as a supported expiry for this contract family.`);
  }

  report(18, 'Evaluating contract markets');
  const ranked: RankedCandidate[] = [];
  const addCandidate = (contract: DigitContractCandidate, support: DigitContractSupport) => {
    if (!supportedTickDurations(support.minDuration, support.maxDuration).includes(selectedDuration)) return;
    const outcomes = evaluateHistoricalContract(feed.ticks, contract, selectedDuration, context);
    const baseline = evaluateHistoricalContract(feed.ticks, contract, selectedDuration);
    if (family !== 'over-under' && (outcomes.sample < MINIMUM_CONDITIONAL_OUTCOMES || outcomes.smoothedHistoricalHitRate === null || baseline.empiricalHitRate === null)) return;
    ranked.push({ contract, outcomes, baseline, label: candidateLabel(contract) });
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
  report(45, 'Fitting engines on validated digits');

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
    if (!uniqueRanked.length) return blocked('Deriv did not report any supported barrier in the required 1–8 research range at this expiry.');
    const contracts = uniqueRanked.map((candidate) => candidate.contract).filter((contract): contract is OverUnderContract => contract.family === 'over-under');
    const overUnder = runOverUnderEnsemble(feed.ticks, selectedDuration, contracts, (percent, stage) => report(45 + percent * 0.5, stage));
    const candidates = overUnder.candidates.map((score) => ({
      ...uniqueRanked.find((candidate) => candidate.contract.family === 'over-under' && candidate.contract.contractType === score.contract.contractType && candidate.contract.barrier === score.contract.barrier)!,
      ensemble: score,
    }));
    report(96, 'Building consensus signal');
    const signal = overUnderSignal(overUnder);
    report(100, 'Signal ready');
    return { candidates, reason: overUnder.reason, signal, overUnder };
  }

  uniqueRanked.sort((left, right) => {
    const rateDifference = (right.outcomes.smoothedHistoricalHitRate ?? -Infinity) - (left.outcomes.smoothedHistoricalHitRate ?? -Infinity);
    return rateDifference || right.outcomes.sample - left.outcomes.sample || left.label.localeCompare(right.label);
  });
  if (!uniqueRanked.length) {
    if (family === 'matches' && !supportsAtDuration.some((support) => support.targets.length > 0)) {
      return blocked('The valid Matches target-digit domain could not be verified for this contract response.');
    }
    return blocked(`No candidate had ${MINIMUM_CONDITIONAL_OUTCOMES} conditional historical outcomes at ${selectedDuration} ticks.`);
  }

  report(70, 'Running the engine council');
  const top = uniqueRanked[0];
  const votes = family === 'even-odd'
    ? evenOddCouncil(analysis, feed.ticks, selectedDuration)
    : matchesCouncil(analysis, feed.ticks, selectedDuration);
  report(88, 'Counting engine agreement');
  const side = pickMajority(votes);
  // The emitted signal follows the engine council majority; the ranked
  // candidates remain the historical-evidence view.
  const label = side ?? top.label;
  const signal = buildConsensus(votes, label, {
    evidence: outcomeEvidence(top),
    note: side && side !== top.label
      ? `The engine council leans ${side}; the historical ranking leads with ${top.label}.`
      : `Leads the historical ranking at ${selectedDuration} ticks with ${top.outcomes.hits}/${top.outcomes.sample} conditioned hits.`,
  });
  report(100, 'Signal ready');
  return { candidates: uniqueRanked, reason: '', signal };
}


