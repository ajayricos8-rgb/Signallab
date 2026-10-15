import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDigits } from '../src/lib/digit-analysis.ts';
import { runResearchRanking } from '../src/lib/digit-signals.ts';
import { buildDigitQuantContext, digitConsensus, runConditionedFollowThrough, winningDigits, uniformWinRate } from '../src/lib/digit-consensus.ts';
import { buildConsensus, confidenceGrade, engineVote, confidenceFactor } from '../src/lib/signal-confidence.ts';
import { publishedDirection, riseFallConsensus, riseFallQuantMetrics } from '../src/lib/rise-fall-consensus.ts';
import { analyzeRiseFall } from '../src/lib/rise-fall-analysis.ts';
import { normalizeActiveSymbols, normalizeContractSupport } from '../src/lib/deriv-digit-metadata.ts';

const contracts = normalizeContractSupport(
  ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH'].map((contract_type) => ({
    contract_type, expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t',
  })),
);
const selectedMarket = normalizeActiveSymbols([{
  symbol: 'R_100', display_name: 'Volatility 100 Index', pip: 0.01,
  exchange_is_open: 1, is_trading_suspended: 0,
}])[0];

const ticksOf = (digits) => digits.map((digit, index) => ({
  symbol: 'R_100', digit, quote: 100 + digit / 100, epoch: 1_700_000_000 + index, pipSize: 0.01, precision: 2,
}));

const makeFeed = (digits) => ({
  selectedMarket, contracts, contractsLoaded: true, historyLoaded: true,
  fresh: true, precisionError: '', ticks: ticksOf(digits),
});

function seededDigits(count, seed = 99) {
  let state = seed >>> 0;
  return Array.from({ length: count }, () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor((state / 4294967296) * 10);
  });
}

const rank = (family, feed, duration = 1, onProgress) =>
  runResearchRanking(family, feed, analyzeDigits(feed.ticks), duration, onProgress);

test('confidence combines weighted factors and counts agreement without inflating it', () => {
  const votes = [
    engineVote({ id: 'a', label: 'A', family: 'trend', stance: 'support', strength: 0.8, weight: 0.5, detail: '' }),
    engineVote({ id: 'b', label: 'B', family: 'momentum', stance: 'support', strength: 0.4, weight: 0.25, detail: '' }),
    engineVote({ id: 'c', label: 'C', family: 'breadth', stance: 'oppose', strength: 0.9, weight: 0.25, detail: '' }),
    engineVote({ id: 'd', label: 'D', family: 'quant', stance: 'neutral', strength: 0, weight: 0, detail: 'abstains' }),
  ];
  const consensus = buildConsensus({
    votes,
    factors: [confidenceFactor({ id: 'x', label: 'X', score: 1, weight: 3 }), confidenceFactor({ id: 'y', label: 'Y', score: 0, weight: 1 })],
  });
  assert.equal(consensus.enginesTotal, 4);
  assert.equal(consensus.enginesAgreed, 2);
  assert.equal(consensus.enginesOpposed, 1);
  assert.equal(consensus.enginesAbstained, 1);
  // Support weight 0.75 of 1.0 counted weight.
  assert.ok(Math.abs(consensus.weightedAgreement - 0.75) < 1e-9);
  assert.equal(consensus.familiesAgreed, 2, 'the opposing family must not be counted as agreeing');
  assert.equal(consensus.confidence, 0.75);
  assert.equal(consensus.confidencePercent, 75);
  assert.equal(consensus.grade, 'strong');
  assert.match(consensus.headline, /2\/4 engines agree · 75% confidence/);
});

test('abstaining engines stay visible but carry no voting weight', () => {
  const consensus = buildConsensus({
    votes: [engineVote({ id: 'a', label: 'A', family: 'trend', stance: 'neutral', strength: 0, weight: 0, detail: 'no data' })],
    factors: [],
  });
  assert.equal(consensus.weightedAgreement, 0);
  assert.equal(consensus.confidence, 0);
  assert.equal(consensus.enginesTotal, 1);
  assert.equal(confidenceGrade(0), 'very weak');
  assert.equal(confidenceGrade(100), 'very strong');
});

