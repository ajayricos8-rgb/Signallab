/**
 * Parity Lab — the Even/Odd ensemble behind the AI Even Switcher.
 *
 * The engine answers one question: *what is the chance the last digit at the
 * settling tick is even?* Everything else (the side, the stake, whether to
 * trade at all) is derived from that number and the live DIGITEVEN/DIGITODD
 * quotes.
 *
 * Sixteen experts vote, in two layers:
 *
 *   Digit layer (inherited from the proven vision ensemble — each produces a
 *   full ten-digit distribution, summed to P(even)):
 *     uniform      — the fair 10 % anchor
 *     frequency    — the long-run digit histogram
 *     recent       — the short-window histogram (picks up digit drift)
 *     transition   — the Markov row P(digit at t+h | digit now)
 *     analog       — kernel replay of states that looked like this one
 *     momentum     — the analytical price forecast mapped onto the last digit
 *                    with an exact Fourier series
 *     neural       — a ten-class softmax regression, trained walk-forward on
 *                    the settled past (online: predict, score, update)
 *     regime       — the regime-switching price-to-digit forecast
 *
 *   Parity layer (native to this engine — structure invisible to histograms):
 *     share        — the long-run even share
 *     recent-share — the last ~120 ticks' even share (the fast reactor)
 *     markov-1     — the 2×2 parity transition row, matrix-powered to h
 *     markov-2     — order-2 parity rows (EE/EO/OE/OO), powered to h
 *     digit-row    — the 10-bin digit row conditioned on the current digit,
 *                    powered to the horizon (the v1 measurement, upgraded)
 *     streak       — run-continuation rates by run length, decayed over h
 *     alternation  — the parity-autocorrelation projector 0.5 + ρ^h·(x−0.5)
 *     parity-net   — a small online perceptron on parity features, trained
 *                    walk-forward on settled windows only
 *
 * Every expert is scored walk-forward with Brier loss against the 0.5 anchor
 * over the settled past and mixed by measured skill — an expert that cannot
 * read this market loses its vote on its own. The blend is shrunk toward 50 %
 * by its effective sample size, calibrated against the rule's own graded
 * record per side, and priced against the live quotes. The side with the best
 * expected value wins; in cadence mode that side is bought on every readable
 * cycle, sized by tenth-Kelly down to the exchange minimum.
 *
 * The engine is stateless and deterministic: the brain (both nets, all skill
 * weights) is rebuilt from settled windows on every decision. No persistence
 * to corrupt, no yesterday steering today, no randomness anywhere.
 *
 * On the horizon: a buy's entry tick is the tick AFTER the purchase, so the
 * settling digit sits duration+1 ticks past the last tick in hand. The engine
 * takes the contract duration and charges `entrySlip` (default 1) on top, and
 * every h-step expert is projected to that exact tick — never to the nearer,
 * wrong one.
 *
 * On refusal: a frozen quote feed (one price repeated) makes every expert
 * agree and the edge look enormous — measured once at a phantom +40% EV. The
 * engine vetoes the decision before a single expert speaks, the refusal is
 * never filed for grading, and the market scout scores the dead tape 0.
 */

import {
    analogDistribution,
    buildFeatureSpace,
    featureVector,
    momentumDistribution,
    neuralDistribution,
    regimeDistribution,
    transitionDistribution,
} from './vision-ai.mjs';
import {
    autocorrelation,
    digitEntropy,
    evenShare,
    inferPipSize,
    lastDigits,
    mean,
    stdDev,
    sum,
    toNumbers,
} from './vision-math.mjs';

export const PARITY_MODEL_NAMES = [
    'uniform',
    'frequency',
    'recent',
    'transition',
    'analog',
    'momentum',
    'neural',
    'regime',
    'share',
    'recent-share',
    'markov-1',
    'markov-2',
    'digit-row',
    'streak',
    'alternation',
    'parity-net',
];

export const PARITY_MODEL_VERSION = 1;
/** Ticks the engine needs before it will publish anything at all. */
export const PARITY_MIN_TICKS = 60;
/** Pseudo-ticks of fair coin every estimate is shrunk by. */
export const PARITY_PRIOR_STRENGTH = 256;
/** Graded decisions needed before the own-record calibration counts. */
export const PARITY_CALIBRATION_SAMPLES = 20;
/** Graded decisions needed before the record can stand the bot down. */
export const PARITY_STAND_DOWN_SAMPLES = 40;
/** Payout multiple used before Deriv has quoted this market (both sides). */
export const PARITY_FALLBACK_PAYOUT = 1.95;
/** Walk-forward origins per decision — accuracy against tick time. */
export const PARITY_MAX_ORIGINS = 64;
/** How far back the walk-forward replay reaches. */
const PARITY_REPLAY_WINDOW = 500;
/** Skill-mixing sharpness: binary Brier gaps are small, so this is gentle. */
const PARITY_ETA = 8;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const safe = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const parityOf = digit => (Math.round(digit) % 2 === 0 ? 1 : 0);

const uniform10 = () => new Array(10).fill(0.1);
const evenOf = distribution => {
    let p = 0;
    for (let d = 0; d <= 8; d += 2) p += safe(distribution[d], 0);
    return clamp(p, 0, 1);
};

/**
 * Fast integer powers of small stochastic matrices. The 10×10 digit chain to
 * the 11th power is ~4k multiplies — nothing per decision, and exact where a
 * repeated one-step sample would be noise.
 */
function matMul(a, b) {
    const n = a.length;
    const out = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < n; k++) {
            const aik = a[i][k];
            if (!aik) continue;
            for (let j = 0; j < n; j++) out[i][j] += aik * b[k][j];
        }
    }
    return out;
}

function matPow(matrix, power) {
    const n = matrix.length;
    let result = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    let base = matrix.map(row => row.slice());
    let p = Math.max(1, Math.round(power));
    while (p > 0) {
        if (p % 2 === 1) result = matMul(result, base);
        base = matMul(base, base);
        p = Math.floor(p / 2);
    }
    return result;
}

const normaliseRow = row => {
    const total = sum(row);
    if (!(total > 0)) return row.map(() => 1 / row.length);
    return row.map(value => value / total);
};

