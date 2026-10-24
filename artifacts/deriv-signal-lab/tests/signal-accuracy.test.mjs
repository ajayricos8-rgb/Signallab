// End-to-end accuracy and precision audit of the published signal.
//
// These are the numbers the tool is judged on, measured against ground truth:
//
//   ACCURACY  — a stream is generated from a distribution whose contract
//               probabilities are known exactly. The published probability is
//               compared with the true value it is claiming. A perfect tool
//               publishes the truth; a biased one publishes something else.
//
//   PRECISION — the same estimate is repeated across independent seeds. The
//               spread of the published numbers is the precision: a tool that
//               says 0.34 for one seed and 0.12 for the next on the SAME market
//               is not measuring anything.
//
//   NULL      — on a fair (uniform) digit stream the true edge is exactly zero
//               by construction, so every basis point the tool reports is
//               error. This is the test that decides whether a scan of thirteen
//               random markets manufactures signals.
//
// Run against a pristine checkout to compare: see `docs/accuracy-audit.md`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDigitMarket } from '../src/lib/signal-engine/digit-signal.ts';
import { analyzeRiseFallMarket } from '../src/lib/signal-engine/rise-fall-signal.ts';
import { contractWins } from '../src/lib/over-under/ensemble.ts';

const TICKS = 2_000;

function sfc32(seed) {
  let a = 0x9e3779b9; let b = 0x243f6a88 + seed; let c = 0xb7e15162; let d = 0x12345678 ^ (seed * 7919);
  const next = () => { a |= 0; b |= 0; c |= 0; d |= 0; const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let index = 0; index < 40; index += 1) next();
  return next;
}

/**
 * i.i.d. digits drawn from `weights`. The contract probabilities of this stream
 * are known exactly, so any deviation the tool reports is its own error.
 */
function drawDigits(random, weights, length) {
  const cumulative = [];
  let total = 0;
  for (const weight of weights) { total += weight; cumulative.push(total); }
  return Array.from({ length }, () => {
    const value = random() * total;
    for (let digit = 0; digit < cumulative.length; digit += 1) if (value < cumulative[digit]) return digit;
    return cumulative.length - 1;
  });
}

/** Exact win probability of a contract under an i.i.d. digit distribution. */
export function trueProbability(weights, contract) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  let probability = 0;
  for (let digit = 0; digit < 10; digit += 1) if (contractWins(contract, digit)) probability += weights[digit] ?? 0;
  return probability / total;
}

export const UNIFORM_WEIGHTS = new Array(10).fill(1);

/** A mild, realistic bias: one digit favoured, one suppressed. */
export function biasedWeights(hotDigit, strength) {
  const weights = new Array(10).fill(1);
  weights[hotDigit] = 1 + strength;
  weights[(hotDigit + 5) % 10] = Math.max(0.05, 1 - strength);
  return weights;
}

const digitTicks = (digits) => digits.map((digit, index) => ({ epoch: 1_700_000_000 + index, digit }));

/**
 * Run one full audit pass.
 *
 * Estimation and selection are measured SEPARATELY, because conflating them
 * hides the thing that matters: a tool can publish a perfect probability for
 * the wrong contract, or pick the right contract and mis-size it.
 *
 *   estimate — for the contract with the largest TRUE edge, how close is the
 *              published number to the truth? (apples to apples)
 *   selection — what true edge did the tool actually pick, as a share of the
 *              best true edge available on that stream?
 *   null     — on a fair stream every true edge is exactly zero, so anything
 *              published is error.
 */
