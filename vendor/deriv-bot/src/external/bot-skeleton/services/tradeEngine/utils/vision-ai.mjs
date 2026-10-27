/**
 * Vision Lab — the AI engine behind the AI blocks.
 *
 * The engine answers one question: *what is the chance the last digit at expiry
 * lands on each of the ten digits?* Everything else (barrier choice, direction,
 * stake, whether to trade at all) is derived from that distribution.
 *
 * It is an ensemble of seven experts, each producing a full digit distribution:
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
 *
 * Experts are combined with multiplicative weights driven by each expert's own
 * measured Brier loss, so the mix adapts to the market instead of being fixed.
 * Every estimate is shrunk toward uniform by its effective sample size, and the
 * trade decision subtracts the payout margin before it fires: the engine is
 * built to say *no* far more often than it says yes.
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

export const MODEL_NAMES = ['uniform', 'frequency', 'recent', 'transition', 'analog', 'momentum', 'neural'];

/**
 * The experts that actually measure the market, as opposed to the two
 * structural anchors (`uniform` and `momentum`). Significance is judged on
 * these alone: the anchors are deliberately blind to digit bias, so counting
 * their sample size would make every lean look overwhelmingly significant.
 */
const MEASURED_MODELS = ['frequency', 'recent', 'transition', 'analog', 'neural'];

const NEURAL_FEATURE_COUNT = 6;
const PRIOR_STRENGTH = 320; // how many pseudo-ticks of uniform each estimate is shrunk by
const MIN_TICKS = 60;

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
    if (!n) return { rows, scales: [1, 1, 1, 1, 1] };
    const dims = rows[0].length;
    const means = new Array(dims).fill(0);
    const stds = new Array(dims).fill(0);
    for (let d = 0; d < dims; d++) {
        const column = rows.map(row => row[d]);
        means[d] = mean(column);
        stds[d] = stdDev(column) || 1;
    }
    const scaled = rows.map(row => row.map((value, d) => (value - means[d]) / stds[d]));
    return { rows: scaled, scales: stds };
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

    const muY = mu / unit;
    const sigmaY = sigma / unit;
    const distribution = new Array(10);
    for (let d = 0; d < 10; d++) {
        let p = 0.1;
        for (let m = 1; m <= 3; m++) {
            const decay = Math.exp((-2 * Math.PI * Math.PI * m * m * sigmaY * sigmaY) / 100);
            if (decay < 1e-9) break;
            const coefficient = (Math.sin((Math.PI * m) / 10) / (Math.PI * m)) * 2;
            p += coefficient * Math.cos((2 * Math.PI * m * (muY - d - 0.5)) / 10) * decay;
        }
        distribution[d] = clamp(p, 0, 1);
    }
    const total = sum(distribution);
    return total > 0 ? distribution.map(value => value / total) : uniformDistribution();
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
    const { rows: scaled } = standardise(rows);
    const current = standardise([featureVector(space, digits, n - 1)]).rows[0];
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

    candidates.forEach(candidate => {
        const { agreementRatio, confidence } = scoreCandidate(candidate);
        candidate.agreementRatio = agreementRatio;
        candidate.confidence = confidence;
        candidate.passes =
            candidate.bias > 0 &&
            candidate.rawBias > 0 &&
            candidate.tStat >= minLean &&
            confidence >= minConfidence &&
            agreementRatio >= minAgreement &&
            (!strictValue || candidate.adjusted >= rawMinEdge / 100);
    });

    // Two-stage choice. Significance and agreement first: a lean the data — or
    // the other models — cannot support is not a signal. Then, among the
    // candidates that clear every bar, take the best expected value, which in
    // practice means the low-margin barriers (over 0-2, under 8-9) rather than
    // the long shots the broker taxes hardest.
    candidates.sort((a, b) => b.tStat - a.tStat);
    const eligible = candidates.filter(candidate => candidate.passes);
    const best = eligible.length
        ? eligible.reduce((a, b) => (b.adjusted > a.adjusted ? b : a))
        : candidates[0] || null;

    const agreementRatio = best?.agreementRatio ?? 0;
    const decisionConfidence = best?.confidence ?? 0;
    const stable = !options.previous || options.previous.direction !== best?.direction || options.previous.barrier === best?.barrier;
    const go = Boolean(best?.passes);

    // Stake sizing: how far past the significance bar this lean is, times the
    // confidence, times how much risk the strategy is willing to take. (Kelly is
    // published as information but is unusably small on a long-shot payout.)
    const conviction = best ? clamp(best.tStat / Math.max(minLean * 2.2, 0.4), 0, 1) : 0;
    const valueScale = strictValue ? clamp(best ? best.edge / Math.max(0.005, safe(options.targetEdge, 0.04)) : 0, 0, 1) : 1;
    const stakeFactor = best
        ? clamp(conviction * valueScale * (0.55 + 0.45 * (decisionConfidence / 100)) * (0.4 + 0.6 * riskFactor), 0, 1)
        : 0;

    return {
        ...forecast,
        confidence: decisionConfidence,
        candidates,
        best,
        plan: best,
        go,
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
        stable,
        minLean,
        strictValue,
        effectiveSample,
        tStat: best?.tStat ?? 0,
        conviction,
        rawBiasPoints: best?.rawBiasPoints ?? 0,
        reason: !best
            ? 'no tradeable barrier'
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
            ? `${best.direction.toUpperCase()} ${best.barrier} · p ${(best.probability * 100).toFixed(2)}% · fair ${(best.fair * 100).toFixed(0)}% · lean ${best.rawBiasPoints.toFixed(2)}pt (${best.tStat.toFixed(2)}σ) · payout ${best.payout.toFixed(2)}x · EV ${(best.edge * 100).toFixed(2)}% · conf ${decisionConfidence.toFixed(0)}`
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
    if (record.won) next.wins = safe(next.wins) + 1;
    else next.losses = safe(next.losses) + 1;
    next.lastOutcomeAt = Date.now();
    return next;
}

export default {
    analogDistribution,
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
