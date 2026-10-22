// Layer 7 — the embedded, free neural model.
//
// The model is only worth shipping if three properties hold:
//
//   1. it is deterministic and causal — the same feed produces the same
//      forecast, and no feature ever sees the tick it is predicting;
//   2. it is inert when it has not earned a vote — on a fair stream it must
//      measure at chance and leave the published probability bit-identical;
//   3. it actually learns — on a stream with real structure it must validate
//      out of sample, peak on the structured class, and move the estimate.
//
// These tests pin all three, for both the digit and the quote network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIGIT_FEATURE_COUNT, DIGIT_FEATURE_WINDOW, QUOTE_FEATURE_COUNT, digitFeatures } from '../src/lib/neural/features.ts';
import { NEURAL_MAX_WEIGHT, trainClassifier } from '../src/lib/neural/train.ts';
import { fuseNeural, neuralEvidence, trainDigitNeuralModel, trainQuoteNeuralModel } from '../src/lib/neural/models.ts';
import { confidenceScore, neuralTerm } from '../src/lib/signal-engine/confidence.ts';
import { analyzeDigitMarket } from '../src/lib/signal-engine/digit-signal.ts';

function sfc32(seed) {
  let a = 0x9e3779b9; let b = 0x243f6a88 + seed; let c = 0xb7e15162; let d = 0x12345678 ^ (seed * 7919);
  const next = () => { a |= 0; b |= 0; c |= 0; d |= 0; const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let index = 0; index < 40; index += 1) next();
  return next;
}

const fairDigits = (seed, length = 1_600) => {
  const random = sfc32(seed);
  return Array.from({ length }, () => Math.floor(random() * 10));
};

/** A stream where digit 7 is far more likely than any other digit. */
const biasedDigits = (seed, length = 1_600) => {
  const random = sfc32(seed);
  return Array.from({ length }, () => (random() < 0.6 ? 7 : Math.floor(random() * 10)));
};

test('digit features are the declared width and never look at the tick they predict', () => {
  const digits = fairDigits(3, 600);
  const features = digitFeatures(digits, 400);
  assert.ok(features);
  assert.equal(features.length, DIGIT_FEATURE_COUNT);
  assert.equal(QUOTE_FEATURE_COUNT, 20);
  // Rewriting the future must not change a feature vector built at index 400.
  const rewritten = [...digits.slice(0, 401), ...Array.from({ length: 199 }, (_, index) => (index * 7) % 10)];
  const after = digitFeatures(rewritten, 400);
  assert.deepEqual(Array.from(features), Array.from(after));
  // Too little history is refused rather than padded with zeros.
  assert.equal(digitFeatures(digits, DIGIT_FEATURE_WINDOW - 2), null);
});

test('the digit net is deterministic for a given feed', () => {
  const digits = biasedDigits(11, 1_200);
  const first = trainDigitNeuralModel(digits);
  const second = trainDigitNeuralModel(digits);
  assert.ok(first && second);
  assert.deepEqual(first.distribution, second.distribution);
  assert.equal(first.weight, second.weight);
  assert.equal(first.metrics.brierSkill, second.metrics.brierSkill);
  assert.equal(first.model.parameters, second.model.parameters);
  assert.equal(first.model.license, 'MIT');
  assert.equal(first.model.cost, 'free');
});

test('on a fair stream the model measures at chance and carries no weight', () => {
  const forecast = trainDigitNeuralModel(fairDigits(5, 1_600));
  assert.ok(forecast);
  assert.equal(forecast.weight, 0);
  assert.equal(forecast.metrics.validated, false);
  assert.ok((forecast.metrics.brierSkill ?? 0) < 0.05, `brier skill ${forecast.metrics.brierSkill}`);
  const fused = fuseNeural({
    probability: 0.531, fair: 0.5, neuralProbability: 0.62, weight: forecast.weight, metrics: forecast.metrics,
  });
  // Bit-identical: an unvalidated model can never move a published estimate.
  assert.equal(fused.probability, 0.531);
  assert.equal(fused.fusion.weight, 0);
  assert.equal(fused.fusion.contributionPts, 0);
});

test('on a structured stream the model validates, peaks on the hot digit and earns weight', () => {
  const forecast = trainDigitNeuralModel(biasedDigits(21, 1_600));
  assert.ok(forecast);
  assert.equal(forecast.metrics.validated, true, JSON.stringify(forecast.metrics));
  assert.ok((forecast.metrics.z ?? 0) >= 2, `z ${forecast.metrics.z}`);
  assert.ok((forecast.metrics.brierSkill ?? 0) > 0);
  assert.ok(forecast.weight > 0 && forecast.weight <= NEURAL_MAX_WEIGHT);
  // The live distribution must lean on the digit that actually runs hot.
  assert.equal(forecast.topDigit, 7);
  assert.ok(forecast.distribution[7] > 0.2, `p(7)=${forecast.distribution[7]}`);
  const sum = forecast.distribution.reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const fused = fuseNeural({
    probability: 0.15, fair: 0.1, neuralProbability: forecast.distribution[7], weight: forecast.weight, metrics: forecast.metrics,
  });
  assert.ok(fused.fusion.weight > 0);
  assert.ok(fused.probability > 0.15, 'the validated model pulls the estimate toward its own view');
  assert.ok(fused.probability < forecast.distribution[7] + 1e-9, 'a weighted second opinion cannot overshoot');
  assert.equal(fused.fusion.stance, 'supportive');
});

