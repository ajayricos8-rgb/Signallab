import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseMafiaMarket,
  measureUniformity,
  normalizeMafiaTicks,
  replayDirectionOutcomes,
  replayGatedOutcomes,
  verdictOnUniformity,
} from '../src/lib/mafia-bot/analysis.ts';
import { evaluatePairEconomics, evidenceProbability, sizeMafiaPair } from '../src/lib/mafia-bot/economics.ts';
import { evaluateMafiaEntry, mafiaSessionStop } from '../src/lib/mafia-bot/decision.ts';
import {
  applyLegPurchase,
  isPairOpen,
  mafiaPairsToCsv,
  makeMafiaPair,
  settleMafiaLeg,
  summarizeMafiaPairs,
  summarizeMafiaPredictions,
  trimMafiaPairs,
} from '../src/lib/mafia-bot/ledger.ts';
import {
  MAFIA_DURATION_TICKS,
  defaultMafiaBotConfig,
  oppositeDirection,
  sanitizeMafiaBotConfig,
} from '../src/lib/mafia-bot/types.ts';
import {
  isStepIndexMarket,
  isStepIndexSymbol,
  resolveMafiaSymbol,
  stepIndexMarkets,
} from '../src/lib/mafia-bot/universe.ts';

// ---- fixtures ------------------------------------------------------------

function ticks(quotes, startEpoch = 1_700_000_000) {
  return quotes.map((quote, index) => ({ epoch: startEpoch + index, quote }));
}

/** A tape that steps up by `step` every tick. */
function uptrend(count, step = 0.01, start = 1_000) {
  return ticks(Array.from({ length: count }, (_, index) => start + index * step));
}

/** A tape that alternates up/down: uniform in *change*, not in direction. */
function sawtooth(count, step = 0.01, start = 1_000) {
  return ticks(Array.from({ length: count }, (_, index) => start + (index % 2 === 0 ? 0 : step)));
}

function flatTape(count, quote = 1_000) {
  return ticks(Array.from({ length: count }, () => quote));
}

/**
 * A live-shaped 4-tick Rise/Fall quote. Deriv's Step-index quotes in the app
 * have been around 3.08× a stake, which is why the bot reads the payout from the
 * proposal instead of assuming a constant.
 */
const PAYOUT_MULTIPLE = 3.08;
const quotesFor = (primaryStake = 2, coverStake = 1.8) => ({
  primaryAsk: primaryStake,
  coverAsk: coverStake,
  primaryPayout: Math.round(primaryStake * PAYOUT_MULTIPLE * 100) / 100,
  coverPayout: Math.round(coverStake * PAYOUT_MULTIPLE * 100) / 100,
});

function market(symbol, name, overrides = {}) {
  return {
    symbol,
    name,
    market: 'Synthetic Indices',
    symbolType: 'Synthetic',
    pipSize: 0.01,
    precision: 2,
    exchangeOpen: true,
    tradingSuspended: false,
    ...overrides,
  };
}

function riskSnapshot(overrides = {}) {
  return {
    balance: 1_000,
    dailyNet: 0,
    sessionNet: 0,
    openPairs: 0,
    pairsThisSession: 0,
    consecutiveLosingPairs: 0,
    sessionStartedAt: 1_000,
    lastPairAt: null,
    ...overrides,
  };
}

/** Runs the whole engine over a tape so the decision can be tested end to end. */
function scenario(quotes, configPatch = {}, riskPatch = {}, quotePatch = null) {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), ...configPatch });
  const observations = quotes;
  const last = observations[observations.length - 1];
  const now = last.epoch * 1_000 + 200;
  const analysis = analyseMafiaMarket(observations, config, { symbol: 'stpRNG', now });
  const gated = replayGatedOutcomes(observations, config);
  const evaluation = evaluateMafiaEntry({
    now,
    symbol: 'stpRNG',
    mode: 'live',
    config,
    running: true,
    paused: false,
    analysis,
    gated,
    risk: riskSnapshot(riskPatch),
    quotes: quotePatch === 'none' ? null : { ...quotesFor(), ...(quotePatch ?? {}) },
    stopReason: null,
  });
  return { config, analysis, gated, evaluation, now };
}

// ---- universe ------------------------------------------------------------

test('the Mafia universe is Step indices and nothing else', () => {
  assert.equal(isStepIndexSymbol('stpRNG'), true);
  assert.equal(isStepIndexSymbol('stpRNG3'), true);
  assert.equal(isStepIndexSymbol('R_100'), false);
  assert.equal(isStepIndexSymbol('1HZ100V'), false);

  assert.equal(isStepIndexMarket('stpRNG', 'Step Index'), true);
  assert.equal(isStepIndexMarket(null, 'Step Index 2'), true);
  assert.equal(isStepIndexMarket(null, 'Volatility 100 (1s) Index'), false);
  assert.equal(isStepIndexMarket(null, 'Volatility 100 Index'), false);
  assert.equal(isStepIndexMarket('R_100', 'Volatility 100 Index'), false);
  assert.equal(isStepIndexMarket(null, undefined), false);
});

