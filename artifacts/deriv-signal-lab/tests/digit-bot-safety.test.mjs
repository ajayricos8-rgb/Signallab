// Automated tests for the digit-bot safety, risk, validation and accounting
// layer (specification test requirements 11–17 and 21–25).
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFinalDigit, precisionFromPipSize } from '../src/lib/digit-analysis.ts';
import {
  applyContractUpdate,
  beginPurchase,
  completePurchase,
  createExecutionState,
  failPurchase,
  hasPurchasedDecision,
  openContractCount,
  settlementMatchesRule,
  upsertMonitoredContract,
} from '../src/lib/digit-bot/execution.ts';
import {
  applyPurchase,
  applySettlement,
  beginSession,
  computeStake,
  dayKeyOf,
  entriesRemaining,
  evaluateRisk,
  reconcileBalance,
  rollTradingDay,
  sanitizeRiskConfig,
  sessionMinutesRemaining,
} from '../src/lib/digit-bot/risk.ts';
import {
  clearAutoPause,
  createSafetyState,
  engageEmergencyStop,
  pauseBot,
  registerAutoPause,
  resumeBot,
  startBot,
  stopBot,
} from '../src/lib/digit-bot/safety.ts';
import { validateTrade } from '../src/lib/digit-bot/validation.ts';
import { contractWins, createPredictionRecord, resolvePendingPredictions, separateByMode, summarizePerformance, walkForwardReport } from '../src/lib/digit-bot/performance.ts';
import { createAccountState, defaultRiskConfig } from '../src/lib/digit-bot/types.ts';

const NOW = 1_700_000_000_000;

function candidate(overrides = {}) {
  return {
    id: 'DIGITUNDER:5',
    family: 'over-under',
    contractType: 'DIGITUNDER',
    symbol: 'R_100',
    barrier: 5,
    targetDigit: null,
    winningCondition: 'Under 5 wins when the final digit is less than 5 (0, 1, 2, 3, 4)',
    estimatedProbability: 0.62,
    probabilityLowerBound: 0.55,
    probabilityUpperBound: 0.69,
    uncertainty: 0.04,
    effectiveSample: 900,
    payout: 1.9,
    stake: 1,
    netProfitIfWon: 0.9,
    netLossIfLost: -1,
    breakEvenProbability: 0.5263,
    expectedValue: 0.178,
    conservativeExpectedValue: 0.045,
    returnOnStake: 0.178,
    dataQuality: 1,
    modelValidated: true,
    riskValidated: true,
    proposalVerified: true,
    eligible: true,
    rejectionReasons: [],
    reasonCodes: ['EXPECTED_VALUE_POSITIVE'],
    score: 0.3,
    ...overrides,
  };
}

function dataQuality(overrides = {}) {
  return {
    status: 'live',
    fresh: true,
    tickCount: 800,
    validTickCount: 800,
    duplicatesDropped: 0,
    gapsDetected: 0,
    precisionVerified: true,
    requestedPrecision: 2,
    lastTickEpoch: 1_700_000_000,
    lastTickAt: NOW - 1_000,
    sourceAgeMs: 500,
    receiveAgeMs: 200,
    maxGapMs: 2_000,
    quality: 1,
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    quoteId: 'quote-9',
    askPrice: 1,
    payout: 1.9,
    spot: 1234.56,
    spotTime: 1_700_000_000,
    dateStart: 1_700_000_000,
    dateExpiry: 1_700_000_001,
    longcode: 'Win payout if the last digit of Volatility 100 Index is less than 5. Payout in USD.',
    receivedAt: NOW,
    ...overrides,
  };
}

function validationInput(overrides = {}) {
  const config = defaultRiskConfig();
  const account = { ...createAccountState(), currentBalance: 100, initialBalance: 100, currency: 'USD', accountId: 'DOT9000000', dayKey: dayKeyOf(NOW) };
  const safety = startBot(createSafetyState(), 'live');
  const risk = evaluateRisk({
    config,
    account,
    mode: 'live',
    safety,
    symbol: 'R_100',
    now: NOW,
    tickCount: 800,
    activeContracts: [],
    purchaseInFlight: false,
  });
  return {
    decisionId: 'bot-test-1',
    candidate: candidate(),
    risk,
    safety,
    mode: 'live',
    dataQuality: dataQuality(),
    modelValidated: true,
    modelValidationReason: '',
    accountAuthorized: true,
    connectionHealthy: true,
    proposal: proposal(),
    expectation: { contractType: 'DIGITUNDER', barrierDigit: 5, symbol: 'R_100', stake: 1, currency: 'USD', durationTicks: 1 },
    purchasedDecisionIds: [],
    purchaseInFlight: false,
    now: NOW,
    maxProposalAgeMs: 20_000,
    minProbabilityEdge: 0.01,
    ...overrides,
  };
}

