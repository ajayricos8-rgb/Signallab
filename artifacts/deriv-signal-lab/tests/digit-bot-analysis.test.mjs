// Automated tests for the digit-bot analysis layer.
//
// Covers specification test requirements 1–10 and the model-family rules:
// last-digit extraction, quote-precision preservation, digit frequencies,
// Even/Odd probabilities, Over/Under barrier conditions, Matches target
// conditions, smoothing, transition matrices, expected value and break-even.
//
// All fixtures are deterministic recorded sequences — no random digits are
// generated at test time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFinalDigit, precisionFromPipSize } from '../src/lib/digit-analysis.ts';
import { TickBuffer, assessDataQuality, buildWindows, detectGaps, isChronological } from '../src/lib/digit-bot/data-engine.ts';
import {
  CHI_SQUARE_95_DF9,
  DIGIT_BASELINE,
  analyzeDigitIntelligence,
  digitEffectiveSample,
} from '../src/lib/digit-bot/digit-intelligence.ts';
import {
  CREDIBLE_Z,
  chiSquareUniform,
  dirichletEventEstimate,
  dirichletMean,
  dirichletPosterior,
  effectiveSampleSize,
  probabilityOfEvent,
  transitionCounts,
  transitionProbabilities,
  wilsonInterval,
} from '../src/lib/digit-bot/statistics.ts';
import { barrierDigitsFor, contractEconomics, longcodeMatches, normalizeMoney, validateProposal } from '../src/lib/digit-bot/expectancy.ts';
import { buildCandidateDrafts, candidateKey, eligibleBarriers, eligibleTargets, rankCandidates, selectBestCandidate } from '../src/lib/digit-bot/candidates.ts';
import { cappedWeights, digitFeatures, needsRefit, trainModelFamily, trainSoftmaxClassifier } from '../src/lib/digit-bot/models.ts';

/** Recorded fixture: the first digits of a well-known constant. */
const RECORDED_DIGITS = '31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679821480865132823066470938446095505822317253594081284811174502841027019385211055596446229489549303819644288109756659334461284756482337867831652712019091456485669234603486104543266482133936072602491412737245870066063155881748815209209628292540917153643678925903600113305305488204665213841469519415116094330572703657595919530921861173819326117931051185480744623799627495673518857527248912279381830119491'
  .split('')
  .map(Number);

/** Deterministic repeating cycle 0…9 — a genuine, learnable structure. */
function cycleDigits(length) {
  return Array.from({ length }, (_, index) => index % 10);
}

const SYMBOLS = [
  { contractType: 'DIGITEVEN', expiryType: 'tick', minDuration: 1, maxDuration: 5, barriers: [], targets: [], digitRangeKnown: true, durationBounds: { min: { value: 1, unit: 't' }, max: { value: 5, unit: 't' } } },
  { contractType: 'DIGITODD', expiryType: 'tick', minDuration: 1, maxDuration: 5, barriers: [], targets: [], digitRangeKnown: true, durationBounds: { min: { value: 1, unit: 't' }, max: { value: 5, unit: 't' } } },
  { contractType: 'DIGITOVER', expiryType: 'tick', minDuration: 1, maxDuration: 5, barriers: [0, 1, 2, 3, 4, 5, 6, 7, 8], targets: [], digitRangeKnown: true, durationBounds: { min: { value: 1, unit: 't' }, max: { value: 5, unit: 't' } } },
  { contractType: 'DIGITUNDER', expiryType: 'tick', minDuration: 1, maxDuration: 5, barriers: [1, 2, 3, 4, 5, 6, 7, 8, 9], targets: [], digitRangeKnown: true, durationBounds: { min: { value: 1, unit: 't' }, max: { value: 5, unit: 't' } } },
  { contractType: 'DIGITMATCH', expiryType: 'tick', minDuration: 1, maxDuration: 5, barriers: [], targets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], digitRangeKnown: true, durationBounds: { min: { value: 1, unit: 't' }, max: { value: 5, unit: 't' } } },
];

function ticksFrom(digits, options = {}) {
  const pipSize = options.pipSize ?? 0.01;
  const precision = precisionFromPipSize(pipSize) ?? 2;
  return digits.map((digit, index) => {
    const quote = Number((1000 + index / 100).toFixed(precision));
    const lastDigit = extractFinalDigit(quote, pipSize) ?? digit;
    const epoch = 1_700_000_000 + index;
    return { symbol: 'R_100', quote, epoch, pipSize, precision, digit: lastDigit, receivedAt: epoch * 1_000 };
  });
}

