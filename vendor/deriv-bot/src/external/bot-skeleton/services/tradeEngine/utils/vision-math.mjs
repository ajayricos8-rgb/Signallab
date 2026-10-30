/**
 * Vision Lab — maths and measurement kernel.
 *
 * Every function here is pure, synchronous and dependency-free: it takes plain
 * JavaScript arrays of numbers and returns numbers or arrays. That keeps the
 * Blockly runtime thin (the generated code only ever calls `Bot.*`), keeps the
 * interpreter fast (no loops run inside the ES5 interpreter), and lets the same
 * code be unit-tested outside the browser.
 *
 * The module is `.mjs` so Node can import it directly in tests; the bundler
 * resolves it the same way it resolves every other ESM file in the workspace.
 */

export const EPSILON = 1e-12;

export const isNum = value => typeof value === 'number' && Number.isFinite(value);

/** Coerce anything the blocks hand us (strings, pseudo arrays) into numbers. */
export function toNumbers(input) {
    if (!input) return [];
    const source = Array.isArray(input) ? input : [input];
    const out = [];
    for (let i = 0; i < source.length; i++) {
        const raw = source[i];
        const value = typeof raw === 'number' ? raw : parseFloat(raw);
        if (Number.isFinite(value)) out.push(value);
    }
    return out;
}

/** Keep the newest `count` values (oldest first). */
export function windowSlice(values, count) {
    const list = toNumbers(values);
    if (!isNum(count) || count <= 0) return list;
    const size = Math.min(list.length, Math.floor(count));
    return list.slice(list.length - size);
}

export const last = values => (values.length ? values[values.length - 1] : null);

export function sum(values) {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[i];
    return total;
}

export function mean(values) {
    return values.length ? sum(values) / values.length : 0;
}

export function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function variance(values, sample = true) {
    if (values.length < 2) return 0;
    const mu = mean(values);
    let acc = 0;
    for (let i = 0; i < values.length; i++) acc += (values[i] - mu) ** 2;
    return acc / (values.length - (sample ? 1 : 0));
}

export const stdDev = (values, sample = true) => Math.sqrt(Math.max(variance(values, sample), 0));

export function mad(values) {
    if (!values.length) return 0;
    const centre = median(values);
    return median(values.map(value => Math.abs(value - centre)));
}

export function rms(values) {
    if (!values.length) return 0;
    return Math.sqrt(mean(values.map(value => value * value)));
}

export function skewness(values) {
    const n = values.length;
    if (n < 3) return 0;
    const sigma = stdDev(values);
    if (sigma < EPSILON) return 0;
    const mu = mean(values);
    let acc = 0;
    for (let i = 0; i < n; i++) acc += ((values[i] - mu) / sigma) ** 3;
    return (n / ((n - 1) * (n - 2))) * acc;
}

export function kurtosis(values) {
    const n = values.length;
    if (n < 4) return 0;
    const sigma = stdDev(values);
    if (sigma < EPSILON) return 0;
    const mu = mean(values);
    let acc = 0;
    for (let i = 0; i < n; i++) acc += ((values[i] - mu) / sigma) ** 4;
    return acc / n - 3; // excess kurtosis
}

export function quantile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const rank = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export const iqr = values => quantile(values, 0.75) - quantile(values, 0.25);

/** One statistic of a series, chosen by name. */
export function statistic(values, name) {
    const list = toNumbers(values);
    switch (String(name).toLowerCase()) {
        case 'sum':
            return sum(list);
        case 'mean':
        case 'average':
            return mean(list);
        case 'median':
            return median(list);
        case 'min':
            return list.length ? Math.min(...list) : 0;
        case 'max':
            return list.length ? Math.max(...list) : 0;
        case 'range':
            return list.length ? Math.max(...list) - Math.min(...list) : 0;
        case 'variance':
            return variance(list);
        case 'stddev':
            return stdDev(list);
        case 'mad':
            return mad(list);
        case 'rms':
            return rms(list);
        case 'skew':
            return skewness(list);
        case 'kurtosis':
            return kurtosis(list);
        case 'iqr':
            return iqr(list);
        case 'count':
            return list.length;
        default:
            return mean(list);
    }
}