test('11 · missing data blocks trades and leaves predictions unresolved instead of guessing', () => {
  const config = defaultRiskConfig();
  const account = createAccountState();
  const risk = evaluateRisk({
    config,
    account,
    mode: 'live',
    safety: startBot(createSafetyState(), 'live'),
    symbol: 'R_100',
    now: NOW,
    tickCount: 0,
    activeContracts: [],
    purchaseInFlight: false,
  });
  assert.equal(risk.allowed, false);
  assert.equal(risk.reasonCodes.includes('ACCOUNT_UNAVAILABLE'), true, 'no balance means no trade');
  assert.equal(risk.stake, null);

  const record = createPredictionRecord({
    id: 'p1', at: NOW, mode: 'analysis', symbol: 'R_100', currentDigit: 3, window: 500,
    modelVersions: ['A'], contractType: 'DIGITEVEN', family: 'even-odd', barrier: null,
    predictedProbability: 0.5, probabilityLowerBound: 0.47, probabilityUpperBound: 0.53,
    payout: null, stake: null, breakEvenProbability: null, expectedValue: null,
    decision: 'NO_TRADE', reasonCodes: [], reasons: [], traded: false, passedRiskChecks: false, contractId: null,
  });
  // Only one tick exists, so the settlement tick for a 1-tick contract does not.
  const partial = resolvePendingPredictions([record], [{ symbol: 'R_100', quote: 1, epoch: 1_700_000_000, pipSize: 0.01, precision: 2, digit: 3 }], 1);
  assert.equal(partial.resolved.length, 0);
  assert.equal(partial.records[0].resolved, false);
  const enough = resolvePendingPredictions([record], [
    { symbol: 'R_100', quote: 1, epoch: 1_700_000_000, pipSize: 0.01, precision: 2, digit: 3 },
    { symbol: 'R_100', quote: 2, epoch: 1_700_000_001, pipSize: 0.01, precision: 2, digit: 4 },
  ], 1);
  assert.equal(enough.resolved.length, 1);
  assert.equal(enough.records[0].outcomeDigit, 4);
  assert.equal(enough.records[0].won, true);
});

test('12 · a stale tick stream fails validation with a data reason code', () => {
  const stale = validateTrade(validationInput({ dataQuality: dataQuality({ fresh: false, status: 'stale', sourceAgeMs: 90_000 }) }));
  assert.equal(stale.ok, false);
  assert.equal(stale.codes.includes('DATA_STALE'), true);
  const unverified = validateTrade(validationInput({ dataQuality: dataQuality({ precisionVerified: false }) }));
  assert.equal(unverified.ok, false);
  assert.equal(unverified.codes.includes('PRECISION_UNVERIFIED'), true);
  const checks = stale.checks.find((check) => check.id === 'data');
  assert.equal(checks.passed, false);
});

test('13 · validation rejects proposals that do not match the intended contract', () => {
  const mismatched = validateTrade(validationInput({ proposal: proposal({ askPrice: 3 }) }));
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.codes.includes('PROPOSAL_MISMATCH') || mismatched.codes.includes('EXPECTED_VALUE_NEGATIVE'), true);
  const expired = validateTrade(validationInput({ proposal: proposal({ receivedAt: NOW - 60_000 }) }));
  assert.equal(expired.ok, false);
  assert.equal(expired.codes.includes('PROPOSAL_EXPIRED'), true);
  const wrongBarrier = validateTrade(validationInput({ proposal: proposal({ longcode: 'Win payout if the last digit is less than 7. Payout in USD.' }) }));
  assert.equal(wrongBarrier.ok, false);
  assert.equal(wrongBarrier.codes.includes('PROPOSAL_MISMATCH'), true);
  const missing = validateTrade(validationInput({ proposal: null }));
  assert.equal(missing.ok, false);
  assert.equal(missing.codes.includes('PAYOUT_MISSING'), true);
  const passing = validateTrade(validationInput());
  assert.equal(passing.ok, true);
  assert.equal(passing.codes.includes('TRADE_APPROVED'), true);
  assert.equal(passing.recalculatedEconomics.expectedValue > 0, true);
});

