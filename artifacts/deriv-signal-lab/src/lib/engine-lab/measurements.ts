import { ENGINE_CATALOG } from './catalog.ts';
import {
  advanceMarkov, atr, closedCandles, contextDistribution, correlation, counts, differences, distribution, efficiency, ema, entropy,
  fanoFactor, finite, gapData, kpss, last, macd, mean, normalizeRows, normalizeTicks, pacf, patternCounts, quantile,
  rankedPatterns, ratio, rsi, runs, slope, standardDeviation, sum, transitions, weightedDistribution, eventWins,
} from './math.ts';
import { autocorrelation, chiSquareGoodnessOfFit, chiSquareIndependence, cusumChange, ljungBox, runsTest, wilsonInterval } from '../signal-engine/stats.ts';
import type { EngineReading, LabContract, LabHorizon, LabTick, ToolFamily } from './types.ts';

type Data = NonNullable<EngineReading['data']>;
export type ReadingWriter = (id: number, value: number | string | null, sample: number, detail: string, data?: Data, contextOnly?: boolean) => void;
const fmt = (n: number | null) => n === null || !Number.isFinite(n) ? 'unavailable' : Number(n.toPrecision(5)).toString();
const stateName = (value: number) => value === 0 ? 'rise' : value === 1 ? 'fall' : 'flat';
const changeRate = (values: readonly number[]) => values.length > 1 ? values.slice(1).filter((value, index) => value !== values[index]).length / (values.length - 1) : null;
const rate = (values: readonly number[], state: number) => values.length ? values.filter((value) => value === state).length / values.length : 0;
const pressure = (values: readonly number[], barrier: number) => values.length ? mean(values.map((digit) => digit > barrier ? 1 : digit < barrier ? -1 : 0)) : 0;

export function createReadingWriter(family: ToolFamily) {
  const readings = new Map<number, EngineReading>();
  const put: ReadingWriter = (id, rawValue, sample, detail, data, contextOnly = false) => {
    const def = ENGINE_CATALOG[id - 1];
    if (!def) throw new Error(`Unknown engine ${id}`);
    const value = typeof rawValue === 'number' ? finite(rawValue) : rawValue;
    const context = contextOnly || (def.domain === 'quotes' ? family !== 'rise-fall'
      : def.domain === 'digits' ? family === 'rise-fall'
        : ['matches', 'even-odd', 'over-under'].includes(def.domain) ? def.domain !== family : false);
    readings.set(id, { id, value, sample: Math.max(0, sample), status: value === null ? 'insufficient' : context ? 'context' : 'active',
      detail: context ? `${detail} Context only for ${family}; not an independent probability vote.` : detail, contribution: null, ...(data ? { data } : {}) });
  };
  const missing = (ids: readonly number[], reason: string) => { for (const id of ids) readings.set(id, { id, value: null, sample: 0, status: 'unavailable', detail: reason, contribution: null }); };
  return { readings, put, missing };
}
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

function binarySummary(values: readonly number[]) {
  const runList = runs(values); const current = runList.at(-1);
  const table = transitions(values, 2); const normalized = normalizeRows(table);
  const completed = runList.slice(0, -1);
  const gaps = gapData(values, 2);
  return { runList, current, table, normalized, completed, gaps, meanRun: completed.length ? mean(completed.map((run) => run.length)) : null };
}

function core(put: ReadingWriter, ticks: readonly LabTick[], digits: number[], prices: number[], contract: LabContract) {
  const isQuote = contract.family === 'rise-fall';
  const returns = differences(prices);
  const values = isQuote ? returns : digits;
  const states = isQuote ? returns.map((v) => v > 0 ? 0 : v < 0 ? 1 : 2) : digits;
  const size = isQuote ? 3 : 10;
  const n = states.length;
  if (!n) return;
  const probabilities = distribution(states, size);
  const current = last(states);
  const event = states.map((state) => eventWins(contract, state) ? 1 : 0);
  const p = mean(event);
  const short = event.slice(-50); const medium = event.slice(-200); const long = event.slice(-1000);
  const windows = [mean(short), mean(medium), mean(long)];
  const linear = weightedDistribution(event, 2); const recency = weightedDistribution(event, 2, true);
  const context = contextDistribution(states, size);
  const runList = runs(states); const currentRun = runList.at(-1)!;
  const completed = runList.slice(0, -1);
  let continued = 0; let eligible = 0; let length = 1;
  for (let index = 1; index < states.length; index += 1) {
    if (states[index - 1] === currentRun.state && Math.min(length, 5) === Math.min(currentRun.length, 5)) {
      eligible += 1; if (states[index] === currentRun.state) continued += 1;
    }
    length = states[index] === states[index - 1] ? length + 1 : 1;
  }
  const continuation = (continued + 20 * probabilities[current]) / (eligible + 20);
  const switches = changeRate(states);
  const half = Math.floor(n / 2);
  const before = distribution(states.slice(0, half), size); const after = distribution(states.slice(half), size);
  const shift = 0.5 * sum(before.map((value, index) => Math.abs(value - after[index])));
  const binaryRuns = runsTest(event.map((value) => value ? 1 : -1));
  const runsValid = binaryRuns.positives > 10 && binaryRuns.negatives > 10;
  const uniform = chiSquareGoodnessOfFit(counts(states, size));
  const nonrandom = runsValid && binaryRuns.pValue < 0.05 / 300 || !isQuote && n >= 50 && uniform.pValue < 0.05 / 300;
  const regime = shift > 0.2 ? 'distribution-shifting' : nonrandom ? 'observed structure' : 'no detected structure';
  const q1 = quantile(values, 0.25)!; const q3 = quantile(values, 0.75)!;
  const outside = values.filter((value) => value < q1 - 1.5 * (q3 - q1) || value > q3 + 1.5 * (q3 - q1)).length;
  const countZ = probabilities.map((value) => (value - 1 / size) / Math.sqrt((1 / size) * (1 - 1 / size) / n));
  const base = values.slice(0, -1); const sd = standardDeviation(base);
  const latestZ = sd > 0 ? (last(values) - mean(base)) / sd : null;
  const pattern = states.slice(-2).join(',');
  const oldPattern = patternCounts(states.slice(0, half), 2).get(pattern) ?? 0;
  const newPattern = patternCounts(states.slice(half), 2).get(pattern) ?? 0;
  put(1, ticks.length > 1 ? ratio(ticks.length - 1, ticks.at(-1)!.epoch - ticks[0].epoch) : null, ticks.length, 'Observed ticks per second. Historical cadence does not certify current feed freshness.');
  put(3, mean(short), short.length, 'Selected-event rates across trailing observation windows.', { windows: [50, 200, 1000], probabilities: windows });
  put(4, linear[1], event.length, 'Linearly weighted selected-event probability; descriptive, before validation.');
  put(5, recency[1], event.length, 'Exponentially weighted selected-event probability; half-life 50 observations.');
  put(8, context.probabilities[current], context.sample, 'Smoothed next-current-state probability after the last two states.', { probabilities: context.probabilities });
  put(9, switches === null ? null : 1 - switches, n - 1, 'Observed adjacent state repetitions.');
  put(10, switches, n - 1, 'Observed adjacent state switches; for ten digits this is not binary alternation.');
  put(11, currentRun.length, n, `Current state ${isQuote ? stateName(current) : current}; unfinished run is right-censored.`);
  put(12, eligible ? 1 - continuation : null, eligible, 'Smoothed break rate after matching historical run-state/length contexts; capped length bucket 5+.');
  put(13, isQuote ? mean(returns.slice(-20)) - mean(returns.slice(-100)) : mean(short) - mean(medium), Math.min(100, n), isQuote ? 'Short-minus-medium mean return.' : 'Short-minus-medium selected-event frequency.');
  put(14, autocorrelation(values, 1), n, 'Lag-one correlation. Negative correlation alone is not a validated mean-reversion trade.');
  put(15, completed.length ? ratio(currentRun.length, mean(completed.map((run) => run.length))) : null, completed.length, 'Current run / mean completed runs. A long run is not automatically due to break.');
  put(16, switches, n - 1, 'State-change rate; descriptive reversal proxy.');
  put(17, switches === null ? null : 1 - switches, n - 1, 'State persistence rate, shares the repetition evidence rather than another vote.');
  put(18, eligible ? continuation : null, eligible, 'Continuation in matching historical run contexts with 20-observation prior shrinkage.');
  put(19, isQuote ? latestZ === null ? null : Math.abs(latestZ) : Math.max(...countZ.map(Math.abs)), n, 'Absolute return/count z-score. An anomaly is not directional information.');
  put(20, outside / n, n, 'Fraction outside Tukey fences. Discrete-digit fences can legitimately find zero outliers.');
  put(21, regime, n, 'Descriptive regime; the 300-test diagnostic threshold is conservative and does not establish forecast skill.');
  put(22, regime, n, 'Primary stream snapshot. Prediction skill is evaluated separately on chronologically unseen outcomes.');
  put(24, runsValid ? nonrandom ? 'evidence against a null model' : 'no rejection; not proof of randomness' : null, n, 'Runs diagnostic requires both event classes >10; digit uniformity additionally requires expected counts ≥5.');
  put(25, entropy(probabilities), n, 'Shannon entropy in bits.', { maximumBits: Math.log2(size), normalized: entropy(probabilities) / Math.log2(size) });
  put(26, n >= 40 ? 1 - shift : null, n, 'Distribution overlap between the older and newer halves; not probability calibration.');
  put(27, oldPattern ? (newPattern / Math.max(1, n - half - 1)) / (oldPattern / Math.max(1, half - 1)) : null, n, `Recurrence ratio for context ${pattern}; undefined if absent from the older half.`, { oldOccurrences: oldPattern, recentOccurrences: newPattern });
  put(28, 1 - (Math.max(...windows) - Math.min(...windows)), n, 'Agreement in short/medium/long event rates. Overlapping windows are correlated, not three independent confirmations.');
}

