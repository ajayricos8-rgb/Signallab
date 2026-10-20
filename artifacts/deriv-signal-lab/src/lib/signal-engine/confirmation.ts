// Layer 3 — CALCULATION + AI CONFIRMATION.
//
// The prediction engines produce a probability. That number is not trusted on
// its own: this layer asks a second, independent question — "does the edge
// survive calibration on rows the models never saw?" — and adjusts the signal
// only when the answer is yes.
//
// For each contract/direction it:
//   1. calibrates the holdout probabilities out of sample (isotonic and Platt
//      scaling are both fitted on the older half and scored on the newer half),
//   2. fits a small logistic stack on the same rows when there is enough data,
//   3. asks the analysis engines for agreement (a validated analysis prior can
//      move the probability by at most two points),
//   4. reports the raw and confirmed probability, the calibration skill, the
//      AI/engine agreement, and a decisive status with the reasons.
//
// Nothing is fitted and scored on the same rows. A model that cannot beat its
// own base rate out of sample is reported as such and leaves the probability
// unchanged.
import { selectionPenalty, type BacktestSummary, type VoteTally } from './confidence.ts';
import type { DigitMarketState, QuoteMarketState } from './market-state.ts';
import {
  brierScore, calibrateOutOfSample, clamp, fitOutOfSampleStack,
  type CalibrationPoint, type CalibrationResult, type StackResult,
} from './stats.ts';

export type ConfirmationStatus = 'confirmed' | 'adjusted' | 'cautious' | 'contradicted';

export type ConfirmationReport = {
  status: ConfirmationStatus;
  /** Probability before confirmation (the prediction engines' estimate). */
  probabilityBefore: number;
  /** Probability after out-of-sample calibration, stacking and analysis check. */
  probability: number;
  fairRate: number;
  edgePtsBefore: number;
  edgePts: number;
  calibration: {
    method: CalibrationResult['method'];
    sample: number;
    evaluationSample: number;
    brierBefore: number | null;
    brierAfter: number | null;
    skill: number | null;
    improved: boolean;
    /**
     * How far the probabilities have actually been from the frequencies they
     * claimed, in probability units, measured on rows no calibrator saw and
     * after subtracting the sampling noise of the bins that measured it. This
     * is the part of the error bar that variance alone cannot see: a model can
     * be tightly clustered and still be badly wrong.
     */
    residualMiscalibration: number | null;
  };
  ai: {
    /** Probability produced by the calibrated model (null when none improved). */
    calibratedProbability: number | null;
    /** Probability produced by the logistic stack (null when it did not improve). */
    stackedProbability: number | null;
    /** Brier skill of the stack over the calibrated chain on the evaluation slice. */
    stackSkill: number | null;
    /**
     * The same skill measured against the no-edge rate instead of the chain.
     * Master pooling weights sources by their skill against FAIR, so a stack
     * that improves 5% on a chain already 20% better than fair must not look
     * five times weaker than an engine with 5% skill against fair.
     */
    stackSkillVsFair: number | null;
    stackSample: number;
    /** 1 when the AI model and the engine consensus point the same way. */
    agreement: number;
  };
  state: {
    regime: string;
    predictability: number;
    /** −1 opposes the trade, +1 supports it, 0 no measured opinion. */
    agreement: number;
    adjustmentPts: number;
    applied: boolean;
    detail: string;
  };
  engines: {
    agreeing: number;
    total: number;
    weightedAgreement: number;
  };
  /** Points added to the evidence score (confidence), bounded to ±10. */
  confidenceDelta: number;
  reasons: string[];
  /** True only when a confirmed edge remains after every adjustment. */
  decisive: boolean;
};

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function boundedShift(base: number, target: number, limit: number): number {
  return base + clamp(target - base, -limit, limit);
}