test('14 · stake validation respects fixed, minimum, maximum, percentage and balance rules', () => {
  const config = sanitizeRiskConfig({ ...defaultRiskConfig(), fixedStake: 1, minStake: 0.35, maxStake: 5, maxStakeShareOfBalance: 2 });
  const rich = { ...createAccountState(), currentBalance: 1_000, currency: 'USD' };
  assert.equal(computeStake(config, rich).stake, 1);
  assert.equal(computeStake({ ...config, fixedStake: 0.1 }, rich).reasonCodes.includes('STAKE_BELOW_MINIMUM'), true);
  assert.equal(computeStake({ ...config, fixedStake: 9 }, rich).reasonCodes.includes('STAKE_ABOVE_MAXIMUM'), true);
  // 2% of a 100 balance is 2, under the fixed stake ceiling.
  assert.equal(computeStake(config, { ...rich, currentBalance: 10 }).reasonCodes.includes('STAKE_ABOVE_MAXIMUM'), true);
  const percent = computeStake({ ...config, stakeMode: 'percent', percentOfBalance: 1 }, { ...rich, currentBalance: 200 });
  assert.equal(percent.stake, 2);
  assert.equal(percent.basis, 'percent-of-balance');
  const tinyBalance = computeStake({ ...config, stakeMode: 'percent', percentOfBalance: 1 }, { ...rich, currentBalance: 10 });
  assert.equal(tinyBalance.reasonCodes.includes('STAKE_BELOW_MINIMUM'), true);
  assert.equal(computeStake(config, createAccountState()).stake, 1, 'a fixed stake is still computed when the balance is unknown');
  const unknownBalanceRisk = evaluateRisk({
    config,
    account: createAccountState(),
    mode: 'live',
    safety: startBot(createSafetyState(), 'live'),
    symbol: 'R_100',
    now: NOW,
    tickCount: 100,
    activeContracts: [],
    purchaseInFlight: false,
  });
  assert.equal(unknownBalanceRisk.allowed, false);
  assert.equal(unknownBalanceRisk.reasonCodes.includes('ACCOUNT_UNAVAILABLE'), true);
});

test('15 · the daily loss limit stops trading and resets on a new calendar day', () => {
  const config = defaultRiskConfig();
  const base = { ...createAccountState(), currentBalance: 100, dailyPnl: -10, dayKey: dayKeyOf(NOW) };
  const risk = evaluateRisk({
    config, account: base, mode: 'live', safety: startBot(createSafetyState(), 'live'),
    symbol: 'R_100', now: NOW, tickCount: 500, activeContracts: [], purchaseInFlight: false,
  });
  assert.equal(risk.allowed, false);
  assert.equal(risk.reasonCodes.includes('DAILY_LOSS_LIMIT'), true);
  const nextDay = rollTradingDay(base, NOW + 86_400_000);
  assert.equal(nextDay.dailyPnl, 0);
  assert.equal(nextDay.dayKey !== base.dayKey, true);
  const allowedAgain = evaluateRisk({
    config, account: nextDay, mode: 'live', safety: startBot(createSafetyState(), 'live'),
    symbol: 'R_100', now: NOW + 86_400_000, tickCount: 500, activeContracts: [], purchaseInFlight: false,
  });
  assert.equal(allowedAgain.allowed, true);
  const sessionLimit = evaluateRisk({
    config, account: { ...base, dailyPnl: -1, sessionPnl: -5 }, mode: 'live', safety: startBot(createSafetyState(), 'live'),
    symbol: 'R_100', now: NOW, tickCount: 500, activeContracts: [], purchaseInFlight: false,
  });
  assert.equal(sessionLimit.reasonCodes.includes('SESSION_LOSS_LIMIT'), true);
});

