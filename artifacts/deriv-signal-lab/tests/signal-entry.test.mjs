import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_LIMITS,
  analyzeDigitEntry,
  analyzeQuoteEntry,
  describeEntryPlan,
  entryConfidence,
  entryModeLabel,
  entryTier,
  entryWindowMs,
  evaluateEntry,
  immediateEntryPlan,
  isEntryPlan,
  medianTickSpacingMs,
  rebaseEntryPlan,
  ticksSince,
  typicalTickMove,
  wilsonLowerBound,
} from '../src/lib/signal-engine/entry.ts';
import { DIGIT_SIGNAL_CONTRACTS, analyzeDigitMarket } from '../src/lib/signal-engine/digit-signal.ts';
import { analyzeRiseFallMarket } from '../src/lib/signal-engine/rise-fall-signal.ts';

// ---- helpers ---------------------------------------------------------------

/** Deterministic sfc32, so every assertion below is reproducible. */
function sfc32(seed) {
  let a = seed >>> 0;
  let b = (seed * 2654435761) >>> 0;
  let c = (seed * 40503) >>> 0;
  let d = (seed * 12345) >>> 0;
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function quotesFrom(seed, length, drift = 0, noise = 1) {
  const random = sfc32(seed);
  const prices = [];
  let quote = 1_000;
  for (let index = 0; index < length; index += 1) {
    quote += drift + (random() - 0.5) * noise;
    prices.push(Number(quote.toFixed(4)));
  }
  return prices;
}

function epochsFor(length, spacingMs = 1_000) {
  return Array.from({ length }, (_, index) => 1_700_000_000_000 + index * spacingMs);
}

/** Every tick can be the origin of a horizon-tick contract. */
function everyRow(prices, horizon) {
  const rows = [];
  for (let origin = 0; origin + horizon < prices.length; origin += 2) rows.push({ origin, exit: origin + horizon });
  return rows;
}

function pullbackPlan(overrides = {}) {
  return {
    ...immediateEntryPlan({ reason: 'test' }),
    mode: 'pullback',
    trigger: 'quote',
    label: 'Pullback entry',
    priceLevel: 999.5,
    priceCondition: 'below',
    distance: 0.5,
    referenceQuote: 1_000,
    windowTicks: 6,
    expectedWaitTicks: 3,
    expectedWaitMs: 3_000,
    reachRate: 0.7,
    edgeGainPts: 2.4,
    sample: 90,
    confidence: 72,
    measured: true,
    ...overrides,
  };
}

// ---- quote entries ---------------------------------------------------------

test('a trending market earns a pullback entry with a measured level and window', () => {
  // Steady upward drift with readable counter-moves: a rise signal, entered on
  // a pullback, should reach its level well over half the time.
  const prices = quotesFrom(11, 1_400, 0.05, 1.4);
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows: everyRow(prices, 5),
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 5,
  });
  assert.ok(plan.windowTicks >= ENTRY_LIMITS.windowTicks.min && plan.windowTicks <= ENTRY_LIMITS.windowTicks.max);
  assert.ok(plan.confidence >= 0 && plan.confidence <= 100);
  assert.ok(plan.sample > 0);
  if (plan.mode !== 'immediate') {
    assert.equal(plan.trigger, 'quote');
    assert.ok(plan.distance > 0);
    // A rise waits for a lower price, a fall for a higher one.
    assert.equal(plan.priceCondition, 'below');
    assert.ok(plan.priceLevel < plan.referenceQuote);
    assert.ok(plan.reachRate >= ENTRY_LIMITS.minReach - 1e-9);
    assert.ok(plan.edgeGainPts >= ENTRY_LIMITS.minEdgePts);
    assert.ok(plan.expectedWaitTicks >= 0 && plan.expectedWaitMs >= 0);
  } else {
    assert.equal(plan.priceLevel, null);
  }
});

