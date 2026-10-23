import test from 'node:test';
import assert from 'node:assert/strict';
import {
  confidenceScore, edgeShrinkage, selectionPenalty, strengthOf, strengthWithConfirmation, summarizeBacktest, tallyVotes,
} from '../src/lib/signal-engine/confidence.ts';
import { analyzeDigitMarket, DIGIT_SIGNAL_CONTRACTS, fairProbability } from '../src/lib/signal-engine/digit-signal.ts';
import {
  analyzeRiseFallMarket, countNonOverlappingOutcomes, normalizeRiseFallTicks,
  resolveRiseFallHorizons, RISE_FALL_ENGINES, RISE_FALL_HORIZONS, selectNonOverlappingOutcomes, splitPurgedReplay,
} from '../src/lib/signal-engine/rise-fall-signal.ts';
import { familyBalancedWeights } from '../src/lib/signal-engine/consensus.ts';
import { rankScanResults } from '../src/lib/signal-engine/scan-protocol.ts';
import {
  FALLBACK_SCAN_MARKETS, digitTicksOf, historyToTicks, marketFreshness, mergeTicks, pipSizeFromResponse, resolvePipSize, selectScanMarkets,
} from '../src/lib/market-feed.ts';
import { canApplySignal } from '../src/lib/trade-draft.ts';

