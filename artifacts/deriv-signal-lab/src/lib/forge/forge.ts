// Layer 8 — THE FORGED MODEL.
//
// Layers 1–7 each answer a piece of the question: the engines measure, the
// analysis engines test for structure, the confirmation layer calibrates, the
// research library audits, the precision layer prices the error, the neural
// layer is a second opinion and the master decision pools what survived. What
// none of them is, is a single model that has LEARNED how those pieces fit
// together on this market.
//
// The forge is that model. It is trained here, from scratch, on this market's
// own replayed rows, and its inputs are the outputs of every audited layer at
// the same origin:
//
//   engines → family-weighted probability, spread, agreement and votes
//   AI + neural → horizon-matched, causal model forecasts
//   research → an independent ensemble forecast on the same holdout origin
//   analysis → the causal prior and its measured skill
//   calculations → rolling-frequency baseline, fair rate, horizon and edge/noise
//   market knowledge → cadence, volatility class, market family and contract rules
//   structure → digit entropy/runs/hot/parity/streak, or variance ratio/trend/
//               volatility/RSI-like balance/range position
//
// and it is taught twice over: against the realised outcome (supervised) and
// against the audited teachers' probabilities (distillation, `train.ts`). The
// knowledge base (`knowledge.ts`) is the syllabus: it fixes the anchor (fair),
// names the teachers, pins the inputs, and contributes the rules that can only
// REMOVE conviction.
//
// The result is used for all three jobs at once:
//   * analysis   — the card and its reading of the market context,
//   * prediction — a single probability for the traded call,
//   * entry      — `applyForge` decides whether the call is confirmed, trimmed
//                  or vetoed, and a veto is what stops the master decision from
//                  calling the entry decisive.
//
// Fail-closed by construction: no fit, no validation or no live vector leaves
// the published probability bit-identical. A validated forge can raise a call
// by at most FORGE_MAX_WEIGHT of its edge, can cut it, and can never place an
// order.
import { parameterCount } from '../neural/network.ts';
import type { NetworkSpec } from '../neural/network.ts';
import {
  FORGE_KNOWLEDGE_VERSION,
  FORGE_MARKET_ATLAS,
  knowledgeFor,
  marketProfile,
  summarizeKnowledge,
} from './knowledge.ts';
import { FORGE_FEATURE_COUNT, featureLabels } from './features.ts';
import { trainForge, type ForgeRow } from './train.ts';
import {
  FORGE_LICENSE,
  FORGE_MAX_WEIGHT,
  FORGE_MODEL_ID,
  type ForgeFamily,
  type ForgeFusion,
  type ForgedModel,
  type ForgeModelCard,
  type ForgeStage,
} from './types.ts';
import type { ForgeMetrics } from './types.ts';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const safeProbability = (value: number) => clamp(value, 0.0005, 0.9995);

/** Bucket a named forge input into the angle domain it represents. */
function angleDomain(label: string): ForgeAngleDomain['domain'] {
  const lower = label.toLowerCase();
  if (/engine|ensemble|agreement|disagreement|balance|abstain|vote/.test(lower)) return 'engines';
  if (/\bai\b|meta-model|neural/.test(lower)) {
    if (/neural/.test(lower)) return 'neural';
    return 'ai';
  }
  if (/research/.test(lower)) return 'research';
  if (/market|cadence|volatility|family|instrument/.test(lower)) return 'market-structure';
  if (/knowledge|uncertainty|syllabus/.test(lower)) return 'knowledge';
  return 'calculations';
}

/** Share of the teacher probability mixed into each training label. */
export const FORGE_DISTILLATION = 0.35;

/** Architecture: 31 → 24 → 12 → 2, 1,094 parameters. */
const FORGE_SPEC: NetworkSpec = {
  inputDim: FORGE_FEATURE_COUNT,
  hidden: [24, 12],
  outputs: 2,
  seed: 0x5eed_f0f6,
  learningRate: 0.012,
  l2: 1.5e-4,
  epochs: 12,
  batchSize: 32,
  patience: 3,
};

/** Rows of the tick stream a fit may consume, so the worker stays responsive. */
const MAX_FORGE_ROWS = 480;

