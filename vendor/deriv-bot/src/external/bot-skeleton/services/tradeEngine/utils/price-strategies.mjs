/**
 * Price-path ensemble for the shipped DBot strategies — v3.
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
 *               removed and the remainder split evenly. Tick: the discrete
 *               arcsine law over the five positions (27 %, 16 %, 14 %, 16 %,
 *               27 %) — the running maximum of a random walk favours the ends,
 *               and that structure is the one bet on this instrument that does
 *               not require a model to be clever.
 *   frequency   the long-run outcome histogram of completed windows.
 *   transition  the Markov row for the current two-change state (↑↑, ↑↓, …).
 *   recent      the histogram of the last 250 windows (regime drift).
 *   analog      kernel replay: how did windows that *looked* like this one
 *               resolve (same state, similar RSI, slope, stretch, volatility)?
 *   drift       the analytical directional forecast from measured drift and
 *               volatility — N(drift·h, σ√h) above zero. Directional only; in
 *               tick mode it abstains and the mixture learns to ignore it.
 *   serial      the serial-dependence forecast: an AR(1) fit on the last few
 *               hundred changes, compounded over the horizon. This is the only
 *               structure a tick generator can actually leave behind (momentum
 *               or mean reversion); on an independent stream it collapses to
 *               the anchor by itself.
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
 * What v3 changed, and why
 * ------------------------
 *   Payout-aware edge. The gate used to be an absolute probability (56 %).
 *   For a Rise/Fall contract paying 0.95, break-even is 51.3 %, but the
 *   probability a *shrunk* ensemble can honestly claim on a near-fair Step
 *   Index sits around 51–53 %. A 56 % bar is therefore not a quality filter,
 *   it is an off switch: the bot waited forever on exactly the market both
 *   presets ship. The gate is now `probability − break-even ≥ minEdge`, where
 *   break-even is derived from the payout actually quoted for the contract
 *   (1/(1+payout)) — the standard positive-expectation rule. `threshold`
 *   still works as an absolute floor for anyone who wants one.
 *
 *   Side-level agreement. Agreement used to count the model weight whose
 *   *argmax was the winning outcome index*. In High/Low Tick mode that asks
 *   seven models to name the same tick out of five; even a strong consensus
 *   scored under the old 60 % floor. Agreement is now measured on the traded
 *   side (high vs low, rise vs fall) — what the strategy actually needs —
 *   and the outcome-level figure is still reported separately.
 *
 *   Serial expert + honest evidence. A drift model cannot read a fixed-step
 *   index; serial dependence is the structure that *can* exist there. It is
 *   added as a scored expert, so it either earns its vote or decays.
 *
 * Two honesty rules carry over from v2:
 *
 *   Ties. On a fixed-step market (Step Index moves in ±0.1 steps) an *even*
 *   tick horizon ties about 36 % of the time and every tie is a loss, so the
 *   win probability of a 4-tick Rise/Fall there tops out near 32 %. The tie
 *   rate is measured, returned and gated (`maxTie`), and the presets use an
 *   odd horizon where no tie exists.
 *
 *   Evidence. The estimate is shrunk toward the anchor by its effective sample
 *   size, and the decision carries the model agreement, the separation from
 *   the runner-up, a standard error and a confidence figure — so a strategy
 *   can require more than "the number is above the bar" before it risks money.

 * What the shipped v3 presets then do with it
 * -------------------------------------------
 *   The confidence floor, the payout-aware edge and the model agreement are
 *   inputs of the decision, not checks bolted on afterwards, because the
 *   runtime grades the decisions the engine publishes: a floor applied
 *   downstream would grade a different population from the one the bot trades.
 *
 *   The last gate is the caller's own ledger (`evidence: { hits, samples }`).
 *   Once twenty-five published decisions have been graded, a hit rate under
 *   the break-even stops entries until the record recovers — a model whose
 *   estimates run hot is a losing bot with good explanations, and this is the
 *   gate that notices. `modelReady` stays true through that veto so the
 *   caller keeps grading and the pause can end by itself.
 *
 *   High/Low Tick probabilities are normalised per side (five positions), not
 *   over the ten joint outcomes, and its structural break-even is 1/5 when no
 *   payout is quoted. Normalising over ten outcomes halved every probability
 *   and made a payout-aware gate unreachable — which, together with an
 *   absolute 26 % floor, is why the tick preset used to buy nothing at all.
 *
 * Everything here is historical and conditional: these are estimates, not
 * calibrated odds. The realised hit rate of the published decisions belongs to
 * the runtime (see VisionInterface's price calibration), not to this pure
 * function. None of it is a promise of profit.
 */

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const sign = value => (value > 0 ? 1 : value < 0 ? -1 : 0);
const safe = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** The models that make up the mixture, in reporting order. */
export const PRICE_MODEL_NAMES = ['anchor', 'frequency', 'transition', 'recent', 'analog', 'drift', 'serial', 'neural', 'regime'];

