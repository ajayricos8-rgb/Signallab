import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_CATALOG, ENGINE_CATEGORIES, ENGINE_SOURCES } from '../src/lib/engine-lab/catalog.ts';
import { measureEngines } from '../src/lib/engine-lab/measurements.ts';
import { buildEngineLabReport, settledPerformance } from '../src/lib/engine-lab/report.ts';
import { auditForecastBank, buildForecastBank, decideResearch, forecastAt } from '../src/lib/engine-lab/forecast.ts';
import { atr, closedCandles, correlation, distribution, ema, eventWins, horizonExits, kpss, macd, normalizeTicks, project, rsi, weightedDistribution } from '../src/lib/engine-lab/math.ts';
import { quoteEconomics, researchAdvisory, scopeSettlements } from '../src/lib/engine-lab/execution.ts';
import { fuseResearch, researchEvidence } from '../src/lib/engine-lab/fusion.ts';
import { analyzeDigitMarket } from '../src/lib/signal-engine/digit-signal.ts';
import { analyzeRiseFallMarket, RISE_FALL_ENGINES } from '../src/lib/signal-engine/rise-fall-signal.ts';
import { analyzeDigitEntry } from '../src/lib/signal-engine/entry.ts';
import { confidenceScore } from '../src/lib/signal-engine/confidence.ts';

