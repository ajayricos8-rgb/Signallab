/**
 * Vision Lab — the AI engine behind the AI blocks.
 *
 * The engine answers one question: *what is the chance the last digit at expiry
 * lands on each of the ten digits?* Everything else (barrier choice, direction,
 * stake, whether to trade at all) is derived from that distribution.
 *
 * It is an ensemble of eight experts, each producing a full digit distribution:
 *
 *   uniform    — the fair 10% anchor (a synthetic index is, to a first
 *                approximation, a random walk)
 *   frequency  — the long-run digit histogram of the series
 *   recent     — the short-window histogram (picks up digit drift)
 *   transition — the Markov row P(digit at t+h | digit now)
 *   analog     — kernel replay: how did digits at t+h behave after states that
 *                looked like this one (drift, stretch, volatility, digit)?
 *   momentum   — the analytical price forecast: N(q_t + drift·h, σ√h) mapped
 *                onto the last digit with an exact Fourier series. When the
 *                market moves far more than one digit-step per horizon this
 *                collapses to uniform, which is the honest answer.
 *   neural     — a ten-class softmax regression over the same features, trained
 *                online from the contracts the bot actually traded.
 *   regime     — a regime-switching forecast: the same price-to-digit mapping as
 *                momentum, but the drift is whatever the current regime implies.
 *                In a quiet, stretched tape it pulls the quote back toward its
 *                long mean; in an expanding tape it stops extrapolating
 *                altogether and widens the band instead, because a drift
 *                measured in a burst is the least trustworthy number in the
 *                series.
 *
 * Experts are combined with multiplicative weights driven by each expert's own
 * measured Brier loss, so the mix adapts to the market instead of being fixed.
 * Every estimate is shrunk toward uniform by its effective sample size, and the
 * trade decision subtracts the payout margin before it fires: the engine is
 * built to say *no* far more often than it says yes.
 *
 * On top of the mixture sits a second, empirical layer: the rule grades every
 * decision it publishes against the tick that settled it. Once enough of those
 * decisions are on the record, the estimate is pulled toward the fair anchor by
 * how the bot has actually done against the payout it was paid — an earned
 * record sharpens the estimate, a losing one shrinks it instead of parking the
 * bot. The factor is published as `calibration` and on the plan, so the entry
 * line can show what the record is doing to the numbers.
 */

import {
    autocorrelation,
    clamp,
    digitCounts,
    digitEntropy,
    digitFrequencies,
    evenShare,
    hurst,
    inferPipSize,
    kellyFraction,
    lastDigits,
    mean,
    returns,
    stdDev,
    sum,
    toNumbers,
} from './vision-math.mjs';
import { isAllowedBarrier } from './vision-entry.mjs';

export const MODEL_NAMES = ['uniform', 'frequency', 'recent', 'transition', 'analog', 'momentum', 'neural', 'regime'];

/**
 * The experts that actually measure the market, as opposed to the two
 * structural anchors (`uniform` and `momentum`). Significance is judged on
 * these alone: the anchors are deliberately blind to digit bias, so counting
 * their sample size would make every lean look overwhelmingly significant.
 */
const MEASURED_MODELS = ['frequency', 'recent', 'transition', 'analog', 'neural', 'regime'];

const NEURAL_FEATURE_COUNT = 6;
const PRIOR_STRENGTH = 320; // how many pseudo-ticks of uniform each estimate is shrunk by
const MIN_TICKS = 60;

/** Graded decisions needed before the own-record calibration is trusted. */
const CALIBRATION_SAMPLES = 20;

export const defaultBrain = () => ({
    version: 1,
    experts: MODEL_NAMES.reduce((acc, name) => {
        acc[name] = { weight: name === 'uniform' ? 0.25 : 0.125, loss: 0, count: 0, brier: 0.25 };
        return acc;
    }, {}),
    neural: { weights: Array.from({ length: 10 }, () => new Array(NEURAL_FEATURE_COUNT).fill(0)), updates: 0, lr: 0.06 },
    trained: 0,
    wins: 0,
    losses: 0,
    lastOutcomeAt: 0,
});

const cloneBrain = brain => ({
    ...defaultBrain(),
    ...(brain || {}),
    experts: { ...defaultBrain().experts, ...(brain?.experts || {}) },
    neural: {
        ...defaultBrain().neural,
        ...(brain?.neural || {}),
        weights: (brain?.neural?.weights || defaultBrain().neural.weights).map(row => row.slice()),
    },
});

/** Drop-in guard: nothing in the engine may ever throw into the interpreter. */
const safe = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

const uniformDistribution = () => new Array(10).fill(0.1);

const normalise = values => {
    const total = sum(values);
    if (!(total > 0)) return uniformDistribution();
    return values.map(value => value / total);
};

/** Shrink an empirical distribution toward uniform by its effective sample size. */
const shrink = (distribution, effective, prior = PRIOR_STRENGTH) => {
    const weight = Math.max(0, safe(effective)) / (Math.max(0, safe(effective)) + prior);
    return distribution.map(value => weight * value + (1 - weight) * 0.1);
};

/* ------------------------------------------------------------------ *
 * Features
 * ------------------------------------------------------------------ */

/**
 * Rolling standardised description of every point in the series.
 * O(n): means and standard deviations come from prefix sums.
 */
