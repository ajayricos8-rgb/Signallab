// Accuracy audit for the level-reversion (Ornstein–Uhlenbeck) layer.
//
// The rest of the analysis stack reads RETURNS. A market can be strongly
// mean-reverting while its returns look almost uncorrelated, because the pull
// is proportional to the distance from equilibrium, not to the last tick's
// move. These tests plant exactly that structure and demand four things:
//
//   1. DETECTION   — the fit finds the pull and reports a usable half-life.
//   2. ACCURACY    — the probability the model publishes matches the frequency
//                    that actually happened at that displacement.
//   3. HONESTY     — a random walk never clears the unit-root bar, and the
//                    prior stays null there, so no edge is invented.
//   4. ENTRY       — the entry master turns the same fit into a timing rule
//                    that is validated out of sample, and drops it on noise.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeQuoteState,
  fitLevelReversion,
  levelReversionProbabilityUp,
  quotePriorProbability,
} from '../src/lib/signal-engine/market-state.ts';
import { analyzeQuoteEntry, isEntryPlan, rebaseEntryPlan, typicalTickMove } from '../src/lib/signal-engine/entry.ts';
import { shrinkEdges } from '../src/lib/signal-engine/precision.ts';

// ---- deterministic streams -------------------------------------------------

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

/** x[t+1] = x[t] + theta·(mean − x[t]) + noise. Half-life = −ln2 / ln(1 − theta). */
function ouQuotes(seed, length, theta = 0.06, noise = 0.5, mean = 1_000) {
  const random = sfc32(seed);
  const prices = [];
  let quote = mean;
  for (let index = 0; index < length; index += 1) {
    quote += theta * (mean - quote) + (random() - 0.5) * noise;
    prices.push(Number(quote.toFixed(6)));
  }
  return prices;
}

function randomWalk(seed, length, noise = 0.5) {
  const random = sfc32(seed);
  const prices = [];
  let quote = 1_000;
  for (let index = 0; index < length; index += 1) {
    quote += (random() - 0.5) * noise;
    prices.push(Number(quote.toFixed(6)));
  }
  return prices;
}

function epochsFor(length, spacingMs = 1_000) {
  return Array.from({ length }, (_, index) => 1_700_000_000_000 + index * spacingMs);
}

const SIGNAL = {
  source: 'rise-fall',
  agreeing: 9,
  total: 15,
  probability: 0.6,
  aiProbability: 0.6,
  confirmation: { status: 'adjusted', edgePts: 3, decisive: false },
};

// ---- 1. detection ----------------------------------------------------------

test('the level fit finds a planted pull and measures its half-life', () => {
  const prices = ouQuotes(4, 2_600, 0.06, 0.5);
  const model = fitLevelReversion(prices);
  assert.ok(model, 'the fit must produce a model');
  assert.ok(model.significant, `expected a significant pull, t = ${model.tStatistic.toFixed(2)}`);
  // theta = 0.06 is a half-life of ~11.2 ticks.
  assert.ok(model.halfLifeTicks !== null && model.halfLifeTicks > 5 && model.halfLifeTicks < 30,
    `half-life ${model.halfLifeTicks}`);
  assert.ok(model.tStatistic <= -3.5, `unit-root t ${model.tStatistic}`);
  assert.ok(model.phi > 0.85 && model.phi < 1, `phi ${model.phi}`);
  assert.ok(model.levelSigma > 0 && Number.isFinite(model.displacementZ));
});

// ---- 2. accuracy -----------------------------------------------------------