test('step index markets drop suspended and unverified symbols and keep Deriv order', () => {
  const markets = stepIndexMarkets([
    market('stpRNG3', 'Step Index 3'),
    market('stpRNG', 'Step Index'),
    market('stpRNG2', 'Step Index 2', { tradingSuspended: true }),
    market('stpRNG4', 'Step Index 4', { precision: null }),
    market('stpRNG5', 'Step Index 5', { exchangeOpen: false }),
    market('R_100', 'Volatility 100 Index'),
  ]);
  assert.deepEqual(markets.map((row) => row.symbol), ['stpRNG', 'stpRNG3']);
});

test('the bot resolves to a Step index even when another market is selected', () => {
  const symbols = [market('R_100', 'Volatility 100 Index'), market('stpRNG2', 'Step Index 2'), market('stpRNG', 'Step Index')];
  assert.equal(resolveMafiaSymbol(symbols, 'R_100')?.symbol, 'stpRNG');
  assert.equal(resolveMafiaSymbol(symbols, 'stpRNG2')?.symbol, 'stpRNG2');
  assert.equal(resolveMafiaSymbol([market('R_100', 'Volatility 100 Index')], null), null);
});

// ---- configuration -------------------------------------------------------

test('configuration sanitising clamps every input into a usable range', () => {
  const defaults = defaultMafiaBotConfig();
  const cleaned = sanitizeMafiaBotConfig({
    primaryStake: -5,
    minStake: 0.1,
    maxStake: 5,
    hedgeRatioPercent: 400,
    uniformityWindow: 4,
    minUniformity: 12,
    minUniformityZ: -3,
    minDirectionSamples: 0,
    maxOpenPairs: 99,
    stakeMode: 'yolo',
    evidenceZ: 9,
    martingaleFactor: 0.2,
  });
  assert.equal(cleaned.minStake, 0.35);
  assert.equal(cleaned.primaryStake, cleaned.minStake);
  assert.equal(cleaned.maxStake, 5);
  assert.equal(cleaned.hedgeRatioPercent, 100);
  assert.equal(cleaned.uniformityWindow, 20);
  assert.equal(cleaned.minUniformity, 1);
  assert.equal(cleaned.minUniformityZ, 0);
  assert.equal(cleaned.minDirectionSamples, 10);
  assert.equal(cleaned.maxOpenPairs, 5);
  assert.equal(cleaned.stakeMode, defaults.stakeMode);
  assert.equal(cleaned.evidenceZ, 2.58);
  assert.equal(cleaned.martingaleFactor, 1);
});

test('sanitising survives null, strings and NaN', () => {
  const cleaned = sanitizeMafiaBotConfig({ primaryStake: '3.5', maxStake: Number.NaN, uniformityWindow: null });
  assert.equal(cleaned.primaryStake, 3.5);
  assert.equal(cleaned.maxStake, defaultMafiaBotConfig().maxStake);
  assert.equal(cleaned.uniformityWindow, defaultMafiaBotConfig().uniformityWindow);
  assert.deepEqual(sanitizeMafiaBotConfig(null), defaultMafiaBotConfig());
});

test('the duration is fixed at four ticks and directions are opposites', () => {
  assert.equal(MAFIA_DURATION_TICKS, 4);
  assert.equal(oppositeDirection('CALL'), 'PUT');
  assert.equal(oppositeDirection('PUT'), 'CALL');
});

// ---- tick analysis -------------------------------------------------------

test('ticks are normalised: sorted, deduplicated by epoch, non-positive dropped', () => {
  const rows = normalizeMafiaTicks([
    { epoch: 3, quote: 101 },
    { epoch: 1, quote: 100 },
    { epoch: 3, quote: 102 },
    { epoch: 4, quote: 0 },
    { epoch: 5, quote: Number.NaN },
  ]);
  assert.deepEqual(rows, [{ epoch: 1, quote: 100 }, { epoch: 3, quote: 102 }]);
});

test('a one-directional tape is measured as uniform, with the direction attached', () => {
  const config = sanitizeMafiaBotConfig(defaultMafiaBotConfig());
  const uniformity = measureUniformity(uptrend(120), config);
  assert.equal(uniformity.available, true);
  assert.equal(uniformity.direction, 'CALL');
  assert.ok(uniformity.score > 0.9, `score ${uniformity.score}`);
  assert.ok(uniformity.directionalZ > 5);
  assert.ok(uniformity.persistenceZ > 5);
  assert.equal(uniformity.flatShare, 0);
  assert.equal(uniformity.regime, 'trend');
  assert.equal(uniformity.upTicks, config.uniformityWindow - 1);
  assert.equal(uniformity.downTicks, 0);
});