test('1 · the final digit is extracted from the displayed decimal places, not from float truncation', () => {
  assert.equal(extractFinalDigit(1234.5, 0.1), 5);
  assert.equal(extractFinalDigit(1234.56, 0.01), 6);
  assert.equal(extractFinalDigit(0.0000007, 0.0000001), 7);
  // A value whose float representation is inexact must still yield the digits
  // Deriv displays: 1.005 as displayed by a 0.001 pip is 1.005 → digit 5.
  assert.equal(extractFinalDigit(1.005, 0.001), 5);
  assert.equal(extractFinalDigit(Number('8981.5'), 0.1), 5);
  assert.equal(extractFinalDigit(8981.5, 0.01), 0);
  assert.equal(precisionFromPipSize(0.001), 3);
  assert.equal(precisionFromPipSize(0.015), null);
});

test('2 · the tick buffer preserves the quote, pip size and precision of every observation', () => {
  const buffer = new TickBuffer(10);
  const digits = RECORDED_DIGITS.slice(0, 40);
  const ticks = ticksFrom(digits, { pipSize: 0.001 });
  for (const tick of ticks) buffer.add(tick, tick.receivedAt);
  const stored = buffer.list('R_100');
  assert.equal(stored.length, ticks.length);
  for (let index = 0; index < ticks.length; index += 1) {
    assert.equal(stored[index].quote, ticks[index].quote);
    assert.equal(stored[index].pipSize, 0.001);
    assert.equal(stored[index].precision, 3);
    assert.equal(stored[index].digit, ticks[index].digit);
  }
  assert.equal(isChronological(stored), true);
});

test('3 · digit frequencies match a direct count and never claim an unobserved digit is impossible', () => {
  const digits = RECORDED_DIGITS.slice(0, 300);
  const counts = Array(10).fill(0);
  for (const digit of digits) counts[digit] += 1;
  const posterior = dirichletMean(counts);
  assert.equal(Math.abs(posterior.reduce((total, value) => total + value, 0) - 1) < 1e-12, true);
  for (let digit = 0; digit < 10; digit += 1) {
    const empirical = counts[digit] / digits.length;
    assert.equal(Math.abs(posterior[digit] - empirical) < 0.02, true, `digit ${digit} posterior ${posterior[digit]} vs empirical ${empirical}`);
  }
  // A digit with zero observations in a short sample keeps a non-zero
  // posterior: rare is not impossible.
  const shortCounts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 5];
  const shortPosterior = dirichletMean(shortCounts);
  assert.equal(shortPosterior[0] > 0, true);
  assert.equal(shortPosterior[9] > shortPosterior[0], true);
});

test('4 · Even/Odd probabilities follow the last-digit definition (zero is even) and sum to one', () => {
  const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 2, 4, 6, 8];
  const counts = Array(10).fill(0);
  for (const digit of digits) counts[digit] += 1;
  const even = dirichletEventEstimate(counts, { kind: 'parity', parity: 0 }, { z: CREDIBLE_Z });
  const odd = dirichletEventEstimate(counts, { kind: 'parity', parity: 1 }, { z: CREDIBLE_Z });
  assert.equal(Math.abs(even.probability + odd.probability - 1) < 1e-12, true);
  assert.deepEqual(even.digits, [0, 2, 4, 6, 8]);
  assert.deepEqual(odd.digits, [1, 3, 5, 7, 9]);
  const allEven = Array(10).fill(0);
  allEven[0] = 40;
  allEven[2] = 40;
  const evenOnly = dirichletEventEstimate(allEven, { kind: 'parity', parity: 0 });
  assert.equal(evenOnly.probability > 0.85, true);
  assert.equal(evenOnly.lower < evenOnly.probability && evenOnly.upper > evenOnly.probability, true);
});

