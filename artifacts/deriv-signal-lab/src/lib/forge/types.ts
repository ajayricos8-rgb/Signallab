// Shared types for Layer 8 — the forged model.
//
// One model, one number, three jobs: the forge produces the analysis view (what
// the market is doing and which inputs carry it), the prediction (the
// probability the traded outcome wins) and the entry verdict (whether the call
// is strong enough to enter, and how much of its edge survives).
export type ForgeFamily = 'digit' | 'rise-fall';

/** How the forge ended up treating the published call. */
export type ForgeDecision =
  /** Not validated on this market: reported, carries no weight, cannot raise anything. */
  | 'inert'
  /** Validated and agreeing: folded into the published probability at its weight. */
  | 'confirm'
  /** Validated and materially lower: the published edge was trimmed. */
  | 'trim'
  /** Validated and against the call: the edge was cut and the entry cannot be decisive. */
  | 'veto';

/** One input the forged network actually consumes, labelled for the card. */
export type ForgeFeature = {
  /** Position in the feature vector. */
  index: number;
  key: string;
  label: string;
  /** The knowledge entry that justifies this input, when there is one. */
  knowledge?: string;
};

/** A single training stage, so the curriculum is visible on the card. */
export type ForgeStage = {
  id: string;
  label: string;
  /** Rows or facts consumed by the stage. */
  size: number;
  detail: string;
};

export type ForgeModelCard = {
  id: string;
  name: string;
  version: string;
  task: string;
  family: ForgeFamily;
  /** Input → hidden → output widths. */
  shape: number[];
  parameters: number;
  activation: 'relu';
  optimizer: 'adam';
  learningRate: number;
  l2: number;
  /** Soft-target distillation share mixed into the hard label. */
  distillation: number;
  epochsRun: number;
  epochsPlanned: number;
  bestEpoch: number;
  temperature: number;
  trainRows: number;
  validationRows: number;
  holdoutRows: number;
  seed: number;
  license: 'MIT';
  /** Where the weights came from — always this market, never a download. */
  origin: string;
  runtime: string;
  cost: 'free';
  /** Version of the syllabus the model was trained against. */
  knowledgeVersion: string;
  /** Frozen inputs the model was forged from, for auditability. */
  features: ForgeFeature[];
  /** Causal analysis-layer outputs and market calculations consumed as inputs. */
  inputs: string[];
  /** The teacher layers distillation drew on. */
  teachers: string[];
  /** Ordered curriculum actually executed for this fit. */
  stages: ForgeStage[];
};

export type ForgeMetrics = {
  trainRows: number;
  validationRows: number;
  holdoutRows: number;
  /** Share of holdout rows whose call was right. */
  accuracy: number | null;
  /** Accuracy of the no-edge rate on the same rows. */
  baselineAccuracy: number | null;
  /** Mean Brier loss of the forged probability on holdout rows. */
  brier: number | null;
  /** Mean Brier loss of the no-edge rate on the same rows. */
  baselineBrier: number | null;
  /** 1 − brier / baselineBrier. */
  brierSkill: number | null;
  /** Paired z of the per-row Brier improvement. */
  z: number | null;
  /**
   * The z this fit had to clear: the base bar, raised for the number of
   * candidates the scan compared (the same multiple-comparison correction the
   * analysis engines apply).
   */
  zBar: number;
  logLoss: number | null;
  baselineLogLoss: number | null;
  logLossSkill: number | null;
  /** Reliability of the holdout probabilities: |mean forecast − hit rate|. */
  calibrationGap: number | null;
  /** True only when every out-of-sample gate the syllabus names has passed. */
  validated: boolean;
  /** Why the gate passed or failed, one line per condition. */
  gate: string[];
  temperature: number;
  temperatureGain: number;
  /** Share of holdout rows whose teacher disagreed with the realised outcome. */
  teacherErrorRate: number | null;
  /**
   * How much of the network's own correction survived validation (1 = all of
   * it, 0 = the forge is publishing the audited teacher unchanged).
   */
  residualScale: number;
};

/** The forged model as it stands after training, before fusion into a call. */
export type ForgedModel = {
  card: ForgeModelCard;
  metrics: ForgeMetrics;
  /** The model's live probability for the traded outcome. */
  probability: number;
  /** No-edge probability of that outcome. */
  fair: number;
  /** Forged edge in probability points. */
  edgePts: number;
  /** How strongly the model leans, 0–100 (a conviction, not a win rate). */
  drive: number;
  /** The model's own reading of the market and of its own reliability. */
  analysis: string;
  /** Share of the published edge the model has earned (0 when unvalidated). */
  weight: number;
  validated: boolean;
  skill: number | null;
  sample: number;
  /** One sentence for the ledger. */
  note: string;
};

/** Fusion of the forged forecast into the number a tool publishes. */
export type ForgeFusion = {
  /** The probability the tool publishes after the forge spoke. */
  probability: number;
  fair: number;
  /** The model's own probability for the traded outcome. */
  modelProbability: number;
  /** Share of the published edge the forge supplied (0 when inert). */
  weight: number;
  /** Probability points the forge moved the published estimate by. */
  contributionPts: number;
  validated: boolean;
  skill: number | null;
  sample: number;
  /** Forged edge in points, against the same fair rate. */
  edgePts: number;
  /** How strongly the model leans, 0–100. */
  drive: number;
  stance: 'supportive' | 'contradicting' | 'neutral';
  decision: ForgeDecision;
  note: string;
};

/** Everything the analyzers publish about the forge for one candidate. */
export type ForgeResult = {
  model: ForgedModel;
  fusion: ForgeFusion;
};

export const FORGE_MODEL_ID = 'signal-lab-forge-v1';
export const FORGE_LICENSE = 'MIT' as const;
/** Highest share of a published edge the forge may ever take. */
export const FORGE_MAX_WEIGHT = 0.3;
/** Independent holdout rows the forge needs before it can carry weight. */
export const FORGE_MIN_HOLDOUT = 60;
/** Paired z the forged holdout improvement must clear. */
export const FORGE_MIN_Z = 2;
