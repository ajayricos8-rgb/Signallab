// Automated tests for the Rise/Fall premium bot engine: the feature engine, the
// decision rules, the historical evidence replay, the proposal economics and
// quote validation, the risk manager (stake models, purchase gate, account
// ledger) and the trade-log export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMomentumThresholdPips, extractFeatures, pipsToPrice, priceToPips } from '../src/lib/rise-fall-bot/features.ts';
import { decideDirection, ruleFiresAtIndex } from '../src/lib/rise-fall-bot/decision.ts';
import { evaluateProposalEconomics, evaluateSignalEvidence, validateRiseFallQuote } from '../src/lib/rise-fall-bot/evidence.ts';
import {
  applyPurchase,
  applySettlement,
  beginSession,
  computeStakePlan,
  evaluateRiskGate,
  reconcileBalance,
  rollTradingDay,
  sessionMinutesRemaining,
  setOpenExposure,
  tradesRemaining,
} from '../src/lib/rise-fall-bot/risk.ts';
import { resolvePredictions, summarizePredictions, summarizeTrades, tradesToCsv } from '../src/lib/rise-fall-bot/performance.ts';
import {
  createRiseFallAccountState,
  dayKeyOf,
  defaultRiseFallConfig,
  sanitizeRiseFallConfig,
} from '../src/lib/rise-fall-bot/types.ts';

const PIP = 0.01;

/** A quiet tape: alternating one-pip moves around 1000. */
function flatTape(count = 40, start = 1_000) {
  return Array.from({ length: count }, (_, index) => start + (index % 2 === 0 ? 0 : PIP));
}

/** A steady ramp: every tick one pip higher. */
function risingTape(count = 60, start = 1_000, step = PIP) {
  return Array.from({ length: count }, (_, index) => start + index * step);
}

function fallingTape(count = 60, start = 1_000, step = PIP) {
  return Array.from({ length: count }, (_, index) => start - index * step);
}

