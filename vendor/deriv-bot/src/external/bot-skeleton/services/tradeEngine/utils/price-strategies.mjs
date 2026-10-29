/**
 * Price-path ensemble for the shipped DBot strategies.
 *
 * Two kinds of question are answered here:
 *
 *   'tick'  — of the next five quotes, which position holds a *strict* high
 *             (side +1) or a strict low (side −1)?  Ten outcomes: tick 1..5
 *             high, tick 1..5 low.
 *   'rise'  — is the quote at expiry above or below the quote at entry?
 *             Two outcomes, with an equality counted as a loss on both sides
 *             exactly as Deriv settles it.
 *
 * Both are answered by an ensemble, not by one formula. Every model below
 * produces a full probability vector:
 *
 *   anchor      the structural prior. Directional: the market's own tie rate
 *               removed and the remainder split evenly. Tick: 1/10 per tick.
 *   frequency   the long-run outcome histogram of completed windows.
 *   transition  the Markov row for the current two-change state (↑↑, ↑↓, …).
 *   recent      the histogram of the last 250 windows (regime drift).
 *   analog      kernel replay: how did windows that *looked* like this one
 *               resolve (same state, similar RSI, slope, stretch, volatility)?
 *   drift       the analytical directional forecast from measured drift and
 *               volatility — N(drift·h, σ√h) above zero. Directional only; in
 *               tick mode it abstains and the mixture learns to ignore it.
 *   neural      an online softmax regression over the same state features,
 *               trained walk-forward on completed windows.
 *
 * The mixture weights are not hand-picked. Each model is scored with a Brier
 * loss over the windows it would have predicted, and the weights follow the
 * multiplicative-weights rule (exponential in relative loss). A model that is
 * useless on this market — a drift model on a fixed-step index, say — loses
 * weight by itself; a model that reads the market keeps it. That is the same
 * adaptive-expert design the digit brain uses, applied to price contracts.
 *
 * Two honesty rules the previous single-blend version did not have:
 *
 *   Ties. On a fixed-step market (Step Index moves in ±0.1 steps) an *even*
 *   tick horizon ties about 36% of the time and every tie is a loss, so the
 *   win probability of a 4-tick Rise/Fall there tops out near 32%. A fixed
 *   56% gate could never fire: both the Rise/Fall and the hedge preset were
 *   silently unable to trade. The tie rate is now measured, returned and
 *   gated (`maxTie`), and the presets use an odd horizon where no tie exists.
 *
 *   Evidence. The estimate is shrunk toward the anchor by its effective sample
 *   size, and the decision carries the model agreement, the separation from
 *   the runner-up and a confidence figure — so a strategy can require more
 *   than "the number is above the bar" before it risks money.
 *
 * Everything here is historical and conditional: these are estimates, not
 * calibrated odds, and they do not know the payout. None of it is a promise of
 * profit.
 */

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const sign = value => (value > 0 ? 1 : value < 0 ? -1 : 0);
const safe = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** The models that make up the mixture, in reporting order. */
export const PRICE_MODEL_NAMES = ['anchor', 'frequency', 'transition', 'recent', 'analog', 'drift', 'neural'];

/** Minimum history before any decision is published at all. */
const MIN_TICKS = 256;
/** Walk-forward windows used to score the experts on this call. */
const SCORE_WINDOWS = 360;
/** Sliding window behind the `recent` expert. */
const RECENT_WINDOWS = 250;
/** Kernel replay looks at most this far back (and at most this many rows). */
const ANALOG_ROWS = 320;
/** Pseudo-counts that damp a thin state or a thin window toward its parent. */
const PRIOR = 40;
/** Windows of evidence needed before the mixture stops being pulled to the anchor. */
const SHRINK = 120;
/** Sharpness of the multiplicative-weights step. */
const ETA = 18;
/** Standard-error multiplier for the lower confidence bound. */
const Z = 1.0;

const stateAt = (prices, index) =>
    `${sign(prices[index - 1] - prices[index - 2])},${sign(prices[index] - prices[index - 1])}`;

/**
 * A compact description of the moment a window starts: trend strength,
 * path efficiency, stretch from the short mean and volatility expansion.
 * All four are scale-free, so one set of kernel widths works on any market.
 */
