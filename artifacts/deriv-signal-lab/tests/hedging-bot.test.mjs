import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replayHedgeWindows,
  strictExtremePosition,
  tickPositionStats,
  selectHedgeTicks,
  resolveHedgePredictions,
  jointOutcomes,
} from '../src/lib/hedging-bot/selection.ts';
import { evaluatePairEconomics, validateLegProposal } from '../src/lib/hedging-bot/economics.ts';
import {
  consecutiveLosingPairs,
  evaluateHedgeGate,
  hedgeSessionMinutesRemaining,
  sizeLegStake,
} from '../src/lib/hedging-bot/risk.ts';
import {
  boughtLegs,
  isPairOpen,
  settleLeg,
  summarizePairs,
  trimPairs,
} from '../src/lib/hedging-bot/ledger.ts';
import {
  RECONCILE_TIMEOUT_MS,
  concludeReconciliation,
  matchUnreconciledLegs,
  reconcilePurchase,
} from '../src/lib/hedging-bot/reconcile.ts';
import {
  HEDGE_CONTRACT_TYPES,
  defaultHedgingBotConfig,
  sanitizeHedgingBotConfig,
} from '../src/lib/hedging-bot/types.ts';
import { createRiseFallAccountState } from '../src/lib/rise-fall-bot/types.ts';

// ---- fixtures ------------------------------------------------------------

function leg(side, overrides = {}) {
  return {
    side,
    contractType: HEDGE_CONTRACT_TYPES[side],
    tickPosition: side === 'HIGH' ? 5 : 1,
    contractId: null,
    stake: 1,
    askPrice: null,
    payout: null,
    historicalRate: 0.2,
    status: 'pending',
    profit: null,
    exitSpot: null,
    settledAt: null,
    longcode: null,
    ...overrides,
  };
}

function pair(overrides = {}) {
  return {
    id: 'p1',
    at: 1_000_000,
    symbol: 'R_100',
    mode: 'live',
    status: 'open',
    high: leg('HIGH'),
    low: leg('LOW'),
    entrySpot: 100,
    expectedValue: null,
    netProfit: null,
    balanceAfter: null,
    settledAt: null,
    note: '',
    ...overrides,
  };
}

function openLeg(side, contractId, overrides = {}) {
  return leg(side, { contractId, status: 'open', askPrice: 1, payout: 1.9, stake: 1, ...overrides });
}

function position(contractId, contractType, overrides = {}) {
  return {
    contractId,
    contractType,
    symbol: 'R_100',
    currency: 'USD',
    buyPrice: 1,
    payout: 1.9,
    profit: null,
    profitPercentage: null,
    entrySpot: null,
    exitSpot: null,
    currentSpot: null,
    status: 'open',
    longcode: null,
    shortcode: null,
    buyTime: 1_000,
    expiryTime: null,
    isSold: false,
    isExpired: false,
    isValidToSell: true,
    tickCount: null,
    tickPassed: null,
    source: 'portfolio',
    ...overrides,
  };
}

function gateInput(overrides = {}) {
  const config = defaultHedgingBotConfig();
  return {
    config,
    account: { ...createRiseFallAccountState(), balance: 100 },
    pairs: [],
    mode: 'live',
    runState: 'running',
    manualPause: false,
    autoPauseReasons: [],
    accountAuthorized: true,
    connectionHealthy: true,
    feedFresh: true,
    feedStatus: 'live',
    tickContractsSupported: true,
    tickCount: 1_000,
    openPairs: 0,
    unreconciled: false,
    purchaseInFlight: false,
    stake: 1,
    now: 1_000_000_000,
    ...overrides,
  };
}

// ---- replay and ties -----------------------------------------------------

test('strict extreme is the single tick that beats every other in the window', () => {
  assert.equal(strictExtremePosition([1, 2, 3, 4, 5], 'max'), 5);
  assert.equal(strictExtremePosition([1, 2, 3, 4, 5], 'min'), 1);
  assert.equal(strictExtremePosition([3, 1, 4, 1, 5], 'min'), 0, 'two equal minima: nobody wins');
  assert.equal(strictExtremePosition([5, 5, 1, 2, 3], 'max'), 0, 'two equal maxima: nobody wins');
  assert.equal(strictExtremePosition([5, 5, 1, 2, 3], 'min'), 3);
  assert.equal(strictExtremePosition([], 'max'), 0);
});

