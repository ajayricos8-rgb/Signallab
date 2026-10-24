import { fitIsotonic, normalPValue, pairedImprovementZ } from '../signal-engine/stats.ts';
import { familyBalancedWeights } from '../signal-engine/consensus.ts';
import { closedCandles, correlation, differences, entropy, eventWins, horizonExits, mean, normalizeTicks, project, rsi, standardDeviation, sum } from './math.ts';
import type { ForecastBank, ForecastRow, LabContract, LabHorizon, LabTick, ModelSpec, ResearchAudit, ResearchDecision } from './types.ts';

const COMMON_MODELS: ModelSpec[] = [
  { id: 'short', name: '50-outcome frequency', family: 'frequency', engines: [3, 29, 241] },
  { id: 'medium', name: '200-outcome frequency', family: 'frequency', engines: [2, 30, 242] },
  { id: 'long', name: '1,000-outcome frequency', family: 'frequency', engines: [6, 243] },
  { id: 'linear', name: 'Linear weighted frequency', family: 'frequency', engines: [4] },
  { id: 'recency', name: 'Exponential recency', family: 'frequency', engines: [5, 58] },
  { id: 'transition', name: 'Direct-horizon state transition', family: 'dependence', engines: [7, 50, 51, 60, 73, 84, 105, 208, 209] },
  { id: 'sequence', name: 'Two-state conditional transition', family: 'dependence', engines: [8, 47, 48, 49, 52, 199, 210, 211, 212] },
  { id: 'run', name: 'Run-length conditional outcome', family: 'run-length', engines: [9, 10, 11, 12, 17, 18, 55, 68, 80, 96, 213] },
  { id: 'regime', name: 'Causal regime-conditional outcome', family: 'regime', engines: [21, 22, 25, 43, 77, 93, 107, 283, 294, 298] },
];
const DIGIT_MODEL: ModelSpec = { id: 'gap', name: 'Empirical gap-conditioned hazard', family: 'recurrence', engines: [33, 38, 39, 40, 57, 74, 85] };
const QUOTE_MODELS: ModelSpec[] = [
  { id: 'trend', name: 'MA/trend-context outcome', family: 'trend', engines: [100, 128, 129, 130, 136, 137, 138, 139, 140, 141] },
  { id: 'oscillator', name: 'RSI-context outcome', family: 'momentum', engines: [13, 94, 142, 143, 145, 146] },
  { id: 'candle', name: 'Closed-candle-context outcome', family: 'candle', engines: [108, 116, 117, 123] },
];
const clampProbability = (p: number) => Math.max(0.000001, Math.min(0.999999, p));
const gapBucket = (age: number) => age < 3 ? age : age < 6 ? 3 : age < 11 ? 4 : age < 21 ? 5 : 6;

type Features = { category: number; pair: string; run: number; regime: number; trend: number; oscillator: number; candle: number; gaps: number[] };
type Prepared = {
  kind: 'digit' | 'quote'; epochs: number[]; values: number[]; categories: number[]; features: Features[]; size: number; models: ModelSpec[];
};

