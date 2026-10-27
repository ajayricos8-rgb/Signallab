// Shared vote counting, out-of-sample backtest summaries and the confidence
// score used by every signal tool (Rise/Fall, Over/Under, Even/Odd, Matches).
//
// Confidence is an evidence score from 1 to 99. It is NOT a win probability:
// it blends (1) how much of the engine weight agrees with the signal, (2) how
// large the estimated edge is relative to the contract's fair probability,
// (3) how the same consensus rule performed on recent held-out ticks and
// (4) out-of-sample model skill, then shrinks toward 50 when data quality is
// weaker. Synthetic indices are random-number driven, so no score guarantees
// an outcome.

export type SignalStrength = 'STRONG' | 'MODERATE' | 'WEAK';
export type VoteDirection = 'agree' | 'against' | 'neutral' | 'abstain';

export type EngineVote = {
  id: string;
  label: string;
  family: string;
  vote: VoteDirection;
  /** Engine estimate for the signalled outcome (a probability from 0 to 1). */
  value: number | null;
  /** Share of the consensus weight this engine carried (0–1). */
  weight: number;
  /** Out-of-sample skill used to set the weight; null when unmeasured. */
  skill: number | null;
  note: string;
};

export type VoteTally = {
  agreeing: number;
  against: number;
  neutral: number;
  abstained: number;
  /** Engines that produced an estimate (agree + against + neutral). */
  voting: number;
  /** Every engine in the panel, including abstentions. */
  total: number;
  /** Agreeing weight divided by all voting weight (0–1). */
  weightedAgreement: number;
};

export type BacktestSummary = {
  /** Held-out occasions on which the consensus favoured this outcome. */
  sample: number;
  wins: number;
  winRate: number | null;
  /** Fair (no-edge) probability of the outcome. */
  fair: number;
  /** Win-rate z-score versus the fair probability, using the effective sample. */
  zScore: number | null;
  effectiveSample: number;
};

export type ConfirmationStatus = 'confirmed' | 'adjusted' | 'cautious' | 'contradicted';

/** What the calculation + AI confirmation layer measured for this signal. */
export type ConfirmationEvidence = {
  status: ConfirmationStatus;
  /** Out-of-sample Brier skill of the calibration (0.05 = 5% better than raw). */
  calibrationSkill: number | null;
  /** −1 the analysis opposes the trade, +1 supports it, 0 no measured opinion. */
  stateAgreement: number;
  /** 0–1 strength of the measured market structure. */
  statePredictability: number;
  /** Probability points the confirmation layer added or removed. */
  adjustmentPts: number;
};

/**
 * What the 300-engine research library's forecast contributed to a signal.
 * Handed to the score by the analyzers; unvalidated research can only lower it.
 */
export type ResearchEvidence = {
  /** Share of research-model weight favouring the traded outcome (0–1). */
  agreement: number;
  /** Holdout Brier skill of the research ensemble; null when unmeasured. */
  skill: number | null;
  /** Independent holdout rows behind that skill. */
  sample: number;
  /** True only when the ensemble passed independent holdout validation. */
  validated: boolean;
  /** True when a validated ensemble contradicts the traded outcome. */
  contradicted: boolean;
};

/**
 * What the embedded neural model's forecast contributed to a signal.
 * Handed to the score by the analyzers; an unvalidated model has no vote, so
 * it can neither add nor remove confidence.
 */
export type NeuralEvidence = {
  /** The model's probability for the traded outcome. */
  probability: number;
  /** No-edge probability of that outcome. */
  fair: number;
  /** Out-of-sample Brier skill of the model; null when unmeasured. */
  skill: number | null;
  /** Independent holdout rows behind that skill. */
  sample: number;
  /** True only when the model beat chance out of sample and carries weight. */
  validated: boolean;
  /** True when a validated model contradicts the traded outcome. */
  contradicted: boolean;
};

/**
 * What the forged model (Layer 8 — engines, AI and calculations learnt into one
 * network) contributed to a signal. Only a model that cleared its own out-of-
 * sample gate can contribute; a veto is a measured contradiction and is the
 * only way this term can be negative.
 */