function calibrationReport(result: CalibrationResult) {
  // The residual is taken from the CALIBRATED side when a calibrator was
  // accepted and from the raw side otherwise, so it always describes what the
  // published number is actually worth. `reliability` is a mean squared gap, so
  // the square root converts it into probability units.
  const report = result.reliability
    ? (result.improved ? result.reliability.calibrated : result.reliability.raw)
    : null;
  return {
    method: result.method,
    sample: result.sample,
    evaluationSample: result.evaluationSample,
    brierBefore: result.brierBefore,
    brierAfter: result.brierAfter,
    skill: result.skill,
    improved: result.improved,
    residualMiscalibration: report && report.sample >= 8 ? report.miscalibration : null,
  };
}

export type DigitConfirmationInput = {
  contractLabel: string;
  /** Ensemble probability for this contract (bias-corrected and shrunk). */
  probability: number;
  fairRate: number;
  /** Chronological held-out rows: model probability and whether the contract won. */
  holdout: readonly CalibrationPoint[];
  state: DigitMarketState;
  tally: VoteTally;
  backtest: BacktestSummary;
  validationSkill: number | null;
  /** Contract probability from the validated analysis prior, when one exists. */
  statePriorProbability: number | null;
  /** Candidates competing in the scan (contracts × markets), for the best-of-pool bar. */
  selectionPool?: number;
  /**
   * Extra features for the AI meta-model, aligned with `holdout`: how widely
   * the engines disagree, how much of their weight backs the signalled side,
   * and what the rolling-frequency baseline says. These are the things a
   * linear blend cannot see. Without them the stack would only see monotone
   * transforms of the same probability and could never add information.
   */
  engineFeatures?: readonly (readonly number[])[];
  /** The same extra features for the live row this signal is published from. */
  liveFeatures?: readonly number[];
};

/**
 * Confirms one digit contract. The probability can only move by a bounded
 * amount, and every move is explained by a measured skill number.
 */