function prepare(input: readonly LabTick[], kind: 'digit' | 'quote'): Prepared {
  const ticks = normalizeTicks(input).filter((tick) => kind === 'digit' ? tick.digit != null : tick.quote != null);
  const values = ticks.map((tick) => kind === 'digit' ? tick.digit! : tick.quote!);
  const epochs = ticks.map((tick) => tick.epoch);
  const increments = [0, ...differences(values)];
  const categories = kind === 'digit' ? values : increments.map((value) => value > 0 ? 0 : value < 0 ? 1 : 2);
  const size = kind === 'digit' ? 10 : 3;
  const oscillator = kind === 'quote' ? rsi(values) : [];
  const bars = kind === 'quote' ? closedCandles(ticks) : [];
  let barIndex = -1;
  const lastSeen = Array<number>(size).fill(-1);
  let streak = 0;
  const features = values.map((_, index): Features => {
    streak = index && categories[index] === categories[index - 1] ? streak + 1 : 1;
    lastSeen[categories[index]] = index;
    while (barIndex + 1 < bars.length && bars[barIndex + 1].epoch + 60 <= epochs[index]) barIndex += 1;
    const counts = Array<number>(size).fill(0);
    for (let past = Math.max(0, index - 49); past <= index; past += 1) counts[categories[past]] += 1;
    const n = sum(counts);
    const normalizedEntropy = entropy(counts.map((count) => count / n)) / Math.log2(size);
    const longVol = standardDeviation(increments.slice(Math.max(1, index - 99), index + 1));
    const shortVol = standardDeviation(increments.slice(Math.max(1, index - 19), index + 1));
    const regime = kind === 'digit' ? normalizedEntropy < 0.7 ? 0 : normalizedEntropy < 0.9 ? 1 : 2 : longVol === 0 ? 0 : shortVol / longVol < 0.67 ? 0 : shortVol / longVol > 1.5 ? 2 : 1;
    const shortMean = mean(values.slice(Math.max(0, index - 19), index + 1));
    const longMean = mean(values.slice(Math.max(0, index - 59), index + 1));
    return {
      category: categories[index], pair: index ? `${categories[index - 1]},${categories[index]}` : '',
      run: Math.min(5, streak), regime, trend: Math.sign(shortMean - longMean),
      oscillator: oscillator[index] == null ? -1 : oscillator[index]! < 30 ? 0 : oscillator[index]! > 70 ? 2 : 1,
      candle: barIndex >= 0 ? Math.sign(bars[barIndex].close - bars[barIndex].open) : 2,
      gaps: lastSeen.map((seen) => seen < 0 ? -1 : gapBucket(index - seen)),
    };
  });
  return { kind, epochs, values, categories, features, size, models: [...COMMON_MODELS, ...(kind === 'digit' ? [DIGIT_MODEL] : QUOTE_MODELS)] };
}

function targetAt(data: Prepared, origin: number, exit: number): number {
  if (data.kind === 'digit') return data.values[exit];
  return data.values[exit] > data.values[origin] ? 0 : data.values[exit] < data.values[origin] ? 1 : 2;
}

/** Exported for causality tests. No value after origin may affect this forecast. */
export function forecastAt(input: readonly LabTick[], kind: 'digit' | 'quote', horizon: LabHorizon, origin: number): number[][] {
  const data = prepare(input, kind);
  if (!Number.isInteger(origin) || origin < 0 || origin >= data.values.length) throw new Error('Invalid forecast origin.');
  return forecast(data, horizonExits(data.epochs, horizon), origin);
}

function forecast(data: Prepared, exits: readonly number[], origin: number): number[][] {
  const now = data.features[origin];
  // Positive Dirichlet pseudocounts, including a small explicit flat category.
  const prior = data.kind === 'digit' ? Array<number>(10).fill(0.1) : [0.4995, 0.4995, 0.001];
  const totals = data.models.map(() => prior.map((value) => 20 * value));
  const gapHit = Array<number>(data.size).fill(0);
  const gapCount = Array<number>(data.size).fill(0);
  const settled: number[] = [];
  // Both ends are bounded by origin, including for time-based horizons.
  for (let index = Math.max(1, origin - 1400); index < origin; index += 1) if (exits[index] >= 0 && exits[index] <= origin) settled.push(index);
  const history = settled.slice(-1000);
  for (let position = 0; position < history.length; position += 1) {
    const past = history[position];
    const target = targetAt(data, past, exits[past]);
    const features = data.features[past];
    const age = history.length - 1 - position;
    const weights = [age < 50 ? 1 : 0, age < 200 ? 1 : 0, 1, (position + 1) / history.length, 2 ** (-age / 50),
      features.category === now.category ? 1 : 0,
      features.pair === now.pair && now.pair !== '' ? 1 : 0,
      features.category === now.category && features.run === now.run ? 1 : 0,
      features.regime === now.regime ? 1 : 0,
    ];
    if (data.kind === 'quote') weights.push(features.trend === now.trend ? 1 : 0, now.oscillator >= 0 && features.oscillator === now.oscillator ? 1 : 0, now.candle !== 2 && features.candle === now.candle ? 1 : 0);
    weights.forEach((weight, model) => { totals[model][target] += weight; });
    if (data.kind === 'digit') for (let state = 0; state < data.size; state += 1) {
      // Unknown (left-censored) age is never used as an "overdue" signal.
      if (now.gaps[state] >= 0 && features.gaps[state] === now.gaps[state]) { gapCount[state] += 1; if (target === state) gapHit[state] += 1; }
    }
  }
  if (data.kind === 'digit') totals[totals.length - 1] = gapHit.map((hits, state) => (hits + 2) / (gapCount[state] + 20));
  return totals.map((row) => { const total = sum(row); return row.map((value) => total ? value / total : 1 / data.size); });
}