function features(prices, end = prices.length - 1) {
    const start = Math.max(1, end - 13);
    let up = 0;
    let down = 0;
    let movement = 0;
    for (let i = start; i <= end; i++) {
        const change = prices[i] - prices[i - 1];
        up += Math.max(0, change);
        down += Math.max(0, -change);
        movement += Math.abs(change);
    }
    const rsi = up + down ? (up - down) / (up + down) : 0;
    const slope = movement ? (prices[end] - prices[start - 1]) / movement : 0;
    const shortStart = Math.max(1, end - 39);
    let sum = 0;
    let count = 0;
    for (let i = shortStart; i <= end; i++) {
        sum += prices[i];
        count++;
    }
    const mean = count ? sum / count : prices[end];
    let variance = 0;
    for (let i = shortStart; i <= end; i++) variance += (prices[i] - mean) ** 2;
    const deviation = count ? Math.sqrt(variance / count) : 0;
    const stretch = deviation > 0 ? (prices[end] - mean) / deviation : 0;
    let recentMove = 0;
    let longMove = 0;
    for (let i = Math.max(1, end - 9); i <= end; i++) recentMove += Math.abs(prices[i] - prices[i - 1]);
    for (let i = Math.max(1, end - 39); i <= end; i++) longMove += Math.abs(prices[i] - prices[i - 1]);
    const expansion = longMove > 0 ? recentMove / 4 / (longMove / 40) : 1;
    return { rsi, slope, stretch, expansion };
}

const normalise = (vector, fallback) => {
    const total = vector.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) return fallback.slice();
    return vector.map(value => value / total);
};

const uniform = count => new Array(count).fill(1 / count);

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 inside an erfc form). */
function normalCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const density = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    const tail =
        density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - tail : tail;
}

const softmax = scores => {
    const max = Math.max(...scores);
    const exps = scores.map(score => Math.exp(score - max));
    const total = exps.reduce((sum, value) => sum + value, 0) || 1;
    return exps.map(value => value / total);
};

/** Exponential weighting of experts by their measured Brier loss. */
function mixtureWeights(brier) {
    const finite = brier.map(value => (Number.isFinite(value) ? value : 1));
    const best = Math.min(...finite);
    const raw = finite.map(value => clamp(Math.exp(-ETA * (value - best)), 0.02, 1.5));
    const total = raw.reduce((sum, value) => sum + value, 0) || 1;
    return raw.map(value => value / total);
}

const emptyDecision = (extra = {}) => ({
    ready: false,
    side: 0,
    tick: 0,
    probability: 0,
    samples: 0,
    conditionalSamples: 0,
    horizon: 0,
    tieRate: 0,
    edge: 0,
    confidence: 0,
    agreement: 0,
    separation: 0,
    stderr: 0,
    decisive: 0,
    models: [],
    probabilities: [],
    reason: '',
    version: 2,
    ...extra,
});

/**
 * @param values    the tick list (numbers or numeric strings)
 * @param mode      'tick' | 'rise' | 'step-hedge'
 * @param horizon   contract horizon in ticks (tick mode always uses 5)
 * @param threshold minimum win probability the chosen side must reach
 * @param options   { maxTie, minAgreement, payout }
 */
