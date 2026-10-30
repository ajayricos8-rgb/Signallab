/**
 * Price-path ensemble for the shipped DBot strategies — v6 (APEX core).
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
 *   neural      a deep online network (8 features → 10 tanh units → softmax),
 *               trained walk-forward on completed windows only, with L2
 *               regularisation. The internal built-in AI: it never sees the
 *               future, and it is scored like every other expert, so a
 *               decorative net loses its vote.
 *   regime      expansion → the extreme prints late; quiet-and-stretched →
 *               the extreme prints early. On a fair stream it loses its vote.
 *   position    a Markov chain on the previous window's strict extreme
 *               (H1…H5, L1…L5, T). Consecutive windows overlap four ticks, so
 *               their outcomes are correlated even when the increments are not.
 *   volatility  v6: the expansion-adjusted tilt. A rising, expanding tape
 *               pushes the high late and the low early with a strength that
 *               scales with the measured expansion instead of a fixed constant.
 *   microtrend  v6: short-horizon pressure from RSI, slope and stretch fused
 *               into one continuous lean, per side.
 *   range       v6: the structure selector. Compressed volatility behaves like
 *               the grid walk, expanded volatility like the continuous walk;
 *               this expert interpolates the prior between the two by the
 *               measured expansion instead of asserting one shape everywhere.
 *   entropy     v6: concentration reader. When the recent extreme histogram is
 *               concentrated (low Shannon entropy) it persists the modal shape;
 *               when it is diffuse it abstains to the frequency table.
 *   hurst       v6: long-memory probe. An R/S Hurst exponent above ~0.55 tilts
 *               with the trend, below ~0.45 tilts against the stretched move,
 *               and near a half it abstains.
 *   cycle       v6: extreme-phase persistence. The lag-1 autocorrelation of
 *               the settled extreme positions decides whether the next window
 *               inherits the last window's phase or reverts to the base rate.
 *
 * The mixture weights are not hand-picked. Each model is scored with a Brier
 * loss over the windows it would have predicted, and the weights follow the
 * multiplicative-weights rule (exponential in relative loss), gated per market
 * regime: the engine keeps a separate scoreboard for expansion, reversion and
 * balanced tape, and blends the global weights with the live regime's
 * scoreboard, so an expert that reads trends but not ranges is trusted exactly
 * when a trend is on. A model that is useless on this market — a drift model
 * on a fixed-step index, say — loses weight by itself; a model that reads the
 * market keeps it. That is the same adaptive-expert design the digit brain
 * uses, applied to price contracts.
 *
 * What v6 changed, and why
 * ------------------------
 *   Six new experts (volatility, microtrend, range, entropy, hurst, cycle),
 *   each scored walk-forward like the original ten, so the league is now
 *   sixteen models and the mixture has a specialist for volatility structure,
 *   short-horizon pressure, granularity selection, concentration, long memory
 *   and extreme-phase persistence.
 *
 *   A deep online brain. The `neural` expert is now a two-layer network
 *   (8 → 10 tanh → softmax) trained walk-forward with backpropagation and L2
 *   decay. Its update count, hidden-layer norm and learning rate are reported
 *   in `decision.brain`, and the `x_price_brain` block prints them.
 *
 *   Regime-gated mixture (meta-learner). Brier scoreboards are kept per
 *   regime, and the live mixture blends the global weights with the live
 *   regime's weights, so regime specialists are trusted when their regime is
 *   on. The walk-forward replay scores the gated blend, keeping `skill` honest.
 *
 *   Market DNA v2 — the auto-reverse-engineering layer. The fingerprint now
 *   carries the Hurst exponent, extreme entropy, jump rate, extreme-phase
 *   autocorrelation, tie clustering, range compression and an `autoTune`
 *   recommendation (EV caution, slip charge, anchor trust) derived from the
 *   measured phase. The `x_price_reverse` block prints the whole diagnosis.
 *
 *   Per-outcome calibration. When the runtime supplies a per-outcome graded
 *   record, each outcome's probability is reliability-adjusted against what
 *   that outcome claimed — a high-tick-3 read that keeps missing is shrunk
 *   without punishing the reads that earned their keep.
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
    'volatility',
    'microtrend',
    'range',
    'entropy',
    'hurst',
    'cycle',
];

/** Bumped whenever the decision shape or its gates change meaning. */
export const PRICE_MODEL_VERSION = 6;

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
/** Hidden units of the online deep net behind the `neural` expert (v6). */
const NET_HIDDEN = 10;
/** Learning rate and L2 decay of that net's walk-forward gradient steps. */
const NET_LEARNING_RATE = 0.05;
const NET_L2 = 0.0005;
/** Regime scoreboard samples needed before the meta-learner trusts a regime. */
const REGIME_MIN_SAMPLES = 25;
/** Blend between the global mixture and the live regime's mixture. */
const REGIME_BLEND = 0.45;
/** Changes read by the Hurst probe (v6 `hurst` expert and DNA v2). */
const HURST_LOOKBACK = 120;
/** Recent settled rows read by the concentration and phase experts. */
const SHAPE_LOOKBACK = 60;

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
 * Normalised Shannon entropy of a histogram: 0 when one bin holds everything,
 * 1 when the mass is spread evenly. Used by the `entropy` expert (concentration
 * reader) and by market DNA v2.
 */