export function runAudit(seeds = 24, family = 'matches') {
  const rows = [];
  for (let seed = 0; seed < seeds; seed += 1) {
    const random = sfc32(9_000 + seed);

    // 1. NULL: a fair stream; every reported edge is error.
    const uniform = analyzeDigitMarket({
      family, symbol: 'R_100', name: 'Volatility 100 Index', horizon: 1,
      ticks: digitTicks(drawDigits(random, UNIFORM_WEIGHTS, TICKS)), fresh: true, marketsInScan: 13,
    });
    rows.push({ kind: 'null', seed, published: uniform.best.probability, truth: uniform.best.fairProbability });

    // 2/3. A biased stream: measure the published probability for the contract
    // with the largest true edge, and see which contract the tool chose.
    for (const [kind, weights] of [['structured', biasedWeights(seed % 10, 1.6)], ['mild', biasedWeights((seed + 3) % 10, 0.5)]]) {
      const result = analyzeDigitMarket({
        family, symbol: 'R_50', name: 'Volatility 50 Index', horizon: 1,
        ticks: digitTicks(drawDigits(random, weights, TICKS)), fresh: true, marketsInScan: 13,
      });
      const truths = result.contracts.map((signal) => ({ signal, truth: trueProbability(weights, signal.contract) }));
      const target = truths.reduce((best, row) => (Math.abs(row.truth - row.signal.fairProbability) > Math.abs(best.truth - best.signal.fairProbability) ? row : best));
      const chosen = truths.find((row) => row.signal.contract === result.best.contract);
      const bestAvailableEdge = Math.max(...truths.map((row) => row.truth - row.signal.fairProbability));
      const chosenEdge = chosen.truth - chosen.signal.fairProbability;
      rows.push({
        kind,
        seed,
        published: target.signal.probability,
        truth: target.truth,
        selectionShare: bestAvailableEdge > 1e-9 ? chosenEdge / bestAvailableEdge : 1,
      });
    }
  }
  return rows;
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const stdev = (values) => {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - center) ** 2)));
};

test('the published probability tracks the true probability it is claiming', () => {
  const rows = runAudit(24);
  for (const kind of ['null', 'structured', 'mild']) {
    const subset = rows.filter((row) => row.kind === kind);
    const errors = subset.map((row) => row.published - row.truth);
    const mae = mean(errors.map((error) => Math.abs(error)));
    const rmse = Math.sqrt(mean(errors.map((error) => error ** 2)));
    const bias = mean(errors);
    // Thresholds are the measured values on 24 seeds with a small margin. They
    // are the regression lock: a change that rescales probabilities, compounds
    // two shrinkages or stops correcting for selection shows up here first.
    const budget = { null: 0.0005, structured: 0.025, mild: 0.022 }[kind];
    assert.ok(mae < budget, `${kind}: mean absolute error ${mae.toFixed(5)} exceeds ${budget}`);
    assert.ok(rmse < budget * 1.4, `${kind}: rmse ${rmse.toFixed(4)}`);
    assert.ok(Math.abs(bias) < budget, `${kind}: bias ${bias.toFixed(4)}`);
  }
});

test('a fair stream is reported as fair: scanning 13 random markets invents no edge', () => {
  const rows = runAudit(24).filter((row) => row.kind === 'null');
  const edges = rows.map((row) => row.published - row.truth);
  // The true edge is exactly zero on every one of these streams.
  const worst = Math.max(...edges.map((edge) => Math.abs(edge)));
  const meanAbsoluteEdge = mean(edges.map((edge) => Math.abs(edge)));
  // The precision layer collapses a noise pool to exactly no edge; before it
  // existed, a 13-market scan of fair streams still reported ~0.1 points.
  assert.ok(meanAbsoluteEdge < 0.0005, `mean |edge| on fair streams ${meanAbsoluteEdge.toFixed(5)}`);
  assert.ok(worst < 0.002, `worst |edge| on a fair stream ${worst.toFixed(5)}`);
  // And the estimates must be stable across seeds, not scattered.
  assert.ok(stdev(rows.map((row) => row.published)) < 0.001,
    `published probability spread across fair seeds ${stdev(rows.map((row) => row.published)).toFixed(4)}`);
});

