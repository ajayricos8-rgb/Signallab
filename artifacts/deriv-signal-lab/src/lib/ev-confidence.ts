// Expected-value (EV) confidence engine.
//
// Every signal in Signal Lab reports a confidence that is derived from expected
// value, never from a raw hit rate. The arithmetic is the standard binary
// contract expectancy:
//
//   stake                S
//   payout               P                (what Deriv returns when the contract wins)
//   payout multiple      M = P / S
//   break-even rate      b = S / P        (the win rate at which EV is exactly zero)
//   win probability      q
//   EV per stake         q·(P − S) + (1 − q)·(−S) = q·P − S = S·(q·M − 1)
//   return on stake      ROI = q·M − 1
//
// The confidence shown next to a signal is that ROI mapped onto 0–100 %:
//
//   confidence = clamp(0.5 + ROI / (2 · EV_CONFIDENCE_ROI_SCALE), 0, 1)
//
// 50 % therefore means the payout in front of you pays exactly what the estimate
// says the contract is worth (EV = 0), 100 % means the expected return per unit
// staked has reached EV_CONFIDENCE_ROI_SCALE, and 0 % means it is that far
// negative. When a conservative win probability is supplied (a Wilson lower
// bound, or the smaller of the model estimate and that bound) the headline
// confidence is computed at that conservative probability, so sampling noise
// cannot buy a strong confidence. Two payout bases are supported:
//
//   • 'live-payout' — a real Deriv proposal (ask + payout). EV is money.
//   • 'fair-payout' — no live quote on this surface, so the break-even uses a
//     zero-margin fair price built from a stated reference rate (the rolling
//     frequency baseline of the same contract). EV then measures the model's
//     lift over that reference, not a promised return.
//
// An optional reliability factor (0–1, evidence quality: held-out skill, model
// agreement, sample size, market-structure checks) shrinks the EV confidence
// toward 50 % so an unvalidated estimate cannot claim a strong edge.

/** Expected return per unit staked that maps to 100 % EV confidence. */
export const EV_CONFIDENCE_ROI_SCALE = 0.1;

export type EvBasis = 'live-payout' | 'fair-payout';
export type EvBand = 'high' | 'moderate' | 'low';

export type EvAssessment = {
  basis: EvBasis;
  /** Win probability used for the point estimate (0–1). */
  probability: number;
  /** Conservative win probability when one is available. */
  conservativeProbability: number | null;
  /** Stake the EV is expressed against. Always 1 for the fair-price basis. */
  stake: number;
  /** Payout the EV is expressed against. */
  payout: number;
  payoutMultiple: number;
  /** S/P — the win rate at which the contract breaks even. */
  breakEvenProbability: number;
  /** probability − breakEvenProbability, in probability points. */
  edge: number;
  conservativeEdge: number | null;
  /** q·M − 1 at the point probability — expected return per unit staked. */
  expectedValuePerStake: number;
  /** q·M − 1 at the conservative probability, when one is available. */
  conservativeExpectedValuePerStake: number | null;
  /** Money: EV per contract at the quoted stake. Only for the live basis. */
  expectedValue: number | null;
  conservativeExpectedValue: number | null;
  /**
   * Headline 0–1 EV confidence after the reliability shrinkage. Computed at the
   * conservative probability whenever one was supplied.
   */
  confidence: number;
  /** Same mapping at the point probability, for comparison. */
  pointConfidence: number;
  band: EvBand;
  /** Reliability multiplier that was applied (1 = none). */
  reliability: number;
  /** True when `confidence` was computed from the conservative probability. */
  conservative: boolean;
  basisNote: string;
};

