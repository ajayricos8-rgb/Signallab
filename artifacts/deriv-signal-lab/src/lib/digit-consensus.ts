/**
 * Digit consensus — every engine and every AI synthesiser votes on one signal.
 *
 * The Over/Under ensemble already fits twelve models across eight families. This
 * module adds the evidence sources that were previously rendered only as
 * descriptive side panels (the deep quantitative engines and the rule-based AI
 * synthesis) and turns them into counted votes, so a completed scan can always
 * report:
 *
 *   · the signal itself,
 *   · how many engines agreed (and how many engine families),
 *   · an evidence confidence score with a per-factor breakdown.
 *
 * Nothing here invents probabilities. Every vote is derived from validated
 * ticks: observed frequencies, conditioned transitions, run-conditioned
 * follow-through, distribution drift and held-out model skill. Engines with too
 * little evidence abstain instead of guessing, and abstentions stay visible in
 * the UI. Confidence is an evidence score, never a win probability.
 */
import type { DigitAnalysis, DigitContractCandidate, HistoricalContractOutcomes } from './digit-analysis.ts';
import { analyzeEvenOdd, type EvenOddMetrics } from './quant/even-odd.ts';
import { analyzeMatches, type MatchesMetrics } from './quant/matches.ts';
import { analyzeOverUnder, type OverUnderMetrics } from './quant/over-under.ts';
import { evenOddInsight, matchesInsight, overUnderInsight, type Insight } from './quant/ai-insights.ts';
import {
  buildConsensus,
  clamp01,
  confidenceFactor,
  engineVote,
  scale,
  type ConfidenceFactor,
  type EngineVote,
  type SignalConsensus,
  type VoteStance,
} from './signal-confidence.ts';

export type DigitConsensusFamily = 'over-under' | 'even-odd' | 'matches';

const ALL_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const LONG_WINDOW = 1_000;
const RECENT_WINDOW = 120;
/** Minimum historical repeats before the run-structure engine will vote. */
const MINIMUM_RUN_REPEATS = 25;
/** Minimum transitions from the live context before the Markov engine votes. */
const MINIMUM_CONTEXT_TRANSITIONS = 20;

export type DigitQuantContext = {
  family: DigitConsensusFamily;
  insight: Insight;
  sample: number;
  overUnder?: { recent: OverUnderMetrics; long: OverUnderMetrics };
  evenOdd?: { recent: EvenOddMetrics; long: EvenOddMetrics };
  matches?: { metrics: MatchesMetrics; orderTwo: Record<string, number[]> };
};

/** Digits that settle a win for this contract, using Deriv's strict rules. */
export function winningDigits(contract: DigitContractCandidate): number[] {
  if (contract.family === 'over-under') {
    return ALL_DIGITS.filter((digit) => contract.contractType === 'DIGITOVER' ? digit > contract.barrier : digit < contract.barrier);
  }
  if (contract.family === 'even-odd') {
    const wantEven = contract.contractType === 'DIGITEVEN';
    return ALL_DIGITS.filter((digit) => (digit % 2 === 0) === wantEven);
  }
  return [contract.targetDigit];
}

/** Probability of a win when every digit is equally likely. */
export function uniformWinRate(contract: DigitContractCandidate): number {
  return winningDigits(contract).length / ALL_DIGITS.length;
}

/** Plain-language name of the outcome this contract wins on. */
export function contractNoun(contract: DigitContractCandidate): string {
  if (contract.family === 'over-under') return `${contract.contractType === 'DIGITOVER' ? 'Over' : 'Under'} barrier ${contract.barrier}`;
  if (contract.family === 'even-odd') return contract.contractType === 'DIGITEVEN' ? 'Even digits' : 'Odd digits';
  return `Digit ${contract.targetDigit}`;
}

function orderTwoConditionals(digits: readonly number[]): Record<string, number[]> {
  const table: Record<string, number[]> = {};
  for (let index = 2; index < digits.length; index += 1) {
    const key = `${digits[index - 2]}${digits[index - 1]}`;
    const row = table[key] ?? (table[key] = Array.from({ length: 10 }, () => 0));
    row[digits[index]] += 1;
  }
  return table;
}

