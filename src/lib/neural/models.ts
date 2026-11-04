// The embedded, free neural model the tools run next to their engines.
//
// Two instances of the same architecture family are trained inside the app:
//
//   * `signal-net-digit-v1` — 10-way softmax over the next digit, trained on
//     the market's own tick stream. Every digit contract (Over/Under,
//     Even/Odd, Matches) reuses its distribution, summing the classes the
//     contract wins on.
//   * `signal-net-quote-v1` — 2-way softmax over the direction of the move a
//     Rise/Fall horizon settles on, trained on the same prices and the same
//     purged replay rows the 14 indicator engines use.
//
// Why train locally instead of downloading a model: a general-purpose
// pretrained language or vision model knows nothing about this feed, and the
// only "pretrained" signal models on offer for synthetic indices are
// unverifiable. Training here is genuinely free — no API key, no account, no
// per-token bill, no data leaving the browser — and, critically, it can be
// validated honestly on a slice of the market it was not fitted to. A model
// that has not beaten the no-edge baseline out of sample gets zero weight, so
// installing it can never manufacture an edge.
//
// Everything is deterministic for a given (ticks, seed) pair, serialisable
// (the analysis runs in Web Workers) and free of dependencies.
import { DIGIT_FEATURE_COUNT, DIGIT_FEATURE_WINDOW, QUOTE_FEATURE_COUNT, QUOTE_FEATURE_WINDOW, digitFeatures, liveDigitFeatures, liveQuoteFeatures, quoteFeatures } from './features.ts';
import { NEURAL_MAX_WEIGHT, neuralWeight, trainClassifier, type NeuralMetrics, type SupervisedRow } from './train.ts';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export type NeuralModelCard = {
  id: string;
  name: string;
  version: string;
  /** One-line description of what the network predicts. */
  task: string;
  /** Layer widths, input → … → output. */
  shape: number[];
  parameters: number;
  activation: 'relu';
  optimizer: 'adam';
  learningRate: number;
  l2: number;
  /** Epochs actually run (early stopping can end training sooner). */
  epochsRun: number;
  epochsPlanned: number;
  /** Epoch whose weights were kept. */
  bestEpoch: number;
  /** Softmax temperature fitted on the validation slice. */
  temperature: number;
  trainRows: number;
  validationRows: number;
  holdoutRows: number;
  seed: number;
  license: 'MIT';
  /** Where the weights came from — worth stating plainly on the card. */
  origin: string;
  runtime: string;
  cost: 'free';
};

export type NeuralDigitForecast = {
  kind: 'digit';
  /** Calibrated probabilities for the digit at the requested tick horizon, index 0–9. */
  distribution: number[];
  /** Number of ticks between the current origin and the target digit. */
  horizonTicks: number;
  /** Sampled out-of-sample holdout forecasts, used as causal Forge inputs. */
  replay: Array<{ origin: number; distribution: number[] }>;
  topDigit: number;
  /** Highest single-digit probability. */
  confidence: number;
  /** Normalised entropy of the distribution (1 = uniform). */
  entropy: number;
  metrics: NeuralMetrics;
  model: NeuralModelCard;
  /** Share of a published edge this model has earned (0 when unvalidated). */
  weight: number;
  /** Out-of-sample Brier skill of the distribution. */
  skill: number | null;
  note: string;
};

export type NeuralQuoteForecast = {
  kind: 'quote';
  /** Calibrated probability that the horizon's exit price is above the entry. */
  probabilityUp: number;
  /** Sampled out-of-sample holdout forecasts at their causal tick origins. */
  replay: Array<{ origin: number; probabilityUp: number }>;
  probabilityDown: number;
  /** 'RISE' when the network leans up, 'FALL' otherwise. */
  direction: 'RISE' | 'FALL';
  /** Distance of the up-probability from a coin flip, in points. */
  leanPts: number;
  metrics: NeuralMetrics;
  model: NeuralModelCard;
  weight: number;
  skill: number | null;
  note: string;
};

export type NeuralFusion = {
  /** The model's probability for the traded outcome. */
  probability: number;
  fair: number;
  /** Share of the edge the model supplied (0 when it had no vote). */
  weight: number;
  /** Probability points the model moved the published estimate by. */
  contributionPts: number;
  validated: boolean;
  skill: number | null;
  sample: number;
  stance: 'supportive' | 'contradicting' | 'neutral';
  note: string;
};