/** Public, inspectable summary of the model that the Base workspace displays. */
export const FORGE_TRAINING_PROFILE = {
  shape: [FORGE_SPEC.inputDim, ...(FORGE_SPEC.hidden ?? []), FORGE_SPEC.outputs],
  maxReplayRows: MAX_FORGE_ROWS,
  maxEpochs: FORGE_SPEC.epochs ?? 12,
  distillationShare: FORGE_DISTILLATION,
} as const;

export type ForgeCandidateInput = {
  family: ForgeFamily;
  /** Contract or duration label, used on the card and in the notes. */
  label: string;
  /** No-edge probability of the traded outcome. */
  fair: number;
  /** Chronological replayed rows for this exact call. */
  rows: readonly ForgeRow[];
  /** The same vector built at the live origin. */
  liveFeatures: Float64Array;
  /**
   * The audited teacher's probability for the live call. The network learns a
   * residual correction on top of it, so this is required for an honest
   * prediction (not as an input, as the baseline the correction applies to).
   */
  liveTeacherProbability: number;
  /** 0–1 maturity of the sample the rows came from. */
  dataQuality: number;
  /** Ticks the contract runs for, used by the purge gap. */
  horizonTicks: number;
  /** Plain-language reading of the market context the vector carries. */
  contextSummary: string;
  /** Causal layer outputs/calculations used as model inputs. */
  inputs?: readonly string[];
  /** Which audited layers supplied the distillation targets. */
  teachers: readonly string[];
  symbol?: string | null;
  name?: string | null;
  seed?: number;
  /**
   * Candidates competing in the same scan. The forge fits once per candidate,
   * so the holdout bar is raised for the size of that search.
   */
  selectionPool?: number;
};

function describeGate(metrics: ForgeMetrics): string {
  const skill = metrics.brierSkill === null ? '—' : `${(100 * metrics.brierSkill).toFixed(1)}%`;
  const z = metrics.z === null ? '—' : metrics.z.toFixed(2);
  return metrics.validated
    ? `Validated out of sample: ${metrics.accuracy === null ? '—' : `${(100 * metrics.accuracy).toFixed(1)}%`} hit rate vs ${metrics.baselineAccuracy === null ? '—' : `${(100 * metrics.baselineAccuracy).toFixed(1)}%`} at the fair rate, ${skill} Brier skill, z ${z} on ${metrics.holdoutRows} unseen rows.`
    : `Not validated on this market: ${skill} Brier skill, z ${z} on ${metrics.holdoutRows} unseen rows. It carries no vote until it beats the fair rate out of sample.`;
}

function buildStages(input: {
  family: ForgeFamily;
  trainRows: number;
  validationRows: number;
  holdoutRows: number;
  inputCount: number;
  distillation: number;
  knowledgeCount: number;
  marketClass: string;
  temperature: number;
}): ForgeStage[] {
  return [
    {
      id: 'knowledge',
      label: 'Knowledge anchor',
      size: input.knowledgeCount,
      detail: `${input.knowledgeCount} syllabus entries for the ${input.family === 'digit' ? 'digit' : 'Rise/Fall'} family pin the anchor at fair odds, the teachers, the inputs and the rules that can only remove conviction.`,
    },
    {
      id: 'inputs',
      label: 'Causal expert inputs',
      size: input.inputCount,
      detail: 'Engine consensus, AI and horizon-matched neural views, independent research forecasts, and fair-rate/edge-to-noise calculations enter as inputs only when they were available at that replay origin.',
    },
    {
      id: 'market',
      label: 'Instrument condition',
      size: 1,
      detail: `Market family ${input.marketClass}; cadence, volatility class and family enter the vector so the model conditions on the instrument, not just the ticks.`,
    },
    {
      id: 'distillation',
      label: 'Teacher distillation',
      size: input.trainRows,
      detail: `Each training label was mixed ${(100 * input.distillation).toFixed(0)}%/${(100 * (1 - input.distillation)).toFixed(0)}% with the audited teachers' probability for the same row, shrunk toward the fair rate by the knowledge prior.`,
    },
    {
      id: 'fit',
      label: 'Chronological fit',
      size: input.trainRows,
      detail: 'Adam on soft targets, L2 weight decay, gradient clipping and early stopping on the validation slice; no row is ever shuffled across a split boundary.',
    },
    {
      id: 'calibration',
      label: 'Temperature calibration',
      size: input.validationRows,
      detail: `One scalar temperature fitted on the validation slice only (chosen ${input.temperature.toFixed(2)}), so the probabilities are neither over- nor under-confident.`,
    },
    {
      id: 'holdout',
      label: 'Independent holdout',
      size: input.holdoutRows,
      detail: 'Scored once against the same fair rate the contract is priced on: accuracy, Brier skill, log-loss skill, calibration gap and a paired z.',
    },
  ];
}