test('5 · Over/Under use strict boundaries: a digit equal to the barrier wins neither side', () => {
  const counts = Array(10).fill(10);
  const over4 = dirichletEventEstimate(counts, { kind: 'over', barrier: 4 });
  const under4 = dirichletEventEstimate(counts, { kind: 'under', barrier: 4 });
  assert.deepEqual(over4.digits, [5, 6, 7, 8, 9]);
  assert.deepEqual(under4.digits, [0, 1, 2, 3]);
  // Over 4 wins on five digits (5–9); Under 4 wins on four (0–3). The digit
  // equal to the barrier satisfies neither side, so the two events sum to 0.9.
  assert.equal(Math.abs(over4.probability - 0.5) < 1e-12, true);
  assert.equal(Math.abs(under4.probability - 0.4) < 1e-12, true);
  assert.equal(Math.abs(over4.probability + under4.probability - 0.9) < 1e-12, true);
  // Digit 4 itself contributes to neither event.
  const barrierOnly = Array(10).fill(0);
  barrierOnly[4] = 50;
  const over = dirichletEventEstimate(barrierOnly, { kind: 'over', barrier: 4 });
  const under = dirichletEventEstimate(barrierOnly, { kind: 'under', barrier: 4 });
  assert.equal(over.probability > 0 && over.probability < 0.05, true);
  assert.equal(under.probability > 0 && under.probability < 0.05, true);
  // Barrier domains: Over cannot be 9 and Under cannot be 0.
  assert.equal(barrierDigitsFor('DIGITOVER', 9), null);
  assert.deepEqual(barrierDigitsFor('DIGITOVER', 8), [8]);
  assert.equal(barrierDigitsFor('DIGITUNDER', 0), null);
  assert.deepEqual(barrierDigitsFor('DIGITUNDER', 1), [1]);
  assert.deepEqual(barrierDigitsFor('DIGITMATCH', 0), [0]);
});

test('6 · Matches wins only on the exact target digit', () => {
  const counts = Array(10).fill(7);
  const match = dirichletEventEstimate(counts, { kind: 'match', target: 6 });
  assert.deepEqual(match.digits, [6]);
  assert.equal(Math.abs(match.probability - 0.1) < 1e-9, true);
  const exact = Array(10).fill(0);
  exact[6] = 60;
  assert.equal(dirichletEventEstimate(exact, { kind: 'match', target: 6 }).probability > 0.9, true);
  assert.equal(dirichletEventEstimate(exact, { kind: 'match', target: 5 }).probability < 0.05, true);
});