/** Fit the deep quantitative engines and the AI synthesis once per scan. */
export function buildDigitQuantContext(family: DigitConsensusFamily, digits: readonly number[]): DigitQuantContext | null {
  const long = digits.slice(-LONG_WINDOW);
  const recent = digits.slice(-RECENT_WINDOW);
  if (long.length < 50) return null;
  if (family === 'over-under') {
    const longMetrics = analyzeOverUnder(long);
    return { family, insight: overUnderInsight(longMetrics), sample: long.length, overUnder: { recent: analyzeOverUnder(recent), long: longMetrics } };
  }
  if (family === 'even-odd') {
    const longMetrics = analyzeEvenOdd(long);
    return { family, insight: evenOddInsight(longMetrics), sample: long.length, evenOdd: { recent: analyzeEvenOdd(recent), long: longMetrics } };
  }
  const metrics = analyzeMatches(long);
  return { family, insight: matchesInsight(metrics), sample: long.length, matches: { metrics, orderTwo: orderTwoConditionals(long) } };
}

function rateOf(frequencies: Array<number | null> | null | undefined, winners: readonly number[]): number | null {
  if (!frequencies) return null;
  let total = 0;
  for (const digit of winners) {
    const value = frequencies[digit];
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    total += value;
  }
  return clamp01(total);
}

type Reading = { stance: VoteStance; strength: number };

/** Compare an observed rate with its reference using scale-relative margins. */
function readRate(rate: number | null, reference: number): Reading {
  if (rate === null || !Number.isFinite(reference)) return { stance: 'neutral', strength: 0 };
  const margin = Math.max(0.005, reference * 0.1);
  const fullMarks = Math.max(0.03, reference * 0.5);
  const difference = rate - reference;
  if (Math.abs(difference) <= margin) return { stance: 'neutral', strength: scale(Math.abs(difference), margin) * 0.4 };
  return { stance: difference > 0 ? 'support' : 'oppose', strength: scale(Math.abs(difference), fullMarks) };
}

type OutcomeClass = 'win' | 'lose' | 'equal';

function classify(digit: number, winners: ReadonlySet<number>, contract: DigitContractCandidate): OutcomeClass {
  if (winners.has(digit)) return 'win';
  if (contract.family === 'over-under' && digit === contract.barrier) return 'equal';
  return 'lose';
}

/**
 * Empirical follow-through after a run of identical outcomes at this contract's
 * expiry. It measures what actually happened next in this stream and makes no
 * "due digit" assumption; when the current run state is too rare to measure the
 * engine abstains.
 */
export function runConditionedFollowThrough(
  digits: readonly number[],
  contract: DigitContractCandidate,
  horizon: number,
): { rate: number | null; sample: number; side: OutcomeClass; runLength: number } {
  const winners = new Set(winningDigits(contract));
  if (digits.length < horizon + 30) return { rate: null, sample: 0, side: 'lose', runLength: 0 };
  const classes = digits.map((digit) => classify(digit, winners, contract));
  const current = classes.at(-1)!;
  let runLength = 1;
  for (let index = classes.length - 2; index >= 0 && classes[index] === current; index -= 1) runLength += 1;
  let sample = 0;
  let wins = 0;
  for (let index = runLength; index + horizon < classes.length; index += 1) {
    if (classes[index] !== current) continue;
    let matched = true;
    for (let offset = 1; offset < runLength; offset += 1) {
      if (classes[index - offset] !== current) { matched = false; break; }
    }
    if (!matched) continue;
    sample += 1;
    if (classes[index + horizon] === 'win') wins += 1;
  }
  return { rate: sample > 0 ? wins / sample : null, sample, side: current, runLength };
}