/**
 * Forge one candidate. Returns null when the call cannot be fitted honestly
 * (thin sample, degenerate rows), in which case the analyzers simply carry on
 * without the layer.
 */
export function forgeCandidate(input: ForgeCandidateInput): ForgedModel | null {
  if (!Array.isArray(input.rows)) return null;
  const fair = clamp(finite(input.fair) ? input.fair : 0.5, 0.001, 0.999);
  // Keep the newest rows: the market's current regime matters more than a
  // stale one, and the chronological split still holds inside the window.
  const rows = input.rows.length > MAX_FORGE_ROWS ? input.rows.slice(-MAX_FORGE_ROWS) : input.rows;
  // The floor the trainer can still split honestly (≈55 train / 40 holdout
  // rows after purging); below it, a fit would be noise with a model card.
  if (rows.length < 160) return null;
  const profile = marketProfile(input.symbol, input.name);
  const purge = Math.max(12, Math.trunc(finite(input.horizonTicks) ? input.horizonTicks : 12));
  const spec: NetworkSpec = { ...FORGE_SPEC, seed: finite(input.seed) ? (input.seed as number) : FORGE_SPEC.seed };
  const trained = trainForge(rows, fair, {
    spec,
    purge,
    distillation: FORGE_DISTILLATION,
    maxTrainRows: 400,
    maxValidationRows: 200,
    maxHoldoutRows: 520,
    selectionPool: input.selectionPool,
  });
  if (!trained) return null;
  const raw = trained.predict(input.liveFeatures, input.liveTeacherProbability);
  const probability = clamp(finite(raw) ? raw : fair, 0.001, 0.999);
  const metrics = trained.metrics;
  const quality = clamp(finite(input.dataQuality) ? input.dataQuality : 0, 0, 1);
  // Data quality scales the earned weight: the same measured skill on a thin
  // or stale sample is worth less, exactly as the syllabus says.
  const weight = trained.weight * clamp(0.35 + 0.65 * quality, 0, 1);
  const edge = probability - fair;
  // Drive: the forged edge in units of its own sampling error. A validated
  // model can reach 100; an unvalidated one is capped at 40 however loud its
  // number is, because it has not earned the right to be believed.
  const samplingError = Math.sqrt(Math.max(1e-6, probability * (1 - probability)) / Math.max(20, metrics.holdoutRows));
  const z = samplingError > 1e-9 ? Math.abs(edge) / samplingError : 0;
  const drive = Math.round(100 * clamp(Math.tanh(z / 2) * (metrics.validated ? 1 : 0.4), 0, 1));
  const knowledgeCount = knowledgeFor(input.family).length;
  const card: ForgeModelCard = {
    id: FORGE_MODEL_ID,
    name: 'SignalLab Forge · unified model',
    version: '1.1.0',
    task: input.family === 'digit'
      ? `Terminal-digit contract win probability · ${input.label}`
      : `Rise/Fall win probability · ${input.label}`,
    family: input.family,
    shape: [...trained.network.shape],
    parameters: parameterCount(trained.network),
    activation: 'relu',
    optimizer: 'adam',
    learningRate: spec.learningRate ?? 0.012,
    l2: spec.l2 ?? 1.5e-4,
    distillation: FORGE_DISTILLATION,
    epochsRun: trained.epochsRun,
    epochsPlanned: spec.epochs ?? 12,
    bestEpoch: trained.bestEpoch,
    temperature: trained.temperature,
    trainRows: metrics.trainRows,
    validationRows: metrics.validationRows,
    holdoutRows: metrics.holdoutRows,
    seed: spec.seed,
    license: FORGE_LICENSE,
    origin: `Forged now, in this run, from ${input.label} replayed rows and causal layer outputs on ${profile.name} — no pretrained weights and no download.`,
    runtime: 'Trained and executed locally in a Web Worker · no network, no account, no cost',
    cost: 'free',
    knowledgeVersion: FORGE_KNOWLEDGE_VERSION,
    features: featureLabels(input.family),
    inputs: [...(input.inputs ?? [])],
    teachers: [...input.teachers],
    stages: buildStages({
      family: input.family,
      trainRows: metrics.trainRows,
      validationRows: metrics.validationRows,
      holdoutRows: metrics.holdoutRows,
      inputCount: (input.inputs ?? []).length,
      distillation: FORGE_DISTILLATION,
      knowledgeCount,
      marketClass: profile.kind,
      temperature: trained.temperature,
    }),
  };
  const teacherError = metrics.teacherErrorRate === null ? '—' : `${(100 * metrics.teacherErrorRate).toFixed(0)}%`;
  const angleInputs = (input.inputs ?? []).map((label) => ({
    domain: angleDomain(label),
    label,
    measured: true,
    verdict: 'neutral' as const,
  }));
  const angleReport = forgeAllAnglesReport({
    angles: angleInputs,
    forgeValidated: metrics.validated,
    forgeDecision: 'inert',
    forgedEdgePts: 100 * edge,
  });
  const analysis = `${input.contextSummary} The Forge reads ${input.label} at ${(100 * probability).toFixed(1)}% against a ${(100 * fair).toFixed(1)}% fair rate, weighing ${angleReport.measuredCount} of ${angleReport.angleCount} causal angles (${angleInputs.map((angle) => angle.label).join(', ')}); it has ${metrics.validated ? 'a validated' : 'no validated'} out-of-sample edge, and its teachers were wrong on ${teacherError} of the holdout rows. ${angleReport.summary}`;
  const note = `${describeGate(metrics)} ${metrics.validated ? `Forged view ${(100 * probability).toFixed(1)}%, drive ${drive}/100.` : 'The estimate is unchanged.'}`;
  return {
    card,
    metrics,
    probability,
    fair,
    edgePts: 100 * edge,
    drive,
    analysis,
    weight,
    validated: metrics.validated,
    skill: metrics.brierSkill,
    sample: metrics.holdoutRows,
    note,
  };
}

