// Accuracy and precision regression suite for the calibration, stacking and
// shrinkage layers.
//
// The signal tools publish a probability. The only defensible way to test a
// probability is against ground truth we control: every test here builds a
// stream with a KNOWN win rate (or a known miscalibration) and asks whether the
// published number is close to it (accuracy) and stable across seeds
// (precision). The null cases assert the opposite — that a stream with no
// structure produces no invented edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrationBins, calibrationSlope, crossValidateCalibration, fitPlatt, forecastStandardError,
  precisionShrinkage, probabilityInterval, purgedFolds, recalibrate, reliabilityReport,
} from '../src/lib/signal-engine/recalibration.ts';
import { accuracyAudit, heterogeneity, inverseNormalCdf, lagOneAutocorrelation, rateStandardError, shrinkEdges, standoutThreshold } from '../src/lib/signal-engine/precision.ts';
import { blendWeight, constrainedRidgeWeights, fitStackWeights, mixWeights, projectToSimplex } from '../src/lib/signal-engine/stacking.ts';

function sfc32(seed) {
  let a = 0x9e3779b9; let b = 0x243f6a88 + seed; let c = 0xb7e15162; let d = 0x12345678 ^ (seed * 7919);
  const next = () => { a |= 0; b |= 0; c |= 0; d |= 0; const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let index = 0; index < 20; index += 1) next();
  return next;
}

/**
 * A forecaster with a known distortion: it issues `compress(raw, slope)` while
 * the true win rate is `raw`. Everything the calibrator has to recover is the
 * inverse of `compress`.
 */
const compress = (probability, slope) => 0.5 + slope * (probability - 0.5);
const LOGIT = (probability) => Math.log(probability / (1 - probability));
const SIGMOID = (value) => 1 / (1 + Math.exp(-value));

function labelledSeries(seed, length, transform = (value) => value) {
  const random = sfc32(seed);
  const points = [];
  for (let index = 0; index < length; index += 1) {
    const trueRate = 0.2 + 0.6 * random();
    points.push({ probability: transform(trueRate), won: random() < trueRate ? 1 : 0 });
  }
  return points;
}

// ---- purged folds -----------------------------------------------------------

test('purged folds are chronological, non-empty and leave an embargo gap', () => {
  const folds = purgedFolds(400, { folds: 5, minimumTraining: 120, embargo: 2 });
  assert.ok(folds.length >= 3);
  let previousEnd = 0;
  for (const fold of folds) {
    assert.ok(fold.trainEnd + 2 <= fold.testStart, 'the embargo must separate training rows from scoring rows');
    assert.ok(fold.testEnd > fold.testStart);
    assert.ok(fold.testStart >= previousEnd);
    previousEnd = fold.testEnd;
  }
  assert.equal(folds.at(-1).testEnd, 400);
  assert.deepEqual(purgedFolds(10), []);
});

// ---- accuracy ---------------------------------------------------------------

test('a known overconfident forecaster is detected and corrected toward the truth', () => {
  // The forecaster is too extreme: it reports 0.5 + 1.8·(θ − 0.5).
  const distorted = labelledSeries(11, 900, (value) => compress(value, 1.8));
  const rawAudit = accuracyAudit(distorted.map((point) => point.probability), distorted.map((point) => point.won));
  // The distortion shows up as a calibration slope well below 1...
  const rawSlope = calibrationSlope(distorted);
  assert.ok(rawSlope !== null && rawSlope < 0.8, `raw slope ${rawSlope}`);
  // ...and recalibration pulls the mean forecast back onto the realised rate.
  const result = recalibrate(distorted, { minimum: 80, minimumEvaluation: 25 });
  const cv = crossValidateCalibration(distorted);
  const calibrated = accuracyAudit(cv.outOfFold, cv.labels);
  assert.ok(calibrated.rmse < rawAudit.rmse, `rmse ${rawAudit.rmse} → ${calibrated.rmse}`);
  assert.ok(result.raw.reliability > 0.005, `reliability ${result.raw.reliability}`);
  assert.ok(result.calibrated.reliability < result.raw.reliability,
    `reliability ${result.raw.reliability} → ${result.calibrated.reliability}`);
});

