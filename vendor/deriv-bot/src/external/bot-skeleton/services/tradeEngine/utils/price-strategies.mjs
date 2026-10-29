/**
 * Price-path ensemble for the shipped DBot strategies — v5.
 *
 * Two kinds of question are answered here:
 *
 *   'tick'  — of the next five quotes, which position holds a *strict* high
 *             (side +1) or a strict low (side −1)?  Ten outcomes: tick 1..5
 *             high, tick 1..5 low. This is Deriv's High/Low Ticks contract.
 *   'rise'  — is the quote at expiry above or below the quote at entry?
 *             Two outcomes, with an equality counted as a loss on both sides
 *             exactly as Deriv settles it.
 *
 * Both are answered by a mixture of experts, not by one formula. Every model
 * below produces a full probability vector:
 *
 *   anchor      the structural prior. Directional: the market's own tie rate
 *               removed and the remainder split evenly. Tick: the *tie-aware*
 *               structural distribution of "which position holds the running
 *               extreme" (see below), which is the one bet on this instrument
 *               that does not require a model to be clever.
 *   frequency   the long-run outcome histogram of completed windows.
 *   transition  the Markov row for the current two-change state (↑↑, ↑↓, …).
 *   recent      the histogram of the last 250 windows (regime drift).
 *   analog      kernel replay: how did windows that *looked* like this one
 *               resolve (same state, similar RSI, slope, stretch, volatility,
 *               run length and previous extreme position)?
 *   drift       the analytical directional forecast from measured drift and
 *               volatility — N(drift·h, σ√h) above zero. Directional only; in
 *               tick mode it abstains and the mixture learns to ignore it.
 *   serial      the serial-dependence forecast: an AR(1) fit on the last few
 *               hundred changes, compounded over the horizon. In tick mode it
 *               is the AR(1) fit on the *position* of the running extreme,
 *               which is the only persistence a tick generator can leave there.
 *   neural      an online softmax regression over the same state features,
 *               trained walk-forward on completed windows.
 *   regime      expansion → the extreme prints late; quiet-and-stretched →
 *               the extreme prints early. On a fair stream it loses its vote.
 *   position    v5: a Markov chain on the previous window's strict extreme
 *               (H1…H5, L1…L5, T). Consecutive windows overlap four ticks, so
 *               their outcomes are correlated even when the increments are not.
 *
 * The mixture weights are not hand-picked. Each model is scored with a Brier
 * loss over the windows it would have predicted, and the weights follow the
 * multiplicative-weights rule (exponential in relative loss). A model that is
 * useless on this market — a drift model on a fixed-step index, say — loses
 * weight by itself; a model that reads the market keeps it. That is the same
 * adaptive-expert design the digit brain uses, applied to price contracts.
 *
 * What v5 changed, and why
 * ------------------------
 *   Tie-aware structure. On a quote grid the strict extreme is not distributed
 *   like the continuous arcsine law: the middle position is far *less* likely
 *   (6.25 % of windows on a pure ±1-step walk, against 14.06 % continuous) and
 *   up to a third of windows have a tie, which loses on both sides. v5 blends
 *   the arcsine prior with the enumerated grid-walk distribution using the
 *   market's *measured* tie rate, so a Step Index is never priced with a
 *   Volatility 100 prior. `gridStrictPrior` is enumerated here, not guessed.
 *
 *   A tie is missing mass, not a rounding error. v4 normalised each side to
 *   100 % and compared that with the break-even of a quote that already pays
 *   for ties. A window that ties cannot win, so on a Step Index v4 overstated
 *   its win probability by 1/(1 − 0.3125) = 45 %. v5 forecasts the *next*
 *   window's tie probability (recent ties, shrunk to the long-run rate, divided
 *   by the volatility expansion) and reports the unconditional win probability
 *   that a contract is actually paid on.
 *
 *   Per-outcome payouts and an EV scan. Deriv quotes TICKHIGH/TICKLOW per
 *   `selected_tick`, so one pay-out number cannot price ten outcomes. v5 takes
 *   the whole table (`options.payouts`) and ranks outcomes by expected value
 *   `p·(1+m) − 1`, gate `minEv`, and reports the quote and the fair odds behind
 *   the chosen position. When fewer than four quotes are known it falls back to
 *   ranking by probability, exactly as v4 did.
 *
 *   Entry slip. The contract's five ticks start when Deriv processes the buy,
 *   not when the model looked. `options.entrySlip` shrinks the conditional part
 *   of the estimate toward the anchor by √((5 − slip)/5), so a bot on a
 *   one-second market is not credited with information it cannot get filled on.
 *
 *   Self-audit. Every expert now reports its Brier *skill* against the anchor,
 *   the ensemble reports its own walk-forward skill, and the decision carries a
 *   `standDown` flag from a Wilson bound on the rule's graded record — the
 *   difference between "the model says" and "the model has been right".
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
 *   size, and the decision carries the model agreement, the separation from the
 *   runner-up, a standard error and a confidence figure — so a strategy can
 *   require more than "the number is above the bar" before it risks money.
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
export const PRICE_MODEL_NAMES = [
    'anchor',
    'frequency',
    'transition',
    'recent',
    'analog',
    'drift',
    'serial',
    'neural',
    'regime',
    'position',
];

/** Bumped whenever the decision shape or its gates change meaning. */
export const PRICE_MODEL_VERSION = 5;

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
/** The positions a High/Low Tick contract lets you name. Fixed by the instrument. */
export const TICK_POSITIONS = 5;
/**
 * Seconds from "the model looked" to "the contract exists". Deriv's round trip
 * plus the engine's own bookkeeping, measured rather than assumed: it is the
 * only number that turns a tick interval into an execution error.
 */
export const DEFAULT_LATENCY = 0.3;
/** How many recent completed windows the tie forecast averages. */
const TIE_MEMORY = 60;
/** Pseudo-windows pulling the tie forecast toward the long-run tie rate. */
const TIE_SHRINK = 80;
/** Graded decisions needed before the record's Wilson bound may stand a bot down. */
const STAND_DOWN_SAMPLES = 40;

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
 * A compact description of the moment a window starts: trend strength, path
 * efficiency, stretch from the short mean, volatility expansion and the length
 * of the run that ends at this tick. All are scale-free, so one set of kernel
 * widths works on any market.
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
    // Volatility expansion: mean absolute move over the last ten ticks divided
    // by the mean over the last forty. Both means are per tick — the previous
    // form divided a ten-tick sum by four and a forty-tick sum by forty, which
    // reported 2.5 on a market with perfectly constant volatility. That is not a
    // cosmetic bug: the ratio feeds the regime expert and divides the tie
    // forecast, so a constant 2.5 made every market look like it was expanding
    // and made ties look 1.5× rarer than they are — an optimism of about five
    // probability points on the very contract this bot trades.
    let recentMove = 0;
    let longMove = 0;
    let recentTicks = 0;
    let longTicks = 0;
    for (let i = Math.max(1, end - 9); i <= end; i++) {
        recentMove += Math.abs(prices[i] - prices[i - 1]);
        recentTicks += 1;
    }
    for (let i = Math.max(1, end - 39); i <= end; i++) {
        longMove += Math.abs(prices[i] - prices[i - 1]);
        longTicks += 1;
    }
    const recentMean = recentTicks > 0 ? recentMove / recentTicks : 0;
    const longMean = longTicks > 0 ? longMove / longTicks : 0;
    const expansion = longMean > 0 ? clamp(recentMean / longMean, 0.2, 5) : 1;
    // Run length: how many consecutive changes ending at `end` share a sign.
    let run = 0;
    let runSign = 0;
    for (let i = end; i > Math.max(1, end - 20); i--) {
        const direction = sign(prices[i] - prices[i - 1]);
        if (direction === 0) break;
        if (runSign === 0) runSign = direction;
        else if (direction !== runSign) break;
        run++;
    }
    return { rsi, slope, stretch, expansion, run: run * runSign };
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
 * Lag-1 autocorrelation of a numeric series, clamped to a sane range. Used by
 * the tick-mode serial expert and by the market DNA report.
 */