function digitMeasurements(put: ReadingWriter, digits: number[], contract: LabContract, horizon: LabHorizon) {
  const n = digits.length;
  const all = counts(digits, 10); const p = distribution(digits, 10);
  const recent = digits.slice(-200); const recentCounts = counts(recent, 10);
  const ranked = all.map((count, digit) => ({ digit, count })).sort((a, b) => b.count - a.count || a.digit - b.digit);
  const recentRank = recentCounts.map((count, digit) => ({ digit, count })).sort((a, b) => b.count - a.count || a.digit - b.digit);
  const hot = recentRank[0].digit; const cold = recentRank.slice().sort((a, b) => a.count - b.count || a.digit - b.digit)[0].digit;
  const { intervals, gaps } = gapData(digits, 10);
  const table = transitions(digits, 10); const normalized = normalizeRows(table);
  const pair = rankedPatterns(digits, 2)[0]; const triplet = rankedPatterns(digits, 3)[0];
  const conditional = contextDistribution(digits, 10);
  const rotations = digits.slice(1).map((digit, index) => (digit - digits[index] + 10) % 10);
  const rotationCounts = counts(rotations, 10);
  const rotation = rotationCounts.indexOf(Math.max(...rotationCounts));
  const repeats = Array.from({ length: Math.min(20, n - 1) }, (_, i) => digits.slice(i + 1).filter((digit, j) => digit === digits[j]).length / (n - i - 1) - sum(p.map((v) => v ** 2)));
  const maxCycle = repeats.length ? Math.max(...repeats) : null;
  const concentration = sum(p.map((value) => value ** 2));
  const mode = ranked[0].digit;
  const observedGaps = gaps.map((age, digit) => ({ age, digit })).filter((row): row is { age: number; digit: number } => row.age !== null).sort((a, b) => b.age - a.age || a.digit - b.digit);
  const oldest = observedGaps[0];
  const matrix = [50, 200, 1000].map((window) => distribution(digits.slice(-window), 10));
  put(2, mode, n, `Most frequent digit ${mode}.`, { counts: all, probabilities: p });
  put(6, entropy(p), n, 'Ten-category probability mass; see full distribution.', { probabilities: p });
  put(7, table[last(digits)][last(digits)], Math.max(0, n - 1), 'Raw ordered-pair counts. A diagonal count is not a calibrated repeat probability.', { matrix: table });
  put(29, 3, n, 'Rows are 50-, 200- and 1,000-tick windows; columns are digits 0–9.', { matrix, windows: [50, 200, 1000] });
  put(30, ranked.map((row) => row.digit).join(' > '), n, 'Ranked by empirical frequency, tie-broken by digit number.', { counts: ranked.map((row) => row.count) });
  put(31, hot, recent.length, `Count ${recentCounts[hot]}; being hot does not establish continuation.`);
  put(32, cold, recent.length, `Count ${recentCounts[cold]}; being cold does not establish a reversal.`);
  put(33, oldest?.digit ?? null, n, `Largest known gap ${oldest?.age ?? 'unobserved'} ticks. ${gaps.filter((gap) => gap === null).length} unseen digits have censored, unknown ages.`);
  put(34, counts(digits.slice(-50), 10).map((count, digit) => count === 0 ? digit : null).filter((digit) => digit !== null).join(', ') || 'none', Math.min(n, 50), 'Missing digits in this window are not due on the next tick.');
  put(35, p[mode], n, `Dominant digit ${mode}; lead ${fmt(p[mode] - p[ranked[1].digit])}.`);
  put(36, all.map((count, digit) => count < n / 20 ? digit : null).filter((digit) => digit !== null).join(', ') || 'none', n, 'Descriptive count below half the uniform expectation; not multiplicity-adjusted significance.');
  put(37, n >= 100 ? rate(digits.slice(-50), hot) - rate(digits.slice(-100, -50), hot) : null, Math.min(n, 100), `Change in frequency of recent hot digit ${hot}.`);
  put(38, intervals[mode].length ? mean(intervals[mode]) : null, intervals[mode].length, `Mean completed interval for reference digit ${mode}; no censored intervals included.`, { meanIntervals: intervals.map((row) => row.length ? mean(row) : -1) });
  put(39, gaps[mode], n, `Age of reference digit ${mode}. -1 in the array denotes unknown, not an infinite/due age.`, { gaps: gaps.map((gap) => gap ?? -1) });
  put(40, quantile(intervals[mode], 0.5), intervals[mode].length, `Median completed interval for digit ${mode}; CV ${fmt(ratio(standardDeviation(intervals[mode]), mean(intervals[mode])))}.`, { intervals: intervals[mode] });
  put(41, fanoFactor(digits, mode), Math.floor(n / 20), `Reference digit ${mode}; completed 20-tick blocks.`);
  put(42, standardDeviation(p), n, 'Dispersion of the ten digit frequencies.');
  put(43, concentration, n, 'Uniform-digit reference is 0.1; maximum concentration is 1.');
  put(44, 0.5 * sum(p.map((value) => Math.abs(value - 0.1))), n, 'Total variation distance from uniform.');
  put(45, rotations.length ? rotation : null, rotations.length, `Modal modular change; frequency ${fmt(rate(rotations, rotation))}.`, { counts: rotationCounts });
  put(46, maxCycle, n, `Exploratory maximum recurrence excess at lag ${maxCycle === null ? '—' : repeats.indexOf(maxCycle) + 1}. This searches 20 lags and is not evidence of a tradeable cycle.`);
  put(47, patternCounts(digits, 3).get(digits.slice(-3).join(',')) ?? null, Math.max(0, n - 2), `Occurrences of latest triplet ${digits.slice(-3).join(' → ')}.`);
  put(48, pair?.[0] ?? null, Math.max(0, n - 1), `Most common pair count ${pair?.[1] ?? 0}; overlapping occurrences are not independent.`);
  put(49, triplet?.[0] ?? null, Math.max(0, n - 2), `Most common triplet count ${triplet?.[1] ?? 0}; overlapping occurrences are not independent.`);
  put(50, normalized[last(digits)][last(digits)], n - 1, 'Dirichlet +1 per destination transition rows; each row sums to one.', { matrix: normalized });
  put(51, horizon.unit === 'ticks' ? horizon.value : null, n, 'First-order Markov propagation. Time-based digit prediction is not inferred from an average tick rate.', horizon.unit === 'ticks' ? { probabilities: advanceMarkov(normalized, last(digits), horizon.value) } : undefined);
  put(52, conditional.sample ? Math.max(...conditional.probabilities) : null, conditional.sample, 'Largest smoothed next-digit mass after the latest two-digit context.', { probabilities: conditional.probabilities });

  const target = contract.family === 'matches' ? contract.targetDigit : mode;
  const targetNote = `${contract.family === 'matches' ? 'Selected' : 'Context reference'} target ${target}.`;
  const match = digits.map((digit) => digit === target ? 1 : 0); const m = binarySummary(match);
  const hitCount = sum(match); const hot50 = mean(match.slice(-50)); const before50 = mean(match.slice(-100, -50));
  put(53, hitCount, n, targetNote);
  put(54, hitCount / n, n, targetNote);
  put(55, m.current?.state === 1 ? m.current.length : 0, n, targetNote);
  put(56, m.current?.state === 0 ? m.current.length : 0, n, targetNote);
  put(57, gaps[target], n, `${targetNote} Current age is not a hazard increase.`, { intervals: intervals[target] });
  put(58, weightedDistribution(match, 2, true)[1], n, `${targetNote} Recency-weighted descriptive frequency.`);
  put(59, (hitCount + 2) / (n + 20), n, `${targetNote} Beta(2,18) posterior mean, not out-of-sample calibration.`);
  put(60, sum(m.table[last(match)]) ? m.normalized[last(match)][1] : null, sum(m.table[last(match)]), targetNote, { matrix: m.table });
  put(61, fanoFactor(match, 1), Math.floor(n / 20), targetNote);
  put(62, n >= 100 ? hot50 - before50 : null, Math.min(n, 100), `${targetNote} Short-window frequency decay, no forced reversal.`);
  put(63, changeRate(match), n - 1, targetNote);
  put(64, (hitCount - n * 0.1) / Math.sqrt(n * 0.1 * 0.9), n, `${targetNote} Count z-score under uniform digits; exploratory.`);
  const dynamic = matrix[1].map((_, digit) => ({ digit, p: mean(matrix.map((row, window) => (row[digit] * Math.min(n, [50, 200, 1000][window]) + 2) / (Math.min(n, [50, 200, 1000][window]) + 20))) })).sort((a, b) => b.p - a.p || a.digit - b.digit);
  put(65, dynamic[0].digit, n, 'Descriptive multi-window target ranking. Final tool selection still requires candidate-specific confirmation.', { ranking: dynamic.map((row) => row.digit) });

  const parity = digits.map((digit) => digit % 2); const e = binarySummary(parity); const even = parity.filter((value) => value === 0).length;
  const pr = runsTest(parity.map((state) => state === 0 ? 1 : -1));
  put(66, even / n, n, `Even ${even}; odd ${n - even}. Zero is even.`, { counts: [even, n - even] });
  put(67, ratio(even, n - even), n, 'Even/odd ratio; undefined with zero odd observations.');
  put(68, e.current!.length, n, `${last(parity) === 0 ? 'Even' : 'Odd'} run; unfinished.`);
  put(69, changeRate(parity), n - 1, 'Adjacent parity switch frequency.');
  put(70, n >= 100 ? rate(parity.slice(-50), 0) - rate(parity.slice(-100, -50), 0) : null, Math.min(n, 100), 'Recent-minus-preceding even rate.');
  put(71, sum(e.table[last(parity)]) ? e.normalized[last(parity)][1 - last(parity)] : null, sum(e.table[last(parity)]), 'Smoothed next-parity reversal frequency.');
  put(72, e.meanRun ? e.current!.length / e.meanRun : null, e.completed.length, 'Current run / mean completed parity runs.');
  put(73, e.normalized[last(parity)][0], n - 1, 'Current-row P(even), smoothed.', { matrix: e.table });
  put(74, e.gaps.gaps[0], n, 'Age of even parity; -1 means unseen in the array.', { gaps: e.gaps.gaps.map((v) => v ?? -1) });
  put(75, (even + 10) / (n + 20), n, 'P(even); P(odd) is its complement.', { probabilities: [(even + 10) / (n + 20), (n - even + 10) / (n + 20)] });
  put(76, Math.abs(2 * even / n - 1), n, 'Absolute parity imbalance.');
  put(77, pr.positives > 10 && pr.negatives > 10 ? pr.direction : null, n, 'Unadjusted runs-test descriptive regime; not a validated predictive edge.', { pValue: pr.pValue, z: pr.zScore });

  const barrier = contract.family === 'over-under' ? contract.barrier : 4;
  const ou = digits.map((digit) => digit > barrier ? 0 : digit < barrier ? 1 : 2);
  const ouCounts = counts(ou, 3); const ouP = distribution(ou, 3); const ouRuns = runs(ou);
  const ouTable = transitions(ou, 3); const ouNormalized = normalizeRows(ouTable); const ouGaps = gapData(ou, 3);
  const strictCross = ou.slice(1).filter((value, index) => value !== 2 && ou[index] !== 2 && value !== ou[index]).length;
  const note = `${contract.family === 'over-under' ? 'Selected' : 'Context reference'} barrier ${barrier}; equality loses both strict sides.`;
  put(78, ouCounts[0], n, note, { counts: ouCounts, probabilities: ouP });
  put(79, ratio(ouCounts[0], ouCounts[1]), n, note);
  put(80, ouRuns.at(-1)!.length, n, `${note} Current state ${['over', 'under', 'equal'][last(ou)]}.`);
  put(81, n >= 100 ? rate(ou.slice(-50), 0) - rate(ou.slice(-100, -50), 0) : null, Math.min(n, 100), note);
  put(82, ratio(strictCross, n - 1), n - 1, `${note} Strict side switches.`);
  put(83, ouRuns.length > 1 ? ratio(ouRuns.at(-1)!.length, mean(ouRuns.slice(0, -1).map((run) => run.length))) : null, ouRuns.length - 1, note);
  put(84, ouNormalized[last(ou)][0], n - 1, `${note} Current-row P(over).`, { matrix: ouTable });
  put(85, ouGaps.gaps[0], n, note, { gaps: ouGaps.gaps.map((gap) => gap ?? -1) });
  put(86, barrier, n, note, { equalProbability: ouP[2] });
  put(87, ouP[0], n, note, { over: ouP[0], under: ouP[1], equal: ouP[2], fairOver: (9 - barrier) / 10, fairUnder: barrier / 10 });
  put(88, mean(digits.map((digit) => Math.abs(digit - barrier))), n, `${note} Distance is on digit labels, not the quote axis.`);
  put(89, pressure(digits.slice(-50), barrier), Math.min(n, 50), note);
  put(90, n >= 100 ? pressure(digits.slice(-50), barrier) - pressure(digits.slice(-100, -50), barrier) : null, Math.min(n, 100), note);
  put(91, ratio(strictCross, n - 1), n - 1, note);
  const barriers = Array.from({ length: 8 }, (_, index) => index + 1).flatMap((b) => ['over', 'under'].map((side) => {
    const fair = side === 'over' ? (9 - b) / 10 : b / 10;
    const hits = digits.filter((digit) => side === 'over' ? digit > b : digit < b).length;
    return { barrier: b, side, edge: ((hits + 20 * fair) / (n + 20) - fair) / Math.sqrt(fair * (1 - fair)) };
  })).sort((a, b) => b.edge - a.edge || a.barrier - b.barrier);
  put(92, `${barriers[0].side} ${barriers[0].barrier}`, n, 'Descriptive normalized-edge leader in the allowed 1–8 research domain. Payout is not known.');
  put(93, entropy(ouP) / Math.log2(3), n, `${note} Normalized three-state entropy.`, { concentration: sum(ouP.map((value) => value ** 2)) });
}