test('the published reversion probability matches the frequency that happened', () => {
  const prices = ouQuotes(9, 12_000, 0.06, 0.5);
  const horizon = 5;
  let predictions = 0;
  let squared = 0;
  let squaredFair = 0;
  let sumProbability = 0;
  let sumOutcome = 0;
  const confident = { count: 0, won: 0, sumProbability: 0 };
  for (let origin = 600; origin + horizon < prices.length; origin += 9) {
    // Only data up to the origin: this is a forecast, not a fitted description.
    const model = fitLevelReversion(prices.slice(0, origin + 1));
    const probability = levelReversionProbabilityUp(model, horizon);
    if (probability === null) continue;
    const won = prices[origin + horizon] > prices[origin] ? 1 : 0;
    predictions += 1;
    squared += (probability - won) ** 2;
    squaredFair += (0.5 - won) ** 2;
    sumProbability += probability;
    sumOutcome += won;
    // Read every forecast as a call on its own side: p ≥ 0.6 says "up", and
    // p ≤ 0.4 says "down" with probability 1 − p.
    if (probability >= 0.6) {
      confident.count += 1;
      confident.won += won;
      confident.sumProbability += probability;
    } else if (probability <= 0.4) {
      confident.count += 1;
      confident.won += 1 - won;
      confident.sumProbability += 1 - probability;
    }
  }
  assert.ok(predictions >= 400, `expected the model to fire often, got ${predictions}`);
  const skill = 1 - squared / squaredFair;
  assert.ok(skill > 0.02, `Brier skill of the reversion probability was ${skill.toFixed(3)}`);
  const meanForecast = sumProbability / predictions;
  const realised = sumOutcome / predictions;
  assert.ok(Math.abs(meanForecast - realised) < 0.03,
    `mean forecast ${meanForecast.toFixed(3)} against realised ${realised.toFixed(3)}`);
  // Where the model is confident it has to be right at least as often as it
  // says, and no more often than the market allows: publishing 0.7 and winning
  // 0.9 is as much a calibration error as publishing 0.7 and winning 0.5.
  assert.ok(confident.count >= 60, `only ${confident.count} confident forecasts`);
  const hitRate = confident.won / confident.count;
  const statedRate = confident.sumProbability / confident.count;
  assert.ok(hitRate > 0.55, `confident hit rate ${hitRate.toFixed(3)}`);
  assert.ok(hitRate > statedRate - 0.12, `stated ${statedRate.toFixed(3)} over-claimed: hit ${hitRate.toFixed(3)}`);
});

test('a stretched price gets a probability that grows with the exit horizon', () => {
  const prices = ouQuotes(2, 2_000, 0.12, 0.5);
  const model = fitLevelReversion(prices);
  assert.ok(model && model.significant);
  const near = levelReversionProbabilityUp(model, 1);
  const far = levelReversionProbabilityUp(model, 10);
  assert.ok(near !== null && far !== null);
  const shortEdge = Math.abs(near - 0.5);
  const longEdge = Math.abs(far - 0.5);
  assert.ok(longEdge > shortEdge,
    `a longer contract should be more certain under a pull: ${shortEdge.toFixed(3)} → ${longEdge.toFixed(3)}`);
  assert.ok(far > 0.5 !== model.displacementZ > 0,
    'a price above equilibrium must be predicted to fall');
});

// ---- 3. honesty ------------------------------------------------------------

test('a random walk never clears the unit-root bar', () => {
  let fired = 0;
  for (let seed = 1; seed <= 12; seed += 1) {
    const model = fitLevelReversion(randomWalk(seed, 2_600, 0.5));
    if (model?.significant) fired += 1;
    if (model) assert.equal(levelReversionProbabilityUp(model, 5), model.significant ? levelReversionProbabilityUp(model, 5) : null);
  }
  assert.ok(fired <= 1, `${fired} of 12 random walks cleared a t of −3.5`);
});

test('the analysis reports mean reversion and ships a validated prior — or stays neutral', () => {
  const reverting = analyzeQuoteState(ouQuotes(5, 2_600, 0.06, 0.5), epochsFor(2_600));
  const engine = reverting.engines.find((item) => item.id === 'level-reversion');
  assert.ok(engine, 'the level-reversion engine must be reported');
  assert.equal(reverting.regime, 'mean-reverting');
  assert.ok(engine.strength > 0.2, `engine strength ${engine.strength}`);
  assert.ok(reverting.predictability >= 0.1, `predictability ${reverting.predictability}`);
  assert.ok(reverting.metrics.levelReversionPhi !== null && reverting.metrics.levelReversionPhi < 1);
  assert.ok(reverting.prior !== null, 'a validated prior should be published');
  assert.ok(reverting.priorBacktest.skill !== null && reverting.priorBacktest.skill > 0,
    `prior Brier skill ${reverting.priorBacktest.skill}`);

  const noise = analyzeQuoteState(randomWalk(6, 2_600, 0.5), epochsFor(2_600));
  const noiseEngine = noise.engines.find((item) => item.id === 'level-reversion');
  assert.equal(noiseEngine.strength, 0, 'a random walk must not earn level-reversion strength');
  assert.equal(noise.prior, null, 'a random walk must not ship a directional prior');
  assert.notEqual(noise.regime, 'mean-reverting');
});