export type ForgeFusionInput = {
  /** The probability the chain publishes before the forge speaks. */
  published: number;
  fair: number;
  model: ForgedModel | null;
  /** Measured standard error of the published probability, when known. */
  standardError?: number | null;
};

/**
 * Fold the forged forecast into the number a tool publishes, and decide what
 * the forge did to the call.
 *
 * Rules, in order (they mirror the research and neural fusions so the layers
 * can never contradict each other about how much a model is worth):
 *
 *   1. No model, no validation, no weight: the published number is returned
 *      bit-identical and the decision is `inert`.
 *   2. Validated and agreeing: the forged edge is blended in at its earned
 *      weight, over the same fair baseline. The forge can move the number.
 *   3. Validated and materially lower: `trim` — the published edge is blended
 *      toward the forged one and the excess is removed.
 *   4. Validated and against the call (the forged edge is on the other side of
 *      fair by more than the material threshold): `veto` — the published edge
 *      is cut to 35% of its size and the analyzers are told to stop calling the
 *      entry decisive.
 *   5. Unvalidated: inert — it cannot move the published number in either
 *      direction until its own independent gate passes.
 */
export function applyForge(input: ForgeFusionInput): { probability: number; fusion: ForgeFusion } {
  const publishedRaw = finite(input.published) ? input.published : 0.5;
  const published = safeProbability(publishedRaw);
  const fair = clamp(finite(input.fair) ? input.fair : 0.5, 0.001, 0.999);
  const model = input.model;
  const material = Math.max(0.005, 0.01 * fair);
  if (!model) {
    return {
      probability: publishedRaw,
      fusion: {
        probability: publishedRaw,
        fair,
        modelProbability: fair,
        weight: 0,
        contributionPts: 0,
        validated: false,
        skill: null,
        sample: 0,
        edgePts: 0,
        drive: 0,
        stance: 'neutral',
        decision: 'inert',
        note: 'The forged model could not be fitted for this call on this market, so the published estimate is unchanged.',
      },
    };
  }
  const modelProbability = safeProbability(model.probability);
  const publishedEdge = published - fair;
  const forgedEdge = modelProbability - fair;
  const validated = model.validated && model.weight > 0;
  const weight = validated ? clamp(model.weight, 0, FORGE_MAX_WEIGHT) : 0;
  const stance: ForgeFusion['stance'] = Math.abs(forgedEdge) < material
    ? 'neutral'
    : forgedEdge > 0 === publishedEdge > 0
      ? 'supportive'
      : 'contradicting';
  const opposite = Math.abs(publishedEdge) > 0 && forgedEdge * publishedEdge < 0 && Math.abs(forgedEdge) > material;
  let next = published;
  let decision: ForgeFusion['decision'] = 'inert';
  let applied = 0;
  if (validated) {
    if (opposite && Math.abs(forgedEdge) > 1.5 * material) {
      // Veto: the strongest thing the forge can do to a call it has measured
      // against. It cuts the edge rather than inverting it — the chain still
      // owns the direction, the forge only refuses to certify it.
      next = safeProbability(fair + 0.35 * publishedEdge);
      decision = 'veto';
      applied = 0.65;
    } else if (forgedEdge < publishedEdge - material) {
      next = safeProbability(fair + (1 - weight) * publishedEdge + weight * forgedEdge);
      decision = 'trim';
      applied = weight;
    } else {
      next = safeProbability(fair + (1 - weight) * publishedEdge + weight * forgedEdge);
      decision = 'confirm';
      applied = weight;
    }
  }
  // Below the gate the forge is inert — it does not even trim.
  //
  // The research layer is allowed to subtract without validating because its
  // audit is an independent model suite with its own holdout. The forge is
  // fitted on the same rows the chain publishes, once per candidate, in a scan
  // of dozens of candidates: a sub-gate model that "knows" a call is worse than
  // the chain is far more often the expected maximum of that search than a
  // measurement. On a uniform stream the honest answer is that the model found
  // nothing, and it must publish nothing.
  const contributionPts = 100 * (next - published);
  const direction = decision === 'inert' ? 'was not applied' : decision === 'confirm' ? 'confirmed the call' : decision === 'trim' ? 'trimmed the call' : 'vetoed the entry';
  const note = decision === 'inert'
    ? `${model.note} ${model.validated ? 'It agreed too closely to change the number.' : 'It may only lower a call, and it did not.'}`
    : `The forged model ${direction} at ${(100 * applied).toFixed(0)}% weight (${contributionPts >= 0 ? '+' : ''}${contributionPts.toFixed(2)} pts): ${model.skill === null ? '—' : `${(100 * model.skill).toFixed(1)}%`} Brier skill on ${model.sample} unseen rows, drive ${model.drive}/100.`;
  return {
    probability: next,
    fusion: {
      probability: next,
      fair,
      modelProbability,
      weight: applied,
      contributionPts,
      validated,
      skill: model.skill,
      sample: model.sample,
      edgePts: 100 * forgedEdge,
      drive: model.drive,
      stance,
      decision,
      note,
    },
  };
}

