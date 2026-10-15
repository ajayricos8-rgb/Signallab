import { countsOf, distributionStats, dot, gaussianDigits, mean, mix, normalize, propagate, regress, smooth, sum, UNIFORM, variance, clamp } from './math.ts';
import { informationState, prefix, streakState, trendFeatures, type FittedEngine, type Forecast, type Sequence } from './features.ts';

function addOutcome(table: Map<string, number[]>, key: string, target: number) {
  const counts = table.get(key) ?? Array<number>(10).fill(0);
  counts[target] += 1;
  table.set(key, counts);
}

function lookup(table: Map<string, number[]>, key: string, prior: number[], minimum = 8): Forecast {
  const counts = table.get(key);
  const support = counts ? sum(counts) : 0;
  return { probabilities: counts && support >= minimum ? smooth(counts, prior, 20) : null, support };
}

export function fitMarkov(sequence: Sequence) {
  const { digits } = sequence;
  const prior = smooth(countsOf(digits));
  const counts = Array.from({ length: 10 }, () => Array<number>(10).fill(0));
  for (let i = 1; i < digits.length; i += 1) counts[digits[i - 1]][digits[i]] += 1;
  const matrix = counts.map((row) => smooth(row, prior, 10));
  const engine: FittedEngine = {
    id: 'markov', family: 'markov', label: 'First-order Markov · 10 × 10',
    predict: ({ digits: context }, horizon) => {
      const last = context.at(-1)!;
      const support = sum(counts[last]);
      const state = UNIFORM.map((_, digit) => Number(digit === last));
      return { probabilities: support >= 8 ? propagate(state, matrix, horizon) : null, support };
    },
  };
  return { engine, counts, matrix };
}

export function fitNgrams(sequence: Sequence, horizon: number) {
  const prior = smooth(countsOf(sequence.digits));
  const tables = [2, 3, 4, 5].map(() => new Map<string, number[]>());
  for (let origin = 4; origin + horizon < sequence.digits.length; origin += 1) {
    tables.forEach((table, index) => addOutcome(table, sequence.digits.slice(origin - index - 1, origin + 1).join(''), sequence.digits[origin + horizon]));
  }
  const contexts = (digits: number[]) => tables.map((table, index) => {
    const context = digits.slice(-index - 2).join('');
    return { order: index + 2, context, ...lookup(table, context, prior) };
  });
  const engine: FittedEngine = {
    id: 'ngram', family: 'markov', label: 'Higher-order Markov · orders 2–5',
    predict: ({ digits }) => {
      const available = contexts(digits).filter((row) => row.probabilities !== null);
      let probabilities: number[] | null = null;
      for (const row of available) probabilities = probabilities ? mix(row.probabilities!, probabilities, row.support / (row.support + 30)) : row.probabilities;
      return { probabilities, support: Math.max(0, ...available.map((row) => row.support)), note: available.length ? `Orders ${available.map((row) => row.order).join(', ')} have repeated contexts` : 'Unseen or sparse contexts; no extrapolated pattern vote' };
    },
  };
  return { engine, contexts };
}

