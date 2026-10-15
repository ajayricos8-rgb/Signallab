import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNAL_BOT_LIMITS,
  SIGNAL_BOT_RUNS_BY_STRENGTH,
  defaultSignalBotConfig,
  maxLadderStake,
  nextRunDecision,
  recommendedRuns,
  resolveMaxRuns,
  sanitizeSignalBotConfig,
  settlementTimeoutMs,
  stakeForRun,
  summarizeBotRuns,
} from '../src/lib/signal-bot/plan.ts';

// ---- runs the analysis is worth -------------------------------------------

test('a strong signal is worth the most runs, a weak one the fewest', () => {
  const strong = recommendedRuns({ confidence: 60, strength: 'STRONG' });
  const moderate = recommendedRuns({ confidence: 60, strength: 'MODERATE' });
  const weak = recommendedRuns({ confidence: 60, strength: 'WEAK' });
  assert.equal(strong, SIGNAL_BOT_RUNS_BY_STRENGTH.STRONG);
  assert.equal(moderate, SIGNAL_BOT_RUNS_BY_STRENGTH.MODERATE);
  assert.equal(weak, SIGNAL_BOT_RUNS_BY_STRENGTH.WEAK);
  assert.ok(strong > moderate && moderate > weak);
});

test('confidence nudges the run count up or down by one run per 10 points', () => {
  assert.equal(recommendedRuns({ confidence: 90, strength: 'STRONG' }), SIGNAL_BOT_RUNS_BY_STRENGTH.STRONG + 3);
  assert.equal(recommendedRuns({ confidence: 40, strength: 'WEAK' }), SIGNAL_BOT_RUNS_BY_STRENGTH.WEAK - 2);
});

test('the run count always stays inside 1..100', () => {
  for (const confidence of [-50, 0, 33, 50, 99, 140, Number.NaN]) {
    for (const strength of ['STRONG', 'MODERATE', 'WEAK']) {
      const runs = recommendedRuns({ confidence, strength });
      assert.ok(runs >= 1 && runs <= 100, `${runs} out of range for ${strength} @ ${confidence}`);
    }
  }
});

test('the dock runs box wins, otherwise the analysis decides', () => {
  const config = { ...defaultSignalBotConfig(), maxRuns: 7 };
  assert.equal(resolveMaxRuns(config, 20), 7);
  assert.equal(resolveMaxRuns({ ...config, maxRuns: 0 }, 20), 20);
  assert.equal(resolveMaxRuns({ ...config, maxRuns: 0 }, 0), 1);
  assert.equal(resolveMaxRuns({ ...config, maxRuns: 1e6 }, 20), 100);
});

// ---- martingale ladder ----------------------------------------------------

test('the ladder is flat when the multiplier or the step limit says so', () => {
  const config = { ...defaultSignalBotConfig(), baseStake: 1, martingaleMultiplier: 2, maxMartingaleSteps: 3 };
  assert.deepEqual(stakeForRun({ ...config, martingaleMultiplier: 1 }, 2), { stake: 1, step: 0, exhausted: false });
  assert.deepEqual(stakeForRun({ ...config, maxMartingaleSteps: 0 }, 2), { stake: 1, step: 0, exhausted: false });
});

test('the stake multiplies with the losing streak up to the step limit', () => {
  const config = { ...defaultSignalBotConfig(), baseStake: 1, martingaleMultiplier: 2, maxMartingaleSteps: 3 };
  assert.deepEqual(stakeForRun(config, 0), { stake: 1, step: 0, exhausted: false });
  assert.deepEqual(stakeForRun(config, 1), { stake: 2, step: 1, exhausted: false });
  assert.deepEqual(stakeForRun(config, 3), { stake: 8, step: 3, exhausted: false });
});

test('past the last step the ladder resets to the base stake instead of exploding', () => {
  const config = { ...defaultSignalBotConfig(), baseStake: 0.5, martingaleMultiplier: 2, maxMartingaleSteps: 2 };
  assert.deepEqual(stakeForRun(config, 5), { stake: 0.5, step: 0, exhausted: true });
  assert.equal(maxLadderStake(config), 2);
});

test('stakes are rounded to two decimals', () => {
  const config = { ...defaultSignalBotConfig(), baseStake: 0.35, martingaleMultiplier: 1.7, maxMartingaleSteps: 4 };
  assert.equal(stakeForRun(config, 3).stake, Number((0.35 * 1.7 ** 3).toFixed(2)));
});

// ---- configuration hygiene ------------------------------------------------

test('configuration is clamped into the documented limits', () => {
  const config = sanitizeSignalBotConfig({
    baseStake: -4,
    martingaleMultiplier: 99,
    maxMartingaleSteps: 40,
    stopLossStreak: -1,
    maxRuns: 1e9,
  });
  assert.equal(config.baseStake, SIGNAL_BOT_LIMITS.stake.min);
  assert.equal(config.martingaleMultiplier, SIGNAL_BOT_LIMITS.martingaleMultiplier.max);
  assert.equal(config.maxMartingaleSteps, SIGNAL_BOT_LIMITS.maxMartingaleSteps.max);
  assert.equal(config.stopLossStreak, 0);
  assert.equal(config.maxRuns, SIGNAL_BOT_LIMITS.maxRuns.max);
});