/** Skill-weighted mixture from walk-forward Brier losses. */
function mixtureWeights(brier) {
    const finite = brier.map(value => (Number.isFinite(value) ? value : 1));
    const best = Math.min(...finite);
    const raw = finite.map(value => clamp(Math.exp(-PARITY_ETA * (value - best)), 0.02, 1.5));
    const total = raw.reduce((acc, value) => acc + value, 0) || 1;
    return raw.map(value => value / total);
}

/** The multiple a side deserves given its win probability: (1−p)/p. */
export const parityFairMultiple = probability => {
    const p = clamp(safe(probability, 0), 0, 1);
    return p > 0 ? (1 - p) / p : 0;
};

const wilsonBand = (rate, n, zed = 1.96) => {
    const samples = Math.max(1, safe(n, 1));
    const centre = (rate + (zed * zed) / (2 * samples)) / (1 + (zed * zed) / samples);
    const half =
        (zed * Math.sqrt((rate * (1 - rate)) / samples + (zed * zed) / (4 * samples * samples))) /
        (1 + (zed * zed) / samples);
    return { low: clamp(centre - half, 0, 1), high: clamp(centre + half, 0, 1) };
};

/* ------------------------------------------------------------------ *
 * Parity DNA — the digit stream's structural fingerprint
 * ------------------------------------------------------------------ */

/**
 * Fingerprint the digit stream before the ensemble speaks: pip size, digit
 * and parity chi-squares against uniform, even share with a Wilson interval,
 * alternation ratio, runs z-score, parity-Markov dependence, longest run vs
 * its expectation, digit entropy, repeat rate and sample warmth — rolled
 * into a 0–100 readability score with a one-line verdict. Descriptive, never
 * predictive: the DNA explains the market; it does not promise it.
 */
export function parityDna(values, options = {}) {
    const prices = toNumbers(values);
    const ticks = prices.length;
    const empty = {
        ticks,
        windows: 0,
        pipSize: null,
        histogram: new Array(10).fill(0),
        digitChi: 0,
        parityChi: 0,
        evenShare: 0.5,
        wilsonEven: { low: 0, high: 1 },
        alternation: 0.5,
        runsZ: 0,
        markovChi: 0,
        parityRho: 0,
        longestRun: 0,
        expectedRun: 0,
        entropy: 0,
        maxEntropy: Math.log2(10),
        repeatRate: 0,
        warmth: 0,
        readability: 0,
        phase: 'cold',
        regime: 'unknown',
        driftZ: 0,
        autoTune: { anchorTrust: 0.5, evZ: 1, family: 'blend', note: 'cold — nothing measured yet' },
        summary: 'no DNA yet — waiting for ticks',
        verdict: `warming up — ${ticks}/${PARITY_MIN_TICKS} usable quotes`,
    };
    if (ticks < PARITY_MIN_TICKS || prices.some(value => !Number.isFinite(value))) return empty;

    const pipSize = inferPipSize(prices);
    const digits = lastDigits(prices, pipSize);
    const n = digits.length;
    const par = digits.map(parityOf);

    const histogram = new Array(10).fill(0);
    digits.forEach(d => {
        histogram[clamp(Math.round(d), 0, 9)] += 1;
    });
    const expected = n / 10;
    const digitChi = histogram.reduce((acc, count) => acc + ((count - expected) ** 2 / expected), 0);

    const evens = par.reduce((acc, value) => acc + value, 0);
    const share = evens / n;
    const parityChi = ((evens - n / 2) ** 2 / (n / 2)) * 2;

    let switches = 0;
    for (let i = 1; i < n; i++) if (par[i] !== par[i - 1]) switches += 1;
    const alternation = n > 1 ? switches / (n - 1) : 0.5;

    // Wald–Wolfowitz runs test on the parity series: fewer runs than expected
    // means sticky, more means alternating.
    let runs = 1;
    for (let i = 1; i < n; i++) if (par[i] !== par[i - 1]) runs += 1;
    const n1 = evens;
    const n2 = n - evens;
    const expectedRuns = (2 * n1 * n2) / Math.max(1, n) + 1;
    const varRuns = (2 * n1 * n2 * (2 * n1 * n2 - n)) / Math.max(1, n * n * (n - 1));
    const runsZ = varRuns > 0 ? (runs - expectedRuns) / Math.sqrt(varRuns) : 0;

    // 2×2 parity independence chi-square (df = 1, critical 3.84).
    let ee = 0.5;
    let eo = 0.5;
    let oe = 0.5;
    let oo = 0.5;
    for (let i = 1; i < n; i++) {
        if (par[i - 1] === 1 && par[i] === 1) ee += 1;
        else if (par[i - 1] === 1) eo += 1;
        else if (par[i] === 1) oe += 1;
        else oo += 1;
    }
    const total2 = ee + eo + oe + oo;
    const markovChi =
        ((ee * oo - eo * oe) ** 2 * total2) / Math.max(1e-9, (ee + eo) * (oe + oo) * (ee + oe) * (eo + oo));

    const rho = autocorrelation(par, 1);

    let longestRun = 1;
    let run = 1;
    let repeats = 0;
    for (let i = 1; i < n; i++) {
        if (par[i] === par[i - 1]) {
            run += 1;
            longestRun = Math.max(longestRun, run);
        } else run = 1;
        if (digits[i] === digits[i - 1]) repeats += 1;
    }
    const expectedRun = Math.log2(Math.max(2, n));
    const repeatRate = n > 1 ? repeats / (n - 1) : 0;
    const entropy = digitEntropy(prices, pipSize);
    const maxEntropy = Math.log2(10);

    // Quote-level drift, for the 'drifty' regime call.
    const changes = [];
    for (let i = Math.max(1, n - 240); i < n; i++) changes.push(prices[i] - prices[i - 1]);
    const driftMean = changes.length ? mean(changes) : 0;
    const driftSd = changes.length ? stdDev(changes) : 0;
    const driftZ = driftSd > 0 ? driftMean / (driftSd / Math.sqrt(Math.max(1, changes.length))) : 0;

    // Readability: enough sample, measurable dependence, a live (not frozen)
    // stream. A frozen quote feed scores ~0 no matter what the counts say.
    const sample = clamp(n / 800, 0, 1);
    const dependence = clamp(Math.abs(runsZ) / 4 + markovChi / 10, 0, 1);
    const liveliness = clamp(entropy / maxEntropy, 0, 1);
    const readability = clamp(100 * (0.4 * sample + 0.4 * dependence + 0.2 * liveliness), 0, 100);
    const warmth = clamp(n / 300, 0, 1);

    let phase = 'fair';
    if (liveliness < 0.5) phase = 'frozen';
    else if (runsZ < -1.5) phase = 'sticky';
    else if (runsZ > 1.5) phase = 'alternating';
    else if (markovChi >= 3.84 || digitChi >= 16.92) phase = 'mixed';

    let regime = 'fair';
    if (phase === 'frozen') regime = 'frozen';
    else if (rho > 0.08) regime = 'sticky';
    else if (rho < -0.08) regime = 'alternating';
    else if (Math.abs(driftZ) > 2) regime = 'drifty';

    const family = markovChi >= 3.84 ? 'markov' : Math.abs(runsZ) >= 1.5 ? 'runs' : digitChi >= 16.92 ? 'digit' : 'blend';
    const anchorTrust = clamp(1 - dependence, 0.2, 0.9);
    const summary =
        `DNA · ${n} ticks · pip ${pipSize} · even ${(share * 100).toFixed(1)}% ` +
        `(χ² ${parityChi.toFixed(1)}) · runs z ${runsZ.toFixed(2)} · Markov χ² ${markovChi.toFixed(1)} · ` +
        `repeat ${(repeatRate * 100).toFixed(1)}% · entropy ${entropy.toFixed(2)}/${maxEntropy.toFixed(2)}`;
    const verdict =
        phase === 'frozen'
            ? 'frozen stream — refusing to read a dead tape'
            : `readability ${readability.toFixed(0)} · ${phase} ${regime !== phase ? `/ ${regime}` : ''} · ` +
              `${family === 'blend' ? 'no family leads — the anchor carries the blend' : `the ${family} family leads`}`;

    return {
        ticks: n,
        windows: n,
        pipSize,
        histogram: histogram.map(count => count / n),
        digitChi,
        parityChi,
        evenShare: share,
        wilsonEven: wilsonBand(share, n),
        alternation,
        runsZ,
        markovChi,
        parityRho: rho,
        longestRun,
        expectedRun,
        entropy,
        maxEntropy,
        repeatRate,
        warmth,
        readability,
        phase,
        regime,
        driftZ,
        autoTune: {
            anchorTrust,
            evZ: 1,
            family,
            note:
                phase === 'frozen'
                    ? 'frozen — stand off until the tape moves'
                    : dependence < 0.15
                      ? 'fair tape — trade the minimum, trust the anchor'
                      : `${phase} tape — let the ${family} experts carry the blend`,
        },
        summary,
        verdict,
    };
}