function quoteMeasurements(put: ReadingWriter, ticks: readonly LabTick[], prices: number[]) {
  const n = prices.length; const returns = differences(prices); const states = returns.map((value) => value > 0 ? 0 : value < 0 ? 1 : 2);
  const directionCounts = counts(states, 3); const table = transitions(states, 3); const normalized = normalizeRows(table);
  const rr = runs(states); const current = rr.at(-1); const currentState = last(states);
  const shortVol = standardDeviation(returns.slice(-20)); const longVol = standardDeviation(returns.slice(-100));
  const volRatio = longVol > 0 ? shortVol / longVol : null;
  const volRegime = volRatio === null ? 'constant / insufficient variation' : volRatio > 1.5 ? 'expanding' : volRatio < 0.67 ? 'compressed' : 'normal';
  const slopes = [20, 60, 200].map((window) => prices.length >= window ? slope(prices.slice(-window)) : null);
  const slope10 = slope(prices.slice(-10)); const previousSlope10 = prices.length >= 20 ? slope(prices.slice(-20, -10)) : null;
  const previousSlope20 = prices.length >= 40 ? slope(prices.slice(-40, -20)) : null;
  const er = efficiency(prices.slice(-60));
  const bars = closedCandles(ticks);
  put(23, volRatio, Math.min(100, returns.length), `20/100 return-volatility ratio: ${volRegime}. Zero long-window variance is undefined, not zero risk.`);
  put(94, ratio(mean(returns.slice(-20)), shortVol), Math.min(20, returns.length), 'Mean return divided by return SD; descriptive momentum.');
  put(95, directionCounts[0], returns.length, 'Up, down and flat tick counts; flat loses both strict contracts.', { counts: directionCounts, probabilities: distribution(states, 3) });
  put(96, current?.length ?? null, returns.length, `Current ${stateName(currentState)} run.`);
  const nonflatPairs = states.slice(1).map((value, index) => ({ value, previous: states[index] })).filter((pair) => pair.value !== 2 && pair.previous !== 2);
  put(97, nonflatPairs.length ? nonflatPairs.filter((pair) => pair.value !== pair.previous).length / nonflatPairs.length : null, nonflatPairs.length, 'Adjacent non-flat increments only. Flat ticks break adjacency.');
  put(98, currentState !== 2 && sum(table[currentState]) ? normalized[currentState][1 - currentState] : null, sum(table[currentState]), 'Smoothed opposite-direction transition probability; a flat current state abstains.');
  put(99, currentState !== 2 && sum(table[currentState]) ? normalized[currentState][currentState] : null, sum(table[currentState]), 'Smoothed continuation probability; flats are separate.');
  put(100, slopes[1], Math.min(n, 60), 'OLS quote slope per tick.');
  put(101, slope10 !== null && previousSlope10 !== null ? slope10 - previousSlope10 : null, Math.min(n, 20), '10-tick slope change.');
  put(102, slope10 !== null && previousSlope10 !== null ? Math.abs(previousSlope10) - Math.abs(slope10) : null, Math.min(n, 20), 'Positive means deceleration in absolute slope.');
  put(103, er, Math.min(n, 60), 'Net displacement / total absolute path displacement.');
  put(104, returns.length ? (directionCounts[0] + 10) / (returns.length + 20) : null, returns.length, 'Tick-direction posterior; duration-specific direct forecasts are in the Prediction group.', { probabilities: [(directionCounts[0] + 10) / (returns.length + 20), (directionCounts[1] + 10) / (returns.length + 20), directionCounts[2] / (returns.length + 20)] });
  put(105, normalized[currentState][0], returns.length - 1, 'Current-row P(rise), with flat destination retained.', { matrix: table });
  put(106, current && rr.length > 1 ? ratio(current.length, mean(rr.slice(0, -1).map((run) => run.length))) : null, rr.length - 1, 'Current run relative to completed direction runs.');
  const regime = er !== null && er > 0.35 ? (slopes[1] ?? 0) > 0 ? 'directional up' : 'directional down' : `non-directional / ${volRegime}`;
  put(107, regime, Math.min(n, 100), 'Rule-based observed regime, not a hidden-state probability.');

  const ema9 = ema(prices, 9); const ema20 = ema(prices, 20); const ema21 = ema(prices, 21); const ema50 = ema(prices, 50);
  const ma = (window: number) => n >= window ? mean(prices.slice(-window)) : null;
  const sma10 = ma(10); const sma20 = ma(20); const sma50 = ma(50);
  const alignment = (a: number | null, b: number | null, c: number | null) => a === null || b === null || c === null ? null : a > b && b > c ? 1 : a < b && b < c ? -1 : 0;
  put(128, slopes.every((value) => value !== null) ? slopes.every((value) => value! > 0) ? 'up' : slopes.every((value) => value! < 0) ? 'down' : 'mixed' : null, n, 'Agreement of 20/60/200 quote slopes.', { slopes: slopes.map((value) => value ?? 0) });
  put(129, er, Math.min(n, 60), 'Direction-independent price-path efficiency.');
  put(130, slopes[1] === null ? null : Math.sign(slopes[1]), Math.min(n, 60), 'Signed regression trend.');
  const blockSlopes: number[] = [];
  for (let start = Math.max(0, n - 400); start + 20 <= n; start += 20) blockSlopes.push(slope(prices.slice(start, start + 20))!);
  put(131, blockSlopes.length && slopes[1] !== null ? blockSlopes.filter((value) => Math.sign(value) === Math.sign(slopes[1]!)).length / blockSlopes.length : null, blockSlopes.length, 'Completed 20-tick block trends agreeing with the latest 60-tick slope.');
  put(132, slopes[0] !== null && previousSlope20 !== null ? slopes[0] - previousSlope20 : null, Math.min(n, 40), '20-tick slope change.');
  put(133, slopes[0] !== null && previousSlope20 !== null ? Math.abs(slopes[0]) - Math.abs(previousSlope20) : null, Math.min(n, 40), 'Negative means absolute trend slope weakened.');
  put(134, slopes[0] !== null && previousSlope20 !== null ? Number(slopes[0] * previousSlope20 < 0) : null, Math.min(n, 40), 'One only for opposite consecutive slope signs.');
  const frames = [60, 180, 300].map((seconds) => closedCandles(ticks, seconds));
  const frameSlopes = frames.map((frame) => frame.length >= 3 ? slope(frame.map((bar) => bar.close).slice(-10)) : null);
  put(135, frameSlopes.every((value) => value !== null) ? frameSlopes.map((value) => Math.sign(value!)).join(' / ') : null, Math.min(...frames.map((frame) => frame.length)), 'Completed 1m / 3m / 5m slope signs. Requires ≥3 closed bars per timeframe; absent bars are never fabricated.');
  put(136, sma20 !== null && ema20.at(-1) != null ? last(prices) - (sma20 + ema20.at(-1)!) / 2 : null, Math.min(n, 20), 'Price minus the mean of SMA-20 and EMA-20.');
  put(137, alignment(sma10, sma20, sma50), Math.min(n, 50), 'SMA 10/20/50: +1 bullish ordering, −1 bearish, 0 mixed.');
  put(138, alignment(ema9.at(-1) ?? null, ema21.at(-1) ?? null, ema50.at(-1) ?? null), Math.min(n, 50), 'EMA 9/21/50 alignment; SMA seeded.');
  put(139, ema20.at(-6) != null ? (ema20.at(-1)! - ema20.at(-6)!) / 5 : null, n, 'EMA-20 slope per tick across five ticks.');
  put(140, ema20.at(-1) != null ? ratio(last(prices) - ema20.at(-1)!, longVol) : null, Math.min(n, 100), 'Quote distance from EMA-20 in return-SD units.');
  const cross = ema21.at(-2) != null ? ema9.at(-1)! > ema21.at(-1)! && ema9.at(-2)! <= ema21.at(-2)! ? 1 : ema9.at(-1)! < ema21.at(-1)! && ema9.at(-2)! >= ema21.at(-2)! ? -1 : 0 : null;
  put(141, cross, n, 'New EMA-9/21 crossover only, not sustained alignment.');
  const rs = rsi(prices); const r = rs.at(-1) ?? null; const m = macd(prices);
  put(142, r, n, 'Wilder RSI-14; flat prices yield 50, one-sided positive returns yield 100.');
  put(143, rs.at(-6) != null ? r! - rs.at(-6)! : null, n, 'Five-tick RSI change.');
  put(144, rs.at(-15) != null ? Number((last(prices) - prices.at(-15)!) * (r! - rs.at(-15)!) < 0) : null, n, 'Price/RSI change-sign divergence proxy, not a confirmed swing divergence.');
  put(145, rs.at(-2) != null ? rs.at(-2)! < 30 && r! >= 30 ? 1 : rs.at(-2)! > 70 && r! <= 70 ? -1 : 0 : null, n, 'RSI re-entry from oversold (+1) or overbought (−1).');
  put(146, r === null ? null : r < 30 ? 'oversold' : r > 70 ? 'overbought' : 'neutral', n, 'An oscillator regime is descriptive, not a reversal guarantee.');
  put(147, m.line.at(-1) ?? null, n, 'MACD 12/26/9.', { signal: m.signal.at(-1) ?? null, histogram: m.histogram.at(-1) ?? null });
  put(148, m.histogram.at(-6) != null ? m.histogram.at(-1)! - m.histogram.at(-6)! : null, n, 'Five-tick MACD histogram change.');
  put(149, m.line.at(-15) != null ? Number((last(prices) - prices.at(-15)!) * (m.line.at(-1)! - m.line.at(-15)!) < 0) : null, n, 'Price/MACD change-sign divergence proxy.');
  const stochastic = (subset: typeof bars) => {
    if (subset.length < 14) return null;
    const window = subset.slice(-14); const hi = Math.max(...window.map((bar) => bar.high)); const lo = Math.min(...window.map((bar) => bar.low));
    return ratio(100 * (window.at(-1)!.close - lo), hi - lo);
  };
  const stoch = stochastic(bars); const previousStoch = stochastic(bars.slice(0, -1));
  put(150, stoch, bars.length, 'Fast stochastic %K-14 on completed 60-second candles.');
  put(151, stoch !== null && previousStoch !== null ? stoch - previousStoch : null, bars.length, 'Change in completed-candle fast %K.');
  const typical = bars.slice(-20).map((bar) => (bar.high + bar.low + bar.close) / 3); const typicalMean = mean(typical);
  put(152, typical.length >= 20 ? ratio(last(typical) - typicalMean, 0.015 * mean(typical.map((value) => Math.abs(value - typicalMean)))) : null, typical.length, 'CCI-20 on completed 60-second candles.');
  put(153, n > 20 ? ratio(100 * (last(prices) - prices.at(-21)!), prices.at(-21)!) : null, n, '20-tick ROC in percent.');
  put(154, n > 10 ? last(prices) - prices.at(-11)! : null, n, '10-tick price momentum.');
  put(155, stoch === null ? null : stoch - 100, bars.length, 'Williams %R-14 on completed candles.');
  put(156, returns.length > 1 ? standardDeviation(returns) : null, returns.length, 'Sample standard deviation of quote increments; not a directional probability.');
  put(157, prices.every((price) => price > 0) && n > 1 ? Math.sqrt(sum(prices.slice(1).map((price, index) => Math.log(price / prices[index]) ** 2))) : null, returns.length, 'Unannualized realized log-return volatility.');
  put(158, returns.length ? Math.abs(last(returns)) : null, returns.length ? 1 : 0, 'Absolute latest price increment.');
  put(159, shortVol, returns.length, 'Return SD across trailing tick windows.', { windows: [20, 50, 100], volatility: [shortVol, standardDeviation(returns.slice(-50)), longVol] });
  const atr14 = atr(bars);
  put(160, atr14, bars.length, 'Wilder ATR-14 requires 15 completed 60-second candles; includes gaps from prior closes.');
  const boll = prices.slice(-20); const center = mean(boll); const deviation = Math.sqrt(mean(boll.map((price) => (price - center) ** 2)));
  put(161, boll.length >= 20 ? center : null, boll.length, 'Bollinger 20-period middle band.', { upper: center + 2 * deviation, lower: center - 2 * deviation });
  put(162, boll.length >= 20 ? ratio(4 * deviation, Math.abs(center)) : null, boll.length, 'Bollinger relative bandwidth.');
  put(163, volRatio === null ? null : Math.max(0, volRatio - 1), Math.min(returns.length, 100), 'Positive expansion excess over the long-window volatility.');
  put(164, volRatio === null ? null : Math.max(0, 1 - volRatio), Math.min(returns.length, 100), 'Positive compression shortfall below the long-window volatility.');
  const priorVol = standardDeviation(returns.slice(-101, -1));
  put(165, returns.length > 20 && priorVol > 0 ? Number(Math.abs(last(returns)) > 3 * priorVol) : null, Math.min(returns.length - 1, 100), 'Latest absolute move >3 prior return SDs. Heavy tails can make this common.');
  // #166 is a transparent alias applied centrally after #23.
  return { bars, ema20: ema20.at(-1) ?? null, atr14 };
}