/** Tick-to-tick differences. `absolute` gives magnitudes only. */
export function returns(values, absolute = false) {
    const list = toNumbers(values);
    const out = [];
    for (let i = 1; i < list.length; i++) {
        const delta = list[i] - list[i - 1];
        out.push(absolute ? Math.abs(delta) : delta);
    }
    return out;
}

/** Simple moving average of the trailing `period` values. */
export function sma(values, period) {
    const list = toNumbers(values);
    const size = Math.max(1, Math.min(Math.floor(period) || 1, list.length));
    return mean(list.slice(list.length - size));
}

/** Exponentially weighted moving average over the whole series. */
export function ema(values, period) {
    const list = toNumbers(values);
    if (!list.length) return 0;
    const size = Math.max(1, Math.floor(period) || 1);
    const alpha = 2 / (size + 1);
    let value = list[0];
    for (let i = 1; i < list.length; i++) value = alpha * list[i] + (1 - alpha) * value;
    return value;
}

/** Weighted moving average: newest value carries the most weight. */
export function wma(values, period) {
    const list = toNumbers(values);
    const size = Math.max(1, Math.min(Math.floor(period) || 1, list.length));
    const slice = list.slice(list.length - size);
    let weightTotal = 0;
    let acc = 0;
    for (let i = 0; i < slice.length; i++) {
        const weight = i + 1;
        acc += slice[i] * weight;
        weightTotal += weight;
    }
    return weightTotal ? acc / weightTotal : 0;
}

/** Rolling average of |Δ| — the tick equivalent of an average true range. */
export function atr(values, period) {
    const changes = returns(values, true);
    const size = Math.max(1, Math.min(Math.floor(period) || 1, changes.length));
    return mean(changes.slice(changes.length - size));
}

/** Wilder's RSI over tick-to-tick changes. */
export function rsi(values, period = 14) {
    const changes = returns(values);
    const size = Math.max(2, Math.floor(period) || 14);
    if (changes.length < size) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = 0; i < size; i++) {
        if (changes[i] >= 0) gains += changes[i];
        else losses -= changes[i];
    }
    let avgGain = gains / size;
    let avgLoss = losses / size;
    for (let i = size; i < changes.length; i++) {
        const change = changes[i];
        avgGain = (avgGain * (size - 1) + Math.max(change, 0)) / size;
        avgLoss = (avgLoss * (size - 1) + Math.max(-change, 0)) / size;
    }
    if (avgLoss < EPSILON) return avgGain < EPSILON ? 50 : 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

/** Bollinger %B: 0 at the lower band, 1 at the upper band, can exceed both. */
export function bollingerPercentB(values, period = 20, deviations = 2) {
    const list = toNumbers(values);
    const size = Math.max(2, Math.min(Math.floor(period) || 20, list.length));
    const slice = list.slice(list.length - size);
    const middle = mean(slice);
    const sigma = stdDev(slice);
    if (sigma < EPSILON) return 0.5;
    return (last(slice) - middle) / (deviations * sigma) / 2 + 0.5;
}

/** MACD line (fast EMA − slow EMA); `signal` returns the signal EMA instead. */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9, wantSignal = false) {
    const list = toNumbers(values);
    if (list.length < 2) return 0;
    const fastAlpha = 2 / (Math.max(1, fast) + 1);
    const slowAlpha = 2 / (Math.max(1, slow) + 1);
    const signalAlpha = 2 / (Math.max(1, signalPeriod) + 1);
    let fastValue = list[0];
    let slowValue = list[0];
    let signalValue = 0;
    let line = 0;
    for (let i = 1; i < list.length; i++) {
        fastValue = fastAlpha * list[i] + (1 - fastAlpha) * fastValue;
        slowValue = slowAlpha * list[i] + (1 - slowAlpha) * slowValue;
        line = fastValue - slowValue;
        signalValue = signalAlpha * line + (1 - signalAlpha) * signalValue;
    }
    return wantSignal ? signalValue : line;
}

/** Least-squares slope per sample (positive = rising). */
export function slope(values) {
    const list = toNumbers(values);
    const n = list.length;
    if (n < 2) return 0;
    const xMean = (n - 1) / 2;
    const yMean = mean(list);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
        numerator += (i - xMean) * (list[i] - yMean);
        denominator += (i - xMean) ** 2;
    }
    return denominator < EPSILON ? 0 : numerator / denominator;
}