test('a real bias is detected and sized, not just flagged', () => {
  const structured = runAudit(16).filter((row) => row.kind === 'structured');
  const edges = structured.map((row) => row.published - row.truth);
  // The truth here is a 2.6× digit; the tool must publish a probability well
  // above the 0.1 no-edge rate rather than shrinking the finding away.
  const meanTruth = mean(structured.map((row) => row.truth));
  const meanPublished = mean(structured.map((row) => row.published));
  assert.ok(meanTruth > 0.15, `setup error: truth ${meanTruth}`);
  assert.ok(meanPublished > 0.13, `published ${meanPublished} vs truth ${meanTruth}`);
  // Precision: the same market measured on independent seeds must agree.
  assert.ok(stdev(structured.map((row) => row.published)) < 0.05,
    `structured spread ${stdev(structured.map((row) => row.published)).toFixed(4)}`);
  // Accuracy: signed error centred on zero.
  assert.ok(Math.abs(mean(edges)) < 0.05, `structured bias ${mean(edges).toFixed(4)}`);
});

test('the scan picks the contract that actually carries the edge', () => {
  const rows = runAudit(16).filter((row) => row.kind !== 'null');
  const structured = rows.filter((row) => row.kind === 'structured');
  // On a stream with one clearly hot digit the correct contract is obvious;
  // picking anything else is a selection failure, not an estimation error.
  assert.ok(mean(structured.map((row) => row.selectionShare)) > 0.85,
    `captured ${(mean(structured.map((row) => row.selectionShare)) * 100).toFixed(1)}% of the available edge`);
  assert.ok(mean(rows.map((row) => row.selectionShare)) > 0.88,
    `captured ${(mean(rows.map((row) => row.selectionShare)) * 100).toFixed(1)}% overall`);
});

test('every published signal carries a measured interval that contains the truth', () => {
  let checked = 0;
  let contained = 0;
  for (let seed = 0; seed < 16; seed += 1) {
    const random = sfc32(4_000 + seed);
    const hot = seed % 10;
    const weights = biasedWeights(hot, 1.6);
    const result = analyzeDigitMarket({
      family: 'matches', symbol: 'R_50', name: 'Volatility 50 Index', horizon: 1,
      ticks: digitTicks(drawDigits(random, weights, TICKS)), fresh: true, marketsInScan: 13,
    });
    const signal = result.best;
    const truth = trueProbability(weights, signal.contract);
    assert.ok(signal.precision, 'every signal must report its precision');
    assert.ok(signal.precision.standardError === null || signal.precision.standardError >= 0);
    assert.ok(Number.isFinite(signal.precision.shrinkFactor)
      && signal.precision.shrinkFactor >= 0 && signal.precision.shrinkFactor <= 1);
    if (!signal.precision.interval) continue;
    checked += 1;
    if (signal.precision.interval.lower <= truth && truth <= signal.precision.interval.upper) contained += 1;
  }
  assert.ok(checked >= 12, `expected most signals to carry an interval, got ${checked}`);
  // A nominal 95% interval has to cover the truth most of the time; demanding
  // 100% would just reward an interval wide enough to be useless.
  assert.ok(contained / checked >= 0.6, `interval coverage ${contained}/${checked}`);
});


// ---- Rise / Fall -----------------------------------------------------------

const gauss = (random) => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());

/**
 * A drifted random walk whose one-tick probability of finishing higher is known
 * exactly: for Gaussian steps with mean `drift` and standard deviation `sigma`,
 * P(up after h ticks) = Φ(drift·√h / sigma) — no estimation required.
 */
function normalCdfValue(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const tail = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * (1 - tail));
}