function random(seed = 1) {
  let a = 0x9e3779b9; let b = 0x243f6a88 + seed; let c = 0xb7e15162; let d = 0x12345678 ^ (seed * 7919);
  const next = () => { a |= 0; b |= 0; c |= 0; d |= 0; const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let i = 0; i < 30; i += 1) next();
  return next;
}
function ticks(seed = 1, length = 2000, bias = false) {
  const next = random(seed); let quote = 100;
  return Array.from({ length }, (_, index) => {
    const digit = bias && next() < 0.65 ? 7 : Math.floor(next() * 10);
    quote += next() - 0.5;
    return { epoch: 1_700_000_040 + index, digit, quote };
  });
}
const contract = {
  matches: { family: 'matches', contractType: 'DIGITMATCH', targetDigit: 7 },
  'even-odd': { family: 'even-odd', contractType: 'DIGITEVEN' },
  'over-under': { family: 'over-under', contractType: 'DIGITOVER', barrier: 4 },
  'rise-fall': { family: 'rise-fall', direction: 'RISE' },
};
const horizon = { unit: 'ticks', value: 1 };
const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);
const readings = (data, family = 'matches', chosen = contract[family]) => measureEngines({ ticks: data, family, contract: chosen, horizon }).readings;
function assertFiniteTree(value, path = '') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path}: ${value}`);
  else if (Array.isArray(value)) value.forEach((item, i) => assertFiniteTree(item, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) assertFiniteTree(item, `${path}.${key}`);
}
const fair = (family) => family === 'matches' ? 0.1 : 0.5;
function report(data, family = 'matches', settlements, settlementCurrency) {
  const audit = auditForecastBank(buildForecastBank(data, family === 'rise-fall' ? 'quote' : 'digit', horizon), contract[family], fair(family), 13);
  const decision = decideResearch({ audit, probability: fair(family), fair: fair(family), fresh: true, confirmed: false, independentSample: 100 });
  const entry = analyzeDigitEntry({ digits: data.map((tick) => tick.digit).filter((digit) => digit != null), epochs: data.map((tick) => tick.epoch), horizon: 1, wins: (digit) => digit === 7, context: 'digit', fairRate: 0.1, signal: { source: 'digit', agreeing: 0, total: 1, probability: 0.1, aiProbability: null } });
  return buildEngineLabReport({ family, symbol: 'R_100', ticks: data, contract: contract[family], horizon, fresh: true, audit, decision,
    legacy: { probability: fair(family), fair: fair(family), confidence: 50, votes: [], confirmationStatus: 'cautious', confirmed: false, entry },
    candidates: [{ label: 'fixture', probability: fair(family), fair: fair(family), confidence: 50 }], settlements, settlementCurrency });
}

test('catalog contains exactly the requested 300 numbered methods, 17 groups and explicit duplicate aliases', () => {
  assert.equal(ENGINE_CATALOG.length, 300);
  assert.deepEqual(ENGINE_CATALOG.map((engine) => engine.id), Array.from({ length: 300 }, (_, i) => i + 1));
  assert.equal(ENGINE_CATEGORIES.length, 17);
  assert.equal(ENGINE_CATALOG[64].name, 'Dynamic Match Target Engine');
  assert.equal(ENGINE_CATALOG[165].aliasOf, 23);
  assert.equal(ENGINE_CATALOG[227].aliasOf, 28);
  assert.equal(ENGINE_CATALOG[299].name, 'Master Signal Synthesis Engine');
  for (const engine of ENGINE_CATALOG) {
    assert.ok(engine.method.length >= 10, engine.name);
    assert.ok(engine.sources.every((source) => ENGINE_SOURCES[source]?.url.startsWith('https://')));
    if (engine.aliasOf) assert.ok(engine.aliasOf < engine.id);
  }
  assert.ok(ENGINE_CATALOG[43].method.includes('|p−0.1|'), 'absolute-value formula must not be truncated by the catalog delimiter');
});

for (const family of Object.keys(contract)) test(`all 300 engines have explicit finite readings/statuses for ${family}`, () => {
  const result = report(ticks(31), family);
  assert.equal(result.readings.length, 300);
  assert.equal(result.registered, 300);
  assert.equal(Object.values(result.counts).reduce((sum, count) => sum + count, 0), 300);
  assert.equal(result.counts.alias, 2);
  assert.equal(result.counts.unavailable, 6, 'only actual-settlement metrics lack required data on this fixture');
  assert.ok(result.sample.candles >= 30);
  assert.ok(result.readings.every((reading) => reading.detail && reading.sample >= 0));
  assertFiniteTree(result);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.readings[165].value, result.readings[22].value);
  assert.equal(result.readings[227].value, result.readings[27].value);
  if (family !== 'rise-fall') assert.equal(result.readings[141].status, 'context');
  else {
    assert.equal(result.readings[30].status, 'context');
    assert.equal(result.readings[208].status, 'context', 'terminal direction state is not net contract return');
  }
});

test('quote, precision and P&L requirements abstain explicitly rather than inventing inputs', () => {
  const digitsOnly = ticks(8).map(({ epoch, digit }) => ({ epoch, digit }));
  const result = report(digitsOnly);
  assert.equal(result.readings[141].status, 'unavailable');
  assert.equal(result.readings[107].status, 'unavailable');
  assert.equal(result.readings[264].value, null);
  assert.equal(result.readings[269].status, 'unavailable');
  const quotesOnly = ticks(3).map(({ epoch, quote }) => ({ epoch, quote }));
  const quoteResult = report(quotesOnly, 'rise-fall');
  assert.equal(quoteResult.readings[1].status, 'unavailable');
  assert.equal(quoteResult.sample.digits, 0);
  assert.equal(quoteResult.readings[141].status, 'active');
});

test('empty, sparse and constant inputs are serializable and mark degenerate ratios unavailable', () => {
  for (const data of [[], [{ epoch: 60, digit: 7, quote: 100 }], Array.from({ length: 600 }, (_, i) => ({ epoch: 60 + i, digit: 7, quote: 100 }))]) {
    const result = report(data);
    assert.equal(result.readings.length, 300);
    assertFiniteTree(result);
    assert.equal(result.decision.eligible, false);
    for (const bin of result.research.bins.filter((entry) => entry.sample === 0)) {
      assert.equal(bin.predicted, null);
      assert.equal(bin.observed, null);
    }
    if (!data.length) {
      assert.ok(result.research.correlations.every((row) => row.every((value) => value === null)));
      assert.ok(result.readings[276].data.losses.every((value) => value === null));
      assert.ok(result.readings[285].data.ablations.every((value) => value === null));
    }
    if (data.length === 600) {
      assert.equal(result.readings[191].value, null, 'z-score is undefined at zero variance');
      assert.equal(result.readings[192].value, null, 'skewness is undefined at zero variance');
      assert.equal(result.readings[213].value, null, 'one-class runs test must abstain');
      assert.equal(result.readings[215].value, null, 'single-row transition independence must abstain');
      assert.equal(result.readings[114].value, null, 'doji wick/body ratio must not become infinity');
    }
  }
});

test('digit and parity probabilities use exact settlement semantics, including zero and barrier ties', () => {
  const p = Array(10).fill(0.1);
  for (let barrier = 0; barrier <= 9; barrier += 1) {
    const over = { family: 'over-under', contractType: 'DIGITOVER', barrier };
    const under = { family: 'over-under', contractType: 'DIGITUNDER', barrier };
    close(project(p, over), (9 - barrier) / 10);
    close(project(p, under), barrier / 10);
    assert.equal(eventWins(over, barrier), false);
    assert.equal(eventWins(under, barrier), false);
    close(project(p, over) + project(p, under) + p[barrier], 1);
  }
  assert.equal(eventWins(contract['even-odd'], 0), true);
  assert.equal(eventWins({ family: 'rise-fall', direction: 'RISE' }, 2), false);
  assert.equal(eventWins({ family: 'rise-fall', direction: 'FALL' }, 2), false);
  for (let digit = 0; digit < 10; digit += 1) close(project(p, { family: 'matches', contractType: 'DIGITMATCH', targetDigit: digit }), 0.1);
});

test('barrier diagnostic preserves equal-barrier mass and respects the selected barrier', () => {
  const data = Array.from({ length: 200 }, (_, i) => ({ epoch: i + 1, digit: i % 10 }));
  const r = readings(data, 'over-under', { ...contract['over-under'], barrier: 7 });
  assert.equal(r.get(86).value, 7);
  close(r.get(87).data.over, 0.2);
  close(r.get(87).data.under, 0.7);
  close(r.get(87).data.equal, 0.1);
  assert.equal(r.get(78).data.counts[2], 20);
  assert.equal(r.get(75).value, 0.5);
});

test('weighted/recency counts normalize and weight newer observations more', () => {
  const values = [...Array(100).fill(0), ...Array(100).fill(1)];
  for (const mode of [false, true]) {
    const p = weightedDistribution(values, 2, mode);
    close(p[0] + p[1], 1);
    assert.ok(p[1] > p[0]);
  }
  assert.deepEqual(distribution([], 2), [0.5, 0.5]);
});

test('unseen-digit gaps are censored and never converted into an automatic due-digit advantage', () => {
  const data = Array.from({ length: 200 }, (_, i) => ({ epoch: i + 1, digit: 7 }));
  const r = readings(data);
  assert.equal(r.get(39).data.gaps[0], -1);
  assert.match(r.get(33).detail, /unknown/);
  assert.equal(r.get(59).value, (200 + 2) / 220);
  assert.match(r.get(34).detail, /not due/);
});

test('transition rows and horizon-propagated distributions stay normalized', () => {
  const r = readings(ticks(4));
  for (const row of r.get(50).data.matrix) close(row.reduce((a, b) => a + b, 0), 1);
  close(r.get(51).data.probabilities.reduce((a, b) => a + b, 0), 1);
  close(r.get(52).data.probabilities.reduce((a, b) => a + b, 0), 1);
});

test('descriptive statistics match hand-computed moments and sample denominators', () => {
  const r = readings([1, 2, 3, 4].map((digit, i) => ({ digit, epoch: i + 1 })));
  close(r.get(184).value, 2.5);
  close(r.get(185).value, 2.5);
  close(r.get(187).value, Math.sqrt(5 / 3));
  close(r.get(188).value, 5 / 3);
  close(r.get(189).value, 3);
  close(r.get(193).value, 0);
  close(r.get(194).value, -1.36);
});

test('SMA-seeded EMA, Wilder RSI and MACD have expected flat/monotone outputs', () => {
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const increasing = Array.from({ length: 60 }, (_, i) => i + 1);
  assert.equal(rsi(increasing).at(-1), 100);
  assert.equal(rsi(increasing.slice().reverse()).at(-1), 0);
  assert.equal(rsi(Array(60).fill(100)).at(-1), 50);
  const flat = macd(Array(60).fill(100));
  close(flat.line.at(-1), 0); close(flat.histogram.at(-1), 0);
  assert.ok(macd(increasing).line.at(-1) > 0);
});

test('ATR includes gaps and requires a previous close; no fabricated candle history', () => {
  const bars = Array.from({ length: 15 }, (_, i) => ({ epoch: 60 * i, open: i + 1, high: i + 2, low: i, close: i + 1, ticks: 60 }));
  close(atr(bars), 2);
  assert.equal(atr(bars.slice(0, 14)), null);
  bars[14] = { ...bars[14], high: 30, low: 28, close: 29 };
  assert.ok(atr(bars) > 2);
});

test('candle builder excludes first partial and last open bucket, even after a large latest-tick shock', () => {
  const data = Array.from({ length: 190 }, (_, i) => ({ epoch: 10 + i, quote: 100 + i / 100 }));
  const bars = closedCandles(data);
  assert.deepEqual(bars.map((bar) => bar.epoch), [60, 120]);
  const changed = data.map((tick, index) => ({ ...tick, quote: index >= 170 ? 1e6 : tick.quote }));
  assert.deepEqual(closedCandles(changed), bars);
  assert.equal(closedCandles(data.slice(0, 20)).length, 0);
});

test('KPSS and correlation abstain on degenerate inputs and detect an obvious trend', () => {
  assert.equal(kpss(Array(100).fill(3)).statistic, null);
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), null);
  close(correlation([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(kpss(Array.from({ length: 200 }, (_, i) => i)).stationary, false);
});

test('normalization preserves sorted last-duplicate observations and does not invent precision', () => {
  const data = normalizeTicks([{ epoch: 3, quote: 100 }, { epoch: 1, digit: 0 }, { epoch: 3, quote: 101, digit: 8 }, { epoch: NaN, digit: 1 }, { epoch: 4, quote: -1, digit: 12 }]);
  assert.equal(data.length, 2);
  assert.equal(data[0].epoch, 1);
  assert.equal(data[1].quote, 101);
  assert.equal(data[0].quote, undefined);
});

test('direct-horizon forecasts are causal under arbitrary changes after the origin, for digits and quotes', () => {
  const data = ticks(8, 850);
  const origin = 500;
  const changed = data.map((tick, i) => i <= origin ? tick : { ...tick, digit: 0, quote: 50_000 + i });
  for (const kind of ['digit', 'quote']) for (const duration of [{ unit: 'ticks', value: 7 }, { unit: 'minutes', value: 1 }]) {
    const expected = forecastAt(data, kind, duration, origin);
    assert.deepEqual(forecastAt(changed, kind, duration, origin), expected);
    for (const p of expected) { close(p.reduce((a, b) => a + b, 0), 1); assert.ok(p.every((v) => v >= 0 && v <= 1)); }
  }
});

test('minute exits resolve observed timestamps rather than average tick cadence', () => {
  const epochs = [0, 5, 12, 61, 70, 123, 181];
  assert.deepEqual(horizonExits(epochs, { unit: 'minutes', value: 1 }), [3, 4, 5, 5, 6, -1, -1]);
  assert.deepEqual(horizonExits(epochs, { unit: 'ticks', value: 2 }), [2, 3, 4, 5, 6, -1, -1]);
  assert.throws(() => horizonExits(epochs, { unit: 'ticks', value: 0 }));
});

test('every replay target uses the actual terminal outcome and all split boundaries are purged', () => {
  const data = ticks(10);
  for (const kind of ['digit', 'quote']) for (const duration of [{ unit: 'ticks', value: 10 }, { unit: 'minutes', value: 1 }]) {
    const bank = buildForecastBank(data, kind, duration);
    const { calibrationStart, holdoutStart } = bank.boundaries;
    assert.ok(bank.tuning.every((row) => row.exit < calibrationStart));
    assert.ok(bank.calibration.every((row) => row.origin >= calibrationStart && row.exit < holdoutStart));
    assert.ok(bank.holdout.every((row) => row.origin >= holdoutStart));
    const rows = [...bank.tuning, ...bank.calibration, ...bank.holdout];
    rows.forEach((row, index) => {
      assert.ok(row.exit > row.origin);
      if (index) assert.ok(row.origin >= rows[index - 1].exit, 'outcome intervals must not overlap');
      const expected = kind === 'digit' ? data[row.exit].digit : data[row.exit].quote > data[row.origin].quote ? 0 : data[row.exit].quote < data[row.origin].quote ? 1 : 2;
      assert.equal(row.target, expected);
    });
  }
});

test('stratified replay does not phase-lock to a ten-digit periodic cycle', () => {
  const data = Array.from({ length: 2000 }, (_, i) => ({ epoch: i + 1, digit: i % 10 }));
  const bank = buildForecastBank(data, 'digit', horizon);
  assert.equal(new Set(bank.holdout.map((row) => row.origin % 10)).size, 10);
});

for (const kind of ['digit', 'quote']) test(`${kind} model weights, selection and calibration are unchanged by future holdout labels`, () => {
  const data = ticks(12);
  const first = buildForecastBank(data, kind, horizon);
  const changed = data.map((tick, i) => i < first.boundaries.holdoutStart ? tick : { ...tick, digit: 7, quote: 101 });
  const second = buildForecastBank(changed, kind, horizon);
  assert.deepEqual(second.tuning, first.tuning);
  assert.deepEqual(second.calibration, first.calibration);
  assert.deepEqual(second.baseline, first.baseline, 'quote flat mass must not come from holdout');
  const family = kind === 'digit' ? 'matches' : 'rise-fall';
  const a = auditForecastBank(first, contract[family], fair(family), 13);
  const b = auditForecastBank(second, contract[family], kind === 'quote' ? 0.01 : fair(family), 13);
  assert.deepEqual(a.weights, b.weights);
  assert.equal(a.selectedModel, b.selectedModel);
  assert.equal(a.calibrationMethod, b.calibrationMethod);
  assert.equal(a.fair, b.fair);
});

test('model budgets, Bayesian likelihood weights and signed contributions normalize', () => {
  const bank = buildForecastBank(ticks(4), 'digit', horizon);
  const audit = auditForecastBank(bank, contract.matches, 0.1, 130);
  close(audit.weights.reduce((a, b) => a + b, 0), 1);
  close(audit.models.reduce((a, model) => a + model.bayesianWeight, 0), 1);
  close(audit.models.reduce((a, model) => a + model.contribution, 0), 100 * (audit.rawProbability - audit.fair));
  const families = new Map();
  for (const model of audit.models) families.set(model.family, (families.get(model.family) ?? 0) + model.weight);
  for (const weight of families.values()) assert.ok(weight <= 0.40000001);
  for (const row of audit.correlations) assert.ok(row.every((v) => v >= -1 && v <= 1));
  assertFiniteTree(audit);
});

test('multi-market null scans do not validate spurious digit or quote edges', () => {
  let validated = 0;
  for (let seed = 1; seed <= 10; seed += 1) {
    const data = ticks(seed);
    for (const family of ['matches', 'even-odd', 'over-under', 'rise-fall']) {
      const bank = buildForecastBank(data, family === 'rise-fall' ? 'quote' : 'digit', horizon);
      const audit = auditForecastBank(bank, contract[family], fair(family), 13 * (family === 'matches' ? 10 : family === 'over-under' ? 16 : family === 'rise-fall' ? 25 : 2));
      if (audit.validated) validated += 1;
    }
  }
  assert.equal(validated, 0, 'null validation is conservative, not a claim of zero real-world false positives');
});

test('a materially biased digit stream can pass independent research validation', () => {
  const data = ticks(37, 2000, true);
  const audit = auditForecastBank(buildForecastBank(data, 'digit', horizon), contract.matches, 0.1, 130);
  assert.ok(audit.sample >= 40);
  assert.ok(audit.skill > 0.2);
  assert.ok(audit.probability > 0.45);
  assert.equal(audit.validated, true);
});

test('long minute horizons with thin independent history cannot self-validate', () => {
  const audit = auditForecastBank(buildForecastBank(ticks(11), 'quote', { unit: 'minutes', value: 15 }), contract['rise-fall'], 0.5, 325);
  assert.ok(audit.sample < 40);
  assert.equal(audit.validated, false);
  assert.equal(audit.calibrationMethod, 'identity');
});

test('unvalidated support never boosts confidence; validated contradiction shrinks edge and blocks automation', () => {
  const baseAudit = auditForecastBank(buildForecastBank(ticks(20), 'digit', horizon), contract.matches, 0.1);
  const input = { audit: { ...baseAudit, probability: 0.95, validated: false }, fresh: true, probability: 0.3, fair: 0.1, confirmed: true, independentSample: 100 };
  const allowed = decideResearch(input);
  assert.equal(allowed.edgeMultiplier, 1);
  assert.equal(allowed.confidencePenalty, 0);
  assert.equal(allowed.eligible, true, 'unvalidated research does not veto already confirmed independent base evidence');
  const contrary = decideResearch({ ...input, audit: { ...baseAudit, probability: 0.02, validated: true } });
  assert.equal(contrary.edgeMultiplier, 0.25);
  assert.equal(contrary.confidencePenalty, 10);
  assert.equal(contrary.eligible, false);
  for (const extra of [{ fresh: false }, { confirmed: false }, { independentSample: 5 }, { probability: 0.101 }, { probability: NaN }, { probability: 2 }, { fair: NaN }, { independentSample: NaN }]) assert.equal(decideResearch({ ...input, ...extra }).eligible, false);
});

test('actual settled P&L metrics use stakes and currency equity instead of fictitious 1:1 outcomes', () => {
  const trades = [{ epoch: 1, stake: 10, profit: 10 }, { epoch: 2, stake: 10, profit: -5 }, { epoch: 3, stake: 10, profit: -5 }, { epoch: 4, stake: 10, profit: 15 }];
  const stats = settledPerformance(trades);
  close(stats.expectancy, 0.375);
  close(stats.profitFactor, 2.5);
  close(stats.maxDrawdown, 10);
  close(stats.recoveryFactor, 1.5);
  close(stats.sortino, 0.375 / Math.sqrt(0.125));
  assert.equal(settledPerformance([]).sharpe, null);
  assert.equal(settledPerformance([{ epoch: 1, stake: 1, profit: 1 }]).profitFactor, null);
  const withPnl = report(ticks(19), 'matches', trades, 'USD');
  assert.equal(withPnl.readings[264].status, 'active');
  assert.deepEqual(withPnl.accounting, { sample: 4, currency: 'USD' });
  assert.match(withPnl.readings[264].detail, /scan time/);
  assert.equal(withPnl.readings[264].sample, 4);
  close(withPnl.readings[266].value, 10);
});

test('performance scope excludes other markets, families, currencies, invalid prices and duplicate contracts', () => {
  const base = { contractId: 1, symbol: 'R_100', contractType: 'DIGITMATCH', currency: 'USD', buyPrice: 1, profit: 0.5, sellTime: 10 };
  const scoped = scopeSettlements([base, base, { ...base, contractId: 2, symbol: 'R_50' }, { ...base, contractId: 3, contractType: 'CALL' }, { ...base, contractId: 4, currency: 'EUR' }, { ...base, contractId: 5, buyPrice: 0 }, { ...base, contractId: 6, sellTime: null }, { ...base, contractId: NaN }, { ...base, contractId: 7, sellTime: -1 }], 'R_100', 'matches', 'USD');
  assert.deepEqual(scoped, [{ epoch: 10, stake: 1, profit: 0.5 }]);
  assert.deepEqual(scopeSettlements([base], 'R_100', 'matches', ''), []);
});

test('research advice is reported but never blocks a purchase, and payout economics stay measurable', () => {
  assert.ok(researchAdvisory(null));
  assert.ok(researchAdvisory({ eligible: false, action: 'observe', reasons: ['Live data freshness is not confirmed.'] }));
  assert.equal(researchAdvisory({ eligible: true, action: 'candidate', reasons: ['Evidence gates passed; compare the live proposal payout with the estimated probability before any purchase.'] }), null);
  const good = quoteEconomics(0.6, 1, 1.9);
  assert.equal(good.allowed, true);
  close(good.breakEven, 1 / 1.9);
  close(good.expectedNet, 0.14);
  assert.equal(quoteEconomics(0.5, 1, 1.9).allowed, false);
  assert.equal(quoteEconomics(0.9, 1, null).allowed, false);
  assert.equal(quoteEconomics(NaN, 1, 2).allowed, false);
  assert.equal(quoteEconomics(0.99, 1, 0.9).allowed, false);
  assert.equal(quoteEconomics(0.501, 1, 2).allowed, false, 'requires the explicit 0.5-point margin');
});

for (const family of ['matches', 'even-odd', 'over-under']) test(`${family} production scan runs the library and preserves signal/entry audit consistency`, () => {
  const data = ticks(41);
  const result = analyzeDigitMarket({ family, symbol: 'R_100', name: 'Volatility 100', horizon: 2,
    ticks: data.map(({ epoch, digit }) => ({ epoch, digit })), quoteTicks: data.map(({ epoch, quote }) => ({ epoch, quote })), fresh: true, marketsInScan: 13 });
  assert.equal(result.engineLab.registered, 300);
  assert.equal(result.engineCount, 12, 'catalog entries are not dishonest extra predictor votes');
  assert.deepEqual(result.engineLab.contract, result.best.contract);
  assert.deepEqual(result.best.researchDecision, result.engineLab.decision);
  close(result.best.entry.evidence.signalProbability, result.best.probability);
  close(result.best.deep.confirmation.probability, result.best.probability);
  assert.ok(result.engineLab.sample.quotes > 0);
  assert.equal(result.best.researchDecision.action, 'observe');
  assert.deepEqual(result.engineLab.fusion, result.best.research);
  assert.ok(result.best.research.total >= 10, 'every contract carries the research ensemble into the analysis');
  assert.ok(Math.abs(result.best.research.contributionPts) <= 35);
  assert.ok(result.best.research.weight <= 0.35);
  assertFiniteTree(result.engineLab);
});

test('Rise/Fall production scan runs all 300 entries on the selected exact duration', () => {
  const data = ticks(42);
  const result = analyzeRiseFallMarket({ symbol: 'R_100', name: 'Volatility 100', ticks: data, digitTicks: data, fresh: true, marketsInScan: 13,
    horizons: [{ unit: 'ticks', value: 1 }, { unit: 'ticks', value: 10 }, { unit: 'minutes', value: 3 }] });
  assert.equal(result.engineLab.registered, 300);
  // 13 state engines (level-reversion included) + drift + the AI meta-model.
  assert.equal(result.engineCount, RISE_FALL_ENGINES.length);
  assert.equal(result.engineCount, 15);
  assert.deepEqual(result.engineLab.horizon, result.best.horizon);
  assert.equal(result.engineLab.contract.direction, result.best.direction);
  close(result.best.entry.evidence.signalProbability, result.best.winEstimate);
  assert.equal(result.engineLab.sample.digits, data.length);
  assert.equal(result.best.researchDecision.action, 'observe');
  assert.deepEqual(result.engineLab.fusion, result.best.research);
  assert.ok(result.best.research.total >= 12);
  assertFiniteTree(result.engineLab);
});

const baseAudit = (overrides = {}) => ({
  probability: 0.30, rawProbability: 0.30, nextTickProbability: 0.30, fair: 0.1,
  sample: 200, tuningSample: 300, calibrationSample: 150, brier: 0.06, baselineBrier: 0.09, skill: 0.33,
  improvementZ: 3, correctedP: 0.001, validated: true, calibrationMethod: 'isotonic-shrinkage', calibrationError: 0.01,
  bins: [], weights: [0.5, 0.5], correlations: [[1, 0.2], [0.2, 1]], redundantPairs: [],
  models: [
    { id: 'a', name: 'A', family: 'frequency', engines: [1], probability: 0.32, weight: 0.5, bayesianWeight: 0.5, tuningBrier: 0.08, holdoutBrier: 0.08, skill: 0.2, contribution: 1, ablation: 0.01 },
    { id: 'b', name: 'B', family: 'dependence', engines: [2], probability: 0.28, weight: 0.5, bayesianWeight: 0.5, tuningBrier: 0.08, holdoutBrier: 0.08, skill: 0.2, contribution: 1, ablation: 0.01 },
  ],
  rows: [], boundaries: { tuningStart: 600, calibrationStart: 1100, holdoutStart: 1500, lastOrigin: 1999 },
  selectedModel: 'a', regimeModel: 'a', regimeSample: 120, selectionPool: 130,
  ...overrides,
});

test('the research library is folded into the traded estimate when it validated out of sample', () => {
  const supportive = fuseResearch({ audit: baseAudit(), probability: 0.2, fair: 0.1 });
  assert.ok(supportive.fusion.weight > 0 && supportive.fusion.weight <= 0.35);
  assert.ok(supportive.probability > 0.2, `${supportive.probability} should exceed the base estimate`);
  assert.ok(supportive.probability <= 0.30 + 1e-12, 'a convex blend can never exceed either estimate');
  close(supportive.fusion.contributionPts, 100 * (supportive.probability - 0.2));
  assert.equal(supportive.fusion.validated, true);
  assert.equal(supportive.fusion.agreeing, 2);
  assert.equal(researchEvidence(supportive.fusion).validated, true);
  assert.equal(researchEvidence(supportive.fusion).contradicted, false);
});

test('unvalidated research can pull an estimate down but never inflate it', () => {
  const unvalidated = baseAudit({ validated: false, probability: 0.05 });
  const lowered = fuseResearch({ audit: unvalidated, probability: 0.2, fair: 0.1 });
  assert.ok(lowered.probability < 0.2);
  assert.ok(lowered.probability >= 0.05 - 1e-12);
  assert.ok(lowered.fusion.weight > 0 && lowered.fusion.weight <= 0.15);
  assert.equal(lowered.fusion.stance, 'contradicting');
  assert.equal(researchEvidence(lowered.fusion).contradicted, true);
  // Higher than the base estimate, but unvalidated: no boost is allowed.
  const flattering = fuseResearch({ audit: baseAudit({ validated: false, probability: 0.4 }), probability: 0.2, fair: 0.1 });
  assert.equal(flattering.probability, 0.2);
  assert.equal(flattering.fusion.weight, 0);
  // A small difference inside the dead band is not a signal either way.
  const noise = fuseResearch({ audit: baseAudit({ validated: false, probability: 0.195 }), probability: 0.2, fair: 0.1 });
  assert.equal(noise.probability, 0.2);
});

test('an unusable research audit leaves the analysis estimate untouched', () => {
  for (const audit of [undefined, null, {}, { ...baseAudit(), probability: Number.NaN }, { ...baseAudit(), models: [] }]) {
    const result = fuseResearch({ audit, probability: 0.2, fair: 0.1 });
    assert.equal(result.probability, 0.2);
    assert.equal(result.fusion.weight, 0);
    assert.equal(result.fusion.contributionPts, 0);
  }
  assertFiniteTree(fuseResearch({ audit: baseAudit(), probability: 0.2, fair: 0.1 }));
});

test('the research term moves the evidence score only through measured, validated skill', () => {
  const base = { weightedAgreement: 0.8, edgeRatio: 0.4, backtest: null, validationSkill: 0.1, dataQuality: 1, selectionPool: 208 };
  const without = confidenceScore(base).confidence;
  assert.equal(confidenceScore({ ...base, research: null }).confidence, without, 'absent research keeps the score bit-identical');
  assert.equal(confidenceScore({ ...base, research: researchEvidence(fuseResearch({ audit: baseAudit({ validated: false, probability: 0.05 }), probability: 0.2, fair: 0.1 }).fusion) }).confidence, without, 'unvalidated agreement cannot add confidence');
  const supported = confidenceScore({ ...base, research: researchEvidence(fuseResearch({ audit: baseAudit(), probability: 0.2, fair: 0.1 }).fusion) });
  assert.ok(supported.confidence >= without, 'validated, agreeing research does not reduce the score');
  assert.ok(supported.breakdown.research > 0);
  const opposed = confidenceScore({ ...base, research: { agreement: 0, skill: 0.3, sample: 200, validated: true, contradicted: true } });
  assert.ok(opposed.confidence < without, 'a validated contradiction costs evidence');
  assert.ok(opposed.confidence >= 1 && opposed.confidence <= 99);
});

test('multi-market null scans do not let research manufacture an edge', () => {
  let boosted = 0;
  for (let seed = 80; seed <= 89; seed += 1) {
    const data = ticks(seed);
    const result = analyzeDigitMarket({ family: 'matches', symbol: 'R_100', name: 'Volatility 100', horizon: 2,
      ticks: data.map(({ epoch, digit }) => ({ epoch, digit })), fresh: true, marketsInScan: 13 });
    for (const signal of result.contracts) if (signal.research.contributionPts > 0.01) boosted += 1;
  }
  assert.equal(boosted, 0, 'noise never validates, so the fusion can only leave the estimate alone or lower it');
});