export function confirmDigitContract(input: DigitConfirmationInput): ConfirmationReport {
  const fair = clamp(input.fairRate, 0.0005, 0.9995);
  const base = clamp(input.probability, 0.0005, 0.9995);
  const reasons: string[] = [];

  const calibration = calibrateOutOfSample(input.holdout);
  const calibratedProbability = calibration.improved ? clamp(calibration.predict(base), 0.001, 0.999) : null;
  if (calibration.improved) {
    reasons.push(
      `Out-of-sample ${calibration.method} calibration improved the Brier score from ${(calibration.brierBefore ?? 0).toFixed(4)} to ${(calibration.brierAfter ?? 0).toFixed(4)} on ${calibration.evaluationSample} unseen ticks (skill ${signed((calibration.skill ?? 0) * 100, 1)}%).`,
    );
  } else if (calibration.evaluationSample >= 20) {
    reasons.push(
      `The calibrator did not beat the raw probability on ${calibration.evaluationSample} unseen ticks, so the raw estimate is kept.`,
    );
  } else {
    reasons.push('Too few independent held-out ticks to recalibrate this contract; the raw ensemble estimate is kept.');
  }

  // A logistic AI stack on the same chronological holdout. Feature 0 is the
  // ensemble probability, so it can only earn its place by beating that base
  // on rows the fit never saw. The remaining features are the ones a weighted
  // average cannot express: engine disagreement, the weight that actually
  // backs the signalled side, and the rolling-frequency baseline's own view.
  //
  // The old stack was fitted on [p, logit(p)] — two monotone transforms of the
  // same number. It could rescale the probability but never add information,
  // so on a genuinely well-calibrated ensemble it lost to the base by
  // construction and the "AI" source carried zero weight. These features make
  // the meta-model a real second opinion.
  let stack: StackResult | null = null;
  let stackedProbability: number | null = null;
  const extraFeatures = input.engineFeatures;
  const extraCount = extraFeatures?.[0]?.length ?? 0;
  const liveExtra = input.liveFeatures;
  if (
    input.holdout.length >= 120 &&
    extraFeatures &&
    extraCount > 0 &&
    extraFeatures.length === input.holdout.length &&
    extraFeatures.every((row) => row.length === extraCount && row.every((value) => Number.isFinite(value))) &&
    liveExtra &&
    liveExtra.length === extraCount &&
    liveExtra.every((value) => Number.isFinite(value))
  ) {
    const features = input.holdout.map((point, index) => {
      const p = clamp(point.probability, 0.001, 0.999);
      return [p, Math.log(p / (1 - p)), ...extraFeatures[index]];
    });
    stack = fitOutOfSampleStack(features, input.holdout.map((point) => point.won), {
      minimum: 120,
      minimumEvaluation: 40,
      ridge: 3,
      // Every digit analysis scores up to 16 contracts; accepting the AI on a
      // 2.5-sigma paired test would make the best of 16 noise stacks look
      // significant. Three sigma is the honest per-contract bar in a pool.
      minimumZ: 3,
    });
    if (stack.improved && stack.model) {
      const liveRow = [base, Math.log(base / (1 - base)), ...liveExtra];
      stackedProbability = clamp(stack.model.predict(liveRow), 0.001, 0.999);
      reasons.push(
        `The AI meta-model (engine disagreement, weighted support and rolling frequency) beat the raw probability out of sample (Brier skill ${signed((stack.skill ?? 0) * 100, 1)}% on ${stack.evaluationSample} ticks).`,
      );
    }
  }

  // Analysis-engine confirmation. The prior only exists when the analysis
  // backtest beat uniform out of sample, so this is measured, not decorative.
  const statePrior = input.state.prior;
  const priorProbability = input.state.prior && input.statePriorProbability !== null ? clamp(input.statePriorProbability, 0.001, 0.999) : null;
  let stateAgreement = 0;
  let stateAdjustment = 0;
  let stateDetail = `Analysis regime is ${input.state.regime} with ${percent(input.state.predictability, 0)} predictability; no validated prior was applied.`;
  if (priorProbability !== null) {
    const edge = priorProbability - fair;
    if (edge > 0.004) stateAgreement = 1;
    else if (edge < -0.004) stateAgreement = -1;
    const scale = clamp(input.state.confidence * 2.5, 0.25, 1);
    stateAdjustment = clamp(edge * 0.5 * scale, -0.02, 0.02);
    stateDetail = `The validated analysis prior puts this contract at ${percent(priorProbability)} against a ${percent(fair)} fair rate (${stateAgreement > 0 ? 'supporting' : stateAgreement < 0 ? 'opposing' : 'neutral'}, prior Brier skill ${signed((input.state.priorBacktest.skill ?? 0) * 100, 1)}% on ${input.state.priorBacktest.sample} ticks).`;
    if (stateAgreement !== 0) reasons.push(stateDetail);
  } else if (input.state.prior) {
    stateDetail = 'The analysis prior did not beat a uniform baseline out of sample, so it was not applied.';
  }

  // The backtest is one of many contracts and markets inspected: discount its
  // z-score by the expected best-of-pool maximum before treating it as
  // confirmation. Otherwise the luckiest of 200 contracts is always "strong".
  const poolPenalty = selectionPenalty(input.selectionPool ?? 1);
  const backtestStrong =
    input.backtest.sample >= 20 && (input.backtest.zScore ?? 0) - poolPenalty >= 2;
  // Calibration repairs overconfidence; it does not create skill. Only count
  // it when the underlying model's independent Brier skill is positive too.
  const validated =
    (calibration.improved || Boolean(stack?.improved)) && (input.validationSkill ?? 0) > 0.005;
  const confirmedEvidence = validated || backtestStrong;
  let modeled = base;
  if (calibratedProbability !== null) modeled = calibratedProbability;
  if (stackedProbability !== null) modeled = (modeled + stackedProbability) / 2;
  // An unconfirmed recalibration may not create an edge the base probability
  // did not already have; it can only re-shape that base.
  const source = confirmedEvidence ? modeled : base;
  // Every correction is bounded: confirmation may not manufacture an edge.
  const adjusted = boundedShift(base, source, 0.06) + stateAdjustment;
  // No validation and no confirming backtest means the raw model is only a
  // hypothesis. That is reported, not silently rescaled: the STATUS, the
  // `decisive` flag and the strength label all say so, and the precision layer
  // prices the estimate with a standard error inflated for exactly this. It
  // used to also shrink the probability by 65% here, which compounded with the
  // prediction layer's own shrinkage and the precision layer's into a number
  // that understated every real edge by an order of magnitude.
  const confirmed = clamp(adjusted, 0.001, 0.999);
  const edgeBefore = base - fair;
  const edge = confirmed - fair;

  let confidenceDelta = 0;
  if (calibration.improved) confidenceDelta += clamp(4 * (calibration.skill ?? 0) / 0.05, 0, 5);
  if (stack?.improved) confidenceDelta += clamp(3 * (stack.skill ?? 0) / 0.05, 0, 4);
  if (stateAgreement > 0) confidenceDelta += clamp(input.state.confidence * 6, 0, 4);
  if (stateAgreement < 0) confidenceDelta -= clamp(input.state.confidence * 8, 0, 6);
  if (edge < 0 && edgeBefore >= 0) confidenceDelta -= 6;
  if (Math.abs(confirmed - base) > 0.03) confidenceDelta -= 2;
  if (!confirmedEvidence) confidenceDelta -= 3;
  confidenceDelta = clamp(confidenceDelta, -10, 10);
  if (!confirmedEvidence)
    reasons.push('Neither the out-of-sample calibration nor the held-out backtest (after the best-of-pool bar) confirmed this edge; it is published at its measured size and marked cautious, with a wider error bar.');

  // Calibration is one confirmation tool, not the only one. A held-out
  // backtest that clears its own z-test also confirms a real edge; without
  // either, the call stays cautious however large the raw model says the edge
  // is. This is what stops an overfit probability from being labelled
  // "confirmed" just because it is far from fair.
  const backtestConfirmed = backtestStrong && edge >= Math.max(0.005, 0.015 * fair);
  const status: ConfirmationStatus = stateAgreement < 0 && edge <= 0.005
    ? 'contradicted'
    : confirmedEvidence && edge >= Math.max(0.005, 0.02 * fair) && stateAgreement >= 0
      ? 'confirmed'
      : Math.abs(confirmed - base) >= 0.005
        ? 'adjusted'
        : 'cautious';

  if (status === 'contradicted') {
    reasons.push(`The analysis engines oppose this contract (${stateDetail}) and the confirmed edge is ${signed(edge * 100, 2)} points. Treat the call as contradicted.`);
  } else if (status === 'confirmed') {
    reasons.push(`Confirmed edge ${signed(edge * 100, 1)} points over the ${percent(fair)} no-edge rate after every adjustment.`);
    if (!calibration.improved && !stack?.improved && backtestConfirmed)
      reasons.push(
        `The held-out prediction backtest independently supports it: ${input.backtest.wins}/${input.backtest.sample} calls won (z ${signed(input.backtest.zScore ?? 0, 1)}).`,
      );
  } else if (status === 'cautious') {
    reasons.push(`No calibration or analysis evidence moved this contract decisively; the confirmed edge is ${signed(edge * 100, 1)} points.`);
  }

  const decisive =
    status !== 'contradicted' &&
    edge >= Math.max(0.005, 0.015 * fair) &&
    input.backtest.sample >= 10 &&
    confirmedEvidence;

  // Express the stack's skill on the same scale as every other source (Brier
  // skill against the no-edge rate). The evaluation slice is the same newer
  // half `fitOutOfSampleStack` scored, so this is still out of sample.
  let stackSkillVsFair: number | null = null;
  if (stack?.improved && stack.stackBrier !== null) {
    const evaluation = input.holdout.slice(Math.floor(input.holdout.length / 2));
    if (evaluation.length >= 20) {
      const fairBrier = evaluation.reduce((total, point) => total + (fair - point.won) ** 2, 0) / evaluation.length;
      if (fairBrier > 1e-9) stackSkillVsFair = 1 - stack.stackBrier / fairBrier;
    }
  }

  return {
    status,
    probabilityBefore: base,
    probability: confirmed,
    fairRate: fair,
    edgePtsBefore: edgeBefore * 100,
    edgePts: edge * 100,
    calibration: calibrationReport(calibration),
    ai: {
      calibratedProbability,
      stackedProbability,
      stackSkill: stack?.skill ?? null,
      stackSkillVsFair,
      stackSample: stack?.sample ?? 0,
      agreement: stateAgreement !== 0 ? stateAgreement : edge > 0.005 ? 1 : edge < -0.005 ? -1 : 0,
    },
    state: {
      regime: input.state.regime,
      predictability: input.state.predictability,
      agreement: stateAgreement,
      adjustmentPts: stateAdjustment * 100,
      applied: Math.abs(stateAdjustment) > 1e-9,
      detail: stateDetail,
    },
    engines: {
      agreeing: input.tally.agreeing,
      total: input.tally.total,
      weightedAgreement: input.tally.weightedAgreement,
    },
    confidenceDelta,
    reasons,
    decisive,
  };
}