test('an alternating tape has no direction to trade', () => {
  const config = sanitizeMafiaBotConfig(defaultMafiaBotConfig());
  const uniformity = measureUniformity(sawtooth(120), config);
  assert.equal(uniformity.direction, null);
  assert.equal(uniformity.score, 0);
  assert.equal(uniformity.regime, 'chop');
  assert.ok((uniformity.reversalRate ?? 0) > 0.9);
  assert.ok(uniformity.reasonCodes.includes('CHOPPY_TAPE'));
});

test('a flat tape is refused and its flat share is reported', () => {
  const config = sanitizeMafiaBotConfig(defaultMafiaBotConfig());
  const uniformity = measureUniformity(flatTape(80), config);
  assert.equal(uniformity.direction, null);
  assert.equal(uniformity.flatShare, 1);
  assert.ok(uniformity.reasonCodes.includes('FLAT_TAPE'));
});

test('the uniformity verdict names the statistic that failed', () => {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), minUniformityZ: 4 });
  const sawVerdict = verdictOnUniformity(measureUniformity(sawtooth(120), config), config);
  assert.equal(sawVerdict.passes, false);
  assert.ok(sawVerdict.reasonCodes.length > 0);
  assert.ok(sawVerdict.headline.length > 0);

  const trendVerdict = verdictOnUniformity(measureUniformity(uptrend(400), config), config);
  assert.equal(trendVerdict.passes, true);
});

// ---- replay --------------------------------------------------------------

test('the replay keeps level windows visible as a third outcome', () => {
  // 4-tick deltas: +1, -1, 0, +1, -1, 0 …
  const quotes = ticks([100, 101, 102, 103, 104, 103, 102, 101, 100, 100, 100, 101, 102, 103, 104, 103, 102, 101]);
  const replay = replayDirectionOutcomes(quotes, 4, 500, null);
  assert.equal(replay.available, true);
  assert.equal(replay.durationTicks, 4);
  assert.equal(replay.samples, quotes.length - 4);
  assert.ok(replay.flatProbability > 0, 'a level window must appear in the sample');
  assert.ok(Math.abs((replay.riseProbability ?? 0) + (replay.fallProbability ?? 0) + (replay.flatProbability ?? 0) - 1) < 1e-9);
  assert.equal(replay.directionProbability, null);
});

test('the replay scores the direction it is given', () => {
  const replay = replayDirectionOutcomes(uptrend(200), 4, 500, 'CALL');
  assert.equal(replay.riseProbability, 1);
  assert.equal(replay.flatProbability, 0);
  assert.equal(replay.directionProbability, 1);
  const wrong = replayDirectionOutcomes(uptrend(200), 4, 500, 'PUT');
  assert.equal(wrong.directionProbability, 0);
});

test('a short tape cannot produce a replay', () => {
  const replay = replayDirectionOutcomes(ticks([100, 101, 102]), 4, 500, 'CALL');
  assert.equal(replay.available, false);
  assert.equal(replay.directionProbability, null);
  assert.ok(replay.reasonCodes.includes('NO_REPLAY'));
});

test('the gated replay only counts windows the gate would have fired on', () => {
  const config = sanitizeMafiaBotConfig(defaultMafiaBotConfig());
  const trend = replayGatedOutcomes(uptrend(400), config);
  assert.equal(trend.available, true);
  assert.ok(trend.samples > 0);
  assert.equal(trend.winRate, 1);
  assert.ok(trend.evaluated >= trend.samples);
  // The newest entry cannot be scored, so no open window is counted as a win.
  assert.ok(trend.samples <= 400 - MAFIA_DURATION_TICKS);

  const chop = replayGatedOutcomes(sawtooth(400), config);
  assert.equal(chop.available, false);
  assert.equal(chop.samples, 0);
  assert.ok(chop.reasonCodes.includes('GATED_REPLAY_EMPTY'));
});

test('the evidence haircut charges the sample for its own size', () => {
  assert.equal(evidenceProbability(null, 100, 1), null);
  assert.equal(evidenceProbability(0.7, 0, 1), null);
  assert.equal(evidenceProbability(0.7, 400, 0), 0.7);
  const small = evidenceProbability(0.7, 25, 1);
  const large = evidenceProbability(0.7, 400, 1);
  assert.ok(small < large, 'a smaller sample must be haircut harder');
  assert.ok(large < 0.7);
  assert.equal(evidenceProbability(1, 400, 1), 1);
  assert.equal(evidenceProbability(0.7, 400, 2.58), Math.max(0, 0.7 - 2.58 * Math.sqrt((0.7 * 0.3) / 400)));
});

// ---- money management ----------------------------------------------------

test('flat sizing buys the configured stake and derives the cover from it', () => {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), primaryStake: 2, hedgeRatioPercent: 40 });
  const sizing = sizeMafiaPair(config, { balance: 500, consecutiveLosingPairs: 0 });
  assert.equal(sizing.blocked, false);
  assert.equal(sizing.primaryStake, 2);
  assert.equal(sizing.coverStake, 0.8);
  assert.equal(sizing.totalStake, 2.8);
});