function runningGateInput(overrides = {}) {
  const config = sanitizeRiseFallConfig({ ...defaultRiseFallConfig(), ...overrides.config });
  const account = {
    ...createRiseFallAccountState(),
    currency: 'USD',
    balance: 10_000,
    accountType: 'demo',
    sessionStartedAt: Date.now(),
    ...overrides.account,
  };
  return {
    config,
    account,
    mode: overrides.mode ?? 'live',
    runState: overrides.runState ?? 'running',
    autoPauseReasons: overrides.autoPauseReasons ?? [],
    manualPause: overrides.manualPause ?? false,
    accountAuthorized: overrides.accountAuthorized ?? true,
    connectionHealthy: overrides.connectionHealthy ?? true,
    feedFresh: overrides.feedFresh ?? true,
    feedStatus: overrides.feedStatus ?? 'live',
    tickCount: overrides.tickCount ?? 200,
    openContracts: overrides.openContracts ?? 0,
    unreconciledPurchase: overrides.unreconciledPurchase ?? false,
    purchaseInFlight: overrides.purchaseInFlight ?? false,
    now: overrides.now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Feature engine
// ---------------------------------------------------------------------------

test('feature engine refuses to describe a market it has not seen', () => {
  const config = defaultRiseFallConfig();
  assert.equal(extractFeatures([], config, PIP), null);
  assert.equal(extractFeatures([1_000, 1_000.01, 1_000.02, 1_000.03], config, PIP), null);
});

test('feature engine reports ratios, momentum, volatility and the last move in pips', () => {
  const config = sanitizeRiseFallConfig({ tickWindow: 20, momentumTicks: 5, volatilityTicks: 10 });
  const features = extractFeatures(risingTape(20), config, PIP);
  assert.ok(features);
  assert.equal(features.sample, 20);
  assert.equal(features.upRatio, 1);
  assert.equal(features.downRatio, 0);
  assert.equal(features.flatRatio, 0);
  // Five one-pip moves; compared with a tolerance because price differences
  // carry binary floating-point noise.
  assert.ok(Math.abs(features.momentumPips - 5) < 1e-6);
  assert.ok(Math.abs(features.volatilityPips - 1) < 1e-6);
  assert.ok(Math.abs(features.lastMovePips - 1) < 1e-6);
  assert.equal(features.streakDirection, 'up');
  assert.equal(features.streakLength, 19);
});

test('feature engine only reads the newest tickWindow quotes', () => {
  const config = sanitizeRiseFallConfig({ tickWindow: 10 });
  const quotes = [...fallingTape(50), ...risingTape(10, 900)];
  const features = extractFeatures(quotes, config, PIP);
  assert.ok(features);
  assert.equal(features.sample, 10);
  assert.equal(features.upRatio, 1);
  assert.ok(features.price > 900);
});

test('pip conversion is only attempted with a verified pip size', () => {
  assert.equal(priceToPips(0.05, PIP), 5);
  assert.equal(priceToPips(0.05, null), null);
  assert.equal(pipsToPrice(5, PIP), 0.05);
  assert.equal(pipsToPrice(5, null), null);
});

test('adaptive thresholds scale the momentum edge with measured volatility', () => {
  const config = sanitizeRiseFallConfig({ momentumThresholdPips: 2, adaptiveThresholds: true, adaptiveMultiple: 1.5 });
  assert.equal(effectiveMomentumThresholdPips(config, 10), 15); // 1.5 × 10 pips beats the fixed 2
  assert.equal(effectiveMomentumThresholdPips(config, 1), 2); // the fixed floor still applies
  const fixed = sanitizeRiseFallConfig({ ...config, adaptiveThresholds: false });
  assert.equal(effectiveMomentumThresholdPips(fixed, 10), 2);
});

// ---------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------

test('decision engine waits without features instead of guessing', () => {
  const verdict = decideDirection(null, defaultRiseFallConfig());
  assert.equal(verdict.direction, null);
  assert.deepEqual(verdict.reasonCodes, ['INSUFFICIENT_TICKS']);
});

test('strong momentum names the direction and says which rule fired', () => {
  const config = sanitizeRiseFallConfig({
    tickWindow: 20,
    momentumTicks: 5,
    momentumThresholdPips: 2,
    minVolatilityPips: 0.5,
    adaptiveThresholds: false,
    strongRatio: 0.65,
  });
  const up = decideDirection(extractFeatures(risingTape(20, 1_000, PIP * 2), config, PIP), config);
  assert.equal(up.direction, 'CALL');
  assert.equal(up.rule, 'momentum');
  assert.ok(up.reasonCodes.includes('MOMENTUM_UP'));

  const down = decideDirection(extractFeatures(fallingTape(20, 1_000, PIP * 2), config, PIP), config);
  assert.equal(down.direction, 'PUT');
  assert.equal(down.rule, 'momentum');
  assert.ok(down.reasonCodes.includes('MOMENTUM_DOWN'));
});

test('continuation rule fires when the last move agrees with the window bias', () => {
  const config = sanitizeRiseFallConfig({
    tickWindow: 20,
    momentumTicks: 20,
    momentumThresholdPips: 1_000, // momentum rule can never fire
    minVolatilityPips: 0,
    adaptiveThresholds: false,
    continuationRatio: 0.55,
  });
  // Thirteen one-pip rises against six falls: a clear window bias whose net move
  // is far below the (deliberately unreachable) momentum edge.
  let quote = 1_000;
  const quotes = [quote];
  for (let index = 1; index < 20; index += 1) {
    quote += index % 3 === 0 ? -PIP : PIP;
    quotes.push(quote);
  }
  const verdict = decideDirection(extractFeatures(quotes, config, PIP), config);
  assert.equal(verdict.direction, 'CALL');
  assert.equal(verdict.rule, 'continuation');
  assert.ok(verdict.reasonCodes.includes('CONTINUATION_UP'));
});

test('a quiet tape is skipped by the volatility floor', () => {
  const config = sanitizeRiseFallConfig({ minVolatilityPips: 5, adaptiveThresholds: false });
  const verdict = decideDirection(extractFeatures(flatTape(40), config, PIP), config);
  assert.equal(verdict.direction, null);
  assert.ok(verdict.reasonCodes.includes('LOW_VOLATILITY'));
  assert.ok(verdict.reasons.some((reason) => reason.includes('Volatility floor')));
});

test('an edge below the adaptive threshold is a wait, not a trade', () => {
  const config = sanitizeRiseFallConfig({
    tickWindow: 20,
    momentumTicks: 5,
    momentumThresholdPips: 1,
    minVolatilityPips: 0,
    adaptiveThresholds: true,
    adaptiveMultiple: 3,
    strongRatio: 0.65,
    continuationRatio: 0.9,
  });
  // One-pip moves: momentum 5 pips, volatility 1 pip → the adaptive edge is 3 pips…
  const small = decideDirection(extractFeatures(risingTape(20, 1_000, PIP), config, PIP), config);
  assert.equal(small.direction, 'CALL');
  // …but a mixed tape with the same momentum and higher volatility is refused.
  const mixed = [1_000, 1_000.05, 1_000, 1_000.05, 1_000, 1_000.05, 1_000, 1_000.05, 1_000, 1_000.01,
    1_000.06, 1_000.01, 1_000.06, 1_000.01, 1_000.06, 1_000.01, 1_000.06, 1_000.01, 1_000.06, 1_000.07];
  const noisy = decideDirection(extractFeatures(mixed, config, PIP), config);
  assert.equal(noisy.direction, null);
  assert.ok(noisy.reasonCodes.includes('NO_EDGE') || noisy.reasonCodes.includes('LOW_VOLATILITY'));
});

test('the replayed rule agrees with the live rule on the same window', () => {
  const config = sanitizeRiseFallConfig({ tickWindow: 20, momentumTicks: 5, minVolatilityPips: 0.5, adaptiveThresholds: false });
  const quotes = risingTape(60, 1_000, PIP * 2);
  const lastIndex = quotes.length - 1;
  const live = decideDirection(extractFeatures(quotes, config, PIP), config);
  assert.equal(ruleFiresAtIndex(quotes, lastIndex, config, PIP), live.direction);
});

// ---------------------------------------------------------------------------
// Evidence replay and proposal economics
// ---------------------------------------------------------------------------

test('evidence replay counts what the same rule did on collected ticks', () => {
  const config = sanitizeRiseFallConfig({
    tickWindow: 20,
    momentumTicks: 5,
    momentumThresholdPips: 2,
    minVolatilityPips: 0.5,
    adaptiveThresholds: false,
    strongRatio: 0.65,
    minEvidenceSample: 5,
  });
  const evidence = evaluateSignalEvidence({ quotes: risingTape(400, 1_000, PIP * 2), config, direction: 'CALL', pipSize: PIP, horizonTicks: 5 });
  assert.ok(evidence.occurrences > config.minEvidenceSample);
  assert.equal(evidence.losses, 0);
  assert.equal(evidence.pushes, 0);
  assert.equal(evidence.winRate, 1);
  assert.equal(evidence.baselineWinRate, 1);
  assert.equal(evidence.sufficient, true);

  const wrongSide = evaluateSignalEvidence({ quotes: risingTape(400, 1_000, PIP * 2), config, direction: 'PUT', pipSize: PIP, horizonTicks: 5 });
  assert.equal(wrongSide.occurrences, 0);
  assert.equal(wrongSide.winRate, null);
  assert.equal(wrongSide.sufficient, false);
});

test('evidence replay separates a level expiry from a win or a loss', () => {
  const config = sanitizeRiseFallConfig({
    tickWindow: 10,
    momentumTicks: 3,
    momentumThresholdPips: 0.5,
    minVolatilityPips: 0,
    adaptiveThresholds: false,
    strongRatio: 0.6,
    minEvidenceSample: 1,
  });
  // Rise for a while, then hold perfectly level: expiries inside the flat run push.
  const quotes = [...risingTape(40, 1_000, PIP * 2), ...Array.from({ length: 60 }, () => 1_080)];
  const evidence = evaluateSignalEvidence({ quotes, config, direction: 'CALL', pipSize: PIP, horizonTicks: 3 });
  assert.ok(evidence.pushes > 0, 'a level expiry must be counted as a push');
  assert.ok(evidence.winRate !== null && evidence.winRate <= 1);
});

test('evidence needs a tick horizon and enough history', () => {
  const config = defaultRiseFallConfig();
  const noHorizon = evaluateSignalEvidence({ quotes: risingTape(200), config, direction: 'CALL', pipSize: PIP, horizonTicks: null });
  assert.equal(noHorizon.occurrences, 0);
  assert.equal(noHorizon.sufficient, false);
  assert.match(noHorizon.note, /tick-based expiry/);

  const tooShort = evaluateSignalEvidence({ quotes: risingTape(12), config, direction: 'CALL', pipSize: PIP, horizonTicks: 5 });
  assert.equal(tooShort.sufficient, false);
});

test('proposal economics derive break-even and expected value from Deriv numbers', () => {
  const economics = evaluateProposalEconomics({ askPrice: 1, payout: 1.95, stake: 1, winRate: 0.6, pushRate: 0 });
  assert.ok(economics);
  assert.ok(Math.abs(economics.breakEvenProbability - 1 / 1.95) < 1e-9);
  assert.ok(economics.expectedValue > 0);
  assert.ok(economics.edge > 0);
  assert.ok(economics.returnOnStake !== null && economics.returnOnStake > 0);

  const losing = evaluateProposalEconomics({ askPrice: 1, payout: 1.95, stake: 1, winRate: 0.45, pushRate: 0 });
  assert.ok(losing);
  assert.ok(losing.expectedValue < 0);

  const withPushes = evaluateProposalEconomics({ askPrice: 1, payout: 1.95, stake: 1, winRate: 0.5, pushRate: 0.2 });
  assert.ok(withPushes);
  // 0.5 × 0.95 − 0.3 × 1 = 0.175
  assert.ok(Math.abs(withPushes.expectedValue - 0.175) < 1e-9);

  assert.equal(evaluateProposalEconomics({ askPrice: 1, payout: null, stake: 1, winRate: 0.6 }), null);
  assert.equal(evaluateProposalEconomics({ askPrice: 1, payout: 1, stake: 1, winRate: 0.6 }), null);
  assert.equal(evaluateProposalEconomics({ askPrice: 1, payout: 2, stake: 1, winRate: null }), null);
});

test('a quote is refused when it does not describe the sized order', () => {
  const base = { stake: 1, spot: 1_000, spotTime: 1_700_000_000, now: 1_700_000_000_000, maxAgeMs: 15_000 };
  assert.equal(validateRiseFallQuote({ ...base, askPrice: 1, payout: 1.95 }).ok, true);
  assert.equal(validateRiseFallQuote({ ...base, askPrice: 1.5, payout: 2.9 }).ok, false, 'ask above the stake');
  assert.equal(validateRiseFallQuote({ ...base, askPrice: 1, payout: 1 }).ok, false, 'payout must exceed the ask');
  assert.equal(validateRiseFallQuote({ ...base, askPrice: 1, payout: null }).ok, false);
  assert.equal(validateRiseFallQuote({ ...base, askPrice: 1, payout: 1.95, spot: null }).ok, false);
  const stale = validateRiseFallQuote({ ...base, askPrice: 1, payout: 1.95, spotTime: 1_699_999_900 });
  assert.equal(stale.ok, false);
  assert.ok(stale.issues.some((issue) => issue.includes('old')));
});

// ---------------------------------------------------------------------------
// Risk manager: stake models
// ---------------------------------------------------------------------------

test('fixed stake never changes with results', () => {
  const config = sanitizeRiseFallConfig({ stakeMode: 'fixed', baseStake: 2 });
  assert.equal(computeStakePlan(config, { balance: 1_000, consecutiveLosses: 0 }).stake, 2);
  assert.equal(computeStakePlan(config, { balance: 1_000, consecutiveLosses: 4 }).stake, 2);
});

test('the martingale ladder multiplies, caps and then resets', () => {
  const config = sanitizeRiseFallConfig({ stakeMode: 'martingale', baseStake: 1, martingaleMultiplier: 2, maxMartingaleSteps: 3, maxStake: 1_000 });
  assert.equal(computeStakePlan(config, { balance: null, consecutiveLosses: 0 }).stake, 1);
  assert.equal(computeStakePlan(config, { balance: null, consecutiveLosses: 1 }).stake, 2);
  assert.equal(computeStakePlan(config, { balance: null, consecutiveLosses: 3 }).stake, 8);
  const exhausted = computeStakePlan(config, { balance: null, consecutiveLosses: 4 });
  assert.equal(exhausted.stake, 1, 'past the step limit the ladder resets to base');
  assert.equal(exhausted.step, 0);
  assert.ok(exhausted.notes.some((note) => note.includes('exhausted')));
});

test('the martingale ladder is still capped by the balance share and the maximum stake', () => {
  const byBalance = computeStakePlan(
    sanitizeRiseFallConfig({ stakeMode: 'martingale', baseStake: 10, martingaleMultiplier: 2, maxMartingaleSteps: 6, maxStakeShareOfBalance: 5, maxStake: 10_000 }),
    { balance: 100, consecutiveLosses: 6 },
  );
  assert.equal(byBalance.stake, 5, '5% of a 100 balance');
  assert.equal(byBalance.capped, true);

  const byMaximum = computeStakePlan(
    sanitizeRiseFallConfig({ stakeMode: 'martingale', baseStake: 10, martingaleMultiplier: 3, maxMartingaleSteps: 5, maxStake: 50, maxStakeShareOfBalance: 100 }),
    { balance: 100_000, consecutiveLosses: 4 },
  );
  assert.equal(byMaximum.stake, 50);
});

test('percentage sizing follows the live balance and falls back without one', () => {
  const config = sanitizeRiseFallConfig({ stakeMode: 'percent', riskPercent: 2, baseStake: 1, maxStakeShareOfBalance: 100, maxStake: 10_000 });
  assert.equal(computeStakePlan(config, { balance: 500, consecutiveLosses: 0 }).stake, 10);
  const fallback = computeStakePlan(config, { balance: null, consecutiveLosses: 0 });
  assert.equal(fallback.stake, 1);
  assert.ok(fallback.notes.some((note) => note.includes('base stake')));
});

test('stakes are clamped into the configured minimum and maximum', () => {
  const config = sanitizeRiseFallConfig({ stakeMode: 'fixed', baseStake: 0.01, minStake: 0.35, maxStake: 100 });
  assert.equal(computeStakePlan(config, { balance: null, consecutiveLosses: 0 }).stake, 0.35);
  const high = sanitizeRiseFallConfig({ stakeMode: 'fixed', baseStake: 5_000, minStake: 0.35, maxStake: 100 });
  assert.equal(computeStakePlan(high, { balance: null, consecutiveLosses: 0 }).stake, 100);
});

// ---------------------------------------------------------------------------
// Risk manager: purchase gate
// ---------------------------------------------------------------------------

test('the gate opens when a live bot has a fresh feed, an account and room in every limit', () => {
  const gate = evaluateRiskGate(runningGateInput());
  assert.equal(gate.allowed, true, gate.violations.join(' | '));
  assert.deepEqual(gate.violations, []);
  assert.equal(gate.stake, 1);
  assert.equal(gate.maxPossibleLoss, 1);
  assert.ok(gate.notes.length > 0);
});

test('analysis mode is reported as a note, not as a violation', () => {
  const gate = evaluateRiskGate(runningGateInput({ mode: 'analysis' }));
  assert.equal(gate.allowed, true);
  assert.ok(gate.notes.some((note) => note.includes('Analysis-only mode')));
});

test('every configured limit blocks a purchase and names itself', () => {
  const cases = [
    [{ runState: 'paused' }, 'BOT_NOT_RUNNING'],
    [{ manualPause: true, runState: 'paused' }, 'MANUAL_PAUSE'],
    [{ autoPauseReasons: ['The authenticated Deriv trading connection is not open.'] }, 'AUTO_PAUSE'],
    [{ accountAuthorized: false }, 'ACCOUNT_UNAUTHORIZED'],
    [{ connectionHealthy: false }, 'TRADING_SOCKET_CLOSED'],
    [{ feedFresh: false }, 'FEED_NOT_FRESH'],
    [{ tickCount: 3 }, 'WARMUP'],
    [{ account: { consecutiveLosses: 5 } }, 'MAX_CONSECUTIVE_LOSSES'],
    [{ account: { dailyPnl: -50 } }, 'DAILY_LOSS_LIMIT'],
    [{ account: { dailyPnl: 100 } }, 'DAILY_TAKE_PROFIT'],
    [{ config: { maxTrades: 10 }, account: { tradesThisSession: 10 } }, 'MAX_TRADES'],
    [{ openContracts: 1 }, 'MAX_OPEN_CONTRACTS'],
    [{ account: { lastSettlementAt: Date.now() } }, 'COOLDOWN'],
    [{ purchaseInFlight: true }, 'PURCHASE_IN_FLIGHT'],
    [{ unreconciledPurchase: true }, 'UNRECONCILED_PURCHASE'],
    [{ account: { balance: 0.2 } }, 'INSUFFICIENT_BALANCE'],
    [{ account: { currency: '' } }, 'CURRENCY_UNKNOWN'],
  ];
  // Exposure was previously OR-ed into the open-contract check. It is a derived
  // counter, and a settlement Deriv never repeated left it above zero, which
  // blocked every later entry for the rest of the session. The contract count is
  // the authority now; exposure is reporting only.
  const exposureOnly = evaluateRiskGate(runningGateInput({ account: { openExposure: 9 } }));
  assert.equal(exposureOnly.allowed, true, 'stale exposure no longer wedges the entry gate');
  assert.ok(!exposureOnly.codes.includes('MAX_OPEN_CONTRACTS'));

  for (const [overrides, code] of cases) {
    const gate = evaluateRiskGate(runningGateInput(overrides));
    assert.equal(gate.allowed, false, `${code} should block`);
    assert.ok(gate.codes.includes(code), `${code} missing from ${gate.codes.join(',')}`);
    assert.ok(gate.violations.length > 0);
  }
});

test('a session time limit blocks new purchases once it elapses', () => {
  const now = Date.now();
  const gate = evaluateRiskGate(runningGateInput({
    config: { maxSessionMinutes: 30 },
    account: { sessionStartedAt: now - 31 * 60_000 },
    now,
  }));
  assert.equal(gate.allowed, false);
  assert.ok(gate.codes.includes('SESSION_TIME_LIMIT'));
  assert.equal(sessionMinutesRemaining(sanitizeRiseFallConfig({ maxSessionMinutes: 30 }), { sessionStartedAt: now - 31 * 60_000 }, now), 0);
});

test('trade and session allowances are reported for the panel', () => {
  const config = sanitizeRiseFallConfig({ maxTrades: 5, maxSessionMinutes: 10 });
  const account = { ...createRiseFallAccountState(), tradesThisSession: 2, sessionStartedAt: Date.now() - 4 * 60_000 };
  assert.equal(tradesRemaining(config, account), 3);
  assert.ok(Math.abs(sessionMinutesRemaining(config, account, Date.now()) - 6) < 0.01);
  assert.equal(tradesRemaining(sanitizeRiseFallConfig({ maxTrades: 0 }), account), null);
});

// ---------------------------------------------------------------------------
// Account ledger
// ---------------------------------------------------------------------------

test('a purchase moves exposure and counters but never books a profit', () => {
  const started = beginSession({ ...createRiseFallAccountState(), currency: 'USD', balance: 100 }, 1_000);
  const after = applyPurchase(started, { stake: 2, now: 1_001 });
  assert.equal(after.grossStake, 2);
  assert.equal(after.openExposure, 2);
  assert.equal(after.tradesThisSession, 1);
  assert.equal(after.tradesToday, 1);
  assert.equal(after.sessionPnl, 0);
  // Deriv deducts the stake and reports the new balance itself; the local
  // ledger must not deduct it a second time.
  assert.equal(after.balance, 100);
});

test('a win, a loss and a push each move the ledger the way Deriv settled them', () => {
  const config = defaultRiseFallConfig();
  let account = beginSession({ ...createRiseFallAccountState(), currency: 'USD', balance: 100 }, 1_000);
  account = applyPurchase(account, { stake: 1, now: 1_001 });
  account = applySettlement(account, { stake: 1, profit: 0.95, outcome: 'win', now: 1_002 });
  assert.equal(account.wins, 1);
  assert.equal(account.consecutiveLosses, 0);
  assert.equal(account.sessionPnl, 0.95);
  assert.equal(account.dailyPnl, 0.95);
  assert.equal(account.openExposure, 0);
  assert.equal(account.lastSettlementAt, 1_002);

  account = applySettlement(account, { stake: 1, profit: -1, outcome: 'loss', now: 1_003 });
  account = applySettlement(account, { stake: 2, profit: -2, outcome: 'loss', now: 1_004 });
  assert.equal(account.losses, 2);
  assert.equal(account.consecutiveLosses, 2);
  assert.equal(account.longestLosingStreak, 2);
  assert.equal(account.sessionPnl, -2.05);

  account = applySettlement(account, { stake: 4, profit: 0, outcome: 'push', now: 1_005 });
  assert.equal(account.pushes, 1);
  assert.equal(account.wins, 1);
  assert.equal(account.losses, 2);
  assert.equal(account.consecutiveLosses, 0, 'a push breaks the losing streak');
  assert.equal(account.sessionPnl, -2.05, 'a returned stake is not a profit');
  assert.equal(computeStakePlan(config, account).stake, config.baseStake);
});

test('drawdown follows the reported balance peak to trough', () => {
  let account = { ...createRiseFallAccountState(), currency: 'USD', balance: 100 };
  account = applySettlement(account, { stake: 1, profit: 50, outcome: 'win', now: 1 });
  assert.equal(account.peakEquity, 150);
  account = applySettlement(account, { stake: 1, profit: -70, outcome: 'loss', now: 2 });
  assert.equal(account.balance, 80);
  assert.equal(account.maxDrawdown, 70);
  account = applySettlement(account, { stake: 1, profit: -5, outcome: 'loss', now: 3 });
  assert.equal(account.maxDrawdown, 75);
});

test('the daily counters roll over but the session counters do not', () => {
  const dayOne = new Date('2026-03-01T22:00:00Z').getTime();
  const dayTwo = new Date('2026-03-02T02:00:00Z').getTime();
  let account = beginSession({ ...createRiseFallAccountState(), currency: 'USD', balance: 100 }, dayOne);
  account = applyPurchase(account, { stake: 1, now: dayOne });
  account = applySettlement(account, { stake: 1, profit: -1, outcome: 'loss', now: dayOne });
  assert.equal(account.dayKey, dayKeyOf(dayOne));
  assert.equal(account.dailyPnl, -1);

  const rolled = rollTradingDay(account, dayTwo);
  assert.equal(rolled.dayKey, dayKeyOf(dayTwo));
  assert.equal(rolled.dailyPnl, 0);
  assert.equal(rolled.tradesToday, 0);
  assert.equal(rolled.sessionPnl, -1, 'the session is still the same session');
  assert.equal(rolled.tradesThisSession, 1);
});

test('a reported balance replaces the local figure without touching realised profit', () => {
  const account = { ...createRiseFallAccountState(), currency: 'USD', balance: 100, sessionPnl: 4 };
  const reconciled = reconcileBalance(account, 137.5);
  assert.equal(reconciled.balance, 137.5);
  assert.equal(reconciled.sessionPnl, 4);
  assert.equal(reconcileBalance(account, null).balance, 100);
  assert.equal(setOpenExposure(account, 12).openExposure, 12);
  assert.equal(setOpenExposure(account, -3).openExposure, 0);
});

// ---------------------------------------------------------------------------
// Configuration sanitisation
// ---------------------------------------------------------------------------

test('stored or pasted configuration is clamped into safe bounds', () => {
  const clean = sanitizeRiseFallConfig({
    baseStake: -5,
    maxStake: 0,
    martingaleMultiplier: 99,
    maxMartingaleSteps: 500,
    tickWindow: 2,
    minTicksBeforeTrade: 9_999,
    momentumTicks: 10_000,
    strongRatio: 4,
    decisionIntervalMs: 1,
    duration: 0,
    stakeMode: 'nonsense',
    durationUnit: 'weeks',
    maxConsecutiveLosses: 0,
    riskPercent: 900,
  });
  assert.equal(clean.baseStake, 0.35);
  assert.ok(clean.maxStake >= 0.35);
  assert.equal(clean.martingaleMultiplier, 5);
  assert.equal(clean.maxMartingaleSteps, 10);
  assert.equal(clean.tickWindow, 10);
  assert.equal(clean.minTicksBeforeTrade, 10, 'never more than the window itself');
  assert.equal(clean.momentumTicks, 10);
  assert.equal(clean.strongRatio, 1);
  assert.equal(clean.decisionIntervalMs, 500);
  assert.equal(clean.duration, 1);
  assert.equal(clean.stakeMode, 'fixed');
  assert.equal(clean.durationUnit, 't');
  assert.equal(clean.maxConsecutiveLosses, 1);
  assert.equal(clean.riskPercent, 25);
  assert.equal(sanitizeRiseFallConfig(null).stakeMode, 'fixed');
});

// ---------------------------------------------------------------------------
// Performance ledger, prediction scoring and CSV export
// ---------------------------------------------------------------------------

function record(overrides = {}) {
  return {
    id: `rf-${overrides.id ?? 1}`,
    at: 1_700_000_000_000,
    settledAt: null,
    mode: 'live',
    symbol: 'R_100',
    direction: 'CALL',
    rule: 'momentum',
    stake: 1,
    step: 0,
    payout: 1.95,
    contractId: 11,
    entrySpot: 1_000,
    exitSpot: null,
    status: 'open',
    profit: null,
    balanceAfter: null,
    sessionPnl: 0,
    dailyPnl: 0,
    momentumPips: 5,
    volatilityPips: 1,
    winRateEstimate: 0.6,
    expectedValue: 0.1,
    note: '',
    ...overrides,
  };
}

test('the trade summary only counts settled Deriv results', () => {
  const summary = summarizeTrades([
    record({ id: 'a', contractId: 1, status: 'won', profit: 0.95, settledAt: 1 }),
    record({ id: 'b', contractId: 2, status: 'lost', profit: -1, settledAt: 2 }),
    record({ id: 'c', contractId: 3, status: 'push', profit: 0, settledAt: 3 }),
    record({ id: 'd', contractId: 4, status: 'open' }),
    record({ id: 'e', contractId: null, status: 'rejected', stake: 0 }),
  ]);
  assert.equal(summary.purchased, 4);
  assert.equal(summary.settled, 3);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.pushes, 1);
  assert.equal(summary.open, 1);
  assert.equal(summary.rejected, 1);
  assert.ok(Math.abs(summary.netProfit - (-0.05)) < 1e-9);
  assert.equal(summary.grossStake, 4);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.bestTrade, 0.95);
  assert.equal(summary.worstTrade, -1);
});