export type ForgeEvidence = {
  /** The forged model's probability for the traded outcome. */
  probability: number;
  /** No-edge probability of that outcome. */
  fair: number;
  /** Out-of-sample Brier skill of the forged model; null when unmeasured. */
  skill: number | null;
  /** Independent holdout rows behind that skill. */
  sample: number;
  /** True only when the model validated out of sample and carried weight. */
  validated: boolean;
  /** True when the validated model measured the call against itself. */
  contradicted: boolean;
};

/**
 * How well the published probability is pinned down. An edge smaller than its
 * own measurement error is not evidence of anything, however many engines
 * agreed on it, so this term is negative until the edge clears one standard
 * error and only saturates once it is several times larger than the noise.
 */
export type PrecisionEvidence = {
  /** Published edge over the no-edge rate, in probability units. */
  edge: number;
  /** Standard error of that edge, measured out of sample. */
  standardError: number | null;
  /** Half-width of the 95% interval for the published probability. */
  intervalHalfWidth: number | null;
};

export type ConfidenceBreakdown = {
  agreement: number;
  edge: number;
  backtest: number;
  validation: number;
  quality: number;
  /** Contribution of the precision layer (0 when none was supplied). */
  precision: number;
  verified: boolean;
  /** Contribution of the confirmation layer (0 when none was supplied). */
  confirmation: number;
  /** Contribution of the research library (0 when none was supplied). */
  research: number;
  /** Contribution of the embedded neural model (0 when none was supplied). */
  neural: number;
  /** Contribution of the forged model (0 when none was supplied). */
  forge: number;
};