test('martingale compounds only up to its step cap and then stops growing', () => {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), stakeMode: 'martingale', primaryStake: 1, martingaleFactor: 2, maxMartingaleSteps: 2, maxStake: 100 });
  assert.equal(sizeMafiaPair(config, { balance: 10_000, consecutiveLosingPairs: 0 }).primaryStake, 1);
  assert.equal(sizeMafiaPair(config, { balance: 10_000, consecutiveLosingPairs: 1 }).primaryStake, 2);
  assert.equal(sizeMafiaPair(config, { balance: 10_000, consecutiveLosingPairs: 2 }).primaryStake, 4);
  assert.equal(sizeMafiaPair(config, { balance: 10_000, consecutiveLosingPairs: 9 }).primaryStake, 4);
});

test('the max stake caps the ladder before the balance share is applied', () => {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), stakeMode: 'martingale', primaryStake: 1, martingaleFactor: 2, maxMartingaleSteps: 5, maxStake: 5 });
  const sizing = sizeMafiaPair(config, { balance: 10_000, consecutiveLosingPairs: 4 });
  assert.equal(sizing.primaryStake, 5);
  assert.equal(sizing.cappedBy, 'maxStake');
});

test('the balance share scales the whole pair down and never exceeds it', () => {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), primaryStake: 10, hedgeRatioPercent: 50, maxStakeShareOfBalance: 1, maxStake: 100 });
  const sizing = sizeMafiaPair(config, { balance: 1_000, consecutiveLosingPairs: 0 });
  assert.equal(sizing.blocked, false);
  assert.equal(sizing.cappedBy, 'balanceShare');
  assert.ok(sizing.totalStake <= 10.0001, `total ${sizing.totalStake}`);
  assert.ok(Math.abs(sizing.coverStake - sizing.primaryStake * 0.5) <= 0.01);
});

test('a cover leg under Deriv minimum is blocked rather than quietly dropped', () => {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), primaryStake: 0.35, hedgeRatioPercent: 10 });
  const sizing = sizeMafiaPair(config, { balance: 500, consecutiveLosingPairs: 0 });
  assert.equal(sizing.blocked, true);
  assert.ok(sizing.reasonCodes.includes('COVER_BELOW_MIN_STAKE'));
  assert.equal(sizing.primaryStake, 0.35);
  assert.ok(sizing.reasons.some((reason) => reason.includes('Raise the stake')));
});

test('fixed-fraction sizing needs a balance and uses one when it has it', () => {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), stakeMode: 'fixed-fraction', fixedFractionPercent: 2, maxStake: 100 });
  const missing = sizeMafiaPair(config, { balance: null, consecutiveLosingPairs: 0 });
  assert.equal(missing.blocked, true);
  assert.deepEqual(missing.reasonCodes, ['BALANCE_UNKNOWN']);
  const sized = sizeMafiaPair(config, { balance: 500, consecutiveLosingPairs: 0 });
  assert.equal(sized.primaryStake, 10);
});

test('the share cap never risks more than the balance and a tiny balance is blocked', () => {
  const config = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), primaryStake: 5, hedgeRatioPercent: 100, maxStakeShareOfBalance: 100, maxStake: 100 });
  const sized = sizeMafiaPair(config, { balance: 5, consecutiveLosingPairs: 0 });
  assert.equal(sized.blocked, false);
  assert.ok(sized.totalStake <= 5, `total ${sized.totalStake}`);

  const tiny = sizeMafiaPair(config, { balance: 0.5, consecutiveLosingPairs: 0 });
  assert.equal(tiny.blocked, true);
  assert.ok(tiny.reasonCodes.includes('PRIMARY_BELOW_MIN_STAKE'));
});

// ---- pair economics ------------------------------------------------------

test('an equal-stake pair cannot profit when the payout is under 2x', () => {
  const economics = evaluatePairEconomics({
    primaryStake: 2,
    coverStake: 2,
    primaryAsk: 2,
    coverAsk: 2,
    primaryPayout: 3.8,
    coverPayout: 3.8,
    probability: 0.6,
    flatProbability: 0,
  });
  assert.equal(economics.paysLessThanCost, true);
  assert.equal(economics.primaryWinProfit, -0.2);
  assert.equal(economics.coverWinProfit, -0.2);
  assert.ok(economics.expectedValue < 0);
  assert.ok(economics.reasonCodes.includes('PAIR_ALWAYS_LOSES'));
  assert.equal(economics.breakEvenProbability, null);
  assert.ok(economics.reasonCodes.includes('BREAK_EVEN_UNDEFINED'));
});

test('a smaller cover leg gives the pair a real break-even probability', () => {
  const economics = evaluatePairEconomics({
    primaryStake: 2,
    coverStake: 0.8,
    primaryAsk: 2,
    coverAsk: 0.8,
    primaryPayout: 3.8,
    coverPayout: 1.52,
    probability: 0.6,
    flatProbability: 0,
  });
  assert.equal(economics.paysLessThanCost, false);
  assert.equal(economics.primaryWinProfit, 1);
  assert.equal(economics.coverWinProfit, -1.28);
  // p·1 + (1−p)·(−1.28) = 0 → p = 1.28 / 2.28
  assert.ok(Math.abs((economics.breakEvenProbability ?? 0) - 1.28 / 2.28) < 1e-6);
  assert.ok(Math.abs((economics.expectedValue ?? 0) - (0.6 * 1 - 0.4 * 1.28)) < 0.011);
});