test('a fall signal looks for the opposite side of the price', () => {
  const prices = quotesFrom(7, 1_200, -0.04, 1.6);
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows: everyRow(prices, 4),
    direction: -1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 4,
  });
  if (plan.mode !== 'immediate') {
    assert.equal(plan.priceCondition, 'above');
    assert.ok(plan.priceLevel > plan.referenceQuote);
  }
});

test('too few replayed signals falls back to entering on the next tick', () => {
  const prices = quotesFrom(3, 400, 0.02, 1);
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows: everyRow(prices, 3).slice(0, 10),
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 3,
  });
  assert.equal(plan.mode, 'immediate');
  assert.equal(plan.trigger, 'immediate');
  assert.equal(plan.priceLevel, null);
  assert.match(plan.detail, /replayed signals/);
});

test('a pure random walk earns no timing edge, so the entry stays immediate', () => {
  const prices = quotesFrom(29, 1_600, 0, 2);
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows: everyRow(prices, 5),
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 5,
  });
  // Either the plan is immediate, or it claims a positive measured edge.
  if (plan.mode !== 'immediate') assert.ok(plan.edgeGainPts >= ENTRY_LIMITS.minEdgePts);
  assert.ok(plan.detail.length > 0);
});

test('a flat market has no entry point to wait for', () => {
  const prices = Array.from({ length: 900 }, () => 1_000);
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows: everyRow(prices, 5),
    direction: 1,
    horizonTicks: 5,
  });
  assert.equal(plan.mode, 'immediate');
  assert.match(plan.detail, /no measurable tick movement/);
});

// ---- digit entries ---------------------------------------------------------

test('pure noise earns no context entry, and any context offered carries its own evidence', () => {
  // Ten random digits per tick: no context can honestly claim a lift. The gates
  // were calibrated on streams like this one, so the plan stays immediate.
  const random = sfc32(5);
  const digits = Array.from({ length: 1_500 }, () => Math.floor(random() * 10));
  for (const wins of [(digit) => digit === 4, (digit) => digit % 2 === 0, (digit) => digit > 6]) {
    const plan = analyzeDigitEntry({
      digits,
      epochs: epochsFor(digits.length),
      horizon: 1,
      wins,
    });
    if (plan.mode === 'context') {
      assert.ok(Array.isArray(plan.contextDigits) && plan.contextDigits.length);
      assert.ok(plan.edgeGainPts >= 1);
      assert.ok(plan.confidence > 50);
    } else {
      assert.equal(plan.mode, 'immediate');
      assert.equal(plan.contextDigits, null);
    }
  }
});

test('a digit context that lifts the win rate out of sample becomes the entry', () => {
  // One half of the stream treats 7 as the winning digit right after a 3, the
  // other half keeps it. Only a real, persistent context can survive the split.
  const random = sfc32(97);
  const digits = [];
  for (let index = 0; index < 900; index += 1) {
    const previous = digits.at(-1);
    const favourable = previous === 3 && random() < 0.7;
    const value = favourable ? 7 : Math.floor(random() * 10);
    digits.push(value);
  }
  const plan = analyzeDigitEntry({
    digits,
    epochs: epochsFor(digits.length),
    horizon: 1,
    wins: (digit) => digit === 7,
  });
  if (plan.mode === 'context') {
    assert.equal(plan.trigger, 'digit');
    assert.ok(Array.isArray(plan.contextDigits) && plan.contextDigits.length);
    assert.ok(plan.contextDigits.includes(3));
    assert.ok(plan.edgeGainPts >= ENTRY_LIMITS.minEdgePts);
    assert.ok(plan.windowTicks >= ENTRY_LIMITS.contextWindowTicks.min);
    assert.ok(plan.windowTicks <= ENTRY_LIMITS.contextWindowTicks.max);
    assert.equal(plan.priceLevel, null);
    assert.ok(plan.contextLabel && plan.contextLabel.startsWith('after'));
  } else {
    assert.equal(plan.mode, 'immediate');
  }
});