export function buildForecastBank(input: readonly LabTick[], kind: 'digit' | 'quote', horizon: LabHorizon): ForecastBank {
  return bankForPrepared(prepare(input, kind), horizon);
}

/** Reuse causal feature extraction across the 25 Rise/Fall durations. */
export function createForecastFactory(input: readonly LabTick[], kind: 'digit' | 'quote'): (horizon: LabHorizon) => ForecastBank {
  const data = prepare(input, kind);
  return (horizon) => bankForPrepared(data, horizon);
}

function bankForPrepared(data: Prepared, horizon: LabHorizon): ForecastBank {
  const kind = data.kind;
  const n = data.values.length;
  const exits = horizonExits(data.epochs, horizon);
  const tuningStart = Math.max(100, Math.floor(n * 0.3));
  const calibrationStart = Math.floor(n * 0.55);
  const holdoutStart = Math.floor(n * 0.75);
  const stride = Math.max(1, Math.ceil((n - tuningStart) / 300));
  const tuning: ForecastRow[] = []; const calibration: ForecastRow[] = []; const holdout: ForecastRow[] = [];
  let previousExit = -1;
  // Stratify replay origins without a fixed stride phase-locking to a periodic
  // stream. Jitter depends ONLY on the block index, never on prices or labels.
  for (let block = 0, start = tuningStart; start < n - 1; block += 1, start += stride) {
    let hash = Math.imul(block + 1, 0x45d9f3b) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
    const origin = start + ((hash ^ (hash >>> 16)) >>> 0) % stride;
    if (origin >= n - 1) continue;
    const exit = exits[origin];
    if (exit < 0 || origin < previousExit) continue;
    if (origin < calibrationStart && exit >= calibrationStart || origin < holdoutStart && exit >= holdoutStart) continue;
    const row = { origin, exit, target: targetAt(data, origin, exit), probabilities: forecast(data, exits, origin), regime: data.features[origin].regime };
    (origin < calibrationStart ? tuning : origin < holdoutStart ? calibration : holdout).push(row);
    previousExit = exit;
  }
  const initial: number[] = [];
  for (let origin = 0; origin < tuningStart && origin < exits.length; origin += 1) if (exits[origin] >= 0 && exits[origin] < tuningStart) initial.push(targetAt(data, origin, exits[origin]));
  const flatRate = initial.length ? initial.filter((state) => state === 2).length / initial.length : 0;
  const baseline = kind === 'digit' ? Array<number>(10).fill(0.1) : [(1 - flatRate) / 2, (1 - flatRate) / 2, flatRate];
  const neutral = data.models.map(() => data.kind === 'digit' ? Array<number>(10).fill(0.1) : [0.5, 0.5, 0]);
  return {
    kind, horizon, models: data.models, tuning, calibration, holdout,
    live: n ? forecast(data, exits, n - 1) : neutral,
    nextTick: n ? forecast(data, horizonExits(data.epochs, { unit: 'ticks', value: 1 }), n - 1) : neutral,
    boundaries: { tuningStart, calibrationStart, holdoutStart, lastOrigin: n - 1 }, liveRegime: data.features.at(-1)?.regime ?? 0, baseline,
  };
}

