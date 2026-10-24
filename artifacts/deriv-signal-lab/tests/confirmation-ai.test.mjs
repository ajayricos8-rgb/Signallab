// Layer 3 — the AI meta-model.
//
// The stack used to be fitted on [p, logit(p)]: two monotone transforms of the
// same number. It could rescale a probability but never add information, so on
// a well-calibrated ensemble it lost to the base by construction and the "AI"
// source never carried weight. These tests pin the replacement: a meta-model
// over features the linear blend cannot express, accepted only when it beats
// the base out of sample, and refused outright when those features are absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmDigitContract } from '../src/lib/signal-engine/confirmation.ts';
import { fitOutOfSampleStack } from '../src/lib/signal-engine/stats.ts';

function state(overrides = {}) {
  return {
    regime: 'random',
    predictability: 0.1,
    confidence: 0.2,
    prior: null,
    priorBacktest: { sample: 0, skill: null, improved: false },
    ...overrides,
  };
}

const backtest = (overrides = {}) => ({ sample: 60, wins: 34, zScore: 1.2, ...overrides });
const tally = { agreeing: 4, total: 12, weightedAgreement: 0.55 };

/** 400 rows where the ensemble probability is useless but the feature is not. */
function rows() {
  const holdout = [];
  const features = [];
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let index = 0; index < 400; index += 1) {
    const signal = rand() < 0.5 ? 1 : -1;
    // 85% of outcomes follow the hidden feature, so it is genuinely predictive
    // while the published probability stays at the fair rate.
    const won = rand() < 0.85 ? (signal > 0 ? 1 : 0) : (signal > 0 ? 0 : 1);
    holdout.push({ probability: 0.5, won });
    features.push([signal, signal, signal * 0.5]);
  }
  return { holdout, features };
}

test('the AI stack earns its place from features the blend cannot see', () => {
  const { holdout, features } = rows();
  const report = confirmDigitContract({
    contractLabel: 'TEST 5',
    probability: 0.5,
    fairRate: 0.5,
    holdout,
    state: state(),
    tally,
    backtest: backtest(),
    validationSkill: 0.08,
    statePriorProbability: null,
    engineFeatures: features,
    liveFeatures: [1, 1, 0.5],
  });
  assert.ok(report.ai.stackedProbability !== null, 'stack should be accepted');
  assert.ok((report.ai.stackSkill ?? 0) > 0.02, `skill ${report.ai.stackSkill}`);
  assert.equal(report.ai.stackSample, 400);
  assert.ok(report.ai.stackedProbability > 0.6, `live ${report.ai.stackedProbability}`);
  // Every correction is bounded to six probability points from the base.
  assert.ok(report.probability >= 0.44 && report.probability <= 0.56, `published ${report.probability}`);
  assert.ok(report.reasons.some((reason) => /AI meta-model/.test(reason)));
});

test('without meta features the stack is not fitted and cannot vote', () => {
  const { holdout } = rows();
  const report = confirmDigitContract({
    contractLabel: 'TEST 5',
    probability: 0.5,
    fairRate: 0.5,
    holdout,
    state: state(),
    tally,
    backtest: backtest(),
    validationSkill: 0.08,
    statePriorProbability: null,
  });
  assert.equal(report.ai.stackedProbability, null);
  assert.equal(report.ai.stackSkill, null);
  assert.equal(report.ai.stackSample, 0);
});

test('malformed or misaligned features are ignored rather than crashing', () => {
  const { holdout, features } = rows();
  const report = confirmDigitContract({
    contractLabel: 'TEST 5',
    probability: 0.5,
    fairRate: 0.5,
    holdout,
    state: state(),
    tally,
    backtest: backtest(),
    validationSkill: 0.08,
    statePriorProbability: null,
    engineFeatures: features.slice(0, 20),
    liveFeatures: [1, 1],
  });
  assert.equal(report.ai.stackedProbability, null);
});

test('the stack gate is a real out-of-sample test, not an in-sample fit', () => {
  // Labels with no relation to the feature must not produce an accepted stack.
  const holdout = Array.from({ length: 400 }, (_, index) => ({ probability: 0.5, won: index % 2 }));
  const features = Array.from({ length: 400 }, (_, index) => [index % 3 === 0 ? 1 : -1, 0, 0]);
  const result = fitOutOfSampleStack(
    holdout.map((point, index) => [point.probability, 0, ...features[index]]),
    holdout.map((point) => point.won),
    { minimum: 120, minimumEvaluation: 40, ridge: 3 },
  );
  assert.equal(result.improved, false);
  assert.equal(result.model, null);
});