test('a missing or broken configuration falls back to the defaults', () => {
  assert.deepEqual(sanitizeSignalBotConfig(null), defaultSignalBotConfig());
  assert.deepEqual(sanitizeSignalBotConfig({ baseStake: Number.NaN, martingaleMultiplier: 'x' }), {
    ...defaultSignalBotConfig(),
    baseStake: defaultSignalBotConfig().baseStake,
  });
});

// ---- when the bot may buy again -------------------------------------------

test('the bot stops once the runs from the analysis are used up', () => {
  const config = { ...defaultSignalBotConfig(), stopLossStreak: 0 };
  assert.deepEqual(nextRunDecision({ status: 'running', runsStarted: 10, targetRuns: 10, lossStreak: 0, config }), {
    buy: false,
    reason: 'runs',
  });
  assert.deepEqual(nextRunDecision({ status: 'running', runsStarted: 9, targetRuns: 10, lossStreak: 0, config }), {
    buy: true,
    reason: null,
  });
});

test('the stop loss trips on the configured losing streak and only then', () => {
  const config = { ...defaultSignalBotConfig(), stopLossStreak: 3 };
  assert.deepEqual(nextRunDecision({ status: 'running', runsStarted: 4, targetRuns: 20, lossStreak: 2, config }), {
    buy: true,
    reason: null,
  });
  assert.deepEqual(nextRunDecision({ status: 'running', runsStarted: 4, targetRuns: 20, lossStreak: 3, config }), {
    buy: false,
    reason: 'stop-loss',
  });
  // A disabled stop loss never stops the bot.
  const off = { ...config, stopLossStreak: 0 };
  assert.equal(nextRunDecision({ status: 'running', runsStarted: 4, targetRuns: 20, lossStreak: 9, config: off }).buy, true);
});

test('a bot that is not running never buys', () => {
  const config = defaultSignalBotConfig();
  for (const status of ['idle', 'stopped', 'completed', 'error']) {
    assert.equal(nextRunDecision({ status, runsStarted: 0, targetRuns: 20, lossStreak: 0, config }).buy, false);
  }
});

// ---- settlement patience --------------------------------------------------

test('the settlement wait scales with the contract but stays sane', () => {
  assert.ok(settlementTimeoutMs(5, 't') >= 45_000);
  assert.ok(settlementTimeoutMs(1, 't') < settlementTimeoutMs(10, 't'));
  assert.ok(settlementTimeoutMs(5, 'm') > settlementTimeoutMs(5, 's'));
  assert.equal(settlementTimeoutMs(10_000, 'm'), 600_000);
});

// ---- the page summary -----------------------------------------------------

function run(status, profit, overrides = {}) {
  return {
    index: 1,
    contractId: 1,
    contractLabel: 'RISE · 5 ticks',
    marketCode: 'R_50',
    stake: 1,
    payout: 1.9,
    martingaleStep: 0,
    status,
    profit,
    openedAt: 1_000,
    settledAt: 2_000,
    note: '',
    ...overrides,
  };
}

test('the summary counts settled runs, money and the win rate', () => {
  const config = defaultSignalBotConfig();
  const summary = summarizeBotRuns(
    [run('won', 0.9), run('lost', -1), run('won', 0.9), run('open', null), run('failed', null, { contractId: null, stake: 4 })],
    config,
  );
  assert.equal(summary.started, 5);
  assert.equal(summary.settled, 3);
  assert.equal(summary.wins, 2);
  assert.equal(summary.losses, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.open, 1);
  assert.equal(summary.profit, 0.8);
  // Every bought contract is staked (including the open one); a refused order
  // never reached Deriv, so its stake is not counted.
  assert.equal(summary.staked, 4);
  assert.equal(summary.winRate, 2 / 3);
});

test('the losing streak survives open runs and sizes the next stake', () => {
  const config = { ...defaultSignalBotConfig(), baseStake: 1, martingaleMultiplier: 2, maxMartingaleSteps: 3 };
  const summary = summarizeBotRuns([run('won', 0.9), run('lost', -1), run('lost', -2), run('open', null)], config);
  assert.equal(summary.lossStreak, 2);
  assert.equal(summary.nextMartingaleStep, 2);
  // One win from three settled runs; the open run is not settled yet.
  assert.equal(summary.winRate, 1 / 3);
});

test('a win clears the losing streak', () => {
  const config = { ...defaultSignalBotConfig(), martingaleMultiplier: 2, maxMartingaleSteps: 3 };
  const summary = summarizeBotRuns([run('lost', -1), run('lost', -2), run('won', 3.8)], config);
  assert.equal(summary.lossStreak, 0);
  assert.equal(summary.nextMartingaleStep, 0);
});

test('an empty page summarises to zeros', () => {
  const summary = summarizeBotRuns([], defaultSignalBotConfig());
  assert.equal(summary.started, 0);
  assert.equal(summary.profit, 0);
  assert.equal(summary.winRate, null);
  assert.equal(summary.nextMartingaleStep, 0);
});
