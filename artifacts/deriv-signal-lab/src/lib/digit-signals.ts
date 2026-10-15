import { evaluateHistoricalContract, supportedTickDurations, type DigitAnalysis, type DigitContractCandidate, type DigitObservation, type HistoricalContractOutcomes } from './digit-analysis.ts';
import type { DigitContractSupport, DigitMarketSymbol } from './deriv-digit-metadata.ts';
import { runOverUnderEnsemble, type OverUnderCandidateScore, type OverUnderReport } from './over-under/ensemble.ts';
import { buildDigitQuantContext, digitConsensus, type DigitQuantContext } from './digit-consensus.ts';
import { emptyConsensus, type SignalConsensus } from './signal-confidence.ts';

export type DigitFamily = 'over-under' | 'even-odd' | 'matches';
export type RankedCandidate = {
  contract: DigitContractCandidate;
  outcomes: HistoricalContractOutcomes;
  baseline: HistoricalContractOutcomes;
  label: string;
  ensemble?: OverUnderCandidateScore;
  /** True when every evidence gate for this family passed. */
  qualified: boolean;
  /** Gate failures that keep this candidate diagnostic-only. */
  gateReasons: string[];
  /** Engine votes, agreement counts and the evidence confidence score. */
  consensus: SignalConsensus;
};

export type DigitRankingResult = {
  candidates: RankedCandidate[];
  reason: string;
  overUnder?: OverUnderReport;
  /** Best-ranked candidate. Present whenever the scan could evaluate anything. */
  signal: RankedCandidate | null;
  /** True when a hard data gate stopped the scan before any evaluation. */
  blocked: boolean;
};

/** Progress reporter so the UI can show a real percentage during a scan. */
export type RankingProgress = (percent: number, phase: string) => void;

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

/** Hard data gates: these stop the scan before any candidate can be measured. */
function blockingReason(feed: DigitRankingFeed, latestDigit: number | null, selectedDuration: number | null): string {
  if (!feed.selectedMarket) return 'No selected symbol metadata is available.';
  if (!feed.contractsLoaded) return 'Waiting for Deriv to verify the selected symbol’s available contracts.';
  if (!feed.historyLoaded || feed.ticks.length < MINIMUM_DIGIT_TICKS) {
    return `Collecting validated digit ticks: ${feed.ticks.length} of ${MINIMUM_DIGIT_TICKS} required. Analysis starts as soon as the history arrives.`;
  }
  if (!feed.fresh) return 'Live tick freshness is not confirmed; reconnect the feed and run analysis again.';
  if (feed.precisionError || feed.selectedMarket.precision === null) {
    return feed.precisionError || 'Verified decimal precision is unavailable.';
  }
  if (feed.selectedMarket.tradingSuspended === true) return 'Deriv reports that trading is suspended for this symbol.';
  if (feed.selectedMarket.exchangeOpen === false) return 'Deriv reports that the selected market is closed.';
  if (latestDigit === null) return 'No validated final digit is available.';
  if (selectedDuration === null) return 'Choose a tick expiry reported by Deriv; the engine does not infer a duration.';
  if (!Number.isInteger(selectedDuration) || selectedDuration < 1) return 'The selected tick expiry is invalid.';
  return '';
}