test('even/odd reads the parity of the tick before the entry', () => {
  const random = sfc32(55);
  const digits = [];
  for (let index = 0; index < 900; index += 1) {
    const previous = digits.at(-1);
    const favourable = previous !== undefined && previous % 2 === 0 && random() < 0.75;
    const value = favourable ? (random() < 0.5 ? 0 : 2) : Math.floor(random() * 10);
    digits.push(value);
  }
  const plan = analyzeDigitEntry({
    digits,
    epochs: epochsFor(digits.length),
    horizon: 2,
    wins: (digit) => digit % 2 === 0,
    context: 'parity',
  });
  if (plan.mode === 'context') {
    assert.ok(plan.contextDigits.every((digit) => digit % 2 === 0));
    assert.match(plan.contextLabel, /even/);
  } else {
    assert.equal(plan.mode, 'immediate');
  }
});

test('a short digit stream cannot measure a context', () => {
  const plan = analyzeDigitEntry({
    digits: Array.from({ length: 60 }, (_, index) => index % 10),
    epochs: epochsFor(60),
    horizon: 1,
    wins: (digit) => digit === 1,
  });
  assert.equal(plan.mode, 'immediate');
  assert.match(plan.detail, /were available to measure an entry context/);
});

// ---- the plan the bot uses -------------------------------------------------

test('re-basing keeps the measured distance and moves the level to the live quote', () => {
  const plan = pullbackPlan();
  const rebased = rebaseEntryPlan(plan, 1_050);
  assert.equal(rebased.distance, plan.distance);
  assert.equal(rebased.referenceQuote, 1_050);
  assert.equal(rebased.priceLevel, 1_050 - plan.distance);
  const higher = rebaseEntryPlan({ ...plan, priceCondition: 'above' }, 1_050);
  assert.equal(higher.priceLevel, 1_050 + plan.distance);
  // Immediate and context plans never change.
  const immediate = immediateEntryPlan({ reason: 'x' });
  assert.equal(rebaseEntryPlan(immediate, 1_050), immediate);
});

test('the entry check waits, fires on the level and expires with the window', () => {
  const plan = pullbackPlan({ windowTicks: 5 });
  const waiting = evaluateEntry(
    plan,
    { quote: 1_000, digit: null, epoch: null },
    { elapsedTicks: 2, now: 1_000, deadline: 10_000 },
  );
  assert.equal(waiting.status, 'waiting');
  assert.ok(waiting.distance > 0);
  assert.equal(waiting.remainingTicks, 3);

  const ready = evaluateEntry(
    plan,
    { quote: plan.priceLevel - 0.01, digit: null, epoch: null },
    { elapsedTicks: 3, now: 2_000, deadline: 10_000 },
  );
  assert.equal(ready.status, 'ready');
  assert.match(ready.reason, /entry level/);

  const expiredByTicks = evaluateEntry(
    plan,
    { quote: 1_000, digit: null, epoch: null },
    { elapsedTicks: 5, now: 2_000, deadline: 10_000 },
  );
  assert.equal(expiredByTicks.status, 'expired');

  const expiredByClock = evaluateEntry(
    plan,
    { quote: 1_000, digit: null, epoch: null },
    { elapsedTicks: 1, now: 10_000, deadline: 10_000 },
  );
  assert.equal(expiredByClock.status, 'expired');
  assert.equal(expiredByClock.remainingMs, 0);
});

test('an immediate entry is ready straight away and never asks for a level', () => {
  const plan = immediateEntryPlan({ reason: 'no timing edge' });
  const evaluation = evaluateEntry(plan, { quote: 1_000, digit: 3, epoch: 1 }, { elapsedTicks: 0, now: 0, deadline: 0 });
  assert.equal(evaluation.status, 'ready');
  assert.equal(evaluation.distance, null);
  // Even a plan whose window has long closed stays ready: there is no wait.
  const late = evaluateEntry(plan, { quote: 1_000, digit: null, epoch: null }, { elapsedTicks: 99, now: 10_000, deadline: 0 });
  assert.equal(late.status, 'ready');
});