test('replay windows are the five ticks after each entry tick', () => {
  const quotes = [1, 2, 3, 4, 5, 6, 7];
  const replay = replayHedgeWindows(quotes, 500);
  assert.equal(replay.windows, 2, 'entries at index 0 and 1 have a full five-tick window');
  assert.deepEqual(replay.highPositions, [5, 5]);
  assert.deepEqual(replay.lowPositions, [1, 1]);
  assert.equal(replay.highCounts[4], 2);
  assert.equal(replay.lowCounts[0], 2);
});

test('a tied window counts for neither leg', () => {
  const tied = replayHedgeWindows([0, 9, 9, 1, 2, 3], 500);
  assert.equal(tied.windows, 1);
  assert.equal(tied.highPositions[0], 0, 'window [9,9,1,2,3] has two equal maxima');
  assert.equal(tied.lowPositions[0], 3, 'lowest is the single 1 at position 3');
});

test('tick statistics expose each position with its share of windows', () => {
  const replay = replayHedgeWindows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 500);
  const stats = tickPositionStats(replay, 'HIGH');
  assert.equal(stats.length, 5);
  assert.equal(stats[4].extremes, replay.windows, 'every window has its maximum at position 5');
  assert.equal(stats[0].extremes, 0);
});

// ---- selection -----------------------------------------------------------

test('a monotonic series selects the last tick for High and the first for Low', () => {
  const quotes = Array.from({ length: 60 }, (_, index) => 100 + index);
  const config = sanitizeHedgingBotConfig({ minSelectionWindows: 1, minTickEdgeZ: 0 });
  const selection = selectHedgeTicks(quotes, config);
  assert.equal(selection.high.tickPosition, 5);
  assert.equal(selection.low.tickPosition, 1);
  assert.equal(selection.high.sufficient, true);
});

test('automatic selection is withheld when the sample is too small', () => {
  const quotes = Array.from({ length: 60 }, (_, index) => 100 + index);
  const selection = selectHedgeTicks(quotes, defaultHedgingBotConfig());
  assert.equal(selection.high.tickPosition, null, 'default minimum is 200 windows');
  assert.equal(selection.low.tickPosition, null);
  assert.equal(selection.joint, null);
});

test('manual mode uses the operator-chosen positions', () => {
  const quotes = Array.from({ length: 60 }, (_, index) => 100 + index);
  const config = sanitizeHedgingBotConfig({ autoSelectTicks: false, manualHighTick: 2, manualLowTick: 4 });
  const selection = selectHedgeTicks(quotes, config);
  assert.equal(selection.high.tickPosition, 2);
  assert.equal(selection.low.tickPosition, 4);
});

test('joint outcomes count the four ways two legs can land', () => {
  const replay = {
    windows: 4,
    highPositions: [2, 2, 3, 1],
    lowPositions: [4, 1, 4, 5],
    highCounts: [1, 2, 1, 0, 0],
    lowCounts: [0, 0, 0, 2, 2],
  };
  const joint = jointOutcomes(replay, 2, 4);
  // Window 0 is both; window 1 only High; window 2 only Low; window 3 neither.
  assert.deepEqual(joint, { windows: 4, bothWin: 1, onlyHigh: 1, onlyLow: 1, neither: 1 });
  assert.equal(joint.bothWin + joint.onlyHigh + joint.onlyLow + joint.neither, joint.windows);
});

test('resolving analysis predictions scores the five ticks after the entry', () => {
  const observations = [1, 2, 3, 4, 5, 6].map((quote, index) => ({ epoch: 100 + index, quote }));
  const row = {
    id: 'a', at: 0, symbol: 'R_100', entryEpoch: 100, entryQuote: 1,
    highTick: 5, lowTick: 1, highRate: null, lowRate: null,
    resolved: false, expired: false, highWon: null, lowWon: null, resolvedAt: null,
  };
  const { rows, changed } = resolveHedgePredictions([row], observations, 99, 60_000);
  assert.equal(changed, true);
  assert.equal(rows[0].resolved, true);
  assert.equal(rows[0].highWon, true);
  assert.equal(rows[0].lowWon, true);
  const pending = resolveHedgePredictions([{ ...row, entryEpoch: 100, entryQuote: 1 }], observations.slice(0, 3), 99, 60_000);
  assert.equal(pending.rows[0].resolved, false, 'not resolved while the window is incomplete');
});