test('signals are scored by Deriv epoch, not by a buffer index that shifts', () => {
  const observations = Array.from({ length: 30 }, (_, index) => ({ epoch: 1_000 + index, quote: 100 + index * PIP }));
  const rows = [{
    id: 'rf-1',
    at: 1,
    symbol: 'R_100',
    direction: 'CALL',
    rule: 'momentum',
    entryEpoch: 1_010,
    entryQuote: 100.1,
    horizonTicks: 5,
    stake: 1,
    winRateEstimate: null,
    resolved: false,
    expired: false,
    exitQuote: null,
    outcome: null,
    resolvedAt: null,
  }];
  const result = resolvePredictions(rows, observations, 'R_100', 2);
  assert.equal(result.resolved, 1);
  assert.equal(result.rows[0].outcome, 'win');
  assert.equal(result.rows[0].exitQuote, 100.15);

  const pruned = resolvePredictions(rows, observations.slice(20), 'R_100', 3);
  assert.equal(pruned.rows[0].expired, true, 'an entry tick that left the buffer is never scored');
  assert.equal(pruned.rows[0].resolved, false);

  const otherSymbol = resolvePredictions(rows, observations, '1HZ100V', 4);
  assert.equal(otherSymbol.resolved, 0);
});

test('the prediction summary keeps pushes and unscored rows apart', () => {
  const summary = summarizePredictions([
    { resolved: true, expired: false, outcome: 'win' },
    { resolved: true, expired: false, outcome: 'win' },
    { resolved: true, expired: false, outcome: 'loss' },
    { resolved: true, expired: false, outcome: 'push' },
    { resolved: false, expired: false, outcome: null },
    { resolved: false, expired: true, outcome: null },
  ]);
  assert.equal(summary.scored, 4);
  assert.equal(summary.pending, 1);
  assert.equal(summary.expired, 1);
  assert.ok(Math.abs(summary.hitRate - 2 / 3) < 1e-9);
});

test('the trade log exports the reference CSV columns and escapes notes', () => {
  const csv = tradesToCsv([
    record({ id: 'a', contractId: 7, status: 'won', profit: 0.95, note: 'Deriv confirmed contract 7, payout "1.95".' }),
  ]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'time,settled_time,mode,symbol,direction,rule,stake,martingale_step,payout,profit,status,contract_id,entry_spot,exit_spot,momentum_pips,volatility_pips,win_rate_estimate,expected_value,balance,session_pnl,daily_pnl,note');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('R_100'));
  assert.ok(lines[1].includes('"Deriv confirmed contract 7, payout ""1.95""."'), 'commas and quotes must be escaped');
  assert.equal(tradesToCsv([]).trim(), lines[0], 'an empty log still carries its header');
});