export type DigitConsensusInput = {
  family: DigitConsensusFamily;
  label: string;
  contract: DigitContractCandidate;
  outcomes: HistoricalContractOutcomes;
  baseline: HistoricalContractOutcomes;
  analysis: DigitAnalysis;
  digits: readonly number[];
  quant: DigitQuantContext | null;
  qualified: boolean;
  gateReasons: readonly string[];
  /** Votes and factors already produced by the twelve fitted Over/Under models. */
  ensembleVotes?: readonly EngineVote[];
  ensembleFactors?: readonly ConfidenceFactor[];
  familiesTotal?: number;
};

/**
 * Build the single published consensus for one digit candidate. The twelve
 * fitted Over/Under models vote with their held-out-derived weights; the
 * frequency, transition, run-structure, deep-quant and AI engines vote for every
 * family. The confidence percentage is the weighted mean of the factors below.
 */
export function digitConsensus(input: DigitConsensusInput): SignalConsensus {
  const { family, contract, outcomes, baseline, analysis, digits, quant } = input;
  const winners = winningDigits(contract);
  const uniform = uniformWinRate(contract);
  const noun = contractNoun(contract);
  const horizon = Math.max(1, outcomes.durationTicks);
  const votes: EngineVote[] = [...(input.ensembleVotes ?? [])];

  const longWindow = analysis.windows.find((row) => row.window === 1_000) ?? null;
  const recentWindow = analysis.windows.find((row) => row.window === 100) ?? null;
  const longRate = rateOf(longWindow?.frequencies ?? analysis.digitFrequencies, winners);
  const reference = longRate ?? uniform;

  // ENGINE — long-window observed frequency.
  const longRead = readRate(longRate, uniform);
  votes.push(engineVote({
    id: 'frequency-long', label: 'Long-window frequency · 1,000 ticks', family: 'frequency',
    stance: longRead.stance, strength: longRead.strength, weight: 0.16,
    detail: longRate === null
      ? 'No validated 1,000-tick distribution yet, so this engine abstains.'
      : `${noun} settled ${(longRate * 100).toFixed(1)}% of the last ${longWindow?.sample ?? analysis.sampleSize} ticks against a ${(uniform * 100).toFixed(1)}% uniform reference.`,
  }));

  // ENGINE — recent-window frequency (short-term drift).
  const recentRate = rateOf(recentWindow?.frequencies ?? null, winners);
  const recentRead = readRate(recentRate, reference);
  votes.push(engineVote({
    id: 'frequency-recent', label: 'Recent-window frequency · 100 ticks', family: 'frequency',
    stance: recentRead.stance, strength: recentRead.strength, weight: 0.1,
    detail: recentRate === null
      ? 'Fewer than 100 validated digits, so this engine abstains.'
      : `Recent rate ${(recentRate * 100).toFixed(1)}% versus the long-window ${(reference * 100).toFixed(1)}% (n=${recentWindow?.sample ?? 0}).`,
  }));

  // ENGINE — recency-weighted (EWMA) frequency.
  const weightedRate = rateOf(analysis.weightedFrequencies, winners);
  const weightedRead = readRate(weightedRate, reference);
  votes.push(engineVote({
    id: 'frequency-ewma', label: 'Recency-weighted frequency · EWMA', family: 'frequency',
    stance: weightedRead.stance, strength: weightedRead.strength, weight: 0.12,
    detail: weightedRate === null
      ? 'No recency-weighted distribution is available, so this engine abstains.'
      : `Exponentially decayed rate ${(weightedRate * 100).toFixed(1)}% versus the ${(reference * 100).toFixed(1)}% long-window reference.`,
  }));

  // ENGINE — transitions conditioned on the live digit or parity context.
  const contextDigit = analysis.lastDigit;
  const contextCounts = contextDigit === null ? null : analysis.transitionCounts[contextDigit] ?? null;
  const contextSample = contextCounts ? contextCounts.reduce((total, count) => total + count, 0) : 0;
  const wantEven = contract.family === 'even-odd' && contract.contractType === 'DIGITEVEN';
  const parityRow = family === 'even-odd' && contextDigit !== null ? analysis.parityTransitions[contextDigit % 2] : null;
  const parityRowSample = parityRow ? parityRow.reduce((total, count) => total + count, 0) : 0;
  const conditionedRate = parityRow && parityRowSample > 0
    ? parityRow[wantEven ? 0 : 1] / parityRowSample
    : rateOf(contextCounts === null ? null : analysis.transitionProbabilities[contextDigit!], winners);
  const contextUsable = parityRow ? parityRowSample >= MINIMUM_CONTEXT_TRANSITIONS : contextSample >= MINIMUM_CONTEXT_TRANSITIONS;
  const conditionedRead = readRate(conditionedRate, reference);
  votes.push(engineVote({
    id: 'markov-context', label: family === 'even-odd' ? 'Parity transition engine · Markov' : 'Digit transition engine · Markov', family: 'markov',
    stance: contextUsable ? conditionedRead.stance : 'neutral',
    strength: contextUsable ? conditionedRead.strength : 0,
    weight: contextUsable ? 0.16 : 0,
    detail: conditionedRate === null
      ? 'No preceding transitions from the current digit are present, so this engine abstains.'
      : `After ${family === 'even-odd' ? `a digit with the same parity as ${contextDigit}` : `digit ${contextDigit}`}, ${noun.toLowerCase()} followed at ${(conditionedRate * 100).toFixed(1)}% of ${parityRowSample || contextSample} observed transitions${contextUsable ? '' : ' — too few to vote on'}.`,
  }));

  // ENGINE — run-conditioned follow-through at the selected expiry.
  const followThrough = runConditionedFollowThrough(digits, contract, horizon);
  const followRead = readRate(followThrough.rate, reference);
  const followUsable = followThrough.sample >= MINIMUM_RUN_REPEATS;
  votes.push(engineVote({
    id: 'run-structure', label: 'Run-length follow-through', family: 'streaks',
    stance: followUsable ? followRead.stance : 'neutral',
    strength: followUsable ? followRead.strength : 0,
    weight: followUsable ? 0.1 : 0,
    detail: followUsable
      ? `After ${followThrough.runLength} consecutive ${followThrough.side === 'win' ? 'wins' : followThrough.side === 'equal' ? 'barrier-equal ticks' : 'losses'} on this contract, the win settled ${(followThrough.rate! * 100).toFixed(1)}% of ${followThrough.sample} historical ${horizon}-tick outcomes.`
      : `Only ${followThrough.sample} historical repeats of the current run state; this engine abstains rather than assuming any digit is due.`,
  }));

  // ENGINE — deep quantitative engine (distribution drift / sequence structure).
  votes.push(deepQuantVote(family, contract, quant));

  // ENGINE — AI synthesis of the deterministic engine outputs.
  votes.push(aiSynthesisVote(family, contract, digits, quant));

  const counted = votes.filter((vote) => vote.weight > 0 || vote.stance !== 'neutral');
  const agreement = buildConsensus({ votes: counted, factors: [], familiesTotal: input.familiesTotal });

  const wilsonWidth = outcomes.wilson95 ? outcomes.wilson95.upper - outcomes.wilson95.lower : 1;
  const conditionedEdge = outcomes.smoothedHistoricalHitRate !== null && baseline.empiricalHitRate !== null
    ? outcomes.smoothedHistoricalHitRate - baseline.empiricalHitRate
    : null;
  const ensembleScale = family === 'over-under' ? 1 : 0;

  const factors: ConfidenceFactor[] = [
    ...(input.ensembleFactors ?? []),
    confidenceFactor({
      id: 'engine-consensus', label: 'Weighted engine agreement', score: agreement.weightedAgreement, weight: 0.2 + 0.3 * ensembleScale,
      detail: `${agreement.enginesAgreed} of ${agreement.enginesTotal} engines support ${input.label}; ${(agreement.weightedAgreement * 100).toFixed(0)}% of the voting weight agrees.`,
    }),
    confidenceFactor({
      id: 'engine-breadth', label: 'Engine-family breadth', score: agreement.familiesTotal ? agreement.familiesAgreed / agreement.familiesTotal : 0, weight: 0.1 + 0.15 * ensembleScale,
      detail: `${agreement.familiesAgreed} of ${agreement.familiesTotal} engine families point the same way.`,
    }),
    confidenceFactor({
      id: 'engine-conviction', label: 'Supporting-engine conviction', score: agreement.conviction, weight: 0.06 + 0.09 * ensembleScale,
      detail: `Average strength of the supporting engines' own evidence: ${(agreement.conviction * 100).toFixed(0)}%.`,
    }),
    confidenceFactor({
      id: 'conditioned-edge', label: 'Edge over the all-history base rate', score: conditionedEdge === null ? 0 : scale(conditionedEdge, 0.05), weight: ensembleScale ? 0.2 : 0.14,
      detail: conditionedEdge === null
        ? 'No conditioned historical outcomes are available at this expiry.'
        : `${conditionedEdge >= 0 ? '+' : ''}${(conditionedEdge * 100).toFixed(1)} pp over the all-history base rate on ${outcomes.sample} conditioned ${horizon}-tick outcomes.`,
    }),
    // Even/Odd and Matches are priced close to their uniform reference, so the
    // absolute conditioned win rate is itself evidence. Over/Under payouts move
    // with the barrier, so only lift over the rolling baseline counts there —
    // the ensemble factors already carry it and a raw-rate factor would simply
    // reward the easiest barrier.
    ...(!ensembleScale && outcomes.smoothedHistoricalHitRate !== null ? [confidenceFactor({
      id: 'absolute-rate', label: `Win rate against the ${Math.round(uniform * 100)}% uniform reference`,
      score: scale(outcomes.smoothedHistoricalHitRate - uniform, 0.15), weight: 0.18,
      detail: `Conditioned win rate ${(outcomes.smoothedHistoricalHitRate! * 100).toFixed(1)}% against the ${(uniform * 100).toFixed(0)}% rate a uniform digit stream would produce.`,
    })] : []),
    confidenceFactor({
      id: 'sample-adequacy', label: 'Conditioned sample size', score: scale(outcomes.sample, 300), weight: 0.12 - 0.02 * ensembleScale,
      detail: `${outcomes.sample} conditioned outcomes observed (${outcomes.hits} wins${outcomes.barrierEqual ? `, ${outcomes.barrierEqual} exact-barrier losses` : ''}).`,
    }),
    confidenceFactor({
      id: 'interval-precision', label: 'Estimate precision · Wilson width', score: 1 - scale(wilsonWidth, 0.2), weight: 0.1 - 0.02 * ensembleScale,
      detail: outcomes.wilson95 ? `Nominal 95% interval spans ${(wilsonWidth * 100).toFixed(1)} pp.` : 'No interval could be computed for this candidate.',
    }),
    confidenceFactor({
      id: 'evidence-gates', label: 'Evidence gates', score: input.qualified ? 1 : 0.35, weight: 0.14 + 0.16 * ensembleScale,
      detail: input.qualified ? 'Every evidence gate for this family passed.' : `Gates not passed: ${input.gateReasons.slice(0, 3).join(' ') || 'insufficient validated evidence'}.`,
    }),
  ];

  return buildConsensus({ votes, factors, familiesTotal: input.familiesTotal });
}

