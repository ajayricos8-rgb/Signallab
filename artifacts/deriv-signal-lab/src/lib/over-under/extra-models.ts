// Five additional digit engines, each a different question about the same tick
// stream. They are fitted on the training partition only and predict the digit
// the contract SETTLES on (origin + horizon), exactly like the original twelve.
//
//   ppm        variable-order Markov with PPM-style escape and backoff, instead
//              of the fixed-weight n-gram blend. Longer contexts win only while
//              they keep paying for themselves.
//   dirichlet  Bayesian Dirichlet–multinomial predictive with exponential
//              recency; the decay half-life and prior strength are chosen on
//              training data, not assumed.
//   hazard     a per-digit discrete-time hazard model: given how long a digit
//              has been absent, how often does it actually print at the exit
//              tick? It replaces the "overdue digit" hunch with a measured rate.
//   spectral   per-digit autocorrelation at the contract's own horizon. Only a
//              correlation that clears its sampling error is allowed to tilt the
//              distribution.
//   kalman     a local-level (exponential state-space) filter per digit, whose
//              gain is fitted on training data, damped forward to the horizon.
//
// Every engine returns `{ probabilities: null }` when it has nothing to say, so
// the ensemble's existing skill gate can give it exactly zero weight.
import { brier, clamp, countsOf, mean, mix, normalize, smooth, sum, UNIFORM } from './math.ts';
import type { FittedEngine, Forecast, Sequence } from './features.ts';

/** Digits the PPM model back off through, shortest last. */
const PPM_ORDERS = [1, 2, 3, 4, 5] as const;
/** Pseudo-counts that shrink a raw context row toward the shorter context. */
const PPM_CONCENTRATION = 24;

/**
 * Variable-order Markov model with PPM-C escape.
 *
 * The n-gram engine mixes its orders by fixed weights. PPM instead asks, at each
 * order, whether the context occurred often enough to speak for itself: a
 * context seen twice should not outvote a context seen two hundred times, and it
 * must also pay an escape probability for the symbols it has never produced.
 */
export function fitPpm(sequence: Sequence, horizon: number) {
  const { digits } = sequence;
  const prior = smooth(countsOf(digits));
  const tables = PPM_ORDERS.map(() => new Map<string, number[]>());
  for (let origin = PPM_ORDERS.at(-1)!; origin + horizon < digits.length; origin += 1) {
    const target = digits[origin + horizon];
    PPM_ORDERS.forEach((order, index) => {
      const key = digits.slice(origin - order, origin).join('');
      const counts = tables[index].get(key) ?? Array<number>(10).fill(0);
      counts[target] += 1;
      tables[index].set(key, counts);
    });
  }
  const contexts = (digits: number[]) => PPM_ORDERS.map((order, index) => {
    const key = digits.slice(-order).join('');
    const counts = tables[index].get(key);
    return { order, key, counts, total: counts ? sum(counts) : 0 };
  });
  const engine: FittedEngine = {
    id: 'ppm', family: 'markov', label: 'Variable-order Markov · PPM escape, orders 1–5',
    predict: ({ digits: history }, steps) => {
      void steps;
      let distribution = prior.slice();
      let support = 0;
      let longest = 0;
      // Shortest order first, each longer order escaping into the one below it.
      // A context's raw row is interpolated with the shorter context's estimate
      // (a Dirichlet weight of PPM_CONCENTRATION pseudo-counts) before it earns
      // its escape share: ten symbols fill a context far faster than a raw
      // frequency table can support, and an unshrunk row of twenty observations
      // is noise wearing a probability.
      for (const entry of contexts(history)) {
        if (!entry.counts || entry.total < 4) continue;
        const distinct = entry.counts.filter((count) => count > 0).length;
        const escape = distinct / (entry.total + distinct);
        const local = normalize(entry.counts.map((count, digit) => (count + PPM_CONCENTRATION * distribution[digit]) / (entry.total + PPM_CONCENTRATION)));
        distribution = normalize(distribution.map((value, digit) => (1 - escape) * local[digit] + escape * value));
        support = Math.max(support, entry.total);
        longest = entry.order;
      }
      if (longest === 0) return { probabilities: null, support: 0, note: 'No context repeated often enough to forecast' };
      return { probabilities: distribution, support, note: `Deepest usable context: ${longest} digit${longest === 1 ? '' : 's'}` };
    },
  };
  return { engine, tables };
}