test('a level window charges both stakes and lowers the expected value', () => {
  const quote = { primaryAsk: 2, coverAsk: 0.8, primaryPayout: 3.8, coverPayout: 1.52 };
  const base = evaluatePairEconomics({ primaryStake: 2, coverStake: 0.8, ...quote, probability: 0.7, flatProbability: 0 });
  const flat = evaluatePairEconomics({ primaryStake: 2, coverStake: 0.8, ...quote, probability: 0.7, flatProbability: 0.2 });
  assert.equal(flat.flatLoss, -2.8);
  assert.ok((flat.expectedValue ?? 0) < (base.expectedValue ?? 0));
  assert.ok((flat.breakEvenProbability ?? 0) > (base.breakEvenProbability ?? 0));
});

// ---- the gate ------------------------------------------------------------

test('a uniform tape with clearing evidence and quotes is a TRADE', () => {
  const { evaluation, analysis } = scenario(uptrend(400));
  assert.equal(analysis.uniformity.direction, 'CALL');
  assert.equal(evaluation.decision.action, 'TRADE', evaluation.decision.reasons.join(' | '));
  assert.equal(evaluation.decision.direction, 'CALL');
  assert.equal(evaluation.decision.primaryStake, 2);
  assert.equal(evaluation.decision.coverStake, 1.8);
  assert.ok((evaluation.evidence ?? 0) >= (evaluation.breakEven ?? 1));
  assert.ok(evaluation.decision.reasonCodes.includes('READY'));
});

test('without quotes the gate waits instead of assuming a payout', () => {
  const { evaluation } = scenario(uptrend(400), {}, {}, 'none');
  assert.equal(evaluation.decision.action, 'WAIT');
  assert.ok(evaluation.decision.reasonCodes.includes('NO_QUOTES'));
});

test('a thin tape is not traded', () => {
  const { evaluation } = scenario(uptrend(120), { minTicksBeforeTrade: 250 });
  assert.equal(evaluation.decision.action, 'WAIT');
  assert.ok(evaluation.decision.reasonCodes.includes('WARMING_UP'));
});

test('a choppy tape never reaches the money rules', () => {
  const { evaluation } = scenario(sawtooth(400));
  assert.equal(evaluation.decision.action, 'WAIT');
  assert.equal(evaluation.sizing, null);
  assert.ok(evaluation.decision.reasonCodes.length > 0);
  assert.notEqual(evaluation.decision.action, 'TRADE');
});

test('a payout too low for the pair blocks the trade even on a clean tape', () => {
  const { evaluation } = scenario(uptrend(400), {}, {}, { primaryPayout: 2.7, coverPayout: 1 });
  assert.equal(evaluation.decision.action, 'BLOCKED');
  assert.equal(evaluation.decision.actionLabel, 'Blocked by payout');
});

test('real risk limits stop the gate: open pairs, streak, daily cap, session cap', () => {
  const openLimit = scenario(uptrend(400), { maxOpenPairs: 1 }, { openPairs: 1 });
  assert.equal(openLimit.evaluation.decision.action, 'WAIT');
  assert.ok(openLimit.evaluation.decision.reasonCodes.includes('MAX_OPEN_PAIRS'));

  const streak = scenario(uptrend(400), { maxConsecutiveLosingPairs: 2 }, { consecutiveLosingPairs: 2 });
  assert.equal(streak.evaluation.decision.action, 'WAIT');
  assert.ok(streak.evaluation.decision.reasonCodes.includes('CONSECUTIVE_LOSS_STOP'));

  const daily = scenario(uptrend(400), { maxDailyLoss: 10 }, { dailyNet: -12 });
  assert.equal(daily.evaluation.decision.action, 'WAIT');
  assert.ok(daily.evaluation.decision.reasonCodes.includes('DAILY_LOSS_CAP'));

  const session = scenario(uptrend(400), { maxPairsPerSession: 3 }, { pairsThisSession: 3 });
  assert.equal(session.evaluation.decision.action, 'WAIT');
  assert.ok(session.evaluation.decision.reasonCodes.includes('SESSION_PAIR_CAP'));

  const target = scenario(uptrend(400), { dailyTakeProfit: 5 }, { dailyNet: 6 });
  assert.equal(target.evaluation.decision.action, 'WAIT');
  assert.ok(target.evaluation.decision.reasonCodes.includes('DAILY_TAKE_PROFIT'));
});

