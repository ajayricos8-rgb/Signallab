/**
 * Markov-chain read for tick contracts.
 *
 * The price-path ensemble in `price-strategies.mjs` answers "which side?" with
 * sixteen experts mixed by walk-forward skill. This module answers the same
 * question with one thing, and answers it exactly: an order-k Markov chain on
 * the tick *directions*, projected forward over the contract horizon by
 * enumerating every state the chain can be in after each tick.
 *
 * Why a chain rather than a frequency table:
 *
 *   - A tick stream is not i.i.d. A run of steps changes the distribution of
 *     the next step (a stretched tape mean-reverts, a trending one continues),
 *     and a chain conditions on that structure instead of averaging over it.
 *   - The projection is exact, not a one-step guess repeated. A four-tick
 *     contract is settled by the *net* displacement after four steps, so the
 *     module carries (state, displacement) forward tick by tick and reads
 *     P(net > 0), P(net = 0) and P(net < 0) off the last layer.
 *   - The tie is priced, not hidden. On a strict Rise/Fall contract an exit
 *     equal to the entry loses both sides, so P(tie) is a real cost of the
 *     shape, and a Step Index at four ticks pays 6/16 = 37.5 % of it.
 *
 * Everything the module returns is measured from the tick list handed in:
 * there is no stored model, no global state and no look-ahead. The walk-forward
 * readers (smoothing, samples, significance) all use transitions that were
 * complete before the last quote.
 *
 * Estimates are conditional frequencies, not calibrated odds. A positive edge
 * against the break-even means "this chain's conditional read beats the price",
 * which is a weak claim on a synthetic index and is often false.
 */

/** Signs a tick direction can take, as probability-vector indices. */
const UP = 0;
const FLAT = 1;
const DOWN = 2;
const SYMBOLS = [1, 0, -1];

/** Model defaults; the block inputs override every one of them. */
export const MARKOV_ORDER_DEFAULT = 3;
export const MARKOV_MEMORY_DEFAULT = 400;
export const MARKOV_HORIZON_DEFAULT = 4;
export const MARKOV_MIN_SAMPLES_DEFAULT = 120;
export const MARKOV_PRIOR_WEIGHT = 3;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const safe = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const round = (value, places) => {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
};

/** Whole number inside a range; a bad knob falls back instead of throwing. */
const whole = (value, fallback, low, high) => clamp(Math.round(safe(value, fallback)), low, high);

/** Sign of a change, with an optional dead band for markets that print zeros. */
const signOf = (change, band) => {
    if (change > band) return 1;
    if (change < -band) return -1;
    return 0;
};

/** Index of a symbol in the probability vector. */
const indexOfSymbol = symbol => (symbol === 1 ? UP : symbol === 0 ? FLAT : DOWN);

/**
 * Complement of the chi-square CDF, via the Wilson–Hilferty normal
 * approximation. Good enough to say "this transition table looks random" at
 * the resolution a trading gate needs, without pulling in a statistics
 * library.
 */
function chiSquareTail(chi2, dof) {
    if (!(dof > 0) || !(chi2 > 0)) return 1;
    const z = ((chi2 / dof) ** (1 / 3) - (1 - 2 / (9 * dof))) / Math.sqrt(2 / (9 * dof));
    return clamp(1 - normalCdf(z), 0, 1);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 error < 1.5e-7). */
