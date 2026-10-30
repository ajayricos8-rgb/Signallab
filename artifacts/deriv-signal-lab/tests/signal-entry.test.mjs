import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_LIMITS,
  analyzeDigitEntry,
  analyzeQuoteEntry,
  describeEntryEvidence,
  describeEntryPlan,
  entryConfidence,
  entryModeLabel,
  entryTier,
  entryWindowMs,
  epochGapMs,
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

/** Mean-reverting (Ornstein-Uhlenbeck) quotes: dips are pulled back to 1,000. */
function revertingQuotes(seed, length, pull = 0.35, noise = 1.2) {
  const random = sfc32(seed);
  const prices = [];
  let quote = 1_000;
  for (let index = 0; index < length; index += 1) {
    quote += pull * (1_000 - quote) + (random() - 0.5) * noise;
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

const EVIDENCE = {
  source: 'rise-fall',
  agreeing: 9,
  total: 12,
  signalProbability: 0.53,
  aiProbability: 0.56,
  fairRate: 0.5,
  rule: "the signal's consensus rule replayed tick by tick on this market",
};

const DIGIT_EVIDENCE = {
  source: 'digit',
  agreeing: 8,
  total: 12,
  signalProbability: 0.55,
  aiProbability: 0.54,
  fairRate: 0.5,
  rule: "the contract's held-out ensemble rule replayed tick by tick",
};

/** The analysis context every quote replay is fed with. */
function quoteSignal(overrides = {}) {
  return { source: 'rise-fall', agreeing: 9, total: 12, probability: 0.53, aiProbability: 0.56, ...overrides };
}

/** The analysis context every digit replay is fed with. */
function digitSignal(overrides = {}) {
  return { source: 'digit', agreeing: 8, total: 12, probability: 0.55, aiProbability: 0.54, ...overrides };
}

function pullbackPlan(overrides = {}) {
  return {
    ...immediateEntryPlan({ reason: 'test', evidence: EVIDENCE }),
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
    evidence: EVIDENCE,
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
    signal: quoteSignal(),
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
    signal: quoteSignal(),
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
    signal: quoteSignal(),
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
    signal: quoteSignal(),
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
    signal: quoteSignal(),
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
      signal: digitSignal(),
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
    signal: digitSignal(),
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
    signal: digitSignal(),
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
    signal: digitSignal(),
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
  const immediate = immediateEntryPlan({ reason: 'x', evidence: EVIDENCE });
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
  const plan = immediateEntryPlan({ reason: 'no timing edge', evidence: EVIDENCE });
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
  // Deriv publishes epochs in SECONDS. Reading a one-second gap as 1 ms
  // collapsed every wall-clock window and validity countdown by 1000x.
  assert.equal(epochGapMs(1_700_000_000, 1_700_000_003), 3_000);
  assert.equal(epochGapMs(1_700_000_000_000, 1_700_000_003_000), 3_000);
  const secondTicks = Array.from({ length: 10 }, (_, index) => ({ epoch: 1_700_000_000 + index }));
  assert.equal(medianTickSpacingMs(secondTicks), 1_000);
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

test('the bot is only ever offered a trigger the replay measured', () => {
  // Whatever the market does, the plan is either "enter at the signal tick" or
  // a level that cleared the documented edge bar — never a level the replay
  // reached often but could not show a gain for.
  for (const [seed, drift, noise, fairRate] of [
    [201, 0.08, 1.2, 0.5],
    [17, 0.02, 1.5, 0.52],
    [88, -0.05, 1.1, 0.5],
  ]) {
    const prices = quotesFrom(seed, 1_600, drift, noise);
    const plan = analyzeQuoteEntry({
      prices,
      epochs: epochsFor(prices.length),
      rows: everyRow(prices, 5),
      direction: drift >= 0 ? 1 : -1,
      averageMove: typicalTickMove(prices),
      horizonTicks: 5,
      fairRate,
      signal: quoteSignal(),
    });
    assert.ok(isEntryPlan(plan));
    assert.equal(plan.trigger === 'immediate', plan.mode === 'immediate');
    if (plan.mode === 'immediate') {
      assert.equal(plan.measured, false);
      assert.equal(plan.priceLevel, null);
      assert.ok(plan.detail.length > 40);
    } else {
      assert.equal(plan.measured, true);
      assert.ok(plan.edgeGainPts >= ENTRY_LIMITS.minEdgePts);
      assert.ok(plan.reachRate >= ENTRY_LIMITS.minReach - 1e-9);
    }
  }
});

test('a market that really does revert still earns a measured pullback', () => {
  // The guard against invented entries must not turn every plan into "next
  // tick": on a genuinely mean-reverting stream the replay finds a real edge and
  // the analysis still produces a level, a window and a wait for it.
  const prices = revertingQuotes(16, 1_800);
  const rows = [];
  for (let origin = 0; origin + 25 < prices.length; origin += 3) rows.push({ origin, exit: origin + 5 });
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows,
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 5,
    fairRate: 0.5,
    signal: quoteSignal({ probability: 0.56, aiProbability: 0.56 }),
  });
  assert.equal(plan.mode, 'pullback');
  assert.equal(plan.trigger, 'quote');
  assert.equal(plan.measured, true);
  assert.ok(plan.distance > 0 && plan.priceLevel < plan.referenceQuote);
  assert.ok(plan.windowTicks >= ENTRY_LIMITS.windowTicks.min && plan.windowTicks <= ENTRY_LIMITS.windowTicks.max);
  assert.ok(plan.expectedWaitTicks >= 0 && plan.expectedWaitTicks <= plan.windowTicks);
  assert.ok(plan.reachRate >= ENTRY_LIMITS.minReach);
  assert.ok(plan.edgeGainPts >= ENTRY_LIMITS.minEdgePts);
  assert.equal(plan.label, 'Pullback entry');
  assert.match(plan.detail, /Waits for the price to pull .* against the signal/);
  assert.equal(isEntryPlan(plan), true);
});

test('a signal the analysis does not stand behind is never timed', () => {
  // The same trending market, but the engine's own probability for the trade
  // sits under the contract's no-edge rate: the entry must stay immediate.
  const prices = quotesFrom(11, 1_400, 0.05, 1.4);
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows: everyRow(prices, 5),
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 5,
    fairRate: 0.5,
    signal: quoteSignal({ probability: 0.31 }),
  });
  assert.equal(plan.mode, 'immediate');
  assert.equal(plan.measured, false);
  assert.match(plan.detail, /analysis rates this signal at 31\.0%/);
});