export function buildFeatureSpace(values, window = 40, longWindow = 240) {
    const list = toNumbers(values);
    const n = list.length;
    const w = Math.max(5, Math.floor(window) || 40);
    const lw = Math.max(w + 5, Math.floor(longWindow) || 240);

    const prefix = new Float64Array(n + 1);
    const prefixSq = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
        prefix[i + 1] = prefix[i] + list[i];
        prefixSq[i + 1] = prefixSq[i] + list[i] * list[i];
    }

    const rolling = (i, size) => {
        const start = Math.max(0, i + 1 - size);
        const count = i + 1 - start;
        if (count <= 0) return { mean: list[i] || 0, std: 0 };
        const m = (prefix[i + 1] - prefix[start]) / count;
        const variance = Math.max((prefixSq[i + 1] - prefixSq[start]) / count - m * m, 0);
        return { mean: m, std: Math.sqrt(variance) };
    };

    const features = new Array(n);
    for (let i = 0; i < n; i++) {
        const short = rolling(i, w);
        const long = rolling(i, lw);
        const past = list[Math.max(0, i - w)];
        const driftSigma = short.std * Math.sqrt(w);
        features[i] = {
            displacement: short.std > 1e-12 ? (list[i] - short.mean) / short.std : 0,
            drift: driftSigma > 1e-12 ? (list[i] - past) / driftSigma : 0,
            volRatio: long.std > 1e-12 ? short.std / long.std : 1,
        };
    }
    return { list, features, window: w, longWindow: lw, pipSize: inferPipSize(list) };
}

/** Standardise a feature matrix column-wise so distances are comparable. */
function standardise(rows) {
    const n = rows.length;
    if (!n) return { rows, scales: [1, 1, 1, 1, 1], means: [0, 0, 0, 0, 0] };
    const dims = rows[0].length;
    const means = new Array(dims).fill(0);
    const stds = new Array(dims).fill(0);
    for (let d = 0; d < dims; d++) {
        const column = rows.map(row => row[d]);
        means[d] = mean(column);
        stds[d] = stdDev(column) || 1;
    }
    const scaled = rows.map(row => row.map((value, d) => (value - means[d]) / stds[d]));
    return { rows: scaled, scales: stds, means };
}

/**
 * The five-dimension state vector used by the analog and neural experts.
 * Digit terms are folded in from the digit series, not the quote series.
 */
export function featureVector(space, digits, index) {
    const f = space.features[index] || { displacement: 0, drift: 0, volRatio: 1 };
    const from = Math.max(0, index - 60);
    const slice = digits.slice(from, index + 1);
    const digitNow = digits[index] ?? 0;
    const parity = (evenShare(slice) - 50) / 50;
    return [f.displacement, f.drift, f.volRatio, (digitNow - 4.5) / 4.5, parity];
}

/* ------------------------------------------------------------------ *
 * Experts
 * ------------------------------------------------------------------ */

/** Analytical distribution of the last digit after `horizon` ticks. */
export function momentumDistribution(values, horizon, pipSize = null) {
    const list = toNumbers(values);
    if (list.length < 10) return uniformDistribution();
    const decimals = pipSize != null ? clamp(Math.round(pipSize), 0, 8) : inferPipSize(list);
    const unit = 10 ** -decimals;

    const changes = returns(list);
    const sample = changes.slice(-Math.min(changes.length, 200));
    const driftPerTick = mean(sample);
    const sigmaPerTick = stdDev(sample) || unit;
    const h = Math.max(1, horizon);
    const mu = list[list.length - 1] + driftPerTick * h;
    const sigma = sigmaPerTick * Math.sqrt(h);

    return digitDistributionFromPrice(mu / unit, sigma / unit);
}

/**
 * Exact digit distribution of a price quoted on a grid of `unit`, given the mean
 * (`muY`) and standard deviation (`sigmaY`) of the landing quote measured in
 * units. A Fourier series of the wrapped normal: the first three harmonics are
 * enough for every band a tick series can produce, and the decay term is what
 * collapses the answer to uniform when the horizon moves several units.
 */
export function digitDistributionFromPrice(muY, sigmaY) {
    const mu = safe(muY, 0);
    const sigma = Math.max(0, safe(sigmaY, 1e6));
    const distribution = new Array(10);
    for (let d = 0; d < 10; d++) {
        let p = 0.1;
        for (let m = 1; m <= 3; m++) {
            const decay = Math.exp((-2 * Math.PI * Math.PI * m * m * sigma * sigma) / 100);
            if (decay < 1e-9) break;
            const coefficient = (Math.sin((Math.PI * m) / 10) / (Math.PI * m)) * 2;
            p += coefficient * Math.cos((2 * Math.PI * m * (mu - d - 0.5)) / 10) * decay;
        }
        distribution[d] = clamp(p, 0, 1);
    }
    const total = sum(distribution);
    return total > 0 ? distribution.map(value => value / total) : uniformDistribution();
}

/**
 * Read the tape's current regime, scale-free, from the feature space and the
 * quote history. Three states, because that is what the two statistics actually
 * separate:
 *
 *   expansion — short-run volatility is running well above its long-run level,
 *               so a drift measured over the last few hundred ticks is the least
 *               reliable number in the series;
 *   reversion — the tape is quiet and the quote is stretched away from its long
 *               mean, which is the state in which a pull back is measurable;
 *   balanced  — neither, and the honest forecast is the neutral one.
 */