/** Fits weights on tuning, calibrates on a later slice, evaluates on untouched non-overlapping rows. */
export function auditForecastBank(bank: ForecastBank, contract: LabContract, fair: number, selectionPool = 1): ResearchAudit {
  if (!Number.isFinite(fair) || fair < 0 || fair > 1) throw new Error('Invalid contract baseline.');
  // Quote tie mass is learned BEFORE tuning, never from the holdout passed by a caller.
  fair = bank.kind === 'quote' ? project(bank.baseline, contract) : fair;
  const baseline = clampProbability(fair);
  const asBinary = (row: ForecastRow) => ({ ...row, won: eventWins(contract, row.target) ? 1 as const : 0 as const, predictions: row.probabilities.map((p) => project(p, contract)) });
  const tuning = bank.tuning.map(asBinary);
  const calibration = bank.calibration.map(asBinary);
  const test = bank.holdout.map(asBinary);
  const baselineTuneLoss = tuning.length ? mean(tuning.map((row) => (baseline - row.won) ** 2)) : 0;
  const tuningLoss = bank.models.map((_, index) => tuning.length ? mean(tuning.map((row) => (row.predictions[index] - row.won) ** 2)) : null);
  const reliabilities = tuningLoss.map((loss) => loss === null || baselineTuneLoss <= 0 ? 1 : Math.max(0.2, Math.min(4, Math.exp(12 * (1 - loss / baselineTuneLoss)))));
  const weights = familyBalancedWeights(bank.models.map((model, index) => ({ family: model.family, reliability: reliabilities[index], available: true })));
  const raw = (predictions: readonly number[]) => sum(predictions.map((probability, index) => weights[index] * probability));
  const rawCalibration = calibration.map((row) => ({ probability: raw(row.predictions), won: row.won }));
  const positives = sum(rawCalibration.map((row) => row.won));
  const calibrator = rawCalibration.length >= 40 && positives >= 5 && rawCalibration.length - positives >= 5 ? fitIsotonic(rawCalibration, 8) : null;
  const calibrated = (p: number) => calibrator ? clampProbability(0.5 * p + 0.5 * calibrator.predict(p)) : clampProbability(p);
  const edgeThreshold = Math.max(0.005, 0.01 * fair);
  const rows = test.map((row) => {
    const estimate = raw(row.predictions); const probability = calibrated(estimate);
    return { origin: row.origin, exit: row.exit, won: row.won, raw: estimate, probability, called: probability > fair + edgeThreshold };
  });
  const modelErrors = rows.map((row) => (row.probability - row.won) ** 2);
  const fairErrors = rows.map((row) => (baseline - row.won) ** 2);
  const brier = rows.length ? mean(modelErrors) : null;
  const baselineBrier = rows.length ? mean(fairErrors) : null;
  const skill = brier !== null && baselineBrier !== null && baselineBrier > 0 ? 1 - brier / baselineBrier : null;
  const improvementZ = rows.length >= 20 ? pairedImprovementZ(fairErrors, modelErrors) : null;
  const pool = Math.max(1, Number.isFinite(selectionPool) ? Math.ceil(selectionPool) : 1);
  // One-sided paired loss test. Multiplicity covers the candidate scan and model search.
  const correctedP = improvementZ === null ? null : Math.min(1, (improvementZ > 0 ? normalPValue(improvementZ) / 2 : 1 - normalPValue(improvementZ) / 2) * pool * bank.models.length);
  const validated = rows.length >= 40 && tuning.length >= 30 && (skill ?? 0) > 0.005 && (correctedP ?? 1) < 0.05;
  const bins = Array.from({ length: 5 }, (_, index) => {
    const group = rows.filter((row) => Math.min(4, Math.floor(row.probability * 5)) === index);
    return { sample: group.length, predicted: group.length ? mean(group.map((row) => row.probability)) : null, observed: group.length ? mean(group.map((row) => row.won)) : null };
  });
  const correlations = bank.models.map((_, a) => bank.models.map((__, b) => correlation(tuning.map((row) => row.predictions[a]), tuning.map((row) => row.predictions[b]))));
  const redundantPairs: Array<[string, string]> = [];
  for (let a = 0; a < bank.models.length; a += 1) for (let b = a + 1; b < bank.models.length; b += 1) if (correlations[a][b] !== null && Math.abs(correlations[a][b]!) >= 0.98) redundantPairs.push([bank.models[a].id, bank.models[b].id]);
  const logLikelihoods = bank.models.map((_, index) => sum(tuning.map((row) => { const p = clampProbability(row.predictions[index]); return row.won ? Math.log(p) : Math.log1p(-p); })));
  const likelihoods = logLikelihoods.map((value) => Math.exp(value - Math.max(...logLikelihoods)));
  const likelihoodTotal = sum(likelihoods);
  const live = bank.live.map((p) => project(p, contract));
  const rawProbability = raw(live);
  const rawTestLoss = test.length ? mean(test.map((row) => (raw(row.predictions) - row.won) ** 2)) : null;
  const models = bank.models.map((model, index) => {
    const holdoutBrier = test.length ? mean(test.map((row) => (row.predictions[index] - row.won) ** 2)) : null;
    const without = weights[index] < 0.999999 && test.length ? mean(test.map((row) => ((raw(row.predictions) - weights[index] * row.predictions[index]) / (1 - weights[index]) - row.won) ** 2)) : null;
    return { ...model, probability: live[index], weight: weights[index], bayesianWeight: likelihoods[index] / likelihoodTotal,
      tuningBrier: tuningLoss[index], holdoutBrier, skill: holdoutBrier !== null && baselineBrier !== null && baselineBrier > 0 ? 1 - holdoutBrier / baselineBrier : null,
      contribution: 100 * weights[index] * (live[index] - fair), ablation: without !== null && rawTestLoss !== null ? without - rawTestLoss : null,
    };
  });
  const chosen = tuningLoss.map((loss, index) => ({ loss: loss ?? Infinity, index })).sort((a, b) => a.loss - b.loss || a.index - b.index)[0].index;
  const sameRegime = tuning.filter((row) => row.regime === bank.liveRegime);
  const regimeBest = sameRegime.length >= 20 ? bank.models.map((model, index) => ({ id: model.id, loss: mean(sameRegime.map((row) => (row.predictions[index] - row.won) ** 2)) })).sort((a, b) => a.loss - b.loss)[0].id : null;
  return {
    probability: calibrated(rawProbability), rawProbability,
    // The next-tick diagnostic has its own direct horizon; do not apply the selected-horizon calibrator or weights to it.
    nextTickProbability: mean(bank.nextTick.slice(0, 3).map((p) => project(p, contract))), fair,
    sample: test.length, tuningSample: tuning.length, calibrationSample: calibration.length, brier, baselineBrier, skill, improvementZ, correctedP, validated,
    calibrationMethod: calibrator ? 'isotonic-shrinkage' : 'identity',
    calibrationError: rows.length ? sum(bins.map((bin) => bin.sample ? bin.sample * Math.abs(bin.predicted! - bin.observed!) : 0)) / rows.length : null,
    bins, weights, correlations, redundantPairs, models, rows, boundaries: bank.boundaries,
    selectedModel: bank.models[chosen].id, regimeModel: regimeBest, regimeSample: sameRegime.length, selectionPool: pool,
  };
}