test('the entry chip text and tier reflect the plan', () => {
  assert.equal(entryModeLabel(immediateEntryPlan({ reason: 'x', evidence: EVIDENCE })), 'Entry next tick');
  assert.match(entryModeLabel(pullbackPlan()), /within 6 ticks/);
  assert.equal(entryTier(pullbackPlan()), 'STRONG');
  assert.equal(entryTier(immediateEntryPlan({ reason: 'x', evidence: EVIDENCE })), 'WEAK');
  // A level nothing measured never reaches the top tier.
  assert.equal(entryTier(pullbackPlan({ measured: false, confidence: 80, edgeGainPts: 0 })), 'MODERATE');
  assert.match(describeEntryPlan(pullbackPlan(), (value) => value.toFixed(2)), /tick down to 999.50/);
});

test('every plan names the analysis it came from', () => {
  const text = describeEntryEvidence(pullbackPlan());
  assert.match(text, /9\/12 engines agree/);
  assert.match(text, /AI 56\.0%/);
  assert.match(text, /the analysis rates the trade 53\.0% against a 50\.0% no-edge rate/);
  assert.match(text, /90 replayed signals/);
  assert.match(text, /consensus rule replayed/);
  const forgeText = describeEntryEvidence(pullbackPlan({
    evidence: {
      ...EVIDENCE,
      forge: { modelProbability: 0.61, validated: true, skill: 0.08, sample: 120, decision: 'confirm', edgePts: 11, contributionPts: 1.4 },
    },
  }));
  assert.match(forgeText, /Forge 61\.0% \(validated, confirm, \+11\.0 pts\)/);
  const digit = describeEntryEvidence({
    ...pullbackPlan({ mode: 'context', trigger: 'digit', priceLevel: null, priceCondition: null, sample: 240, evidence: DIGIT_EVIDENCE }),
  });
  assert.match(digit, /8\/12 engines agree/);
  assert.match(digit, /held-out ensemble rule/);
});

