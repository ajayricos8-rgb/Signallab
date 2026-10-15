import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessExpectedValue,
  discountedEdgeProbability,
  EV_CONFIDENCE_ROI_SCALE,
  evBand,
  evConfidenceFromReturn,
  evidenceReliability,
  formatEvConfidence,
  wilsonInterval95,
} from '../src/lib/ev-confidence.ts';

const close = (value, target, tolerance = 1e-9) => Math.abs(value - target) <= tolerance;

test('the EV confidence scale is 50% at zero expected value and saturates at the ROI scale', () => {
  assert.equal(evConfidenceFromReturn(0), 0.5);
  assert.ok(close(evConfidenceFromReturn(EV_CONFIDENCE_ROI_SCALE), 1));
  assert.ok(close(evConfidenceFromReturn(-EV_CONFIDENCE_ROI_SCALE), 0));
  assert.ok(close(evConfidenceFromReturn(1), 1));
  assert.ok(close(evConfidenceFromReturn(-1), 0));
  assert.equal(evBand(0.9), 'high');
  assert.equal(evBand(0.5), 'moderate');
  assert.equal(evBand(0.2), 'low');
  assert.equal(formatEvConfidence(0.6123), '61%');
  assert.equal(formatEvConfidence(null), '—');
});

test('a live Deriv payout produces money-sized expected value and a confidence from it', () => {
  // Stake 1.00 at a 2.20 payout: break-even 45.45%, expected value +3.4% if the model says 47%.
  const assessment = assessExpectedValue({ probability: 0.47, stake: 1, payout: 2.2 });
  assert.ok(assessment);
  assert.equal(assessment.basis, 'live-payout');
  assert.ok(close(assessment.breakEvenProbability, 1 / 2.2));
  assert.ok(close(assessment.payoutMultiple, 2.2));
  assert.ok(close(assessment.edge, 0.47 - 1 / 2.2));
  assert.ok(close(assessment.expectedValuePerStake, 0.47 * 2.2 - 1));
  assert.ok(close(assessment.expectedValue, 0.47 * 2.2 - 1));
  assert.ok(close(assessment.confidence, 0.5 + (0.47 * 2.2 - 1) / (2 * EV_CONFIDENCE_ROI_SCALE)));
  assert.equal(assessment.band, 'high');
  assert.equal(assessment.conservative, false);
});

test('a losing price is reported as a below-50% confidence instead of being hidden', () => {
  const assessment = assessExpectedValue({ probability: 0.4, stake: 1, payout: 2 });
  assert.ok(assessment);
  assert.ok(assessment.expectedValuePerStake < 0);
  assert.ok(assessment.confidence < 0.5);
  assert.equal(assessment.band, 'low');
});

test('the fair-price basis prices a zero-margin payout from the reference rate', () => {
  const assessment = assessExpectedValue({ probability: 0.6, referenceProbability: 0.5 });
  assert.ok(assessment);
  assert.equal(assessment.basis, 'fair-payout');
  assert.equal(assessment.stake, 1);
  assert.ok(close(assessment.payoutMultiple, 2));
  assert.ok(close(assessment.breakEvenProbability, 0.5));
  assert.ok(close(assessment.expectedValuePerStake, 0.2));
  assert.equal(assessment.expectedValue, null);
  assert.match(assessment.basisNote, /zero-margin fair price/);
});

test('missing or impossible inputs never produce an invented expectancy', () => {
  assert.equal(assessExpectedValue({ probability: null, referenceProbability: 0.5 }), null);
  assert.equal(assessExpectedValue({ probability: 0, referenceProbability: 0.5 }), null);
  assert.equal(assessExpectedValue({ probability: 1, referenceProbability: 0.5 }), null);
  assert.equal(assessExpectedValue({ probability: 0.5 }), null);
  assert.equal(assessExpectedValue({ probability: 0.5, referenceProbability: 0 }), null);
  assert.equal(assessExpectedValue({ probability: 0.5, referenceProbability: 1 }), null);
  // A payout that does not exceed the stake cannot be a binary contract.
  assert.equal(assessExpectedValue({ probability: 0.5, stake: 1, payout: 1 }), null);
  assert.equal(assessExpectedValue({ probability: 0.5, stake: 1, payout: 0.5 }), null);
  assert.equal(assessExpectedValue({ probability: 0.5, stake: null, payout: null, referenceProbability: 0.5 })?.basis, 'fair-payout');
});