function candleAndStructure(put: ReadingWriter, bars: ReturnType<typeof closedCandles>, ema20: number | null, atr14: number | null) {
  const n = bars.length;
  const bar = bars.at(-1)!; const prev = bars.at(-2);
  const body = Math.abs(bar.close - bar.open); const range = bar.high - bar.low;
  const direction = Math.sign(bar.close - bar.open);
  const upper = bar.high - Math.max(bar.open, bar.close); const lower = Math.min(bar.open, bar.close) - bar.low;
  const old = bars.slice(-21, -1);
  const priorRanges = old.map((item) => item.high - item.low);
  const rangeRatio = old.length >= 20 ? ratio(range, mean(priorRanges)) : null;
  const support = old.length >= 20 ? Math.min(...old.map((item) => item.low)) : null;
  const resistance = old.length >= 20 ? Math.max(...old.map((item) => item.high)) : null;
  const engulf = prev ? direction !== 0 && direction === -Math.sign(prev.close - prev.open) && Math.max(bar.open, bar.close) >= Math.max(prev.open, prev.close) && Math.min(bar.open, bar.close) <= Math.min(prev.open, prev.close) : false;
  const triple = n >= 3 ? bars.slice(-3).every((item) => Math.sign(item.close - item.open) === direction) && direction !== 0 : false;
  const pattern = range === 0 ? 'zero range' : body / range < 0.1 ? 'doji' : lower > 2 * body && upper < body ? 'lower pin' : upper > 2 * body && lower < body ? 'upper pin' : 'no named pattern';
  const detail = 'Last fully completed 60-second candle. Open/partial last candle excluded.';
  put(108, direction, n, detail);
  put(109, body, n, detail);
  put(110, range, n, detail);
  put(111, upper + lower, n, detail, { upper, lower });
  put(112, ratio(upper, range), n, `${detail} Upper wick / range.`);
  put(113, ratio(lower, range), n, `${detail} Lower wick / range.`);
  put(114, ratio(body, range), n, `${detail} Body / range.`);
  put(115, ratio(upper + lower, body), n, `${detail} Undefined for zero body; doji is not infinity.`);
  put(116, ratio(bar.close - bar.open, range), n, `${detail} Signed body / range.`);
  put(117, n >= 3 ? mean(bars.slice(-3).map((item) => item.close - item.open)) : null, Math.min(n, 3), 'Mean signed bodies of three closed candles.');
  put(118, n >= 6 ? ratio(body, mean(bars.slice(-6, -1).map((item) => Math.abs(item.close - item.open)))) : null, Math.min(n, 6), 'Body relative to preceding five bodies; not a reversal signal by itself.');
  put(119, prev ? Number(engulf) * direction : null, Math.min(n, 2), 'Explicit opposite-body engulfing rule.');
  put(120, n >= 3 ? Number(triple) * direction : null, Math.min(n, 3), 'Three consecutive same nonzero directions.');
  put(121, rangeRatio, old.length, 'Range ratio below one indicates compression; zero previous average is undefined.');
  put(122, rangeRatio, old.length, 'Same range evidence above one indicates expansion; not another independent vote.');
  put(123, bars.slice(-5).map((item) => item.close > item.open ? 'U' : item.close < item.open ? 'D' : '=').join(' → '), Math.min(n, 5), 'Completed candle direction sequence.');
  put(124, pattern, n, 'Rule-based descriptive pattern; no assumed predictive win rate.');
  put(125, n >= 3 ? engulf ? 'engulfing' : triple ? 'three same-direction bodies' : 'none' : null, Math.min(n, 3), 'Explicit two/three-candle pattern rules.');
  put(126, support !== null && resistance !== null ? bar.close > resistance ? 1 : bar.close < support ? -1 : 0 : null, old.length, 'Close outside a channel computed without the latest candle.');
  put(127, ratio(upper - lower, range), n, 'Signed wick asymmetry; positive means larger upper rejection.');
  put(167, support, old.length, 'Prior 20 completed-candle low; latest candle is excluded.');
  put(168, resistance, old.length, 'Prior 20 completed-candle high; latest candle is excluded.');
  put(169, ema20 !== null && atr14 !== null ? ema20 - atr14 : null, n, 'EMA-20 minus ATR-14; tick EMA / minute ATR hybrid, labelled price-only proxy.');
  put(170, ema20 !== null && atr14 !== null ? ema20 + atr14 : null, n, 'EMA-20 plus ATR-14; tick EMA / minute ATR hybrid, labelled price-only proxy.');
  put(171, resistance === null ? null : Number(bar.close > resistance), old.length, 'Strict close above prior channel resistance.');
  put(172, support === null ? null : Number(bar.close < support), old.length, 'Strict close below prior channel support.');
  const rejection = resistance !== null && support !== null ? bar.high > resistance && bar.close <= resistance ? -1 : bar.low < support && bar.close >= support ? 1 : 0 : null;
  put(173, rejection, old.length, 'Channel pierce and inside close.');
  const older = bars.slice(-22, -2);
  const olderHi = older.length >= 20 ? Math.max(...older.map((item) => item.high)) : null;
  const olderLo = older.length >= 20 ? Math.min(...older.map((item) => item.low)) : null;
  const priorUp = prev && olderHi !== null && prev.close > olderHi;
  const priorDown = prev && olderLo !== null && prev.close < olderLo;
  put(174, olderHi !== null && olderLo !== null ? priorUp && bar.low <= olderHi && bar.close > olderHi ? 1 : priorDown && bar.high >= olderLo && bar.close < olderLo ? -1 : 0 : null, older.length, 'Retest of a fixed level defined before the breakout, not a channel including the breakout.');
  put(175, olderHi !== null && olderLo !== null ? priorUp && bar.close <= olderHi ? -1 : priorDown && bar.close >= olderLo ? 1 : 0 : null, older.length, 'Return inside the fixed pre-breakout channel.');
  put(176, rejection, old.length, 'Price-only sweep/reclaim proxy. No order-book or actual liquidity data is available.');
  const highs: number[] = []; const lows: number[] = [];
  for (let index = 2; index < n - 2; index += 1) {
    const neighbors = [bars[index - 2], bars[index - 1], bars[index + 1], bars[index + 2]];
    if (neighbors.every((neighbor) => bars[index].high > neighbor.high)) highs.push(bars[index].high);
    if (neighbors.every((neighbor) => bars[index].low < neighbor.low)) lows.push(bars[index].low);
  }
  const hh = highs.length >= 2 ? Number(highs.at(-1)! > highs.at(-2)!) : null;
  const lh = highs.length >= 2 ? Number(highs.at(-1)! < highs.at(-2)!) : null;
  const hl = lows.length >= 2 ? Number(lows.at(-1)! > lows.at(-2)!) : null;
  const ll = lows.length >= 2 ? Number(lows.at(-1)! < lows.at(-2)!) : null;
  put(177, highs.length >= 2 && lows.length >= 2 ? 'confirmed pivots' : null, n, 'Two bars on each side confirm a swing; last two bars cannot be confirmed pivots.', { highs: highs.slice(-2), lows: lows.slice(-2) });
  put(178, hh, highs.length, 'Latest confirmed high > preceding high.');
  put(179, lh, highs.length, 'Latest confirmed high < preceding high.');
  put(180, hl, lows.length, 'Latest confirmed low > preceding low.');
  put(181, ll, lows.length, 'Latest confirmed low < preceding low.');
  put(182, hh !== null && hl !== null ? hh && hl ? 'HH + HL / up' : lh && ll ? 'LH + LL / down' : 'mixed / equal' : null, n, 'Structure is withheld until both high and low pivot pairs exist.');
}