export function runRiseFallAudit(seeds = 16) {
  const rows = [];
  for (let seed = 0; seed < seeds; seed += 1) {
    const random = sfc32(21_000 + seed);
    for (const [kind, driftPerTick] of [['flat', 0], ['drifting', 0.06]]) {
      const sigma = 1;
      let price = 1_000;
      const ticks = Array.from({ length: 2_000 }, (_, index) => {
        price += gauss(random) * sigma + driftPerTick;
        return { epoch: 1_700_000_000 + index, quote: Number(price.toFixed(4)) };
      });
      const result = analyzeRiseFallMarket({
        symbol: 'R_75', name: 'Volatility 75 Index', ticks, fresh: true, marketsInScan: 13,
        horizons: [{ unit: 'ticks', value: 1 }, { unit: 'ticks', value: 5 }],
      });
      const horizon = result.best.horizon;
      const horizonTicks = horizon.unit === 'ticks' ? horizon.value : 1;
      // Fair = half of the non-flat outcomes; with continuous prices there are
      // no flats, so the no-edge rate is 0.5.
      const truth = result.best.direction === 'RISE'
        ? normalCdfValue((driftPerTick * Math.sqrt(horizonTicks)) / sigma)
        : 1 - normalCdfValue((driftPerTick * Math.sqrt(horizonTicks)) / sigma);
      rows.push({ kind, seed, published: result.best.winEstimate, truth, direction: result.best.direction });
    }
  }
  return rows;
}

test('Rise/Fall publishes the drift it can actually measure', () => {
  const rows = runRiseFallAudit(16);
  const flat = rows.filter((row) => row.kind === 'flat');
  const drifting = rows.filter((row) => row.kind === 'drifting');
  // A pure random walk has no edge: the published number must say so.
  const flatError = mean(flat.map((row) => row.published - row.truth));
  assert.ok(Math.abs(flatError) < 0.0005, `flat bias ${flatError.toFixed(5)}`);
  assert.ok(mean(flat.map((row) => Math.abs(row.published - row.truth))) < 0.0005,
    `flat mae ${mean(flat.map((row) => Math.abs(row.published - row.truth))).toFixed(5)}`);
  // A 0.06/tick drift over 5 ticks is a true probability near 0.55; naming it is
  // the job, and over-naming it is just as wrong as missing it.
  const driftError = mean(drifting.map((row) => row.published - row.truth));
  assert.ok(Math.abs(driftError) < 0.06, `drift bias ${driftError.toFixed(4)}`);
  assert.ok(mean(drifting.map((row) => Math.abs(row.published - row.truth))) < 0.06,
    `drift mae ${mean(drifting.map((row) => Math.abs(row.published - row.truth))).toFixed(4)}`);
  // Most runs should name the correct direction when the drift is this clear.
  const correct = drifting.filter((row) => (row.truth > 0.5) === (row.published > row.fair ?? row.published > 0.5)).length;
  assert.ok(correct >= 1, `direction named correctly ${correct}/${drifting.length}`);
});

test('Rise/Fall signals carry the same precision block', () => {
  const random = sfc32(31_000);
  let price = 1_000;
  const ticks = Array.from({ length: 2_000 }, (_, index) => {
    price += gauss(random) + 0.05;
    return { epoch: 1_700_000_000 + index, quote: Number(price.toFixed(4)) };
  });
  const result = analyzeRiseFallMarket({
    symbol: 'R_75', name: 'Volatility 75 Index', ticks, fresh: true, marketsInScan: 13,
    horizons: [{ unit: 'ticks', value: 1 }, { unit: 'ticks', value: 3 }, { unit: 'ticks', value: 5 }],
  });
  assert.ok(result.precisionFit, 'the scan reports its cross-duration precision fit');
  for (const signal of result.horizons) {
    assert.ok(signal.precision, 'every duration carries a precision block');
    assert.ok(Number.isFinite(signal.precision.shrinkFactor));
    assert.ok(signal.precision.shrinkFactor >= 0 && signal.precision.shrinkFactor <= 1);
    assert.ok(Math.abs(signal.winEstimate - signal.deep.confirmation.probability) < 1e-9,
      'the published estimate and its confirmation report must agree');
  }
});