test('the fusion is a weighted second opinion, never a multiplier outside the two estimates', () => {
  const metrics = { validated: true, brierSkill: 0.08, holdoutRows: 300, logLossSkill: 0.05 };
  const agree = fuseNeural({ probability: 0.52, fair: 0.5, neuralProbability: 0.58, weight: 0.2, metrics });
  assert.ok(agree.probability > 0.52 && agree.probability < 0.58);
  const oppose = fuseNeural({ probability: 0.52, fair: 0.5, neuralProbability: 0.44, weight: 0.2, metrics });
  assert.ok(oppose.probability < 0.52 && oppose.probability > 0.44);
  assert.equal(oppose.fusion.stance, 'contradicting');
  assert.ok(oppose.fusion.contributionPts < 0);
  // Missing forecasts fail closed.
  const missing = fuseNeural({ probability: 0.52, fair: 0.5, neuralProbability: null, weight: 0.2, metrics });
  assert.equal(missing.probability, 0.52);
});

test('the neural evidence term is silent until the model validates', () => {
  const base = { probability: 0.56, fair: 0.5, skill: 0.06, sample: 300 };
  assert.equal(neuralTerm({ ...base, validated: false, contradicted: false }), 0);
  assert.ok(neuralTerm({ ...base, validated: true, contradicted: false }) > 0);
  assert.ok(neuralTerm({ ...base, validated: true, contradicted: true }) < 0);
  // A contradicted neural model may only lower the score.
  assert.ok(neuralTerm({ ...base, probability: 0.48, validated: true, contradicted: true }) < 0);
  const input = { weightedAgreement: 0.7, edgeRatio: 0.12, backtest: null, validationSkill: 0.03, dataQuality: 1 };
  assert.equal(confidenceScore(input).breakdown.neural, 0);
  assert.equal(confidenceScore({ ...input, neural: neuralEvidence({
    probability: 0.56, fair: 0.5, weight: 0.1, contributionPts: 0.6, skill: 0.06, sample: 300, validated: true, contradicted: false,
  }) }).breakdown.neural > 0, true);
});

test('the quote net learns a genuinely cyclical market and stays silent on a random walk', () => {
  // A pure sine wave has a learnable direction at the next tick.
  const cyclical = Array.from({ length: 1_400 }, (_, index) => 100 + 2 * Math.sin(index / 3));
  const cyclicForecast = trainQuoteNeuralModel(cyclical, cyclical.map((_, index) => index + 1), { horizonTicks: 1 });
  assert.ok(cyclicForecast);
  assert.equal(cyclicForecast.metrics.validated, true, JSON.stringify(cyclicForecast.metrics));
  assert.ok(cyclicForecast.weight > 0);

  const random = sfc32(17);
  let price = 1_000;
  const walk = Array.from({ length: 1_400 }, () => {
    price += (random() - 0.5) * 0.4;
    return price;
  });
  const walkForecast = trainQuoteNeuralModel(walk, walk.map((_, index) => index + 1), { horizonTicks: 1 });
  assert.ok(walkForecast);
  assert.equal(walkForecast.metrics.validated, false);
  assert.equal(walkForecast.weight, 0);
  assert.ok(walkForecast.probabilityUp > 0.2 && walkForecast.probabilityUp < 0.8);
});

test('a thin stream is refused instead of fitted on noise', () => {
  assert.equal(trainDigitNeuralModel(fairDigits(9, 220)), null);
  assert.equal(trainClassifier([], { spec: { inputDim: 4, hidden: [2], outputs: 2, seed: 1 } }), null);
});

test('the digit tools publish the neural layer alongside the engines', () => {
  const digits = biasedDigits(31, 1_200);
  const ticks = digits.map((digit, index) => ({ epoch: 1_700_000_000 + index, digit }));
  const result = analyzeDigitMarket({
    family: 'matches', symbol: 'R_100', name: 'Volatility 100', horizon: 1, ticks, fresh: true,
  });
  // Layer 7 is present at market level, on the winning contract and in the notes.
  assert.ok(result.neural, 'the market carries the trained model');
  assert.equal(result.neural.kind, 'digit');
  assert.equal(result.neural.distribution.length, 10);
  assert.ok(result.best.neural, 'the signal reports what the model did');
  assert.equal(typeof result.best.neural.weight, 'number');
  assert.ok(result.notes.some((note) => note.startsWith('Neural model:')), 'the note explains the fit');
  // The master decision sees it as its own evidence source.
  const source = result.best.master.sources.find((entry) => entry.id === 'neural');
  assert.ok(source, 'the master decision lists the neural source');
  // And the published probability is still a probability: the layer is
  // additive, never a reason to withhold a signal.
  assert.ok(result.best.probability > 0 && result.best.probability < 1);
  assert.ok(Number.isFinite(result.best.confidence));
});