/**
 * Bayesian Dirichlet–multinomial predictive with exponential recency.
 *
 * The predictive probability of the exit digit is
 *   (decayed count + strength · prior) / (decayed total + strength),
 * so the model is a proper posterior mean rather than a raw frequency, and its
 * two hyper-parameters are selected by scoring candidate pairs on the training
 * partition (never on the tuning or held-out rows).
 */
export function fitDirichlet(sequence: Sequence) {
  const { digits } = sequence;
  const prior = smooth(countsOf(digits));
  const halfLives = [60, 150, 400, 1_000];
  const strengths = [1, 4, 12];
  const decayed = (history: readonly number[], halfLife: number, extraSteps: number) => {
    const lambda = Math.pow(0.5, 1 / halfLife);
    const weight = new Array<number>(10).fill(0);
    let total = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const distance = history.length - index + extraSteps;
      // Beyond eight half-lives a tick contributes less than 0.4% of a count.
      if (distance > 8 * halfLife) break;
      const value = Math.pow(lambda, distance);
      weight[history[index]] += value;
      total += value;
    }
    return { weight, total };
  };
  // Fit on the tail of the training partition only.
  const scoringStart = Math.max(300, digits.length - 400);
  const scoringWindow = digits.slice(Math.max(0, scoringStart - 1_500), scoringStart);
  let best = { halfLife: 150, strength: 4, loss: Number.POSITIVE_INFINITY };
  for (const halfLife of halfLives) {
    for (const strength of strengths) {
      let loss = 0;
      let rows = 0;
      for (let index = scoringStart; index < digits.length; index += 1) {
        const history = digits.slice(Math.max(0, index - 1_500), index);
        const { weight, total } = decayed(history, halfLife, 0);
        const probabilities = normalize(weight.map((value, digit) => (value + strength * prior[digit]) / (total + strength)));
        loss += brier(probabilities, digits[index]);
        rows += 1;
      }
      if (rows && loss / rows < best.loss) best = { halfLife, strength, loss: loss / rows };
    }
  }
  void scoringWindow;
  const engine: FittedEngine = {
    id: 'dirichlet', family: 'frequency', label: `Dirichlet predictive · ${best.halfLife}-tick half-life`,
    predict: ({ digits: history }, steps) => {
      const { weight, total } = decayed(history, best.halfLife, Math.max(0, steps - 1));
      if (total < 20) return { probabilities: null, support: Math.round(total) };
      return {
        probabilities: normalize(weight.map((value, digit) => (value + best.strength * prior[digit]) / (total + best.strength))),
        support: Math.round(total),
        note: `Posterior mean with ${best.strength} pseudo-counts; ${best.halfLife}-tick half-life`,
      };
    },
  };
  return { engine, halfLife: best.halfLife, strength: best.strength, trainingLoss: Number.isFinite(best.loss) ? best.loss : null };
}

/** Gap buckets: the bucketed age of a digit, capped at the tail. */
const GAP_BUCKETS = 26;

/**
 * Discrete-time hazard model per digit.
 *
 * For every digit the fit records how often it printed at exactly `horizon`
 * ticks ahead, bucketed by how long it had been absent. The forecast is the
 * measured printing rate for the CURRENT age of each digit, smoothed toward the
 * marginal rate, so a long absence raises a digit only as much as history says
 * it should — the overdue fallacy measured rather than assumed.
 */