/* ------------------------------------------------------------------ *
 * The sixteen experts
 * ------------------------------------------------------------------ */

/**
 * Prefix sums over the parity series so every counting expert answers in
 * O(1) per origin instead of rescanning the tape.
 */
function buildParityPrefix(par) {
    const n = par.length;
    const even = new Float64Array(n + 1);
    const pair = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
        even[i + 1] = even[i] + par[i];
        pair[i + 1] = pair[i] + (i > 0 ? par[i - 1] * par[i] : 0);
    }
    return { even, pair };
}

const rangeEven = (prefix, from, to) => prefix.even[to + 1] - prefix.even[from];

/** Lag-1 Pearson correlation of the 0/1 parity series over [from..to]. */
function parityACF(prefix, par, from, to) {
    const count = to - from + 1;
    if (count < 12) return 0;
    const pairs = count - 1;
    const sumX = rangeEven(prefix, from, to - 1);
    const sumY = rangeEven(prefix, from + 1, to);
    const sumXY = prefix.pair[to + 1] - prefix.pair[from + 1];
    const meanX = sumX / pairs;
    const meanY = sumY / pairs;
    const varX = meanX * (1 - meanX);
    const varY = meanY * (1 - meanY);
    if (!(varX > 0) || !(varY > 0)) return 0;
    return clamp((sumXY / pairs - meanX * meanY) / Math.sqrt(varX * varY), -1, 1);
}

/** The run ending at `end`: its parity and length. */
function runAt(par, end) {
    const side = par[end];
    let length = 1;
    for (let i = end - 1; i >= 0 && par[i] === side; i--) length += 1;
    return { side, length };
}

/**
 * Geometric run model: from the runs in [0..end], how often a run that
 * reached length L reached L+1 — decayed over the horizon. Laplace-smoothed
 * so a run length never seen before answers "fair", not "certain".
 */
function streakContinuation(par, end, horizon, start = 0) {
    const { side, length } = runAt(par, end);
    const level = Math.min(length, 8);
    let reached = 0;
    let continued = 0;
    let i = Math.max(0, start);
    while (i <= end) {
        let j = i;
        while (j + 1 <= end && par[j + 1] === par[i]) j += 1;
        const runLength = j - i + 1;
        // The run still in progress at exactly `level` is censored — its
        // continuation is the thing being forecast, so it must not also be
        // the evidence. Every other run at/above level counts as reached,
        // and only runs observed past level count as continued.
        if (runLength >= level && !(j === end && runLength === level)) {
            reached += 1;
            if (runLength > level) continued += 1;
        }
        i = j + 1;
    }
    const rate = (continued + 1) / (reached + 2);
    const decay = rate ** Math.max(1, horizon);
    return { pEven: 0.5 + decay * (side === 1 ? 0.5 : -0.5), effective: Math.max(1, reached) };
}

/** 2×2 parity chain powered to the horizon. */
function markov1Forecast(par, end, horizon, start = 0) {
    let ee = 0.5;
    let eo = 0.5;
    let oe = 0.5;
    let oo = 0.5;
    for (let i = Math.max(1, start); i <= end; i++) {
        if (par[i - 1] === 1 && par[i] === 1) ee += 1;
        else if (par[i - 1] === 1) eo += 1;
        else if (par[i] === 1) oe += 1;
        else oo += 1;
    }
    const powered = matPow(
        [
            [ee / (ee + eo), eo / (ee + eo)],
            [oe / (oe + oo), oo / (oe + oo)],
        ],
        horizon
    );
    const row = par[end] === 1 ? 0 : 1;
    return { pEven: clamp(powered[row][0], 0, 1), effective: par[end] === 1 ? ee + eo : oe + oo };
}