test('a session stop is reported and suppresses every entry', () => {
  const config = sanitizeMafiaBotConfig(defaultMafiaBotConfig());
  assert.equal(mafiaSessionStop({ config, risk: riskSnapshot(), now: 5_000 }), null);
  assert.ok(mafiaSessionStop({ config, risk: riskSnapshot({ dailyNet: -25 }), now: 5_000 })?.includes('Daily loss cap'));
  const timeStop = mafiaSessionStop({
    config: sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), maxSessionMinutes: 30 }),
    risk: riskSnapshot({ sessionStartedAt: 0 }),
    now: 31 * 60_000,
  });
  assert.ok(timeStop?.includes('session limit'));
});

test('a safety auto-pause blocks the pair even on a perfect tape', () => {
  const config = sanitizeMafiaBotConfig(defaultMafiaBotConfig());
  const observations = uptrend(400);
  const last = observations[observations.length - 1];
  const evaluation = evaluateMafiaEntry({
    now: last.epoch * 1_000 + 200,
    symbol: 'stpRNG',
    mode: 'live',
    config,
    running: true,
    paused: true,
    analysis: analyseMafiaMarket(observations, config, { symbol: 'stpRNG', now: last.epoch * 1_000 + 200 }),
    gated: replayGatedOutcomes(observations, config),
    risk: riskSnapshot(),
    quotes: quotesFor(),
    stopReason: 'The live tick stream is stale; new pairs wait until genuine ticks resume.',
  });
  assert.equal(evaluation.decision.action, 'WAIT');
  assert.ok(evaluation.decision.reasonCodes.includes('BOT_PAUSED'));
  assert.ok(evaluation.decision.reasons[0].includes('auto-paused'));
});

test('stale ticks stop the gate before any analysis is trusted', () => {
  const config = sanitizeMafiaBotConfig(defaultMafiaBotConfig());
  const observations = uptrend(400);
  const last = observations[observations.length - 1];
  const analysis = analyseMafiaMarket(observations, config, { symbol: 'stpRNG', now: last.epoch * 1_000 + 60_000 });
  const evaluation = evaluateMafiaEntry({
    now: last.epoch * 1_000 + 60_000,
    symbol: 'stpRNG',
    mode: 'live',
    config,
    running: true,
    paused: false,
    analysis,
    gated: replayGatedOutcomes(observations, config),
    risk: riskSnapshot(),
    quotes: quotesFor(),
    stopReason: null,
  });
  assert.equal(evaluation.decision.action, 'WAIT');
  assert.ok(evaluation.decision.reasonCodes.includes('STALE_TICKS'));
});

test('by default the bot fires the moment uniformity appears', () => {
  const defaults = defaultMafiaBotConfig();
  assert.equal(defaults.requirePositiveExpectedValue, false);
  assert.equal(defaults.minUniformity, 0.2);
  assert.equal(defaults.minUniformityZ, 1);
  assert.equal(defaults.hedgeRatioPercent, 90);

  // The screenshot case: a lean of about z 1.1 / 1.0 with a 0.29 score. It was
  // refused by the old 0.30 / 1.5 floors; it must fire now.
  const weakLean = {
    ...measureUniformity(uptrend(120), sanitizeMafiaBotConfig(defaultMafiaBotConfig())),
    score: 0.29,
    directionalZ: 1.1,
    persistenceZ: 1.0,
    direction: 'CALL',
  };
  assert.equal(verdictOnUniformity(weakLean, sanitizeMafiaBotConfig(defaultMafiaBotConfig())).passes, true);
  const oldFloors = sanitizeMafiaBotConfig({ ...defaultMafiaBotConfig(), minUniformity: 0.3, minUniformityZ: 1.5 });
  const oldVerdict = verdictOnUniformity(weakLean, oldFloors);
  assert.equal(oldVerdict.passes, false);
  assert.ok(oldVerdict.reasonCodes.includes('UNIFORMITY_BELOW_MIN'));
  assert.ok(oldVerdict.reasonCodes.includes('DIRECTIONAL_Z_LOW'));
});

test('the expected-value gate is the optional brake, not the trigger', () => {
  const config = sanitizeMafiaBotConfig(defaultMafiaBotConfig());
  const observations = uptrend(400);
  const last = observations[observations.length - 1];
  const now = last.epoch * 1_000 + 200;
  const baseAnalysis = analyseMafiaMarket(observations, config, { symbol: 'stpRNG', now });
  // A level-heavy replay: 30% of four-tick windows end where they started. That
  // is the regime where a hedge costs more than the directional lean earns.
  const analysis = {
    ...baseAnalysis,
    replay: { ...baseAnalysis.replay, flatProbability: 0.3 },
  };
  const gated = { ...replayGatedOutcomes(observations, config), winRate: 0.5, samples: 200 };
  const quotes = { primaryAsk: 2, coverAsk: 1.8, primaryPayout: 4.4, coverPayout: 3.96 };
  const run = (requirePositiveExpectedValue) => evaluateMafiaEntry({
    now,
    symbol: 'stpRNG',
    mode: 'live',
    config: sanitizeMafiaBotConfig({ ...config, requirePositiveExpectedValue }),
    running: true,
    paused: false,
    analysis,
    gated,
    risk: riskSnapshot(),
    quotes,
    stopReason: null,
  });

  const lossy = run(true);
  assert.equal(lossy.decision.action, 'WAIT');
  assert.ok(lossy.decision.reasonCodes.includes('EV_BELOW_MIN'), lossy.decision.reasonCodes.join(','));

  const firing = run(false);
  assert.equal(firing.decision.action, 'TRADE', firing.decision.reasons.join(' | '));
  assert.ok(firing.decision.reasonCodes.includes('EV_GATE_OFF'));
  assert.ok(firing.decision.reasons.some((reason) => reason.includes('not an edge')));
});