export function fitGapHazard(sequence: Sequence, horizon: number) {
  const { digits } = sequence;
  const appearances = Array.from({ length: 10 }, () => new Array<number>(GAP_BUCKETS + 1).fill(0));
  const exposures = Array.from({ length: 10 }, () => new Array<number>(GAP_BUCKETS + 1).fill(0));
  const lastSeen = new Array<number>(10).fill(-1);
  for (let index = 0; index < digits.length; index += 1) {
    for (let digit = 0; digit < 10; digit += 1) {
      const gap = lastSeen[digit] < 0 ? GAP_BUCKETS : Math.min(GAP_BUCKETS, index - lastSeen[digit] - 1);
      if (index + horizon >= digits.length) break;
      const hits = digits[index + horizon] === digit ? 1 : 0;
      exposures[digit][gap] += 1;
      appearances[digit][gap] += hits;
    }
    lastSeen[digits[index]] = index;
  }
  const rates = appearances.map((row, digit) => row.map((hits, gap) => {
    // Laplace-smoothed rate toward the digit's own marginal frequency.
    const base = 0.1;
    const exposure = exposures[digit][gap];
    return exposures[digit][gap] > 0 ? (hits + 3 * base) / (exposure + 3) : null;
  }));
  const engine: FittedEngine = {
    id: 'hazard', family: 'streaks', label: 'Gap hazard · measured printing rate by age',
    predict: ({ digits: history }) => {
      const seen = new Array<number>(10).fill(-1);
      for (let index = history.length - 1; index >= 0 && seen.some((value) => value < 0); index -= 1) {
        if (seen[history[index]] < 0) seen[history[index]] = index;
      }
      let measured = 0;
      let support = 0;
      const probabilities = Array.from({ length: 10 }, (_, digit) => {
        const gap = seen[digit] < 0 ? GAP_BUCKETS : Math.min(GAP_BUCKETS, history.length - seen[digit] - 1);
        const rate = rates[digit][gap];
        if (rate === null) return 0.1;
        measured += 1;
        support += exposures[digit][gap];
        return Math.max(0.005, rate);
      });
      if (measured < 8) return { probabilities: null, support: 0, note: 'Not enough age history for every digit' };
      return {
        probabilities: normalize(mix(normalize(probabilities), UNIFORM, 0.25)),
        support: Math.round(support / 10),
        note: measured === 10 ? 'Every digit has a measured hazard for its current age' : `${measured}/10 digits have a measured hazard`,
      };
    },
  };
  return { engine, appearances, exposures };
}

/**
 * Horizon autocorrelation per digit.
 *
 * A digit's 0/1 indicator series is correlated with itself `horizon` ticks
 * later when the stream has a cycle at exactly that contract length. The
 * correlation is tested against its own standard error (1/√n), and only a
 * correlation that clears 2.5 standard errors is allowed to move the forecast.
 */
export function fitSpectral(sequence: Sequence, horizon: number) {
  const engine: FittedEngine = {
    id: 'spectral', family: 'information', label: `Horizon autocorrelation · lag ${horizon}`,
    predict: ({ digits }) => {
      const window = 900;
      if (digits.length < window + horizon + 10) return { probabilities: null, support: digits.length };
      const series = digits.slice(-(window + horizon));
      const n = series.length - horizon;
      const correlations: number[] = [];
      let strongest = 0;
      for (let digit = 0; digit < 10; digit += 1) {
        let sx = 0;
        let sy = 0;
        let sxx = 0;
        let syy = 0;
        let sxy = 0;
        for (let index = 0; index < n; index += 1) {
          const x = Number(series[index] === digit);
          const y = Number(series[index + horizon] === digit);
          sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        }
        const meanX = sx / n;
        const meanY = sy / n;
        const covariance = sxy / n - meanX * meanY;
        const varianceX = sxx / n - meanX * meanX;
        const varianceY = syy / n - meanY * meanY;
        const denominator = Math.sqrt(Math.max(1e-12, varianceX * varianceY));
        const correlation = clamp(covariance / denominator, -1, 1);
        correlations.push(correlation);
        if (Math.abs(correlation) * Math.sqrt(n) >= 2.5) strongest += 1;
      }
      if (strongest === 0) return { probabilities: null, support: n, note: 'No digit cycles at this contract length' };
      const tilted = normalize(UNIFORM.map((value, digit) => Math.max(0.004, value * (1 + clamp(correlations[digit] * 2.5, -0.55, 0.55)))));
      return {
        probabilities: tilted,
        support: n,
        note: `${strongest} digit${strongest === 1 ? '' : 's'} show a measured cyclic correlation at lag ${horizon}`,
      };
    },
  };
  return { engine };
}