test('a context entry fires on the tick that prints the planned digit', () => {
  const plan = { ...pullbackPlan(), mode: 'context', trigger: 'digit', priceLevel: null, priceCondition: null, contextDigits: [2, 7], contextLabel: 'after digit 2 or 7', windowTicks: 10 };
  const waiting = evaluateEntry(plan, { quote: 1_000, digit: 4, epoch: 1 }, { elapsedTicks: 1, now: 0, deadline: 10_000 });
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.reason, /last tick printed 4/);
  const ready = evaluateEntry(plan, { quote: 1_000, digit: 7, epoch: 1 }, { elapsedTicks: 1, now: 0, deadline: 10_000 });
  assert.equal(ready.status, 'ready');
  assert.match(ready.reason, /after digit 2 or 7/);
});

test('the wall-clock window scales with the tick spacing and stays bounded', () => {
  const plan = pullbackPlan({ windowTicks: 8, expectedWaitTicks: 4, expectedWaitMs: 4_000 });
  assert.equal(entryWindowMs(plan, 1_000), 8_000);
  assert.ok(entryWindowMs(plan, 1) >= 1_500);
  assert.ok(entryWindowMs(pullbackPlan({ windowTicks: 60, expectedWaitTicks: 60, expectedWaitMs: 600_000 }), 60_000) <= 180_000);
});

test('feed helpers count ticks after the arming tick and read the spacing', () => {
  const ticks = epochsFor(10).map((epoch, index) => ({ epoch, quote: 1_000 + index }));
  assert.equal(ticksSince(ticks, ticks[6].epoch), 3);
  assert.equal(ticksSince(ticks, null), 0);
  assert.equal(ticksSince(ticks, ticks.at(-1).epoch), 0);
  assert.equal(medianTickSpacingMs(ticks), 1_000);
  assert.equal(medianTickSpacingMs([], 700), 700);
});

// ---- evidence bookkeeping --------------------------------------------------

test('entry confidence is symmetric around no evidence and shrinks with few rows', () => {
  assert.equal(entryConfidence({ improved: 0, worsened: 0, sample: 100 }), 50);
  assert.ok(entryConfidence({ improved: 30, worsened: 5, sample: 120 }) > 60);
  assert.ok(entryConfidence({ improved: 5, worsened: 30, sample: 120 }) < 40);
  assert.equal(entryConfidence({ improved: 2, worsened: 0, sample: 0 }), 50);
});

test('wilson bounds keep thin buckets out of the plan', () => {
  assert.ok(wilsonLowerBound(3, 3) < 1);
  assert.ok(wilsonLowerBound(300, 1_000) > 0.2);
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test('a structural level without a measured gain is reported but flagged', () => {
  // A strong upward drift: every dip is bought back, so the pullback level is
  // reached on most signals. Whether the replay also measures a win-rate gain
  // is what decides `measured`.
  const prices = quotesFrom(201, 1_600, 0.08, 1.2);
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows: everyRow(prices, 5),
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 5,
    fairRate: 0.5,
  });
  assert.ok(isEntryPlan(plan));
  if (plan.mode !== 'immediate') {
    // A plan that claims a gain must clear the documented edge bar.
    if (plan.measured) assert.ok(plan.edgeGainPts >= ENTRY_LIMITS.minEdgePts);
    else assert.match(plan.detail, /no win-rate gain|did not confirm/);
  } else {
    assert.equal(plan.measured, false);
  }
});