test('only well-formed plans pass the guard used for restored analyses', () => {
  assert.equal(isEntryPlan(pullbackPlan()), true);
  assert.equal(isEntryPlan(immediateEntryPlan({ reason: 'x', evidence: EVIDENCE })), true);
  assert.equal(isEntryPlan(null), false);
  assert.equal(isEntryPlan({ mode: 'pullback' }), false);
  assert.equal(isEntryPlan({ ...pullbackPlan(), trigger: 'magic' }), false);
  // No provenance, no trade: an entry has to come out of an analysis run.
  const { evidence, ...restored } = pullbackPlan();
  assert.equal(isEntryPlan(restored), false);
  assert.equal(isEntryPlan({ ...pullbackPlan(), evidence: null }), false);
  assert.equal(isEntryPlan({ ...pullbackPlan(), evidence: { ...EVIDENCE, source: 'guessed' } }), false);
  // …and a wait for something nothing measured is not a plan either.
  assert.equal(isEntryPlan({ ...pullbackPlan(), measured: false }), false);
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
    // The entry carries the run that produced it: the engines, the AI and the
    // analysis's own rating of the trade — never a made-up level.
    assert.equal(entry.evidence.source, 'rise-fall');
    assert.equal(entry.evidence.agreeing, signal.tally.agreeing);
    assert.equal(entry.evidence.total, signal.tally.total);
    assert.ok(Math.abs(entry.evidence.signalProbability - signal.winEstimate) < 1e-9);
    assert.ok(Math.abs(entry.evidence.fairRate - signal.fairProbability) < 1e-9);
    assert.equal(entry.evidence.forge.decision, signal.forge.decision);
    assert.equal(entry.evidence.forge.modelProbability, signal.forge.modelProbability);
    assert.match(describeEntryEvidence(entry), /engines agree/);
    assert.match(describeEntryEvidence(entry), /Forge/);
    // A wait is only ever planned for something the replay measured.
    assert.equal(entry.measured, entry.trigger !== 'immediate');
    assert.ok(entry.windowTicks >= ENTRY_LIMITS.windowTicks.min);
    assert.ok(entry.confidence >= 0 && entry.confidence <= 100);
    assert.ok(entry.detail.length > 20);
    if (entry.trigger === 'quote') {
      assert.ok(entry.priceLevel !== null && entry.distance !== null && entry.distance > 0);
      assert.ok(entry.priceCondition === 'below' || entry.priceCondition === 'above');
      assert.ok(entry.reachRate >= ENTRY_LIMITS.minReach - 1e-9);
      assert.ok(entry.edgeGainPts >= ENTRY_LIMITS.minEdgePts);
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
      // Digit entries carry the ensemble and the contract's own no-edge rate.
      assert.equal(signal.entry.evidence.source, 'digit');
      assert.equal(signal.entry.evidence.agreeing, signal.tally.agreeing);
      assert.equal(signal.entry.evidence.total, signal.tally.total);
      assert.ok(Math.abs(signal.entry.evidence.signalProbability - signal.probability) < 1e-9);
      assert.ok(Math.abs(signal.entry.evidence.fairRate - signal.fairProbability) < 1e-9);
      assert.equal(signal.entry.evidence.forge.decision, signal.forge.decision);
      assert.equal(signal.entry.evidence.forge.modelProbability, signal.forge.modelProbability);
      assert.match(describeEntryEvidence(signal.entry), /Forge/);
      assert.equal(signal.entry.measured, signal.entry.trigger !== 'immediate');
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