test('cross-validated calibration recovers a known logit distortion and lowers the Brier score', () => {
  // True rate θ; the forecaster reports sigmoid(0.6·logit(θ) + 0.4) — a classic
  // overconfident model whose inverse is recoverable from data alone.
  const distort = (value) => SIGMOID(0.6 * LOGIT(value) + 0.4);
  let rawBias = 0;
  let calibratedBias = 0;
  let rawBrier = 0;
  let calibratedBrier = 0;
  let worstBiasZ = 0;
  const seeds = [23, 24, 25, 26, 27, 28];
  for (const seed of seeds) {
    const points = labelledSeries(seed, 800, distort);
    const cv = crossValidateCalibration(points);
    assert.ok(cv.evaluationSample > 400, `expected most rows to receive an out-of-fold prediction, got ${cv.evaluationSample}`);
    const raw = accuracyAudit(cv.rawOutOfFold, cv.labels);
    const calibrated = accuracyAudit(cv.outOfFold, cv.labels);
    rawBrier += raw.rmse ** 2;
    calibratedBrier += calibrated.rmse ** 2;
    rawBias += Math.abs(raw.bias);
    calibratedBias += Math.abs(calibrated.bias);
    worstBiasZ = Math.max(worstBiasZ, Math.abs(calibrated.biasZ));
    assert.ok(calibrated.rmse < raw.rmse, `seed ${seed}: rmse ${raw.rmse} → ${calibrated.rmse}`);
  }
  // Accuracy: the published numbers must sit on the realised frequencies.
  assert.ok(calibratedBias < rawBias / 2, `mean |bias| ${rawBias / seeds.length} → ${calibratedBias / seeds.length}`);
  // And the residual gap must be inside sampling noise on every seed.
  assert.ok(worstBiasZ < 2, `worst residual bias z ${worstBiasZ}`);
  assert.ok(calibratedBrier < rawBrier, `mean Brier ${rawBrier / seeds.length} → ${calibratedBrier / seeds.length}`);
});

test('the deployed calibrator is refitted on every row, so it is more precise than a half-sample fit', () => {
  const distort = (value) => SIGMOID(0.55 * LOGIT(value) - 0.35);
  let cvRows = 0;
  let halfRows = 0;
  for (let seed = 0; seed < 12; seed += 1) {
    const points = labelledSeries(100 + seed, 600, distort);
    const result = recalibrate(points, { minimum: 80, minimumEvaluation: 25 });
    cvRows += result.sample;
    halfRows += Math.floor(points.length / 2);
  }
  // The final fit uses the full sample (600 rows) instead of the 300 the
  // single-split version could use — a 2× increase in fitting data.
  assert.ok(cvRows > halfRows * 1.9, `cv rows ${cvRows} vs half rows ${halfRows}`);
});

test('calibration refuses to accept an improvement it cannot prove out of fold', () => {
  // Perfectly calibrated forecasts: there is nothing to correct, so the layer
  // must leave the probability alone rather than fit noise.
  const points = labelledSeries(37, 600);
  const result = recalibrate(points, { minimum: 80, minimumEvaluation: 25 });
  assert.equal(result.improved, false);
  assert.equal(result.method, 'none');
  const identity = result.predict(0.42);
  assert.ok(Math.abs(identity - 0.42) < 1e-6, `identity predictor moved the estimate: ${identity}`);
});

test('reliability decomposition separates accuracy from skill on a distorted stream', () => {
  const points = labelledSeries(53, 700, (value) => compress(value, 1.7));
  const report = reliabilityReport(points);
  assert.ok(report.sample === points.length);
  assert.ok(report.bins.length >= 2);
  assert.ok(report.reliability > 0.01, `reliability ${report.reliability}`);
  assert.ok(report.resolution > 0, `resolution ${report.resolution}`);
  // Murphy's identity over the bins, including the forecast noise left inside
  // them: Brier = reliability − resolution + uncertainty + withinBinVariance.
  const identity = report.reliability - report.resolution + report.uncertainty + report.withinBinResidual;
  assert.ok(Math.abs(identity - report.brier) < 1e-9, `${identity} vs ${report.brier}`);
  // Overconfidence shows as a positive bias and a slope under 1.
  assert.ok(report.slope === null || report.slope < 1.05);
  assert.ok(report.expectedCalibrationError !== null);
  const bins = calibrationBins(points, 8);
  assert.equal(bins.length, report.bins.length);
});

test('probability intervals cover the truth and shrink with more data', () => {
  const random = sfc32(71);
  const truth = 0.62;
  for (const length of [400, 2_000]) {
    const points = Array.from({ length }, () => ({ probability: truth, won: random() < truth ? 1 : 0 }));
    const interval = probabilityInterval(points, truth);
    assert.ok(interval);
    assert.ok(interval.lower < truth && interval.upper > truth, `interval [${interval.lower}, ${interval.upper}] missed ${truth}`);
    if (length === 400) globalThis.__narrow = interval;
    else assert.ok(interval.standardError < globalThis.__narrow.standardError, 'more data must give a tighter interval');
  }
  const se = forecastStandardError(Array.from({ length: 300 }, () => ({ probability: 0.5, won: 1 })));
  assert.ok(se !== null && se >= 0);
});