export function runResearchRanking(
  family: DigitFamily,
  feed: DigitRankingFeed,
  analysis: DigitAnalysis,
  selectedDuration: number | null,
  onProgress?: RankingProgress,
): DigitRankingResult {
  const report: RankingProgress = typeof onProgress === 'function' ? onProgress : () => {};
  report(2, 'Checking data quality gates');
  const latestDigit = analysis.lastDigit;
  const blocked = blockingReason(feed, latestDigit, selectedDuration);
  if (blocked) return { candidates: [], reason: blocked, signal: null, blocked: true };

  const duration = selectedDuration!;
  const context = conditionalContext(family, latestDigit)!;
  report(5, `Collecting Deriv-supported ${family === 'over-under' ? 'barriers' : family === 'even-odd' ? 'parity contracts' : 'target digits'}`);
  const supportedContracts = FAMILY_CONTRACTS[family].flatMap((contractType) => familySupports(feed, contractType));
  if (!supportedContracts.length) return { candidates: [], reason: 'Deriv did not report the required digit contract for this symbol.', signal: null, blocked: true };
  const supportsAtDuration = supportedContracts.filter((support) =>
    supportedTickDurations(support.minDuration, support.maxDuration).includes(duration),
  );
  if (!supportsAtDuration.length) {
    return { candidates: [], reason: `Deriv did not report ${duration} ticks as a supported expiry for this contract family.`, signal: null, blocked: true };
  }

  report(8, 'Fitting the deep quantitative engines and AI synthesis');
  const digits = feed.ticks.map((tick) => tick.digit);
  const quant: DigitQuantContext | null = buildDigitQuantContext(family, digits);

  const ranked: RankedCandidate[] = [];
  let evaluated = 0;
  let planned = 0;
  const addCandidate = (contract: DigitContractCandidate, support: DigitContractSupport) => {
    if (!supportedTickDurations(support.minDuration, support.maxDuration).includes(duration)) return;
    planned += 1;
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
  if (!planned) {
    return {
      candidates: [],
      reason: family === 'over-under'
        ? 'Deriv did not report any supported barrier in the required 1–8 research range at this expiry.'
        : `Deriv did not report any supported ${family === 'even-odd' ? 'parity contract' : 'target digit'} at ${duration} ticks.`,
      signal: null,
      blocked: true,
    };
  }

  /** Measure one contract against history and score its engine consensus. */
  const measure = (contract: DigitContractCandidate, fromPercent = 8, toPercent = 30): RankedCandidate | null => {
    const outcomes = evaluateHistoricalContract(feed.ticks, contract, duration, context);
    const baseline = evaluateHistoricalContract(feed.ticks, contract, duration);
    const gateReasons: string[] = [];
    if (family !== 'over-under') {
      if (outcomes.sample < MINIMUM_CONDITIONAL_OUTCOMES) gateReasons.push(`Only ${outcomes.sample} conditional historical outcomes at ${duration} ticks; ${MINIMUM_CONDITIONAL_OUTCOMES} required.`);
      if (outcomes.smoothedHistoricalHitRate === null) gateReasons.push('No smoothed historical hit rate could be computed.');
      if (baseline.empiricalHitRate === null) gateReasons.push('No all-history base rate could be computed.');
    }
    evaluated += 1;
    report(fromPercent + (toPercent - fromPercent) * Math.min(1, evaluated / Math.max(1, planned)), `Measuring ${duration}-tick outcomes · ${evaluated}/${planned} contracts`);
    return {
      contract,
      outcomes,
      baseline,
      label: candidateLabel(contract),
      qualified: gateReasons.length === 0,
      gateReasons,
      consensus: emptyConsensus('Pending engine consensus.'),
    };
  };

  if (family === 'over-under') {
    report(30, `Fitting twelve models for the ${duration}-tick expiry`);
    const uniqueContracts = new Map<string, OverUnderCandidateScore['contract']>();
    for (const support of supportsAtDuration) {
      const contractType = support.contractType;
      if (contractType !== 'DIGITOVER' && contractType !== 'DIGITUNDER') continue;
      for (const barrier of support.barriers) {
        // Research stays inside the requested 1–8 domain even when Deriv also
        // allows the edge barriers 0 and 9 for a manual contract.
        if (!Number.isInteger(barrier) || barrier < 1 || barrier > 8) continue;
        uniqueContracts.set(`${contractType}:${barrier}`, { family: 'over-under', contractType, barrier });
      }
    }
    const contracts = [...uniqueContracts.values()];
    if (!contracts.length) {
      return { candidates: [], reason: 'Deriv did not report any supported barrier in the required 1–8 research range at this expiry.', signal: null, blocked: true };
    }
    const overUnder = runOverUnderEnsemble(feed.ticks, duration, contracts, (percent, phase) => report(30 + 0.6 * percent, phase));
    report(92, 'Merging engine votes and scoring confidence');
    const candidates: RankedCandidate[] = overUnder.candidates.map((score) => {
      const measured = measure(score.contract, 92, 96)!;
      const ensembleReasons = score.eligible ? [] : [...score.reasons];
      const gateReasons = [...new Set([...measured.gateReasons, ...ensembleReasons])];
      const consensus = digitConsensus({
        family,
        label: measured.label,
        contract: score.contract,
        outcomes: measured.outcomes,
        baseline: measured.baseline,
        analysis,
        digits,
        quant,
        qualified: score.eligible && gateReasons.length === 0,
        gateReasons,
        ensembleVotes: score.votes,
        ensembleFactors: score.factors,
        familiesTotal: 10,
      });
      return { ...measured, ensemble: score, qualified: score.eligible && gateReasons.length === 0, gateReasons, consensus };
    });
    report(98, 'Publishing the signal');
    return { candidates, reason: overUnder.reason, overUnder, signal: candidates[0] ?? null, blocked: false };
  }

  const measured = (() => {
    const rows: RankedCandidate[] = [];
    if (family === 'even-odd') {
      for (const contractType of FAMILY_CONTRACTS[family]) {
        for (const support of supportsAtDuration.filter((item) => item.contractType === contractType)) {
          const row = measure({ family, contractType: contractType as 'DIGITEVEN' | 'DIGITODD' });
          if (row) rows.push(row);
        }
      }
    } else {
      for (const support of supportsAtDuration.filter((item) => item.contractType === 'DIGITMATCH')) {
        for (const targetDigit of support.targets) {
          if (!Number.isInteger(targetDigit) || targetDigit < 0 || targetDigit > 9) continue;
          const row = measure({ family, contractType: 'DIGITMATCH', targetDigit });
          if (row) rows.push(row);
        }
      }
    }
    return rows;
  })();

  report(32, 'Scoring engine consensus and confidence');
  const withConsensus = measured.map((candidate) => ({
    ...candidate,
    consensus: digitConsensus({
      family,
      label: candidate.label,
      contract: candidate.contract,
      outcomes: candidate.outcomes,
      baseline: candidate.baseline,
      analysis,
      digits,
      quant,
      qualified: candidate.qualified,
      gateReasons: candidate.gateReasons,
      familiesTotal: 6,
    }),
  }));

  const uniqueRanked = [...new Map(withConsensus.map((candidate) => {
    const contract = candidate.contract;
    const discriminator = contract.family === 'matches' ? `${contract.contractType}:${contract.targetDigit}` : contract.contractType;
    return [`${contract.family}:${discriminator}:${candidate.outcomes.durationTicks}`, candidate];
  })).values()];

  if (!uniqueRanked.length) {
    if (family === 'matches' && !supportsAtDuration.some((support) => support.targets.length > 0)) {
      return { candidates: [], reason: 'The valid Matches target-digit domain could not be verified for this contract response.', signal: null, blocked: true };
    }
    return { candidates: [], reason: `No candidate could be measured at ${duration} ticks.`, signal: null, blocked: true };
  }

  // Qualified candidates lead; inside each group the strongest measured evidence
  // and the highest engine confidence decide the order, so a signal is always
  // published instead of a bare WAIT.
  uniqueRanked.sort((left, right) =>
    Number(right.qualified) - Number(left.qualified)
    || right.consensus.confidence - left.consensus.confidence
    || (right.outcomes.smoothedHistoricalHitRate ?? -Infinity) - (left.outcomes.smoothedHistoricalHitRate ?? -Infinity)
    || right.outcomes.sample - left.outcomes.sample
    || left.label.localeCompare(right.label));

  const unqualified = uniqueRanked.filter((candidate) => !candidate.qualified);
  report(98, 'Publishing the signal');
  return {
    candidates: uniqueRanked,
    reason: unqualified.length === uniqueRanked.length
      ? `${uniqueRanked[0].label} leads on measured evidence, but ${uniqueRanked[0].gateReasons[0] ?? 'no candidate met every evidence gate'}`
      : '',
    signal: uniqueRanked[0] ?? null,
    blocked: false,
  };
}