/** Deep quantitative engine vote: distribution drift, runs test or ordering. */
function deepQuantVote(family: DigitConsensusFamily, contract: DigitContractCandidate, quant: DigitQuantContext | null): EngineVote {
  const abstain = (label: string, detail: string) => engineVote({ id: 'quant-deep', label, family: 'quant', stance: 'neutral', strength: 0, weight: 0, detail });
  if (!quant) return abstain('Deep quant engine', 'Fewer than 50 validated digits, so the deep quantitative engine abstains.');

  if (family === 'over-under' && quant.overUnder && contract.family === 'over-under') {
    const barrier = Math.min(9, Math.max(0, contract.barrier));
    const side = contract.contractType === 'DIGITOVER' ? 'over' : 'under';
    const recent = quant.overUnder.recent.cumulative[barrier]?.[side] ?? null;
    const long = quant.overUnder.long.cumulative[barrier]?.[side] ?? null;
    if (recent === null || long === null) return abstain('Deep quant · barrier distribution', 'No barrier distribution could be computed for this contract.');
    const drift = recent - long;
    const reading = readRate(recent, long);
    return engineVote({
      id: 'quant-deep', label: 'Deep quant · barrier distribution drift', family: 'quant',
      stance: Math.abs(drift) < 0.01 ? 'neutral' : reading.stance,
      strength: Math.abs(drift) < 0.01 ? reading.strength * 0.4 : scale(Math.abs(drift), 0.06),
      weight: 0.12,
      detail: `Recent ${RECENT_WINDOW}-tick ${side}-barrier-${barrier} rate ${(recent * 100).toFixed(1)}% versus ${(long * 100).toFixed(1)}% across ${quant.sample} ticks (χ² ${quant.overUnder.long.chiSquare.toFixed(1)}${quant.overUnder.long.chiSquareP === null ? '' : `, p ${quant.overUnder.long.chiSquareP.toFixed(3)}`}).`,
    });
  }

  if (family === 'even-odd' && quant.evenOdd && contract.family === 'even-odd') {
    const wantEven = contract.contractType === 'DIGITEVEN';
    const key = wantEven ? 'even' : 'odd';
    const recent = quant.evenOdd.recent.parityProportion100[key];
    const long = quant.evenOdd.long.parityProportion500[key];
    const drift = recent - long;
    const reading = readRate(recent, long);
    const runsSignificant = quant.evenOdd.long.waldWolfowitz.p < 0.05;
    return engineVote({
      id: 'quant-deep', label: 'Deep quant · parity drift and runs test', family: 'quant',
      stance: Math.abs(drift) < 0.01 ? 'neutral' : reading.stance,
      strength: (Math.abs(drift) < 0.01 ? reading.strength * 0.4 : scale(Math.abs(drift), 0.06)) * (runsSignificant ? 1 : 0.7),
      weight: 0.12,
      detail: `Recent ${key} share ${(recent * 100).toFixed(1)}% versus ${(long * 100).toFixed(1)}% over 500 ticks; Wald–Wolfowitz runs z ${quant.evenOdd.long.waldWolfowitz.z.toFixed(2)} (p ${quant.evenOdd.long.waldWolfowitz.p.toFixed(3)}) — ${runsSignificant ? 'parity ordering is not consistent with independence' : 'parity ordering is consistent with independence'}.`,
    });
  }

  if (family === 'matches' && quant.matches && contract.family === 'matches') {
    const metrics = quant.matches.metrics;
    const structure = 1 - clamp01(metrics.permutationEntropy);
    const acf1 = metrics.autocorrelation[0] ?? 0;
    const significant = Math.abs(acf1) > 2 / Math.sqrt(Math.max(1, quant.sample));
    const highTarget = contract.targetDigit >= 5;
    const aligned = (acf1 > 0 && highTarget) || (acf1 < 0 && !highTarget);
    return engineVote({
      id: 'quant-deep', label: 'Deep quant · sequence structure', family: 'quant',
      stance: structure <= 0.15 || !significant ? 'neutral' : aligned ? 'support' : 'oppose',
      strength: clamp01(structure) * (significant ? 1 : 0.5),
      weight: structure > 0.15 && significant ? 0.12 : 0,
      detail: `Permutation entropy ${metrics.permutationEntropy.toFixed(3)} (0 deterministic, 1 random) and lag-1 autocorrelation ${acf1.toFixed(3)} — ${structure > 0.15 && significant ? 'ordering survives both checks' : 'ordering is indistinguishable from noise, so this engine abstains'}.`,
    });
  }

  return abstain('Deep quant engine', 'The deep quantitative engine has no model for this contract family.');
}