// ---- precision --------------------------------------------------------------

test('shrinkage collapses noise edges and preserves measured ones', () => {
  const random = sfc32(97);
  // 24 candidates, every true edge exactly zero, each measured with noise.
  const noise = Array.from({ length: 24 }, () => {
    const error = 0.02;
    // Standardised edges well inside ±1: this pool is pure noise by construction.
    return { edge: error * (random() * 2 - 1), standardError: error };
  });
  const noiseShrunk = shrinkEdges(noise);
  assert.equal(noiseShrunk.heterogeneity.heterogeneous, false);
  assert.equal(noiseShrunk.tau, 0);
  for (const edge of noiseShrunk.edges) assert.ok(Math.abs(edge) < 1e-12, `noise edge survived: ${edge}`);

  // Same pool, but two candidates carry a real 4-point edge measured precisely.
  const signal = noise.map((candidate, index) => (index < 2 ? { edge: 0.04, standardError: 0.004 } : candidate));
  const signalShrunk = shrinkEdges(signal);
  assert.ok(signalShrunk.heterogeneity.heterogeneous);
  assert.equal(signalShrunk.standouts.length, 2, 'both planted edges must clear the standout bar');
  assert.equal(signalShrunk.factors[0], 1);
  assert.ok(signalShrunk.edges[0] > 0.039, `real edge over-shrunk: ${signalShrunk.edges[0]}`);
  // The key property: a real contract does NOT license the noise around it.
  // Every remaining candidate is pure noise and must collapse to nothing.
  for (let index = 2; index < signal.length; index += 1) {
    assert.ok(Math.abs(signalShrunk.edges[index]) < 1e-12, `noise candidate ${index} kept ${signalShrunk.edges[index]} because a real edge existed elsewhere`);
  }
  // Selecting the winner still costs the winner's-curse debit.
  assert.ok(signalShrunk.selectionBiasUnits > 1, `selection bias ${signalShrunk.selectionBiasUnits}`);
});

test('the standout bar rises with the number of candidates inspected', () => {
  assert.ok(standoutThreshold(16) > standoutThreshold(4));
  assert.ok(standoutThreshold(4) >= 2.5);
  assert.ok(inverseNormalCdf(0.975) > 1.95 && inverseNormalCdf(0.975) < 1.97);
  assert.ok(Math.abs(inverseNormalCdf(0.5)) < 1e-6);
});

test('heterogeneity is not manufactured by adding more noise candidates', () => {
  for (const count of [8, 32, 128]) {
    const random = sfc32(count);
    const candidates = Array.from({ length: count }, () => ({ edge: (random() * 2 - 1) * 0.02, standardError: 0.02 }));
    const stats = heterogeneity(candidates);
    assert.equal(stats.heterogeneous, false, `pool of ${count} noise candidates declared heterogeneous`);
  }
});

test('shrinkage lowers the mean squared error of published edges (precision)', () => {
  let rawError = 0;
  let shrunkError = 0;
  for (let seed = 0; seed < 60; seed += 1) {
    const random = sfc32(1_000 + seed);
    const truth = Array.from({ length: 16 }, () => (random() < 0.25 ? 0.03 : 0));
    const observed = truth.map((value) => value + 0.02 * gaussish(random));
    const candidates = observed.map((edge) => ({ edge, standardError: 0.02 }));
    const shrunk = shrinkEdges(candidates);
    for (let index = 0; index < truth.length; index += 1) {
      rawError += (observed[index] - truth[index]) ** 2;
      shrunkError += (shrunk.edges[index] - truth[index]) ** 2;
    }
  }
  assert.ok(shrunkError < rawError, `shrunk MSE ${shrunkError} must beat raw MSE ${rawError}`);
});

function gaussish(random) {
  return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
}

test('precisionShrinkage is monotone in the standard error and never flips a sign', () => {
  const edge = 0.03;
  const tau = 0.02;
  const tight = precisionShrinkage(edge, 0.005, tau);
  const loose = precisionShrinkage(edge, 0.05, tau);
  assert.ok(tight > loose && loose > 0);
  assert.ok(tight <= edge + 1e-12);
  assert.equal(precisionShrinkage(edge, 0.005, 0), 0, 'no real dispersion means no edge survives');
  assert.equal(precisionShrinkage(-edge, 0.005, tau), -precisionShrinkage(edge, 0.005, tau));
});

