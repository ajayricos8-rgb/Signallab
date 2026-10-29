/** Price-path ensemble for the shipped DBot strategies.
 * Historical windows end before the current tick. Conditional Markov states
 * use the two most recent price changes; a shrinkage prior damps thin states.
 * These are historical estimates, not calibrated probabilities or guarantees.
 */
const sign = n => n > 0 ? 1 : n < 0 ? -1 : 0;
const stateAt = (p, i) => `${sign(p[i - 1] - p[i - 2])},${sign(p[i] - p[i - 1])}`;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function features(p, end = p.length - 1) {
    const start = Math.max(1, end - 13);
    let up = 0, down = 0, movement = 0;
    for (let i = start; i <= end; i++) {
        const d = p[i] - p[i - 1];
        up += Math.max(0, d); down += Math.max(0, -d); movement += Math.abs(d);
    }
    const rsi = up + down ? (up - down) / (up + down) : 0;
    const slope = movement ? (p[end] - p[start - 1]) / movement : 0;
    return { rsi, slope };
}

/** horizon is contract duration: entry is the first tick after the decision,
 * and expiry is horizon ticks after entry. Equality wins neither side. */
export function priceDecision(values, mode = 'rise', horizon = 4, threshold = 0.56) {
    const p = Array.isArray(values) ? values.map(Number) : [];
    const empty = { ready: false, side: 0, tick: 0, probability: 0, samples: 0, conditionalSamples: 0, horizon: 0 };
    if (p.length < 256 || p.some(v => !Number.isFinite(v))) return empty;
    const isTick = mode === 'tick';
    const h = isTick ? 4 : Math.round(Number(horizon));
    if (!Number.isFinite(h) || h < 1 || h > 10) return empty;
    const count = isTick ? 10 : 2;
    const global = Array(count).fill(0), conditional = Array(count).fill(0), recent = Array(count).fill(0);
    const state = stateAt(p, p.length - 1);
    let n = 0, matched = 0, recentN = 0;
    const examples = [];
    // Most recent historical endpoint is at p.length - 1; no future leakage.
    for (let i = Math.max(2, p.length - 1000); i + h + 1 < p.length; i++) {
        const match = stateAt(p, i) === state;
        const isRecent = i >= p.length - 251;
        let winners = [];
        if (isTick) {
            const window = p.slice(i + 1, i + 6);
            const high = Math.max(...window), low = Math.min(...window);
            if (window.filter(v => v === high).length === 1) winners.push(window.indexOf(high));
            if (window.filter(v => v === low).length === 1) winners.push(5 + window.indexOf(low));
        } else {
            const d = p[i + h + 1] - p[i + 1];
            if (d > 0) winners = [0];
            else if (d < 0) winners = [1];
        }
        const f = features(p, i);
        examples.push({ x: [1, sign(p[i] - p[i - 1]), sign(p[i - 1] - p[i - 2]), f.rsi, f.slope], winners });
        n++; if (match) matched++; if (isRecent) recentN++;
        for (const k of winners) { global[k]++; if (match) conditional[k]++; if (isRecent) recent[k]++; }
    }
    if (n < 200 || matched < 20 || recentN < 50) return { ...empty, samples: n, conditionalSamples: matched, horizon: isTick ? 5 : h };
    const f = features(p);
    const currentX = [1, sign(p.at(-1) - p.at(-2)), sign(p.at(-2) - p.at(-3)), f.rsi, f.slope];
    // A small online logistic learner is trained afresh on completed windows.
    // Each of the ten extreme outcomes (or two directional outcomes) has its
    // own classifier. Regularization and a low blend weight limit overfitting;
    // these scores are not calibrated odds and do not include broker payouts.
    const sigmoid = z => 1 / (1 + Math.exp(-clamp(z, -20, 20)));
    const weights = global.map(wins => {
        const base = clamp(wins / n, 0.005, 0.995);
        return [Math.log(base / (1 - base)), 0, 0, 0, 0];
    });
    for (const example of examples) {
        for (let k = 0; k < count; k++) {
            const w = weights[k];
            const prediction = sigmoid(w.reduce((sum, value, j) => sum + value * example.x[j], 0));
            const error = (example.winners.includes(k) ? 1 : 0) - prediction;
            for (let j = 0; j < w.length; j++) w[j] += 0.015 * (error * example.x[j] - (j ? 0.02 * w[j] : 0));
        }
    }
    const scores = global.map((wins, k) => {
        if (!wins) return 0;
        const base = wins / n;
        const markov = (conditional[k] + 40 * base) / (matched + 40);
        const short = (recent[k] + 30 * base) / (recentN + 30);
        // Indicators only gently adjust the directional estimate; tick
        // position scores remain direct empirical extreme frequencies.
        const indicator = isTick ? 0 : (k === 0 ? 1 : -1) * (0.0125 * f.rsi + 0.0125 * f.slope);
        const learned = sigmoid(weights[k].reduce((sum, value, j) => sum + value * currentX[j], 0));
        return clamp(0.45 * markov + 0.25 * base + 0.10 * short + 0.20 * learned + indicator, 0, 1);
    });
    const best = scores.indexOf(Math.max(...scores));
    const min = Number.isFinite(Number(threshold)) ? clamp(Number(threshold), 0, 1) : (isTick ? 0.30 : 0.56);
    return { ready: scores[best] > 0 && scores[best] >= min, side: isTick ? (best < 5 ? 1 : -1) : (best === 0 ? 1 : -1), tick: isTick ? best % 5 + 1 : 0, probability: scores[best], samples: n, conditionalSamples: matched, horizon: isTick ? 5 : h };
}