test('every failed uniformity check is reported, not just the first', () => {
  const { evaluation } = scenario(sawtooth(400));
  assert.equal(evaluation.decision.action, 'WAIT');
  assert.ok(evaluation.decision.reasonCodes.includes('NO_DIRECTION'));
  assert.ok(evaluation.decision.reasonCodes.includes('UNIFORMITY_BELOW_MIN'));
  assert.ok(evaluation.decision.reasons.length >= 2);
});

test('a pair that cannot profit is still refused with the brake off', () => {
  // Neither branch covers both stakes at this quote.
  const { evaluation } = scenario(uptrend(400), { requirePositiveExpectedValue: false }, {}, { primaryPayout: 2.7, coverPayout: 1 });
  assert.equal(evaluation.decision.action, 'BLOCKED');
  assert.equal(evaluation.decision.actionLabel, 'Blocked by payout');
});

test('the gate is deterministic for identical inputs', () => {
  const a = scenario(uptrend(400));
  const b = scenario(uptrend(400));
  assert.equal(a.evaluation.decision.action, b.evaluation.decision.action);
  assert.equal(a.evaluation.evidence, b.evaluation.evidence);
  assert.equal(a.evaluation.breakEven, b.evaluation.breakEven);
  assert.deepEqual(a.evaluation.decision.reasonCodes, b.evaluation.decision.reasonCodes);
});

// ---- ledger --------------------------------------------------------------

test('a Mafia pair settles one winner and one loser into a real net', () => {
  let pair = makeMafiaPair({
    id: 'p1', at: 1_000, symbol: 'stpRNG', mode: 'live', direction: 'CALL',
    primaryStake: 2, coverStake: 0.8, uniformity: 0.7, probability: 0.65, breakEven: 0.56, expectedValue: 0.1,
  });
  pair = applyLegPurchase(pair, 'primary', { contractId: 11, buyPrice: 2, payout: 3.8, balanceAfter: 998, startTime: 1_001, longcode: null });
  pair = applyLegPurchase(pair, 'cover', { contractId: 12, buyPrice: 0.8, payout: 1.52, balanceAfter: 997.2, startTime: 1_001, longcode: null });
  assert.equal(isPairOpen(pair), true);

  pair = settleMafiaLeg(pair, 'cover', { profit: -0.8, exitSpot: 1_000.04, settledAt: 1_010 });
  assert.equal(pair.status, 'open');
  pair = settleMafiaLeg(pair, 'primary', { profit: 1.8, exitSpot: 1_000.04, settledAt: 1_010 });
  assert.equal(pair.status, 'settled');
  assert.equal(pair.netProfit, 1);
  assert.equal(isPairOpen(pair), false);

  // A repeated report can never double-count money.
  const again = settleMafiaLeg(pair, 'primary', { profit: 99, exitSpot: 1, settledAt: 1_020 });
  assert.equal(again.netProfit, 1);
});

test('a level window loses both legs', () => {
  let pair = makeMafiaPair({
    id: 'p2', at: 2_000, symbol: 'stpRNG', mode: 'live', direction: 'PUT',
    primaryStake: 2, coverStake: 0.8, uniformity: 0.6, probability: 0.6, breakEven: 0.56, expectedValue: 0.02,
  });
  pair = applyLegPurchase(pair, 'primary', { contractId: 21, buyPrice: 2, payout: 3.8, balanceAfter: 100, startTime: 2_001, longcode: null });
  pair = applyLegPurchase(pair, 'cover', { contractId: 22, buyPrice: 0.8, payout: 1.52, balanceAfter: 99.2, startTime: 2_001, longcode: null });
  pair = settleMafiaLeg(pair, 'primary', { profit: -2, exitSpot: 1_000, settledAt: 2_010 });
  pair = settleMafiaLeg(pair, 'cover', { profit: -0.8, exitSpot: 1_000, settledAt: 2_010 });
  assert.equal(pair.netProfit, -2.8);
});