export type ConfidenceInput = {
  weightedAgreement: number;
  /** (Shrunk) edge divided by the outcome's standard deviation sqrt(p(1-p)). */
  edgeRatio: number;
  backtest: BacktestSummary | null;
  validationSkill: number | null;
  /** 0–1 multiplier; lower values pull the score toward 50. */
  dataQuality: number;
  /**
   * Number of candidates competing for the final signal (contracts or
   * durations × markets). The best of many noisy candidates looks better than
   * it is, so the backtest z-score is discounted by the expected maximum.
   */
  selectionPool?: number;
  /** True only when the strict research gates also passed. */
  verified?: boolean;
  /**
   * Evidence from the calibration/AI confirmation layer. Only supplied when a
   * real out-of-sample calibration and analysis check were run; when absent the
   * score is identical to the original calibrated formula.
   */
  confirmation?: ConfirmationEvidence | null;
  /**
   * Evidence from the 300-engine research library. Only supplied when a real
   * forecast audit ran for this contract/duration; callers that do not pass it
   * keep a bit-identical score.
   */
  research?: ResearchEvidence | null;
  /**
   * Evidence from the embedded neural model. Optional: absent for callers that
   * do not run it, which keeps their score bit-identical.
   */
  neural?: NeuralEvidence | null;
  /**
   * Evidence from the forged model. Optional: callers that do not forge keep a
   * bit-identical score.
   */
  forge?: ForgeEvidence | null;
  /**
   * How precisely the probability is known. Optional: callers that do not
   * measure a standard error keep the original score to the last bit.
   */
  precision?: PrecisionEvidence | null;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const MIN_BACKTEST_SAMPLE = 20;

/** Partial (correlated-candidate) correction for the expected maximum z-score. */
export function selectionPenalty(pool: number): number {
  return 0.6 * Math.sqrt(2 * Math.log(Math.max(2, pool)));
}

/**
 * How much of a model's claimed edge historically survived out of sample: 0.3
 * with no demonstrated skill, 1 with clear skill, and only once that skill is
 * statistically distinguishable from luck (a positive Brier skill on a few
 * dozen rows is not evidence; one whose paired z clears the noise floor is).
 *
 * This is no longer applied as a multiplier on the published probability —
 * three layers used to each multiply their own trust factor in, which
 * compounded into an order-of-magnitude understatement of every real edge. It
 * now inflates the STANDARD ERROR the precision layer prices (see
 * `digit-signal.ts` / `rise-fall-signal.ts`), so an unvalidated model is
 * charged a wider error bar rather than silently rescaled.
 */
export function edgeShrinkage(validationSkill: number | null, validationZ: number | null = null): number {
  const skill = Math.max(0, validationSkill ?? 0);
  const reliability = validationZ === null || !Number.isFinite(validationZ)
    ? (skill > 0 ? 1 : 0)
    : clamp((validationZ - 1) / 1.5, 0, 1);
  return clamp(0.3 + 25 * skill * reliability, 0.3, 1);
}

export function tallyVotes(votes: readonly EngineVote[]): VoteTally {
  let agreeing = 0;
  let against = 0;
  let neutral = 0;
  let abstained = 0;
  let agreeWeight = 0;
  let votingWeight = 0;
  for (const vote of votes) {
    if (vote.vote === 'abstain') { abstained += 1; continue; }
    votingWeight += vote.weight;
    if (vote.vote === 'agree') { agreeing += 1; agreeWeight += vote.weight; }
    else if (vote.vote === 'against') against += 1;
    else neutral += 1;
  }
  return {
    agreeing, against, neutral, abstained,
    voting: agreeing + against + neutral,
    total: votes.length,
    weightedAgreement: votingWeight > 0 ? agreeWeight / votingWeight : 0,
  };
}

export function summarizeBacktest(wins: number, sample: number, fair: number, effectiveSample = sample): BacktestSummary {
  const n = Math.max(0, Math.min(sample, effectiveSample));
  const winRate = sample > 0 ? wins / sample : null;
  const deviation = Math.sqrt(Math.max(1e-9, fair * (1 - fair)));
  const zScore = winRate !== null && n >= 1 ? (winRate - fair) / (deviation / Math.sqrt(n)) : null;
  return { sample, wins, winRate, fair, zScore, effectiveSample: n };
}

/**
 * How much the research library's own validated forecast is worth to the
 * evidence score. Skill sets the size, agreement sets the sign, sample weight
 * stops a handful of rows from mattering, and an unvalidated ensemble is only
 * ever allowed to take evidence away — the same rule the probability fusion
 * uses, so the library can never manufacture confidence.
 */
export function researchTerm(evidence: ResearchEvidence): number {
  const skill = Math.max(0, Math.min(1, Number.isFinite(evidence.skill) ? (evidence.skill as number) : 0));
  const sample = Number.isFinite(evidence.sample) ? Math.max(0, evidence.sample) : 0;
  const agreement = clamp(Number.isFinite(evidence.agreement) ? evidence.agreement : 0, 0, 1);
  const direction = clamp((agreement - 0.5) / 0.5, -1, 1);
  const magnitude = Math.tanh(12 * skill) * (sample / (sample + 60));
  const signed = magnitude * direction;
  if (!evidence.validated) return Math.min(0, signed);
  if (evidence.contradicted) return Math.min(0, signed) - 0.05;
  return signed;
}

/**
 * How much the embedded neural model's forecast is worth to the evidence
 * score. Same shape as the research term: skill sets the size, the model's
 * own edge sets the sign, the sample stops a thin holdout from mattering, and
 * only a model that validated out of sample can contribute at all.
 */
export function neuralTerm(evidence: NeuralEvidence): number {
  if (!evidence.validated) return 0;
  const skill = Math.max(0, Math.min(1, Number.isFinite(evidence.skill) ? (evidence.skill as number) : 0));
  const sample = Number.isFinite(evidence.sample) ? Math.max(0, evidence.sample) : 0;
  const edge = Number.isFinite(evidence.probability) && Number.isFinite(evidence.fair)
    ? (evidence.probability - evidence.fair) / 0.05
    : 0;
  const magnitude = Math.tanh(12 * skill) * (sample / (sample + 120));
  const signed = magnitude * clamp(edge, -1, 1);
  if (evidence.contradicted) return -Math.abs(signed);
  return signed;
}

/**
 * How much the forged model's forecast is worth to the evidence score.
 *
 * The forge is the last layer and the one that saw the most, so it gets the
 * largest single-model allowance — still small (0.07 of the raw score, about
 * 3.5 points at full strength) because it is fitted on the same market as the
 * layers it distils. It only contributes once validated; a validated veto
 * contributes negatively, which is the one thing no other layer can do.
 */
export function forgeTerm(evidence: ForgeEvidence): number {
  if (!evidence.validated) return 0;
  const skill = Math.max(0, Math.min(1, Number.isFinite(evidence.skill) ? (evidence.skill as number) : 0));
  const sample = Number.isFinite(evidence.sample) ? Math.max(0, evidence.sample) : 0;
  const edge = Number.isFinite(evidence.probability) && Number.isFinite(evidence.fair)
    ? (evidence.probability - evidence.fair) / 0.05
    : 0;
  const magnitude = Math.tanh(18 * skill) * (sample / (sample + 100));
  const signed = magnitude * clamp(edge, -1, 1);
  return evidence.contradicted ? -Math.abs(signed) - 0.05 : signed;
}

/**
 * −1 when the edge is buried in its own measurement error, +1 when it stands
 * several standard errors clear of it. Zero is "one standard error", which is
 * exactly the point at which an edge stops being indistinguishable from noise.
 */
export function precisionTerm(evidence: PrecisionEvidence): number {
  const magnitude = Math.abs(Number.isFinite(evidence.edge) ? evidence.edge : 0);
  const raw = Number.isFinite(evidence.standardError) ? (evidence.standardError as number) : null;
  const interval = Number.isFinite(evidence.intervalHalfWidth) ? (evidence.intervalHalfWidth as number) : null;
  const sigma = clamp(raw ?? interval ?? 0.02, 0.002, 0.08);
  return Math.tanh((magnitude - sigma) / (1.5 * sigma));
}

/**
 * Evidence score from 1 to 99 plus its normalized components (-1 to 1).
 * Calibrated by simulation so that scanning 13 purely random markets almost
 * never produces STRONG, while genuinely structured streams score 85+.
 */
export function confidenceScore(input: ConfidenceInput): { confidence: number; breakdown: ConfidenceBreakdown } {
  const edgeRatio = Number.isFinite(input.edgeRatio) ? input.edgeRatio : 0;
  const magnitude = Math.abs(edgeRatio);
  // Agreement only counts in proportion to a material edge: correlated
  // engines agreeing on a negligible deviation is not evidence.
  const gate = clamp((magnitude - 0.01) / 0.06, 0, 1);
  const agreement = clamp((input.weightedAgreement - 0.5) / 0.5, -1, 1) * gate;
  const edge = Math.sign(edgeRatio) * Math.tanh(Math.max(0, magnitude - 0.02) / 0.06);
  // Selection inflates only the upside: discount positive z-scores by the
  // expected best-of-pool maximum, keep poor results at full strength, and
  // weight the term by how many held-out calls back it.
  const penalty = selectionPenalty(input.selectionPool ?? 1);
  const z = input.backtest?.zScore ?? null;
  const backtest = input.backtest && z !== null && input.backtest.sample > 0
    ? Math.tanh((z > 0 ? Math.max(0, z - penalty) : z) / 2) * (input.backtest.sample / (input.backtest.sample + MIN_BACKTEST_SAMPLE))
    : 0;
  const validation = input.validationSkill === null || !Number.isFinite(input.validationSkill) ? 0 : Math.tanh(25 * input.validationSkill);
  const quality = clamp(Number.isFinite(input.dataQuality) ? input.dataQuality : 0, 0, 1);
  // Confirmation only counts when it was actually measured: a calibration that
  // beat its raw probability out of sample, and/or a validated analysis prior
  // that agrees (or disagrees) with the trade.
  const confirmationSkill = input.confirmation?.calibrationSkill;
  const calibrationTerm = confirmationSkill === null || confirmationSkill === undefined || !Number.isFinite(confirmationSkill)
    ? 0
    : Math.tanh(20 * confirmationSkill);
  const stateTerm = input.confirmation
    ? clamp(input.confirmation.stateAgreement, -1, 1) * clamp(input.confirmation.statePredictability, 0, 1)
    : 0;
  const confirmation = 0.07 * calibrationTerm + 0.05 * stateTerm;
  // The research library contributes at most a few points, and only through
  // measured skill: callers without an audit keep the original score.
  const research = input.research ? 0.06 * researchTerm(input.research) : 0;
  // The embedded neural model is the newest voice and the most heavily
  // gated: it only reaches this term after beating chance out of sample, and
  // even then it can move the score by at most a few points.
  const neural = input.neural ? 0.05 * neuralTerm(input.neural) : 0;
  // The forged model is the largest single-model term and the most gated: it
  // only reaches the score after clearing its own out-of-sample gate.
  const forge = input.forge ? 0.07 * forgeTerm(input.forge) : 0;
  // Precision is the newest layer and deliberately the smallest: it decides
  // between two otherwise identical signals by how well their edge was
  // measured, it does not redefine what the evidence is worth.
  const precision = input.precision ? 0.08 * precisionTerm(input.precision) : 0;
  const raw = 0.25 * agreement + 0.25 * edge + 0.3 * backtest + 0.2 * validation + confirmation + research + neural + precision + forge;
  let confidence = 50 + 50 * raw * quality;
  // Passing every strict held-out research gate is rare and meaningful.
  if (input.verified) confidence += 8;
  return {
    confidence: Math.round(clamp(confidence, 1, 99)),
    breakdown: {
      agreement, edge, backtest, validation, quality, precision,
      verified: Boolean(input.verified), confirmation, research, neural, forge,
    },
  };
}

/**
 * STRONG needs a high score, a skill-weighted majority well above half and
 * non-negative held-out results; MODERATE needs more engines for than against.
 */
export function strengthOf(confidence: number, tally: VoteTally, backtest: BacktestSummary | null): SignalStrength {
  const backtestOk = !backtest || backtest.sample < 10 || (backtest.zScore ?? 0) >= 0;
  if (confidence >= 70 && tally.weightedAgreement >= 0.6 && backtestOk) return 'STRONG';
  if (confidence >= 55 && tally.agreeing > tally.against) return 'MODERATE';
  return 'WEAK';
}

/**
 * STRONG is a promise that the evidence survived out of sample. If the
 * confirmation layer could not call the same signal decisive — or it actively
 * contradicts it — the label is capped at MODERATE even when the confidence
 * score is high.
 */
export function strengthWithConfirmation(
  base: SignalStrength,
  confirmation: { status: string; decisive: boolean } | null | undefined,
): SignalStrength {
  if (base !== 'STRONG' || !confirmation) return base;
  if (!confirmation.decisive || confirmation.status === 'contradicted') return 'MODERATE';
  return base;
}

/** One plain-language sentence explaining what drives (or limits) a signal. */
export function explainSignal(strength: SignalStrength, breakdown: ConfidenceBreakdown, tally: VoteTally): string {
  const share = tally.voting ? tally.agreeing / tally.voting : 0;
  if (breakdown.verified) return 'Every strict held-out research gate passed for this call — the rarest and strongest kind of evidence.';
  if (strength === 'STRONG') return 'Engines agree, the edge over fair odds is material and the same call held up on recent unseen ticks.';
  if (breakdown.backtest < -0.15) return 'Engines lean this way now, but recent held-out results for this call were below fair odds.';
  if (share >= 0.6 && breakdown.edge < 0.2) return 'Most engines lean this way, but the edge over fair odds is very small — typical of a random market.';
  if (share < 0.5) return 'Engines are split on this market; treat it as a low-conviction call.';
  if (breakdown.backtest > 0.15) return 'Engines lean this way and recent held-out ticks were supportive, but not decisive.';
  return 'Engines lean this way with a modest edge; no decisive evidence either way.';
}