/**
 * Order-2 parity chain: the 4 pair-states (EE/EO/OE/OO) powered to h−1, then
 * one step out. Exact for h = 1, Chapman–Kolmogorov after that.
 */
function markov2Forecast(par, end, horizon, start = 0) {
    const index = (a, b) => a * 2 + b;
    const counts = Array.from({ length: 4 }, () => [0.5, 0.5]);
    for (let i = Math.max(2, start); i <= end; i++) counts[index(par[i - 2], par[i - 1])][par[i]] += 1;
    const context = index(par[end - 1] ?? par[end], par[end]);
    const rowTotal = counts[context][0] + counts[context][1];
    if (horizon <= 1) return { pEven: counts[context][1] / rowTotal, effective: rowTotal };
    // Pair chain: from (a,b) to (b,0)/(b,1) with the order-2 row's odds.
    const chain = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (let a = 0; a <= 1; a++) {
        for (let b = 0; b <= 1; b++) {
            const row = counts[index(a, b)];
            const total = row[0] + row[1];
            chain[index(a, b)][index(b, 0)] = row[0] / total;
            chain[index(a, b)][index(b, 1)] = row[1] / total;
        }
    }
    const powered = matPow(chain, horizon - 1)[context];
    let pEven = 0;
    for (let s = 0; s < 4; s++) {
        const b = s % 2;
        const row = counts[s];
        pEven += powered[s] * (row[1] / (row[0] + row[1]));
        void b;
    }
    return { pEven: clamp(pEven, 0, 1), effective: rowTotal };
}

/** 10×10 digit chain conditioned on the current digit, powered to h. */
function digitRowForecast(digits, end, horizon, start = 0) {
    const matrix = Array.from({ length: 10 }, () => new Array(10).fill(0.25));
    for (let i = Math.max(1, start); i <= end; i++) matrix[digits[i - 1]][digits[i]] += 1;
    const from = clamp(Math.round(digits[end]), 0, 9);
    const rowTotal = sum(matrix[from]);
    const powered = matPow(matrix.map(normaliseRow), horizon)[from];
    return { pEven: evenOf(powered), effective: rowTotal };
}

/* ---------------- the online nets ---------------- */

const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -35, 35)));

/** Parity features: current parity, run, recent-share deviation, digit, ρ. */
function parityFeatures(par, digits, prefix, end) {
    const { side, length } = runAt(par, end);
    const back = Math.max(0, end - 119);
    const recentShare = rangeEven(prefix, back, end) / (end - back + 1);
    return [
        1,
        side === 1 ? 1 : -1,
        clamp(length / 8, 0, 1.5),
        clamp((recentShare - 0.5) * 4, -2, 2),
        ((digits[end] ?? 0) - 4.5) / 4.5,
        clamp(parityACF(prefix, par, Math.max(0, end - 239), end), -1, 1),
    ];
}

const dot = (weights, input) => {
    let acc = 0;
    for (let i = 0; i < weights.length; i++) acc += weights[i] * input[i];
    return acc;
};

const netNorm = weights => Math.sqrt(weights.reduce((acc, value) => acc + value * value, 0));

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

const emptyDecision = (extra = {}) => ({
    ready: false,
    modelReady: false,
    side: 0,
    probability: 0,
    evenProbability: 0.5,
    winProbability: 0,
    samples: 0,
    conditionalSamples: 0,
    horizon: 0,
    forecastHorizon: 0,
    edge: 0,
    ev: NaN,
    evLower: 0,
    seEv: 0,
    evZ: 0,
    z: 0,
    tStat: 0,
    breakEven: 0.5,
    payout: 0,
    payoutAt: 0,
    payoutEven: 0,
    payoutOdd: 0,
    payoutLive: 0,
    fairPayout: 0,
    evMargin: 0,
    confidence: 0,
    certainty: 0,
    agreement: 0,
    outcomeAgreement: 0,
    separation: 0,
    stderr: 0,
    skill: 0,
    dnaScore: 0,
    dna: null,
    brain: null,
    forecast: [],
    evTable: [],
    league: [],
    models: [],
    hitRate: 0,
    hitSamples: 0,
    calibration: 1,
    recordEarned: null,
    standDown: 0,
    reason: '',
    version: PARITY_MODEL_VERSION,
    ...extra,
});

/**
 * Turn a tick stream into an Even/Odd decision.
 *
 * @param {number[]} values   quote history, oldest first
 * @param {number} horizon    contract duration in ticks (1–10)
 * @param {number} threshold  probability floor for the chosen side (0 = off)
 * @param {object} options    minAgreement, minEdge, minConfidence,
 *                            requireEdge, minEv, payout / payoutEven /
 *                            payoutOdd (live multiples), entrySlip,
 *                            evidence { hits, samples, rate, mean, byOutcome }
 */