export function entropyOf(histogram) {
    if (!Array.isArray(histogram) || histogram.length < 2) return 1;
    const total = histogram.reduce((sum, value) => sum + Math.max(0, safe(value, 0)), 0);
    if (!(total > 0)) return 1;
    let entropy = 0;
    for (const value of histogram) {
        const p = Math.max(0, safe(value, 0)) / total;
        if (p > 0) entropy -= p * Math.log2(p);
    }
    return clamp(entropy / Math.log2(histogram.length), 0, 1);
}

/**
 * Hurst exponent by the rescaled-range (R/S) method on a change series.
 *
 * H ≈ 0.5 is an uncorrelated walk, H > 0.55 suggests persistence (trends
 * continue) and H < 0.45 suggests anti-persistence (moves revert). A single
 * window over the supplied changes keeps it O(n); the caller decides the
 * lookback so the walk-forward replay stays blind to the future.
 */
export function hurstExponent(changes) {
    if (!Array.isArray(changes) || changes.length < 32) return 0.5;
    const series = changes.map(value => safe(value, 0));
    const n = series.length;
    const mean = series.reduce((sum, value) => sum + value, 0) / n;
    let cumulative = 0;
    let peak = -Infinity;
    let trough = Infinity;
    let variance = 0;
    for (const value of series) {
        cumulative += value - mean;
        if (cumulative > peak) peak = cumulative;
        if (cumulative < trough) trough = cumulative;
        variance += (value - mean) ** 2;
    }
    const deviation = Math.sqrt(variance / n);
    if (!(deviation > 0) || !(peak > trough)) return 0.5;
    const rs = (peak - trough) / deviation;
    if (!(rs > 0)) return 0.5;
    return clamp(Math.log(rs) / Math.log(n), 0.05, 0.95);
}

/**
 * Tilt a five-position tick prior along the tape.
 *
 * Positive `lean` pushes the HIGH extreme late (tick 5) and the LOW extreme
 * early (tick 1) — the shape of a rising drift (§3.4 of the research file);
 * negative lean mirrors it. Shared by every v6 expert that reads direction so
 * they all speak the same geometry.
 */
function tiltTick(base, lean) {
    const k = clamp(safe(lean, 0), -1, 1);
    const high = normalise(
        base.map((value, pos) => value * Math.exp(k * (pos - 2))),
        base
    );
    const low = normalise(
        base.map((value, pos) => value * Math.exp(-k * (pos - 2))),
        base
    );
    return [...high, ...low];
}