/** Two-state categorical HMM, fitted by scaled forward/backward Baum–Welch. */
export function fitHmm(sequence: Sequence) {
  const { digits } = sequence;
  let initial = [0.5, 0.5];
  let transition = [[0.9, 0.1], [0.1, 0.9]];
  let emissions = [normalize(UNIFORM.map((_, d) => 5 - Math.abs(d - 4.5))), normalize(UNIFORM.map((_, d) => 0.5 + Math.abs(d - 4.5)))];
  const iterations = 16;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forward: number[][] = [];
    const scale: number[] = [];
    digits.forEach((digit, index) => {
      const previous = index === 0 ? initial : propagate(forward[index - 1], transition, 1);
      const row = previous.map((p, state) => p * emissions[state][digit]);
      scale.push(Math.max(1e-12, sum(row)));
      forward.push(normalize(row));
    });
    const backward = Array.from({ length: digits.length }, () => [1, 1]);
    for (let index = digits.length - 2; index >= 0; index -= 1) {
      backward[index] = transition.map((row) => sum(row.map((p, state) => p * emissions[state][digits[index + 1]] * backward[index + 1][state])) / scale[index + 1]);
    }
    const emissionCounts = [Array<number>(10).fill(0.5), Array<number>(10).fill(0.5)];
    const transitionCounts = [[1, 1], [1, 1]];
    digits.forEach((digit, index) => {
      const posterior = normalize(forward[index].map((p, state) => p * backward[index][state]));
      if (!index) initial = posterior;
      posterior.forEach((p, state) => { emissionCounts[state][digit] += p; });
      if (index + 1 < digits.length) {
        const pairs = transition.flatMap((row, from) => row.map((p, to) => forward[index][from] * p * emissions[to][digits[index + 1]] * backward[index + 1][to]));
        normalize(pairs).forEach((p, pair) => { transitionCounts[Math.floor(pair / 2)][pair % 2] += p; });
      }
    });
    emissions = emissionCounts.map(normalize);
    transition = transitionCounts.map(normalize);
  }
  // Exact scaled forward filter, written allocation-free because it runs once
  // per evaluation origin (hundreds of times per market scan).
  const posterior = (context: readonly number[]) => {
    const [t00, t01] = transition[0];
    const [t10, t11] = transition[1];
    const [e0, e1] = emissions;
    let s0 = initial[0];
    let s1 = initial[1];
    for (let index = 0; index < context.length; index += 1) {
      let p0 = s0;
      let p1 = s1;
      if (index) {
        const n0 = s0 * t00 + s1 * t10;
        const n1 = s0 * t01 + s1 * t11;
        const total = n0 + n1;
        p0 = total > 0 ? n0 / total : 0.5;
        p1 = total > 0 ? n1 / total : 0.5;
      }
      const a = p0 * e0[context[index]];
      const b = p1 * e1[context[index]];
      const total = a + b;
      s0 = total > 0 ? a / total : 0.5;
      s1 = total > 0 ? b / total : 0.5;
    }
    return [s0, s1];
  };
  const engine: FittedEngine = {
    id: 'hmm', family: 'markov', label: 'Hidden Markov model · 2 regimes',
    predict: ({ digits: context }, horizon) => {
      const state = propagate(posterior(context), transition, horizon);
      return { probabilities: normalize(UNIFORM.map((_, digit) => sum(state.map((p, k) => p * emissions[k][digit])))), support: digits.length };
    },
  };
  return { engine, posterior, transition, emissions, iterations };
}

export function frequencyForecast(context: Sequence): number[] {
  // A fixed recipe; the rolling windows overlap and are not counted as votes.
  return mix(smooth(countsOf(context.digits.slice(-100))), smooth(countsOf(context.digits.slice(-1_000))), 0.35);
}

export function fitInformation(sequence: Sequence, horizon: number): FittedEngine {
  const table = new Map<string, number[]>();
  const prior = smooth(countsOf(sequence.digits));
  for (let origin = 99; origin + horizon < sequence.digits.length; origin += 1) {
    addOutcome(table, informationState(sequence.digits.slice(Math.max(0, origin - 99), origin + 1)), sequence.digits[origin + horizon]);
  }
  return {
    id: 'information', family: 'information', label: 'Shannon entropy + LZ78 state model',
    predict: ({ digits }) => ({ ...lookup(table, informationState(digits), prior, 30), note: 'Complexity is an estimate; uncertainty alone does not predict direction' }),
  };
}

export function fitStreaks(sequence: Sequence, horizon: number): FittedEngine {
  const prior = smooth(countsOf(sequence.digits));
  const tables = Array.from({ length: 8 }, () => new Map<string, number[]>());
  const key = (digits: number[], barrier: number) => {
    const state = streakState(digits, barrier);
    return `${state.side}:${Math.min(8, state.length)}`;
  };
  for (let origin = 10; origin + horizon < sequence.digits.length; origin += 1) {
    const context = sequence.digits.slice(0, origin + 1);
    tables.forEach((table, index) => addOutcome(table, key(context, index + 1), sequence.digits[origin + horizon]));
  }
  return {
    id: 'streak', family: 'streaks', label: 'Run-conditioned outcomes + geometric checks',
    predict: ({ digits }) => {
      const rows = tables.map((table, index) => lookup(table, key(digits, index + 1), prior, 20)).filter((row) => row.probabilities);
      return {
        probabilities: rows.length ? normalize(UNIFORM.map((_, digit) => sum(rows.map((row) => row.probabilities![digit])))) : null,
        support: rows.length ? Math.min(...rows.map((row) => row.support)) : 0,
        note: 'Pools observed run contexts at barriers 1–8; a rare streak never forces a reversal',
      };
    },
  };
}

const TEMPLATES = [
  { id: 'Repeated digit × 4', regex: /^([0-9])\1\1\1$/ },
  { id: 'Low / high alternation', regex: /^[0-4][5-9][0-4][5-9]$/ },
  { id: 'High / low alternation', regex: /^[5-9][0-4][5-9][0-4]$/ },
  { id: 'Low cluster', regex: /^[0-4]{4}$/ },
  { id: 'High cluster', regex: /^[5-9]{4}$/ },
];