export function parityDecision(values, horizon = 5, threshold = 0, options = {}) {
    const prices = toNumbers(values);
    const n = prices.length;
    const duration = clamp(Math.round(safe(horizon, 5)) || 5, 1, 10);
    const slip = clamp(Math.round(safe(options.entrySlip, 1)), 0, 3);
    const forecastHorizon = duration + slip;
    if (n < PARITY_MIN_TICKS || prices.some(value => !Number.isFinite(value))) {
        return emptyDecision({
            horizon: duration,
            forecastHorizon,
            reason: `warming up — ${n}/${PARITY_MIN_TICKS} usable quotes`,
        });
    }

    // A stuck quote feed repeats one price: every expert agrees, the edge
    // looks enormous (measured once at a phantom +40% EV, t 7.75σ), and none
    // of it is real — the contract settles on future ticks the dead tape
    // knows nothing about. Refuse before a single expert speaks; the refusal
    // is not model-ready, so it never pollutes the graded record either.
    const dna = parityDna(prices);
    if (dna.phase === 'frozen') {
        return emptyDecision({
            horizon: duration,
            forecastHorizon,
            dna,
            dnaScore: dna.readability,
            reason: `no decision — quote feed frozen (${dna.ticks} identical ticks)`,
        });
    }

    const pipSize = inferPipSize(prices);
    const digits = lastDigits(prices, pipSize);
    const par = digits.map(parityOf);
    const prefix = buildParityPrefix(par);
    // One causal feature space for the whole decision: every rolling window
    // looks back only, so features[i] never sees the future it scores.
    const space = buildFeatureSpace(prices, 40);

    // ---- walk-forward origins -------------------------------------------
    const lastOrigin = n - 1 - forecastHorizon;
    const firstOrigin = Math.max(PARITY_MIN_TICKS - 1, lastOrigin - PARITY_REPLAY_WINDOW);
    const span = Math.max(0, lastOrigin - firstOrigin);
    const step = Math.max(5, Math.floor(span / Math.max(1, PARITY_MAX_ORIGINS - 1)) || 5);
    const origins = [];
    for (let i = firstOrigin; i <= lastOrigin && origins.length < PARITY_MAX_ORIGINS; i += step) origins.push(i);
    if (!origins.length) {
        return emptyDecision({
            horizon: duration,
            forecastHorizon,
            reason: 'no settled windows to score yet — waiting for the tape to age',
        });
    }

    // ---- the two online nets (zero-init, trained on settled windows) ----
    const softWeights = Array.from({ length: 10 }, () => new Array(6).fill(0));
    const softInput = end => {
        const raw = featureVector(space, digits, end).slice(0, 5);
        while (raw.length < 5) raw.push(0);
        raw.push(1);
        return raw;
    };
    const softPredict = end => {
        const input = softInput(end);
        const scores = softWeights.map(row => dot(row, input));
        const max = Math.max(...scores);
        const exps = scores.map(score => Math.exp(score - max));
        const total = sum(exps) || 1;
        return exps.map(value => value / total);
    };
    const softUpdate = (end, target) => {
        const input = softInput(end);
        const distribution = softPredict(end);
        const lr = 0.06;
        for (let c = 0; c < 10; c++) {
            const error = distribution[c] - (c === target ? 1 : 0);
            for (let i = 0; i < input.length; i++) softWeights[c][i] -= lr * error * input[i];
        }
    };
    const parityWeights = new Array(6).fill(0);
    const parityPredict = end => sigmoid(dot(parityWeights, parityFeatures(par, digits, prefix, end)));
    const parityUpdate = (end, target) => {
        const input = parityFeatures(par, digits, prefix, end);
        const error = sigmoid(dot(parityWeights, input)) - target;
        const lr = 0.1;
        for (let i = 0; i < input.length; i++) parityWeights[i] -= lr * error * input[i];
    };

    // ---- per-origin expert forecasts -------------------------------------
    // Each expert is a function of the tape up to `end` only. The nets use
    // whatever weights the origins before this one taught them — predict,
    // score, then update — so a net is never graded on a window it trained on.
    const expertAt = (index, end) => {
        const name = PARITY_MODEL_NAMES[index];
        const count = end + 1;
        // Replay experts read the last 500 ticks only: older tape adds stale
        // weight, not information, and bounding the window keeps a decision
        // under ~100 ms on a deep stream. Prefix experts still see everything.
        const from = Math.max(0, end - (PARITY_REPLAY_WINDOW - 1));
        switch (name) {
            case 'uniform':
                return { pEven: 0.5, effective: 1e6 };
            case 'frequency':
                return { pEven: rangeEven(prefix, 0, end) / count, effective: count / 2 };
            case 'recent': {
                const w = Math.min(count, Math.max(60, forecastHorizon * 60));
                return { pEven: rangeEven(prefix, end - w + 1, end) / w, effective: w / 2 };
            }
            case 'transition': {
                const t = transitionDistribution(digits.slice(from, end + 1), forecastHorizon);
                return { pEven: evenOf(t.distribution), effective: t.effective };
            }
            case 'analog': {
                const a = analogDistribution(prices.slice(from, end + 1), forecastHorizon, { window: 40 });
                return { pEven: evenOf(a.distribution), effective: safe(a.effective, 0) };
            }
            case 'momentum':
                return {
                    pEven: evenOf(momentumDistribution(prices.slice(from, end + 1), forecastHorizon, pipSize)),
                    effective: 400,
                };
            case 'neural':
                // NOTE: featureVector's parity dim reads evenShare() off a digit
                // slice, and lastDigits() maps bare integers to 0 (pip fallback),
                // so that dim is a constant 1.0 here — a harmless extra bias the
                // net absorbs, not a signal. Left as-is to stay bit-compatible
                // with the vision engine this layer is inherited from.
                return { pEven: evenOf(neuralDistribution({ neural: { weights: softWeights.map(row => row.slice()) } }, featureVector(space, digits, end)).distribution), effective: Math.max(1, softUpdates) };
            case 'regime': {
                const r = regimeDistribution(prices.slice(from, end + 1), forecastHorizon, pipSize);
                return { pEven: evenOf(r.distribution), effective: safe(r.effective, 0) };
            }
            case 'share':
                return { pEven: rangeEven(prefix, 0, end) / count, effective: count };
            case 'recent-share': {
                const w = Math.min(count, 120);
                return { pEven: rangeEven(prefix, end - w + 1, end) / w, effective: w };
            }
            case 'markov-1':
                return markov1Forecast(par, end, forecastHorizon, from);
            case 'markov-2':
                return end >= 2 ? markov2Forecast(par, end, forecastHorizon, from) : { pEven: 0.5, effective: 0 };
            case 'digit-row':
                return digitRowForecast(digits, end, forecastHorizon, from);
            case 'streak':
                return streakContinuation(par, end, forecastHorizon, from);
            case 'alternation': {
                const rho = parityACF(prefix, par, Math.max(0, end - 499), end);
                return {
                    pEven: clamp(0.5 + rho ** forecastHorizon * (par[end] - 0.5), 0.02, 0.98),
                         pEven: clamp(0.5 + rho ** forecastHorizon * (par[end] - 0.5), 0.02, 0.98),
                    effective: Math.max(12, end + 1) / 2,
                };
            }
            case 'parity-net':
                return { pEven: clamp(parityPredict(end), 0.02, 0.98), effective: Math.max(1, parityUpdates) };
            default:
                return { pEven: 0.5, effective: 0 };
        }
    };

    // ---- the walk-forward replay ------------------------------------------
    const brier = new Array(PARITY_MODEL_NAMES.length).fill(0);
    let scored = 0;
    let softUpdates = 0;
    let parityUpdates = 0;
    origins.forEach(end => {
        const target = par[end + forecastHorizon];
        for (let m = 0; m < PARITY_MODEL_NAMES.length; m++) {
            const { pEven } = expertAt(m, end);
            brier[m] += (pEven - target) ** 2;
        }
        // The nets learn from this origin only after being scored on it.
        softUpdate(end, digits[end + forecastHorizon]);
        softUpdates += 1;
        parityUpdate(end, target);
        parityUpdates += 1;
        scored += 1;
    });
    for (let m = 0; m < brier.length; m++) brier[m] /= Math.max(1, scored);
    // The anchor's Brier is 0.25 by construction — every expert is judged
    // against the number for "this market is a fair coin".
    const skills = brier.map(value => 1 - value / 0.25);
    const mixture = mixtureWeights(brier);

    // ---- the live blend ----------------------------------------------------
    const live = PARITY_MODEL_NAMES.map((name, m) => {
        const { pEven, effective } = expertAt(m, n - 1);
        const w = Math.max(0, safe(effective)) / (Math.max(0, safe(effective)) + PARITY_PRIOR_STRENGTH);
        return { name, raw: clamp(pEven, 0, 1), effective: safe(effective), shrunk: w * pEven + (1 - w) * 0.5 };
    });
    let pEven = 0;
    let effectiveSample = 0;
    live.forEach((expert, m) => {
        pEven += mixture[m] * expert.shrunk;
        effectiveSample += mixture[m] * Math.min(expert.effective, 1500);
    });
    pEven = clamp(pEven, 0.01, 0.99);
    effectiveSample = Math.min(1500, effectiveSample);

    const stderr = Math.sqrt(0.25 / Math.max(1, effectiveSample));
    const z = (pEven - 0.5) / stderr;
    const dataQuality = clamp(effectiveSample / 400, 0, 1);
    const skill = clamp(
        live.reduce((acc, expert, m) => acc + mixture[m] * Math.max(0, skills[m]), 0),
        0,
        1
    );

    // ---- payouts and the two-sided read ------------------------------------
    const liveTable = options.payouts && typeof options.payouts === 'object' ? options.payouts : null;
    const fallback = safe(options.payout, PARITY_FALLBACK_PAYOUT) || PARITY_FALLBACK_PAYOUT;
    const optEven = safe(options.payoutEven, 0);
    const optOdd = safe(options.payoutOdd, 0);
    const payoutEven = (liveTable && safe(liveTable.even, 0)) || optEven || fallback;
    const payoutOdd = (liveTable && safe(liveTable.odd, 0)) || optOdd || fallback;
    const payoutLive = liveTable ? 1 : 0;

    const evEven = pEven * payoutEven - 1;
    const evOdd = (1 - pEven) * payoutOdd - 1;
    // Ties break to Even: a documented coin flip, not a hidden bias — the
    // journal prints both sides, so a tie-leaning record is visible.
    const evenSide = evEven >= evOdd;
    const side = evenSide ? 1 : -1;
    const breakEven = 1 / (evenSide ? payoutEven : payoutOdd);

    // ---- own-record calibration (per side) ----------------------------------
    const evidence = options.evidence && typeof options.evidence === 'object' ? options.evidence : null;
    const graded = Math.max(0, Math.round(safe(evidence?.samples, 0)));
    const lane = evenSide ? evidence?.byOutcome?.even : evidence?.byOutcome?.odd;
    const laneSamples = Math.max(0, Math.round(safe(lane?.samples, 0)));
    const laneRate = laneSamples ? clamp(safe(lane?.hits, 0) / laneSamples, 0, 1) : 0;
    const laneMean = laneSamples ? clamp(safe(lane?.predicted, 0) / laneSamples, 0.01, 0.99) : 0.5;
    let calibration = 1;
    let recordEarned = null;
    if (laneSamples >= PARITY_CALIBRATION_SAMPLES) {
        const ratio = laneRate / laneMean;
        calibration = ratio >= 1 ? 1 + Math.min(0.25, (ratio - 1) * 0.5) : clamp(ratio, 0.35, 1);
        recordEarned = ratio >= 1;
    }
    const calibratedEven = clamp(0.5 + (pEven - 0.5) * calibration, 0.01, 0.99);
    const probability = evenSide ? calibratedEven : 1 - calibratedEven;
    const ev = probability * (evenSide ? payoutEven : payoutOdd) - 1;
    const seEv = (evenSide ? payoutEven : payoutOdd) * stderr;
    const evLower = ev - seEv;
    const evZ = seEv > 0 ? ev / seEv : 0;
    const edge = probability - breakEven;

    // Agreement: the weight share leaning with the side, among voting experts.
    // The uniform anchor is expected on the fence, so it never votes.
    let agreeing = 0;
    let voting = 0;
    live.forEach((expert, m) => {
        if (expert.name === 'uniform' || mixture[m] < 0.04) return;
        voting += mixture[m];
        const lean = expert.raw - 0.5;
        if ((evenSide && lean > 0) || (!evenSide && lean < 0)) agreeing += mixture[m];
    });
    const agreement = voting > 0 ? agreeing / voting : 0;
    const confidence = clamp(100 * (0.45 * agreement + 0.35 * dataQuality + 0.2 * skill), 0, 100);

    // ---- the gates -----------------------------------------------------------
    const minAgreement = clamp(safe(options.minAgreement, 0), 0, 1);
    const minEdge = safe(options.minEdge, 0);
    const minConfidence = clamp(safe(options.minConfidence, 0), 0, 100);
    const minEv = safe(options.minEv, 0);
    const floor = clamp(safe(threshold, 0), 0, 1);
    const requireEdge = options.requireEdge !== false;
    let ready = true;
    let reason = '';
    const sideName = evenSide ? 'EVEN' : 'ODD';
    // The probability floor is unconditional (it only exists when set above
    // zero); every other bar belongs to selective mode. In cadence mode the
    // best side is bought on every readable cycle and the stake — not the
    // gate — carries the caution.
    if (floor > 0 && probability < floor) {
        ready = false;
        reason = `probability ${(probability * 100).toFixed(1)}% below the ${(floor * 100).toFixed(0)}% floor`;
    } else if (requireEdge && agreement < minAgreement) {
        ready = false;
        reason = `model agreement ${(agreement * 100).toFixed(0)}% below ${(minAgreement * 100).toFixed(0)}%`;
    } else if (requireEdge && edge < minEdge) {
        ready = false;
        reason = `edge ${(edge * 100).toFixed(2)}pt below ${(minEdge * 100).toFixed(2)}pt over break-even`;
    } else if (requireEdge && minConfidence > 0 && confidence < minConfidence) {
        ready = false;
        reason = `confidence ${confidence.toFixed(0)} below ${minConfidence.toFixed(0)}`;
    } else if (requireEdge && minEv > 0 && evLower < minEv) {
        ready = false;
        reason = `no value — EV lower bound ${(evLower * 100).toFixed(2)}% below the ${(minEv * 100).toFixed(1)}% floor`;
    }
    const evidenceRate = graded ? clamp(safe(evidence?.rate, 0), 0, 1) : 0;
    // Side-aware t: the lean behind the side being bought, so an ODD pick at
    // −3σ reads as the +3σ odd-lean it is.
    const tSide = evenSide ? z : -z;
    if (ready) {
        reason =
            `${sideName} ${(probability * 100).toFixed(1)}% @ ${(evenSide ? payoutEven : payoutOdd).toFixed(2)}×` +
            ` · EV ${(ev * 100).toFixed(2)}% (floor ${(evLower * 100).toFixed(2)}%) · t ${tSide.toFixed(2)}σ` +
            ` · conf ${confidence.toFixed(0)} · agree ${(agreement * 100).toFixed(0)}% · n=${Math.round(effectiveSample)}` +
            (graded >= PARITY_CALIBRATION_SAMPLES
                ? ` · record ${(evidenceRate * 100).toFixed(1)}% of ${graded} · cal ${calibration.toFixed(2)}`
                : '');
    }

    // ---- league, certainty, stand-down ---------------------------------------
    const league = PARITY_MODEL_NAMES.map((name, m) => ({
        name,
        weight: mixture[m],
        brier: brier[m],
        skill: skills[m],
        probability: live[m].shrunk,
    })).sort((left, right) => right.skill - left.skill);
    const models = PARITY_MODEL_NAMES.map((name, m) => ({
        name,
        weight: mixture[m],
        brier: brier[m],
        skill: skills[m],
        probability: live[m].shrunk,
    }));
    const skillScore = clamp(50 + 200 * skill, 0, 100);
    const evScore = Number.isFinite(ev) ? clamp(50 + 500 * ev, 0, 100) : 50;
    const certainty = clamp(0.5 * confidence + 0.25 * skillScore + 0.25 * evScore, 0, 100);

    let standDown = 0;
    if (graded >= PARITY_STAND_DOWN_SAMPLES && Number.isFinite(evidenceRate)) {
        const zed = 1.64;
        const centre = (evidenceRate + (zed * zed) / (2 * graded)) / (1 + (zed * zed) / graded);
        const half =
            (zed * Math.sqrt((evidenceRate * (1 - evidenceRate)) / graded + (zed * zed) / (4 * graded * graded))) /
            (1 + (zed * zed) / graded);
        standDown = centre + half < breakEven ? 1 : 0;
    }

    const payoutAt = evenSide ? payoutEven : payoutOdd;

    const evTable = [
        {
            outcome: 0,
            side: 1,
            label: 'EVEN',
            probability: calibratedEven,
            winProbability: calibratedEven,
            payout: payoutEven,
            fairPayout: parityFairMultiple(calibratedEven),
            breakEven: 1 / payoutEven,
            ev: calibratedEven * payoutEven - 1,
        },
        {
            outcome: 1,
            side: -1,
            label: 'ODD',
            probability: 1 - calibratedEven,
            winProbability: 1 - calibratedEven,
            payout: payoutOdd,
            fairPayout: parityFairMultiple(1 - calibratedEven),
            breakEven: 1 / payoutOdd,
            ev: (1 - calibratedEven) * payoutOdd - 1,
        },
    ];
    const runnerUp = evenSide ? evTable[1] : evTable[0];

    const brain = {
        version: PARITY_MODEL_VERSION,
        experts: PARITY_MODEL_NAMES.length,
        net: {
            updates: softUpdates + parityUpdates,
            hidden: 6,
            norm: netNorm(parityWeights),
            lr: 0.1,
            softmaxNorm: Math.sqrt(softWeights.reduce((acc, row) => acc + row.reduce((a, v) => a + v * v, 0), 0)),
        },
        regime: dna.regime,
        regimeSamples: scored,
        gated: false,
        top: league.slice(0, 3).map(expert => ({ name: expert.name, weight: expert.weight, skill: expert.skill })),
        skill,
        calibration,
        votes: live.map((expert, m) => ({ name: expert.name, pEven: expert.shrunk, weight: mixture[m] })),
    };

    return {
        ready,
        modelReady: true,
        side,
        probability,
        evenProbability: calibratedEven,
        winProbability: probability,
        samples: Math.round(effectiveSample),
        conditionalSamples: scored,
        horizon: duration,
        forecastHorizon,
        edge,
        ev,
        evLower,
        seEv,
        evZ,
        z,
        tStat: typeof tSide === 'number' ? tSide : z,
        breakEven,
        payout: payoutAt,
        payoutAt,
        payoutEven,
        payoutOdd,
        payoutLive,
        fairPayout: parityFairMultiple(probability),
        evMargin: ev - runnerUp.ev,
        confidence,
        certainty,
        agreement,
        outcomeAgreement: agreement,
        separation: Math.abs(evTable[0].ev - evTable[1].ev),
        stderr,
        skill,
        dnaScore: dna.readability,
        dna,
        brain,
        forecast: evTable.map(row => ({
            label: row.label,
            probability: row.probability,
            payout: row.payout,
            ev: row.ev,
        })),
        evTable,
        league,
        models,
        hitRate: evidenceRate,
        hitSamples: graded,
        calibration,
        recordEarned,
        standDown,
        reason,
        version: PARITY_MODEL_VERSION,
    };
}