/** Directional two-vector from a z-score, carrying the market's tie mass. */
function upVector(z, tieRate) {
    const up = clamp(normalCdf(clamp(safe(z, 0), -2.5, 2.5)), 0.02, 0.98);
    return [up * (1 - tieRate * 0.5), (1 - up) * (1 - tieRate * 0.5)];
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
 *
 * v6 (DNA v2) adds the auto-reverse-engineering layer — deeper measurements of
 * the same ticks, plus the tuning the bot derives from them on its own:
 *
 *   hurst          R/S Hurst exponent of the tick changes (0.5 = no memory)
 *   entropyHigh    normalised Shannon entropy of the high-side extreme shape
 *   entropyLow     normalised Shannon entropy of the low-side extreme shape
 *   jumpRate       share of moves larger than 3× the median move (spike tape)
 *   extremeAutocorr lag-1 autocorrelation of the settled high positions
 *   tieClustering  Fano factor of tie counts across 20-window blocks (1 = even)
 *   compression    recent window range / longer-run window range (<1 squeezed)
 *   tickSigma      σ per tick in price units
 *   autoTune       { evZ, slip, anchorTrust, note } — the caution the measured
 *                  phase implies: grid tape gets a wider EV bound, jumpy tape
 *                  a heavier anchor, compressed tape a patience note
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
        hurst: 0.5,
        entropyHigh: 1,
        entropyLow: 1,
        jumpRate: 0,
        extremeAutocorr: 0,
        tieClustering: 1,
        compression: 1,
        tickSigma: 0,
        autoTune: { evZ: 1, slip: 1, anchorTrust: 0.5, note: 'cold — nothing measured yet' },
        verdict: `warming up — ${prices.length}/${MIN_TICKS} usable quotes`,
    };
    if (!usable) return empty;

    // ---- windows ----------------------------------------------------------
    const first = Math.max(2, prices.length - 1000);
    const highCounts = new Array(horizon).fill(0);
    const lowCounts = new Array(horizon).fill(0);
    const highPhase = [];
    const tieHighFlags = [];
    const windowRanges = [];
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
        const highTied = window.filter(value => value === high).length !== 1;
        const lowTied = window.filter(value => value === low).length !== 1;
        if (!highTied) highCounts[highAt] += 1;
        else tieHigh += 1;
        if (!lowTied) lowCounts[lowAt] += 1;
        else tieLow += 1;
        highPhase.push(highTied ? 2 : highAt);
        tieHighFlags.push(highTied ? 1 : 0);
        windowRanges.push(high - low);
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

    // ---- DNA v2: the auto-reverse-engineering layer ------------------------
    // Everything above describes the market's shape; these fields describe its
    // memory, its spikes and its rhythm — the measurements the bot uses to tune
    // its own caution without being told.
    const hurst = hurstExponent(changes.slice(-HURST_LOOKBACK));
    const entropyHigh = entropyOf([...strictHigh, rateHigh]);
    const entropyLow = entropyOf([...strictLow, rateLow]);
    const orderedMoves = magnitudes.slice().sort((a, b) => a - b);
    const medianMove = orderedMoves.length ? orderedMoves[Math.floor(orderedMoves.length / 2)] : 0;
    const jumpRate = changes.length && medianMove > 0
        ? changes.filter(value => Math.abs(value) > 3 * medianMove).length / changes.length
        : 0;
    const extremeAutocorr = highPhase.length >= 20 ? lagOneCorrelation(highPhase) : 0;
    let tieClustering = 1;
    {
        const blocks = [];
        for (let b = 0; b + 20 <= tieHighFlags.length; b += 20) {
            blocks.push(tieHighFlags.slice(b, b + 20).reduce((sum, value) => sum + value, 0));
        }
        if (blocks.length >= 3) {
            const mean = blocks.reduce((sum, value) => sum + value, 0) / blocks.length;
            const variance = blocks.reduce((sum, value) => sum + (value - mean) ** 2, 0) / blocks.length;
            tieClustering = mean > 0 ? clamp(variance / mean, 0, 5) : 1;
        }
    }
    const recentRange = windowRanges.slice(-10);
    const longRange = windowRanges.slice(-60);
    const meanOf = list => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0);
    const compression = meanOf(longRange) > 0 ? clamp(meanOf(recentRange) / meanOf(longRange), 0.1, 5) : 1;
    // The tuning this market's own measurements imply. Grid tape is tie-heavy,
    // so the EV bound widens; jumpy tape is anchor-heavy, so deviations from
    // structure are trusted less; compressed tape earns a patience note rather
    // than a trade. Nothing here is a forecast — it is the bot reading its own
    // instruments and setting its own caution.
    const autoTune = {
        evZ: phase === 'grid' ? 1.5 : phase === 'mixed' ? 1.25 : 1,
        slip: 1,
        anchorTrust: clamp(0.5 + ((rateHigh + rateLow) / 2) * 1.2 + jumpRate * 2, 0.5, 1),
        note:
            phase === 'grid'
                ? 'grid tape: widen the EV bound, the middle pays for rarity'
                : jumpRate > 0.05
                  ? 'spike tape: trust the anchor, spikes break conditional reads'
                  : compression < 0.7
                    ? 'compressed tape: small windows, wait for the release'
                    : Math.abs(hurst - 0.5) > 0.1
                      ? `memory ${hurst > 0.5 ? 'trending' : 'reverting'} (H ${hurst.toFixed(2)}): lean with the phase`
                      : 'clean tape: standard caution',
    };

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
        hurst,
        entropyHigh,
        entropyLow,
        jumpRate,
        extremeAutocorr,
        tieClustering,
        compression,
        tickSigma: sigma,
        autoTune,
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
    brain: null,
    meta: null,
    autoTune: null,
    forecast: [],
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
    const arcPrior = isTick ? arcsinePrior(TICK_POSITIONS) : null;
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
    // The internal built-in AI: a two-layer online network (features → tanh
    // hidden → softmax), trained walk-forward on settled windows only. The
    // hidden layer lets it learn interactions (e.g. "stretched AND quiet")
    // that a linear model cannot express; L2 decay keeps it honest on thin
    // samples. Its update count and weight norm are reported in `brain`.
    const netW1 = Array.from({ length: NET_HIDDEN }, () => new Array(featureCount).fill(0));
    const netB1 = new Array(NET_HIDDEN).fill(0);
    const netW2 = Array.from({ length: count }, () => new Array(NET_HIDDEN).fill(0));
    const netB2 = new Array(count).fill(0);
    let netUpdates = 0;
    const netForward = featureRow => {
        const hidden = netW1.map((row, unit) => {
            let sum = netB1[unit];
            for (let i = 0; i < featureCount; i++) sum += row[i] * featureRow[i];
            return Math.tanh(sum);
        });
        const logits = netW2.map((row, k) => {
            let sum = netB2[k];
            for (let j = 0; j < NET_HIDDEN; j++) sum += row[j] * hidden[j];
            return sum;
        });
        return { hidden, probs: softmax(logits) };
    };
    const netStep = (featureRow, winners) => {
        const { hidden, probs } = netForward(featureRow);
        const outputError = probs.map((p, k) => p - (winners.includes(k) ? 1 : 0));
        // Output layer gradients, with L2 decay toward zero.
        for (let k = 0; k < count; k++) {
            netB2[k] -= NET_LEARNING_RATE * outputError[k];
            for (let j = 0; j < NET_HIDDEN; j++) {
                netW2[k][j] -= NET_LEARNING_RATE * (outputError[k] * hidden[j] + NET_L2 * netW2[k][j]);
            }
        }
        // Hidden layer gradients through the tanh derivative.
        for (let j = 0; j < NET_HIDDEN; j++) {
            let back = 0;
            for (let k = 0; k < count; k++) back += outputError[k] * netW2[k][j];
            const delta = back * (1 - hidden[j] * hidden[j]);
            netB1[j] -= NET_LEARNING_RATE * delta;
            for (let i = 0; i < featureCount; i++) {
                netW1[j][i] -= NET_LEARNING_RATE * (delta * featureRow[i] + NET_L2 * netW1[j][i]);
            }
        }
        netUpdates += 1;
    };
    const netNorm = () => {
        let sum = 0;
        for (const row of netW1) for (const value of row) sum += value * value;
        for (const row of netW2) for (const value of row) sum += value * value;
        return Math.sqrt(sum);
    };
    // Meta-learner scoreboards: one Brier ledger per market regime, so the
    // mixture can trust trend-readers when a trend is on and range-readers
    // when it is not. Accumulated in settleScore (settled rows only), exactly
    // like the global ledger.
    const REGIMES = ['expansion', 'reversion', 'balanced'];
    const regimeBrierSum = {
        expansion: PRICE_MODEL_NAMES.map(() => 0),
        reversion: PRICE_MODEL_NAMES.map(() => 0),
        balanced: PRICE_MODEL_NAMES.map(() => 0),
    };
    const regimeBrierCount = {
        expansion: PRICE_MODEL_NAMES.map(() => 0),
        reversion: PRICE_MODEL_NAMES.map(() => 0),
        balanced: PRICE_MODEL_NAMES.map(() => 0),
    };
    const regimeOf = moment => tickRegime(moment);
    /** Global mixture gated by the live regime's own scoreboard. */
    const mixtureFor = regime => {
        const global = mixtureWeights(
            brierSum.map((value, modelIndex) => (brierCount[modelIndex] ? value / brierCount[modelIndex] : 1))
        );
        const sums = regimeBrierSum[regime] || regimeBrierSum.balanced;
        const counts = regimeBrierCount[regime] || regimeBrierCount.balanced;
        const samples = Math.min(...counts);
        if (!(samples >= REGIME_MIN_SAMPLES)) return { weights: global, samples, gated: false };
        const gated = mixtureWeights(sums.map((value, modelIndex) => (counts[modelIndex] ? value / counts[modelIndex] : 1)));
        const weights = global.map((value, modelIndex) => (1 - REGIME_BLEND) * value + REGIME_BLEND * gated[modelIndex]);
        const total = weights.reduce((sum, value) => sum + value, 0) || 1;
        return { weights: weights.map(value => value / total), samples, gated: true };
    };

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
        const neural = netForward(featureRow).probs;
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
        // ---- v6 experts ----------------------------------------------------
        // Volatility: expansion-scaled trend tilt. A rising, expanding tape
        // pushes the high late and the low early; the strength scales with the
        // measured expansion instead of a fixed constant.
        const volStrength = clamp((safe(moment.expansion, 1) - 1) * 0.7, -0.8, 0.9);
        const volLean = volStrength * Math.sign(moment.slope || 0);
        const volatility = isTick
            ? tiltTick(strictPrior, volLean)
            : upVector(moment.slope * 2 * clamp(safe(moment.expansion, 1) - 0.6, 0, 1.6), tieRate);
        // Microtrend: RSI, slope and stretch fused into one continuous lean.
        const microLean = clamp(0.55 * safe(moment.rsi, 0) + 0.45 * safe(moment.slope, 0), -1, 1) * 0.75;
        const microtrend = isTick ? tiltTick(strictPrior, microLean) : upVector(microLean * 2.4, tieRate);
        // Range: the structure selector. Compressed tape behaves like the grid
        // walk, expanded tape like the continuous walk; the prior is
        // interpolated between the two by the measured expansion.
        let range;
        if (isTick) {
            const mixWeight = clamp((safe(moment.expansion, 1) - 0.6) / 1.4, 0, 1);
            const mixed = strictPrior.map((value, pos) => (1 - mixWeight) * value + mixWeight * arcPrior[pos]);
            range = [...mixed, ...mixed];
        } else {
            range = anchor.slice();
        }
        // Entropy: the concentration reader. A concentrated recent shape
        // persists; a diffuse one abstains to the frequency table.
        let entropy;
        {
            const shape = passed.slice(-SHAPE_LOOKBACK);
            if (shape.length < 20) {
                entropy = frequency.slice();
            } else {
                const shapeCounts = blank();
                shape.forEach(row => tally(shapeCounts, row.winners));
                const smoothed = fromCounts(shapeCounts, shape.length, frequency);
                const concentration = isTick
                    ? clamp((0.92 - entropyOf(shapeCounts)) * 4, 0, 0.7)
                    : clamp((1 - entropyOf(shapeCounts)) * 3 - 0.6, 0, 0.7);
                entropy = smoothed.map((value, index) => concentration * value + (1 - concentration) * frequency[index]);
            }
        }
        // Hurst: the long-memory probe, read from settled changes only.
        let hurst;
        {
            const end = moment.index;
            const startH = Math.max(1, end - HURST_LOOKBACK);
            const hChanges = [];
            for (let index = startH; index <= end; index++) hChanges.push(prices[index] - prices[index - 1]);
            const memory = hurstExponent(hChanges);
            const direction = Math.sign(moment.slope || prices[end] - prices[end - 1] || 0);
            let lean = 0;
            if (memory > 0.55) lean = clamp((memory - 0.5) * 4, 0, 0.8) * direction;
            else if (memory < 0.45) lean = -clamp((0.5 - memory) * 4, 0, 0.8) * direction;
            hurst = isTick ? tiltTick(strictPrior, lean) : upVector(lean * 2, tieRate);
        }
        // Cycle: extreme-phase persistence from the settled position series.
        let cycle;
        {
            const phase = passed
                .slice(-40)
                .map(row => (row.winners.length ? row.winners[0] % (isTick ? 5 : 2) : null))
                .filter(value => value !== null);
            if (phase.length < 20) {
                cycle = frequency.slice();
            } else if (!isTick) {
                const signs = phase.map(value => (value === 0 ? 1 : -1));
                const rhoPhase = lagOneCorrelation(signs);
                cycle =
                    Math.abs(rhoPhase) < 0.1
                        ? frequency.slice()
                        : upVector(clamp(rhoPhase * 4, -2, 2) * signs[signs.length - 1], tieRate);
            } else {
                const mean = phase.reduce((sum, value) => sum + value, 0) / phase.length;
                const rhoPhase = lagOneCorrelation(phase);
                if (Math.abs(rhoPhase) < 0.15) {
                    cycle = frequency.slice();
                } else {
                    const predictedHigh = clamp(mean + rhoPhase * (phase[phase.length - 1] - mean), 0, 4);
                    const bump = predicted =>
                        normalise(
                            strictPrior.map((value, pos) => value * Math.exp(-((pos - predicted) ** 2) / 2.5)),
                            strictPrior
                        );
                    cycle = [...bump(predictedHigh), ...bump(4 - predictedHigh)];
                }
            }
        }
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
            volatility,
            microtrend,
            range,
            entropy,
            hurst,
            cycle,
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

        // One deep-network gradient step on this window's features. The row is
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
        netStep(featureRow, row.winners);
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
            // The gated blend is what the live decision trades, so it is what
            // the replay scores: `skill` stays an honest measure of the blend
            // that actually publishes.
            const rowRegime = regimeOf(row.features);
            const gatedRow = mixtureFor(rowRegime);
            const blendWeights = gatedRow.gated ? gatedRow.weights : liveWeights;
            const blendNow = new Array(count).fill(0);
            PRICE_MODEL_NAMES.forEach((name, modelIndex) => {
                vectors[name].forEach((value, outcome) => {
                    blendNow[outcome] += blendWeights[modelIndex] * value;
                });
            });
            pendingScores.set(index, {
                regime: rowRegime,
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
    // The live mixture: global weights gated by the live regime's scoreboard.
    const liveRegime = regimeOf(currentFeatures);
    const gatedLive = mixtureFor(liveRegime);
    const mixture = gatedLive.weights;
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

    // ---- per-outcome calibration from the graded record --------------------
    // The global calibration above treats every outcome alike; the runtime's
    // per-outcome ledger lets each outcome be judged on its own claims. A
    // high-tick-3 read that keeps missing is shrunk toward the anchor without
    // punishing the reads that earned their keep. Inactive unless the caller
    // supplies `evidence.byOutcome` (the Vision runtime does).
    const byOutcome = Array.isArray(evidence?.byOutcome) ? evidence.byOutcome : null;
    if (byOutcome && byOutcome.length === count) {
        let touched = false;
        for (let index = 0; index < count; index++) {
            const record = byOutcome[index] || {};
            const samples = Number(record.samples);
            const rate = Number.isFinite(Number(record.rate))
                ? Number(record.rate)
                : samples > 0
                  ? Number(record.hits || 0) / samples
                  : NaN;
            const mean = Number(record.mean);
            if (!(samples >= MIN_EVIDENCE_SAMPLES) || !Number.isFinite(rate) || !(mean > 0)) continue;
            const ratio = rate / mean;
            const factor = clamp(
                ratio < 1 ? ratio + (1 - ratio) * 0.15 : 1 + Math.min(0.25, (ratio - 1) * 0.6),
                0.35,
                1.25
            );
            if (factor !== 1) {
                probabilities[index] = anchor[index] + factor * (probabilities[index] - anchor[index]);
                touched = true;
            }
        }
        if (touched) {
            if (isTick) {
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

    // ---- the AI core report ------------------------------------------------
    // Everything the internal brain wants the operator to see: the deep net's
    // training state, the meta-learner's regime call, the experts carrying the
    // decision, and the auto-tuning the market DNA implies. The `x_price_brain`
    // and `x_price_reverse` blocks print these; the `forecast` is the full
    // ten-outcome read for `x_price_forecast`.
    const brainTop = league.slice(0, 3).map(expert => ({
        name: expert.name,
        weight: expert.weight,
        skill: expert.skill,
    }));
    const brain = {
        version: PRICE_MODEL_VERSION,
        experts: PRICE_MODEL_NAMES.length,
        net: { updates: netUpdates, hidden: NET_HIDDEN, norm: netNorm(), lr: NET_LEARNING_RATE },
        regime: liveRegime,
        regimeSamples: gatedLive.samples,
        gated: gatedLive.gated,
        top: brainTop,
        skill,
        calibration,
        votes,
    };
    const meta = {
        regime: liveRegime,
        samples: gatedLive.samples,
        gated: gatedLive.gated,
        weights: Object.fromEntries(PRICE_MODEL_NAMES.map((name, modelIndex) => [name, mixture[modelIndex]])),
    };
    const autoTune = dna?.autoTune || { evZ, slip: entrySlip, anchorTrust: 0.5, note: 'directional contract: standard caution' };
    const forecast = ladderRows.slice(0, isTick ? 5 : 2).map(row => ({
        label: row.label,
        side: row.side,
        tick: row.tick,
        probability: row.probability,
        ev: row.ev,
        payout: row.payout,
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
        brain,
        meta,
        autoTune,
        forecast,
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

/**
 * AI CORE — one journal line for the internal brain.
 *
 * What the deep net has learned (walk-forward updates, hidden-layer weight
 * norm), which regime the meta-learner sees, whether the regime scoreboard is
 * trusted yet, and which experts carry the live decision. Printed by the
 * `x_price_brain` block.
 */
export function aiBrainReport(decision) {
    const brain = decision?.brain;
    if (!brain) return 'AI core warming up — no decision has been scored yet';
    const top = (brain.top || [])
        .map(expert => `${expert.name} ${Math.round(safe(expert.weight, 0) * 100)}%`)
        .join(', ');
    return [
        `AI core v${brain.version || PRICE_MODEL_VERSION} · ${brain.experts || PRICE_MODEL_NAMES.length} experts`,
        `deep net ${(brain.net?.updates ?? 0)} updates (hidden ${brain.net?.hidden ?? NET_HIDDEN}, ‖w‖ ${safe(brain.net?.norm, 0).toFixed(2)})`,
        `regime ${brain.regime || 'balanced'}${brain.gated ? ` (gated, ${brain.regimeSamples || 0} scored)` : ' (global weights)'}`,
        top ? `carrying: ${top}` : 'carrying: anchor',
        `skill ${(safe(brain.skill, 0) * 100).toFixed(0)} · calibration ${safe(brain.calibration, 1).toFixed(2)}×`,
    ].join(' · ');
}

/**
 * REVERSE ENGINEERING — one journal line for the DNA v2 diagnosis.
 *
 * The market's phase, memory, entropy, spike rate, extreme-phase persistence,
 * tie clustering and compression, plus the auto-tuning the bot derived from
 * them. Printed by the `x_price_reverse` block.
 */
export function reverseEngineerReport(dna) {
    if (!dna || !dna.windows) return String(dna?.verdict || 'reverse engineering warming up — waiting for ticks');
    const tune = dna.autoTune || {};
    return [
        `reverse engineering · ${dna.phase} phase`,
        `H ${safe(dna.hurst, 0.5).toFixed(2)}`,
        `entropy H/L ${safe(dna.entropyHigh, 1).toFixed(2)}/${safe(dna.entropyLow, 1).toFixed(2)}`,
        `jumps ${(safe(dna.jumpRate, 0) * 100).toFixed(1)}%`,
        `extreme ρ ${safe(dna.extremeAutocorr, 0).toFixed(2)}`,
        `tie clustering ${safe(dna.tieClustering, 1).toFixed(2)}`,
        `compression ${safe(dna.compression, 1).toFixed(2)}`,
        `auto-tune: EV bound ${safe(tune.evZ, 1).toFixed(2)}σ · anchor trust ${(safe(tune.anchorTrust, 0.5) * 100).toFixed(0)}%`,
        String(tune.note || dna.verdict || ''),
    ].join(' · ');
}

/**
 * FORECAST — one journal line for the full outcome read.
 *
 * The top outcomes by expected value with their win probabilities and live
 * quotes. Printed by the `x_price_forecast` block.
 */
export function forecastReport(decision) {
    const rows = Array.isArray(decision?.forecast) ? decision.forecast : [];
    if (!rows.length) return 'no forecast yet — no decision has been scored';
    return (
        'forecast · ' +
        rows
            .map(row => {
                const ev = Number.isFinite(row.ev) ? `, EV ${(row.ev * 100).toFixed(1)}%` : '';
                const quote = row.payout > 0 ? ` @ ${row.payout.toFixed(2)}×` : '';
                return `${row.label} ${(safe(row.probability, 0) * 100).toFixed(1)}%${ev}${quote}`;
            })
            .join(' · ')
    );
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
    entropyOf,
    hurstExponent,
    aiBrainReport,
    reverseEngineerReport,
    forecastReport,
};