export function fitPatterns(sequence: Sequence, horizon: number) {
  const prior = smooth(countsOf(sequence.digits));
  const exact = [3, 4, 5].map(() => new Map<string, number[]>());
  const motifs = new Map<string, number[]>();
  for (let origin = 4; origin + horizon < sequence.digits.length; origin += 1) {
    const context = sequence.digits.slice(0, origin + 1);
    exact.forEach((table, index) => addOutcome(table, context.slice(-index - 3).join(''), sequence.digits[origin + horizon]));
    for (const template of TEMPLATES) if (template.regex.test(context.slice(-4).join(''))) addOutcome(motifs, template.id, sequence.digits[origin + horizon]);
  }
  const matches = (digits: number[]) => [
    ...exact.map((table, index) => ({ template: `Exact ${digits.slice(-index - 3).join(' → ')}`, ...lookup(table, digits.slice(-index - 3).join(''), prior, 8) })),
    ...TEMPLATES.filter((template) => template.regex.test(digits.slice(-4).join(''))).map((template) => ({ template: template.id, ...lookup(motifs, template.id, prior, 20) })),
  ];
  const engine: FittedEngine = {
    id: 'patterns', family: 'patterns', label: 'Subsequence + regex template matching',
    predict: ({ digits }) => {
      const rows = matches(digits).filter((row) => row.probabilities !== null);
      // Exact and regex templates are correlated; they form ONE engine vote.
      return { probabilities: rows.length ? normalize(UNIFORM.map((_, digit) => sum(rows.map((row) => row.probabilities![digit])))) : null, support: rows.length ? Math.max(...rows.map((row) => row.support)) : 0, note: rows.length ? rows.map((row) => row.template).join('; ') : 'No sufficiently repeated template' };
    },
  };
  return { engine, matches };
}

export function fitTrend(sequence: Sequence, horizon: number) {
  const features: number[][] = [];
  const targets: number[] = [];
  for (let origin = 50; origin + horizon < sequence.digits.length; origin += 1) {
    features.push(trendFeatures(sequence.digits.slice(0, origin + 1)));
    targets.push(sequence.digits[origin + horizon]);
  }
  const coefficients = regress(features, targets, 5);
  const residualVariance = Math.max(0.15, mean(features.map((row, index) => (targets[index] - dot(coefficients, row)) ** 2)));
  const engine: FittedEngine = {
    id: 'trend', family: 'trend', label: 'SMA / EMA / MACD digit regression',
    predict: ({ digits }) => ({ probabilities: gaussianDigits(dot(coefficients, trendFeatures(digits)), Math.sqrt(residualVariance)), support: features.length }),
  };
  return { engine, coefficients, residualVariance };
}

type ArimaModel = { p: number; d: number; q: number; center: number; coefficients: number[]; residuals: number[]; innovationVariance: number; aic: number };

function filterArima(digits: readonly number[], model: Pick<ArimaModel, 'p' | 'd' | 'center' | 'coefficients'>) {
  const length = model.d ? Math.max(0, digits.length - 1) : digits.length;
  const values = Array<number>(length);
  for (let i = 0; i < length; i += 1) values[i] = (model.d ? digits[i + 1] - digits[i] : digits[i]) - model.center;
  const residuals = Array<number>(length).fill(0);
  const { p, coefficients } = model;
  // Same left-to-right accumulation as dot([1, lags..., previous error]) but
  // without allocating a row per step: this filter runs for every forecast.
  for (let t = p; t < length; t += 1) {
    let prediction = coefficients[0];
    for (let lag = 0; lag < p; lag += 1) prediction += coefficients[lag + 1] * values[t - lag - 1];
    prediction += coefficients[p + 1] * residuals[t - 1];
    residuals[t] = clamp(values[t] - prediction, -30, 30);
  }
  return { values, residuals };
}