/** Pearson correlation between two equally long series. */
export function correlation(a, b) {
    const left = toNumbers(a);
    const right = toNumbers(b);
    const n = Math.min(left.length, right.length);
    if (n < 2) return 0;
    const xMean = mean(left.slice(left.length - n));
    const yMean = mean(right.slice(right.length - n));
    let numerator = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
        const xv = left[left.length - n + i] - xMean;
        const yv = right[right.length - n + i] - yMean;
        numerator += xv * yv;
        dx += xv * xv;
        dy += yv * yv;
    }
    const denominator = Math.sqrt(dx * dy);
    return denominator < EPSILON ? 0 : numerator / denominator;
}

/** Autocorrelation at `lag` — mean reversion shows up as negative values. */
export function autocorrelation(values, lag = 1) {
    const list = toNumbers(values);
    const k = Math.max(1, Math.floor(lag) || 1);
    if (list.length <= k + 1) return 0;
    const mu = mean(list);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < list.length; i++) denominator += (list[i] - mu) ** 2;
    for (let i = 0; i + k < list.length; i++) numerator += (list[i] - mu) * (list[i + k] - mu);
    return denominator < EPSILON ? 0 : numerator / denominator;
}

/**
 * Rescaled-range Hurst estimate. ~0.5 is a random walk, > 0.5 trends,
 * < 0.5 mean reverts. Uses log-spaced lags over the series.
 */
export function hurst(values, maxLag = 20) {
    const list = toNumbers(values);
    if (list.length < 40) return 0.5;
    const changes = returns(list);
    const lags = [];
    const tau = [];
    const limit = Math.min(maxLag, Math.floor(changes.length / 4));
    for (let lag = 2; lag <= Math.max(2, limit); lag++) {
        const diffs = changes.slice(lag).map((value, i) => value - changes[i]);
        if (diffs.length < 4) continue;
        lags.push(Math.log(lag));
        tau.push(Math.log(Math.sqrt(mean(diffs.map(value => value * value)))));
    }
    if (lags.length < 3) return 0.5;
    const beta = slopeOfPairs(lags, tau);
    return Math.min(Math.max(isNum(beta) ? beta : 0.5, 0), 1);
}

function slopeOfPairs(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return 0;
    const xMean = mean(xs.slice(0, n));
    const yMean = mean(ys.slice(0, n));
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
        numerator += (xs[i] - xMean) * (ys[i] - yMean);
        denominator += (xs[i] - xMean) ** 2;
    }
    return denominator < EPSILON ? 0 : numerator / denominator;
}