/** Bumped whenever the decision shape or its gates change meaning. */
export const PRICE_MODEL_VERSION = 4;

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
/** Standard-error multiplier for the reported interval. */
const Z = 1.0;
/** Changes read by the serial expert. */
const SERIAL_LOOKBACK = 260;
/**
 * Positions a High/Low Tick contract lets you name. The count is fixed by the
 * instrument, not by the caller's horizon, so it is its own constant.
 */
const TICK_POSITIONS = 5;

/** The payout the shipped presets assume when the live quote is unavailable. */
export const DEFAULT_PAYOUT = 0.95;
/**
 * A `threshold` at or below this is treated as "no absolute floor": the
 * payout-derived edge gate becomes the only value test. It lets a strategy say
 * "trade the edge, whatever the raw probability is" instead of hard-coding a
 * number that cannot be reached on its market.
 */
const ABSOLUTE_FLOOR_OFF = 0.02;

/**
 * Graded decisions needed before the rule's own record is allowed to veto a
 * trade. Below this the sample is too small to say anything; above it a hit
 * rate under the break-even is not bad luck, it is a broken estimate.
 */
const MIN_EVIDENCE_SAMPLES = 25;

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

/**
 * Classify the market state the models are being asked to read.
 *
 * `expansion` — volatility is picking up after a directional run; continuation
 *               is the live hypothesis.
 * `reversion` — the market is quiet but stretched from its short mean; a pull
 *               back is the live hypothesis.
 * `balanced`  — neither; the frequency model is the honest answer.
 *
 * The thresholds are on scale-free features, so the same rule works on a
 * two-decimal index and on a five-decimal one.
 */