/* ------------------------------------------------------------------ *
 * The scout's yardstick + the journal reports
 * ------------------------------------------------------------------ */

/**
 * A 0–100 read on how worth trading a market is: measured expected value,
 * the engine's certainty, the DNA readability, the sample behind the
 * decision and the blend's walk-forward skill. It ranks markets; it does
 * not promise profit.
 */
export function scoreParityMarket(plan, dna) {
    if (!plan) return 0;
    // A dead tape scores nothing: its phantom edge is what the frozen veto
    // exists to refuse, and the scout must walk away from it, not toward it.
    if (dna?.phase === 'frozen') return 0;
    const ev = Number.isFinite(plan.ev) ? clamp(plan.ev, -0.2, 0.2) : 0;
    const evScore = clamp((ev + 0.05) / 0.15, 0, 1);
    const certainty = clamp(safe(plan.certainty, 0) / 100, 0, 1);
    const readability = clamp(safe(dna?.readability, safe(plan.dnaScore, 0)) / 100, 0, 1);
    const sample = clamp(safe(plan.samples, 0) / 600, 0, 1);
    const skill = clamp((50 + 200 * safe(plan.skill, 0)) / 100, 0, 1);
    return Math.round(100 * (0.35 * evScore + 0.2 * certainty + 0.15 * readability + 0.15 * sample + 0.15 * skill) * 10) / 10;
}