test('16 · consecutive losses stop trading and never change the stake (no martingale)', () => {
  const config = defaultRiskConfig();
  const losing = { ...createAccountState(), currentBalance: 100, consecutiveLosses: 3, dayKey: dayKeyOf(NOW) };
  const risk = evaluateRisk({
    config, account: losing, mode: 'live', safety: startBot(createSafetyState(), 'live'),
    symbol: 'R_100', now: NOW, tickCount: 500, activeContracts: [], purchaseInFlight: false,
  });
  assert.equal(risk.allowed, false);
  assert.equal(risk.reasonCodes.includes('CONSECUTIVE_LOSS_LIMIT'), true);
  // The same stake is produced whatever the loss history is.
  const streakStakes = [0, 1, 2, 3, 5, 8].map((losses) => computeStake(config, { ...losing, consecutiveLosses: losses }).stake);
  assert.deepEqual([...new Set(streakStakes)], [0.35]);
  // Applying a settlement only counts Deriv's authoritative profit.
  const settledLoss = applySettlement(createAccountState(), { contractId: 1, stake: 1, profit: -1, symbol: 'R_100' }, NOW);
  assert.equal(settledLoss.consecutiveLosses, 1);
  assert.equal(settledLoss.realizedPnl, -1);
  assert.equal(settledLoss.sessionPnl, -1);
  const win = applySettlement(settledLoss, { contractId: 2, stake: 1, profit: 0.9, symbol: 'R_100' }, NOW + 1_000);
  assert.equal(win.consecutiveLosses, 0);
  assert.equal(win.wins, 1);
  assert.equal(win.longestLosingStreak, 1);
  const unknownProfit = applySettlement(createAccountState(), { contractId: 3, stake: 1, profit: null, symbol: 'R_100' }, NOW);
  assert.equal(unknownProfit.realizedPnl, 0, 'an unknown profit is not treated as a win or a loss');
});

test('17 · duplicate purchases are blocked for the life of the decision', () => {
  const intent = {
    decisionId: 'bot-test-1',
    family: 'over-under',
    contractType: 'DIGITUNDER',
    symbol: 'R_100',
    stake: 1,
    duration: 1,
    durationUnit: 't',
    barrier: '5',
    barrierDigit: 5,
    currency: 'USD',
    mode: 'live',
    createdAt: NOW,
    reasonCodes: [],
  };
  let state = createExecutionState();
  const first = beginPurchase(state, intent, NOW);
  assert.equal(first.ok, true);
  state = first.state;
  const concurrent = beginPurchase(state, { ...intent, decisionId: 'bot-test-2' }, NOW + 1);
  assert.equal(concurrent.ok, false, 'only one purchase may be in flight');
  const completed = completePurchase(state, intent, { contractId: 42, buyPrice: 1, payout: 1.9, balanceAfter: 99, purchaseTime: NOW / 1_000, startTime: NOW / 1_000, longcode: null, shortcode: null, transactionId: 7 }, NOW);
  state = completed.state;
  assert.equal(completed.outcome.status, 'confirmed');
  assert.equal(hasPurchasedDecision(state, 'bot-test-1'), true);
  const repeated = beginPurchase(state, intent, NOW + 2);
  assert.equal(repeated.ok, false, 'the same decision cannot buy twice');
  assert.equal(repeated.message.includes('duplicate'), true);
  const failed = failPurchase(state, { ...intent, decisionId: 'bot-test-3' }, 'Deriv rejected the request.', NOW + 3, { uncertain: false });
  assert.equal(failed.outcome.status, 'rejected');
  assert.equal(failed.state.unreconciled, undefined ?? null, 'a definite rejection leaves nothing outstanding');
  const uncertain = failPurchase(createExecutionState(), { ...intent, decisionId: 'bot-test-4' }, 'timed out', NOW + 4, { uncertain: true });
  assert.equal(uncertain.state.stage, 'unreconciled');
  const blocked = beginPurchase(uncertain.state, { ...intent, decisionId: 'bot-test-5' }, NOW + 5);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.message.includes('reconciled'), true);
  assert.equal(openContractCount(state), 1);
});