export const DIGIT_MODEL_ID = 'signal-net-digit-v1';
export const QUOTE_MODEL_ID = 'signal-net-quote-v1';
export const NEURAL_LICENSE = 'MIT' as const;

const DIGIT_SPEC = {
  inputDim: DIGIT_FEATURE_COUNT,
  hidden: [24, 12] as const,
  outputs: 10,
  seed: 0x5eed_1d19,
  learningRate: 0.008,
  l2: 1e-4,
  epochs: 12,
  batchSize: 32,
  patience: 3,
};

const QUOTE_SPEC = {
  inputDim: QUOTE_FEATURE_COUNT,
  hidden: [24, 12] as const,
  outputs: 2,
  seed: 0x5eed_9a0e,
  learningRate: 0.01,
  l2: 1e-4,
  epochs: 10,
  batchSize: 24,
  patience: 3,
};

function uniformEntropy(distribution: ArrayLike<number>): number {
  let entropy = 0;
  for (let index = 0; index < distribution.length; index += 1) {
    const value = distribution[index];
    if (value > 0) entropy -= value * Math.log(value);
  }
  return entropy / Math.log(distribution.length);
}

function cardFrom(
  id: string,
  name: string,
  task: string,
  shape: number[],
  parameters: number,
  spec: typeof DIGIT_SPEC,
  trained: { epochsRun: number; bestEpoch: number; temperature: number },
  metrics: NeuralMetrics,
  origin: string,
): NeuralModelCard {
  return {
    id,
    name,
    task,
    version: '1.0.0',
    shape,
    parameters,
    activation: 'relu',
    optimizer: 'adam',
    learningRate: spec.learningRate,
    l2: spec.l2,
    epochsRun: trained.epochsRun,
    epochsPlanned: spec.epochs,
    bestEpoch: trained.bestEpoch,
    temperature: trained.temperature,
    trainRows: metrics.trainRows,
    validationRows: metrics.validationRows,
    holdoutRows: metrics.holdoutRows,
    seed: spec.seed,
    license: NEURAL_LICENSE,
    origin,
    runtime: 'Trained and executed locally in a Web Worker · no network, no account, no cost',
    cost: 'free',
  };
}

function metricNote(metrics: NeuralMetrics): string {
  const accuracy = metrics.accuracy === null ? '—' : `${(100 * metrics.accuracy).toFixed(1)}%`;
  const baseline = metrics.baselineAccuracy === null ? '—' : `${(100 * metrics.baselineAccuracy).toFixed(1)}%`;
  const skill = metrics.brierSkill === null ? '—' : `${(100 * metrics.brierSkill).toFixed(1)}%`;
  const z = metrics.z === null ? '—' : metrics.z.toFixed(2);
  if (metrics.validated) {
    return `Validated out of sample: ${accuracy} hit rate vs ${baseline} baseline, ${skill} Brier skill, z ${z} on ${metrics.holdoutRows} unseen ticks.`;
  }
  return `Not validated on this market: ${accuracy} hit rate vs ${baseline} baseline, ${skill} Brier skill, z ${z} on ${metrics.holdoutRows} unseen ticks. It carries no vote until it beats chance.`;
}

/**
 * Train the digit network on a tick stream and forecast the digit at the
 * requested horizon. This keeps the network's target aligned with the contract
 * expiry instead of reusing a one-tick forecast for multi-tick contracts.
 * Returns null when the stream cannot support a fit (callers simply carry on
 * without the model — this layer is additive, never a dependency).
 */