/** Rule-based AI synthesis vote over the deterministic engine outputs. */
function aiSynthesisVote(family: DigitConsensusFamily, contract: DigitContractCandidate, digits: readonly number[], quant: DigitQuantContext | null): EngineVote {
  const abstain = (label: string, detail: string) => engineVote({ id: 'ai-synthesis', label, family: 'ai', stance: 'neutral', strength: 0, weight: 0, detail });
  if (!quant) return abstain('AI synthesis', 'Not enough validated digits for the synthesis engine.');

  if (family === 'over-under' && quant.overUnder && contract.family === 'over-under') {
    const zScores = quant.overUnder.long.zScores;
    const deviated = zScores.reduce((best, value, digit) => Math.abs(value) > Math.abs(zScores[best]) ? digit : best, 0);
    const z = zScores[deviated];
    const winners = new Set(winningDigits(contract));
    let stance: VoteStance = 'neutral';
    if (Math.abs(z) > 1 && deviated !== contract.barrier) stance = winners.has(deviated) === z > 0 ? 'support' : 'oppose';
    return engineVote({
      id: 'ai-synthesis', label: 'AI synthesis · deviation verdict', family: 'ai',
      stance, strength: scale(Math.abs(z), 3), weight: stance === 'neutral' ? 0 : 0.1,
      detail: `${quant.insight.verdict}. Digit ${deviated} carries z ${z.toFixed(2)} across ${quant.sample} ticks, which ${stance === 'support' ? 'favours' : stance === 'oppose' ? 'argues against' : 'does not separate'} ${contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${contract.barrier}. ${quant.insight.risk}`,
    });
  }

  if (family === 'even-odd' && quant.evenOdd && contract.family === 'even-odd') {
    const wantEven = contract.contractType === 'DIGITEVEN';
    const share = quant.evenOdd.long.parityProportion100.even;
    const biased = Math.abs(share - 0.5) > 0.05;
    const stance: VoteStance = biased ? ((share > 0.5) === wantEven ? 'support' : 'oppose') : 'neutral';
    return engineVote({
      id: 'ai-synthesis', label: 'AI synthesis · parity verdict', family: 'ai',
      stance, strength: scale(Math.abs(share - 0.5), 0.08), weight: biased ? 0.1 : 0,
      detail: `${quant.insight.verdict} (${(share * 100).toFixed(1)}% even over the last 100 ticks). ${quant.insight.risk}`,
    });
  }

  if (family === 'matches' && quant.matches && contract.family === 'matches') {
    const deterministic = quant.matches.metrics.permutationEntropy < 0.5;
    if (!deterministic) return abstain('AI synthesis · pattern verdict', `${quant.insight.verdict}. No exploitable ordering was found, so the synthesis engine abstains. ${quant.insight.risk}`);
    const row = digits.length >= 2 ? quant.matches.orderTwo[`${digits.at(-2)}${digits.at(-1)}`] : null;
    const rowSample = row ? row.reduce((total, count) => total + count, 0) : 0;
    const rate = row && rowSample > 0 ? row[contract.targetDigit] / rowSample : null;
    const stance: VoteStance = rate === null || rowSample < 10 ? 'neutral' : rate > 0.1 ? 'support' : 'oppose';
    return engineVote({
      id: 'ai-synthesis', label: 'AI synthesis · pattern verdict', family: 'ai',
      stance, strength: stance === 'neutral' ? 0 : scale(Math.abs((rate ?? 0.1) - 0.1), 0.1), weight: stance === 'neutral' ? 0 : 0.1,
      detail: `${quant.insight.verdict}. ${rate === null ? 'This two-digit context has no history yet.' : `After the context ${digits.at(-2)}${digits.at(-1)}, digit ${contract.targetDigit} followed at ${(rate * 100).toFixed(1)}% of ${rowSample} occurrences.`} ${quant.insight.risk}`,
    });
  }

  return abstain('AI synthesis', 'The synthesis engine has no verdict for this contract family.');
}