test('winning digit sets follow Deriv settlement rules, including strict barriers', () => {
  assert.deepEqual(winningDigits({ family: 'over-under', contractType: 'DIGITOVER', barrier: 7 }), [8, 9]);
  assert.deepEqual(winningDigits({ family: 'over-under', contractType: 'DIGITUNDER', barrier: 2 }), [0, 1]);
  assert.deepEqual(winningDigits({ family: 'even-odd', contractType: 'DIGITODD' }), [1, 3, 5, 7, 9]);
  assert.deepEqual(winningDigits({ family: 'matches', contractType: 'DIGITMATCH', targetDigit: 0 }), [0]);
  assert.equal(uniformWinRate({ family: 'even-odd', contractType: 'DIGITEVEN' }), 0.5);
  assert.equal(uniformWinRate({ family: 'matches', contractType: 'DIGITMATCH', targetDigit: 4 }), 0.1);
});

test('run-conditioned follow-through measures history and abstains on rare states', () => {
  const alternating = Array.from({ length: 600 }, (_, index) => (index % 2 === 0 ? 8 : 1));
  const over = runConditionedFollowThrough(alternating, { family: 'over-under', contractType: 'DIGITOVER', barrier: 4 }, 1);
  assert.ok(over.sample >= 25, 'a repeating stream has plenty of run repeats');
  assert.equal(over.side, 'lose', 'the stream ends on digit 1, which loses over barrier 4');
  assert.equal(over.rate, 1, 'after a loss this stream always wins at the next tick');
  // Equality ticks break Over/Under runs and are measured as their own state.
  const equalRun = runConditionedFollowThrough(
    Array.from({ length: 400 }, (_, index) => (index % 5 === 0 ? 4 : index % 2 === 0 ? 9 : 0)),
    { family: 'over-under', contractType: 'DIGITOVER', barrier: 4 },
    1,
  );
  assert.ok(['win', 'lose', 'equal'].includes(equalRun.side));
  const rare = runConditionedFollowThrough(seededDigits(400), { family: 'matches', contractType: 'DIGITMATCH', targetDigit: 7 }, 3);
  assert.equal(typeof rare.sample, 'number');
  if (rare.rate !== null) assert.ok(rare.rate >= 0 && rare.rate <= 1);
});

test('every digit family publishes a signal with engine agreement and a confidence score', () => {
  const digits = seededDigits(2000);
  for (const family of ['even-odd', 'matches']) {
    const result = rank(family, makeFeed(digits), 1);
    assert.equal(result.blocked, false);
    assert.ok(result.signal, `${family} must publish a signal after a completed scan`);
    assert.ok(result.candidates.length > 0);
    for (const candidate of result.candidates) {
      const consensus = candidate.consensus;
      assert.ok(consensus, `${candidate.label} is missing its consensus`);
      assert.ok(consensus.enginesTotal >= 6, `${candidate.label} should be voted on by every engine`);
      assert.ok(consensus.enginesAgreed + consensus.enginesOpposed + consensus.enginesAbstained === consensus.enginesTotal);
      assert.ok(consensus.confidence >= 0 && consensus.confidence <= 1);
      assert.equal(consensus.confidencePercent, Math.round(consensus.confidence * 100));
      assert.ok(consensus.factors.length >= 6);
      assert.ok(consensus.familiesTotal > 0);
      assert.ok(consensus.votes.every((vote) => ['support', 'oppose', 'neutral'].includes(vote.stance)));
      assert.ok(consensus.votes.every((vote) => vote.detail.length > 0), 'every vote must explain itself');
    }
    // The published signal is the strongest qualified candidate when one exists.
    const qualified = result.candidates.filter((candidate) => candidate.qualified);
    if (qualified.length) assert.ok(qualified.some((candidate) => candidate.label === result.signal.label));
  }
});

test('the deep quant engine and the AI synthesis vote on digit signals', () => {
  const digits = seededDigits(1200);
  const context = buildDigitQuantContext('even-odd', digits);
  assert.ok(context);
  assert.ok(context.evenOdd);
  assert.equal(typeof context.insight.verdict, 'string');
  const analysis = analyzeDigits(ticksOf(digits));
  const consensus = digitConsensus({
    family: 'even-odd',
    label: 'EVEN',
    contract: { family: 'even-odd', contractType: 'DIGITEVEN' },
    outcomes: { candidate: { family: 'even-odd', contractType: 'DIGITEVEN' }, durationTicks: 1, sample: 400, hits: 220, misses: 180, barrierEqual: 0, empiricalHitRate: 0.55, wilson95: { lower: 0.5, upper: 0.6 }, smoothedHistoricalHitRate: 0.55, contextSample: 400, contextDigit: 4, contextParity: 0 },
    baseline: { candidate: { family: 'even-odd', contractType: 'DIGITEVEN' }, durationTicks: 1, sample: 1900, hits: 950, misses: 950, barrierEqual: 0, empiricalHitRate: 0.5, wilson95: { lower: 0.48, upper: 0.52 }, smoothedHistoricalHitRate: 0.5, contextSample: 1900, contextDigit: null, contextParity: null },
    analysis, digits, quant: context, qualified: true, gateReasons: [], familiesTotal: 6,
  });
  const ids = consensus.votes.map((vote) => vote.id);
  assert.ok(ids.includes('quant-deep'), 'the deep quantitative engine must vote');
  assert.ok(ids.includes('ai-synthesis'), 'the AI synthesis engine must vote');
  assert.ok(ids.includes('frequency-long') && ids.includes('markov-context') && ids.includes('run-structure'));
});