export type EvInput = {
  /** Model probability of the contract winning. */
  probability: number | null | undefined;
  /**
   * Reference win rate of the same contract. Required for the fair-price basis;
   * ignored when a live stake and payout are supplied.
   */
  referenceProbability?: number | null;
  /** Live Deriv proposal ask price (the stake). */
  stake?: number | null;
  /** Live Deriv proposal payout. */
  payout?: number | null;
  /** Conservative win probability (interval lower bound, or min with the estimate). */
  conservativeProbability?: number | null;
  /** 0–1 evidence quality; values outside the range are clamped. Defaults to 1. */
  reliability?: number | null;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const isProbability = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;

export function evBand(confidence: number): EvBand {
  if (!Number.isFinite(confidence)) return 'low';
  if (confidence >= 0.65) return 'high';
  if (confidence >= 0.5) return 'moderate';
  return 'low';
}

export const EV_BAND_LABELS: Record<EvBand, string> = {
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
};

/** Maps an expected return per unit staked onto the 0–1 EV confidence scale. */
export function evConfidenceFromReturn(returnOnStake: number): number {
  if (!Number.isFinite(returnOnStake)) return 0.5;
  return clamp(0.5 + returnOnStake / (2 * EV_CONFIDENCE_ROI_SCALE), 0, 1);
}

/**
 * Builds the EV assessment behind a signal. Returns null when the numbers
 * needed for an honest expectancy are missing: the engine never invents a
 * payout, a probability or a reference rate.
 */
export function assessExpectedValue(input: EvInput): EvAssessment | null {
  const probability = input.probability;
  if (!isProbability(probability)) return null;
  const reliabilityInput = input.reliability ?? 1;
  const reliability = clamp(Number.isFinite(reliabilityInput) ? reliabilityInput : 1, 0, 1);

  const stake = input.stake;
  const payout = input.payout;
  const live =
    Number.isFinite(stake) && (stake as number) > 0 &&
    Number.isFinite(payout) && (payout as number) > 0 &&
    (payout as number) > (stake as number);
  const reference = input.referenceProbability;
  if (!live && !isProbability(reference)) return null;

  const effectiveStake = live ? (stake as number) : 1;
  const effectivePayout = live ? (payout as number) : Number((1 / (reference as number)).toFixed(10));
  const payoutMultiple = effectivePayout / effectiveStake;
  const breakEvenProbability = effectiveStake / effectivePayout;
  const expectedValuePerStake = probability * payoutMultiple - 1;
  const pointConfidence = clamp(
    0.5 + (evConfidenceFromReturn(expectedValuePerStake) - 0.5) * reliability,
    0.02,
    0.98,
  );

  // The conservative bound may legitimately be exactly 0 (no observed win), so
  // it is read inclusively rather than through `isProbability`.
  const conservativeInput = input.conservativeProbability;
  const conservative = typeof conservativeInput === 'number' && Number.isFinite(conservativeInput)
    && conservativeInput >= 0 && conservativeInput <= 1
    ? conservativeInput
    : null;
  const conservativeExpectedValuePerStake = conservative === null ? null : conservative * payoutMultiple - 1;
  const confidence = conservativeExpectedValuePerStake === null
    ? pointConfidence
    : clamp(
      0.5 + (evConfidenceFromReturn(conservativeExpectedValuePerStake) - 0.5) * reliability,
      0.02,
      0.98,
    );

  return {
    basis: live ? 'live-payout' : 'fair-payout',
    probability,
    conservativeProbability: conservative,
    stake: effectiveStake,
    payout: effectivePayout,
    payoutMultiple,
    breakEvenProbability,
    edge: probability - breakEvenProbability,
    conservativeEdge: conservative === null ? null : conservative - breakEvenProbability,
    expectedValuePerStake,
    conservativeExpectedValuePerStake,
    expectedValue: live ? expectedValuePerStake * effectiveStake : null,
    conservativeExpectedValue: live && conservativeExpectedValuePerStake !== null
      ? conservativeExpectedValuePerStake * effectiveStake
      : null,
    confidence,
    pointConfidence,
    band: evBand(confidence),
    reliability,
    conservative: conservativeExpectedValuePerStake !== null,
    basisNote: live
      ? `Live Deriv proposal: stake ${effectiveStake} against payout ${effectivePayout.toFixed(2)}. Expected value is money at that quoted payout; a rejected or missing proposal removes it.`
      : `No live Deriv payout is quoted on this surface, so break-even uses a zero-margin fair price at the stated reference rate ${(breakEvenProbability * 100).toFixed(1)}%. The expected value measures the model's lift over that reference; it is not a promised return and it carries no house margin.`,
  };
}

/**
 * Wilson 95 % score interval for a binomial rate. Exported here so every signal
 * surface derives its conservative win probability the same way.
 */
export function wilsonInterval95(hits: number, sample: number): { lower: number; upper: number } | null {
  if (!Number.isInteger(sample) || sample <= 0 || !Number.isInteger(hits) || hits < 0 || hits > sample) return null;
  const z = 1.959963984540054;
  const rate = hits / sample;
  const zSquared = z * z;
  const denominator = 1 + zSquared / sample;
  const center = (rate + zSquared / (2 * sample)) / denominator;
  const radius = (z * Math.sqrt((rate * (1 - rate) / sample) + (zSquared / (4 * sample * sample)))) / denominator;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

/** One-sided 95 % normal quantile used to discount an estimated edge. */
export const EDGE_CONFIDENCE_Z = 1.6448536269514722;

/**
 * Discounts a model edge over a reference rate by its own sampling error before
 * any expected value is computed:
 *
 *   se   = sqrt( p(1−p)/n + b(1−b)/nb )        (both rates are estimates)
 *   edge = (p − b) − z · se                    (z = one-sided 95 %)
 *
 * Returns the win probability the conservative EV is built from. A large edge
 * estimated from few outcomes collapses toward the reference — and therefore
 * toward zero expected value — while a large edge measured from many outcomes
 * survives. This is what stops sampling noise on a long-shot contract from
 * producing a strong confidence.
 */
export function discountedEdgeProbability(input: {
  probability: number;
  referenceProbability: number;
  /** Outcomes behind `probability`. */
  sample: number | null | undefined;
  /** Observations behind `referenceProbability`. */
  referenceSample: number | null | undefined;
  z?: number;
}): number | null {
  const { probability: p, referenceProbability: b } = input;
  const n = input.sample;
  const nb = input.referenceSample;
  if (!isProbability(p) || !isProbability(b)) return null;
  if (!Number.isFinite(n) || (n as number) < 2 || !Number.isFinite(nb) || (nb as number) < 2) return null;
  const z = Number.isFinite(input.z) ? (input.z as number) : EDGE_CONFIDENCE_Z;
  const standardError = Math.sqrt((p * (1 - p)) / (n as number) + (b * (1 - b)) / (nb as number));
  const discountedEdge = (p - b) - z * standardError;
  return clamp(b + discountedEdge, 0, 1);
}

/**
 * Reliability multiplier for a research estimate: held-out skill, engine
 * agreement, family support, sample size and dispersion each contribute, and a
 * detected market-structure shift shrinks the whole factor. Only the terms a
 * surface actually reports are weighted, so a tool that has no engine-agreement
 * figure is not silently punished for it. Keeping this in one place means every
 * tool shrinks its EV confidence the same way.
 */
export function evidenceReliability(input: {
  validationSkill?: number | null;
  agreement?: number | null;
  supportingFamilies?: number | null;
  dispersion?: number | null;
  sample?: number | null;
  structureStable?: boolean | null;
  /** Sample size at which the evidence term is fully credited (default 60). */
  sampleTarget?: number | null;
}): number {
  const sampleTarget = Number.isFinite(input.sampleTarget) && (input.sampleTarget as number) > 0 ? (input.sampleTarget as number) : 60;
  const terms: { score: number; weight: number }[] = [];
  if (input.validationSkill !== undefined && input.validationSkill !== null) {
    terms.push({ score: clamp(input.validationSkill / 0.05, 0, 1), weight: 0.3 });
  }
  if (input.agreement !== undefined && input.agreement !== null) {
    terms.push({ score: clamp((input.agreement - 0.5) / 0.5, 0, 1), weight: 0.25 });
  }
  if (input.supportingFamilies !== undefined && input.supportingFamilies !== null) {
    terms.push({ score: clamp(input.supportingFamilies / 6, 0, 1), weight: 0.2 });
  }
  if (input.sample !== undefined && input.sample !== null) {
    terms.push({ score: clamp(input.sample / sampleTarget, 0, 1), weight: 0.15 });
  }
  if (input.dispersion !== undefined && input.dispersion !== null) {
    terms.push({ score: clamp(1 - input.dispersion / 0.18, 0, 1), weight: 0.1 });
  }
  const weightTotal = terms.reduce((total, term) => total + term.weight, 0);
  const weighted = weightTotal > 0
    ? terms.reduce((total, term) => total + term.score * term.weight, 0) / weightTotal
    : 0;
  const structurePenalty = input.structureStable === false ? 0.55 : 1;
  return clamp(weighted * structurePenalty, 0.05, 1);
}

/** Formats a 0–1 confidence as a whole percentage, or '—' when unavailable. */
export function formatEvConfidence(confidence: number | null | undefined): string {
  return typeof confidence === 'number' && Number.isFinite(confidence) ? `${(confidence * 100).toFixed(0)}%` : '—';
}
