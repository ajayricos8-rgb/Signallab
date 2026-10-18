// The research library is pure, deterministic and safe to run in scan workers.
// Catalog entries are measurements/policies, NOT 300 independent model votes.
export type ToolFamily = 'rise-fall' | 'over-under' | 'even-odd' | 'matches';
export type EngineDomain = 'all' | 'digits' | 'quotes' | 'matches' | 'even-odd' | 'over-under' | 'settled-trades';
export type EngineRole = 'measurement' | 'prediction' | 'validation' | 'synthesis' | 'filter' | 'performance';
export type EngineStatus = 'active' | 'context' | 'insufficient' | 'unavailable' | 'alias';
export type EngineDefinition = {
  id: number;
  name: string;
  category: string;
  domain: EngineDomain;
  role: EngineRole;
  method: string;
  sources: string[];
  aliasOf?: number;
};
export type EngineReading = {
  id: number;
  status: EngineStatus;
  value: number | string | null;
  sample: number;
  detail: string;
  /** Extra values, including matrices, for the expandable inspector/export. */
  data?: Record<string, number | string | null | (number | null)[] | (number | null)[][]>;
  /** Signed contribution in probability points. Null means no probability vote. */
  contribution: number | null;
};
export type LabTick = { epoch: number; quote?: number; digit?: number | null };
export type LabContract =
  | { family: 'rise-fall'; direction: 'RISE' | 'FALL' }
  | { family: 'over-under'; contractType: 'DIGITOVER' | 'DIGITUNDER'; barrier: number }
  | { family: 'even-odd'; contractType: 'DIGITEVEN' | 'DIGITODD' }
  | { family: 'matches'; contractType: 'DIGITMATCH'; targetDigit: number };
export type LabHorizon = { unit: 'ticks' | 'minutes'; value: number };
export type SettledReturn = {
  /** Actual settled provider-reported P&L and stake. External costs are not guessed. */
  epoch: number;
  stake: number;
  profit: number;
};
export type ModelSpec = { id: string; name: string; family: string; engines: number[] };
export type ForecastRow = {
  origin: number;
  exit: number;
  target: number;
  probabilities: number[][];
  regime: number;
};
export type ForecastBank = {
  kind: 'digit' | 'quote';
  horizon: LabHorizon;
  models: ModelSpec[];
  tuning: ForecastRow[];
  calibration: ForecastRow[];
  holdout: ForecastRow[];
  live: number[][];
  nextTick: number[][];
  /** Boundaries are indices, and every label settles BEFORE the next phase. */
  boundaries: { tuningStart: number; calibrationStart: number; holdoutStart: number; lastOrigin: number };
  liveRegime: number;
  /** No-edge state probabilities estimated before tuning (quotes retain flat mass). */
  baseline: number[];
};
export type ProbabilityAuditRow = {
  origin: number;
  exit: number;
  probability: number;
  raw: number;
  won: 0 | 1;
  called: boolean;
};
export type ModelAudit = ModelSpec & {
  probability: number;
  weight: number;
  bayesianWeight: number;
  tuningBrier: number | null;
  holdoutBrier: number | null;
  skill: number | null;
  contribution: number;
  /** Fixed-model, leave-one-model-out loss change on holdout; not causal importance. */
  ablation: number | null;
};
export type ResearchAudit = {
  probability: number;
  rawProbability: number;
  nextTickProbability: number;
  fair: number;
  sample: number;
  tuningSample: number;
  calibrationSample: number;
  brier: number | null;
  baselineBrier: number | null;
  skill: number | null;
  improvementZ: number | null;
  correctedP: number | null;
  validated: boolean;
  calibrationMethod: 'identity' | 'isotonic-shrinkage';
  calibrationError: number | null;
  bins: Array<{ sample: number; predicted: number | null; observed: number | null }>;
  weights: number[];
  correlations: (number | null)[][];
  redundantPairs: Array<[string, string]>;
  models: ModelAudit[];
  rows: ProbabilityAuditRow[];
  boundaries: ForecastBank['boundaries'];
  /** Tuning-only selection; no selecting a model from its final test result. */
  selectedModel: string;
  regimeModel: string | null;
  regimeSample: number;
  selectionPool: number;
};
export type ResearchDecision = {
  action: 'candidate' | 'observe';
  eligible: boolean;
  reasons: string[];
  /** A validated contradiction may shrink a legacy edge; never inflate it. */
  edgeMultiplier: number;
  confidencePenalty: number;
  requiresPayout: true;
};
export type EngineLabReport = {
  version: '1.0.0';
  family: ToolFamily;
  symbol: string;
  asOfEpoch: number | null;
  horizon: LabHorizon;
  contract: LabContract;
  registered: number;
  counts: Record<EngineStatus, number>;
  readings: EngineReading[];
  research: ResearchAudit;
  decision: ResearchDecision;
  warnings: string[];
  /** Loaded history of the account active at scan time; not automatically refreshed. */
  accounting: { sample: number; currency: string | null };
  /** A snapshot: never silently refreshed with ticks from a different analysis. */
  sample: { digits: number; quotes: number; candles: number };
};