test('a biased stream produces a stronger signal than a uniform random stream', () => {
  const random = rank('even-odd', makeFeed(seededDigits(2000, 7)), 1).signal;
  const biased = rank('even-odd', makeFeed(Array.from({ length: 2000 }, (_, index) => (index % 4 === 0 ? 1 : 2))), 1).signal;
  assert.ok(random && biased);
  assert.equal(biased.label, 'EVEN');
  assert.ok(biased.consensus.confidence > random.consensus.confidence, 'measured edge must raise the evidence confidence');
  assert.ok(biased.consensus.enginesAgreed >= random.consensus.enginesAgreed);
});

test('hard data gates still block instead of inventing a signal', () => {
  const feed = makeFeed(seededDigits(2000));
  const blocked = rank('matches', { ...feed, fresh: false }, 1);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.signal, null);
  assert.equal(blocked.candidates.length, 0);
  assert.notEqual(blocked.reason, '');
});

test('ranking reports monotonically increasing progress while it works', () => {
  const seen = [];
  rank('matches', makeFeed(seededDigits(1200)), 1, (percent, phase) => seen.push({ percent, phase }));
  assert.ok(seen.length >= 3, 'a scan must report progress phases');
  assert.ok(seen.every((step) => Number.isFinite(step.percent) && step.percent >= 0 && step.percent <= 100));
  assert.ok(seen.every((step) => step.phase.length > 0));
  const percents = seen.map((step) => step.percent);
  assert.equal(percents[percents.length - 1] >= percents[0], true);
  assert.ok(Math.max(...percents) >= 90, 'progress must reach the published signal');
});

test('rise/fall publishes a direction with engine votes from every engine family', () => {
  let state = 5;
  const prices = Array.from({ length: 900 }, (_, index) => {
    state = (Math.imul(1103515245, state) + 12345) >>> 0;
    return 1000 + index * 0.05 + ((state / 4294967296) - 0.5) * 0.8;
  });
  const analysis = analyzeRiseFall(prices.map((quote, index) => ({ quote, epoch: 1_700_000_000 + index })), 5);
  const { direction, sign } = publishedDirection(analysis);
  assert.ok(['RISE', 'FALL', 'WAIT'].includes(direction));
  assert.ok(sign === 1 || sign === -1);
  const quant = riseFallQuantMetrics(prices);
  assert.ok(quant);
  const consensus = riseFallConsensus({
    marketCode: 'R_100', marketName: 'Volatility 100 Index', analysis, prices,
    fresh: true, historyLoaded: true, tickCount: prices.length,
    horizon: { unit: 'ticks', value: 5 },
    historical: { horizon: 5, sample: 400, rise: 240, fall: 150, unchanged: 10 },
    directionalSupport: direction === 'FALL' ? -0.2 : 0.2,
    qualified: false, gateReasons: ['Test gate.'], quant,
  });
  const ids = consensus.votes.map((vote) => vote.id);
  assert.equal(consensus.enginesTotal, 14, 'five windows plus nine further engines');
  for (const expected of ['trend', 'swing-structure', 'momentum', 'breadth', 'roc-volatility', 'ema-position', 'expiry-history', 'deep-quant', 'ai-synthesis']) {
    assert.ok(ids.includes(expected), `${expected} must vote`);
  }
  assert.ok(consensus.factors.length >= 7);
  assert.ok(consensus.confidence >= 0 && consensus.confidence <= 1);
  assert.equal(consensus.confidencePercent, Math.round(consensus.confidence * 100));
});