export function readRegime(space) {
    const features = space?.features || [];
    const last = features[features.length - 1] || { displacement: 0, drift: 0, volRatio: 1 };
    const expansion = safe(last.volRatio, 1);
    const stretch = safe(last.displacement, 0);
    const slope = safe(last.drift, 0);
    const state =
        expansion > 1.25
            ? 'expansion'
            : expansion < 0.92 && Math.abs(stretch) > 0.75
              ? 'reversion'
              : 'balanced';
    // How much of a claim the read has. Each statistic is scored against a bar
    // it has to clear before it counts at all, so a random walk's ordinary
    // one-sigma wobble does not read as a regime: -15 % volatility, 0.5 sigma of
    // stretch and 1 sigma of slope are the neutral zone, and the score ramps to 1
    // at -75 %, 2 sigma and 3.5 sigma respectively.
    const burst = clamp((Math.abs(expansion - 1) - 0.15) / 0.6, 0, 1);
    const pinned = clamp((Math.abs(stretch) - 0.5) / 1.5, 0, 1);
    const trend = clamp((Math.abs(slope) - 1) / 2.5, 0, 1);
    const conviction =
        state === 'expansion'
            ? Math.max(burst, 0.5 * pinned)
            : state === 'reversion'
              ? Math.max(pinned, 0.4 * trend)
              : Math.max(0.2 * burst, 0.2 * pinned, 0.15 * trend);
    return { state, expansion, stretch, slope, conviction: clamp(conviction, 0, 1) };
}

/**
 * The regime expert: the same price-to-digit mapping as momentum, driven by what
 * the regime says about the *next* `horizon` ticks rather than by the sample
 * mean of the last few hundred.
 *
 *   reversion — the quote is pulled back toward its long mean, recovering a
 *               fraction of its stretch over the horizon;
 *   expansion — no extrapolation at all (the mean is the current quote) and a
 *               widened band, because a burst says nothing about direction but
 *               a great deal about dispersion;
 *   balanced  — half of the measured drift, which is the shrinkage a fair market
 *               deserves.
 *
 * It is a genuinely different model from momentum, not a relabel: momentum
 * extrapolates a mean, this one reverses a stretch, and the two disagree
 * exactly when it matters.
 */
export function regimeDistribution(values, horizon, pipSize = null, space = null) {
    const list = toNumbers(values);
    if (list.length < MIN_TICKS) return { distribution: uniformDistribution(), effective: 0, regime: 'balanced' };
    const decimals = pipSize != null ? clamp(Math.round(pipSize), 0, 8) : inferPipSize(list);
    const unit = 10 ** -decimals;
    const spaceRead = space || buildFeatureSpace(list);
    const regime = readRegime(spaceRead);
    const h = Math.max(1, Math.floor(horizon) || 1);

    const changes = returns(list);
    const sample = changes.slice(-Math.min(changes.length, 220));
    const driftPerTick = mean(sample);
    const sigmaPerTick = stdDev(sample) || unit;
    const last = list[list.length - 1];

    const longWindow = Math.min(list.length, 480);
    const longMean = mean(list.slice(-longWindow));
    const longStd = stdDev(list.slice(-longWindow)) || unit;

    let mu = last;
    let sigma = sigmaPerTick * Math.sqrt(h);
    if (regime.state === 'reversion') {
        // Recover a share of the stretch, scaled by how quiet the tape is: a
        // dead tape mean-reverts further within the same horizon than a busy one.
        const recovery = clamp(0.45 * (1 - Math.min(regime.expansion, 1)), 0.05, 0.45);
        mu = last + (longMean - last) * recovery;
        sigma *= 0.9;
    } else if (regime.state === 'expansion') {
        mu = last;
        sigma *= 1.25;
    } else {
        mu = last + driftPerTick * h * 0.5;
    }

    // A regime read that is barely off neutral has no business claiming much;
    // the effective sample is what the blend shrinks this expert by.
    const effective = clamp((list.length / 4) * (0.2 + 0.8 * regime.conviction), 0, 400);
    return {
        distribution: digitDistributionFromPrice(mu / unit, sigma / unit),
        effective,
        regime: regime.state,
        conviction: regime.conviction,
    };
}

/**
 * Kernel replay: look at every historical state, weight it by how similar it is
 * to now (and by how recent it is), then read off the digit that followed.
 */
export function analogDistribution(values, horizon, options = {}) {
    const window = options.window || 40;
    const bandwidth = options.bandwidth || 1.15;
    const recency = options.recency || 420;
    const space = buildFeatureSpace(values, window);
    const digits = lastDigits(values, space.pipSize);
    const h = Math.max(1, Math.floor(horizon) || 1);
    const n = digits.length;
    if (n < MIN_TICKS + h + 5) return { distribution: uniformDistribution(), effective: 0 };

    const rows = [];
    for (let i = window; i + h < n; i++) rows.push(featureVector(space, digits, i));
    const { rows: scaled, means, scales } = standardise(rows);
    // The current state must be scaled with the SAME column statistics as
    // the history. Standardising it on its own subtracted its own mean,
    // which zeroed the vector: every distance was then measured to the
    // *average* historical state instead of to now, and the "analog"
    // expert was replaying near-average states whatever the market was
    // actually doing.
    const current = featureVector(space, digits, n - 1).map((value, d) => (value - means[d]) / scales[d]);
    const dims = current.length;

    const counts = new Array(10).fill(0);
    let totalWeight = 0;
    for (let r = 0; r < scaled.length; r++) {
        const index = window + r;
        let distanceSq = 0;
        for (let d = 0; d < dims; d++) {
            const diff = scaled[r][d] - current[d];
            distanceSq += diff * diff;
        }
        const age = n - 1 - index;
        const weight = Math.exp(-distanceSq / (2 * bandwidth * bandwidth)) * Math.exp(-age / recency);
        if (weight < 1e-4) continue;
        counts[digits[index + h]] += weight;
        totalWeight += weight;
    }
    if (totalWeight <= 1e-6) return { distribution: uniformDistribution(), effective: 0 };
    const distribution = counts.map(value => value / totalWeight);
    return { distribution, effective: totalWeight };
}