function normalCdf(z) {
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const erf =
        1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
            t *
            Math.exp(-x * x);
    return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Read a tick stream through an order-k Markov chain.
 *
 * @param {number[]} prices  tick quotes, oldest first
 * @param {object}   options
 *   order       state length in ticks (1–4, default 3)
 *   memory      transitions to fit the chain on (60–2000, default 400)
 *   horizon     contract length in ticks (1–10, default 4)
 *   payout      multiple a win pays (0.95 = +95 %); the break-even is 1/(1+p)
 *   minSamples  transitions the chain needs before it will publish
 *   band        change inside ±band counts as a flat tick (default 0: exact)
 *   priorWeight Dirichlet weight pulling a thin state toward the base rate
 */
export function markovRead(prices, options = {}) {
    const order = whole(options.order, MARKOV_ORDER_DEFAULT, 1, 4);
    const memory = whole(options.memory, MARKOV_MEMORY_DEFAULT, 60, 2000);
    const horizon = whole(options.horizon, MARKOV_HORIZON_DEFAULT, 1, 10);
    const minSamples = whole(options.minSamples, MARKOV_MIN_SAMPLES_DEFAULT, 20, 5000);
    const payout = Math.max(0.01, safe(options.payout, 0.95));
    const band = Math.max(0, safe(options.band, 0));
    const priorWeight = Math.max(0.5, safe(options.priorWeight, MARKOV_PRIOR_WEIGHT));
    const breakEven = 1 / (1 + payout);

    const series = [];
    for (const value of Array.isArray(prices) ? prices : []) {
        const quote = Number(value);
        if (Number.isFinite(quote)) series.push(quote);
    }

    const blank = extra => ({
        ready: 0,
        side: 0,
        up: 0,
        down: 0,
        tie: 0,
        edge: 0,
        ev: 0,
        breakEven: round(breakEven, 6),
        samples: 0,
        stateSamples: 0,
        z: 0,
        lift: 0,
        readability: 0,
        chi2: 0,
        chi2p: 1,
        entropy: 1,
        persistence: 0,
        tieOk: 0,
        stationaryUp: 0,
        expectedDisplacement: 0,
        baseUp: 0,
        baseDown: 0,
        baseTie: 0,
        horizon,
        order,
        memory,
        payout: round(payout, 4),
        state: '',
        reason: '',
        ...extra,
    });

    // A chain of order k needs k transitions just to name the current state,
    // then enough transitions to fit a table on. Publishing before that is how
    // a "model" ends up quoting a probability from four observations.
    if (series.length < order + 2) {
        return blank({ reason: `warming up — ${series.length} quotes` });
    }

    const symbols = [];
    for (let index = 1; index < series.length; index++) {
        symbols.push(signOf(series[index] - series[index - 1], band));
    }
    // The fit window is bounded so a long-running bot does not slowly stop
    // hearing its own most recent regime.
    const window = symbols.slice(-(memory + order));

    /** stateKey → { counts: [up, flat, down], total } */
    const transitions = new Map();
    const totals = [0, 0, 0];
    let samples = 0;
    for (let index = order; index < window.length; index++) {
        const state = window.slice(index - order, index);
        const next = window[index];
        const column = indexOfSymbol(next);
        const key = state.join(',');
        let cell = transitions.get(key);
        if (!cell) {
            cell = { counts: [0, 0, 0], total: 0 };
            transitions.set(key, cell);
        }
        cell.counts[column] += 1;
        cell.total += 1;
        totals[column] += 1;
        samples += 1;
    }

    // Base rate: the chain's own one-step marginal, smoothed so a sample of
    // three cannot claim a tick is bound to rise.
    const total = totals[UP] + totals[FLAT] + totals[DOWN];
    const base = totals.map(value => (value + 1) / (total + 3));

    const currentState = window.slice(-order);
    const stateKey = currentState.join(',');
    const stateCell = transitions.get(stateKey);
    const stateSamples = stateCell ? stateCell.total : 0;

    /** P(next | state), pulled toward the base rate by `priorWeight`. */
    const rowFor = key => {
        const cell = transitions.get(key);
        if (!cell || !cell.total) return base.slice();
        const row = cell.counts.map((count, index) => (count + priorWeight * base[index]) / (cell.total + priorWeight));
        const sum = row[UP] + row[FLAT] + row[DOWN] || 1;
        return row.map(value => value / sum);
    };

    /**
     * Carry a distribution over (state, net displacement) through `horizon`
     * ticks. This is the whole model: the chain supplies the transition row
     * for the state the walk is actually in, and the displacement accumulates
     * the signed steps, so the last layer is the exact settlement distribution
     * of the contract rather than a one-step probability raised to a power.
     */
    const project = startRowAt => {
        let layer = new Map();
        layer.set(`${currentState.join(',')}|0`, 1);
        for (let step = 0; step < horizon; step++) {
            const nextLayer = new Map();
            layer.forEach((probability, id) => {
                const split = id.lastIndexOf('|');
                const key = id.slice(0, split);
                const displacement = Number(id.slice(split + 1));
                const state = key.split(',').map(Number);
                const row = startRowAt ? startRowAt() : rowFor(key);
                SYMBOLS.forEach((symbol, column) => {
                    const weight = probability * row[column];
                    if (!(weight > 0)) return;
                    const advanced = state.slice(1).concat(symbol);
                    const nextId = `${advanced.join(',')}|${displacement + symbol}`;
                    nextLayer.set(nextId, (nextLayer.get(nextId) || 0) + weight);
                });
            });
            layer = nextLayer;
        }
        const out = { up: 0, down: 0, tie: 0, expected: 0 };
        layer.forEach((probability, id) => {
            const displacement = Number(id.slice(id.lastIndexOf('|') + 1));
            if (displacement > 0) out.up += probability;
            else if (displacement < 0) out.down += probability;
            else out.tie += probability;
            out.expected += probability * displacement;
        });
        return out;
    };

    const chain = project(null);
    // The same horizon under the chain's own marginal (no conditioning). The
    // difference between the two is what conditioning actually bought.
    const marginal = project(() => base);

    const bestSide = chain.up >= chain.down ? 1 : -1;
    const bestProbability = bestSide === 1 ? chain.up : chain.down;
    const evUp = chain.up * (1 + payout) - 1;
    const evDown = chain.down * (1 + payout) - 1;

    // Significance of the conditioning: how many standard errors the side the
    // chain picked sits above that side's unconditional read, using the current
    // state's own sample count. A state seen four times cannot be ten sigma.
    const marginalSide = bestSide === 1 ? marginal.up : marginal.down;
    const standardError = Math.sqrt((marginalSide * (1 - marginalSide)) / Math.max(1, stateSamples));
    const z = standardError > 0 ? (bestProbability - marginalSide) / standardError : 0;

    // Persistence: does a tick tend to follow the previous one? Measured on the
    // first-order table so it is a property of the tape, not of one state.
    let continueWeight = 0;
    let reverseWeight = 0;
    for (let index = 1; index < window.length; index++) {
        const before = window[index - 1];
        const after = window[index];
        if (before === 0 || after === 0) continue;
        if (before === after) continueWeight += 1;
        else reverseWeight += 1;
    }
    const persistence =
        continueWeight + reverseWeight > 0 ? (continueWeight - reverseWeight) / (continueWeight + reverseWeight) : 0;

    // Independence test on the fitted table: is the next tick actually
    // conditional on the last k, or is this table noise? dof is (rows − 1) ×
    // (columns − 1) over the states that were seen.
    let chi2 = 0;
    let rows = 0;
    transitions.forEach(cell => {
        rows += 1;
        const expected = cell.total;
        cell.counts.forEach((count, column) => {
            const wanted = expected * base[column];
            if (wanted > 0) chi2 += (count - wanted) ** 2 / wanted;
        });
    });
    const dof = Math.max(1, (rows - 1) * 2);
    const chi2p = chiSquareTail(chi2, dof);

    const currentRow = rowFor(stateKey);
    const entropy = normalizeEntropy(currentRow);

    // Readability combines "is this chain significantly different from noise"
    // with "has it seen enough to say so". Both must hold to score well.
    const significance = 1 - chi2p;
    const sampleShare = clamp(samples / (4 * minSamples), 0, 1);
    const readability = Math.round(100 * clamp(0.75 * significance + 0.25 * sampleShare, 0, 1));

    const stationaryUp = stationaryProbability(window, base, priorWeight);

    const ready = samples >= minSamples && stateSamples >= Math.max(8, Math.round(minSamples / 8)) ? 1 : 0;
    const tieOk = chain.tie <= safe(options.maxTie, 1) ? 1 : 0;

    const reason = !ready
        ? `thin chain — ${samples}/${minSamples} transitions (state seen ${stateSamples}×)`
        : !tieOk
          ? `tie risk — ${(chain.tie * 100).toFixed(1)} % of ${horizon}-tick windows`
          : `ready — P(${bestSide === 1 ? 'up' : 'down'}) ${(bestProbability * 100).toFixed(1)} % vs ` +
            `break-even ${(breakEven * 100).toFixed(1)} % (z ${z.toFixed(2)}σ)`;

    return blank({
        ready,
        // Nothing actionable is published from a chain that has not seen
        // enough transitions: the probabilities are reported for the journal,
        // but the side, the edge and the expected value stay at zero.
        side: ready ? bestSide : 0,
        up: round(chain.up, 6),
        down: round(chain.down, 6),
        tie: round(chain.tie, 6),
        edge: ready ? round(bestProbability - breakEven, 6) : 0,
        ev: ready ? round(bestSide === 1 ? evUp : evDown, 6) : 0,
        samples,
        stateSamples,
        z: ready ? round(z, 3) : 0,
        lift: ready ? round(bestProbability - marginalSide, 6) : 0,
        readability,
        chi2: round(chi2, 3),
        chi2p: round(chi2p, 4),
        entropy: round(entropy, 4),
        persistence: round(persistence, 4),
        tieOk,
        stationaryUp: round(stationaryUp, 6),
        expectedDisplacement: round(chain.expected, 4),
        baseUp: round(marginal.up, 6),
        baseDown: round(marginal.down, 6),
        baseTie: round(marginal.tie, 6),
        state: currentState.map(value => (value === 1 ? '↑' : value === -1 ? '↓' : '·')).join(''),
        reason,
    });
}

/** Normalised entropy of a three-way row: 0 = certain, 1 = uniform. */
function normalizeEntropy(row) {
    let entropy = 0;
    row.forEach(value => {
        if (value > 0) entropy -= value * Math.log(value);
    });
    return clamp(entropy / Math.log(3), 0, 1);
}

/**
 * The chain's long-run P(up): the stationary distribution of the one-step
 * symbol table, found by pushing the base rate through the fitted kernel. It
 * answers "where is this tape going" as opposed to "where does this state go",
 * which is what tells a strategy whether a state read is fighting the market.
 */
function stationaryProbability(window, base, priorWeight) {
    const counts = [0, 1, 2].map(() => [0, 0, 0]);
    for (let index = 1; index < window.length; index++) {
        counts[indexOfSymbol(window[index - 1])][indexOfSymbol(window[index])] += 1;
    }
    const kernel = counts.map(row => {
        const total = row[0] + row[1] + row[2];
        const smoothed = row.map((count, index) => (count + priorWeight * base[index]) / (total + priorWeight));
        const sum = smoothed[0] + smoothed[1] + smoothed[2] || 1;
        return smoothed.map(value => value / sum);
    });
    let distribution = base.slice();
    for (let step = 0; step < 60; step++) {
        const next = [0, 0, 0];
        distribution.forEach((mass, from) => {
            kernel[from].forEach((probability, to) => {
                next[to] += mass * probability;
            });
        });
        const sum = next[0] + next[1] + next[2] || 1;
        distribution = next.map(value => value / sum);
    }
    const directional = distribution[UP] + distribution[DOWN];
    return directional > 0 ? distribution[UP] / directional : 0.5;
}

/** One journal line describing a read. */
export function markovReport(read) {
    if (!read) return 'MARKOV no read yet';
    if (!read.ready) return `MARKOV · ${read.reason}`;
    const pct = value => `${(value * 100).toFixed(1)}%`;
    const ordinal = value => `${value}${['th', 'st', 'nd', 'rd'][value] || 'th'}`;
    return (
        `MARKOV ${ordinal(read.order)}-order ${read.horizon}-tick · state ${read.state} (${read.stateSamples}×): ` +
        `up ${pct(read.up)} / down ${pct(read.down)} / tie ${pct(read.tie)} · ` +
        `break-even ${pct(read.breakEven)} · edge ${read.edge >= 0 ? '+' : ''}${(read.edge * 100).toFixed(1)}pt ` +
        `(${read.side === 1 ? 'rise' : 'fall'}) · EV ${read.ev >= 0 ? '+' : ''}${(read.ev * 100).toFixed(1)}% · ` +
        `z ${read.z.toFixed(2)}σ · lift ${(read.lift * 100).toFixed(1)}pt · ` +
        `readability ${read.readability}/100 · persistence ${(read.persistence * 100).toFixed(0)}%`
    );
}

/** Plan layout shared by the block runtime and the strategies. */
export const MARKOV_PLAN_PARTS = {
    ready: 0,
    side: 1,
    up: 2,
    down: 3,
    tie: 4,
    edge: 5,
    ev: 6,
    'break-even': 7,
    samples: 8,
    'state-samples': 9,
    z: 10,
    lift: 11,
    readability: 12,
    chi: 13,
    'chi-p': 14,
    entropy: 15,
    persistence: 16,
    'tie-ok': 17,
    stationary: 18,
    displacement: 19,
    'base-up': 20,
    'base-down': 21,
    'base-tie': 22,
    horizon: 23,
};

/** Plan slot → the field of the read it carries. */
const PLAN_FIELDS = {
    ready: 'ready',
    side: 'side',
    up: 'up',
    down: 'down',
    tie: 'tie',
    edge: 'edge',
    ev: 'ev',
    'break-even': 'breakEven',
    samples: 'samples',
    'state-samples': 'stateSamples',
    z: 'z',
    lift: 'lift',
    readability: 'readability',
    chi: 'chi2',
    'chi-p': 'chi2p',
    entropy: 'entropy',
    persistence: 'persistence',
    'tie-ok': 'tieOk',
    stationary: 'stationaryUp',
    displacement: 'expectedDisplacement',
    'base-up': 'baseUp',
    'base-down': 'baseDown',
    'base-tie': 'baseTie',
    horizon: 'horizon',
};

/** The read as the flat numeric array the interpreter hands around. */
export function markovPlan(read) {
    const source = read || {};
    return Object.keys(MARKOV_PLAN_PARTS)
        .sort((left, right) => MARKOV_PLAN_PARTS[left] - MARKOV_PLAN_PARTS[right])
        .map(part => {
            const value = Number(source[PLAN_FIELDS[part]]);
            return Number.isFinite(value) ? value : 0;
        });
}