// ---- economics -----------------------------------------------------------

test('pair expected value is the sum of the two leg expectations', () => {
  const economics = evaluatePairEconomics({
    high: { askPrice: 1, payout: 1.9, winRate: 0.2 },
    low: { askPrice: 1, payout: 1.9, winRate: 0.2 },
    joint: null,
  });
  assert.equal(economics.totalAsk, 2);
  assert.equal(economics.scenarios.bothWin, 1.8);
  assert.equal(economics.scenarios.onlyHigh, -0.1, 'one win returns 1.9 against a total cost of 2');
  assert.equal(economics.scenarios.neither, -2);
  // Each leg: 0.2 * (1.9 - 1) - 0.8 * 1 = -0.62; the pair is twice that.
  assert.ok(Math.abs(economics.expectedValue - -1.24) < 1e-9, `expected -1.24, got ${economics.expectedValue}`);
  assert.ok(economics.returnOnStake < 0);
});

test('an unpriced leg leaves the whole pair unpriced', () => {
  const noRate = evaluatePairEconomics({
    high: { askPrice: 1, payout: 1.9, winRate: 0.2 },
    low: { askPrice: 1, payout: 1.9, winRate: null },
    joint: null,
  });
  assert.equal(noRate.expectedValue, null);
  assert.equal(noRate.returnOnStake, null);

  const notAboveAsk = evaluatePairEconomics({
    high: { askPrice: 1, payout: 1, winRate: 0.2 },
    low: { askPrice: 1, payout: 1.9, winRate: 0.2 },
    joint: null,
  });
  assert.equal(notAboveAsk.expectedValue, null, 'a payout that is not above the ask is never priced');
});

test('quote validation refuses a missing payout', () => {
  const check = validateLegProposal({
    proposal: { askPrice: 1, payout: null, spot: 100, spotTime: 1_000 },
    stake: 1,
    now: 1_000_000,
    maxAgeMs: 15_000,
    serverClockOffsetMs: 0,
  });
  assert.equal(check.ok, false);
});

// ---- sizing and the gate ----------------------------------------------------

test('each leg is sized to half the pair share of the balance', () => {
  const config = sanitizeHedgingBotConfig({ stakePerLeg: 10, maxStakeShareOfBalance: 5 });
  const sizing = sizeLegStake(config, 100);
  assert.equal(sizing.stake, 2.5, '5% of 100 split across two legs');
  assert.notEqual(sizing.note, '');

  const small = sizeLegStake(sanitizeHedgingBotConfig({ stakePerLeg: 1, maxStakeShareOfBalance: 5 }), 100);
  assert.equal(small.stake, 1);
  assert.equal(small.note, '');

  const tiny = sizeLegStake(sanitizeHedgingBotConfig({ stakePerLeg: 1, maxStakeShareOfBalance: 5 }), 1);
  assert.equal(tiny.stake, null, 'below the 0.35 minimum stake');
});

test('a clean live state is allowed to buy a pair', () => {
  const gate = evaluateHedgeGate(gateInput());
  assert.equal(gate.allowed, true, gate.violations.join(' | '));
  assert.equal(gate.totalStake, 2, 'worst case is both stakes');
});

test('High/Low Tick unsupported blocks, but unknown does not', () => {
  const unsupported = evaluateHedgeGate(gateInput({ tickContractsSupported: false }));
  assert.equal(unsupported.allowed, false);
  assert.ok(unsupported.codes.includes('CONTRACT_UNSUPPORTED'));

  const unknown = evaluateHedgeGate(gateInput({ tickContractsSupported: null }));
  assert.equal(unknown.allowed, true, 'contracts not yet loaded does not block');
});