test('the P/L summary splits total, per leg and per pair outcome', () => {
  let win = makeMafiaPair({
    id: 'a', at: 1_000, symbol: 'stpRNG', mode: 'live', direction: 'CALL',
    primaryStake: 2, coverStake: 0.8, uniformity: 0.7, probability: 0.6, breakEven: 0.56, expectedValue: 0.1,
  });
  win = applyLegPurchase(win, 'primary', { contractId: 1, buyPrice: 2, payout: 3.8, balanceAfter: 0, startTime: 1, longcode: null });
  win = applyLegPurchase(win, 'cover', { contractId: 2, buyPrice: 0.8, payout: 1.52, balanceAfter: 0, startTime: 1, longcode: null });
  win = settleMafiaLeg(win, 'primary', { profit: 1.8, exitSpot: 2, settledAt: 2 });
  win = settleMafiaLeg(win, 'cover', { profit: -0.8, exitSpot: 2, settledAt: 2 });

  let loss = makeMafiaPair({
    id: 'b', at: 3_000, symbol: 'stpRNG', mode: 'live', direction: 'PUT',
    primaryStake: 2, coverStake: 0.8, uniformity: 0.7, probability: 0.6, breakEven: 0.56, expectedValue: 0.1,
  });
  loss = applyLegPurchase(loss, 'primary', { contractId: 3, buyPrice: 2, payout: 3.8, balanceAfter: 0, startTime: 3, longcode: null });
  loss = applyLegPurchase(loss, 'cover', { contractId: 4, buyPrice: 0.8, payout: 1.52, balanceAfter: 0, startTime: 3, longcode: null });
  loss = settleMafiaLeg(loss, 'primary', { profit: -2, exitSpot: 2, settledAt: 4 });
  loss = settleMafiaLeg(loss, 'cover', { profit: 0.72, exitSpot: 2, settledAt: 4 });

  let open = makeMafiaPair({
    id: 'c', at: 5_000, symbol: 'stpRNG', mode: 'live', direction: 'CALL',
    primaryStake: 2, coverStake: 0.8, uniformity: 0.7, probability: 0.6, breakEven: 0.56, expectedValue: 0.1,
  });
  open = applyLegPurchase(open, 'primary', { contractId: 5, buyPrice: 2, payout: 3.8, balanceAfter: 0, startTime: 5, longcode: null });
  open = applyLegPurchase(open, 'cover', { contractId: 6, buyPrice: 0.8, payout: 1.52, balanceAfter: 0, startTime: 5, longcode: null });

  const summary = summarizeMafiaPairs([win, loss, open]);
  assert.equal(summary.pairs, 3);
  assert.equal(summary.settled, 2);
  assert.equal(summary.open, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.primaryWins, 1);
  assert.equal(summary.coverWins, 1);
  assert.equal(summary.flatWindows, 0);
  assert.ok(Math.abs(summary.realisedProfit - (1 - 1.28)) < 1e-6);
  assert.equal(summary.totalProfit, summary.realisedProfit);
  assert.equal(summary.openStake, 2.8);
  assert.equal(summary.currentLosingStreak, 1);
  assert.ok(summary.returnOnStake !== null && summary.returnOnStake < 0);
});

test('rejected pairs never count toward stake or profit and can be trimmed apart', () => {
  const rejected = { ...makeMafiaPair({
    id: 'r', at: 1, symbol: 'stpRNG', mode: 'live', direction: 'CALL',
    primaryStake: 2, coverStake: 0.8, uniformity: null, probability: null, breakEven: null, expectedValue: null,
  }), status: 'rejected' };
  const summary = summarizeMafiaPairs([rejected]);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.settled, 0);
  assert.equal(summary.realisedProfit, 0);
  assert.equal(summary.grossStakeSettled, 0);
  assert.equal(trimMafiaPairs([rejected], 10, 1).length, 1);
  assert.equal(trimMafiaPairs([rejected], 10, 0).length, 0);
});

test('the prediction summary scores the rule, flats included', () => {
  const rows = [
    { outcome: 'primary' }, { outcome: 'cover' }, { outcome: 'flat' }, { outcome: null },
  ];
  const summary = summarizeMafiaPredictions(rows);
  assert.equal(summary.total, 4);
  assert.equal(summary.resolved, 3);
  assert.equal(summary.pending, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.flats, 1);
  assert.ok(Math.abs((summary.hitRate ?? 0) - 1 / 3) < 1e-9);
  assert.ok(Math.abs((summary.flatRate ?? 0) - 1 / 3) < 1e-9);
});

test('the CSV carries both legs and the pair economics', () => {
  const pair = makeMafiaPair({
    id: 'csv', at: 1_000, symbol: 'stpRNG', mode: 'live', direction: 'CALL',
    primaryStake: 2, coverStake: 0.8, uniformity: 0.7, probability: 0.61, breakEven: 0.56, expectedValue: 0.04,
  });
  const csv = mafiaPairsToCsv([pair]);
  const [header, row] = csv.split('\n');
  assert.ok(header.startsWith('pair_id,time,symbol,mode,status,direction'));
  assert.ok(header.includes('primary_profit'));
  assert.ok(header.includes('cover_profit'));
  assert.ok(row.includes('stpRNG'));
  assert.ok(row.includes('CALL'));
});