export function fitTimeSeries(sequence: Sequence) {
  const models: ArimaModel[] = [];
  for (const [p, d] of [[1, 0], [2, 0], [1, 1]]) {
    const raw = d ? sequence.digits.slice(1).map((digit, i) => digit - sequence.digits[i]) : sequence.digits;
    const center = mean(raw);
    const values = raw.map((value) => value - center);
    let coefficients = Array<number>(p + 2).fill(0);
    let residuals = [...values];
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const rows = values.slice(p).map((_, i) => [1, ...Array.from({ length: p }, (_, lag) => values[i + p - lag - 1]), residuals[i + p - 1]]);
      coefficients = regress(rows, values.slice(p), 10);
      const arSize = sum(coefficients.slice(1, p + 1).map(Math.abs));
      if (arSize > 0.98) for (let k = 1; k <= p; k += 1) coefficients[k] *= 0.98 / arSize;
      coefficients[p + 1] = clamp(coefficients[p + 1], -0.95, 0.95);
      residuals = filterArima(sequence.digits, { p, d, center, coefficients }).residuals;
    }
    const innovationVariance = Math.max(0.15, mean(residuals.slice(p).map((error) => error * error)));
    const n = residuals.length - p;
    models.push({ p, d, q: 1, center, coefficients, residuals, innovationVariance, aic: n * Math.log(innovationVariance) + 2 * (p + 3) });
  }
  // Compare likelihoods on common differenced/undifferenced scale approximately;
  // this bounded candidate search is not a full automatic ARIMA package.
  const arima = models.sort((a, b) => a.aic - b.aic)[0];
  let garch = { omega: arima.innovationVariance * 0.1, alpha: 0.1, beta: 0.8, loss: Infinity };
  for (const alpha of [0.02, 0.08, 0.15, 0.25]) for (const beta of [0.4, 0.65, 0.8, 0.9]) {
    if (alpha + beta >= 0.99) continue;
    const omega = arima.innovationVariance * (1 - alpha - beta);
    let v = arima.innovationVariance;
    let loss = 0;
    for (const error of arima.residuals.slice(arima.p)) {
      loss += Math.log(v) + error * error / v;
      v = Math.max(0.05, omega + alpha * error * error + beta * v);
    }
    if (loss < garch.loss) garch = { omega, alpha, beta, loss };
  }
  const forecast = (context: Sequence, horizon: number, conditionalVariance: boolean) => {
    const filtered = filterArima(context.digits, arima);
    // Only the last p filtered values feed the recursion; avoid copying the full context.
    const values = filtered.values.slice(-Math.max(1, arima.p));
    let lastError = filtered.residuals.at(-1) ?? 0;
    let prediction = context.digits.at(-1)!;
    let v = arima.innovationVariance;
    if (conditionalVariance) {
      const { residuals } = filtered;
      for (let index = arima.p; index < residuals.length; index += 1) {
        const error = residuals[index];
        v = Math.max(0.05, garch.omega + garch.alpha * error * error + garch.beta * v);
      }
    }
    const futureVariances: number[] = [];
    for (let step = 0; step < horizon; step += 1) {
      const next = dot(arima.coefficients, [1, ...Array.from({ length: arima.p }, (_, lag) => values.at(-lag - 1) ?? 0), lastError]);
      values.push(next);
      prediction = arima.d ? prediction + next + arima.center : next + arima.center;
      lastError = 0;
      futureVariances.push(v);
      if (conditionalVariance) v = garch.omega + (garch.alpha + garch.beta) * v;
    }
    // MA-infinity impulse response, cumulated once for the integrated model.
    const psi = [1];
    for (let k = 1; k < horizon; k += 1) psi.push((k === 1 ? arima.coefficients[arima.p + 1] : 0) + sum(Array.from({ length: arima.p }, (_, j) => arima.coefficients[j + 1] * (psi[k - j - 1] ?? 0))));
    const impulses = arima.d ? psi.map((_, i) => sum(psi.slice(0, i + 1))) : psi;
    const forecastVariance = sum(futureVariances.map((value, step) => value * impulses[horizon - step - 1] ** 2));
    return { probabilities: gaussianDigits(prediction, Math.sqrt(forecastVariance)), support: sequence.digits.length, center: clamp(prediction, 0, 9), variance: forecastVariance };
  };
  const engines: FittedEngine[] = [
    { id: 'arima', family: 'time-series', label: `ARIMA(${arima.p},${arima.d},1) · conditional least squares`, predict: (context, horizon) => forecast(context, horizon, false) },
    { id: 'garch', family: 'time-series', label: 'GARCH(1,1) · ARIMA residual volatility', predict: (context, horizon) => forecast(context, horizon, true) },
  ];
  return { engines, arima, garch, forecast };
}

export function fitStatisticalEngines(sequence: Sequence, horizon: number) {
  const markov = fitMarkov(sequence);
  const ngram = fitNgrams(sequence, horizon);
  const hmm = fitHmm(sequence);
  const patterns = fitPatterns(sequence, horizon);
  const trend = fitTrend(sequence, horizon);
  const timeSeries = fitTimeSeries(sequence);
  const engines: FittedEngine[] = [
    markov.engine, ngram.engine, hmm.engine,
    { id: 'frequency', family: 'frequency', label: 'Rolling frequency · 100 / 1,000 ticks', predict: (context) => ({ probabilities: frequencyForecast(context), support: Math.min(1_000, context.digits.length) }) },
    fitInformation(sequence, horizon), fitStreaks(sequence, horizon), trend.engine, patterns.engine, ...timeSeries.engines,
  ];
  return { engines, markov, ngram, hmm, patterns, trend, timeSeries };
}