/**
 * Local-level state-space filter per digit.
 *
 * Each digit carries a filtered probability state that reacts to new ticks with
 * a gain fitted on the training partition. The state is then damped forward to
 * the contract's horizon, so a digit that is hot right now is not assumed to
 * still be hot five ticks later by the same amount.
 */
export function fitKalman(sequence: Sequence) {
  const { digits } = sequence;
  const gains = [0.02, 0.05, 0.1, 0.2];
  const scoringStart = Math.max(400, digits.length - 500);
  let best = { gain: 0.05, loss: Number.POSITIVE_INFINITY };
  for (const gain of gains) {
    const state = new Array<number>(10).fill(0.1);
    let loss = 0;
    let rows = 0;
    for (let index = 0; index < digits.length; index += 1) {
      if (index >= scoringStart) {
        loss += brier(normalize(state), digits[index]);
        rows += 1;
      }
      for (let digit = 0; digit < 10; digit += 1) {
        state[digit] += gain * ((digits[index] === digit ? 1 : 0) - state[digit]);
      }
    }
    if (rows && loss / rows < best.loss) best = { gain, loss: loss / rows };
  }
  const engine: FittedEngine = {
    id: 'kalman', family: 'time-series', label: `Local-level filter · gain ${best.gain}`,
    predict: ({ digits: history }, steps) => {
      const window = Math.min(1_200, history.length);
      if (window < 200) return { probabilities: null, support: window };
      const state = new Array<number>(10).fill(0.1);
      for (let index = history.length - window; index < history.length; index += 1) {
        for (let digit = 0; digit < 10; digit += 1) {
          state[digit] += best.gain * ((history[index] === digit ? 1 : 0) - state[digit]);
        }
      }
      // Damp toward the marginal as the contract length grows: the filter's
      // information decays with every tick it is projected forward.
      const retention = Math.pow(1 - best.gain, Math.max(0, steps - 1));
      const projection = normalize(state.map((value) => 0.1 + (value - 0.1) * retention));
      return { probabilities: mix(projection, UNIFORM, 0.15), support: window, note: `Gain ${best.gain}, projected ${Math.max(0, steps - 1)} ticks` };
    },
  };
  return { engine, gain: best.gain, trainingLoss: Number.isFinite(best.loss) ? best.loss : null };
}

/** The five extra engines, fitted once per market on the training partition. */
export function fitExtraEngines(sequence: Sequence, horizon: number) {
  const ppm = fitPpm(sequence, horizon);
  const dirichlet = fitDirichlet(sequence);
  const hazard = fitGapHazard(sequence, horizon);
  const spectral = fitSpectral(sequence, horizon);
  const kalman = fitKalman(sequence);
  const engines: FittedEngine[] = [ppm.engine, dirichlet.engine, hazard.engine, spectral.engine, kalman.engine];
  return {
    engines, ppm, dirichlet, hazard, spectral, kalman,
    diagnostics: {
      dirichlet: { halfLife: dirichlet.halfLife, strength: dirichlet.strength, trainingLoss: dirichlet.trainingLoss },
      kalman: { gain: kalman.gain, trainingLoss: kalman.trainingLoss },
    },
  };
}

/** Exposed for tests: the PPM depth the live context supports. */
export function ppmDepth(sequence: Sequence, horizon: number): number {
  const { tables } = fitPpm(sequence, horizon);
  const { digits } = sequence;
  let depth = 0;
  for (let index = 0; index < tables.length; index += 1) {
    const order = PPM_ORDERS[index];
    if ((tables[index].get(digits.slice(-order).join(''))?.reduce((total, value) => total + value, 0) ?? 0) >= 4) depth = order;
  }
  return depth;
}

/** Mean Brier loss of a probability track, used by the fitting helpers above. */
export function meanBrier(rows: readonly { probabilities: number[]; target: number }[]): number {
  return rows.length ? mean(rows.map((row) => brier(row.probabilities, row.target))) : 0;
}