/** Shannon entropy in bits of the last-digit distribution (log2 10 ≈ 3.32 max). */
export function digitEntropy(values, pipSize = null) {
    const digits = lastDigits(values, pipSize);
    if (!digits.length) return 0;
    const counts = new Array(10).fill(0);
    for (let i = 0; i < digits.length; i++) counts[digits[i]] += 1;
    let entropy = 0;
    for (let d = 0; d < 10; d++) {
        if (!counts[d]) continue;
        const p = counts[d] / digits.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

/** How many decimal places a quote carries (used as the pip size). */
export function inferPipSize(values) {
    for (let i = Math.min(values.length - 1, 40); i >= 0; i--) {
        const text = String(values[i]);
        const dot = text.indexOf('.');
        if (dot >= 0) return text.length - dot - 1;
    }
    return 2;
}

/** The final digit of every quote (0-9), using the market's decimal places. */
export function lastDigits(values, pipSize = null) {
    const list = toNumbers(values);
    const decimals = isNum(pipSize) ? Math.max(0, Math.min(Math.round(pipSize), 8)) : inferPipSize(list);
    const factor = 10 ** decimals;
    return list.map(value => {
        const scaled = Math.round(Math.abs(value) * factor) % 10;
        return ((scaled % 10) + 10) % 10;
    });
}

export const lastDigitOf = (value, pipSize = null) => {
    const list = toNumbers([value]);
    if (!list.length) return 0;
    const digits = lastDigits(list, isNum(pipSize) ? pipSize : inferPipSize(list));
    return digits[0];
};

/** Ten counters, index = digit, value = how often that digit appeared. */
export function digitCounts(values, pipSize = null) {
    const digits = lastDigits(values, pipSize);
    const counts = new Array(10).fill(0);
    for (let i = 0; i < digits.length; i++) counts[digits[i]] += 1;
    return counts;
}

/** Digit frequency in percent (index = digit). */
export function digitFrequencies(values, pipSize = null) {
    const counts = digitCounts(values, pipSize);
    const total = sum(counts) || 1;
    return counts.map(count => (count / total) * 100);
}

/** The most frequent digit in the series. */
export function dominantDigit(values, pipSize = null) {
    const counts = digitCounts(values, pipSize);
    let index = 0;
    for (let d = 1; d < 10; d++) if (counts[d] > counts[index]) index = d;
    return index;
}

/** Spread between the most and least frequent digit, in percentage points. */
export function digitSpread(values, pipSize = null) {
    const frequencies = digitFrequencies(values, pipSize);
    return Math.max(...frequencies) - Math.min(...frequencies);
}

/** Share of even last digits, in percent. */
export function evenShare(values, pipSize = null) {
    const digits = lastDigits(values, pipSize);
    if (!digits.length) return 50;
    let even = 0;
    for (let i = 0; i < digits.length; i++) if (digits[i] % 2 === 0) even += 1;
    return (even / digits.length) * 100;
}

/** Chi-square statistic of the digit distribution against uniform (10 bins). */
export function digitChiSquare(values, pipSize = null) {
    const counts = digitCounts(values, pipSize);
    const total = sum(counts);
    if (!total) return 0;
    const expected = total / 10;
    let acc = 0;
    for (let d = 0; d < 10; d++) acc += (counts[d] - expected) ** 2 / expected;
    return acc;
}

/** Largest peak-to-trough fall inside the series, in quote points. */
export function maxDrawdown(values) {
    const list = toNumbers(values);
    let peak = list.length ? list[0] : 0;
    let worst = 0;
    for (let i = 0; i < list.length; i++) {
        if (list[i] > peak) peak = list[i];
        const drop = peak - list[i];
        if (drop > worst) worst = drop;
    }
    return worst;
}

/** Signed streak of consecutive rises (+) or falls (−) at the end of a series. */
export function streak(values) {
    const changes = returns(values);
    if (!changes.length) return 0;
    let count = 0;
    const direction = changes[changes.length - 1] > 0 ? 1 : changes[changes.length - 1] < 0 ? -1 : 0;
    if (!direction) return 0;
    for (let i = changes.length - 1; i >= 0; i--) {
        const sign = changes[i] > 0 ? 1 : changes[i] < 0 ? -1 : 0;
        if (sign !== direction) break;
        count += 1;
    }
    return count * direction;
}

/** How many times the last digit repeated in a row at the end of the series. */
export function digitStreak(values, pipSize = null) {
    const digits = lastDigits(values, pipSize);
    if (!digits.length) return 0;
    const target = digits[digits.length - 1];
    let count = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] !== target) break;
        count += 1;
    }
    return count;
}

/** Signed length of the current even (+) / odd (−) run. */
export function parityRun(values, pipSize = null) {
    const digits = lastDigits(values, pipSize);
    if (!digits.length) return 0;
    const direction = digits[digits.length - 1] % 2 === 0 ? 1 : -1;
    let count = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] % 2 !== (direction > 0 ? 0 : 1)) break;
        count += 1;
    }
    return count * direction;
}

/** Signed length of the current run of digits over (+) / under (−) `barrier`. */
export function overUnderRun(values, barrier, pipSize = null) {
    const digits = lastDigits(values, pipSize);
    if (!digits.length) return 0;
    const level = Math.round(barrier);
    const tail = digits[digits.length - 1];
    if (tail === level) return 0;
    const direction = tail > level ? 1 : -1;
    let count = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] === level) break;
        if (digits[i] > level !== direction > 0) break;
        count += 1;
    }
    return count * direction;
}

/**
 * Empirical probability (0-100) that the digit `horizon` ticks after a state
 * like the current one is over/under `barrier`, measured by replaying history.
 */