test('analysis mode, open pair limit and stake problems each block', () => {
  assert.ok(evaluateHedgeGate(gateInput({ mode: 'analysis' })).codes.includes('ANALYSIS_MODE'));
  assert.ok(evaluateHedgeGate(gateInput({ openPairs: 1 })).codes.includes('OPEN_PAIR_LIMIT'));
  assert.ok(evaluateHedgeGate(gateInput({ stake: null })).codes.includes('NO_STAKE'));
  assert.ok(evaluateHedgeGate(gateInput({ unreconciled: true })).codes.includes('UNRECONCILED'));
  assert.ok(evaluateHedgeGate(gateInput({ tickCount: 3 })).codes.includes('WARMUP'));
});

test('a losing streak counts only settled pairs with a known net', () => {
  const rows = [
    pair({ id: 'a', status: 'settled', netProfit: -1, settledAt: 300 }),
    pair({ id: 'b', status: 'settled', netProfit: -1, settledAt: 200 }),
    pair({ id: 'c', status: 'open', netProfit: null, settledAt: 400 }),
    pair({ id: 'd', status: 'settled', netProfit: 1, settledAt: 100 }),
  ];
  assert.equal(consecutiveLosingPairs(rows), 2);
  const gate = evaluateHedgeGate(gateInput({ pairs: rows, config: { ...defaultHedgingBotConfig(), maxConsecutiveLosingPairs: 2 } }));
  assert.equal(gate.allowed, false);
});

test('the session time limit is measured from the session start', () => {
  const config = sanitizeHedgingBotConfig({ maxSessionMinutes: 10 });
  const account = { ...createRiseFallAccountState(), sessionStartedAt: 0 };
  assert.equal(hedgeSessionMinutesRemaining(config, account, 4 * 60_000), 6);
  assert.equal(hedgeSessionMinutesRemaining(config, { ...account, sessionStartedAt: null }, 0), null);
});

// ---- ledger ---------------------------------------------------------------

test('a partial pair that has not settled is still open and not counted as a push', () => {
  const partial = pair({
    id: 'x',
    status: 'partial',
    high: openLeg('HIGH', 11),
    low: leg('LOW', { status: 'rejected' }),
    netProfit: null,
  });
  assert.equal(isPairOpen(partial), true);
  assert.equal(summarizePairs([partial]).pushes, 0);
  assert.equal(boughtLegs(partial).length, 1);

  const settled = settleLeg(partial, 'HIGH', { profit: -1, exitSpot: 99, settledAt: 5 });
  assert.equal(settled.status, 'partial');
  assert.equal(settled.netProfit, -1);
  assert.equal(isPairOpen(settled), false);
});

test('rejected rows are capped separately so they cannot push real pairs out', () => {
  const real = pair({ id: 'real', status: 'settled', netProfit: 1 });
  const refused = Array.from({ length: 10 }, (_, index) => pair({ id: `r${index}`, status: 'rejected' }));
  const trimmed = trimPairs([real, ...refused], 100, 3);
  assert.ok(trimmed.some((row) => row.id === 'real'));
  assert.equal(trimmed.filter((row) => row.status === 'rejected').length, 3);
  assert.deepEqual(trimmed.filter((row) => row.status === 'rejected').map((row) => row.id), ['r7', 'r8', 'r9']);
});

// ---- reconciliation -------------------------------------------------------

const AT = 1_000_000;

function unknownPair() {
  return pair({
    id: 'u1',
    at: AT,
    status: 'unreconciled',
    high: leg('HIGH'),
    low: leg('LOW'),
  });
}

test('an unknown pair is matched by type, symbol and start time', () => {
  const positions = [
    position(41, HEDGE_CONTRACT_TYPES.HIGH, { buyTime: AT / 1000 + 1 }),
    position(42, HEDGE_CONTRACT_TYPES.LOW, { symbol: 'R_50', buyTime: AT / 1000 }),
    position(43, HEDGE_CONTRACT_TYPES.LOW, { buyTime: AT / 1000 - 9_999 }),
    position(44, HEDGE_CONTRACT_TYPES.LOW, { isSold: true, buyTime: AT / 1000 }),
    position(45, HEDGE_CONTRACT_TYPES.LOW, { buyTime: AT / 1000 }),
  ];
  const matches = matchUnreconciledLegs({ pairId: 'u1', at: AT, symbol: 'R_100', missing: ['HIGH', 'LOW'] }, positions, new Set());
  assert.deepEqual(matches.map((match) => [match.side, match.position.contractId]), [['HIGH', 41], ['LOW', 45]]);
});