test('21 · the emergency stop blocks purchases but never claims an open contract was cancelled', () => {
  const safety = startBot(createSafetyState(), 'live');
  const stopped = engageEmergencyStop(safety, { now: NOW, by: 'user' });
  assert.equal(stopped.canPurchase, false);
  assert.equal(stopped.runState, 'emergency');
  assert.equal(stopped.reasonCodes.includes('EMERGENCY_STOP'), true);
  const risk = evaluateRisk({
    config: defaultRiskConfig(),
    account: { ...createAccountState(), currentBalance: 100, dayKey: dayKeyOf(NOW) },
    mode: 'live',
    safety: stopped,
    symbol: 'R_100',
    now: NOW,
    tickCount: 500,
    activeContracts: [],
    purchaseInFlight: false,
  });
  assert.equal(risk.allowed, false);
  assert.equal(risk.reasonCodes.includes('EMERGENCY_STOP'), true);
  const validation = validateTrade(validationInput({ safety: stopped }));
  assert.equal(validation.ok, false);
  assert.equal(validation.codes.includes('EMERGENCY_STOP'), true);

  // A contract that Deriv already accepted stays open and keeps being monitored.
  let state = createExecutionState();
  const intent = { decisionId: 'bot-live-1', family: 'over-under', contractType: 'DIGITUNDER', symbol: 'R_100', stake: 1, duration: 1, durationUnit: 't', barrier: '5', barrierDigit: 5, currency: 'USD', mode: 'live', createdAt: NOW, reasonCodes: [] };
  state = beginPurchase(state, intent, NOW).state;
  state = completePurchase(state, intent, { contractId: 77, buyPrice: 1, payout: 1.9, balanceAfter: 99, purchaseTime: NOW / 1_000, startTime: NOW / 1_000, longcode: null, shortcode: null, transactionId: null }, NOW).state;
  const afterStop = stopBot(stopped, 'live', { now: NOW + 1_000, by: 'user' });
  assert.equal(afterStop.canPurchase, false);
  assert.equal(state.contracts.length, 1);
  assert.equal(state.contracts[0].isSold, false, 'stopping the bot does not cancel or hide the contract');
  const update = applyContractUpdate(state, {
    contractId: 77, contractType: 'DIGITUNDER', symbol: 'R_100', currency: 'USD', buyPrice: 1, payout: 1.9,
    profit: -1, profitPercentage: -1, entrySpot: 1234.5, exitSpot: 1234.9, currentSpot: 1234.9, status: 'lost',
    longcode: null, shortcode: null, buyTime: NOW / 1_000, expiryTime: NOW / 1_000 + 1, isSold: true, isExpired: true,
    isValidToSell: false, tickCount: 1, tickPassed: 1, source: 'contract',
  }, { now: NOW + 5_000, pipSize: 0.1, mode: 'live' });
  assert.equal(update.settled.profit, -1);
  assert.equal(update.contract.exitDigit, 9);
  assert.equal(settlementMatchesRule(update.contract), true, 'the settled result must agree with the contract rule');
  const double = applyContractUpdate(update.state, {
    contractId: 77, contractType: 'DIGITUNDER', symbol: 'R_100', currency: 'USD', buyPrice: 1, payout: 1.9,
    profit: -1, profitPercentage: -1, entrySpot: 1234.5, exitSpot: 1234.9, currentSpot: 1234.9, status: 'lost',
    longcode: null, shortcode: null, buyTime: NOW / 1_000, expiryTime: NOW / 1_000 + 1, isSold: true, isExpired: true,
    isValidToSell: false, tickCount: 1, tickPassed: 1, source: 'contract',
  }, { now: NOW + 6_000, pipSize: 0.1, mode: 'live' });
  assert.equal(double.settled, null, 'a settlement is only credited once');
});

test('22 · analysis-only mode produces recommendations but can never prepare an order', () => {
  const analysisSafety = startBot(createSafetyState(), 'analysis');
  const config = defaultRiskConfig();
  const account = { ...createAccountState(), currentBalance: 100, dayKey: dayKeyOf(NOW) };
  const risk = evaluateRisk({
    config, account, mode: 'analysis', safety: analysisSafety, symbol: 'R_100',
    now: NOW, tickCount: 500, activeContracts: [], purchaseInFlight: false,
  });
  assert.equal(risk.allowed, false);
  assert.equal(risk.reasonCodes.includes('MODE_NOT_EXECUTABLE'), true);
  assert.equal(risk.stake, null, 'no stake is prepared when the trade is not allowed');
  // Without the dry-run flag the execution gate blocks the trade outright.
  const strict = validateTrade(validationInput({ mode: 'analysis', safety: analysisSafety }));
  assert.equal(strict.ok, false);
  assert.equal(strict.codes.includes('MODE_NOT_EXECUTABLE'), true);
  // The simulation check still reports every other gate honestly.
  const simulated = validateTrade(validationInput({ mode: 'analysis', safety: analysisSafety, dryRun: true }));
  assert.equal(simulated.checks.find((check) => check.id === 'mode').passed, true);
  assert.equal(simulated.checks.some((check) => check.id === 'expectancy' && check.passed), true);
  assert.equal(analysisSafety.canPurchase, false);
});