/** A forecast is not an order. Preserve ranked candidates, but do not auto-trade weak evidence. */
export function decideResearch(input: {
  audit: ResearchAudit; fresh: boolean; probability: number; fair: number;
  confirmed: boolean; independentSample: number;
}): ResearchDecision {
  const { audit, probability, fair } = input;
  const contradicted = audit.validated && audit.probability < audit.fair - Math.max(0.005, 0.01 * audit.fair) && probability > fair;
  const reasons: string[] = [];
  if (![probability, fair, audit.probability, audit.fair].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) reasons.push('Finite, bounded base and research probabilities are required.');
  if (!input.fresh) reasons.push('Live data freshness is not confirmed.');
  if (!input.confirmed) reasons.push('The base signal has not passed independent confirmation.');
  if (!Number.isInteger(input.independentSample) || input.independentSample < 30) reasons.push('Fewer than 30 valid independent base-signal outcomes.');
  if (probability - fair < Math.max(0.005, 0.01 * fair)) reasons.push('No material edge over this contract’s no-edge baseline.');
  if (contradicted) reasons.push('The independently validated research ensemble contradicts this contract.');
  const eligible = reasons.length === 0;
  if (eligible) reasons.push('Evidence gates passed; compare the live proposal payout with the estimated probability before any purchase.');
  return { action: eligible ? 'candidate' : 'observe', eligible, reasons, edgeMultiplier: contradicted ? 0.25 : 1, confidencePenalty: contradicted ? 10 : 0, requiresPayout: true };
}