/** Ten-class softmax regression over the state vector. */
export function neuralDistribution(brain, feature) {
    const weights = brain?.neural?.weights;
    if (!weights || weights.length !== 10) return { distribution: uniformDistribution(), effective: 0 };
    const input = feature.slice(0, NEURAL_FEATURE_COUNT - 1);
    input.push(1); // bias
    const scores = weights.map(row => {
        let acc = 0;
        for (let i = 0; i < input.length; i++) acc += row[i] * input[i];
        return acc;
    });
    const max = Math.max(...scores);
    const exps = scores.map(score => Math.exp(score - max));
    const total = sum(exps);
    if (!(total > 0)) return { distribution: uniformDistribution(), effective: 0 };
    // A freshly trained net carries no information; its weight grows with data.
    return { distribution: exps.map(value => value / total), effective: safe(brain?.neural?.updates) * 0.5 };
}

/** P(digit at t+h | digit now) — the Markov row, shrunk toward uniform. */
export function transitionDistribution(digits, horizon) {
    const h = Math.max(1, Math.floor(horizon) || 1);
    const n = digits.length;
    if (n < 80 + h) return { distribution: uniformDistribution(), effective: 0 };
    const matrix = Array.from({ length: 10 }, () => new Array(10).fill(0));
    for (let i = 0; i + h < n; i++) matrix[digits[i]][digits[i + h]] += 1;
    const row = matrix[digits[n - 1]] || new Array(10).fill(0);
    const total = sum(row);
    if (!total) return { distribution: uniformDistribution(), effective: 0 };
    const distribution = row.map(value => value / total);
    return { distribution, effective: Math.min(total, 400) }; // rows of a 10-bin table are thin data
}

/* ------------------------------------------------------------------ *
 * The ensemble
 * ------------------------------------------------------------------ */

/**
 * Forecast the digit distribution `horizon` ticks from now.
 * Returns the blended distribution, every expert's own view, the weights that
 * were used, and a 0-100 confidence score.
 */
export function forecastDigits(values, options = {}) {
    const horizon = Math.max(1, Math.floor(options.horizon || 5));
    const brain = cloneBrain(options.brain);
    const space = buildFeatureSpace(values, options.window || 40);
    const digits = lastDigits(values, space.pipSize);
    const shortWindow = Math.min(digits.length, Math.max(60, horizon * 60));

    const longCounts = digitCounts(values, space.pipSize);
    const longTotal = sum(longCounts) || 1;
    const shortCounts = digitCounts(values.slice(-shortWindow), space.pipSize);
    const shortTotal = sum(shortCounts) || 1;

    const transition = transitionDistribution(digits, horizon);
    const analog = analogDistribution(values, horizon, { window: options.window || 40 });
    const neural = neuralDistribution(brain, featureVector(space, digits, digits.length - 1));
    const regime = regimeDistribution(values, horizon, space.pipSize, space);

    const raw = {
        uniform: { distribution: uniformDistribution(), effective: 1e6 },
        frequency: {
            distribution: longCounts.map(count => count / longTotal),
            effective: longTotal / 2,
        },
        recent: {
            distribution: shortCounts.map(count => count / shortTotal),
            effective: shortTotal / 2,
        },
        transition: { distribution: transition.distribution, effective: transition.effective },
        analog: { distribution: analog.distribution, effective: analog.effective },
        momentum: { distribution: momentumDistribution(values, horizon, space.pipSize), effective: 400 },
        neural: { distribution: neural.distribution, effective: neural.effective },
        regime: { distribution: regime.distribution, effective: regime.effective },
    };

    const experts = {};
    let weightTotal = 0;
    MODEL_NAMES.forEach(name => {
        const entry = raw[name] || { distribution: uniformDistribution(), effective: 0 };
        const meta = brain.experts[name] || { weight: 0.125 };
        const weight = Math.max(meta.weight, 0.02);
        weightTotal += weight;
        experts[name] = {
            distribution: shrink(normalise(entry.distribution), entry.effective),
            raw: normalise(entry.distribution),
            weight,
            effective: safe(entry.effective),
            brier: safe(meta.brier, 0.25),
        };
    });

    const distribution = new Array(10).fill(0);
    MODEL_NAMES.forEach(name => {
        const expert = experts[name];
        const share = weightTotal > 0 ? expert.weight / weightTotal : 1 / MODEL_NAMES.length;
        expert.share = share;
        for (let d = 0; d < 10; d++) distribution[d] += share * expert.distribution[d];
    });
    const blended = normalise(distribution);

    // Data quality: how much evidence sits behind the blend, and whether the
    // ensemble has beaten the fair-odds anchor on this market before. Model
    // agreement is judged per candidate in planTrade, where a direction exists.
    const dataQuality = clamp(
        sum(MEASURED_MODELS.map(name => (experts[name].share || 0) * experts[name].effective)) / 400,
        0,
        1
    );
    const skill = clamp((0.25 - (brain.experts?.analog?.brier ?? 0.25)) * 8, 0, 1);
    const confidence = clamp(100 * (0.6 * dataQuality + 0.4 * skill), 0, 100);

    return {
        distribution: blended,
        experts,
        regime: regime.regime,
        regimeConviction: regime.conviction,
        confidence,
        dataQuality,
        digits,
        pipSize: space.pipSize,
        features: featureVector(space, digits, digits.length - 1),
        horizon,
        entropy: digitEntropy(values, space.pipSize),
        acf: autocorrelation(values, 1),
        hurst: hurst(values),
    };
}