export function priceDecision(values, mode = 'rise', horizon = 5, threshold, options = {}) {
    const prices = Array.isArray(values) ? values.map(Number) : [];
    if (prices.length < MIN_TICKS || prices.some(value => !Number.isFinite(value))) {
        return emptyDecision({ reason: `warming up — ${prices.length}/${MIN_TICKS} usable quotes` });
    }

    const isTick = mode === 'tick';
    const h = isTick ? 4 : Math.round(safe(horizon, 5));
    if (!Number.isFinite(h) || h < 1 || h > 10) {
        return emptyDecision({ reason: `unsupported horizon ${horizon}` });
    }
    const count = isTick ? 10 : 2;
    const anchorSide = 1 / count;
    const min = Number.isFinite(Number(threshold)) ? clamp(Number(threshold), 0, 1) : isTick ? 0.3 : 0.56;
    const maxTie = clamp(safe(options.maxTie, 0.2), 0, 1);
    const minAgreement = clamp(safe(options.minAgreement, 0), 0, 1);
    const payout = Number(options.payout);

    // ---- completed windows -------------------------------------------------
    // A window starts at i and is decided by prices[i + h + 1] vs prices[i + 1]
    // (directional) or by the five quotes after i (tick positions). Nothing at
    // or after the last quote is ever read, so there is no future leakage.
    const rows = [];
    const first = Math.max(2, prices.length - 1000);
    for (let i = first; i + h + 1 < prices.length; i++) {
        const winners = [];
        if (isTick) {
            const window = prices.slice(i + 1, i + 6);
            const high = Math.max(...window);
            const low = Math.min(...window);
            if (window.filter(value => value === high).length === 1) winners.push(window.indexOf(high));
            if (window.filter(value => value === low).length === 1) winners.push(5 + window.indexOf(low));
        } else {
            const change = prices[i + h + 1] - prices[i + 1];
            if (change > 0) winners.push(0);
            else if (change < 0) winners.push(1);
        }
        rows.push({ state: stateAt(prices, i), winners, features: features(prices, i) });
    }

    const n = rows.length;
    const recentN = rows.filter((_, index) => index >= rows.length - RECENT_WINDOWS).length;
    if (!rows.length || n < 200) {
        return emptyDecision({ samples: n, horizon: isTick ? 5 : h, reason: `thin history — ${n} completed windows` });
    }

    const currentState = stateAt(prices, prices.length - 1);
    const currentFeatures = features(prices);
    const matched = rows.filter(row => row.state === currentState).length;
    const ties = rows.filter(row => row.winners.length === 0).length;
    const tieRate = isTick ? 0 : ties / n;

    const anchor = isTick ? uniform(count) : new Array(count).fill((1 - tieRate) / 2);

    /** Counts → probability vector, damped toward `parent` by PRIOR pseudo-windows. */
    const fromCounts = (counts, total, parent) => {
        if (!total) return parent.slice();
        return counts.map((value, index) => (value + PRIOR * parent[index]) / (total + PRIOR));
    };

    const blank = () => new Array(count).fill(0);
    const tally = (counts, winners) => {
        winners.forEach(index => {
            if (index >= 0 && index < count) counts[index] += 1;
        });
    };

    // ---- walk-forward scoring of the experts -------------------------------
    const start = Math.max(0, rows.length - SCORE_WINDOWS);
    const brierSum = PRICE_MODEL_NAMES.map(() => 0);
    const brierCount = PRICE_MODEL_NAMES.map(() => 0);

    const globalCounts = blank();
    let globalTotal = 0;
    const stateCounts = new Map();
    const recentQueue = [];
    const recentCounts = blank();
    let recentTotal = 0;
    const passed = []; // rows the models may learn from, with features
    const featureCount = 5; // bias + four state features
    const weights = Array.from({ length: count }, () => new Array(featureCount).fill(0));
    const learningRate = 0.05;

    const score = (probability, winners) => {
        // Brier over the K outcome indicators. A window with two strict
        // extremes (a wide tick window) marks both, so the loss stays honest.
        if (!winners.length) return probability.reduce((sum, value) => sum + value * value, 0) / count;
        let loss = 0;
        for (let k = 0; k < count; k++) loss += (probability[k] - (winners.includes(k) ? 1 : 0)) ** 2;
        return loss / count;
    };

    const expertVectors = () => {
        const frequency = fromCounts(globalCounts, globalTotal, anchor);
        const stateTotal = stateCounts.get(currentState);
        const transition = stateTotal
            ? fromCounts(stateTotal.counts, stateTotal.total, frequency)
            : frequency.slice();
        const recent = fromCounts(recentCounts, recentTotal, frequency);
        let analog = frequency.slice();
        if (passed.length) {
            const tallyAnalog = blank();
            let weightSum = 0;
            for (let index = passed.length - 1; index >= Math.max(0, passed.length - ANALOG_ROWS); index--) {
                const row = passed[index];
                const distance = Math.sqrt(
                    ((row.features.rsi - currentFeatures.rsi) / 0.35) ** 2 +
                        ((row.features.slope - currentFeatures.slope) / 0.35) ** 2 +
                        ((row.features.stretch - currentFeatures.stretch) / 1.2) ** 2 +
                        ((row.features.expansion - currentFeatures.expansion) / 0.8) ** 2
                );
                const weight = Math.exp(-0.5 * distance * distance);
                if (weight < 0.02) continue;
                weightSum += weight;
                row.winners.forEach(index => {
                    if (index >= 0 && index < count) tallyAnalog[index] += weight;
                });
            }
            if (weightSum > 0) {
                analog = tallyAnalog.map((value, index) => (value + PRIOR * 0.25 * frequency[index]) / (weightSum + PRIOR * 0.25));
            }
        }
        let drift = anchor.slice();
        if (!isTick) {
            const driftStart = Math.max(1, prices.length - 40);
            let move = 0;
            let movement = 0;
            for (let index = driftStart; index < prices.length; index++) {
                const change = prices[index] - prices[index - 1];
                move += change;
                movement += Math.abs(change);
            }
            const steps = prices.length - driftStart;
            if (steps > 0 && movement > 0) {
                const meanChange = move / steps;
                const meanMove = movement / steps;
                const z = (meanChange * h) / (meanMove * Math.sqrt(h));
                const up = clamp(normalCdf(z), 0.01, 0.99);
                // The drift model has no tie mass of its own; give it the
                // market's measured tie rate so it competes on the same terms.
                drift = [up * (1 - tieRate * 0.5), (1 - up) * (1 - tieRate * 0.5)];
            }
        }
        const featureRow = [1, sign(prices.at(-1) - prices.at(-2)), sign(prices.at(-2) - prices.at(-3)), currentFeatures.rsi, currentFeatures.stretch];
        const neural = softmax(weights.map(row => row.reduce((sum, value, index) => sum + value * featureRow[index], 0)));
        return { anchor, frequency, transition, recent, analog, drift, neural };
    };

    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (index >= start) {
            // Score every expert on a prediction made *before* this window
            // resolved, then train on it.
            const vectors = expertVectors();
            PRICE_MODEL_NAMES.forEach((name, modelIndex) => {
                brierSum[modelIndex] += score(vectors[name], row.winners);
                brierCount[modelIndex] += 1;
            });
        }

        // Advance the accumulators with the window that just completed.
        tally(globalCounts, row.winners);
        globalTotal += 1;
        const bucket = stateCounts.get(row.state) || { counts: blank(), total: 0 };
        tally(bucket.counts, row.winners);
        bucket.total += 1;
        stateCounts.set(row.state, bucket);
        recentQueue.push(row.winners);
        tally(recentCounts, row.winners);
        recentTotal += 1;
        if (recentQueue.length > RECENT_WINDOWS) {
            const dropped = recentQueue.shift();
            dropped.forEach(outcome => {
                if (outcome >= 0 && outcome < count) recentCounts[outcome] -= 1;
            });
            recentTotal = Math.max(0, recentTotal - 1);
        }

        // One softmax gradient step on this window's features.
        if (index >= start) {
            // The state signs are read from the row itself so the net sees the
            // same inputs the other experts do.
            const [previousSign, latestSign] = row.state.split(',').map(Number);
            const featureRow = [1, latestSign, previousSign, row.features.rsi, row.features.stretch];
            const output = softmax(
                weights.map(weightRow => weightRow.reduce((sum, value, position) => sum + value * featureRow[position], 0))
            );
            for (let k = 0; k < count; k++) {
                const target = row.winners.includes(k) ? 1 : 0;
                const error = output[k] - target;
                for (let position = 0; position < featureCount; position++) {
                    weights[k][position] -= learningRate * error * featureRow[position];
                }
            }
        }
        passed.push(row);
    }

    const brier = brierSum.map((value, index) => (brierCount[index] ? value / brierCount[index] : 1));
    const mixture = mixtureWeights(brier);
    const experts = expertVectors();
    const blended = new Array(count).fill(0);
    PRICE_MODEL_NAMES.forEach((name, modelIndex) => {
        experts[name].forEach((value, outcome) => {
            blended[outcome] += mixture[modelIndex] * value;
        });
    });

    // Shrink toward the anchor by the effective sample size: a thin state is
    // an anchor, not a discovery.
    const effective = Math.max(0, Math.min(matched, recentN));
    const trust = effective / (effective + SHRINK);
    const probabilities = normalise(
        blended.map((value, index) => trust * value + (1 - trust) * anchor[index]),
        anchor
    );

    const ranked = probabilities
        .map((probability, index) => ({ probability, index }))
        .sort((left, right) => right.probability - left.probability);
    const best = ranked[0];
    const runnerUp = ranked[1] || { probability: 0, index: -1 };
    const side = isTick ? (best.index < 5 ? 1 : -1) : best.index === 0 ? 1 : -1;
    const tick = isTick ? (best.index % 5) + 1 : 0;

    // Agreement: the mixture weight that backs the winning side.
    const agreeWeight = PRICE_MODEL_NAMES.reduce((sum, name, modelIndex) => {
        const vector = experts[name];
        const top = vector.indexOf(Math.max(...vector));
        return sum + (top === best.index ? mixture[modelIndex] : 0);
    }, 0);

    const separation = best.probability - runnerUp.probability;
    const votes = effective + SHRINK;
    const stderr = Math.sqrt((best.probability * (1 - best.probability)) / Math.max(1, votes));
    const confidence = clamp(
        100 * (0.4 * agreeWeight + 0.3 * clamp(effective / 400, 0, 1) + 0.3 * clamp(separation / 0.1, 0, 1)),
        0,
        100
    );
    const breakEven = Number.isFinite(payout) && payout > 0 ? 1 / (1 + payout) : anchorSide;
    const edge = best.probability - breakEven;
    const decisive = isTick ? best.probability : tieRate < 1 ? best.probability / (1 - tieRate) : 0;

    const models = PRICE_MODEL_NAMES.map((name, modelIndex) => ({
        name,
        weight: mixture[modelIndex],
        brier: brier[modelIndex],
        probability: experts[name][best.index],
    }));

    const result = {
        ready: false,
        side,
        tick,
        probability: best.probability,
        samples: n,
        conditionalSamples: matched,
        horizon: isTick ? 5 : h,
        tieRate,
        edge,
        confidence,
        agreement: agreeWeight,
        separation,
        stderr,
        decisive,
        models,
        probabilities,
        reason: '',
        version: 2,
    };

    // ---- gates -------------------------------------------------------------
    if (n < 200) return { ...result, reason: `thin history — ${n}/200 completed windows` };
    if (matched < 20) return { ...result, reason: `thin state — ${matched}/20 matches for ${currentState}` };
    if (recentN < 50) return { ...result, reason: `thin recent window — ${recentN}/50` };
    if (tieRate > maxTie) {
        return {
            ...result,
            reason: `tie risk ${(tieRate * 100).toFixed(1)}% above ${(maxTie * 100).toFixed(0)}% — ${h} ticks ties too often on this market, use an odd horizon`,
        };
    }
    // A directional decision needs one side to actually lead. In tick mode a
    // tie between the strict high and the strict low is a real answer, not an
    // ambiguity (in a clean trend both are tradeable), so only the directional
    // model enforces separation.
    if (!isTick && !(separation > 0)) return { ...result, reason: 'no side leads' };
    if (best.probability < min) {
        return {
            ...result,
            reason: `below threshold — ${(best.probability * 100).toFixed(1)}% < ${(min * 100).toFixed(1)}%`,
        };
    }
    if (best.probability - Z * stderr < min - 0.02) {
        return {
            ...result,
            reason: `evidence too thin — ${(best.probability * 100).toFixed(1)}% ±${(Z * stderr * 100).toFixed(1)}pt`,
        };
    }
    if (agreeWeight < minAgreement) {
        return {
            ...result,
            reason: `only ${(agreeWeight * 100).toFixed(0)}% of the model weight agrees, floor ${(minAgreement * 100).toFixed(0)}%`,
        };
    }

    const summary = isTick
        ? `${side > 0 ? 'HIGH' : 'LOW'} tick ${tick} · p ${(best.probability * 100).toFixed(1)}% · conf ${confidence.toFixed(0)} · agree ${(agreeWeight * 100).toFixed(0)}% · 5 ticks`
        : `${side > 0 ? 'RISE' : 'FALL'} · p ${(best.probability * 100).toFixed(1)}% · conf ${confidence.toFixed(0)} · agree ${(agreeWeight * 100).toFixed(0)}% · tie ${(tieRate * 100).toFixed(1)}% · ${h} ticks`;

    return { ...result, ready: true, reason: summary };
}

export default { priceDecision, PRICE_MODEL_NAMES };