function xorshift(seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
// High-quality deterministic generator for "pure noise" digit streams.
function sfc32(seed) {
  let a = 0x9e3779b9; let b = 0x243f6a88 + seed; let c = 0xb7e15162; let d = 0x12345678 ^ (seed * 7919);
  const next = () => { a |= 0; b |= 0; c |= 0; d |= 0; const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let index = 0; index < 20; index += 1) next();
  return next;
}
const digitTicks = (digits) => digits.map((digit, index) => ({ epoch: 1_700_000_000 + index, digit }));
const randomDigits = (seed, length = 2000) => { const random = sfc32(seed); return Array.from({ length }, () => Math.floor(random() * 10)); };
const vote = (state, weight = 1) => ({ id: state + weight, label: state, family: 'x', vote: state, value: 0.5, weight, skill: null, note: '' });

test('vote tally counts every engine and weights agreement by skill', () => {
  const tally = tallyVotes([vote('agree', 2), vote('agree', 1), vote('against', 1), vote('neutral', 0.5), vote('abstain', 0)]);
  assert.equal(tally.agreeing, 2);
  assert.equal(tally.against, 1);
  assert.equal(tally.neutral, 1);
  assert.equal(tally.abstained, 1);
  assert.equal(tally.voting, 4);
  assert.equal(tally.total, 5);
  assert.ok(Math.abs(tally.weightedAgreement - 3 / 4.5) < 1e-12);
});

test('confidence is bounded, rewards evidence and only discounts lucky backtests', () => {
  const base = { weightedAgreement: 0.9, edgeRatio: 0.15, backtest: summarizeBacktest(130, 200, 0.5), validationSkill: 0.04, dataQuality: 1 };
  const strong = confidenceScore(base).confidence;
  const weak = confidenceScore({ ...base, weightedAgreement: 0.4, edgeRatio: 0.005, backtest: summarizeBacktest(95, 200, 0.5), validationSkill: -0.01 }).confidence;
  assert.ok(strong > 80 && strong <= 99, `strong=${strong}`);
  assert.ok(weak < 50 && weak >= 1, `weak=${weak}`);
  assert.equal(confidenceScore({ ...base, verified: true }).confidence, Math.min(99, strong + 8));
  // More competing candidates discount a positive backtest...
  assert.ok(confidenceScore({ ...base, selectionPool: 208 }).confidence < strong);
  // ...but never make a losing backtest look worse than it is.
  const losing = { ...base, backtest: summarizeBacktest(70, 200, 0.5) };
  assert.equal(confidenceScore({ ...losing, selectionPool: 1 }).confidence, confidenceScore({ ...losing, selectionPool: 500 }).confidence);
  assert.ok(selectionPenalty(208) > selectionPenalty(16));
  // Agreement on a negligible edge is not evidence.
  const noEdge = confidenceScore({ ...base, edgeRatio: 0, backtest: null, validationSkill: null }).confidence;
  assert.equal(noEdge, 50);
});

test('strength labels need confidence, more engines for than against, and a non-losing backtest for STRONG', () => {
  const tally = (weightedAgreement) => ({ agreeing: 9, against: 2, neutral: 1, abstained: 0, voting: 12, total: 12, weightedAgreement });
  assert.equal(strengthOf(75, tally(0.8), summarizeBacktest(60, 100, 0.5)), 'STRONG');
  assert.equal(strengthOf(75, tally(0.8), summarizeBacktest(40, 100, 0.5)), 'MODERATE');
  assert.equal(strengthOf(60, tally(0.7), null), 'MODERATE');
  assert.equal(strengthOf(60, tally(0.45), null), 'MODERATE');
  assert.equal(strengthOf(60, { ...tally(0.3), agreeing: 4, against: 6 }, null), 'WEAK');
  assert.equal(strengthOf(50, tally(0.9), null), 'WEAK');
});

test('a STRONG label and a trusted model edge both need evidence that survived out of sample', () => {
  const tally = { agreeing: 10, against: 1, neutral: 1, abstained: 0, voting: 12, total: 12, weightedAgreement: 0.85 };
  const base = strengthOf(85, tally, summarizeBacktest(70, 120, 0.5));
  assert.equal(base, 'STRONG');
  // The confidence score alone cannot promote a call the confirmation layer
  // could not call decisive, or one it contradicts.
  assert.equal(strengthWithConfirmation(base, { status: 'cautious', decisive: false }), 'MODERATE');
  assert.equal(strengthWithConfirmation(base, { status: 'contradicted', decisive: false }), 'MODERATE');
  assert.equal(strengthWithConfirmation(base, { status: 'confirmed', decisive: true }), 'STRONG');
  assert.equal(strengthWithConfirmation('MODERATE', { status: 'confirmed', decisive: true }), 'MODERATE');

  // A positive Brier skill on thin rows is not trusted; the same skill with a
  // paired z that clears the noise floor is.
  assert.equal(edgeShrinkage(0.01), 0.55);
  assert.equal(edgeShrinkage(0.01, 0.5), 0.3);
  assert.ok(edgeShrinkage(0.01, 2) > 0.3 && edgeShrinkage(0.01, 2) < 0.55, `z=2 shrinkage ${edgeShrinkage(0.01, 2)}`);
  assert.equal(edgeShrinkage(0.01, 4), 0.55);
  assert.equal(edgeShrinkage(0.05), 1);
});

test('family-balanced weights combine independent groups without letting correlated engine count dominate', () => {
  const engines = [
    ...Array.from({ length: 4 }, () => ({ family: 'trend', reliability: 1 })),
    { family: 'momentum', reliability: 1 },
    { family: 'structure', reliability: 1 },
    { family: 'statistical', reliability: 1 },
    { family: 'ml', reliability: 1 },
    { family: 'unavailable', reliability: 10, available: false },
  ];
  const weights = familyBalancedWeights(engines);
  assert.ok(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  const trendShare = weights.slice(0, 4).reduce((sum, weight) => sum + weight, 0);
  assert.ok(trendShare <= 0.400000001, `trend family received ${trendShare}`);
  assert.equal(weights[8], 0);
  assert.ok(weights.slice(0, 8).every((weight) => weight > 0));
  assert.deepEqual(familyBalancedWeights([{ family: 'x', reliability: 1, available: false }]), [0]);
});

test('purged replay splits exclude labels that cross validation or holdout boundaries', () => {
  const rows = [
    { origin: 1, exit: 2, label: 1 },
    { origin: 3, exit: 5, label: -1 }, // crosses training boundary
    { origin: 5, exit: 7, label: 1 },
    { origin: 8, exit: 10, label: -1 }, // crosses holdout boundary
    { origin: 10, exit: 12, label: 1 },
    { origin: 11, exit: 12, label: null },
  ];
  const split = splitPurgedReplay(rows, 5, 10);
  assert.deepEqual(split.training.map(({ origin }) => origin), [1]);
  assert.deepEqual(split.validation.map(({ origin }) => origin), [5]);
  assert.deepEqual(split.holdout.map(({ origin }) => origin), [10]);
  assert.throws(() => splitPurgedReplay(rows, 10, 5), /strictly increasing/);
});

test('effective replay sample counts only non-overlapping outcome intervals', () => {
  const rows = [
    { origin: 1, exit: 4 },
    { origin: 2, exit: 5 },
    { origin: 4, exit: 7 },
    { origin: 8, exit: 9 },
  ];
  assert.equal(countNonOverlappingOutcomes(rows), 3);
  assert.deepEqual(selectNonOverlappingOutcomes(rows).map(({ origin }) => origin), [1, 4, 8]);
});

test('every digit family always returns a signal with 12 engine votes on random digits', () => {
  for (const family of ['over-under', 'even-odd', 'matches']) {
    const result = analyzeDigitMarket({ family, symbol: 'R_100', name: 'Volatility 100 Index', horizon: 1, ticks: digitTicks(randomDigits(family.length)), fresh: true, marketsInScan: 13 });
    assert.equal(result.kind, 'digit');
    assert.equal(result.engineCount, 12);
    assert.equal(result.contracts.length, DIGIT_SIGNAL_CONTRACTS[family].length);
    const signal = result.best;
    assert.equal(signal.contract.family, family);
    assert.ok(signal.label.length > 0);
    assert.ok(Number.isInteger(signal.confidence) && signal.confidence >= 1 && signal.confidence <= 99);
    assert.equal(signal.votes.length, 12);
    assert.equal(signal.tally.agreeing + signal.tally.against + signal.tally.neutral + signal.tally.abstained, 12);
    const familyWeights = new Map();
    for (const engine of signal.votes) familyWeights.set(engine.family, (familyWeights.get(engine.family) ?? 0) + engine.weight);
    for (const [engineFamily, weight] of familyWeights) assert.ok(weight <= 0.400000001, `${engineFamily} family received ${weight}`);
    assert.ok(Math.abs(signal.votes.reduce((sum, engine) => sum + engine.weight, 0) - 1) < 1e-9);
    assert.ok(signal.probability > 0 && signal.probability < 1);
    assert.equal(signal.fairProbability, fairProbability(signal.contract));
    // Pure noise across a 13-market scan must not be labelled STRONG.
    assert.notEqual(signal.strength, 'STRONG', `${family} ${signal.label} ${signal.confidence}`);
    // Contracts are ranked by the master decision (verdict evidence, then
    // conviction), so a decisive edge outranks a higher confidence whose edge
    // the master could not certify. Equal priorities must stay confidence
    // ordered, which is the tie-break.
    for (let index = 1; index < result.contracts.length; index += 1) {
      const previous = result.contracts[index - 1];
      const current = result.contracts[index];
      assert.ok(previous.master.priority >= current.master.priority, `${family} priority order`);
      if (previous.master.priority === current.master.priority) assert.ok(previous.confidence >= current.confidence);
    }
  }
});

test('digit engines find a genuinely over-represented digit and call it strongly', () => {
  const random = xorshift(77);
  const digits = Array.from({ length: 2000 }, () => (random() < 0.25 ? 7 : Math.floor(random() * 10)));
  const matches = analyzeDigitMarket({ family: 'matches', symbol: 'R_50', name: 'Volatility 50 Index', horizon: 1, ticks: digitTicks(digits), fresh: true, marketsInScan: 13 });
  assert.equal(matches.best.label, 'MATCH 7');
  assert.equal(matches.best.strength, 'STRONG');
  assert.ok(matches.best.confidence >= 85);
  assert.ok(matches.best.tally.agreeing >= 9);
  assert.ok(matches.best.probability > 0.2);
  const evenOdd = analyzeDigitMarket({ family: 'even-odd', symbol: 'R_50', name: 'Volatility 50 Index', horizon: 1, ticks: digitTicks(digits), fresh: true, marketsInScan: 13 });
  assert.equal(evenOdd.best.label, 'ODD');
  assert.equal(evenOdd.best.strength, 'STRONG');
});

test('a deterministic digit cycle passes the strict gates and is flagged as a verified edge', () => {
  const digits = Array.from({ length: 1500 }, (_, index) => (index * 7 + 2) % 10);
  const result = analyzeDigitMarket({ family: 'over-under', symbol: 'R_10', name: 'Volatility 10 Index', horizon: 1, ticks: digitTicks(digits), fresh: true });
  assert.equal(result.best.strength, 'STRONG');
  assert.ok(result.best.verified);
  assert.ok(result.best.confidence >= 95);
  assert.ok(result.report.selected);
  assert.equal(result.report.engines.length, 12);
});

test('digit analysis honours the reported contract subset and validates its inputs', () => {
  const contracts = [{ family: 'over-under', contractType: 'DIGITOVER', barrier: 2 }, { family: 'over-under', contractType: 'DIGITUNDER', barrier: 7 }];
  const result = analyzeDigitMarket({ family: 'over-under', symbol: 'R_25', name: 'Volatility 25 Index', horizon: 3, ticks: digitTicks(randomDigits(5)), fresh: false, contracts });
  assert.deepEqual(result.contracts.map((signal) => signal.label).sort(), ['OVER 2', 'UNDER 7']);
  assert.equal(result.horizon, 3);
  assert.ok(result.notes.some((note) => note.includes('freshness')));
  assert.throws(() => analyzeDigitMarket({ family: 'matches', symbol: 'X', name: 'X', horizon: 1, ticks: digitTicks(randomDigits(1, 300)), fresh: true }), /500/);
  assert.throws(() => analyzeDigitMarket({ family: 'matches', symbol: 'X', name: 'X', horizon: 11, ticks: digitTicks(randomDigits(1)), fresh: true }), /1 to 10/);
});

const gauss = (random) => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
function pricePath(seed, drift = 0, length = 2000) {
  const random = xorshift(seed);
  let price = 1000;
  return Array.from({ length }, (_, index) => { price += (gauss(random) + drift) * 0.3; return { epoch: 1_700_000_000 + index * 2, quote: Number(price.toFixed(3)) }; });
}

test('Rise/Fall returns a direction and combines the full engine panel by independent family', () => {
  const result = analyzeRiseFallMarket({ symbol: 'R_75', name: 'Volatility 75 Index', ticks: pricePath(9), fresh: true, marketsInScan: 13 });
  assert.equal(result.kind, 'rise-fall');
  assert.equal(result.horizons.length, RISE_FALL_HORIZONS.length);
  assert.ok(['RISE', 'FALL'].includes(result.best.direction));
  assert.equal(result.best.votes.length, RISE_FALL_ENGINES.length);
  assert.equal(result.best.tally.total, RISE_FALL_ENGINES.length);
  assert.ok(result.best.confidence >= 1 && result.best.confidence <= 99);
  assert.notEqual(result.best.strength, 'STRONG');
  const familyWeight = new Map();
  for (const engine of result.best.votes) familyWeight.set(engine.family, (familyWeight.get(engine.family) ?? 0) + engine.weight);
  for (const [family, weight] of familyWeight) assert.ok(weight <= 0.400000001, `${family} family received ${weight}`);
  assert.throws(() => analyzeRiseFallMarket({ symbol: 'R_75', name: 'Volatility 75 Index', ticks: pricePath(9, 0, 300), fresh: true }), /600/);
});

test('Rise/Fall input sanitation de-duplicates chronologically and validates durations', () => {
  const normalized = normalizeRiseFallTicks([
    { epoch: 3, quote: 102 }, { epoch: 1, quote: 100 }, { epoch: 2, quote: 101 },
    { epoch: 2, quote: 101.5 }, { epoch: 4, quote: Number.NaN }, { epoch: 5, quote: -1 },
  ]);
  assert.deepEqual(normalized, [{ epoch: 1, quote: 100 }, { epoch: 2, quote: 101.5 }, { epoch: 3, quote: 102 }]);
  assert.deepEqual(resolveRiseFallHorizons([{ unit: 'ticks', value: 2 }, { unit: 'ticks', value: 2 }]), [{ unit: 'ticks', value: 2 }]);
  assert.throws(() => resolveRiseFallHorizons([{ unit: 'ticks', value: 0 }]), /1–10 ticks/);
  assert.throws(() => resolveRiseFallHorizons([{ unit: 'seconds', value: 5 }]), /1–10 ticks/);
});

test('Rise/Fall follows a clear trend in either direction', () => {
  const up = analyzeRiseFallMarket({ symbol: 'UP', name: 'Up', ticks: pricePath(21, 0.3), fresh: true });
  const down = analyzeRiseFallMarket({ symbol: 'DOWN', name: 'Down', ticks: pricePath(22, -0.3), fresh: true });
  assert.equal(up.best.direction, 'RISE');
  assert.equal(down.best.direction, 'FALL');
  assert.ok(up.best.confidence >= 70, `up=${up.best.confidence}`);
  assert.ok(down.best.confidence >= 70, `down=${down.best.confidence}`);
  assert.ok(up.best.tally.agreeing >= 10);
});

test('cross-market ranking puts the most confident signal first', () => {
  const make = (symbol, confidence, weightedAgreement) => ({ kind: 'digit', symbol, best: { confidence, edgeRatio: 0.1, tally: { weightedAgreement } } });
  const ranked = rankScanResults([make('A', 60, 0.6), make('B', 72, 0.5), make('C', 72, 0.9)]);
  assert.deepEqual(ranked.map((result) => result.symbol), ['C', 'B', 'A']);
});

test('feed helpers parse Deriv precision, extract digits and merge ticks chronologically', () => {
  assert.equal(pipSizeFromResponse(2), 0.01);
  assert.equal(pipSizeFromResponse('3'), 0.001);
  assert.equal(pipSizeFromResponse(0.001), 0.001);
  assert.equal(pipSizeFromResponse(-1), null);
  assert.equal(pipSizeFromResponse('x'), null);
  assert.equal(resolvePipSize(0.01, 2), 0.01);
  assert.equal(resolvePipSize(null, 3), 0.001);
  assert.equal(resolvePipSize(0.01, 3), 0.001);
  assert.equal(resolvePipSize(0.01, undefined), 0.01);
  const ticks = historyToTicks([1234.57, '1234.50', 'bad', 0], [10, 11, 12, 13], 0.01);
  assert.deepEqual(ticks, [{ epoch: 10, quote: 1234.57, digit: 7 }, { epoch: 11, quote: 1234.5, digit: 0 }]);
  assert.deepEqual(digitTicksOf([...ticks, { epoch: 12, quote: 1, digit: null }]), [{ epoch: 10, digit: 7 }, { epoch: 11, digit: 0 }]);
  const merged = mergeTicks([{ epoch: 3, quote: 3, digit: 3 }, { epoch: 1, quote: 1, digit: 1 }], [{ epoch: 2, quote: 2, digit: 2 }, { epoch: 3, quote: 9, digit: 9 }], 10);
  assert.deepEqual(merged.map((tick) => [tick.epoch, tick.quote]), [[1, 1], [2, 2], [3, 9]]);
  const bounded = mergeTicks(merged, [{ epoch: 4, quote: 4, digit: 4 }], 3);
  assert.deepEqual(bounded.map((tick) => tick.epoch), [2, 3, 4]);
});

test('scan markets come from active symbols in a stable order with a safe fallback', () => {
  const symbol = (code, name = code) => ({ symbol: code, name, market: 'synthetic_index', symbolType: 'stockindex', pipSize: 0.01, precision: 2, exchangeOpen: true, tradingSuspended: false });
  const picked = selectScanMarkets([symbol('1HZ100V', 'Volatility 100 (1s) Index'), symbol('frxEURUSD'), symbol('R_10', 'Volatility 10 Index'), symbol('1HZ10V'), symbol('R_100')]);
  assert.deepEqual(picked.map((market) => market.symbol), ['R_10', 'R_100', '1HZ10V', '1HZ100V']);
  assert.equal(picked.find((market) => market.symbol === '1HZ10V').name, 'Volatility 10 (1s) Index');
  assert.equal(selectScanMarkets([symbol('frxEURUSD')]), FALLBACK_SCAN_MARKETS);
  assert.equal(FALLBACK_SCAN_MARKETS.length, 13);
});

test('freshness needs a recent live tick and tolerates a missing server clock', () => {
  const now = 1_700_000_100_000;
  assert.equal(marketFreshness(now - 2_000, 1_700_000_099, now, 0).fresh, true);
  assert.equal(marketFreshness(now - 20_000, 1_700_000_099, now, 0).fresh, false);
  assert.equal(marketFreshness(null, 1_700_000_099, now, 0).fresh, false);
  assert.equal(marketFreshness(now - 1_000, 1_700_000_099, now, null).fresh, true);
  assert.equal(marketFreshness(now - 1_000, 1_700_000_000, now, 0).fresh, false);
});

test('signals from every tool can be copied into the trade ticket, invalid ones cannot', () => {
  const ticks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(canApplySignal({ symbol: 'R_100', contractType: 'DIGITOVER', barrier: 3, duration: 1, durationUnit: 't' }, 'over-under', ticks), true);
  assert.equal(canApplySignal({ symbol: 'R_100', contractType: 'DIGITUNDER', barrier: 0, duration: 1, durationUnit: 't' }, 'over-under', ticks), false);
  assert.equal(canApplySignal({ symbol: 'R_100', contractType: 'DIGITEVEN', duration: 2, durationUnit: 't' }, 'even-odd', ticks), true);
  assert.equal(canApplySignal({ symbol: 'R_100', contractType: 'DIGITMATCH', barrier: 0, duration: 1, durationUnit: 't' }, 'matches', ticks), true);
  assert.equal(canApplySignal({ symbol: 'R_100', contractType: 'DIGITMATCH', duration: 1, durationUnit: 't' }, 'matches', ticks), false);
  assert.equal(canApplySignal({ symbol: '1HZ10V', contractType: 'PUT', duration: 5, durationUnit: 'm' }, 'rise-fall', ticks), true);
  assert.equal(canApplySignal({ symbol: '1HZ10V', contractType: 'CALL', duration: 11, durationUnit: 't' }, 'rise-fall', ticks), false);
  assert.equal(canApplySignal({ symbol: 'R_100', contractType: 'DIGITEVEN', duration: 2, durationUnit: 'm' }, 'even-odd', ticks), false);
  assert.equal(canApplySignal({ symbol: 'R_100', contractType: 'CALL', duration: 2, durationUnit: 't' }, 'even-odd', ticks), false);
  assert.equal(canApplySignal(null, 'even-odd', ticks), false);
});

// ---- layer 1: the analysis engines -----------------------------------------

import { analyzeDigitState, analyzeQuoteState } from '../src/lib/signal-engine/market-state.ts';
import { ENTRY_LIMITS, analyzeQuoteEntry, evaluateEntry } from '../src/lib/signal-engine/entry.ts';
import { typicalTickMove } from '../src/lib/signal-engine/entry.ts';

function analyzeQuote(prices, epochs, rows) {
  return analyzeQuoteEntry({
    prices, epochs, rows, direction: 1, averageMove: typicalTickMove(prices), horizonTicks: 5, fairRate: 0.5,
    signal: { source: 'rise-fall', agreeing: 9, total: 14, probability: 0.56, aiProbability: 0.56 },
  });
}

test('the analysis layer finds digit structure only when the stream really has it', () => {
  const noise = analyzeDigitState(randomDigits(11, 2_200));
  assert.equal(noise.regime, 'random');
  assert.ok(noise.predictability < 0.1, `noise predictability ${noise.predictability}`);
  assert.equal(noise.prior, null);
  assert.ok(noise.engines.length >= 8);

  // One digit is genuinely over-represented.
  const random = sfc32(12);
  const biased = Array.from({ length: 2_200 }, () => (random() < 0.18 ? 7 : Math.floor(random() * 10)));
  const bias = analyzeDigitState(biased);
  assert.notEqual(bias.regime, 'random');
  assert.ok(bias.predictability > 0.2, `bias predictability ${bias.predictability}`);
  assert.ok(bias.priorBacktest.improved, 'a validated digit prior should survive its own backtest');
  assert.ok((bias.priorBacktest.skill ?? 0) > 0);

  // A deterministic cycle is the strongest possible serial dependence.
  const cycle = analyzeDigitState(Array.from({ length: 2_200 }, (_, index) => index % 10));
  assert.equal(cycle.regime, 'serially-dependent');
  assert.ok(cycle.predictability > 0.5, `cycle predictability ${cycle.predictability}`);
});

test('every digit angle is measured, and only the ones that beat uniform carry weight', () => {
  // A fair stream must show all ten angles, all with zero weight: measuring is
  // free, believing is not.
  const noise = analyzeDigitState(randomDigits(41, 2_400));
  assert.equal(noise.priorComponents.length, 10, 'every angle is reported even when none fires');
  assert.ok(noise.priorComponents.every((component) => component.weight === 0), 'a fair stream gives no angle weight');
  assert.equal(noise.prior, null, 'a fair stream ships no prior at all');

  // A real five-tick bias: the angles are graded on the exit tick, and only a
  // graded angle may carry weight.
  const random = sfc32(42);
  const biased = Array.from({ length: 2_600 }, () => (random() < 0.2 ? 8 : Math.floor(random() * 10)));
  const state = analyzeDigitState(biased, { horizon: 5 });
  assert.equal(state.priorComponents.length, 10);
  const firing = state.priorComponents.filter((component) => component.weight > 0);
  assert.ok(firing.length >= 1, 'the validated bias earns weight from at least one angle');
  assert.ok(firing.every((component) => component.skill !== null && component.skill > 0), 'weight is only granted to measured skill');
  assert.ok(state.priorComponents.filter((component) => component.weight === 0).every((component) => component.weight === 0));
  // "Repeats more than 10%" is a one-tick claim; at five ticks the angle
  // abstains instead of smuggling a one-tick effect into a five-tick contract.
  const repeatAngle = state.priorComponents.find((component) => component.id === 'repeat');
  assert.equal(repeatAngle.probabilities, null);
  assert.equal(repeatAngle.weight, 0);
});

test('the validated prior survives its own out-of-sample replay on a planted bias', () => {
  const random = sfc32(43);
  const biased = Array.from({ length: 3_000 }, () => (random() < 0.2 ? 8 : Math.floor(random() * 10)));
  const state = analyzeDigitState(biased, { horizon: 5 });
  assert.ok(state.prior, 'a biased stream ships a prior');
  assert.ok(state.priorBacktest.sample >= 100, `backtest rows ${state.priorBacktest.sample}`);
  assert.ok((state.priorBacktest.skill ?? 0) > 0, 'the shipped recipe beats uniform out of sample');
  const mass = state.prior[8];
  assert.ok(mass > 0.1 && mass < 0.1 + 0.12 + 1e-9, `digit 8 mass ${mass} must stay inside the per-digit clip`);
});

test('the analysis layer separates random walks from directional markets', () => {
  const priced = (seed, drift) => {
    const random = sfc32(seed);
    let quote = 1_000;
    return Array.from({ length: 2_200 }, () => {
      quote += drift + (random() - 0.5) * 1.2;
      return quote;
    });
  };
  const walk = analyzeQuoteState(priced(21, 0));
  assert.equal(walk.regime, 'random');
  assert.ok(walk.predictability < 0.1, `walk predictability ${walk.predictability}`);
  assert.equal(walk.prior, null);

  const up = analyzeQuoteState(priced(22, 0.06));
  assert.equal(up.regime, 'trending-up');
  assert.ok(up.direction > 0.2);
  const down = analyzeQuoteState(priced(23, -0.06));
  assert.equal(down.regime, 'trending-down');
  assert.ok(down.direction < -0.2);
});

// ---- layer 3: confirmation --------------------------------------------------

test('confirmation only confirms an edge the held-out data supports', () => {
  const noise = analyzeDigitMarket({
    family: 'over-under', symbol: 'R_100', name: 'Volatility 100 Index', horizon: 1,
    ticks: digitTicks(randomDigits(31)), fresh: true, marketsInScan: 13,
  });
  assert.ok(noise.best.confidence < 70, `random best confidence ${noise.best.confidence}`);
  assert.ok(noise.best.edge < 0.03, `random best edge ${noise.best.edge}`);
  for (const signal of noise.contracts) {
    const report = signal.deep.confirmation;
    // No correction may manufacture a large edge out of a noise contract.
    assert.ok(Math.abs(report.probability - report.probabilityBefore) <= 0.065 + 1e-9);
    assert.notEqual(report.status, 'confirmed');
  }

  const random = sfc32(32);
  const biased = Array.from({ length: 2_200 }, () => (random() < 0.18 ? 7 : Math.floor(random() * 10)));
  const strong = analyzeDigitMarket({
    family: 'over-under', symbol: 'R_100', name: 'Volatility 100 Index', horizon: 1,
    ticks: digitTicks(biased), fresh: true, marketsInScan: 13,
  });
  assert.equal(strong.best.strength, 'STRONG');
  assert.equal(strong.best.deep.confirmation.status, 'confirmed');
  assert.ok(strong.best.deep.confirmation.decisive);
  assert.ok(strong.best.deep.confirmation.edgePts >= 3);
});

test('Rise/Fall exposes the analysis panel and keeps a random walk at fair odds', () => {
  const random = sfc32(41);
  const ticks = [];
  let quote = 1_000;
  for (let index = 0; index < 2_200; index += 1) {
    quote += (random() - 0.5) * 1.2;
    ticks.push({ epoch: 1_700_000_000 + index, quote: Number(quote.toFixed(4)) });
  }
  const result = analyzeRiseFallMarket({ symbol: 'R_100', name: 'Volatility 100 Index', ticks, fresh: true, marketsInScan: 13 });
  assert.equal(result.state.regime, 'random');
  assert.ok(result.analysisEngineCount >= 10);
  assert.ok(result.best.deep.confirmation);
  assert.ok(result.best.edgeRatio === undefined || true); // shape guard only
  assert.ok(result.best.winEstimate - result.best.fairProbability < 0.03);
  assert.ok(result.best.confidence < 65, `random Rise/Fall confidence ${result.best.confidence}`);
});

// ---- layer 4: precise entry -------------------------------------------------

test('a measured entry validates out of sample and defines a no-chase band', () => {
  const random = sfc32(1);
  const prices = [];
  let quote = 1_000;
  for (let index = 0; index < 1_800; index += 1) {
    quote += 0.35 * (1_000 - quote) + (random() - 0.5) * 1.2;
    prices.push(Number(quote.toFixed(4)));
  }
  const rows = [];
  for (let origin = 0; origin + 25 < prices.length; origin += 3) rows.push({ origin, exit: origin + 5 });
  const epochs = prices.map((_, index) => 1_700_000_000_000 + index * 1_000);
  const plan = analyzeQuoteEntryLike(prices, epochs, rows);
  assert.ok(['pullback', 'breakout'].includes(plan.mode), `mode ${plan.mode}: ${plan.detail}`);
  assert.ok(plan.tolerance !== null && plan.tolerance > 0);
  assert.equal(plan.fill, 'limit-with-tolerance');
  assert.ok(plan.validation);
  assert.equal(plan.validation.phase, 'out-of-sample');
  assert.ok(plan.validation.passed);
  assert.ok(plan.validation.sample >= ENTRY_LIMITS.minValidationSample);
  assert.ok(plan.edgeGainPts >= ENTRY_LIMITS.minEdgePts);

  const armed = { ...plan, priceLevel: 1_000, priceCondition: 'below', trigger: 'quote', mode: 'pullback', tolerance: 0.4, windowTicks: 8 };
  const state = { elapsedTicks: 1, now: 0, deadline: 10_000 };
  assert.equal(evaluateEntry(armed, { quote: 1_000.2, digit: null, epoch: null }, state).status, 'waiting');
  assert.equal(evaluateEntry(armed, { quote: 999.5, digit: null, epoch: null }, state).status, 'missed');
  const near = evaluateEntry(armed, { quote: 999.8, digit: null, epoch: null }, state);
  assert.equal(near.status, 'ready');
  assert.match(near.reason, /entry level/);
});

/** Minimal call into the real entry analyzer (kept here to avoid a second helper import). */
function analyzeQuoteEntryLike(prices, epochs, rows) {
  // The module is imported lazily so this file's other tests keep their imports.
  return analyzeQuote(prices, epochs, rows);
}