/**
 * How much the rule's own graded record should move the estimate.
 *
 * `hits`/`graded` are the decisions this rule published that have since been
 * settled — a shadow sample scores the forecast but never counts here, because
 * it was never paid. `breakEven` is the probability the payout on the contract
 * being priced demands. The factor is 1 with no record: nothing measured, no
 * change. A record at or above break-even sharpens the estimate (up to +25 %),
 * a record below it pulls the estimate back toward the anchor, floored at 0.35
 * so a losing streak shrinks the bot instead of parking it.
 */
export function recordCalibration(hits, graded, breakEven) {
    const samples = safe(graded, 0);
    if (samples < CALIBRATION_SAMPLES || !(safe(breakEven, 0) > 0)) {
        return { factor: 1, hitRate: samples > 0 ? clamp(safe(hits, 0) / samples, 0, 1) : null, samples, earned: null };
    }
    const rate = clamp(safe(hits, 0) / samples, 0, 1);
    const ratio = rate / breakEven;
    const factor = ratio >= 1 ? 1 + Math.min(0.25, (ratio - 1) * 0.5) : clamp(ratio, 0.35, 1);
    return { factor, hitRate: rate, samples, earned: ratio >= 1 };
}

export const probabilityOver = (distribution, barrier) => {
    let p = 0;
    for (let d = Math.max(0, Math.floor(barrier) + 1); d <= 9; d++) p += distribution[d] || 0;
    return p;
};

export const probabilityUnder = (distribution, barrier) => {
    let p = 0;
    for (let d = 0; d <= Math.min(9, Math.floor(barrier) - 1); d++) p += distribution[d] || 0;
    return p;
};

/* ------------------------------------------------------------------ *
 * Payouts
 * ------------------------------------------------------------------ */

/** Winning digits for a contract: Over b → b+1..9, Under b → 0..b-1. */
export const winningDigitCount = (direction, barrier) => {
    const b = clamp(Math.round(barrier), 0, 9);
    return direction === 'under' ? b : 9 - b;
};

/**
 * Fallback payout multiple when the API has not answered yet.
 *
 * Deriv does not price every barrier at the same margin: the near-certain
 * contracts trade close to fair odds, the long shots carry a heavy margin. The
 * ladder below is a deliberately conservative reading of that curve (the live
 * table replaces it as soon as the API answers), and it errs *downwards* so the
 * engine never mistakes the fallback for an opportunity.
 */
const PAYOUT_BY_WINNING_DIGITS = [0, 6.4, 3.45, 2.4, 1.8, 1.5, 1.32, 1.2, 1.1, 1.03];

export const fallbackPayout = (direction, barrier) => {
    const count = winningDigitCount(direction, barrier);
    if (count <= 0) return 0;
    return PAYOUT_BY_WINNING_DIGITS[count] ?? (10 / count) * 0.97;
};

/* ------------------------------------------------------------------ *
 * The trade plan
 * ------------------------------------------------------------------ */

/**
 * Turn a forecast into a trade: pick the barrier and direction with the best
 * expected value after the payout margin, size it, and decide whether to fire.
 */