function statistical(put: ReadingWriter, digits: number[], prices: number[], contract: LabContract, horizon: LabHorizon) {
  const quote = contract.family === 'rise-fall';
  const returns = differences(prices); const values = quote ? returns : digits;
  const states = quote ? returns.map((v) => v > 0 ? 0 : v < 0 ? 1 : 2) : digits;
  const size = quote ? 3 : 10; const n = values.length;
  if (!n) return;
  const average = mean(values); const sd = standardDeviation(values); const med = quantile(values, 0.5);
  const q1 = quantile(values, 0.25)!; const q3 = quantile(values, 0.75)!;
  const min = Math.min(...values); const max = Math.max(...values);
  const table = new Map<number, number>(); for (const value of values) table.set(value, (table.get(value) ?? 0) + 1);
  const mode = [...table].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const popVariance = mean(values.map((value) => (value - average) ** 2));
  const third = mean(values.map((value) => (value - average) ** 3)); const fourth = mean(values.map((value) => (value - average) ** 4));
  const previous = values.slice(0, -1); const previousSd = standardDeviation(previous);
  const frequencies = quote ? counts(values.map((value) => max === min ? 0 : Math.min(9, Math.floor(10 * (value - min) / (max - min)))), 10) : counts(digits, 10);
  const events = states.map((state) => eventWins(contract, state) ? 1 : 0); const hits = sum(events);
  const fair = contract.family === 'matches' ? 0.1 : contract.family === 'even-odd' ? 0.5 : contract.family === 'over-under' ? contract.contractType === 'DIGITOVER' ? (9 - contract.barrier) / 10 : contract.barrier / 10 : (1 - rate(states, 2)) / 2;
  const stateTable = transitions(states, size); const smoothed = normalizeRows(stateTable); const current = last(states);
  const conditional = contextDistribution(states, size);
  const outcomeMass = (p: readonly number[]) => sum(p.map((value, state) => eventWins(contract, state) ? value : 0));
  const binary = events.map((value) => value ? 1 : -1); const test = runsTest(binary);
  const sequence = states.slice(-3).join(','); const sequenceCount = patternCounts(states, 3).get(sequence) ?? 0;
  const pattern = states.slice(-2).join(','); const occurrences: number[] = [];
  for (let index = 1; index < n; index += 1) if (`${states[index - 1]},${states[index]}` === pattern) occurrences.push(index);
  const rr = runs(states);
  const statsDetail = quote ? 'Primary series: observed quote increments, not nonstationary quote levels.' : 'Primary series: numeric digit labels. Arithmetic moments are descriptive, not a price trend.';
  put(183, average, n, statsDetail, { mean: average, median: med, standardDeviation: sd, min, max });
  put(184, average, n, statsDetail);
  put(185, med, n, statsDetail);
  put(186, mode, n, `${statsDetail} Exact-value mode; ascending tie break.`);
  put(187, n >= 2 ? sd : null, n, 'Sample SD, denominator n−1.');
  put(188, n >= 2 ? sd ** 2 : null, n, 'Sample variance, denominator n−1.');
  put(189, max - min, n, statsDetail);
  put(190, quantile(values, 0.95), n, statsDetail, { p5: quantile(values, 0.05), p50: med, p95: quantile(values, 0.95) });
  put(191, q3 - q1, n, statsDetail, { q1, q3 });
  put(192, previousSd > 0 ? (last(values) - mean(previous)) / previousSd : null, previous.length, 'Latest value standardized only against earlier observations.');
  put(193, popVariance > 0 ? third / popVariance ** 1.5 : null, n, 'Biased population-moment skewness; constant series is undefined.');
  put(194, popVariance > 0 ? fourth / popVariance ** 2 - 3 : null, n, 'Biased excess kurtosis; Gaussian reference 0, constant series undefined.');
  put(195, entropy(frequencies.map((count) => count / n)), n, quote ? 'Ten equal-width return histogram bins; value is histogram entropy.' : 'Categorical digit-distribution entropy.', { counts: frequencies });
  const bandwidth = sd * n ** (-0.2);
  const density = quote ? bandwidth > 0 ? mean(values.map((value) => Math.exp(-0.5 * ((last(values) - value) / bandwidth) ** 2) / (bandwidth * Math.sqrt(2 * Math.PI)))) : null : frequencies[last(values)] / n;
  put(196, density, n, quote ? 'Gaussian KDE at the latest return; Scott bandwidth; constant series abstains.' : 'Probability mass at the latest digit, not a Gaussian digit density.');
  const interval = wilsonInterval(hits, n);
  put(197, interval.lower, n, 'Descriptive 95% Wilson interval for observed one-step contract events. Serial dependence can invalidate nominal coverage; independent holdout interval appears under #226.', { lower: interval.lower, upper: interval.upper });
  put(198, (hits + 20 * Math.max(0.000001, Math.min(0.999999, fair))) / (n + 20), n, 'Beta prior strength 20; center is the contract baseline clipped to [0.000001, 0.999999] to keep both prior parameters positive.');
  put(199, sum(stateTable[current]) ? outcomeMass(smoothed[current]) : null, sum(stateTable[current]), 'Selected-event mass in the current-state smoothed transition row.');
  put(200, n >= 2 ? stateTable[states.at(-2)!][current] / (n - 1) : null, n - 1, 'Unconditional joint mass for the latest ordered state pair.');
  put(201, hits / n, n, 'Full-window descriptive selected-event frequency; not strategy backtest accuracy.');
  put(202, mean(events.slice(-200)), Math.min(n, 200), 'Recent descriptive selected-event frequency.');
  put(203, frequencies.indexOf(Math.max(...frequencies)), n, 'Modal histogram/category bin.', { counts: frequencies });
  const acf = Array.from({ length: Math.min(10, n - 1) }, (_, index) => autocorrelation(values, index + 1));
  put(204, n >= 3 && sd > 0 ? acf[0] : null, n, 'Autocorrelation on digits or returns. Numeric digit-label dependence is not directional quote dependence.', { autocorrelations: acf });
  put(205, n >= 12 && sd > 0 ? pacf(values)[4] : null, n, 'Lag-five PACF, Durbin–Levinson; vector gives lags one through five.', { partialAutocorrelations: n >= 12 && sd > 0 ? pacf(values) : [] });
  const dependence = ljungBox(values, Math.min(10, Math.max(1, Math.floor(n / 5))));
  put(207, n >= 30 && sd > 0 ? dependence.statistic : null, n, 'Ljung–Box serial-dependence test; diagnostic p-value is not a win probability.', { pValue: dependence.pValue, lags: dependence.degreesOfFreedom });
  put(208, sum(stateTable[current]) ? smoothed[current][current] : null, n - 1, 'Current-row repeat-state probability.', { matrix: smoothed });
  put(209, horizon.unit === 'ticks' ? outcomeMass(advanceMarkov(smoothed, current, horizon.value)) : null, n, quote ? 'Markov forecast of the direction state at the terminal tick, NOT the net Rise/Fall contract return. Context diagnostic only.' : 'Selected-event mass in horizon-propagated digit state distribution.', undefined, quote);
  put(210, conditional.sample ? outcomeMass(conditional.probabilities) : null, conditional.sample, 'Event probability after the latest two states.', { probabilities: conditional.probabilities });
  put(211, n >= 3 ? sequenceCount / (n - 2) : null, n - 2, `Observed probability of sequence ${sequence}. Overlap is not independence.`);
  put(212, occurrences.length >= 2 ? mean(differences(occurrences)) : null, occurrences.length, `Mean completed recurrence interval for pair ${pattern}.`, { intervals: differences(occurrences) });
  put(213, rr.length > 1 ? mean(rr.slice(0, -1).map((run) => run.length)) : null, rr.length - 1, `Mean completed run length; latest unfinished run ${rr.at(-1)!.length} excluded.`, { lengths: rr.slice(0, -1).map((run) => run.length) });
  put(214, test.positives > 10 && test.negatives > 10 ? test.zScore : null, n, 'Normal approximation only with >10 observations in both event classes.', { pValue: test.positives > 10 && test.negatives > 10 ? test.pValue : null, runs: test.runs, expectedRuns: test.expectedRuns });
  const nonzeroRows = stateTable.filter((row) => sum(row) > 0);
  const activeColumns = Array.from({ length: size }, (_, column) => column).filter((column) => sum(nonzeroRows.map((row) => row[column])) > 0);
  const reduced = nonzeroRows.map((row) => activeColumns.map((column) => row[column]));
  const total = sum(reduced.flat()); const columns = activeColumns.map((_, column) => sum(reduced.map((row) => row[column])));
  const adequate = reduced.length > 1 && columns.length > 1 && reduced.every((row) => columns.every((columnTotal) => sum(row) * columnTotal / total >= 5));
  const independence = adequate ? chiSquareIndependence(reduced) : null;
  put(216, independence?.statistic ?? null, total, 'Transition-table independence test; every expected cell must be ≥5 and empty margins are removed.', { pValue: independence?.pValue ?? null });
  const stationarity = kpss(values);
  put(217, stationarity.statistic, n, `KPSS level-stationarity diagnostic: ${stationarity.stationary === null ? 'undefined' : stationarity.stationary ? 'not rejected at 5%' : 'rejected at 5%'}. Not an ADF test.`, { lags: stationarity.lags, critical5Percent: 0.463 });
  const change = cusumChange(values);
  put(218, n >= 30 && sd > 0 ? change.statistic : null, n, 'Exploratory centered CUSUM, no selected change-point p-value claim.', { index: change.index, shift: change.shift });
}