test('rise/fall confidence falls when the feed is stale or outcomes disagree', () => {
  const prices = Array.from({ length: 800 }, (_, index) => 1000 + Math.sin(index / 9) * 2 + index * 0.01);
  const ticks = prices.map((quote, index) => ({ quote, epoch: 1_700_000_000 + index }));
  const analysis = analyzeRiseFall(ticks, 5);
  const base = {
    marketCode: 'R_50', marketName: 'Volatility 50 Index', analysis, prices,
    historyLoaded: true, tickCount: prices.length,
    horizon: { unit: 'ticks', value: 5 },
    historical: { horizon: 5, sample: 400, rise: 260, fall: 140, unchanged: 0 },
    directionalSupport: 0.3, qualified: true, gateReasons: [],
    quant: riseFallQuantMetrics(prices),
  };
  const fresh = riseFallConsensus({ ...base, fresh: true });
  const stale = riseFallConsensus({ ...base, fresh: false });
  assert.ok(stale.confidence < fresh.confidence, 'a stale feed must lower confidence');
  const contradicted = riseFallConsensus({ ...base, fresh: true, directionalSupport: -0.4, historical: { horizon: 5, sample: 400, rise: 140, fall: 260, unchanged: 0 } });
  assert.ok(contradicted.confidence < fresh.confidence, 'contradicting expiry outcomes must lower confidence');
  const thin = riseFallConsensus({ ...base, fresh: true, historical: { horizon: 5, sample: 12, rise: 8, fall: 4, unchanged: 0 }, directionalSupport: 0.3 });
  assert.ok(thin.confidence < fresh.confidence, 'a thin outcome sample must lower confidence');
});

test('scans on empty or short feeds abstain loudly instead of crashing or changing the engine count', () => {
  // Rise/Fall: a market with no validated history yet must still publish a row.
  for (const prices of [[], [1000], Array.from({ length: 40 }, (_, index) => 1000 + index)]) {
    const ticks = prices.map((quote, index) => ({ quote, epoch: 1_700_000_000 + index }));
    const analysis = analyzeRiseFall(ticks, 5);
    const consensus = riseFallConsensus({
      marketCode: 'R_100', marketName: 'Volatility 100 Index', analysis, prices,
      fresh: false, historyLoaded: false, tickCount: prices.length,
      horizon: { unit: 'ticks', value: 5 },
      historical: { horizon: 5, sample: 0, rise: 0, fall: 0, unchanged: 0 },
      directionalSupport: null, qualified: false, gateReasons: ['Waiting for validated history.'],
      quant: riseFallQuantMetrics(prices),
    });
    assert.equal(consensus.enginesTotal, 14, 'the engine count must not depend on feed size');
    assert.equal(consensus.enginesAgreed, consensus.votes.filter((vote) => vote.stance === 'support').length);
    assert.ok(consensus.confidence >= 0 && consensus.confidence <= 1);
    assert.ok(consensus.votes.every((vote) => vote.detail.length > 0), 'abstentions must explain themselves');
  }

  // Digit families: below the quant minimum the engines abstain but still vote.
  for (const digits of [[], [7, 7, 7], Array.from({ length: 60 }, (_, index) => index % 10)]) {
    const analysis = analyzeDigits(ticksOf(digits));
    const consensus = digitConsensus({
      family: 'even-odd', label: 'EVEN', contract: { family: 'even-odd', contractType: 'DIGITEVEN' },
      outcomes: { candidate: { family: 'even-odd', contractType: 'DIGITEVEN' }, durationTicks: 1, sample: digits.length, hits: 0, misses: digits.length, barrierEqual: 0, empiricalHitRate: null, wilson95: null, smoothedHistoricalHitRate: null, contextSample: 0, contextDigit: null, contextParity: null },
      baseline: { candidate: { family: 'even-odd', contractType: 'DIGITEVEN' }, durationTicks: 1, sample: 0, hits: 0, misses: 0, barrierEqual: 0, empiricalHitRate: null, wilson95: null, smoothedHistoricalHitRate: null, contextSample: 0, contextDigit: null, contextParity: null },
      analysis, digits, quant: buildDigitQuantContext('even-odd', digits),
      qualified: false, gateReasons: ['Not enough conditioned outcomes.'], familiesTotal: 6,
    });
    assert.equal(consensus.enginesTotal, 7, 'the digit engine count must not depend on feed size');
    assert.ok(consensus.confidence <= 0.5, 'a thin feed must not produce a confident signal');
  }
});