/** Each expert's measured Brier skill against the 0.5 anchor, best first. */
export function parityLeagueReport(decision) {
    const league = Array.isArray(decision?.league) ? decision.league : [];
    if (!league.length) return 'league warming up — no decision has been scored yet';
    const rows = league
        .slice(0, 8)
        .map(expert => {
            const points = (safe(expert.skill, 0) * 100).toFixed(0);
            const sign = safe(expert.skill, 0) >= 0 ? '+' : '';
            return `${expert.name} ${sign}${points} (w ${Math.round(safe(expert.weight, 0) * 100)}%)`;
        })
        .join(' · ');
    return `league · ${rows}${league.length > 8 ? ` · +${league.length - 8} more` : ''}`;
}

/**
 * SELF-AUDIT — the bot holding itself to its own numbers: walk-forward
 * skill, certainty, the calibration it applied, the graded record against
 * the break-even it was paid, and whether the record warrants standing down.
 */
export function parityAuditReport(decision) {
    if (!decision || !decision.modelReady) return 'self-audit warming up — no decision has been scored yet';
    const gap = (safe(decision.hitRate, 0) - safe(decision.breakEven, 0.5)) * 100;
    const gapText = decision.hitSamples >= PARITY_CALIBRATION_SAMPLES ? ` · gap ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pt` : '';
    return [
        'self-audit',
        `skill ${(safe(decision.skill, 0) * 100).toFixed(0)}`,
        `certainty ${safe(decision.certainty, 0).toFixed(0)}`,
        `cal ${safe(decision.calibration, 1).toFixed(2)}×`,
        decision.hitSamples > 0
            ? `record ${(safe(decision.hitRate, 0) * 100).toFixed(1)}% of ${decision.hitSamples} vs BE ${(safe(decision.breakEven, 0.5) * 100).toFixed(1)}%${gapText}`
            : 'record warming up',
        decision.standDown ? 'STAND DOWN — record under break-even' : 'trading',
    ].join(' · ');
}