test('23 · paper results are stored and reported separately from live results', () => {
  const paperRecord = createPredictionRecord({
    id: 'paper-1', at: NOW, mode: 'paper', symbol: 'R_100', currentDigit: 2, window: 500,
    modelVersions: ['C'], contractType: 'DIGITMATCH', family: 'matches', barrier: 7,
    predictedProbability: 0.31, probabilityLowerBound: 0.22, probabilityUpperBound: 0.4,
    payout: 3, stake: 1, breakEvenProbability: 0.333, expectedValue: -0.07,
    decision: 'TRADE', reasonCodes: ['TRADE_APPROVED'], reasons: [], traded: true, passedRiskChecks: true, contractId: -1,
  });
  const liveRecord = createPredictionRecord({
    ...paperRecord, id: 'live-1', mode: 'live', contractId: 55, predictedProbability: 0.5,
  });
  const separation = separateByMode([paperRecord, liveRecord]);
  assert.equal(separation.paper.length, 1);
  assert.equal(separation.live.length, 1);
  assert.equal(separation.requiresLabel, true);
  const paperMetrics = summarizePerformance(separation.paper);
  const liveMetrics = summarizePerformance(separation.live);
  assert.equal(paperMetrics.sample, 1);
  assert.equal(liveMetrics.sample, 1);
  assert.equal(paperMetrics.traded, 1);
  assert.equal(liveMetrics.netProfit, 0, 'an unsettled live contract contributes no realised profit');
  const walk = walkForwardReport([paperRecord, liveRecord]);
  assert.equal(walk.splitAt, null);
  assert.equal(walk.note.includes('twenty'), true);
  assert.equal(contractWins('DIGITMATCH', 7, 7), true);
  assert.equal(contractWins('DIGITMATCH', 7, 8), false);
  assert.equal(contractWins('DIGITUNDER', 5, 5), false, 'the barrier digit loses an Under contract');
});

test('24 · live orders require an authorized account and an open trading socket', () => {
  const unauthorized = validateTrade(validationInput({ accountAuthorized: false }));
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.codes.includes('ACCOUNT_UNAUTHORIZED'), true);
  const disconnected = validateTrade(validationInput({ connectionHealthy: false }));
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.codes.includes('CONNECTION_INTERRUPTED'), true);
  const paused = validateTrade(validationInput({ safety: pauseBot(startBot(createSafetyState(), 'live'), 'live') }));
  assert.equal(paused.ok, false);
  assert.equal(paused.codes.includes('MANUAL_PAUSE'), true);
  const resumed = resumeBot(pauseBot(startBot(createSafetyState(), 'live'), 'live'), 'live');
  assert.equal(resumed.canPurchase, true);
});