export function measureEngines(input: { ticks: readonly LabTick[]; family: ToolFamily; contract: LabContract; horizon: LabHorizon }) {
  const writer = createReadingWriter(input.family); const { put, missing } = writer;
  const ticks = normalizeTicks(input.ticks);
  const digits = ticks.filter((tick) => tick.digit != null).map((tick) => tick.digit!);
  const quoteTicks = ticks.filter((tick) => tick.quote != null);
  const prices = quoteTicks.map((tick) => tick.quote!);
  const primary = input.family === 'rise-fall' ? prices.length > 1 : digits.length > 0;
  if (primary) { core(put, ticks, digits, prices, input.contract); statistical(put, digits, prices, input.contract, input.horizon); }
  else missing([...ids(1, 28), ...ids(183, 218)], 'No valid primary-stream observations.');
  if (digits.length) {
    digitMeasurements(put, digits, input.contract, input.horizon);
    const chi = chiSquareGoodnessOfFit(counts(digits, 10));
    put(215, digits.length >= 50 ? chi.statistic : null, digits.length, 'Uniform ten-digit chi-square requires expected cell counts ≥5; p is diagnostic only.', { pValue: digits.length >= 50 ? chi.pValue : null, degreesOfFreedom: 9 });
  } else missing([2, 6, 7, ...ids(29, 93), 215], 'Verified last-digit precision/data is unavailable. Digits are never guessed from a rounded numeric quote.');
  let candleCount = 0;
  if (prices.length > 1) {
    const quote = quoteMeasurements(put, quoteTicks, prices)!;
    const returns = differences(prices);
    put(206, correlation(returns.slice(1), returns.slice(0, -1).map(Math.abs)), returns.length - 1, 'Aligned return versus preceding absolute return correlation. No external market/volume data inferred.');
    candleCount = quote.bars.length;
    if (candleCount) candleAndStructure(put, quote.bars, quote.ema20, quote.atr14);
    else missing([...ids(108, 127), ...ids(167, 182)], 'No fully closed 60-second candles. In-progress and first partial buckets are excluded.');
  } else missing([23, ...ids(94, 165), ...ids(167, 182), 206], 'Quote history is unavailable. Price/candle evidence cannot be fabricated from final digits.');
  // Alias #166 is copied in report.ts after the source is known.
  return { ...writer, ticks, digits, prices, sample: { digits: digits.length, quotes: prices.length, candles: candleCount } };
}