function tickRegime(current) {
    if (current.expansion >= 1.25 && Math.abs(current.slope) >= 0.2) return 'expansion';
    if (current.expansion <= 0.9 && Math.abs(current.stretch) >= 1.1) return 'reversion';
    return 'balanced';
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

/**
 * Serial-dependence forecast as a z-score of the cumulative move.
 *
 * An AR(1) coefficient is fitted to the last few hundred changes. If changes
 * persist (ρ > 0) the last change is projected forward and compounded; if they
 * alternate (ρ < 0) the projection flips sign. Compounding over the horizon is
 * Σ ρⁱ, so a small ρ is not extrapolated into a fantasy: it decays. The
 * forecast is returned in units of the horizon's own standard deviation, which
 * makes it comparable across markets with different step sizes.
 */
export function serialLean(prices, horizon = 5) {
    const start = Math.max(2, prices.length - SERIAL_LOOKBACK);
    const changes = [];
    for (let i = start; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
    if (changes.length < 30) return 0;

    const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
    const variance = changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / changes.length;
    const deviation = Math.sqrt(variance);
    if (!(deviation > 0)) return 0;

    let covariance = 0;
    for (let i = 1; i < changes.length; i++) covariance += (changes[i] - mean) * (changes[i - 1] - mean);
    covariance /= changes.length - 1;
    const rho = clamp(covariance / (deviation * deviation), -0.6, 0.6);

    let decay = 0;
    let factor = 1;
    for (let step = 1; step <= horizon; step++) {
        factor *= rho;
        decay += factor;
    }
    const expected = (changes[changes.length - 1] - mean) * decay;
    const scale = deviation * Math.sqrt(Math.max(1, horizon));
    return scale > 0 ? clamp(expected / scale, -2.5, 2.5) : 0;
}

/**
 * Break-even win probability for a binary contract paying `payout` profit per
 * unit staked: you win `payout`, you lose 1, so p·payout − (1 − p) = 0 gives
 * p = 1/(1 + payout). With the usual 0.95 quote that is 51.28 %, not 50 % and
 * certainly not 56 %.
 */
export function breakEvenProbability(payout, fallback = 0.5) {
    const value = Number(payout);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return 1 / (1 + value);
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
    ev: 0,
    breakEven: 0.5,
    payout: 0,
    z: 0,
    confidence: 0,
    agreement: 0,
    outcomeAgreement: 0,
    separation: 0,
    stderr: 0,
    decisive: 0,
    models: [],
    probabilities: [],
    reason: '',
    version: PRICE_MODEL_VERSION,
    ...extra,
});

/**
 * Discrete arcsine law: the probability that tick k holds the strict maximum of
 * a symmetric random walk of `h` steps, normalised over the positions.
 *
 * P(position k) ∝ C(2k-2, k-1) · C(2h-2k, h-k) — the classical result that a
 * random walk's maximum is most likely to sit at one of the ends. Exported for
 * the tests, which pin it to the enumerated 5-tick distribution.
 */
export function arcsinePrior(h = 5) {
    const steps = Math.min(10, Math.max(1, Math.round(h)));
    const choose = (n, r) => {
        if (r < 0 || r > n) return 0;
        let value = 1;
        for (let i = 1; i <= r; i++) value = (value * (n - r + i)) / i;
        return value;
    };
    const weights = [];
    for (let k = 1; k <= steps; k++) {
        weights.push(choose(2 * k - 2, k - 1) * choose(2 * steps - 2 * k, steps - k));
    }
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    return weights.map(value => value / total);
}

/**
 * @param values    the tick list (numbers or numeric strings)
 * @param mode      'tick' | 'rise' | 'step-hedge'
 * @param horizon   contract horizon in ticks (tick mode always uses 5)
 * @param threshold absolute probability floor; ≤ 0.02 (or absent) turns it off
 *                  and leaves the payout-derived edge gate in charge
 * @param options   { maxTie, minAgreement, minEdge, payout, minProbability,
 *                    minConfidence,
 *                    evidence } — `evidence` is { hits, samples } from the
 *                  caller's own ledger of graded decisions.
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
    // `requireEdge` is the operator's choice between two different jobs:
    //
    //   true  (default) — publish a decision only when the evidence clears the
    //                     payout break-even. Opportunistic: an idle bot is
    //                     doing its job.
    //   false           — publish the best side the ensemble can name on every
    //                     readable tick, and let the *stake* carry the caution
    //                     (Kelly sizes a thin read to the exchange minimum).
    //                     This is for strategies that must keep a cadence — a
    //                     hedged pair re-entering after each settlement — where
    //                     "the market is fair" is not a reason to stop trading
    //                     but a reason to trade small.
    //
    // What is never disabled by it: the warm-up and thin-history floors (there
    // is nothing to read yet), the tie gate (a shape that cannot settle a
    // winner), and the caller's own session brakes.
    const requireEdge = options.requireEdge !== false;
    const maxTie = clamp(safe(options.maxTie, 0.2), 0, 1);
    const minAgreement = clamp(safe(options.minAgreement, 0), 0, 1);
    const minEdge = safe(options.minEdge, 0);
    const payout = Number(options.payout);
    const payoutKnown = Number.isFinite(payout) && payout > 0;

    // The absolute floor is only applied when the strategy asked for one.
    const requestedFloor = Number.isFinite(Number(threshold)) ? Number(threshold) : NaN;
    const explicitFloor = Number.isFinite(requestedFloor) ? clamp(requestedFloor, 0, 1) : 0;
    const minProbability = clamp(
        safe(options.minProbability, explicitFloor > ABSOLUTE_FLOOR_OFF ? explicitFloor : 0),
        0,
        1
    );

    // Break-even from the payout actually quoted for this contract. In tick
    // mode the payout is a multiple, not a 0.95-style ratio, so a caller that
    // does not supply one gets the structural 1/5 — one chance in five
    // positions, which is the scale each side is normalised to — instead of a
    // made-up figure.
    const breakEven = payoutKnown
        ? breakEvenProbability(payout, 1 / count)
        : isTick
          ? 1 / TICK_POSITIONS
          : 0.5;

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
    if (!rows.length || n < 200) {
        return emptyDecision({
            samples: n,
            horizon: isTick ? 5 : h,
            breakEven,
            payout: payoutKnown ? payout : 0,
            reason: `thin history — ${n}/200 completed windows`,
        });
    }
    const recentN = rows.filter((_, index) => index >= rows.length - RECENT_WINDOWS).length;
    if (recentN < 50) {
        return emptyDecision({
            samples: n,
            horizon: isTick ? 5 : h,
            breakEven,
            payout: payoutKnown ? payout : 0,
            reason: `thin recent window — ${recentN}/50`,
        });
    }

    const currentState = stateAt(prices, prices.length - 1);
    const currentFeatures = features(prices);
    const matched = rows.filter(row => row.state === currentState).length;
    const ties = rows.filter(row => row.winners.length === 0).length;
    const tieRate = isTick ? 0 : ties / n;

    // High/Low Tick has a structural prior, and it is not the uniform one. For
    // a symmetric random walk the chance that a given tick holds the running
    // maximum follows the discrete arcsine law: the extreme positions are the
    // likeliest (27 % at tick 1 or 5 over five ticks) and the middle is the
    // least likely (14 %). Deriv quotes one payout for the contract, so buying
    // an end position is the one bet on this instrument that does not depend on
    // a model being clever. Anchoring the mixture there means a thin sample
    // falls back to that structure instead of to a flat 1-in-5 guess, and the
    // live evidence gate decides whether the market has already priced it.
    const anchor = isTick
        ? [...arcsinePrior(TICK_POSITIONS), ...arcsinePrior(TICK_POSITIONS)]
        : new Array(count).fill((1 - tieRate) / 2);

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
        // Serial dependence: abstains on tick mode (it has no directional
        // question to answer) and falls back to the anchor when there is no
        // measurable persistence.
        let serial = anchor.slice();
        if (!isTick) {
            const z = serialLean(prices, h);
            const up = clamp(normalCdf(z), 0.02, 0.98);
            serial = [up * (1 - tieRate * 0.5), (1 - up) * (1 - tieRate * 0.5)];
        }
        const featureRow = [1, sign(prices.at(-1) - prices.at(-2)), sign(prices.at(-2) - prices.at(-3)), currentFeatures.rsi, currentFeatures.stretch];
        const neural = softmax(weights.map(row => row.reduce((sum, value, index) => sum + value * featureRow[index], 0)));
        // The regime expert asks a different question from every other model
        // here: not "which way is it going" but "what kind of market is this?".
        // A quiet market that has stretched away from its short mean tends to
        // pull back (mean reversion); a market whose volatility is expanding
        // after a directional run tends to continue. The switch is read from
        // the expansion ratio, so the model changes its hypothesis with the
        // regime instead of applying one rule everywhere. It is scored like the
        // rest, so on a market where neither tendency exists it simply loses
        // its vote.
        const regime = tickRegime(currentFeatures);
        let regimeVector;
        if (isTick) {
            // Tick contracts ask about the extreme, not the direction: a quiet,
            // stretched market is more likely to keep its extreme where the run
            // started, an expanding one to extend it.
            regimeVector = anchor.slice();
        } else if (regime === 'expansion') {
            const z = clamp(currentFeatures.slope * 2.2, -2.5, 2.5);
            const up = clamp(normalCdf(z), 0.03, 0.97);
            regimeVector = [up * (1 - tieRate * 0.5), (1 - up) * (1 - tieRate * 0.5)];
        } else if (regime === 'reversion') {
            const z = clamp(-currentFeatures.stretch * 0.9, -2.5, 2.5);
            const up = clamp(normalCdf(z), 0.03, 0.97);
            regimeVector = [up * (1 - tieRate * 0.5), (1 - up) * (1 - tieRate * 0.5)];
        } else {
            regimeVector = frequency.slice();
        }
        return { anchor, frequency, transition, recent, analog, drift, serial, neural, regime: regimeVector };
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

    // High/Low Tick is two separate bets: "the strict high prints at tick k"
    // and "the strict low prints at tick k". The market prices each of them as
    // a probability over the five positions, so each side must sum to one.
    // The joint ten-outcome vector sums to two, and reading half of it as a win
    // probability is what made a payout-aware tick gate unreachable — a model
    // that was right about the likely tick still reported half the payout
    // break-even. Normalising per side fixes the scale, not the ranking.
    if (isTick) {
        [0, 5].forEach(offset => {
            const mass = probabilities.slice(offset, offset + 5).reduce((sum, value) => sum + value, 0);
            if (mass > 0) {
                for (let k = offset; k < offset + 5; k++) probabilities[k] /= mass;
            }
        });
    }

    // ---- calibration from the rule's own record ---------------------------
    // Every other number here is a model of the future. This one is the
    // measured past: the hit rate of the decisions this rule actually
    // published, graded against the ticks that settled them. A record at or
    // above the break-even means the estimates are earning their keep, so the
    // vector is sharpened a little; a record below it means the estimates are
    // running hot, so the vector is pulled back toward the structural anchor by
    // the ratio. Calibrating instead of standing down keeps the bot trading
    // after a bad run — at a stake Kelly already sizes down — rather than
    // parking it forever the way a hard veto did.
    const evidence = options.evidence;
    const graded = Number(evidence?.samples);
    const evidenceRate =
        evidence && Number.isFinite(Number(evidence.rate))
            ? Number(evidence.rate)
            : evidence && graded > 0
              ? Number(evidence.hits || 0) / graded
              : NaN;
    let calibration = 1;
    if (graded >= MIN_EVIDENCE_SAMPLES && Number.isFinite(evidenceRate) && breakEven > 0) {
        calibration =
            evidenceRate >= breakEven
                ? 1 + Math.min(0.25, (evidenceRate / breakEven - 1) * 0.5)
                : clamp(evidenceRate / breakEven, 0.35, 1);
        if (calibration !== 1) {
            for (let index = 0; index < count; index++) {
                probabilities[index] = anchor[index] + calibration * (probabilities[index] - anchor[index]);
            }
            if (isTick) {
                // Each side is a distribution over its own five positions.
                [0, TICK_POSITIONS].forEach(offset => {
                    const mass = probabilities
                        .slice(offset, offset + TICK_POSITIONS)
                        .reduce((sum, value) => sum + value, 0);
                    if (mass > 0) {
                        for (let k = offset; k < offset + TICK_POSITIONS; k++) probabilities[k] /= mass;
                    }
                });
            } else {
                const normalised = normalise(probabilities, anchor);
                for (let index = 0; index < count; index++) probabilities[index] = normalised[index];
            }
        }
    }

    const ranked = probabilities
        .map((probability, index) => ({ probability, index }))
        .sort((left, right) => right.probability - left.probability);
    const best = ranked[0];
    const runnerUp = ranked[1] || { probability: 0, index: -1 };
    const side = isTick ? (best.index < 5 ? 1 : -1) : best.index === 0 ? 1 : -1;
    const tick = isTick ? (best.index % 5) + 1 : 0;

    // Agreement is measured on the side the strategy trades. In tick mode the
    // exact winning outcome index is a five-way detail; two models that both
    // say "high, different tick" still agree about the buy.
    const sideOf = outcome => (isTick ? (outcome < 5 ? 1 : -1) : outcome === 0 ? 1 : -1);
    let agreeWeight = 0;
    let outcomeAgreeWeight = 0;
    PRICE_MODEL_NAMES.forEach((name, modelIndex) => {
        const vector = experts[name];
        let topIndex = 0;
        for (let index = 1; index < vector.length; index++) if (vector[index] > vector[topIndex]) topIndex = index;
        if (sideOf(topIndex) === side) agreeWeight += mixture[modelIndex];
        if (topIndex === best.index) outcomeAgreeWeight += mixture[modelIndex];
    });

    const separation = best.probability - runnerUp.probability;
    const votes = effective + SHRINK;
    const stderr = Math.sqrt((best.probability * (1 - best.probability)) / Math.max(1, votes));
    // Separation is scored on its own scale: five points of separation is a
    // mountain when the pick is one of ten tick positions and a rounding error
    // when it is one of two directions. Scoring both against 0.1 held the tick
    // strategy at a confidence it could never reach.
    const separationScale = isTick ? 0.04 : 0.1;
    const confidence = clamp(
        100 *
            (0.4 * agreeWeight +
                0.3 * clamp(effective / 400, 0, 1) +
                0.3 * clamp(separation / separationScale, 0, 1)),
        0,
        100
    );
    // Edge and expected value are payout-aware. A "56 % probability" means
    // nothing until it is compared with what the contract pays.
    const edge = best.probability - breakEven;
    const ev = payoutKnown ? best.probability * (1 + payout) - 1 : edge;
    const z = stderr > 0 ? edge / stderr : 0;
    const decisive = isTick ? best.probability : tieRate < 1 ? best.probability / (1 - tieRate) : 0;

    const models = PRICE_MODEL_NAMES.map((name, modelIndex) => ({
        name,
        weight: mixture[modelIndex],
        brier: brier[modelIndex],
        probability: experts[name][best.index],
    }));

    const result = {
        ready: false,
        // True when every *model* gate passed, which is what the caller grades
        // against the tick that settles. The evidence gate can still veto the
        // entry — and the grading must continue while it does, or a bot that
        // paused once could never prove itself again.
        modelReady: false,
        side,
        tick,
        probability: best.probability,
        samples: n,
        conditionalSamples: matched,
        horizon: isTick ? 5 : h,
        tieRate,
        edge,
        ev,
        breakEven,
        payout: payoutKnown ? payout : 0,
        z,
        confidence,
        agreement: agreeWeight,
        outcomeAgreement: outcomeAgreeWeight,
        separation,
        stderr,
        decisive,
        models,
        probabilities,
        requireEdge,
        calibration,
        hitRate: Number.isFinite(evidenceRate) ? evidenceRate : NaN,
        hitSamples: Number.isFinite(graded) ? graded : 0,
        reason: '',
        version: PRICE_MODEL_VERSION,
    };

    // ---- gates -------------------------------------------------------------
    // Ordered from "not enough history to answer" to "the answer is not worth
    // money". Each one names itself, because an idle bot that cannot explain
    // why it is idle is indistinguishable from a broken one.
    if (n < 200) return { ...result, reason: `thin history — ${n}/200 completed windows` };
    if (matched < 20) return { ...result, reason: `thin state — ${matched}/20 matches for ${currentState}` };
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
    if (minProbability > 0 && best.probability < minProbability) {
        return {
            ...result,
            reason: `below floor — ${(best.probability * 100).toFixed(1)}% < ${(minProbability * 100).toFixed(1)}%`,
        };
    }
    // The value gate: the estimate must clear the break-even implied by the
    // payout, by at least `minEdge`. Without a quoted payout the break-even is
    // the structural one, so this reduces to "trade only a positive lean".
    //
    // High/Low Tick prices every tick position differently (the middle ticks
    // are the likeliest, so they pay least), so one scalar payout cannot
    // describe the ten outcomes. The gate is therefore directional by default
    // and a tick strategy opts in only by asking for an edge *and* supplying
    // the payout of the tick it buys.
    const valueGate = requireEdge && (!isTick || minEdge > 0);
    if (valueGate && edge < minEdge) {
        const need = (breakEven + minEdge) * 100;
        return {
            ...result,
            reason: `no edge — ${(best.probability * 100).toFixed(1)}% vs break-even ${(breakEven * 100).toFixed(1)}% (needs ${need.toFixed(1)}%)`,
        };
    }
    if (requireEdge && agreeWeight < minAgreement) {
        return {
            ...result,
            reason: `only ${(agreeWeight * 100).toFixed(0)}% of the model weight is on this side, floor ${(minAgreement * 100).toFixed(0)}%`,
        };
    }
    // The evidence gate. Every other gate is a claim about the future; this one
    // is the rule's own record. Once enough published decisions have been
    // graded, a hit rate below the break-even means the estimates are running
    // hot — an over-confident expert, a regime the models cannot read, or a
    // market whose payout moved against the strategy. Trading on through that
    // is how a "profitable" model becomes a losing bot, so entries stop until
    // the record recovers. Grading never stops, so it can recover.
    // The confidence floor belongs here, not only in the block, because the
    // engine grades the decisions it publishes: a floor applied downstream
    // would grade a different population from the one the strategy trades.
    const minConfidence = clamp(safe(options.minConfidence, 0), 0, 100);
    if (requireEdge && minConfidence > 0 && confidence < minConfidence) {
        return {
            ...result,
            reason: `confidence ${confidence.toFixed(0)} below the ${minConfidence.toFixed(0)} floor`,
        };
    }
    result.modelReady = true;
    // Opt-in strictness: a strategy that would rather stop than trade a
    // discounted read can ask for the veto. The presets use calibration
    // instead, because a stand-down is indistinguishable from a broken bot.
    if (options.evidenceVeto === true && graded >= MIN_EVIDENCE_SAMPLES && evidenceRate < breakEven) {
        return {
            ...result,
            hitRate: evidenceRate,
            hitSamples: graded,
            reason:
                `the rule's own record is ${(evidenceRate * 100).toFixed(1)}% over ` +
                `${graded} graded decisions — below the ${(breakEven * 100).toFixed(1)}% break-even`,
        };
    }

    // The journal line carries the measured record and the tie rate as well as
    // the estimate: with the edge gate off, "how is this rule actually doing"
    // is the number the operator needs to see.
    const record =
        graded >= MIN_EVIDENCE_SAMPLES && Number.isFinite(evidenceRate)
            ? ` · record ${(evidenceRate * 100).toFixed(0)}%/${graded}`
            : '';
    const summary = isTick
        ? `${side > 0 ? 'HIGH' : 'LOW'} tick ${tick} · p ${(best.probability * 100).toFixed(1)}% · EV ${(ev * 100).toFixed(1)}% · conf ${confidence.toFixed(0)} · agree ${(agreeWeight * 100).toFixed(0)}% · 5 ticks${record}`
        : `${side > 0 ? 'RISE' : 'FALL'} · p ${(best.probability * 100).toFixed(1)}% · break-even ${(breakEven * 100).toFixed(1)}% · edge ${(edge * 100).toFixed(1)}pt · tie ${(tieRate * 100).toFixed(1)}% · conf ${confidence.toFixed(0)} · agree ${(agreeWeight * 100).toFixed(0)}% · ${h} ticks${record}`;

    return { ...result, ready: true, reason: summary };
}

export default { priceDecision, PRICE_MODEL_NAMES, PRICE_MODEL_VERSION, breakEvenProbability, serialLean };