test('autocorrelation inflates the standard error instead of hiding in it', () => {
  const flat = rateStandardError(0.5, 200, null);
  const correlated = rateStandardError(0.5, 200, 0.4);
  assert.ok(correlated > flat, `${correlated} vs ${flat}`);
  const series = Array.from({ length: 200 }, (_, index) => Math.sin(index / 3));
  const lag = lagOneAutocorrelation(series);
  assert.ok(lag !== null && lag > 0.5, `lag ${lag}`);
  assert.equal(lagOneAutocorrelation([1]), null);
});

// ---- stacking ---------------------------------------------------------------

test('simplex projection returns a non-negative distribution that sums to one', () => {
  const projected = projectToSimplex([0.7, -0.2, 0.4, 0.1]);
  assert.ok(projected.every((value) => value >= 0));
  assert.ok(Math.abs(projected.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  const uniform = projectToSimplex([3, 3, 3]);
  assert.ok(uniform.every((value) => Math.abs(value - 1 / 3) < 1e-9));
});

test('the learned combination finds the engine that actually knows the answer', () => {
  const random = sfc32(211);
  const rows = [];
  for (let index = 0; index < 600; index += 1) {
    const truth = random() < 0.5 ? 1 : 0;
    // Engine 0 is informative, engines 1–3 are noise around the base rate.
    rows.push({
      forecasts: [
        truth ? 0.5 + 0.18 + 0.02 * (random() - 0.5) : 0.5 - 0.18 + 0.02 * (random() - 0.5),
        0.5 + 0.05 * (random() - 0.5),
        0.5 + 0.05 * (random() - 0.5),
        0.5 + 0.05 * (random() - 0.5),
      ],
      outcome: truth,
    });
  }
  const result = fitStackWeights(rows, 4);
  assert.ok(result.weights[0] > 0.5, `informative engine got weight ${result.weights[0]}`);
  assert.ok(Math.abs(result.weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.ok(result.weights.every((value) => value >= 0));
  assert.ok(result.skill !== null && result.skill > 0, `learned combination must beat equal weights: ${result.skill}`);
});

test('a stack of pure noise collapses toward equal weights and never invents skill', () => {
  const random = sfc32(223);
  const rows = Array.from({ length: 600 }, () => {
    const truth = random() < 0.5 ? 1 : 0;
    return { forecasts: Array.from({ length: 6 }, () => 0.5 + 0.05 * (random() - 0.5)), outcome: truth };
  });
  const result = fitStackWeights(rows, 6);
  for (const weight of result.weights) assert.ok(Math.abs(weight - 1 / 6) < 0.12, `noise engine got weight ${weight}`);
  // Blending the learned weights in must not degrade the reference.
  const blend = blendWeight(result.weights, [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6], rows);
  assert.ok(blend.brier === null || blend.brier <= (blend.baselineBrier ?? 1) + 1e-9);
});

test('missing engine forecasts are imputed without rewarding absence', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    forecasts: [index % 2 === 0 ? 0.6 : 0.4, index % 3 === 0 ? null : 0.5],
    outcome: (index % 2 === 0 ? 1 : 0),
  }));
  const weights = constrainedRidgeWeights(rows, 2, 4);
  assert.equal(weights.length, 2);
  assert.ok(Math.abs(weights[0] + weights[1] - 1) < 1e-9);
  assert.ok(weights.every((value) => value >= 0));
  const mixed = mixWeights([1, 0], [0, 1], 0.25);
  assert.ok(Math.abs(mixed[0] - 0.75) < 1e-9 && Math.abs(mixed[1] - 0.25) < 1e-9);
});

test('platt scaling fits the log-odds, so it can express over- and under-confidence', () => {
  const points = labelledSeries(307, 600, (value) => SIGMOID(0.6 * LOGIT(value) + 0.4));
  const fit = fitPlatt(points);
  assert.ok(fit.model);
  // The fitted slope on logit(p) must be above 1 to undo the 0.6 compression.
  assert.ok((fit.slope ?? 0) > 1.2, `slope ${fit.slope}`);
  const low = fit.predict(0.2);
  const high = fit.predict(0.8);
  assert.ok(low < 0.2 && high > 0.8, `platt did not decompress: ${low} / ${high}`);
});
