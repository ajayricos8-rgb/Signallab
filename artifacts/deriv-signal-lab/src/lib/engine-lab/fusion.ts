// Layer 4: fold the 300-engine research library into the signal itself.
//
// Until now the library was a side report: its forecast could only shrink an
// already-confirmed edge and its 300 readings sat next to a probability they
// never touched. This module makes the research ensemble part of the overall
// analysis — the number every tool ranks, confirms, plans an entry for and
// trades.
//
// The rule that keeps this honest is unchanged and is the whole point of the
// separate phases in `forecast.ts`:
//
//   * a research ensemble that PASSED its own independent holdout validation
//     earns a real weight and can move the estimate in either direction;
//   * a research ensemble that did NOT validate can only pull the estimate
//     toward its own (lower) number — never inflate an edge.
//
// Weights come from measured evidence only (validation flag, holdout Brier
// skill, holdout sample). The fusion is a convex combination of the two edges
// over the same no-edge baseline, so the result can never sit outside the range
// the two estimates already span: research is a second opinion, not a
// multiplier. Everything here is pure, deterministic and worker-safe.
import type { ResearchAudit } from './types.ts';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Highest share a validated research ensemble can take of the final edge. */
export const RESEARCH_MAX_WEIGHT = 0.35;
/** Highest share an unvalidated ensemble may take, and only downwards. */
export const RESEARCH_UNVALIDATED_WEIGHT = 0.15;
/** Holdout rows at which a validated ensemble earns its full sample weight. */
const FULL_SAMPLE = 200;

export type ResearchStance = 'supportive' | 'contradicting' | 'neutral';

export type ResearchFusion = {
  /** Share of the final edge the research ensemble supplied (0–0.35). */
  weight: number;
  /** Probability points the research layer moved the traded estimate by. */
  contributionPts: number;
  /** The research ensemble's own live estimate for the traded outcome. */
  probability: number;
  /** Research models whose live estimate sits above the no-edge rate. */
  agreeing: number;
  total: number;
  /** Share of research-model weight that favours the outcome (0–1). */
  agreement: number;
  /** True only when the ensemble passed independent holdout validation. */
  validated: boolean;
  /** Holdout Brier skill of the ensemble versus the no-edge rate. */
  skill: number | null;
  /** Independent holdout rows behind that skill. */
  sample: number;
  stance: ResearchStance;
  /** One sentence for the UI explaining what the layer did. */
  note: string;
};

export type ResearchFusionInput = {
  audit: ResearchAudit;
  /** Estimate for the traded outcome after the confirmation layer. */
  probability: number;
  /** No-edge probability of the traded outcome. */
  fair: number;
};

const finiteProbability = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0.0005, 0.9995) : null;

/**
 * Blend the research ensemble into the base estimate.
 *
 * Returns the base estimate untouched when the research audit is unusable
 * (missing, non-finite, no models), so a broken library can never move a
 * signal — the same fail-closed behaviour the rest of the layer uses.
 */
export function fuseResearch(input: ResearchFusionInput): { probability: number; fusion: ResearchFusion } {
  const audit = input.audit;
  const models = Array.isArray(audit?.models) ? audit.models : [];
  const base = finiteProbability(input.probability);
  const fair = finiteProbability(input.fair);
  const research = finiteProbability(audit?.probability);
  const researchFair = finiteProbability(audit?.fair) ?? fair ?? 0.5;
  const baseline = fair ?? researchFair;
  const material = Math.max(0.005, 0.01 * baseline);
  const sample = Number.isFinite(audit?.sample) ? Math.max(0, Math.trunc(audit.sample!)) : 0;
  const validated = Boolean(audit?.validated);
  const skill = typeof audit?.skill === 'number' && Number.isFinite(audit.skill) ? audit.skill : null;

  const favourable = models.filter((model) => Number.isFinite(model.probability) && model.probability > researchFair + material);
  const weightTotal = models.reduce((total, model) => total + (Number.isFinite(model.weight) ? Math.max(0, model.weight) : 0), 0);
  const agreement = weightTotal > 0
    ? favourable.reduce((total, model) => total + (Number.isFinite(model.weight) ? Math.max(0, model.weight) : 0), 0) / weightTotal
    : 0;

  const total = models.length;
  const agreeing = favourable.length;
  const baseEdge = base === null || fair === null ? 0 : base - fair;
  const researchEdge = research === null ? 0 : research - researchFair;
  const stance: ResearchStance = research === null
    ? 'neutral'
    : researchEdge < -material && baseEdge > material
      ? 'contradicting'
      : researchEdge > material
        ? 'supportive'
        : 'neutral';

  const summary = validated
    ? `validated on ${sample} independent holdout rows, ${agreeing}/${total} models favour the outcome`
    : `not independently validated, ${agreeing}/${total} models favour the outcome`;

  if (base === null || fair === null || research === null || !total) {
    return {
      probability: input.probability,
      fusion: {
        weight: 0, contributionPts: 0, probability: research ?? finiteProbability(input.probability) ?? 0.5, agreeing, total,
        agreement, validated, skill, sample, stance,
        note: `Research library unavailable for this contract (${summary}). The signal keeps its own estimate.`,
      },
    };
  }

  const sampleFactor = clamp(sample / FULL_SAMPLE, 0.25, 1);
  const skillFactor = validated ? clamp(4 * Math.max(0, skill ?? 0), 0.1, 1) : 0;
  // Validated research earns a real weight; unvalidated research may only drag
  // the estimate down towards its own, and only by a materially lower number.
  const weight = validated
    ? clamp(RESEARCH_MAX_WEIGHT * sampleFactor * skillFactor, 0.05, RESEARCH_MAX_WEIGHT)
    : researchEdge < baseEdge - material
      ? clamp(RESEARCH_UNVALIDATED_WEIGHT * sampleFactor, 0, RESEARCH_UNVALIDATED_WEIGHT)
      : 0;

  const probability = clamp(fair + (1 - weight) * baseEdge + weight * researchEdge, 0.0005, 0.9995);
  const contributionPts = 100 * (probability - base);
  const note = weight <= 0
    ? `Research library checked this contract and left the estimate alone (${summary}).`
    : stance === 'contradicting'
      ? `Research library pulls this estimate down ${Math.abs(contributionPts).toFixed(2)} pts: ${summary}.`
      : `Research library folded in at ${(100 * weight).toFixed(0)}% weight, ${contributionPts >= 0 ? '+' : ''}${contributionPts.toFixed(2)} pts: ${summary}.`;

  return {
    probability,
    fusion: { weight, contributionPts, probability: research, agreeing, total, agreement, validated, skill, sample, stance, note },
  };
}

/** Evidence the research layer hands to the confidence score. */
export function researchEvidence(fusion: ResearchFusion): {
  agreement: number;
  skill: number | null;
  sample: number;
  validated: boolean;
  contradicted: boolean;
} {
  return {
    agreement: Number.isFinite(fusion.agreement) ? clamp(fusion.agreement, 0, 1) : 0,
    skill: fusion.skill,
    sample: fusion.sample,
    validated: fusion.validated,
    contradicted: fusion.stance === 'contradicting',
  };
}