export type QuoteConfirmationRow = {
  /** AI probability of a rise, conditional on the outcome not being flat. */
  ai: number;
  /** Consensus score at the same origin (−1 … 1). */
  score: number;
  /** 1 when the exit quote was above the entry quote. */
  won: 0 | 1;
};

export type QuoteConfirmationInput = {
  /** Raw AI probability of a rise (conditional on non-flat), when available. */
  aiProbability: number | null;
  holdout: readonly QuoteConfirmationRow[];
  /** Consensus direction before confirmation. */
  consensusDirection: 1 | -1;
  /** Live weighted consensus score (−1 … 1), fed to the AI stack. */
  consensusScore: number;
  state: QuoteMarketState;
  tally: VoteTally;
  backtest: BacktestSummary;
  validationSkill: number | null;
  /** Share of held-out outcomes that were unchanged (excluded from fair odds). */
  flatRate: number;
  /** Durations × markets competing in the scan, for the best-of-pool bar. */
  selectionPool?: number;
};

export type QuoteConfirmationResult = ConfirmationReport & {
  /** Confirmed conditional probability that the next move is up. */
  probabilityRise: number;
  /** Direction after confirmation (may override the raw consensus). */
  direction: 1 | -1;
  directionChanged: boolean;
  winProbability: number;
};