test('25 · balance and profit reconciliation flags unexplained gaps and settles once', () => {
  const account = { ...createAccountState(), currentBalance: 100, initialBalance: 100, currency: 'USD' };
  const clean = reconcileBalance(account, 100, { now: NOW });
  assert.equal(clean.unexplained, false);
  assert.equal(clean.account.currentBalance, 100);
  assert.equal(clean.account.initialBalance, 100);
  // A settlement raises the locally expected balance before Deriv reports it.
  const settled = applySettlement(account, { contractId: 1, stake: 1, profit: 0.9, symbol: 'R_100' }, NOW);
  assert.equal(settled.realizedPnl, 0.9);
  assert.equal(settled.expectedBalanceDelta, 0.9);
  assert.equal(settled.openExposure, 0, 'exposure is released when the contract settles');
  const match = reconcileBalance(settled, 100.9, { now: NOW + 1_000 });
  assert.equal(match.unexplained, false);
  assert.equal(match.account.expectedBalanceDelta, 0);
  const mismatch = reconcileBalance(settled, 95, { now: NOW + 1_000 });
  assert.equal(mismatch.unexplained, true);
  assert.equal(mismatch.reasonCodes.includes('BALANCE_DISCREPANCY'), true);
  const blocked = evaluateRisk({
    config: defaultRiskConfig(),
    account: mismatch.account,
    mode: 'live',
    safety: startBot(createSafetyState(), 'live'),
    symbol: 'R_100',
    now: NOW + 1_000,
    tickCount: 500,
    activeContracts: [],
    purchaseInFlight: false,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reasonCodes.includes('BALANCE_DISCREPANCY'), true);
  // Purchase accounting records the stake without touching realised profit.
  const session = beginSession(account, NOW);
  assert.equal(session.sessionStartedAt, NOW);
  assert.equal(session.sessionPnl, 0);
  assert.equal(entriesRemaining(defaultRiskConfig(), session), defaultRiskConfig().maxEntriesPerSession);
  const purchased = applyPurchase(session, { stake: 1, symbol: 'R_100', now: NOW + 1_000, tickCount: 120 });
  assert.equal(purchased.totalStaked, 1);
  assert.equal(purchased.openExposure, 1);
  assert.equal(purchased.realizedPnl, 0);
  assert.equal(purchased.tradesToday, 1);
  assert.equal(purchased.tradesThisSession, 1);
  assert.equal(purchased.tradesBySymbol.R_100, 1);
  assert.equal(purchased.lastEntryTickCount, 120);
  assert.equal(entriesRemaining(defaultRiskConfig(), purchased), defaultRiskConfig().maxEntriesPerSession - 1);
  assert.equal(sessionMinutesRemaining(defaultRiskConfig(), purchased, NOW) === defaultRiskConfig().maxSessionMinutes, true);
  const expiredSession = sessionMinutesRemaining(defaultRiskConfig(), purchased, NOW + defaultRiskConfig().maxSessionMinutes * 60_000 + 1);
  assert.equal(expiredSession, 0);
});

test('automatic pauses are registered, deduplicated and cleared explicitly', () => {
  let safety = startBot(createSafetyState(), 'live');
  assert.equal(safety.canPurchase, true);
  safety = registerAutoPause(safety, 'The public market-data feed is reconnecting; new trades are paused until ticks resume.', 'live');
  assert.equal(safety.canPurchase, false);
  assert.equal(safety.autoPauseReasons.length, 1);
  safety = registerAutoPause(safety, 'The public market-data feed is reconnecting; new trades are paused until ticks resume.', 'live');
  assert.equal(safety.autoPauseReasons.length, 1);
  safety = clearAutoPause(safety, (reason) => reason.startsWith('The public market-data feed'), 'live');
  assert.equal(safety.autoPauseReasons.length, 0);
  assert.equal(safety.canPurchase, true);
  safety = registerAutoPause(safety, 'Balance check: mismatch', 'live');
  assert.equal(safety.reasonCodes.includes('BALANCE_DISCREPANCY'), true);
});

test('a monitored contract keeps the decision it came from and its barrier', () => {
  const contract = {
    contractId: 5, decisionId: 'bot-1', contractType: 'DIGITOVER', symbol: 'R_100', currency: 'USD',
    buyPrice: 1, payout: 1.8, stake: 1, barrierDigit: 6, entrySpot: 100.1, exitSpot: null, currentSpot: null,
    entryDigit: 1, exitDigit: null, profit: null, status: 'open', purchaseTime: 1_700_000_000, expiryTime: null,
    isSold: false, lastUpdateAt: NOW, settledProfit: null, settledAt: null, mode: 'live',
  };
  const merged = upsertMonitoredContract([contract], { ...contract, profit: -0.4, currentSpot: 100.2, lastUpdateAt: NOW + 500 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].profit, -0.4);
  assert.equal(merged[0].barrierDigit, 6);
  assert.equal(merged[0].decisionId, 'bot-1');
  const kept = upsertMonitoredContract([contract], { ...contract, profit: null, barrierDigit: null, decisionId: null });
  assert.equal(kept[0].profit, null);
  assert.equal(kept[0].decisionId, 'bot-1');
});

test('a candidate fixture used by these tests matches the engine contract', () => {
  const row = candidate();
  assert.equal(row.eligible, true);
  assert.equal(row.probabilityLowerBound > row.breakEvenProbability, true);
  assert.equal(row.conservativeExpectedValue > 0, true);
  const finalDigit = extractFinalDigit(row.stake + 1234.56, 0.01);
  assert.equal(finalDigit, extractFinalDigit(1235.56, 0.01));
  assert.equal(precisionFromPipSize(0.01), 2);
  assert.equal(typeof row.id, 'string');
});