export function lagOneCorrelation(series) {
    if (!Array.isArray(series) || series.length < 20) return 0;
    const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
    let variance = 0;
    let covariance = 0;
    for (let i = 0; i < series.length; i++) variance += (series[i] - mean) ** 2;
    for (let i = 1; i < series.length; i++) covariance += (series[i] - mean) * (series[i - 1] - mean);
    if (!(variance > 0)) return 0;
    return clamp(covariance / variance, -1, 1);
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

/**
 * THE EXECUTION CLOCK — the half of High/Low Tick that no chart shows.
 *
 * A tick contract is five ticks of *the market's* clock, and the model is asked
 * its question on the last quote it can see. Between that quote and the moment
 * Deriv accepts the buy, the bot's own round trip elapses; if that is longer
 * than the tick interval, the five ticks the contract settles on start a tick
 * later than the five the model scored. The decision is then not wrong, it is
 * *misaligned* — a different bet with a different (usually structural-only)
 * distribution.
 *
 * `labelFidelity` is the probability that a decision taken with this latency is
 * settled on the window it was scored against, averaged over the unknown phase
 * of the arrival inside the interval. It is the ceiling on how well any label
 * can teach a model on this market, which is why the self-audit reports it next
 * to the hit rate: a bot cannot learn faster than its labels are true.
 *
 * @param tickSeconds seconds per tick on this symbol (2 for R_*, 1 for 1HZ*)
 * @param latencySeconds model-look-to-fill time
 * @returns {{ expectedLag: number, fidelity: number, horizon: number, concurrent: number, stakeable: number }}
 */
export function labelFidelity(tickSeconds, latencySeconds = DEFAULT_LATENCY) {
    const interval = Number(tickSeconds);
    const latency = Math.max(0, Number(latencySeconds) || 0);
    const horizon = TICK_POSITIONS * (interval > 0 ? interval : 0);
    if (!(interval > 0)) {
        return { expectedLag: 0, fidelity: 1, horizon: 0, concurrent: 1, stakeable: 1 / TICK_POSITIONS };
    }
    const lag = latency / interval;
    const fidelity = clamp(1 - lag / 2, 0.35, 1);
    // Fraction of a five-tick cycle that a single contract covers, and how many
    // cycles overlap while it runs: buying one position at a time on a 1 s
    // market means five contracts in flight, each a one-in-five bet.
    const stakeable = clamp((1 - 2 * Math.min(lag, 1)) / TICK_POSITIONS, 0.02, 0.25);
    return { expectedLag: lag, fidelity, horizon, concurrent: TICK_POSITIONS, stakeable };
}

/**
 * Discrete arcsine law: the probability that tick k holds the strict maximum of
 * a *continuous* symmetric random walk of `h` steps, normalised over positions.
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
 * The strict-extreme distribution of a *grid* random walk, enumerated exactly.
 *
 * A Step Index moves exactly ±1 quote increment per tick. Enumerating every
 * path of length h (2^h of them, by dynamic programming here) gives the chance
 * that a single position holds the strict maximum, and the chance that the
 * window ties — which loses on both sides. For h = 5 that is
 * [6, 4, 2, 4, 6] strict windows out of 32 and 10 tied windows: the middle
 * position is 6.25 % of all windows, not the 20 % a uniform guess assumes and
 * not the 14.06 % the continuous arcsine law gives.
 *
 * @returns {{ positions: number[], tieRate: number, h: number }} `positions`
 *          is conditional on a strict extreme existing (it sums to one).
 */
export function gridStrictPrior(h = 5) {
    const steps = Math.min(10, Math.max(1, Math.round(h)));
    // State: value, running max, position of the running max, how many positions
    // hold it. After the first tick the max always exists (it is tick 1).
    let states = new Map();
    states.set(`${1}|${1}|${1}|1`, 1);
    states.set(`${-1}|${-1}|${1}|1`, 1);
    for (let step = 2; step <= steps; step++) {
        const next = new Map();
        states.forEach((ways, key) => {
            const [value, max, maxPosition, seen] = key.split('|').map(Number);
            for (const move of [1, -1]) {
                const moved = value + move;
                const entry =
                    moved > max
                        ? `${moved}|${moved}|${step}|1`
                        : moved === max
                          ? `${moved}|${max}|${maxPosition}|${seen + 1}`
                          : `${moved}|${max}|${maxPosition}|${seen}`;
                next.set(entry, (next.get(entry) || 0) + ways);
            }
        });
        states = next;
    }
    const strict = new Array(steps).fill(0);
    let ties = 0;
    let total = 0;
    states.forEach((ways, key) => {
        const [, , maxPosition, seen] = key.split('|').map(Number);
        total += ways;
        if (seen === 1) strict[maxPosition - 1] += ways;
        else ties += ways;
    });
    const strictTotal = strict.reduce((sum, value) => sum + value, 0);
    return {
        positions: strictTotal > 0 ? strict.map(value => value / strictTotal) : arcsinePrior(steps),
        tieRate: total > 0 ? ties / total : 0,
        h: steps,
    };
}

/**
 * The structural prior a market actually has, given how tie-heavy it is.
 *
 * A market whose ticks move many quote-grid increments per step behaves like the
 * continuous random walk (arcsine, no ties); one that moves a single increment
 * behaves like the enumerated grid walk (heavily tied, middle position rare).
 * The measured tie rate is the observable that separates the two, so the prior
 * is the mix of the two structures at that rate — not a flat 1-in-5 guess and
 * not the continuous law applied where it does not hold.
 */
export function strictExtremePrior(h = 5, tieRate = 0) {
    const steps = Math.min(10, Math.max(1, Math.round(h)));
    const arc = arcsinePrior(steps);
    const grid = gridStrictPrior(steps);
    const weight = grid.tieRate > 0 ? clamp(safe(tieRate, 0) / grid.tieRate, 0, 1) : 0;
    return normalise(
        arc.map((value, index) => (1 - weight) * value + weight * grid.positions[index]),
        arc
    );
}

/**
 * MARKET DNA — the market's structural fingerprint, measured rather than assumed.
 *
 * This is the "reverse engineering" layer: it answers *what kind of market am I
 * standing on* before any model is allowed to trade it. Every field is a
 * measurement of the collected ticks; none of them is a forecast.
 *
 *   windows        completed five-tick windows in the sample
 *   tieHigh/Low    share of windows with no strict high / low (a tie loses)
 *   strictHigh/Low the strict-extreme histogram, per side
 *   arcSine        the continuous random-walk prior for comparison
 *   gridPrior      the enumerated one-increment grid-walk prior
 *   chi            chi-square displacement of the observed histograms from the
 *                  arcsine prior (4 degrees of freedom; ~9.5 is the 5 % line)
 *   positionZ      per-position binomial z against the arcsine prior
 *   gridRatio      σ per tick ÷ quote grid — the parameter of §3.3 of the
 *                  research file; below ~2 the grid dominates and ties explode
 *   driftZ         drift significance of the tick-to-tick changes
 *   rho            lag-1 autocorrelation of the changes
 *   expansion      recent vs longer-run absolute move (volatility regime)
 *   readability    0–100: how much of this market is measurable at all, from
 *                  sample size, structure, drift, persistence and tie stability
 *   phase          'grid' | 'mixed' | 'continuous' — which prior applies
 *   verdict        one line for the journal
 */
export function marketDna(values, options = {}) {
    const prices = Array.isArray(values) ? values.map(Number) : [];
    const horizon = Math.min(10, Math.max(1, Math.round(safe(options.horizon, TICK_POSITIONS))));
    const usable = prices.length >= MIN_TICKS && prices.every(value => Number.isFinite(value));
    const empty = {
        windows: 0,
        tieHigh: 0,
        tieLow: 0,
        tieBandHigh: { low: 0, high: 1 },
        tieBandLow: { low: 0, high: 1 },
        fairPayoutHigh: new Array(horizon).fill(0),
        fairPayoutLow: new Array(horizon).fill(0),
        strictHigh: new Array(horizon).fill(0),
        strictLow: new Array(horizon).fill(0),
        arcSine: arcsinePrior(horizon),
        gridPrior: gridStrictPrior(horizon).positions,
        chi: 0,
        positionZ: new Array(horizon).fill(0),
        gridRatio: 0,
        driftZ: 0,
        rho: 0,
        expansion: 1,
        readability: 0,
        phase: 'cold',
        horizon,
        verdict: `warming up — ${prices.length}/${MIN_TICKS} usable quotes`,
    };
    if (!usable) return empty;

    // ---- windows ----------------------------------------------------------
    const first = Math.max(2, prices.length - 1000);
    const highCounts = new Array(horizon).fill(0);
    const lowCounts = new Array(horizon).fill(0);
    let windows = 0;
    let tieHigh = 0;
    let tieLow = 0;
    for (let i = first; i + horizon + 1 < prices.length; i++) {
        const window = prices.slice(i + 1, i + 1 + horizon);
        const high = Math.max(...window);
        const low = Math.min(...window);
        const highAt = window.indexOf(high);
        const lowAt = window.indexOf(low);
        windows += 1;
        if (window.filter(value => value === high).length === 1) highCounts[highAt] += 1;
        else tieHigh += 1;
        if (window.filter(value => value === low).length === 1) lowCounts[lowAt] += 1;
        else tieLow += 1;
    }
    if (!windows) return { ...empty, verdict: 'no completed windows yet' };

    const strictHigh = highCounts.map(value => value / windows);
    const strictLow = lowCounts.map(value => value / windows);
    const rateHigh = tieHigh / windows;
    const rateLow = tieLow / windows;

    // ---- grid ratio and change statistics ---------------------------------
    const changes = [];
    for (let i = Math.max(1, prices.length - 500); i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
    const magnitudes = changes.map(value => Math.abs(value)).filter(value => value > 0);
    const gridSize = magnitudes.length ? Math.min(...magnitudes) : 0;
    const meanChange = changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : 0;
    const variance = changes.length
        ? changes.reduce((sum, value) => sum + (value - meanChange) ** 2, 0) / changes.length
        : 0;
    const sigma = Math.sqrt(variance);
    const gridRatio = gridSize > 0 ? sigma / gridSize : 0;
    const driftZ = sigma > 0 ? (meanChange / (sigma / Math.sqrt(Math.max(1, changes.length)))) : 0;
    const rho = lagOneCorrelation(changes);
    const current = features(prices);
    const expansion = clamp(safe(current.expansion, 1), 0.25, 4);

    // ---- structure tests ---------------------------------------------------
    const arc = arcsinePrior(horizon);
    const expected = n => arc.map(value => value * (1 - n));
    const chiOf = (observed, tieRate) => {
        const exp = expected(tieRate);
        let chi = 0;
        for (let k = 0; k < horizon; k++) if (exp[k] > 0) chi += (observed[k] - exp[k]) ** 2 / exp[k];
        return chi;
    };
    const chi = (chiOf(strictHigh, rateHigh) + chiOf(strictLow, rateLow)) / 2;
    const positionZ = strictHigh.map((value, index) => {
        const p = arc[index] * (1 - rateHigh);
        return p > 0 ? (value - p) / Math.sqrt((p * (1 - p)) / windows) : 0;
    });

    // ---- readability -------------------------------------------------------
    // Five independent things that make a market measurable: enough windows, a
    // displacement from the fair prior, a drift, a persistence, and a tie rate
    // that is stable enough to forecast. A market can be unreadable and still be
    // tradable (the structural prior alone is a real, if thin, read) — this
    // score is advice for the strategy's own gate, not a veto in here.
    const sample = clamp(windows / 600, 0, 1);
    const structure = clamp(chi / 12, 0, 1);
    const drift = clamp(Math.abs(driftZ) / 4, 0, 1);
    const persistence = clamp(Math.abs(rho) / 0.15, 0, 1);
    const tie = clamp(0.55 + 0.45 * (1 - Math.min(1, rateHigh / 0.4)), 0, 1);
    const readability = clamp(
        100 * (0.3 * sample + 0.2 * structure + 0.18 * drift + 0.16 * persistence + 0.16 * tie),
        0,
        100
    );

    // The tie rate is a proportion measured on `windows` samples, so it has a
    // sampling error and the strategy's tie gate should respect it: a market
    // measured at 28 % ties with ±3 % is not "below 30 %", it is unknown. Wilson
    // keeps that honest at small samples, where the normal interval does not.
    const tieBandOf = rate => {
        const n = Math.max(1, windows);
        const zed = 1.96;
        const centre = (rate + (zed * zed) / (2 * n)) / (1 + (zed * zed) / n);
        const half =
            (zed * Math.sqrt((rate * (1 - rate)) / n + (zed * zed) / (4 * n * n))) / (1 + (zed * zed) / n);
        return { low: clamp(centre - half, 0, 1), high: clamp(centre + half, 0, 1) };
    };
    // The multiple this market's structure alone says each side is worth. A
    // quote above it is a bet on the model; a quote below it is a bet on the
    // pricing model being wrong, which is the only kind of edge this bot has.
    const fairOf = histogram => histogram.map(value => (value > 0 ? (1 - value) / value : 0));

    const phase = gridRatio <= 2.5 ? 'grid' : gridRatio >= 8 ? 'continuous' : 'mixed';
    const parts = [
        `${windows} windows`,
        `tie ${(rateHigh * 100).toFixed(1)}%`,
        `grid ${gridRatio.toFixed(1)}σ/step (${phase})`,
        `drift z ${driftZ.toFixed(1)}`,
        `ρ ${rho.toFixed(2)}`,
        `expansion ${expansion.toFixed(2)}`,
        `χ² ${chi.toFixed(1)}`,
        `readability ${readability.toFixed(0)}/100`,
    ];
    const verdict =
        phase === 'grid'
            ? 'grid-dominated: ties are frequent, the middle position is rare, price the strict probabilities'
            : phase === 'continuous'
              ? 'continuous-like: the arcsine structure applies and ties are rare'
              : 'mixed granularity: both structures are in play';

    return {
        windows,
        tieHigh: rateHigh,
        tieLow: rateLow,
        tieBandHigh: tieBandOf(rateHigh),
        tieBandLow: tieBandOf(rateLow),
        fairPayoutHigh: fairOf(strictHigh),
        fairPayoutLow: fairOf(strictLow),
        strictHigh,
        strictLow,
        arcSine: arc,
        gridPrior: gridStrictPrior(horizon).positions,
        chi,
        positionZ,
        gridRatio,
        driftZ,
        rho,
        expansion,
        readability,
        phase,
        horizon,
        summary: parts.join(' · '),
        verdict,
    };
}

/** Empty decision skeleton — every consumer sees every field, always. */
const emptyDecision = (extra = {}) => ({
    ready: false,
    modelReady: false,
    side: 0,
    tick: 0,
    probability: 0,
    winProbability: 0,
    samples: 0,
    conditionalSamples: 0,
    horizon: 0,
    tieRate: 0,
    tieForecast: 0,
    edge: 0,
    ev: NaN,
    breakEven: 0.5,
    payout: 0,
    payoutAt: 0,
    fairPayout: 0,
    evMargin: 0,
    evLower: 0,
    seEv: 0,
    evZ: 0,
    z: 0,
    confidence: 0,
    certainty: 0,
    agreement: 0,
    outcomeAgreement: 0,
    separation: 0,
    stderr: 0,
    decisive: 0,
    skill: 0,
    dnaScore: 0,
    dna: null,
    standDown: 0,
    intervalSeconds: 0,
    latencySeconds: 0,
    expectedLag: 0,
    horizonSeconds: 0,
    labelFidelity: 0,
    stakeable: 0,
    concurrent: 1,
    quoted: 0,
    evTable: [],
    ladderRows: [],
    models: [],
    league: [],
    probabilities: [],
    winProbabilities: [],
    evByOutcome: [],
    reason: '',
    version: PRICE_MODEL_VERSION,
    ...extra,
});

/**
 * Read the payout table into a per-outcome array of multiples.
 * Accepts `[H1..H5, L1..L5]`, `{ high: [...], low: [...] }`, or a single number.
 */
function payoutVector(payouts, count, isTick) {
    const vector = new Array(count).fill(0);
    const put = (index, value) => {
        const multiple = Number(value);
        if (index >= 0 && index < count && Number.isFinite(multiple) && multiple > 0) vector[index] = multiple;
    };
    if (Array.isArray(payouts)) {
        payouts.slice(0, count).forEach((value, index) => put(index, value));
    } else if (payouts && typeof payouts === 'object') {
        const positions = isTick ? TICK_POSITIONS : 1;
        (Array.isArray(payouts.high) ? payouts.high : []).slice(0, positions).forEach((value, index) => put(index, value));
        (Array.isArray(payouts.low) ? payouts.low : [])
            .slice(0, positions)
            .forEach((value, index) => put(isTick ? TICK_POSITIONS + index : 1, value));
        // Directional callers may name the two sides explicitly.
        if (!isTick) {
            if (payouts.call > 0) put(0, payouts.call);
            if (payouts.put > 0) put(1, payouts.put);
        }
    }
    return vector;
}

/**
 * @param values    the tick list (numbers or numeric strings)
 * @param mode      'tick' | 'rise' | 'step-hedge'
 * @param horizon   contract horizon in ticks (tick mode always uses 5)
 * @param threshold absolute probability floor; ≤ 0.02 (or absent) turns it off
 *                  and leaves the payout-derived edge gate in charge
 * @param options   { maxTie, minAgreement, minEdge, minEv, payout, payouts,
 *                    minProbability, minConfidence, entrySlip,
 *                    evidence, evidenceVeto } — `evidence` is { hits, samples }
 *                  from the caller's own ledger of graded decisions.
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
    const minEv = safe(options.minEv, 0);
    const payout = Number(options.payout);
    const payoutKnown = Number.isFinite(payout) && payout > 0;
    const entrySlip = clamp(Math.round(safe(options.entrySlip, 0)), 0, 4);
    // The execution clock. `interval` is the symbol's seconds per tick and
    // `latency` the bot's look-to-fill time; both come from the runtime's own
    // measurements (tick epochs, order round trip), never from a guess about the
    // market. With no interval the clock is unknown and no execution gate fires.
    const intervalSeconds = Math.max(0, safe(options.interval, 0));
    const latencySeconds = Math.max(0, safe(options.latency, DEFAULT_LATENCY));
    const clock = labelFidelity(intervalSeconds, latencySeconds);

    // The absolute floor is only applied when the strategy asked for one.
    const requestedFloor = Number.isFinite(Number(threshold)) ? Number(threshold) : NaN;
    const explicitFloor = Number.isFinite(requestedFloor) ? clamp(requestedFloor, 0, 1) : 0;
    const minProbability = clamp(
        safe(options.minProbability, explicitFloor > ABSOLUTE_FLOOR_OFF ? explicitFloor : 0),
        0,
        1
    );

    /**
     * The extreme structure of the last *settled* window, as a state key.
     *
     * This is what a decision taken on tick `index` can honestly know: for the
     * tick family, the five quotes ending at `index`; for the directional
     * family, the sign of the last `h` changes. It is the state behind the
     * `position` expert, and computing it from settled ticks only is what keeps
     * that expert's evidence walk-forward.
     */
    const historyAt = index => {
        if (isTick) {
            if (index - TICK_POSITIONS + 1 < 1) return { key: 'NA', position: 2 };
            const window = prices.slice(index - TICK_POSITIONS + 1, index + 1);
            const high = Math.max(...window);
            const low = Math.min(...window);
            const highAt = window.lastIndexOf(high);
            const lowAt = window.lastIndexOf(low);
            return { key: `H${highAt + 1}L${lowAt + 1}`, position: highAt };
        }
        if (index - h < 1) return { key: 'NA', position: 0 };
        return { key: `D${sign(prices[index] - prices[index - h])}`, position: sign(prices[index] - prices[index - h]) };
    };

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
        const history = historyAt(i);
        rows.push({
            index: i,
            state: stateAt(prices, i),
            winners,
            features: features(prices, i),
            historyKey: history.key,
            historyPosition: history.position,
        });
    }

    const n = rows.length;
    if (!rows.length || n < 200) {
        return emptyDecision({
            samples: n,
            horizon: isTick ? 5 : h,
            reason: `thin history — ${n}/200 completed windows`,
        });
    }
    const recentN = rows.filter((_, index) => index >= rows.length - RECENT_WINDOWS).length;
    if (recentN < 50) {
        return emptyDecision({
            samples: n,
            horizon: isTick ? 5 : h,
            reason: `thin recent window — ${recentN}/50`,
        });
    }

    const currentState = stateAt(prices, prices.length - 1);
    const currentFeatures = features(prices);
    const matched = rows.filter(row => row.state === currentState).length;
    const ties = rows.filter(row => row.winners.length === 0).length;
    const tieRate = isTick ? 0 : ties / n;

    // ---- the structural prior ---------------------------------------------
    // High/Low Tick has a structural prior, and it is not the uniform one. The
    // tie-aware prior below interpolates between the continuous arcsine law and
    // the enumerated one-increment grid walk using this market's measured tie
    // rate, so a Step Index is priced like a step index.
    const tieHistory = isTick
        ? {
              high: rows.filter(row => !row.winners.some(index => index < 5)).length / n,
              low: rows.filter(row => !row.winners.some(index => index >= 5)).length / n,
          }
        : { high: tieRate, low: tieRate };
    const tieLong = isTick ? (tieHistory.high + tieHistory.low) / 2 : tieRate;
    const strictPrior = isTick ? strictExtremePrior(TICK_POSITIONS, tieLong) : null;
    const anchor = isTick
        ? [...strictPrior, ...strictPrior]
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

    /**
     * Tie forecast for the *next* window.
     *
     * A tie cannot be bought — it loses on both sides — so the probability a
     * contract is paid on is the conditional position probability times the
     * chance that this window has a strict extreme at all. The forecast is the
     * mean of the last TIE_MEMORY windows, shrunk toward the long-run rate by
     * TIE_SHRINK pseudo-windows (a thin recent sample is not a discovery), and
     * divided by the measured volatility expansion: a market moving in larger
     * steps has fewer exact repeats of its extreme. That last step is a
     * first-order approximation of how tie probability scales with σ per tick,
     * and it is clamped so a wild expansion cannot wish ties away.
     */
    const tieForecastFor = offset => {
        const key = offset === 0 ? 'high' : 'low';
        if (!isTick) return tieRate;
        const flags = rows.slice(-TIE_MEMORY).map(row =>
            offset === 0 ? !row.winners.some(index => index < 5) : !row.winners.some(index => index >= 5)
        );
        const recent = flags.length ? flags.filter(Boolean).length / flags.length : tieHistory[key];
        const blended = (recent * flags.length + tieHistory[key] * TIE_SHRINK) / (flags.length + TIE_SHRINK);
        return clamp(blended / clamp(safe(currentFeatures.expansion, 1), 0.75, 1.5), 0, 0.75);
    };
    const tieForecast = isTick
        ? { high: tieForecastFor(0), low: tieForecastFor(5) }
        : { high: tieRate, low: tieRate };

    // ---- walk-forward scoring of the experts -------------------------------
    //
    // Integrity first. A window's outcome is only known once its last tick has
    // printed: row i runs from tick i+1 to i+LAG, so at a decision taken on tick
    // `t` only the rows with i <= t − LAG are settled. The accumulators below
    // are advanced with exactly those rows, which is what makes the Brier
    // scores, the mixture weights and the reported `skill` walk-forward rather
    // than in-sample. (A loop that tallies each row as it scores it lets the
    // most recent windows leak their own outcomes into their training set — the
    // classic way a backtest finds an edge that does not exist.)
    const LAG = isTick ? TICK_POSITIONS : h + 1;
    const start = Math.max(0, rows.length - SCORE_WINDOWS);
    const brierSum = PRICE_MODEL_NAMES.map(() => 0);
    const brierCount = PRICE_MODEL_NAMES.map(() => 0);
    /** The mixture's own walk-forward Brier — the number `skill` is measured on. */
    let blendSum = 0;
    let blendCount = 0;

    const globalCounts = blank();
    let globalTotal = 0;
    const stateCounts = new Map();
    const recentQueue = [];
    const recentCounts = blank();
    let recentTotal = 0;
    const positionCounts = new Map();
    const passed = []; // settled rows the models may learn from, with features
    const featureCount = 8; // bias + signs + rsi + stretch + expansion + run + history position
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

    /**
     * The ten experts, given the moment they are being asked about.
     *
     * Every state they read is passed in rather than taken from a module-level
     * "latest", so the same function scores the walk-forward replay and answers
     * the live question with the data that moment actually had.
     */
    const expertVectors = (moment, historyKey, historyPosition) => {
        const frequency = fromCounts(globalCounts, globalTotal, anchor);
        const stateTotal = stateCounts.get(moment.state);
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
                    ((row.features.rsi - moment.rsi) / 0.35) ** 2 +
                        ((row.features.slope - moment.slope) / 0.35) ** 2 +
                        ((row.features.stretch - moment.stretch) / 1.2) ** 2 +
                        ((row.features.expansion - moment.expansion) / 0.8) ** 2 +
                        ((row.features.run - moment.run) / 2.5) ** 2
                );
                const weight = Math.exp(-0.5 * distance * distance);
                if (weight < 0.02) continue;
                weightSum += weight;
                row.winners.forEach(index => {
                    if (index >= 0 && index < count) tallyAnalog[index] += weight;
                });
            }
            if (weightSum > 0) {
                analog = tallyAnalog.map(
                    (value, index) => (value + PRIOR * 0.25 * frequency[index]) / (weightSum + PRIOR * 0.25)
                );
            }
        }
        let drift = anchor.slice();
        if (!isTick) {
            // Read the prices the moment could see — never the live ones. A
            // walk-forward score is only a score if the expert was blind to the
            // window it is being graded on.
            const driftStart = Math.max(1, moment.index - 39);
            let move = 0;
            let movement = 0;
            for (let index = driftStart; index <= moment.index; index++) {
                const change = prices[index] - prices[index - 1];
                move += change;
                movement += Math.abs(change);
            }
            const steps = moment.index - driftStart + 1;
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
        /**
         * Serial dependence.
         *
         * Directional mode: an AR(1) fit on the changes, compounded over the
         * horizon. Tick mode has no directional question to answer, so the same
         * idea is applied to the *position* of the extreme: when the settled
         * windows have been printing their high late, the model nudges its
         * distribution late — and the walk-forward score decides whether that
         * persistence is real on this market.
         */
        let serial = anchor.slice();
        if (!isTick) {
            const z = serialLean(prices.slice(0, moment.index + 1), h);
            const up = clamp(normalCdf(z), 0.02, 0.98);
            serial = [up * (1 - tieRate * 0.5), (1 - up) * (1 - tieRate * 0.5)];
        } else {
            const recentPositions = passed
                .slice(-12)
                .map(row => (row.winners.length ? row.winners[0] % 5 : null))
                .filter(value => value !== null);
            if (recentPositions.length >= 6) {
                const mean = recentPositions.reduce((sum, value) => sum + value, 0) / recentPositions.length;
                const lean = clamp((mean - 2) / 2, -1, 1) * 0.35;
                const highTilt = normalise(
                    strictPrior.map((value, pos) => value * Math.exp(lean * (pos - 2))),
                    strictPrior
                );
                const lowTilt = normalise(
                    strictPrior.map((value, pos) => value * Math.exp(-lean * (pos - 2))),
                    strictPrior
                );
                serial = [...highTilt, ...lowTilt];
            }
        }
        const featureRow = [
            1,
            sign(prices[moment.index] - prices[moment.index - 1]),
            sign(prices[moment.index - 1] - prices[moment.index - 2]),
            moment.rsi,
            moment.stretch,
            clamp(moment.expansion, 0, 3),
            clamp(moment.run, -6, 6) / 6,
            isTick ? (historyPosition - 2) / 2 : moment.run >= 0 ? 0.5 : -0.5,
        ];
        const neural = softmax(
            weights.map(row => row.reduce((sum, value, index) => sum + value * featureRow[index], 0))
        );
        // The regime expert asks a different question from every other model
        // here: not "which way is it going" but "what kind of market is this?".
        // A quiet market that has stretched away from its short mean tends to
        // pull back (mean reversion); a market whose volatility is expanding
        // after a directional run tends to continue. The switch is read from
        // the expansion ratio, so the model changes its hypothesis with the
        // regime instead of applying one rule everywhere. It is scored like the
        // rest, so on a market where neither tendency exists it simply loses
        // its vote.
        const regime = tickRegime(moment);
        let regimeVector;
        if (isTick) {
            // Tick contracts ask about the extreme, not the direction: a rising,
            // expanding tape pushes the high late and the low early; a quiet,
            // stretched tape pulls both back toward where the move started.
            const tiltAmount =
                regime === 'expansion'
                    ? 0.35 * clamp(moment.expansion - 1, 0, 1.5) * Math.sign(moment.slope || 0)
                    : regime === 'reversion'
                      ? -0.35 * clamp(Math.abs(moment.stretch) - 1, 0, 1.5) * Math.sign(moment.stretch || 0)
                      : 0;
            const tilt = offset => {
                const direction = offset === 0 ? tiltAmount : -tiltAmount;
                return normalise(
                    strictPrior.map((value, pos) => value * Math.exp(clamp(direction, -1, 1) * (pos - 2))),
                    strictPrior
                );
            };
            regimeVector = [...tilt(0), ...tilt(5)];
        } else if (regime === 'expansion') {
            const z = clamp(moment.slope * 2.2, -2.5, 2.5);
            const up = clamp(normalCdf(z), 0.03, 0.97);
            regimeVector = [up * (1 - tieRate * 0.5), (1 - up) * (1 - tieRate * 0.5)];
        } else if (regime === 'reversion') {
            const z = clamp(-moment.stretch * 0.9, -2.5, 2.5);
            const up = clamp(normalCdf(z), 0.03, 0.97);
            regimeVector = [up * (1 - tieRate * 0.5), (1 - up) * (1 - tieRate * 0.5)];
        } else {
            regimeVector = frequency.slice();
        }
        // Position: the Markov row for the last settled window's extreme.
        const bucket = positionCounts.get(historyKey);
        const position = bucket ? fromCounts(bucket.counts, bucket.total, frequency) : frequency.slice();
        return {
            anchor,
            frequency,
            transition,
            recent,
            analog,
            drift,
            serial,
            neural,
            regime: regimeVector,
            position,
        };
    };

    /** Fold one settled window into every accumulator, and train the net on it. */
    const advance = row => {
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
        const positionBucket = positionCounts.get(row.historyKey) || { counts: blank(), total: 0 };
        tally(positionBucket.counts, row.winners);
        positionBucket.total += 1;
        positionCounts.set(row.historyKey, positionBucket);

        // One softmax gradient step on this window's features. The row is
        // settled, so this is learning from the past, never from the future.
        const [previousSign, latestSign] = row.state.split(',').map(Number);
        const featureRow = [
            1,
            latestSign,
            previousSign,
            row.features.rsi,
            row.features.stretch,
            clamp(row.features.expansion, 0, 3),
            clamp(row.features.run, -6, 6) / 6,
            isTick ? (row.historyPosition - 2) / 2 : row.historyPosition * 0.5,
        ];
        const output = softmax(
            weights.map(weightRow => weightRow.reduce((sum, value, idx) => sum + value * featureRow[idx], 0))
        );
        for (let k = 0; k < count; k++) {
            const target = row.winners.includes(k) ? 1 : 0;
            const error = output[k] - target;
            for (let position = 0; position < featureCount; position++) {
                weights[k][position] -= learningRate * error * featureRow[position];
            }
        }
        passed.push(row);
    };

    // Queue scores until their window has settled. Overlapping windows must
    // not influence the expert weights before their outcomes are available.
    const pendingScores = new Map();
    const settleScore = index => {
        const pending = pendingScores.get(index);
        if (!pending) return;
        pending.losses.forEach((loss, modelIndex) => {
            brierSum[modelIndex] += loss;
            brierCount[modelIndex] += 1;
        });
        blendSum += pending.blendLoss;
        blendCount += 1;
        pendingScores.delete(index);
    };
    for (let index = 0; index < rows.length; index++) {
        if (index >= start) {
            const row = rows[index];
            const vectors = expertVectors(
                { ...row.features, state: row.state, index: row.index },
                row.historyKey,
                row.historyPosition
            );
            // Form the blend before scoring this row, using settled scores only.
            const liveWeights = mixtureWeights(
                brierSum.map((value, modelIndex) => (brierCount[modelIndex] ? value / brierCount[modelIndex] : 1))
            );
            const blendNow = new Array(count).fill(0);
            PRICE_MODEL_NAMES.forEach((name, modelIndex) => {
                vectors[name].forEach((value, outcome) => {
                    blendNow[outcome] += liveWeights[modelIndex] * value;
                });
            });
            pendingScores.set(index, {
                losses: PRICE_MODEL_NAMES.map(name => score(vectors[name], row.winners)),
                blendLoss: score(blendNow, row.winners),
            });
        }
        const settled = index - LAG;
        if (settled >= 0) {
            settleScore(settled);
            advance(rows[settled]);
        }
    }
    // All historical windows are settled by the pending live decision.
    for (let index = Math.max(0, rows.length - LAG); index < rows.length; index++) {
        settleScore(index);
        advance(rows[index]);
    }

    // The moment the pending decision is being asked about: the last quote, its
    // features, and the state of the last settled window.
    const pendingHistory = historyAt(prices.length - 1);

    const brier = brierSum.map((value, index) => (brierCount[index] ? value / brierCount[index] : 1));
    const mixture = mixtureWeights(brier);
    const anchorBrier = brier[PRICE_MODEL_NAMES.indexOf('anchor')] > 0 ? brier[PRICE_MODEL_NAMES.indexOf('anchor')] : 1;
    const ensembleBrier = blendCount ? blendSum / blendCount : anchorBrier;
    /**
     * Walk-forward skill against the structural anchor: 0 means "no better than
     * the prior", 0.1 means "a tenth of the anchor's loss removed".
     *
     * This is the engine's self-audit, and it is used, not just printed. A blend
     * that cannot beat the tie-aware prior on the windows it already saw has not
     * earned the right to publish a 60 % probability; it is shrunk back toward
     * the anchor instead. The switch is smooth (a logistic around 0.8 % skill)
     * so a market that only just turns informative is trusted gradually rather
     * than flipping between two behaviours.
     */
    const skill = clamp(1 - ensembleBrier / anchorBrier, -1, 1);
    const skillTrust = 0.3 + 0.7 / (1 + Math.exp(-(skill - 0.008) * 80));
    const experts = expertVectors(
        { ...currentFeatures, state: currentState, index: prices.length - 1 },
        pendingHistory.key,
        pendingHistory.position
    );
    const blended = new Array(count).fill(0);
    PRICE_MODEL_NAMES.forEach((name, modelIndex) => {
        experts[name].forEach((value, outcome) => {
            blended[outcome] += mixture[modelIndex] * value;
        });
    });

    // Shrink toward the anchor by the effective sample size: a thin state is
    // an anchor, not a discovery.
    const effective = Math.max(0, Math.min(matched, recentN));
    const trust = (effective / (effective + SHRINK)) * skillTrust;
    /** Pseudo-independent windows behind one probability. */
    const votes = effective + SHRINK;
    let probabilities = normalise(
        blended.map((value, index) => trust * value + (1 - trust) * anchor[index]),
        anchor
    );

    // High/Low Tick is two separate bets: "the strict high prints at tick k"
    // and "the strict low prints at tick k". The market prices each of them as
    // a probability over the five positions, so each side must sum to one.
    // The joint ten-outcome vector sums to two, and reading half of it as a win
    // probability is what made a payout-aware tick gate unreachable.
    if (isTick) {
        [0, 5].forEach(offset => {
            const mass = probabilities.slice(offset, offset + 5).reduce((sum, value) => sum + value, 0);
            if (mass > 0) {
                for (let k = offset; k < offset + 5; k++) probabilities[k] /= mass;
            }
        });
    }

    // ---- entry slip --------------------------------------------------------
    // A decision executed `entrySlip` ticks late shares only (5 − slip) of its
    // window with the ticks the model saw, so the conditional part of the
    // estimate decays like √((5 − slip)/5) toward the anchor. This is the
    // difference between a replay and a fill, and it is charged, not ignored.
    if (entrySlip > 0) {
        const horizonTicks = isTick ? TICK_POSITIONS : h;
        const decay = Math.sqrt(Math.max(0, horizonTicks - entrySlip) / horizonTicks);
        probabilities = normalise(
            probabilities.map((value, index) => anchor[index] + decay * (value - anchor[index])),
            anchor
        );
        if (isTick) {
            [0, 5].forEach(offset => {
                const mass = probabilities.slice(offset, offset + 5).reduce((sum, value) => sum + value, 0);
                if (mass > 0) {
                    for (let k = offset; k < offset + 5; k++) probabilities[k] /= mass;
                }
            });
        } else {
            probabilities = normalise(probabilities, anchor);
        }
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
    const payoutProbe = payoutKnown ? payout : isTick ? 1 / TICK_POSITIONS : 0.5;
    // Reliability, not wishful thinking. The record is scored against what the
    // rule actually claimed (the mean win probability of the decisions it
    // published), not against the break-even of the payout: predicting 22 % and
    // realising 20 % is an over-confident model even when both numbers sit
    // above the bar. Without a mean prediction (older callers) the break-even
    // comparison is the only available reference and is used instead.
    const meanPredicted = Number(evidence?.mean);
    if (graded >= MIN_EVIDENCE_SAMPLES && Number.isFinite(evidenceRate) && payoutProbe > 0) {
        const reference = Number.isFinite(meanPredicted) && meanPredicted > 0
            ? meanPredicted
            : breakEvenProbability(payoutProbe, 0.5);
        const ratio = evidenceRate / reference;
        calibration = clamp(ratio < 1 ? ratio + (1 - ratio) * 0.15 : 1 + Math.min(0.25, (ratio - 1) * 0.6), 0.35, 1.25);
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

    // ---- win probabilities: the tie discount ------------------------------
    // The conditional distribution says *where* the extreme sits; the tie
    // forecast says whether the market prints one at all. A contract is paid on
    // the product, so every gate, stake and EV below uses that number.
    const winProbabilities = probabilities.map((value, index) =>
        isTick ? value * (1 - (index < 5 ? tieForecast.high : tieForecast.low)) : value
    );

    // ---- payouts and the EV scan -----------------------------------------
    const payouts = payoutVector(options.payouts, count, isTick);
    const quotedCount = payouts.filter(value => value > 0).length;
    const payoutOf = index => (payouts[index] > 0 ? payouts[index] : payoutKnown ? payout : 0);
    const breakEvenOf = index => {
        const multiple = payoutOf(index);
        if (multiple > 0) return breakEvenProbability(multiple, isTick ? 1 / TICK_POSITIONS : 0.5);
        return isTick ? 1 / TICK_POSITIONS : 0.5;
    };
    const evOf = index => {
        const multiple = payoutOf(index);
        if (!(multiple > 0)) return NaN;
        return winProbabilities[index] * (1 + multiple) - 1;
    };
    /**
     * Standard error of that expected value.
     *
     * An EV is a probability multiplied by a payout, so its noise is
     * `(1 + multiple) · √(p(1−p)/n)`. It matters because the bot does not buy
     * the *average* contract, it buys the **best of ten** — and the maximum of
     * ten noisy estimates is biased upward by roughly the noise itself. On a
     * fair market that bias is the entire apparent edge, which is why the entry
     * gate compares a one-sigma *lower bound* with `minEv` rather than the point
     * estimate. (`evZ` sets how many sigmas; 0 restores the naive gate.)
     *
     * It is a multiple-comparison correction, not a promise: ten quotes are not
     * ten independent draws, so the bound is approximate. It is still the
     * difference between "this quote is mispriced" and "this quote is the
     * luckiest of ten".
     */
    const evZ = Math.max(0, safe(options.evZ, isTick ? 1 : 0));
    const seEvOf = index => {
        const multiple = payoutOf(index);
        const p = clamp(winProbabilities[index], 0, 1);
        return (1 + (multiple > 0 ? multiple : 0)) * Math.sqrt((p * (1 - p)) / Math.max(1, votes));
    };
    const evLowerOf = index => {
        const value = evOf(index);
        return Number.isFinite(value) ? value - evZ * seEvOf(index) : NaN;
    };
    const fairPayoutOf = index =>
        winProbabilities[index] > 0 ? (1 - winProbabilities[index]) / winProbabilities[index] : 0;

    // Rank by expected value when the market has quoted enough of the ladder to
    // make the comparison meaningful, otherwise by probability (which is the
    // v4 behaviour and the only sane fallback before quotes arrive).
    const evRanked = winProbabilities
        .map((probability, index) => ({ probability, index, ev: evOf(index) }))
        .filter(entry => Number.isFinite(entry.ev))
        .sort((left, right) => right.ev - left.ev);
    const ranked = winProbabilities
        .map((probability, index) => ({ probability, index, ev: evOf(index) }))
        .sort((left, right) => right.probability - left.probability);
    const useEv = quotedCount >= (isTick ? 4 : 1) && evRanked.length > 0;
    const best = useEv ? { probability: evRanked[0].probability, index: evRanked[0].index } : ranked[0];
    const runnerUp = ranked.find(entry => entry.index !== best.index) || { probability: 0, index: -1 };
    const evRunnerUp = evRanked.find(entry => entry.index !== best.index);
    const side = isTick ? (best.index < 5 ? 1 : -1) : best.index === 0 ? 1 : -1;
    const tick = isTick ? (best.index % 5) + 1 : 0;
    const bestEv = evOf(best.index);
    const evMargin =
        Number.isFinite(bestEv) && evRunnerUp && Number.isFinite(evRunnerUp.ev) ? bestEv - evRunnerUp.ev : 0;

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

    const separation = ranked[0].probability - runnerUp.probability;
    const stderr = Math.sqrt((best.probability * (1 - best.probability)) / Math.max(1, votes));
    // Separation is scored on its own scale: five points of separation is a
    // mountain when the pick is one of ten tick positions and a rounding error
    // when it is one of two directions.
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
    const winProbability = winProbabilities[best.index];
    const breakEven = breakEvenOf(best.index);
    const edge = winProbability - breakEven;
    const ev = bestEv;
    const z = stderr > 0 ? edge / stderr : 0;
    const decisive = isTick ? winProbability : tieRate < 1 ? winProbability / (1 - tieRate) : 0;

    // ---- expert league table ----------------------------------------------
    // Brier skill against the anchor: 0 means "no better than the structural
    // prior", 0.1 means "10 % of the anchor's loss removed". The anchor scores
    // itself, so the comparison is always available, even on a thin sample.
    const league = PRICE_MODEL_NAMES.map((name, modelIndex) => ({
        name,
        weight: mixture[modelIndex],
        brier: brier[modelIndex],
        skill: 1 - brier[modelIndex] / anchorBrier,
        probability: experts[name][best.index],
    })).sort((left, right) => right.skill - left.skill);
    const models = PRICE_MODEL_NAMES.map((name, modelIndex) => ({
        name,
        weight: mixture[modelIndex],
        brier: brier[modelIndex],
        skill: 1 - brier[modelIndex] / anchorBrier,
        probability: experts[name][best.index],
    }));

    // Certainty folds the measured skill and the measured value into the
    // confidence, so "80 % confident" cannot coexist with "no walk-forward
    // skill" on the same line.
    const skillScore = clamp(50 + 200 * skill, 0, 100);
    const evScore = Number.isFinite(ev) ? clamp(50 + 500 * ev, 0, 100) : 50;
    const certainty = clamp(0.5 * confidence + 0.25 * skillScore + 0.25 * evScore, 0, 100);

    // A record that is statistically below break-even is a reason to stand
    // down, not to double the stake. The Wilson upper bound is used so a small
    // sample cannot stop a bot: only a record that is *still* under the line
    // with its whole interval counts.
    let standDown = 0;
    if (graded >= STAND_DOWN_SAMPLES && Number.isFinite(evidenceRate)) {
        const zed = 1.64;
        const centre = (evidenceRate + (zed * zed) / (2 * graded)) / (1 + (zed * zed) / graded);
        const half =
            (zed * Math.sqrt((evidenceRate * (1 - evidenceRate)) / graded + (zed * zed) / (4 * graded * graded))) /
            (1 + (zed * zed) / graded);
        standDown = centre + half < breakEven ? 1 : 0;
    }

    const dna = isTick ? marketDna(prices, { horizon: TICK_POSITIONS }) : null;

    /**
     * The whole ladder, as the bot would read it off a screen: every one of the
     * ten contracts, its own probability, the multiple the market quotes, the
     * multiple its structure says is fair, and the expected value of buying it
     * at that quote. `payout` is 0 where the ladder has not quoted a position —
     * those rows are listed but not rankable, which is exactly how a partially
     * filled table behaves in practice.
     */
    const evTable = winProbabilities.map((probability, index) => {
        const multiple = payoutOf(index);
        const evThis = evOf(index);
        return {
            outcome: index,
            side: isTick ? (index < 5 ? 1 : -1) : index === 0 ? 1 : -1,
            tick: isTick ? (index % 5) + 1 : 0,
            label: isTick ? `${index < 5 ? 'H' : 'L'}${(index % 5) + 1}` : index === 0 ? 'RISE' : 'FALL',
            probability,
            winProbability: probability,
            payout: multiple,
            fairPayout: (1 - probability) / (probability || 1),
            breakEven: breakEvenOf(index),
            ev: evThis,
            evLower: evLowerOf(index),
            seEv: seEvOf(index),
            stakeable: Number.isFinite(evThis) && evThis > 0 && evLowerOf(index) > 0,
        };
    });
    const ladderRows = evTable.slice().sort((left, right) => {
        const leftEv = Number.isFinite(left.ev) ? left.ev : -Infinity;
        const rightEv = Number.isFinite(right.ev) ? right.ev : -Infinity;
        return rightEv - leftEv;
    });
    const quoted = evTable.filter(entry => entry.payout > 0).length;

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
        winProbability,
        samples: n,
        conditionalSamples: matched,
        horizon: isTick ? 5 : h,
        tieRate: isTick ? tieLong : tieRate,
        tieForecast: isTick ? (side > 0 ? tieForecast.high : tieForecast.low) : tieRate,
        edge,
        ev,
        breakEven,
        payout: payoutKnown ? payout : 0,
        payoutAt: payoutOf(best.index),
        fairPayout: fairPayoutOf(best.index),
        evLower: evLowerOf(best.index),
        seEv: seEvOf(best.index),
        evZ,
        evMargin,
        z,
        confidence,
        certainty,
        agreement: agreeWeight,
        outcomeAgreement: outcomeAgreeWeight,
        separation,
        stderr,
        decisive,
        skill,
        dnaScore: dna ? dna.readability : 0,
        dna: dna || null,
        standDown,
        // Execution clock: how long the contract's five ticks take, how far the
        // fill can slip past the quote the model saw, and therefore how much of
        // a five-tick cycle one buy actually covers.
        intervalSeconds,
        latencySeconds,
        expectedLag: clock.expectedLag,
        horizonSeconds: isTick ? clock.horizon : intervalSeconds * h,
        labelFidelity: intervalSeconds > 0 ? clock.fidelity : 0,
        stakeable: isTick ? clock.stakeable : 1,
        concurrent: isTick ? clock.concurrent : 1,
        quoted,
        evTable,
        ladderRows,
        models,
        league,
        probabilities,
        winProbabilities,
        evByOutcome: winProbabilities.map((_, index) => evOf(index)),
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
    // A fill that slips past the first tick of the window is not trading the
    // window that was scored. On a one-second market the default round trip is
    // already a third of a tick, and a 1HZ market half of one; past three
    // quarters of a tick the alignment is a coin flip and the honest answer is
    // no. The bot says which market is too fast for it rather than being wrong
    // quietly.
    if (isTick && intervalSeconds > 0 && clock.expectedLag >= 0.75) {
        return {
            ...result,
            reason:
                `execution — ${latencySeconds.toFixed(2)}s to fill on a ${intervalSeconds.toFixed(0)}s tick ` +
                `is ${clock.expectedLag.toFixed(2)} ticks of slip; the five-tick window would start late`,
        };
    }
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
    if (minProbability > 0 && winProbability < minProbability) {
        return {
            ...result,
            reason: `below floor — ${(winProbability * 100).toFixed(1)}% < ${(minProbability * 100).toFixed(1)}%`,
        };
    }
    // The value gate, in order of what it can prove:
    //
    //   minEv   — the chosen contract's expected value per unit staked. This is
    //             the honest test on this family, because the ten outcomes are
    //             quoted separately, and it is the gate the shipped preset uses.
    //   minEdge — probability minus the break-even the quote implies, kept for
    //             strategies that want a probability margin instead.
    const evLower = evLowerOf(best.index);
    if (requireEdge && minEv > 0 && Number.isFinite(ev) && !(evLower >= minEv)) {
        return {
            ...result,
            reason:
                `no value — EV ${(ev * 100).toFixed(1)}% at a ${payoutOf(best.index).toFixed(2)}× quote ` +
                `(fair ${fairPayoutOf(best.index).toFixed(2)}×, one-sigma floor ${(evLower * 100).toFixed(1)}%, ` +
                `needs ${(minEv * 100).toFixed(1)}%)`,
        };
    }
    const valueGate = requireEdge && (!isTick || minEdge > 0);
    if (valueGate && edge < minEdge) {
        const need = (breakEven + minEdge) * 100;
        return {
            ...result,
            reason: `no edge — ${(winProbability * 100).toFixed(1)}% vs break-even ${(breakEven * 100).toFixed(1)}% (needs ${need.toFixed(1)}%)`,
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
    const quote = payoutOf(best.index) > 0 ? ` · quote ${payoutOf(best.index).toFixed(2)}×` : '';
    const summary = isTick
        ? `${side > 0 ? 'HIGH' : 'LOW'} tick ${tick} · p ${(winProbability * 100).toFixed(1)}% ` +
          `(tie ${(result.tieForecast * 100).toFixed(1)}%)${quote} · EV ${Number.isFinite(ev) ? `${(ev * 100).toFixed(1)}%` : 'n/a'} ` +
          `${evZ > 0 && Number.isFinite(evLower) ? `(floor ${(evLower * 100).toFixed(1)}%) ` : ''}` +
          `· fair ${fairPayoutOf(best.index).toFixed(2)}× · skill ${(skill * 100).toFixed(0)} ` +
          `· conf ${confidence.toFixed(0)} · agree ${(agreeWeight * 100).toFixed(0)}% · ` +
          `${intervalSeconds > 0 ? `${(intervalSeconds * TICK_POSITIONS).toFixed(0)}s` : '5 ticks'}` +
          `${intervalSeconds > 0 && clock.expectedLag > 0.05 ? ` · slip ${clock.expectedLag.toFixed(2)}t` : ''}${record}`
        : `${side > 0 ? 'RISE' : 'FALL'} · p ${(winProbability * 100).toFixed(1)}% · break-even ${(breakEven * 100).toFixed(1)}% · edge ${(edge * 100).toFixed(1)}pt · tie ${(tieRate * 100).toFixed(1)}% · conf ${confidence.toFixed(0)} · agree ${(agreeWeight * 100).toFixed(0)}% · ${h} ticks${record}`;

    return { ...result, ready: true, reason: summary };
}

export default {
    priceDecision,
    marketDna,
    labelFidelity,
    PRICE_MODEL_NAMES,
    PRICE_MODEL_VERSION,
    breakEvenProbability,
    serialLean,
    arcsinePrior,
    gridStrictPrior,
    strictExtremePrior,
    lagOneCorrelation,
};