export function historicalOverUnder(values, barrier, horizon, direction = 'over', pipSize = null) {
    const digits = lastDigits(values, pipSize);
    const h = Math.max(1, Math.floor(horizon) || 1);
    if (digits.length <= h + 5) return direction === 'over' ? ((9 - barrier) / 10) * 100 : (barrier / 10) * 100;
    let wins = 0;
    let total = 0;
    for (let i = 0; i + h < digits.length; i++) {
        const future = digits[i + h];
        total += 1;
        if (direction === 'over' ? future > barrier : future < barrier) wins += 1;
    }
    if (!total) return 50;
    return (wins / total) * 100;
}

/** P(digit at t+horizon = d | digit now = c) rows, from the series itself. */
export function transitionMatrix(values, horizon = 1, pipSize = null) {
    const digits = lastDigits(values, pipSize);
    const h = Math.max(1, Math.floor(horizon) || 1);
    const matrix = Array.from({ length: 10 }, () => new Array(10).fill(0));
    for (let i = 0; i + h < digits.length; i++) matrix[digits[i]][digits[i + h]] += 1;
    return matrix;
}

/** Normalise one row of a transition matrix into a probability vector. */
export function transitionRow(matrix, from) {
    const row = matrix[Math.max(0, Math.min(9, Math.floor(from) || 0))] || [];
    const total = sum(row);
    if (!total) return new Array(10).fill(0.1);
    return row.map(value => value / total);
}

/** Distance from the last quote to the nearest round level of `step` points. */
export function distanceToLevel(values, step = 1) {
    const list = toNumbers(values);
    if (!list.length) return 0;
    const size = Math.abs(step) < EPSILON ? 1 : step;
    const value = last(list);
    const below = Math.floor(value / size) * size;
    const above = below + size;
    return Math.min(value - below, above - value);
}

/** Ticks per minute implied by the epochs in a tick list. */
export function tickRate(epochs) {
    const list = toNumbers(epochs);
    if (list.length < 2) return 0;
    const span = list[list.length - 1] - list[0];
    if (span <= 0) return 0;
    return ((list.length - 1) / span) * 60;
}

/** Clamp, linear interpolation and range mapping helpers. */
export const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
export const lerp = (a, b, t) => a + (b - a) * t;
export function mapRange(value, inLow, inHigh, outLow, outHigh) {
    const span = inHigh - inLow;
    if (Math.abs(span) < EPSILON) return outLow;
    return outLow + ((value - inLow) / span) * (outHigh - outLow);
}

/** Deterministic pseudo-random generator so strategies can be replayed. */
export function seededRandom(seed) {
    let state = (Math.floor(seed) || 1) % 2147483647;
    if (state <= 0) state += 2147483646;
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
}

export const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -35, 35)));

/** Kelly fraction (0-1) for a given win probability and payout multiple. */
export function kellyFraction(probability, payoutMultiple) {
    const p = clamp(probability, 0, 1);
    const b = Math.max(0, payoutMultiple) - 1;
    if (b <= 0) return 0;
    const fraction = (p * (b + 1) - 1) / b;
    return clamp(fraction, 0, 1);
}

/** Standard normal CDF, used for the z-score based confidence read-outs. */
export function normalCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
}

export default {
    atr,
    autocorrelation,
    bollingerPercentB,
    clamp,
    correlation,
    digitChiSquare,
    digitCounts,
    digitEntropy,
    digitFrequencies,
    digitSpread,
    digitStreak,
    distanceToLevel,
    dominantDigit,
    ema,
    evenShare,
    historicalOverUnder,
    hurst,
    inferPipSize,
    iqr,
    kellyFraction,
    kurtosis,
    lastDigitOf,
    lastDigits,
    lerp,
    macd,
    mad,
    mapRange,
    maxDrawdown,
    mean,
    median,
    normalCdf,
    overUnderRun,
    parityRun,
    quantile,
    returns,
    rms,
    rsi,
    seededRandom,
    sigmoid,
    skewness,
    sma,
    slope,
    stdDev,
    statistic,
    streak,
    sum,
    tickRate,
    toNumbers,
    transitionMatrix,
    transitionRow,
    variance,
    wma,
};