test('both legs found on the account resolves to an open hedge', () => {
  const pairs = [unknownPair()];
  const positions = [
    position(41, HEDGE_CONTRACT_TYPES.HIGH, { buyTime: AT / 1000 }),
    position(42, HEDGE_CONTRACT_TYPES.LOW, { buyTime: AT / 1000 }),
  ];
  const result = reconcilePurchase({
    pairs,
    purchase: { pairId: 'u1', at: AT, symbol: 'R_100', missing: ['HIGH', 'LOW'] },
    positions,
    now: AT + 1_000,
  });
  assert.equal(result.resolved, true);
  assert.deepEqual(result.unwind, []);
  assert.equal(result.pairs[0].status, 'open');
  assert.equal(result.pairs[0].high.contractId, 41);
  assert.equal(result.pairs[0].low.contractId, 42);
});

test('one leg found before the timeout keeps the pair unreconciled for the other', () => {
  const result = reconcilePurchase({
    pairs: [unknownPair()],
    purchase: { pairId: 'u1', at: AT, symbol: 'R_100', missing: ['HIGH', 'LOW'] },
    positions: [position(41, HEDGE_CONTRACT_TYPES.HIGH, { buyTime: AT / 1000 })],
    now: AT + 5_000,
  });
  assert.equal(result.resolved, false);
  assert.deepEqual(result.missing, ['LOW']);
  assert.equal(result.pairs[0].status, 'unreconciled');
  assert.equal(result.pairs[0].high.contractId, 41);
});

test('a leg found after the timeout is still attached; the other is then released', () => {
  // Timeout passed with one leg attached and the other never seen. The bought leg is sold back.
  const result = reconcilePurchase({
    pairs: [unknownPair()],
    purchase: { pairId: 'u1', at: AT, symbol: 'R_100', missing: ['HIGH', 'LOW'] },
    positions: [position(41, HEDGE_CONTRACT_TYPES.HIGH, { buyTime: AT / 1000 })],
    now: AT + RECONCILE_TIMEOUT_MS + 1,
  });
  assert.equal(result.resolved, true);
  assert.deepEqual(result.unwind, [41]);
  assert.equal(result.pairs[0].status, 'partial');
  assert.equal(result.pairs[0].low.status, 'rejected');
});

test('nothing on the account after the timeout means the pair was never bought', () => {
  const result = reconcilePurchase({
    pairs: [unknownPair()],
    purchase: { pairId: 'u1', at: AT, symbol: 'R_100', missing: ['HIGH', 'LOW'] },
    positions: [],
    now: AT + RECONCILE_TIMEOUT_MS + 1,
  });
  assert.equal(result.resolved, true);
  assert.deepEqual(result.unwind, []);
  assert.equal(result.pairs[0].status, 'rejected');
});

test('a contract already tracked by another pair is never reused as a match', () => {
  const other = pair({ id: 'other', status: 'open', high: openLeg('HIGH', 41), low: openLeg('LOW', 42) });
  const result = reconcilePurchase({
    pairs: [other, unknownPair()],
    purchase: { pairId: 'u1', at: AT, symbol: 'R_100', missing: ['HIGH'] },
    positions: [position(41, HEDGE_CONTRACT_TYPES.HIGH, { buyTime: AT / 1000 })],
    now: AT + 1_000,
  });
  assert.equal(result.resolved, false, 'contract 41 belongs to the other pair');
});

test('a pair with one bought leg and one refused leg is sold back, never left open', () => {
  const concluded = concludeReconciliation(
    pair({ id: 'c', status: 'open', high: openLeg('HIGH', 77), low: leg('LOW', { status: 'rejected' }) }),
    AT,
  );
  assert.equal(concluded.pair.status, 'partial');
  assert.deepEqual(concluded.unwind, [77]);
});