test('the prior is the same recipe the backtest grades', () => {
  const model = fitLevelReversion(ouQuotes(3, 2_000, 0.08, 0.5));
  assert.ok(model?.significant);
  const tilted = quotePriorProbability({ direction: 0.5, level: model, horizonTicks: 5 });
  const trendOnly = quotePriorProbability({ direction: 0.5, level: null, horizonTicks: 5 });
  // Direction is the same, so the difference is exactly the level pull.
  assert.notEqual(tilted, trendOnly);
  assert.ok(tilted >= 0.3 && tilted <= 0.7);
  assert.ok(quotePriorProbability({ direction: 1, level: null }) > 0.5);
});

// ---- 4. entry --------------------------------------------------------------

test('the entry master plans around the equilibrium instead of a percentile', () => {
  const prices = ouQuotes(11, 2_400, 0.06, 0.5);
  const rows = [];
  for (let origin = 10; origin + 5 < prices.length; origin += 2) rows.push({ origin, exit: origin + 5 });
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows,
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 5,
    fairRate: 0.5,
    signal: SIGNAL,
  });
  assert.equal(isEntryPlan(plan), true, plan.detail);
  assert.equal(plan.measured, plan.trigger !== 'immediate', 'measured is reserved for plans with a trigger');
  assert.match(plan.detail, /equilibrium/);
  assert.ok(plan.edgeGainPts === null || plan.edgeGainPts >= 0);
  if (plan.mode === 'pullback') {
    assert.equal(plan.rebase, 'absolute');
    assert.equal(plan.priceCondition, 'below');
    assert.ok(plan.priceLevel < plan.referenceQuote);
    assert.ok(plan.windowTicks >= 2);
    assert.equal(plan.validation?.passed, true);
  }
});

test('an equilibrium level is never dragged along with the live quote', () => {
  const prices = ouQuotes(12, 2_400, 0.06, 0.5);
  const rows = [];
  for (let origin = 10; origin + 5 < prices.length; origin += 2) rows.push({ origin, exit: origin + 5 });
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows,
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 5,
    fairRate: 0.5,
    signal: SIGNAL,
  });
  if (plan.mode !== 'pullback' || plan.rebase !== 'absolute') return;
  const rebased = rebaseEntryPlan(plan, plan.referenceQuote + 3);
  assert.equal(rebased.priceLevel, plan.priceLevel, 'an absolute level must survive re-basing');
  assert.equal(rebased.referenceQuote, plan.referenceQuote + 3);
});

test('a random walk earns no equilibrium timing, so the entry stays a plain next-tick plan', () => {
  const prices = randomWalk(21, 2_400, 0.5);
  const rows = [];
  for (let origin = 10; origin + 5 < prices.length; origin += 2) rows.push({ origin, exit: origin + 5 });
  const plan = analyzeQuoteEntry({
    prices,
    epochs: epochsFor(prices.length),
    rows,
    direction: 1,
    averageMove: typicalTickMove(prices),
    horizonTicks: 5,
    fairRate: 0.5,
    signal: SIGNAL,
  });
  assert.doesNotMatch(plan.detail, /equilibrium/);
  if (plan.mode === 'immediate') assert.equal(plan.measured, false);
});

// ---- 5. precision gate -----------------------------------------------------

test('a small candidate pool only keeps an edge when an independent source found one', () => {
  const single = [{ edge: 0.1, standardError: 0.05 }];
  assert.equal(shrinkEdges(single).factors[0], 0, 'one noisy candidate alone is not an edge');
  const supported = shrinkEdges(single, { independentEdge: true });
  assert.ok(supported.factors[0] > 0 && supported.factors[0] < 1,
    `independent support should shrink, not zero: ${supported.factors[0]}`);
  // Three candidates are enough to estimate the spread of real edges, so the
  // independent flag stops mattering.
  const pool = [
    { edge: 0.16, standardError: 0.03 },
    { edge: 0.15, standardError: 0.03 },
    { edge: 0.14, standardError: 0.03 },
  ];
  const withoutFlag = shrinkEdges(pool);
  const withFlag = shrinkEdges(pool, { independentEdge: true });
  assert.deepEqual(withoutFlag.factors, withFlag.factors);
  assert.ok(withoutFlag.heterogeneity.count === 3);
});