/** Evidence the forge hands to the confidence score. */
export function forgeEvidence(fusion: ForgeFusion): {
  probability: number;
  fair: number;
  skill: number | null;
  sample: number;
  validated: boolean;
  contradicted: boolean;
} {
  return {
    probability: fusion.modelProbability,
    fair: fusion.fair,
    skill: fusion.skill,
    sample: fusion.sample,
    validated: fusion.validated && fusion.weight > 0 && fusion.decision !== 'inert',
    // A veto is a validated contradiction; a trim is a measured disagreement.
    contradicted: fusion.validated && (fusion.decision === 'veto' || fusion.stance === 'contradicting'),
  };
}

/** True when the forge measured this call as weaker than the chain claims. */
export function forgeVetoed(fusion: ForgeFusion | null | undefined): boolean {
  return Boolean(fusion && fusion.decision === 'veto');
}

/** One angle the forge weighed when it formed its view of a call. */
export type ForgeAngleDomain = {
  domain: 'engines' | 'calculations' | 'market-structure' | 'knowledge' | 'ai' | 'research' | 'neural';
  /** Human label for the card. */
  label: string;
  /** True when this angle had real, non-missing data at the live origin. */
  measured: boolean;
  /** Which way this angle leans, when it was measured. */
  verdict: 'supports' | 'opposes' | 'neutral' | 'unmeasured';
  detail?: string;
};