export function trainDigitNeuralModel(digits: readonly number[], options: { seed?: number; horizonTicks?: number } = {}): NeuralDigitForecast | null {
  const horizonTicks = options.horizonTicks ?? 1;
  if (!Number.isInteger(horizonTicks) || horizonTicks < 1 || horizonTicks > 10) throw new Error('Digit neural horizons must be 1–10 ticks.');
  if (!Array.isArray(digits) || digits.length < DIGIT_FEATURE_WINDOW + 200 + horizonTicks - 1) return null;
  // Bound the work on long streams: the ensemble already trains on all of it,
  // and a 2,000-row window is plenty for a 3k-parameter network.
  const sourceOffset = Math.max(0, digits.length - 2_600);
  const source = sourceOffset ? digits.slice(sourceOffset) : digits;
  const rows: SupervisedRow[] = [];
  for (let index = DIGIT_FEATURE_WINDOW - 1; index + horizonTicks < source.length; index += 1) {
    const features = digitFeatures(source, index);
    const label = source[index + horizonTicks];
    if (!features || !Number.isInteger(label) || label < 0 || label > 9) continue;
    rows.push({ features, label, origin: index, exit: index + horizonTicks });
  }
  const spec = { ...DIGIT_SPEC, seed: options.seed ?? DIGIT_SPEC.seed };
  const trained = trainClassifier(rows, {
    spec,
    purge: Math.max(12, horizonTicks),
    maxTrainRows: 640,
    maxValidationRows: 224,
    maxHoldoutRows: 448,
  });
  if (!trained) return null;
  const live = liveDigitFeatures(source);
  if (!live) return null;
  const probabilities = trained.predict(live);
  const distribution = Array.from(probabilities, (value) => clamp(Number.isFinite(value) ? value : 0.1, 1e-6, 1));
  const total = distribution.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < distribution.length; index += 1) distribution[index] /= total;
  const topDigit = distribution.indexOf(Math.max(...distribution));
  const metrics = trained.metrics;
  const weight = neuralWeight(metrics);
  const parameters = trained.network.layers.reduce((sum, layer) => sum + layer.weights.length + layer.biases.length, 0);
  return {
    kind: 'digit',
    distribution,
    horizonTicks,
    replay: trained.holdoutPredictions.flatMap((row) => Number.isInteger(row.origin)
      ? [{ origin: row.origin! + sourceOffset, distribution: [...row.probabilities] }]
      : []),
    topDigit,
    confidence: distribution[topDigit],
    entropy: uniformEntropy(distribution),
    metrics,
    model: cardFrom(
      DIGIT_MODEL_ID,
      'SignalLab Nano · digit net',
      `Target-digit probability at ${horizonTicks}-tick horizon (10 classes)`,
      [...trained.network.shape],
      parameters,
      spec,
      trained,
      metrics,
      'Trained now, on this market’s own tick stream — no pretrained weights are downloaded.',
    ),
    weight,
    skill: metrics.brierSkill,
    note: `${metricNote(metrics)} Top digit ${topDigit} at ${(100 * distribution[topDigit]).toFixed(1)}%.`,
  };
}

/**
 * Train the direction network for one Rise/Fall horizon.
 *
 * `exits[index]` is the tick the contract started at `index` settles on, so the
 * label is the sign of the price change over exactly that horizon. The rows
 * are chronological, and the caller's split is respected because the same
 * boundaries are re-derived from their order here.
 */
export function trainQuoteNeuralModel(
  prices: readonly number[],
  exits: ArrayLike<number>,
  options: { seed?: number; horizonTicks?: number } = {},
): NeuralQuoteForecast | null {
  if (!Array.isArray(prices) || prices.length < QUOTE_FEATURE_WINDOW + 200) return null;
  const rows: SupervisedRow[] = [];
  for (let index = QUOTE_FEATURE_WINDOW; index < prices.length; index += 1) {
    const exit = exits[index];
    if (!Number.isInteger(exit) || exit <= index || exit >= prices.length) continue;
    const features = quoteFeatures(prices, index);
    if (!features) continue;
    const change = prices[exit] - prices[index];
    if (change === 0) continue;
    rows.push({ features, label: change > 0 ? 1 : 0, origin: index, exit });
  }
  if (rows.length < 200) return null;
  // Purge at least the horizon: a row's label reaches into the next slice.
  const purge = Math.max(12, Math.trunc(options.horizonTicks ?? 12));
  const spec = { ...QUOTE_SPEC, seed: options.seed ?? QUOTE_SPEC.seed };
  const trained = trainClassifier(rows, {
    spec,
    purge,
    maxTrainRows: 512,
    maxValidationRows: 224,
    maxHoldoutRows: 448,
  });
  if (!trained) return null;
  const live = liveQuoteFeatures(prices);
  if (!live) return null;
  const probabilities = trained.predict(live);
  const up = clamp(probabilities[1], 0.001, 0.999);
  const metrics = trained.metrics;
  const weight = neuralWeight(metrics);
  const parameters = trained.network.layers.reduce((sum, layer) => sum + layer.weights.length + layer.biases.length, 0);
  return {
    kind: 'quote',
    probabilityUp: up,
    probabilityDown: 1 - up,
    replay: trained.holdoutPredictions.flatMap((row) => Number.isInteger(row.origin) && Number.isFinite(row.probabilities[1])
      ? [{ origin: row.origin!, probabilityUp: clamp(row.probabilities[1], 0.001, 0.999) }]
      : []),
    direction: up >= 0.5 ? 'RISE' : 'FALL',
    leanPts: 100 * (up - 0.5),
    metrics,
    model: cardFrom(
      QUOTE_MODEL_ID,
      'SignalLab Nano · quote net',
      'Direction of the horizon’s move (2 classes)',
      [...trained.network.shape],
      parameters,
      spec,
      trained,
      metrics,
      'Trained now, on this market’s own price history and horizon — no pretrained weights are downloaded.',
    ),
    weight,
    skill: metrics.brierSkill,
    note: `${metricNote(metrics)} Next move leans ${up >= 0.5 ? 'up' : 'down'} at ${(100 * (up >= 0.5 ? up : 1 - up)).toFixed(1)}%.`,
  };
}

