// Shared multi-engine consensus: every analysis produces a signal, an engines-
// agreed tally and a confidence score. Votes come from the fitted research
// engines plus the rule-based AI synthesis layer; the consensus is a research
// estimate, never a calibrated win probability.

export type AnalysisProgress = { percent: number; stage: string };

export type EngineVote = {
  id: string;
  label: string;
  /** The option this engine supports, e.g. 'OVER 5', 'EVEN', 'MATCH 3', 'RISE'. */
  side: string;
  /** 0..1 conviction of this engine in its own pick. */
  strength: number;
  note: string;
};

export type ConsensusTier = 'STRONG' | 'MODERATE' | 'WEAK';

export type ConsensusSignal = {
  label: string;
  /** 0..100 research confidence score. */
  confidence: number;
  tier: ConsensusTier;
  /** Engines whose own evidence supports the winning label. */
  votesFor: number;
  /** All engines that produced a vote. */
  votesTotal: number;
  /** votesFor / votesTotal. */
  agreement: number;
  engines: EngineVote[];
  note: string;
};

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function pickMajority(engines: readonly EngineVote[]): string | null {
  if (!engines.length) return null;
  const tally = new Map<string, { count: number; strength: number }>();
  for (const engine of engines) {
    const row = tally.get(engine.side) ?? { count: 0, strength: 0 };
    row.count += 1;
    row.strength += clamp01(engine.strength);
    tally.set(engine.side, row);
  }
  return [...tally.entries()].sort((left, right) =>
    right[1].count - left[1].count
    || right[1].strength - left[1].strength
    || left[0].localeCompare(right[0]),
  )[0]?.[0] ?? null;
}

/**
 * Blend engine agreement, agreeing-engine conviction and optional external
 * evidence (held-out skill, historical lift, data quality) into one 0–100 score.
 * Strong consensus needs both breadth (many engines) and conviction.
 */
export function buildConsensus(
  engines: readonly EngineVote[],
  label: string | null,
  options: { evidence?: number; note?: string } = {},
): ConsensusSignal | null {
  if (!engines.length || !label) return null;
  const votesFor = engines.filter((engine) => engine.side === label);
  const votesTotal = engines.length;
  const agreement = votesTotal ? votesFor.length / votesTotal : 0;
  const conviction = votesFor.length
    ? votesFor.reduce((sum, engine) => sum + clamp01(engine.strength), 0) / votesFor.length
    : 0;
  const evidence = clamp01(options.evidence ?? 0.5);
  const score = 0.5 * agreement + 0.3 * conviction + 0.2 * evidence;
  const confidence = Math.round(clamp01(score) * 100);
  const tier: ConsensusTier = confidence >= 72 ? 'STRONG' : confidence >= 56 ? 'MODERATE' : 'WEAK';
  return {
    label,
    confidence,
    tier,
    votesFor: votesFor.length,
    votesTotal,
    agreement,
    engines: [...engines],
    note: options.note ?? '',
  };
}

/** Confidence phrasing shared by every tool panel. */
export function tierDescription(tier: ConsensusTier): string {
  if (tier === 'STRONG') return 'Strong consensus · engines broadly aligned';
  if (tier === 'MODERATE') return 'Moderate consensus · mixed engine evidence';
  return 'Weak consensus · engines disagree or evidence is thin';
}