/**
 * Confirms a Rise/Fall direction. The AI probability is calibrated on the
 * held-out slice, a logistic stack may add the consensus score, and the
 * analysis engines may move the result by at most two points. Direction is
 * only flipped when a validated model disagrees by a material margin.
 */
export function confirmRiseFall(input: QuoteConfirmationInput): QuoteConfirmationResult {
  const flatRate = clamp(input.flatRate, 0, 0.5);
  const fair = 0.5 * (1 - flatRate);
  const reasons: string[] = [];
  const points: CalibrationPoint[] = input.holdout.map((row) => ({ probability: clamp(row.ai, 0.001, 0.999), won: row.won }));
  const calibration = calibrateOutOfSample(points, { minimum: 90, minimumEvaluation: 30 });

  const baseConditional = input.aiProbability === null ? 0.5 : clamp(input.aiProbability, 0.01, 0.99);
  const calibratedProbability = calibration.improved ? clamp(calibration.predict(baseConditional), 0.01, 0.99) : null;
  if (calibration.improved) {
    reasons.push(
      `The AI probability was calibrated on ${calibration.evaluationSample} held-out outcomes: ${calibration.method} improved Brier from ${(calibration.brierBefore ?? 0).toFixed(4)} to ${(calibration.brierAfter ?? 0).toFixed(4)} (skill ${signed((calibration.skill ?? 0) * 100, 1)}%).`,
    );
  } else {
    reasons.push(
      calibration.evaluationSample >= 20
        ? `Calibration did not improve on ${calibration.evaluationSample} held-out outcomes, so the AI estimate is used unchanged.`
        : 'Too few held-out outcomes to calibrate this duration; the AI estimate is used unchanged.',
    );
  }

  let stack: StackResult | null = null;
  let stackedConditional: number | null = null;
  if (input.holdout.length >= 120) {
    const features = input.holdout.map((row) => [clamp(row.ai, 0.01, 0.99), row.score, clamp(row.ai, 0.01, 0.99) * row.score]);
    stack = fitOutOfSampleStack(features, input.holdout.map((row) => row.won), { minimum: 120, minimumEvaluation: 40 });
    if (stack.improved && stack.model) {
      stackedConditional = clamp(stack.model.predict([baseConditional, input.consensusScore, baseConditional * input.consensusScore]), 0.01, 0.99);
      reasons.push(
        `The AI stack (probability + consensus + interaction) beat the raw AI estimate out of sample (skill ${signed((stack.skill ?? 0) * 100, 1)}% on ${stack.evaluationSample} outcomes).`,
      );
    }
  }

  let stateAdjustment = 0;
  let stateAgreement = 0;
  let stateDetail = `Analysis regime is ${input.state.regime} with ${percent(input.state.predictability, 0)} predictability; no validated directional prior was applied.`;
  if (input.state.prior !== null && input.state.priorBacktest.improved) {
    const directionalEdge = input.state.prior - 0.5;
    const scale = clamp(input.state.confidence * 2.5, 0.25, 1);
    stateAdjustment = clamp(directionalEdge * 0.5 * scale, -0.02, 0.02);
    stateAgreement = directionalEdge > 0.004 ? 1 : directionalEdge < -0.004 ? -1 : 0;
    stateDetail = `The validated analysis prior favours ${input.state.prior >= 0.5 ? 'RISE' : 'FALL'} at ${percent(input.state.prior)} (Brier skill ${signed((input.state.priorBacktest.skill ?? 0) * 100, 1)}% on ${input.state.priorBacktest.sample} outcomes).`;
    if (stateAgreement !== 0) reasons.push(stateDetail);
  } else {
    stateDetail = `The analysis engines measured ${input.state.regime} conditions; their directional prior did not beat a coin flip out of sample, so it was not applied.`;
  }

  // The backtest is one of many contracts and markets inspected: discount its
  // z-score by the expected best-of-pool maximum before treating it as
  // confirmation. Otherwise the luckiest of 200 contracts is always "strong".
  const poolPenalty = selectionPenalty(input.selectionPool ?? 1);
  const backtestStrong =
    input.backtest.sample >= 20 && (input.backtest.zScore ?? 0) - poolPenalty >= 2;
  // Calibration repairs overconfidence; it does not create skill. Only count
  // it when the underlying model's independent Brier skill is positive too.
  const validated =
    (calibration.improved || Boolean(stack?.improved)) && (input.validationSkill ?? 0) > 0.005;
  const confirmedEvidence = validated || backtestStrong;
  let modeled = baseConditional;
  if (calibratedProbability !== null) modeled = calibratedProbability;
  if (stackedConditional !== null) modeled = (modeled + stackedConditional) / 2;
  const adjusted = boundedShift(baseConditional, modeled, 0.08) + stateAdjustment;
  // Without validation or a confirming backtest, keep the AI's edge as a
  // hypothesis: halve its distance from fair instead of showing an 8-point
  // "win chance" that nothing out of sample supports.
  // As in the digit panel: an unconfirmed estimate is REPORTED as unconfirmed
  // (status, `decisive` and the strength label all carry it, and the precision
  // layer prices it with a wider error bar) rather than silently rescaled a
  // second time on top of the prediction layer's own shrinkage.
  const confirmedRise = clamp(adjusted, 0.01, 0.99);

  // Only a validated model may override the engines, and only by a material
  // margin. Noise-level disagreement leaves the consensus in place.
  const modelMargin = confirmedRise - 0.5;
  const consensusMargin = input.consensusDirection;
  const directionChanged = validated && Math.abs(modelMargin) >= 0.03 && Math.sign(modelMargin) !== Math.sign(consensusMargin);
  const direction: 1 | -1 = directionChanged ? (modelMargin > 0 ? 1 : -1) : input.consensusDirection;
  const directionConditional = direction === 1 ? confirmedRise : 1 - confirmedRise;
  // A published signal may not claim that the direction it recommends loses
  // more often than the no-edge rate. When the model preferred the other side
  // but was not validated enough to override the consensus, the honest number
  // is "no measured edge", not a self-contradicting probability. (The old code
  // hid this by shrinking everything toward a coin flip, which also destroyed
  // every real edge.)
  const flooredConditional = directionChanged ? directionConditional : Math.max(directionConditional, 0.5);
  const winProbability = clamp(flooredConditional * (1 - flatRate), 0.001, 0.999);
  const probabilityBefore = clamp((input.consensusDirection === 1 ? baseConditional : 1 - baseConditional) * (1 - flatRate), 0.001, 0.999);
  const edgeBefore = probabilityBefore - fair;
  const edge = winProbability - fair;

  if (!directionChanged && directionConditional < 0.5 - 1e-9 && Math.abs(modelMargin) >= 0.03) {
    reasons.push('The validated model preferred the other direction but was not strong enough to override the engine consensus, so this call is published with no measured edge rather than a number that contradicts the direction it recommends.');
  }
  if (directionChanged) {
    reasons.push(`Direction overridden from ${input.consensusDirection === 1 ? 'RISE' : 'FALL'} to ${direction === 1 ? 'RISE' : 'FALL'}: the validated model put the other side at ${percent(directionConditional)} against ${percent(fair)} fair odds.`);
  }

  let confidenceDelta = 0;
  if (calibration.improved) confidenceDelta += clamp(4 * (calibration.skill ?? 0) / 0.05, 0, 5);
  if (stack?.improved) confidenceDelta += clamp(3 * (stack.skill ?? 0) / 0.05, 0, 3);
  if (stateAgreement === direction) confidenceDelta += clamp(input.state.confidence * 6, 0, 4);
  else if (stateAgreement !== 0) confidenceDelta -= clamp(input.state.confidence * 8, 0, 6);
  if (edge < 0 && edgeBefore >= 0) confidenceDelta -= 6;
  if (directionChanged) confidenceDelta -= 2;
  if (!confirmedEvidence) confidenceDelta -= 3;
  confidenceDelta = clamp(confidenceDelta, -10, 10);
  if (!confirmedEvidence)
    reasons.push('Neither calibration nor the held-out direction backtest (after the best-of-pool bar) confirmed the AI estimate; it is published at its measured size and marked cautious, with a wider error bar.');

  const backtestConfirmed = backtestStrong && edge >= Math.max(0.005, 0.015 * fair);
  const status: ConfirmationStatus = stateAgreement !== 0 && stateAgreement !== direction && edge <= 0.005
    ? 'contradicted'
    : confirmedEvidence && edge >= Math.max(0.005, 0.02 * fair) && (stateAgreement === 0 || stateAgreement === direction)
      ? 'confirmed'
      : Math.abs(winProbability - probabilityBefore) >= 0.005 || directionChanged
        ? 'adjusted'
        : 'cautious';

  if (status === 'contradicted') {
    reasons.push(`The analysis engines lean the other way and the confirmed edge is only ${signed(edge * 100, 2)} points. Treat the call as contradicted.`);
  } else if (status === 'confirmed') {
    reasons.push(`Confirmed edge ${signed(edge * 100, 1)} points over the ${percent(fair)} no-edge rate after calibration, stacking and the analysis check.`);
    if (!validated && backtestConfirmed)
      reasons.push(
        `The held-out direction backtest independently supports it: ${input.backtest.wins}/${input.backtest.sample} calls won (z ${signed(input.backtest.zScore ?? 0, 1)}).`,
      );
  } else if (status === 'cautious') {
    reasons.push(`The confirmation layer found no decisive adjustment; the confirmed edge is ${signed(edge * 100, 1)} points.`);
  }

  const decisive =
    status !== 'contradicted' &&
    edge >= Math.max(0.005, 0.015 * fair) &&
    input.backtest.sample >= 10 &&
    confirmedEvidence;

  // The stack and the calibration both work on the non-flat conditional, whose
  // no-edge rate is exactly 0.5 (Brier 0.25). Expressing the stack's skill on
  // that scale keeps it comparable with the engine vote, which is also scored
  // against the fair rate.
  const stackSkillVsFair = stack?.improved && stack.stackBrier !== null
    ? 1 - stack.stackBrier / 0.25
    : null;

  return {
    status,
    probabilityBefore,
    probability: winProbability,
    fairRate: fair,
    edgePtsBefore: edgeBefore * 100,
    edgePts: edge * 100,
    calibration: calibrationReport(calibration),
    ai: {
      calibratedProbability: calibratedProbability === null ? null : clamp((direction === 1 ? calibratedProbability : 1 - calibratedProbability) * (1 - flatRate), 0.001, 0.999),
      stackedProbability: stackedConditional === null ? null : clamp((direction === 1 ? stackedConditional : 1 - stackedConditional) * (1 - flatRate), 0.001, 0.999),
      stackSkill: stack?.skill ?? null,
      stackSkillVsFair,
      stackSample: stack?.sample ?? 0,
      agreement: stateAgreement !== 0 ? stateAgreement : edge > 0.005 ? 1 : edge < -0.005 ? -1 : 0,
    },
    state: {
      regime: input.state.regime,
      predictability: input.state.predictability,
      agreement: stateAgreement,
      adjustmentPts: stateAdjustment * 100,
      applied: Math.abs(stateAdjustment) > 1e-9,
      detail: stateDetail,
    },
    engines: {
      agreeing: input.tally.agreeing,
      total: input.tally.total,
      weightedAgreement: input.tally.weightedAgreement,
    },
    confidenceDelta,
    reasons,
    decisive,
    probabilityRise: confirmedRise,
    direction,
    directionChanged,
    winProbability,
  };
}

/** Short plain-language confirmation line for cards and the bot page. */
export function describeConfirmation(report: ConfirmationReport): string {
  const skill = report.calibration.skill;
  const skillText = skill === null ? 'calibration not measurable' : `out-of-sample calibration skill ${signed(skill * 100, 1)}%`;
  const stateText = report.state.agreement > 0 ? 'analysis supports' : report.state.agreement < 0 ? 'analysis opposes' : 'analysis neutral';
  return `${report.status.toUpperCase()} · ${percent(report.probabilityBefore)} → ${percent(report.probability)} · ${skillText} · ${stateText}`;
}

/** Compact evidence string for the entry plan and signal cards. */
export function confirmationEvidence(report: ConfirmationReport): string {
  return `${report.status} (${percent(report.probabilityBefore)} → ${percent(report.probability)}, ${signed(report.edgePts, 1)} pts edge)`;
}

/** The Brier score of a set of points without fitting anything. */
export function rawBrier(points: readonly CalibrationPoint[]): number | null {
  return brierScore(points);
}