/** The complete, auditable inventory of every angle the forge considered. */
export type ForgeAllAnglesReport = {
  angles: ForgeAngleDomain[];
  /** How many named angles the forge was built from. */
  angleCount: number;
  /** How many of those angles had real data at the live origin. */
  measuredCount: number;
  /** Share of named angles that were measured (0-1). */
  coverage: number;
  /** Measured angles that support the call. */
  supportCount: number;
  /** Measured angles that oppose the call. */
  opposeCount: number;
  /** Share of measured angles that support the call (null when none measured). */
  supportShare: number | null;
  /** Overall bias of the measured angles. */
  dominantVerdict: 'supports' | 'opposes' | 'neutral' | 'unmeasured' | 'mixed';
  /** Whether the forged model cleared its out-of-sample gate. */
  forgeValidated: boolean;
  /** How the forge treated the published call. */
  forgeDecision: ForgeFusion['decision'];
  /** Forged edge in probability points. */
  forgedEdgePts: number;
  /** One-sentence, auditable reading of the all-angles view. */
  summary: string;
};

/**
 * Inventories every angle the forge looked at and rolls it into one auditable
 * reading. Used by the model card and the analysis so the user can see that
 * the forged probability was built from engines, baseline, prior, market
 * structure, knowledge, AI, research and neural layers — not from one of them
 * in isolation.
 */
export function forgeAllAnglesReport(input: {
  angles: readonly ForgeAngleDomain[];
  forgeValidated: boolean;
  forgeDecision: ForgeFusion['decision'];
  forgedEdgePts: number;
}): ForgeAllAnglesReport {
  const angles = [...input.angles];
  const angleCount = angles.length;
  const measured = angles.filter((angle) => angle.measured);
  const measuredCount = measured.length;
  const coverage = angleCount ? measuredCount / angleCount : 0;
  const supportCount = measured.filter((angle) => angle.verdict === 'supports').length;
  const opposeCount = measured.filter((angle) => angle.verdict === 'opposes').length;
  const neutralCount = measured.filter((angle) => angle.verdict === 'neutral').length;
  const supportShare = measuredCount ? supportCount / measuredCount : null;

  let dominantVerdict: ForgeAllAnglesReport['dominantVerdict'] = 'unmeasured';
  if (measuredCount) {
    const top = Math.max(supportCount, opposeCount, neutralCount);
    if (top === supportCount && supportCount > opposeCount && supportCount > neutralCount) dominantVerdict = 'supports';
    else if (top === opposeCount && opposeCount > supportCount && opposeCount > neutralCount) dominantVerdict = 'opposes';
    else if (top === neutralCount && neutralCount > 0) dominantVerdict = 'neutral';
    else dominantVerdict = 'mixed';
  }

  const edgeSign = input.forgedEdgePts > 0 ? 'above' : input.forgedEdgePts < 0 ? 'below' : 'at';
  const measuredList = measured.map((angle) => angle.label).join(', ') || 'none';
  let summary: string;
  if (!input.forgeValidated) {
    summary = `The forge weighed ${measuredCount} of ${angleCount} angles (${measuredList}) but did not clear its out-of-sample gate, so it carries no weight on this call.`;
  } else if (input.forgeDecision === 'veto') {
    summary = `The forge weighed ${measuredCount} of ${angleCount} angles and validated a contrary read (${(input.forgedEdgePts).toFixed(1)} pts ${edgeSign} fair); entry is vetoed.`;
  } else if (input.forgeDecision === 'trim') {
    summary = `The forge weighed ${measuredCount} of ${angleCount} angles (${(100 * supportShare!).toFixed(0)}% supporting) and trimmed the call by ${(input.forgedEdgePts).toFixed(1)} pts.`;
  } else if (input.forgeDecision === 'confirm') {
    summary = `The forge weighed ${measuredCount} of ${angleCount} angles (${(100 * supportShare!).toFixed(0)}% supporting) and confirmed the call (${(input.forgedEdgePts).toFixed(1)} pts ${edgeSign} fair).`;
  } else {
    summary = `The forge weighed ${measuredCount} of ${angleCount} angles (${measuredList}) but left the published estimate unchanged (inert).`;
  }

  return {
    angles,
    angleCount,
    measuredCount,
    coverage,
    supportCount,
    opposeCount,
    supportShare,
    dominantVerdict,
    forgeValidated: input.forgeValidated,
    forgeDecision: input.forgeDecision,
    forgedEdgePts: input.forgedEdgePts,
    summary,
  };
}

/** The syllabus, the atlas and the input list, for the UI and the docs. */
export function forgeKnowledgeReport(family: ForgeFamily) {
  return {
    summary: summarizeKnowledge(family),
    markets: FORGE_MARKET_ATLAS.length,
    inputs: FORGE_FEATURE_COUNT,
  };
}