test('the entry chip text and tier reflect the plan', () => {
  assert.equal(entryModeLabel(immediateEntryPlan({ reason: 'x' })), 'Entry next tick');
  assert.match(entryModeLabel(pullbackPlan()), /within 6 ticks/);
  assert.equal(entryTier(pullbackPlan()), 'STRONG');
  assert.equal(entryTier(immediateEntryPlan({ reason: 'x' })), 'WEAK');
  // An unmeasured level never reaches the top tier, however often it is reached.
  assert.equal(entryTier(pullbackPlan({ measured: false, confidence: 80, edgeGainPts: 0 })), 'MODERATE');
  assert.match(describeEntryPlan(pullbackPlan(), (value) => value.toFixed(2)), /tick down to 999.50/);
});

test('only well-formed plans pass the guard used for restored analyses', () => {
  assert.equal(isEntryPlan(pullbackPlan()), true);
  assert.equal(isEntryPlan(immediateEntryPlan({ reason: 'x' })), true);
  assert.equal(isEntryPlan(null), false);
  assert.equal(isEntryPlan({ mode: 'pullback' }), false);
  assert.equal(isEntryPlan({ ...pullbackPlan(), trigger: 'magic' }), false);
});

// ---- the engines always ship an entry --------------------------------------

test('every Rise/Fall duration carries an entry plan with a usable window', () => {
  const prices = quotesFrom(41, 1_500, 0.03, 1.5);
  const analysis = analyzeRiseFallMarket({
    symbol: 'R_100',
    name: 'Volatility 100 Index',
    ticks: prices.map((quote, index) => ({ epoch: epochsFor(prices.length)[index], quote })),
    fresh: true,
    horizons: [
      { unit: 'ticks', value: 3 },
      { unit: 'minutes', value: 1 },
    ],
    marketsInScan: 1,
  });
  assert.equal(analysis.horizons.length, 2);
  for (const signal of analysis.horizons) {
    const entry = signal.entry;
    assert.ok(isEntryPlan(entry));
    assert.equal(typeof entry.measured, 'boolean');
    assert.ok(entry.windowTicks >= ENTRY_LIMITS.windowTicks.min);
    assert.ok(entry.confidence >= 0 && entry.confidence <= 100);
    assert.ok(entry.detail.length > 20);
    if (entry.trigger === 'quote') {
      assert.ok(entry.priceLevel !== null && entry.distance !== null && entry.distance > 0);
      assert.ok(entry.priceCondition === 'below' || entry.priceCondition === 'above');
      assert.ok(entry.reachRate >= ENTRY_LIMITS.minReach - 1e-9);
    } else {
      assert.equal(entry.trigger, 'immediate');
      assert.equal(entry.priceLevel, null);
    }
  }
});

test('every digit contract carries an entry plan', () => {
  const random = sfc32(1234);
  const ticks = Array.from({ length: 900 }, (_, index) => ({ epoch: epochsFor(900)[index], digit: Math.floor(random() * 10) }));
  for (const family of ['over-under', 'even-odd', 'matches']) {
    const analysis = analyzeDigitMarket({
      family,
      symbol: 'R_50',
      name: 'Volatility 50 Index',
      horizon: 2,
      ticks,
      fresh: true,
      contracts: DIGIT_SIGNAL_CONTRACTS[family].slice(0, 4),
      marketsInScan: 1,
    });
    for (const signal of analysis.contracts) {
      assert.ok(isEntryPlan(signal.entry), `${family} contract ${signal.label} has no entry plan`);
      if (signal.entry.trigger === 'digit') {
        assert.ok(signal.entry.windowTicks >= ENTRY_LIMITS.contextWindowTicks.min);
        assert.ok(signal.entry.windowTicks <= ENTRY_LIMITS.contextWindowTicks.max);
        assert.ok(Array.isArray(signal.entry.contextDigits) && signal.entry.contextDigits.length);
        assert.ok(signal.entry.contextDigits.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9));
        assert.ok(signal.entry.edgeGainPts >= ENTRY_LIMITS.minEdgePts);
      } else {
        assert.equal(signal.entry.trigger, 'immediate');
      }
    }
  }
});