export type NeuralFusionInput = {
  /** Published probability after the confirmation and research layers. */
  probability: number;
  /** No-edge probability of the traded outcome. */
  fair: number;
  /** The model's probability for the traded outcome (null = no view). */
  neuralProbability: number | null;
  /** Weight earned by the model (0–0.25). */
  weight: number;
  metrics?: NeuralMetrics | null;
};

const finiteProbability = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0.0005, 0.9995) : null;

/**
 * Fold the neural forecast into the estimate the tools publish.
 *
 * Identical rule to the research fusion: the model is a weighted second
 * opinion, never a multiplier, and it can only participate when it cleared its
 * own out-of-sample bar. With weight 0 the estimate is returned untouched, so
 * an unvalidated or unavailable model is provably inert.
 */
export function fuseNeural(input: NeuralFusionInput): { probability: number; fusion: NeuralFusion } {
  const base = finiteProbability(input.probability);
  const fair = finiteProbability(input.fair) ?? 0.5;
  const neural = finiteProbability(input.neuralProbability);
  const metrics = input.metrics ?? null;
  const sample = metrics?.holdoutRows ?? 0;
  const skill = metrics?.brierSkill ?? null;
  const validated = Boolean(metrics?.validated) && input.weight > 0 && neural !== null;
  const weight = validated ? clamp(input.weight, 0, NEURAL_MAX_WEIGHT) : 0;
  const material = Math.max(0.004, 0.01 * fair);
  if (base === null || neural === null) {
    return {
      probability: input.probability,
      fusion: {
        probability: neural ?? base ?? fair,
        fair,
        weight: 0,
        contributionPts: 0,
        validated,
        skill,
        sample,
        stance: 'neutral',
        note: `The embedded neural model had no usable forecast for this outcome, so the estimate is unchanged.`,
      },
    };
  }
  const baseEdge = base - fair;
  const neuralEdge = neural - fair;
  const next = weight > 0 ? clamp(fair + (1 - weight) * baseEdge + weight * neuralEdge, 0.0005, 0.9995) : base;
  const contributionPts = 100 * (next - base);
  const stance: NeuralFusion['stance'] = Math.abs(neuralEdge) < material
    ? 'neutral'
    : neuralEdge > 0 === baseEdge > 0
      ? 'supportive'
      : 'contradicting';
  const note = weight <= 0
    ? `The neural model saw this outcome at ${(100 * neural).toFixed(1)}% but has not beaten chance out of sample on this market, so it carries no weight (${(100 * (skill ?? 0)).toFixed(1)}% Brier skill on ${sample} unseen ticks).`
    : `Neural model folded in at ${(100 * weight).toFixed(0)}% weight (${contributionPts >= 0 ? '+' : ''}${contributionPts.toFixed(2)} pts): ${(100 * (skill ?? 0)).toFixed(1)}% Brier skill on ${sample} unseen ticks.`;
  return {
    probability: next,
    fusion: {
      probability: neural,
      fair,
      weight,
      contributionPts,
      validated,
      skill,
      sample,
      stance,
      note,
    },
  };
}

/** Evidence the neural layer hands to the confidence score. */
export function neuralEvidence(fusion: NeuralFusion): {
  probability: number;
  fair: number;
  skill: number | null;
  sample: number;
  validated: boolean;
  contradicted: boolean;
} {
  return {
    probability: fusion.probability,
    fair: fusion.fair,
    skill: fusion.skill,
    sample: fusion.sample,
    validated: fusion.validated && fusion.weight > 0,
    contradicted: fusion.validated && fusion.stance === 'contradicting',
  };
}