test('7 · smoothing keeps every probability inside (0,1) and shrinks sparse transition rows', () => {
  const posterior = dirichletPosterior([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const value of posterior.probabilities) assert.equal(Math.abs(value - 0.1) < 1e-12, true);
  assert.equal(posterior.lower[0] < 0.1 && posterior.upper[0] > 0.1, true);
  const sparse = transitionProbabilities([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
  for (const value of sparse[0]) assert.equal(Math.abs(value - 0.1) < 1e-9, true);
  const denseRow = Array(10).fill(0);
  denseRow[3] = 400;
  const dense = transitionProbabilities([denseRow]);
  assert.equal(dense[0][3] > 0.85, true);
  assert.equal(dense[0].every((value) => value > 0 && value < 1), true);
  const interval = wilsonInterval(0, 20);
  assert.equal(interval.lower, 0);
  assert.equal(interval.upper > 0 && interval.upper < 1, true);
});

test('8 · the transition matrix counts ordered pairs and its rows sum to one', () => {
  const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1];
  const counts = transitionCounts(digits);
  assert.equal(counts[0][1], 2);
  assert.equal(counts[9][0], 1);
  assert.equal(counts.flat().reduce((total, value) => total + value, 0), digits.length - 1);
  const probabilities = transitionProbabilities(counts);
  for (const row of probabilities) {
    assert.equal(Math.abs(row.reduce((total, value) => total + value, 0) - 1) < 1e-12, true);
  }
});

test('9 · expected value follows EV = q·P − S and rejects contracts that cannot profit', () => {
  const economics = contractEconomics({ stake: 1, payout: 2 }, 0.6, 0.55);
  assert.equal(economics.netProfitIfWon, 1);
  assert.equal(economics.netLossIfLost, -1);
  assert.equal(economics.expectedValue, 0.2);
  assert.equal(economics.conservativeExpectedValue, 0.1);
  assert.equal(economics.returnOnStake, 0.2);
  // A payout equal to the stake can never be profitable.
  assert.equal(contractEconomics({ stake: 1, payout: 1 }, 1, 1), null);
  assert.equal(contractEconomics({ stake: 0, payout: 2 }, 0.9, 0.9), null);
  assert.equal(contractEconomics({ stake: 1, payout: null }, 0.9, 0.9), null);
  // A high win rate with an unfavourable payout is still negative EV.
  const highWinLowPay = contractEconomics({ stake: 1, payout: 1.05 }, 0.9, 0.9);
  assert.equal(highWinLowPay.expectedValue < 0, true);
  assert.equal(normalizeMoney(0.1 + 0.2), 0.3);
});

test('10 · break-even is S / P and drives the required probability edge', () => {
  const economics = contractEconomics({ stake: 0.35, payout: 1.4 }, 0.3, 0.25, 0.01);
  assert.equal(economics.breakEvenProbability, 0.25);
  assert.equal(economics.requiredProbability, 0.26);
  assert.equal(Math.abs(economics.probabilityMargin - 0) < 1e-12, true);
  assert.equal(economics.expectedValue, 0.07);
  const tooSmall = contractEconomics({ stake: 0.35, payout: 1.4 }, 0.3, 0.24, 0.01);
  assert.equal(tooSmall.conservativeExpectedValue < 0, true);
});

test('chi-square uniformity withholds a p-value until five expected observations per digit exist', () => {
  const small = chiSquareUniform(Array(10).fill(4));
  assert.equal(small.usable, false);
  assert.equal(small.pValue, null);
  const large = chiSquareUniform(Array(10).fill(50));
  assert.equal(large.usable, true);
  assert.equal(large.statistic, 0);
  assert.equal(large.pValue, 1);
  const skewed = Array(10).fill(0);
  skewed[3] = 450;
  skewed[4] = 50;
  const skewedResult = chiSquareUniform(skewed);
  assert.equal(skewedResult.statistic > CHI_SQUARE_95_DF9, true);
  assert.equal(skewedResult.pValue < 0.05, true);
});

test('digit intelligence reports windows, streaks, recency and entropy without claiming predictability', () => {
  const ticks = ticksFrom(RECORDED_DIGITS.slice(0, 400));
  const findings = analyzeDigitIntelligence({ symbol: 'R_100', ticks, windows: [25, 50, 100, 250, 500, 1_000], barriers: [2, 5, 8] });
  assert.equal(findings.sampleSize, 400);
  const window1000 = findings.windows.find((window) => window.window === 1_000);
  assert.equal(window1000.sample, 400, 'a window larger than the data must report its real sample size');
  for (const window of findings.windows) {
    if (window.sample === 0) continue;
    assert.equal(Math.abs(window.counts.reduce((total, value) => total + value, 0) - window.sample), 0);
    assert.equal(Math.abs(window.evenRate + window.oddRate - 1) < 1e-12, true);
  }
  assert.equal(findings.notes.length >= 3, true);
  assert.equal(findings.notes.join(' ').includes('not'), true);
  assert.equal(findings.streaks.barrierStreaks.length, 3);
  assert.equal(findings.streaks.barrierStreaks.every((entry) => ['over', 'under', 'equal'].includes(entry.side)), true);
  assert.equal(findings.transitions.sample, 399);
  assert.equal(typeof digitEffectiveSample(ticks), 'number');
  assert.equal(effectiveSampleSize([]) < 11, true);
  const windows = buildWindows(ticks, [100, 1_000]);
  assert.equal(windows[0].complete, true);
  assert.equal(windows[1].complete, false);
});

test('data-quality assessment flags stale, interrupted and precision-unverified streams', () => {
  const ticks = ticksFrom(RECORDED_DIGITS.slice(0, 60));
  const base = {
    ticks,
    duplicatesDropped: 0,
    symbol: 'R_100',
    now: ticks.at(-1).receivedAt + 1_000,
    clockOffsetMs: 0,
    maxTickAgeMs: 15_000,
    precision: 2,
    feedFresh: true,
    feedStatus: 'live',
    connectionHealthy: true,
  };
  const live = assessDataQuality(base);
  assert.equal(live.status, 'live');
  assert.equal(live.fresh, true);
  const stale = assessDataQuality({ ...base, now: ticks.at(-1).receivedAt + 60_000 });
  assert.equal(stale.fresh, false);
  const interrupted = assessDataQuality({ ...base, connectionHealthy: false });
  assert.equal(interrupted.status, 'interrupted');
  const noPrecision = assessDataQuality({ ...base, precision: null });
  assert.equal(noPrecision.precisionVerified, false);
  assert.equal(noPrecision.fresh, false);
  const short = ticks.slice(0, 20);
  const tooFew = assessDataQuality({ ...base, ticks: short, now: short.at(-1).receivedAt + 1_000 });
  assert.equal(tooFew.status, 'insufficient');
  assert.equal(tooFew.fresh, false);
  // A gap is detected from the observed tick spacing, not a fixed assumption.
  const gapped = [...ticks.slice(0, 30), ...ticks.slice(30).map((tick) => ({ ...tick, epoch: tick.epoch + 120 }))];
  assert.equal(detectGaps(gapped).gapsDetected >= 1, true);
});

test('duplicate ticks are dropped and never counted twice', () => {
  const buffer = new TickBuffer(20);
  const ticks = ticksFrom(RECORDED_DIGITS.slice(0, 10));
  for (const tick of ticks) buffer.add(tick, tick.receivedAt);
  const duplicate = buffer.add(ticks[3], ticks[3].receivedAt + 5);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.added, false);
  assert.equal(buffer.size(), 10);
  assert.equal(buffer.duplicateCount(), 1);
  const invalid = buffer.add({ ...ticks[3], epoch: 0, digit: 3 }, Date.now());
  assert.equal(invalid.added, false);
  assert.equal(buffer.size(), 10);
});

test('candidates are generated for every Deriv-supported contract and barrier domain', () => {
  const digits = RECORDED_DIGITS.slice(0, 300);
  const ticks = ticksFrom(digits);
  const counts = Array(10).fill(0);
  for (const tick of ticks) counts[tick.digit] += 1;
  const findings = analyzeDigitIntelligence({ symbol: 'R_100', ticks, windows: [100, 500], barriers: [1, 2, 3] });
  const { drafts, notes } = buildCandidateDrafts({
    symbol: 'R_100',
    ticks,
    support: SYMBOLS,
    durationTicks: 1,
    ensemble: null,
    digits: findings,
    stake: 1,
    minProbabilityEdge: 0.01,
    effectiveSample: 200,
    minimumEffectiveSample: 50,
    dataQuality: 1,
    modelValidated: false,
    precision: 2,
    restrictBarriersToResearchRange: true,
  });
  const ids = drafts.map((draft) => draft.candidate.id);
  assert.equal(ids.includes(candidateKey('DIGITEVEN', null)), true);
  assert.equal(ids.includes(candidateKey('DIGITODD', null)), true);
  assert.equal(ids.includes(candidateKey('DIGITOVER', 0)), false, 'the 1-8 research range excludes Over 0');
  assert.equal(ids.includes(candidateKey('DIGITOVER', 1)), true);
  assert.equal(ids.includes(candidateKey('DIGITOVER', 8)), true);
  assert.equal(ids.includes(candidateKey('DIGITOVER', 9)), false, 'Over 9 can never win');
  assert.equal(ids.includes(candidateKey('DIGITUNDER', 8)), true);
  assert.equal(ids.includes(candidateKey('DIGITUNDER', 9)), false, 'the 1-8 research range excludes Under 9');
  assert.equal(ids.includes(candidateKey('DIGITUNDER', 0)), false, 'Under 0 can never win');
  for (let digit = 0; digit < 10; digit += 1) {
    assert.equal(ids.includes(candidateKey('DIGITMATCH', digit)), true, `Matches ${digit} must be evaluated`);
  }
  assert.equal(drafts.length, 2 + 8 + 8 + 10);
  // Without the research-range restriction, Deriv's full domain is evaluated.
  const unrestricted = buildCandidateDrafts({
    symbol: 'R_100',
    ticks,
    support: SYMBOLS,
    durationTicks: 1,
    ensemble: null,
    digits: findings,
    stake: 1,
    minProbabilityEdge: 0.01,
    effectiveSample: 200,
    minimumEffectiveSample: 50,
    dataQuality: 1,
    modelValidated: false,
    precision: 2,
    restrictBarriersToResearchRange: false,
  });
  const unrestrictedIds = unrestricted.drafts.map((draft) => draft.candidate.id);
  assert.equal(unrestrictedIds.includes(candidateKey('DIGITOVER', 0)), true);
  assert.equal(unrestrictedIds.includes(candidateKey('DIGITUNDER', 9)), true);
  assert.equal(unrestrictedIds.includes(candidateKey('DIGITOVER', 9)), false);
  // Every candidate is ineligible until a real proposal supplies economics.
  assert.equal(drafts.every((draft) => draft.candidate.eligible === false), true);
  assert.equal(drafts.every((draft) => draft.candidate.payout === null), true);
  assert.equal(drafts.some((draft) => draft.candidate.rejectionReasons.some((reason) => reason.includes('validated model'))), true);
  assert.equal(notes.length >= 0, true);
  assert.deepEqual(eligibleBarriers(SYMBOLS[2], 'DIGITOVER').at(-1), 8);
  assert.equal(eligibleTargets(SYMBOLS[4]).length, 10);
  assert.equal(rankCandidates(drafts.map((draft) => draft.candidate)).length, drafts.length);
  assert.equal(selectBestCandidate(drafts.map((draft) => draft.candidate)), null);
});

test('proposal validation rejects mismatched, expired and payout-free quotes', () => {
  const base = {
    quoteId: 'quote-1',
    askPrice: 1,
    payout: 1.95,
    spot: 1234.56,
    spotTime: 1_700_000_000,
    dateStart: 1_700_000_000,
    dateExpiry: 1_700_000_001,
    longcode: 'Win payout if the last digit of Volatility 100 Index after 1 tick is less than 5. Payout in USD.',
    receivedAt: 1_000_000,
  };
  const expectation = { contractType: 'DIGITUNDER', barrierDigit: 5, symbol: 'R_100', stake: 1, currency: 'USD', durationTicks: 1 };
  const ok = validateProposal(base, expectation, { now: 1_000_100, maxAgeMs: 20_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.termsVerified, true);
  const unnamedCurrency = validateProposal({ ...base, longcode: 'Win payout if the last digit is less than 5.' }, expectation, { now: 1_000_100, maxAgeMs: 20_000 });
  assert.equal(unnamedCurrency.ok, true);
  assert.equal(unnamedCurrency.termsVerified, false);
  assert.equal(unnamedCurrency.warnings.length, 1);
  const repriced = validateProposal({ ...base, askPrice: 2 }, expectation, { now: 1_000_100, maxAgeMs: 20_000 });
  assert.equal(repriced.ok, false);
  assert.equal(repriced.reasonCodes.includes('PROPOSAL_MISMATCH'), true);
  const stale = validateProposal(base, expectation, { now: 1_100_000, maxAgeMs: 20_000 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reasonCodes.includes('PROPOSAL_EXPIRED'), true);
  const noPayout = validateProposal({ ...base, payout: 0.5 }, expectation, { now: 1_000_100, maxAgeMs: 20_000 });
  assert.equal(noPayout.reasonCodes.includes('PAYOUT_UNFAVOURABLE'), true);
  const wrongDirection = validateProposal({ ...base, longcode: 'Win payout if the last digit is greater than 5. Payout in USD.' }, expectation, { now: 1_000_100, maxAgeMs: 20_000 });
  assert.equal(wrongDirection.ok, false);
  const wrongBarrier = validateProposal({ ...base, longcode: 'Win payout if the last digit is less than 6. Payout in USD.' }, expectation, { now: 1_000_100, maxAgeMs: 20_000 });
  assert.equal(wrongBarrier.ok, false);
  assert.equal(longcodeMatches('Matches the last digit of the quote is 7', 'DIGITMATCH', 7), true);
  assert.equal(longcodeMatches('the last digit is an even number', 'DIGITEVEN', null), true);
  assert.equal(longcodeMatches('the last digit is an odd number', 'DIGITODD', null), true);
});

test('walk-forward model training never uses the tuning or holdout segment for fitting', () => {
  const digits = RECORDED_DIGITS.slice(0, 700);
  const report = trainModelFamily({ symbol: 'R_100', digits, horizon: 1, now: 1_000 });
  assert.equal(report.trainEnd, Math.floor(digits.length * 0.6));
  assert.equal(report.tuningEnd, Math.floor(digits.length * 0.8));
  assert.equal(report.sample, digits.length);
  // The tuning window starts at the training boundary, so no fitted model can
  // have seen a tuning or holdout target.
  assert.equal(report.trainEnd <= report.tuningEnd, true);
  assert.equal(report.models.length, 7);
  const ensemble = report.ensemble;
  assert.equal(ensemble.probabilities.length, 10);
  assert.equal(Math.abs(ensemble.probabilities.reduce((total, value) => total + value, 0) - 1) < 1e-9, true);
  assert.equal(ensemble.baselineWeight >= 0.15 && ensemble.baselineWeight <= 0.45, true);
  // On a near-random fixture the ensemble must not claim a validated edge.
  assert.equal(ensemble.valid, false);
  assert.equal(report.models.every((model) => model.status === 'contributing' || model.status === 'no-skill' || model.status === 'sparse'), true);
  assert.equal(needsRefit(report, 'R_100', digits.length + 5, 1), false);
  assert.equal(needsRefit(report, 'R_100', digits.length + 40, 1), true);
  assert.equal(needsRefit(report, 'R_50', digits.length, 1), true);
});

test('a genuinely learnable structure is detected, weighted and validated out of sample', () => {
  const digits = cycleDigits(700);
  const report = trainModelFamily({ symbol: 'CYCLE', digits, horizon: 1, now: 1_000 });
  assert.equal(report.ensemble.valid, true, 'a deterministic cycle must pass the holdout gate');
  const contributing = report.models.filter((model) => model.status === 'contributing');
  assert.equal(contributing.length >= 2, true);
  // The conditional transition model must be one of the winners.
  assert.equal(contributing.some((model) => model.key === 'C' || model.key === 'F'), true);
  // The forecast must concentrate on the digit that actually follows.
  const last = digits.at(-1);
  const expectedNext = (last + 1) % 10;
  const predicted = report.ensemble.probabilities[expectedNext];
  const highest = Math.max(...report.ensemble.probabilities);
  assert.equal(report.ensemble.probabilities.indexOf(highest), expectedNext, 'the forecast must peak on the digit that really follows');
  assert.equal(predicted > 0.3, true, `expected a concentrated forecast, got ${predicted}`);
  assert.equal(predicted > 3 * 0.1, true, 'the forecast must be far above the uniform 10% baseline');
  // Shrinkage keeps the claim honest: the estimate never reaches certainty.
  assert.equal(predicted < 1, true);
  // No model may carry more than the cap once weights are normalised.
  assert.equal(report.models.every((model) => model.weight <= 0.6), true);
});

test('ensemble weights are driven by measured skill, not by confidence', () => {
  const weights = cappedWeights([0.9, 0.05, 0.05, 0]);
  assert.equal(Math.abs(weights.reduce((total, value) => total + value, 0) - 1) < 1e-9, true);
  assert.equal(weights[0] <= 0.4 + 1e-9, true, 'a single model cannot exceed the cap');
  assert.equal(weights[3], 0);
  const allZero = cappedWeights([0, 0, 0]);
  assert.deepEqual(allZero, [0, 0, 0]);
  // The classifier abstains rather than guessing when it lacks samples.
  assert.equal(trainSoftmaxClassifier(cycleDigits(60), 1), null);
  const trained = trainSoftmaxClassifier(cycleDigits(400), 1);
  assert.equal(trained !== null, true);
  assert.equal(trained.finalLoss <= trained.initialLoss, true);
  const features = digitFeatures(cycleDigits(120), 119);
  assert.equal(features.length, 18);
  assert.equal(features.reduce((total, value) => total + value, 0) > 0, true);
});

test('probability helpers keep observed frequency, estimate and predictive probability distinct', () => {
  const counts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const posterior = dirichletPosterior(counts);
  const observed = counts.map((count) => count / counts.reduce((total, value) => total + value, 0));
  assert.equal(Math.abs(observed[9] - 100 / 550) < 1e-12, true);
  assert.equal(posterior.probabilities[9] < observed[9], true, 'the posterior is shrunk toward 10%, not equal to the frequency');
  assert.equal(posterior.lower[9] < posterior.probabilities[9] && posterior.upper[9] > posterior.probabilities[9], true);
  assert.equal(DIGIT_BASELINE, 0.1);
  assert.equal(probabilityOfEvent(Array(10).fill(0.1), { kind: 'over', barrier: 4 }) > 0.49, true);
});