export function planTrade(values, options = {}) {
    const horizon = Math.max(1, Math.floor(options.horizon || 5));
    const minConfidence = safe(options.minConfidence, 55);
    const riskFactor = clamp(safe(options.risk, 0.35), 0, 1);
    const payoutTable = options.payouts || null;
    const minLean = safe(options.minLean, 1.5);
    const rawMinEdge = safe(options.minEdge, -100);
    // A min edge at or below the sentinel means "do not gate on expected value",
    // which is the honest default: the exchange margin on digit contracts is
    // larger than any bias that can be measured, so a strict positive-EV gate
    // would leave the bot waiting forever. Set it to 0 or above to insist on a
    // trade that beats the margin before it fires.
    const strictValue = rawMinEdge > -50;
    const forecast = forecastDigits(values, { horizon, brain: options.brain, window: options.window });
    const { distribution } = forecast;

    // The un-shrunk blend of the measuring experts only: what they measured
    // before the conservative pull toward uniform. Significance is judged on
    // this; the size and the expected value come from the shrunk numbers.
    const measuredWeight = sum(MEASURED_MODELS.map(name => forecast.experts[name].share || 0)) || 1;
    const rawBlend = normalise(
        MEASURED_MODELS.reduce(
            (acc, name) => {
                const expert = forecast.experts[name];
                for (let d = 0; d < 10; d++) acc[d] += ((expert.share || 0) / measuredWeight) * expert.raw[d];
                return acc;
            },
            new Array(10).fill(0)
        )
    );
    const effectiveSample = Math.min(
        1500,
        sum(MEASURED_MODELS.map(name => ((forecast.experts[name].share || 0) / measuredWeight) * forecast.experts[name].effective))
    );

    const candidates = [];
    for (let barrier = 0; barrier <= 9; barrier++) {
        ['over', 'under'].forEach(direction => {
            // Only barriers the bot is allowed to trade are ever priced:
            // Over 1–6, Under 4–8 (see vision-entry). The near-certain
            // extremes pay almost nothing, so they are not candidates no
            // matter how strong the lean behind them is.
            if (!isAllowedBarrier(direction, barrier)) return;
            const count = winningDigitCount(direction, barrier);
            if (count <= 0) return;
            const fair = count / 10;
            const probability = direction === 'over' ? probabilityOver(distribution, barrier) : probabilityUnder(distribution, barrier);
            const rawProbability = direction === 'over' ? probabilityOver(rawBlend, barrier) : probabilityUnder(rawBlend, barrier);
            const payout = payoutTable?.get?.(direction, barrier) ?? fallbackPayout(direction, barrier);
            if (!(payout > 0)) return;
            const edge = probability * payout - 1;
            // Only count the part of the edge that survives a confidence haircut.
            const adjusted = edge - (1 - (forecast.dataQuality ?? 0)) * 0.06;
            const bias = probability - fair;
            const rawBias = rawProbability - fair;
            // Standard error of the measured lean, and the t-statistic that
            // says whether the lean is bigger than the noise that produced it.
            const variance = Math.max(rawProbability * (1 - rawProbability), 1e-6);
            const standardError = Math.sqrt(variance / Math.max(effectiveSample, 1));
            candidates.push({
                barrier,
                direction,
                probability,
                rawProbability,
                fair,
                payout,
                edge,
                adjusted,
                bias,
                rawBias,
                biasPoints: bias * 100,
                rawBiasPoints: rawBias * 100,
                tStat: clamp(rawBias / standardError, -8, 8),
                kelly: kellyFraction(probability, payout),
                contract: direction === 'over' ? 'DIGITOVER' : 'DIGITUNDER',
            });
        });
    }

    /**
     * Own-record calibration, per candidate: the break-even is 1/payout, which
     * differs by barrier, so the same record means different things on a 1.5x
     * contract and a 3.4x one. The measured lean (`rawBias`, `tStat`) is left
     * alone — significance is a property of the data, not of the record — while
     * the probability used for the expected value, the size and the sign test is
     * pulled toward the fair anchor when the record is behind break-even.
     */
    const graded = safe(options.brain?.wins) + safe(options.brain?.losses);
    const hits = safe(options.brain?.wins);
    let calibrationFactor = 1;
    let hitRate = null;
    candidates.forEach(candidate => {
        const record = recordCalibration(hits, graded, candidate.payout > 0 ? 1 / candidate.payout : 0);
        candidate.calibration = record.factor;
        candidate.hitRate = record.hitRate;
        candidate.recordEarned = record.earned;
        candidate.probability = clamp(candidate.fair + (candidate.probability - candidate.fair) * record.factor, 0, 1);
        candidate.edge = candidate.probability * candidate.payout - 1;
        candidate.adjusted = candidate.edge - (1 - (forecast.dataQuality ?? 0)) * 0.06;
        candidate.bias = candidate.probability - candidate.fair;
        candidate.biasPoints = candidate.bias * 100;
        candidate.kelly = kellyFraction(candidate.probability, candidate.payout);
    });
    calibrationFactor = candidates.length ? candidates.reduce((acc, c) => acc + c.calibration, 0) / candidates.length : 1;
    hitRate = candidates.length ? candidates[0].hitRate : null;

    const minAgreement = options.minAgreement ?? 0.7;
    const skill = clamp((0.25 - (options.brain?.experts?.analog?.brier ?? 0.25)) * 8, 0, 1);

    /**
     * Per-candidate quality: how many experts lean the same way on this exact
     * barrier (the structural anchors — fair odds and price momentum — are
     * expected to sit on the fence, so they are counted but can never carry the
     * vote alone), and the confidence that follows from that agreement, the
     * evidence behind the blend and the ensemble's measured skill.
     */
    const scoreCandidate = candidate => {
        let agreeing = 0;
        let voting = 0;
        Object.entries(forecast.experts).forEach(([name, expert]) => {
            if (name === 'uniform' || expert.share < 0.04) return;
            voting += 1;
            const p =
                candidate.direction === 'over'
                    ? probabilityOver(expert.raw, candidate.barrier)
                    : probabilityUnder(expert.raw, candidate.barrier);
            if (Math.sign(p - candidate.fair) === Math.sign(candidate.rawBias)) agreeing += 1;
        });
        const agreementRatio = voting ? agreeing / voting : 0;
        const confidence = clamp(100 * (0.45 * agreementRatio + 0.35 * (forecast.dataQuality ?? 0) + 0.2 * skill), 0, 100);
        return { agreementRatio, confidence };
    };

    /**
     * A min lean at or below zero means "no significance bar": take the
     * strongest lean the data can offer, however thin, rather than sit out.
     * Nothing stops being measured — the lean, its sigma, the payout and the
     * true expected value are all still published — only the gate moves. That
     * is the difference between a bot that trades the noise and one that waits
     * for a signal no fair market will ever give it.
     */
    const relaxed = minLean <= 0;

    candidates.forEach(candidate => {
        const { agreementRatio, confidence } = scoreCandidate(candidate);
        candidate.agreementRatio = agreementRatio;
        candidate.confidence = confidence;
        candidate.passes =
            candidate.bias > 0 &&
            (relaxed ||
                (candidate.rawBias > 0 &&
                    candidate.tStat >= minLean &&
                    confidence >= minConfidence &&
                    agreementRatio >= minAgreement)) &&
            (!strictValue || candidate.adjusted >= rawMinEdge / 100);
    });

    // Two-stage choice. Significance and agreement first: a lean the data — or
    // the other models — cannot support is not a signal. Then, among the
    // candidates that clear every bar, take the best expected value, which in
    // practice means the low-margin barriers (over 0-2, under 8-9) rather than
    // the long shots the broker taxes hardest.
    candidates.sort((a, b) => b.tStat - a.tStat);
    const eligible = candidates.filter(candidate => candidate.passes);
    // When nothing clears the bars, fall back to the strongest lean rather than
    // the largest deviation, which is just as often the largest shortfall. A
    // relaxed strategy needs a barrier it can actually buy.
    const fallback = candidates.length ? candidates.reduce((a, b) => (b.bias > a.bias ? b : a)) : null;

    /**
     * A relaxed strategy must always have a contract to buy.
     *
     * With the significance and value bars both off the user asked for one
     * thing: open a position on the best thing the AI can see, every time it
     * looks. On a fair synthetic index most ticks have no candidate above the
     * fair odds — the digit distribution shrinks toward uniform and the payout
     * margin wins — so a plan that only fires on a positive lean spends most of
     * its life returning `go: false` with a perfectly good contract sitting in
     * `best`. That is what made the bot look dead: the analysis ran, chose a
     * barrier, and then refused to buy it.
     *
     * So when the bars are off and nothing passes, we still trade: the
     * candidate with the best expected value (in practice the widest, lowest
     * margin contract) becomes the entry, and the plan says plainly that it was
     * forced rather than measured. Turning either bar on turns the forcing off,
     * so an explicit floor is never overridden.
     */
    const forceEntry = options.forceEntry !== false;
    const forced = Boolean(forceEntry && relaxed && !strictValue && !eligible.length && candidates.length);
    const best = eligible.length
        ? eligible.reduce((a, b) => (b.adjusted > a.adjusted ? b : a))
        : forced
          ? candidates.reduce((a, b) => (b.adjusted > a.adjusted ? b : a))
          : fallback;

    const agreementRatio = best?.agreementRatio ?? 0;
    const decisionConfidence = best?.confidence ?? 0;
    const stable = !options.previous || options.previous.direction !== best?.direction || options.previous.barrier === best?.barrier;
    const go = Boolean(best) && (Boolean(best.passes) || forced);

    // Stake sizing: how far past the significance bar this lean is, times the
    // confidence, times how much risk the strategy is willing to take. (Kelly is
    // published as information but is unusably small on a long-shot payout.)
    // The 1.0 floor keeps sizing meaningful with the bar off: a 1σ lean is a
    // full stake, a 0.3σ lean is a third of one.
    //
    // A forced entry has no lean to scale by — its t-statistic is negative by
    // definition — so scaling it by conviction would hand back a zero stake,
    // and a zero stake is not a trade. It gets a floor instead: the smallest
    // sensible fraction of the base stake, which the strategy's own safe-stake
    // block then lifts to the broker minimum.
    const convRaw = best ? clamp(clamp(best.tStat, 0, 8) / Math.max(minLean * 2.2, 1.0), 0, 1) : 0;
    const conviction = forced ? Math.max(convRaw, 0.35) : convRaw;
    const valueScale = strictValue ? clamp(best ? best.edge / Math.max(0.005, safe(options.targetEdge, 0.04)) : 0, 0, 1) : 1;
    const stakeFactor = best
        ? clamp(conviction * valueScale * (0.55 + 0.45 * (decisionConfidence / 100)) * (0.4 + 0.6 * riskFactor), go ? 0.2 : 0, 1)
        : 0;

    return {
        ...forecast,
        confidence: decisionConfidence,
        candidates,
        best,
        plan: best,
        go,
        forced,
        barrier: best?.barrier ?? -1,
        direction: best?.direction ?? 'wait',
        contract: best?.contract ?? '',
        probability: best?.probability ?? 0,
        probabilityPercent: (best?.probability ?? 0) * 100,
        fair: best?.fair ?? 0,
        payout: best?.payout ?? 0,
        edge: best?.edge ?? 0,
        edgePercent: (best?.edge ?? 0) * 100,
        biasPoints: best?.biasPoints ?? 0,
        stakeFactor,
        agreementRatio,
        calibration: best?.calibration ?? calibrationFactor,
        hitRate,
        hitSamples: graded,
        recordEarned: best?.recordEarned ?? null,
        regime: forecast.regime,
        stable,
        minLean,
        strictValue,
        forceEntry,
        effectiveSample,
        tStat: best?.tStat ?? 0,
        conviction,
        rawBiasPoints: best?.rawBiasPoints ?? 0,
        reason: !best
            ? 'no tradeable barrier'
            : forced
                ? 'no measured lean above the fair odds — trading the safest contract anyway (bars are off)'
                : best.bias <= 0 || best.rawBias <= 0
                    ? 'no measured lean against the fair odds'
                    : best.tStat < minLean
                        ? `lean of ${best.rawBiasPoints.toFixed(2)} points is only ${best.tStat.toFixed(2)}σ, below the ${minLean}σ bar`
                        : decisionConfidence < minConfidence
                            ? `confidence ${decisionConfidence.toFixed(0)} below ${minConfidence}`
                            : agreementRatio < (options.minAgreement ?? 0.7)
                                ? `only ${(agreementRatio * 100).toFixed(0)}% of models agree`
                                : strictValue && best.adjusted < rawMinEdge / 100
                                    ? `edge ${(best.adjusted * 100).toFixed(2)}% below the ${rawMinEdge.toFixed(1)}% floor`
                                    : 'entry confirmed',
        summary: best
            ? `${best.direction.toUpperCase()} ${best.barrier} · p ${(best.probability * 100).toFixed(2)}% · fair ${(best.fair * 100).toFixed(0)}% · lean ${best.rawBiasPoints.toFixed(2)}pt (${best.tStat.toFixed(2)}σ) · payout ${best.payout.toFixed(2)}x · EV ${(best.edge * 100).toFixed(2)}% · conf ${decisionConfidence.toFixed(0)}${forced ? ' · forced' : ''}${graded >= CALIBRATION_SAMPLES ? ` · own record ${((hitRate ?? 0) * 100).toFixed(1)}% of ${graded} · cal ${calibrationFactor.toFixed(2)}` : ''}`
            : 'no candidate',
    };
}