test('the headline confidence uses the conservative probability while the point figure stays visible', () => {
  const point = assessExpectedValue({ probability: 0.6, referenceProbability: 0.5 });
  const conservative = assessExpectedValue({ probability: 0.6, referenceProbability: 0.5, conservativeProbability: 0.5 });
  assert.ok(point && conservative);
  assert.ok(close(point.pointConfidence, point.confidence));
  assert.ok(conservative.confidence < point.confidence);
  assert.ok(close(conservative.confidence, 0.5));
  assert.ok(close(conservative.pointConfidence, point.pointConfidence));
  assert.equal(conservative.conservative, true);
  // A bound of exactly zero is honoured rather than ignored as "missing", and
  // lands on the floor (the engine never prints a literal 0% certainty).
  const hopeless = assessExpectedValue({ probability: 0.6, referenceProbability: 0.5, conservativeProbability: 0 });
  assert.ok(hopeless);
  assert.ok(hopeless.confidence <= 0.02);
  assert.ok(hopeless.pointConfidence > 0.5);
});

test('the reliability factor shrinks the EV confidence toward 50% without changing the EV', () => {
  const full = assessExpectedValue({ probability: 0.6, referenceProbability: 0.5, reliability: 1 });
  const unvalidated = assessExpectedValue({ probability: 0.6, referenceProbability: 0.5, reliability: 0.05 });
  assert.ok(full && unvalidated);
  assert.ok(close(full.expectedValuePerStake, unvalidated.expectedValuePerStake));
  assert.ok(full.confidence > unvalidated.confidence);
  assert.ok(unvalidated.confidence >= 0.02);
  const neutral = assessExpectedValue({ probability: 0.6, referenceProbability: 0.5, reliability: 0 });
  assert.ok(neutral);
  assert.ok(close(neutral.confidence, 0.5));
});

test('reliability only weights the evidence terms a surface actually reports', () => {
  // Sample-only evidence is not punished for the agreement/skill terms it lacks.
  assert.equal(evidenceReliability({ sample: 500, sampleTarget: 500 }), 1);
  assert.ok(evidenceReliability({ sample: 250, sampleTarget: 500 }) < 1);
  const penalised = evidenceReliability({ sample: 500, sampleTarget: 500, structureStable: false });
  assert.ok(close(penalised, 0.55));
  const full = evidenceReliability({
    validationSkill: 0.08, agreement: 1, supportingFamilies: 8, dispersion: 0, sample: 60, sampleTarget: 60,
  });
  assert.ok(close(full, 1));
  assert.ok(evidenceReliability({ validationSkill: 0, agreement: 0.5, supportingFamilies: 0, dispersion: 0.18, sample: 0, sampleTarget: 60 }) <= 0.0500001);
});

test('the edge discount collapses a large edge measured from too few outcomes', () => {
  const thin = discountedEdgeProbability({ probability: 0.7, referenceProbability: 0.5, sample: 8, referenceSample: 1_000 });
  const thick = discountedEdgeProbability({ probability: 0.7, referenceProbability: 0.5, sample: 5_000, referenceSample: 5_000 });
  assert.ok(thin !== null && thick !== null);
  assert.ok(thin < 0.6, `thin sample should be discounted towards the reference, got ${thin}`);
  assert.ok(thick > 0.66, `a well-measured edge should survive, got ${thick}`);
  // A negative edge can never be turned into a positive one by the discount.
  const negative = discountedEdgeProbability({ probability: 0.4, referenceProbability: 0.5, sample: 2_000, referenceSample: 5_000 });
  assert.ok(negative !== null && negative <= 0.4);
  assert.equal(discountedEdgeProbability({ probability: 0.6, referenceProbability: 0.5, sample: 0, referenceSample: 100 }), null);
  assert.equal(discountedEdgeProbability({ probability: 0.6, referenceProbability: 0.5, sample: 100, referenceSample: null }), null);
  assert.equal(discountedEdgeProbability({ probability: null, referenceProbability: 0.5, sample: 100, referenceSample: 100 }), null);
});

test('the Wilson interval is a one-tailed-safe lower bound for the observed rate', () => {
  const none = wilsonInterval95(0, 20);
  assert.ok(none);
  assert.equal(none.lower, 0);
  assert.ok(none.upper > 0 && none.upper < 0.2);
  const all = wilsonInterval95(20, 20);
  assert.ok(all);
  assert.equal(all.upper, 1);
  assert.ok(all.lower > 0.8);
  assert.equal(wilsonInterval95(5, 0), null);
  assert.equal(wilsonInterval95(21, 20), null);
  assert.equal(wilsonInterval95(1.5, 20), null);
});