/** AI CORE — the internal brain as one journal line. */
export function parityBrainReport(decision) {
    const brain = decision?.brain;
    if (!brain) return 'AI core warming up — no decision has been scored yet';
    const top = (brain.top || [])
        .map(expert => `${expert.name} ${Math.round(safe(expert.weight, 0) * 100)}%`)
        .join(', ');
    return [
        `AI core v${brain.version || PARITY_MODEL_VERSION} · ${brain.experts || PARITY_MODEL_NAMES.length} experts`,
        `parity-net ${(brain.net?.updates ?? 0)} updates (‖w‖ ${safe(brain.net?.norm, 0).toFixed(2)})`,
        `regime ${brain.regime || 'balanced'} (${brain.regimeSamples || 0} scored)`,
        top ? `carrying: ${top}` : 'carrying: anchor',
        `skill ${(safe(brain.skill, 0) * 100).toFixed(0)} · calibration ${safe(brain.calibration, 1).toFixed(2)}×`,
    ].join(' · ');
}

/**
 * REVERSE ENGINEERING — the market's deep diagnosis: phase, regime, memory,
 * entropy, spikes and repetition, plus the auto-tuning the bot derived.
 * Descriptive, not predictive.
 */
export function parityReverseReport(dna) {
    if (!dna || !dna.windows) return String(dna?.verdict || 'reverse engineering warming up — waiting for ticks');
    const tune = dna.autoTune || {};
    return [
        `reverse engineering · ${dna.phase} phase · ${dna.regime} regime`,
        `runs z ${safe(dna.runsZ, 0).toFixed(2)}`,
        `Markov χ² ${safe(dna.markovChi, 0).toFixed(1)} · digit χ² ${safe(dna.digitChi, 0).toFixed(1)}`,
        `alternation ${(safe(dna.alternation, 0.5) * 100).toFixed(1)}%`,
        `entropy ${safe(dna.entropy, 0).toFixed(2)}/${safe(dna.maxEntropy, 3.32).toFixed(2)}`,
        `repeat ${(safe(dna.repeatRate, 0) * 100).toFixed(1)}% · longest run ${dna.longestRun ?? 0} (exp ~${safe(dna.expectedRun, 0).toFixed(0)})`,
        `drift z ${safe(dna.driftZ, 0).toFixed(2)}`,
        `auto-tune: anchor trust ${(safe(tune.anchorTrust, 0.5) * 100).toFixed(0)}% · ${tune.family || 'blend'} leads`,
        String(tune.note || dna.verdict || ''),
    ].join(' · ');
}

/** FORECAST — both sides with their probabilities, EVs and live quotes. */
export function parityForecastReport(decision) {
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
    parityDecision,
    parityDna,
    scoreParityMarket,
    parityLeagueReport,
    parityAuditReport,
    parityBrainReport,
    parityReverseReport,
    parityForecastReport,
    parityFairMultiple,
    PARITY_MODEL_NAMES,
    PARITY_MODEL_VERSION,
};
