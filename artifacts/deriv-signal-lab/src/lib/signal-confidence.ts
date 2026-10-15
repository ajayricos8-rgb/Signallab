/**
 * Shared engine-consensus and confidence scoring for every research tool.
 *
 * After a scan each tool has to answer the same three questions: which engines
 * agreed, how strongly did they agree, and how much measured evidence backs the
 * published signal. This module keeps those answers identical in shape across
 * Over/Under, Even/Odd, Matches and Rise/Fall so the UI can render one
 * confidence card everywhere.
 *
 * IMPORTANT: the confidence percentage is an EVIDENCE score built only from
 * measurable inputs (weighted engine agreement, edge over the rolling
 * frequency baseline, held-out Brier skill, sample size, engine dispersion,
 * data quality). It is not a calibrated win probability, not a payout or
 * expected-value model and not a promise about the next outcome. A high score
 * means "many independent measurements point the same way on this data", never
 * "this trade will win".
 */

export type VoteStance = 'support' | 'oppose' | 'neutral';

export type EngineVote = {
  id: string;
  label: string;
  family: string;
  stance: VoteStance;
  /** 0–1 magnitude of this engine's own evidence, independent of its weight. */
  strength: number;
  /** Relative influence on weighted agreement. 0 means the engine abstains. */
  weight: number;
  detail: string;
};

export type ConfidenceFactor = {
  id: string;
  label: string;
  /** 0–1 contribution to the confidence score. */
  score: number;
  weight: number;
  detail: string;
};

export type ConfidenceGrade = 'very strong' | 'strong' | 'moderate' | 'weak' | 'very weak';

export type SignalConsensus = {
  confidence: number;
  confidencePercent: number;
  grade: ConfidenceGrade;
  enginesTotal: number;
  enginesAgreed: number;
  enginesOpposed: number;
  enginesAbstained: number;
  familiesTotal: number;
  familiesAgreed: number;
  weightedAgreement: number;
  conviction: number;
  factors: ConfidenceFactor[];
  votes: EngineVote[];
  headline: string;
  summary: string;
};

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function scale(value: number, fullMarksAt: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(fullMarksAt) || fullMarksAt <= 0) return 0;
  return clamp01(value / fullMarksAt);
}

export function engineVote(vote: Omit<EngineVote, 'strength' | 'weight'> & { strength?: number; weight?: number }): EngineVote {
  return {
    id: vote.id,
    label: vote.label,
    family: vote.family,
    stance: vote.stance,
    detail: vote.detail,
    strength: clamp01(vote.strength ?? 0.5),
    weight: Math.max(0, Number.isFinite(vote.weight ?? 0) ? vote.weight! : 0),
  };
}

export function confidenceFactor(factor: ConfidenceFactor): ConfidenceFactor {
  return { ...factor, score: clamp01(factor.score), weight: Math.max(0, Number.isFinite(factor.weight) ? factor.weight : 0) };
}

export function confidenceGrade(percent: number): ConfidenceGrade {
  if (percent >= 80) return 'very strong';
  if (percent >= 65) return 'strong';
  if (percent >= 50) return 'moderate';
  if (percent >= 35) return 'weak';
  return 'very weak';
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentText(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

/**
 * Combine engine votes and confidence factors into one publishable consensus.
 * Votes decide agreement; factors decide the confidence percentage. Engines
 * that abstain (weight 0 or a neutral stance) stay visible in the breakdown but
 * can never inflate agreement.
 */
export function buildConsensus(input: { votes: EngineVote[]; factors: ConfidenceFactor[]; familiesTotal?: number }): SignalConsensus {
  const votes = input.votes.map((vote) => ({ ...vote, strength: clamp01(vote.strength), weight: Math.max(0, Number.isFinite(vote.weight) ? vote.weight : 0) }));
  const factors = input.factors.map(confidenceFactor);
  const enginesTotal = votes.length;
  const enginesAgreed = votes.filter((vote) => vote.stance === 'support').length;
  const enginesOpposed = votes.filter((vote) => vote.stance === 'oppose').length;
  const enginesAbstained = enginesTotal - enginesAgreed - enginesOpposed;

  const supportWeight = sum(votes.filter((vote) => vote.stance === 'support').map((vote) => vote.weight));
  const opposeWeight = sum(votes.filter((vote) => vote.stance === 'oppose').map((vote) => vote.weight));
  const countedWeight = supportWeight + opposeWeight;
  const weightedAgreement = countedWeight > 0 ? supportWeight / countedWeight : 0;

  const familyNames = [...new Set(votes.map((vote) => vote.family))];
  const familiesAgreed = familyNames.filter((family) => {
    const rows = votes.filter((vote) => vote.family === family);
    const support = sum(rows.filter((vote) => vote.stance === 'support').map((vote) => vote.weight));
    const oppose = sum(rows.filter((vote) => vote.stance === 'oppose').map((vote) => vote.weight));
    return support > 0 && support >= oppose;
  }).length;
  const familiesTotal = input.familiesTotal && input.familiesTotal > 0 ? input.familiesTotal : familyNames.length;

  const convictionWeight = sum(votes.filter((vote) => vote.stance === 'support').map((vote) => vote.weight));
  const conviction = convictionWeight > 0
    ? sum(votes.filter((vote) => vote.stance === 'support').map((vote) => vote.weight * vote.strength)) / convictionWeight
    : 0;

  const factorWeight = sum(factors.map((factor) => factor.weight));
  const confidence = factorWeight > 0 ? clamp01(sum(factors.map((factor) => factor.weight * factor.score)) / factorWeight) : 0;
  const confidencePercent = Math.round(confidence * 100);

  return {
    confidence,
    confidencePercent,
    grade: confidenceGrade(confidencePercent),
    enginesTotal,
    enginesAgreed,
    enginesOpposed,
    enginesAbstained,
    familiesTotal,
    familiesAgreed,
    weightedAgreement,
    conviction,
    factors,
    votes,
    headline: `${enginesAgreed}/${enginesTotal} engines agree · ${confidencePercent}% confidence`,
    summary: `${enginesAgreed} of ${enginesTotal} engines support this signal (${familiesAgreed}/${familiesTotal} engine families) · weighted agreement ${percentText(weightedAgreement)} · evidence confidence ${confidencePercent}% (${confidenceGrade(confidencePercent)}).`,
  };
}

/** Consensus used when a scan cannot produce any candidate at all. */
export function emptyConsensus(reason: string): SignalConsensus {
  return buildConsensus({
    votes: [],
    factors: [confidenceFactor({ id: 'blocked', label: 'Signal gates', score: 0, weight: 1, detail: reason })],
  });
}