/* ------------------------------------------------------------------ *
 * Learning
 * ------------------------------------------------------------------ */

/**
 * Fold one settled contract back into the brain: score every expert with a
 * Brier loss, move the mixture weights, and take one gradient step on the
 * softmax net.
 */
export function learn(brain, record = {}) {
    const next = cloneBrain(brain);
    const digit = clamp(Math.round(safe(record.digit, -1)), -1, 9);
    if (digit < 0) return next;

    if (Array.isArray(record.expertDistributions)) {
        const eta = 0.35;
        let best = Infinity;
        const losses = {};
        record.expertDistributions.forEach(({ name, distribution }) => {
            let loss = 0;
            for (let d = 0; d < 10; d++) loss += (distribution[d] - (d === digit ? 1 : 0)) ** 2;
            losses[name] = loss;
            if (loss < best) best = loss;
        });
        let total = 0;
        MODEL_NAMES.forEach(name => {
            const meta = next.experts[name];
            const loss = losses[name] ?? best ?? 0.9;
            meta.brier = safe(meta.brier, 0.25) * 0.9 + loss * 0.1;
            meta.loss = safe(meta.loss) * 0.9 + loss * 0.1;
            meta.count = safe(meta.count) + 1;
            const gain = Math.exp(-eta * (loss - best));
            meta.weight = clamp(safe(meta.weight, 0.125) * (0.9 + 0.1 * gain), 0.01, 4);
            total += meta.weight;
        });
        if (total > 0) MODEL_NAMES.forEach(name => (next.experts[name].weight /= total));
    }

    if (Array.isArray(record.features)) {
        const input = record.features.slice(0, NEURAL_FEATURE_COUNT - 1);
        while (input.length < NEURAL_FEATURE_COUNT - 1) input.push(0);
        input.push(1);
        const lr = safe(next.neural.lr, 0.06);
        const weights = next.neural.weights;
        const scores = weights.map(row => {
            let acc = 0;
            for (let i = 0; i < input.length; i++) acc += row[i] * input[i];
            return acc;
        });
        const max = Math.max(...scores);
        const exps = scores.map(score => Math.exp(score - max));
        const total = sum(exps) || 1;
        for (let c = 0; c < 10; c++) {
            const p = exps[c] / total;
            const error = p - (c === digit ? 1 : 0);
            for (let i = 0; i < input.length; i++) weights[c][i] -= lr * error * input[i];
        }
        next.neural.updates = safe(next.neural.updates) + 1;
    }

    next.trained = safe(next.trained) + 1;
    // Shadow samples (forecasts scored against the tick stream itself,
    // with no contract behind them) train the experts and the net exactly
    // like real ones, but they are not trades: counting them would
    // corrupt the win/loss record the session statistics are read from.
    if (!record.shadow) {
        if (record.won) next.wins = safe(next.wins) + 1;
        else next.losses = safe(next.losses) + 1;
    }
    next.lastOutcomeAt = Date.now();
    return next;
}

export default {
    analogDistribution,
    digitDistributionFromPrice,
    readRegime,
    recordCalibration,
    regimeDistribution,
    defaultBrain,
    fallbackPayout,
    featureVector,
    forecastDigits,
    learn,
    momentumDistribution,
    planTrade,
    probabilityOver,
    probabilityUnder,
    winningDigitCount,
};
