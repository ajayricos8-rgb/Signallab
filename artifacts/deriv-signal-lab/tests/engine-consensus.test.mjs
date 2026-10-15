import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConsensus, pickMajority, tierDescription } from '../src/lib/engine-consensus.ts';
import { evenOddCouncil, matchesCouncil, overUnderCouncil } from '../src/lib/digit-engines.ts';
import { riseFallCouncil } from '../src/lib/rise-fall-engines.ts';
import { analyzeDigits } from '../src/lib/digit-analysis.ts';
import { runResearchRanking } from '../src/lib/digit-signals.ts';
import { normalizeActiveSymbols, normalizeContractSupport } from '../src/lib/deriv-digit-metadata.ts';

const contracts = normalizeContractSupport([
  'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITMATCH',
].map((contract_type) => ({
  contract_type, expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t',
})));
const selectedMarket = normalizeActiveSymbols([{
  symbol: 'R_100', display_name: 'Volatility 100 Index', pip: 0.01,
  exchange_is_open: 1, is_trading_suspended: 0,
}])[0];
const makeFeed = (digit = 0) => ({
  selectedMarket, contracts, contractsLoaded: true, historyLoaded: true,
  fresh: true, precisionError: '',
  ticks: Array.from({ length: 2000 }, (_, index) => ({
    symbol: 'R_100', digit, quote: 100 + digit / 100,
    epoch: 1700000000 + index, pipSize: 0.01, precision: 2,
  })),
});

const vote = (id, side, strength = 0.6) => ({ id, label: id, side, strength, note: '' });

test('pickMajority follows count then strength then label order', () => {
  assert.equal(pickMajority([vote('a', 'EVEN'), vote('b', 'EVEN'), vote('c', 'ODD')]), 'EVEN');
  // Counts dominate: two ODD votes beat one stronger EVEN vote.
  assert.equal(pickMajority([vote('a', 'EVEN', 0.9), vote('b', 'ODD', 0.2), vote('c', 'ODD', 0.1)]), 'ODD');
  // Two votes each: higher total strength wins.
  assert.equal(pickMajority([vote('a', 'EVEN', 0.9), vote('b', 'ODD', 0.2), vote('c', 'ODD', 0.2), vote('d', 'EVEN', 0.3)]), 'EVEN');
  assert.equal(pickMajority([]), null);
});

test('buildConsensus reports engines agreed, a confidence score and a tier', () => {
  const engines = [vote('a', 'OVER 5'), vote('b', 'OVER 5'), vote('c', 'OVER 5'), vote('d', 'UNDER 5', 0.3)];
  const signal = buildConsensus(engines, 'OVER 5', { evidence: 0.8 });
  assert.ok(signal);
  assert.equal(signal.label, 'OVER 5');
  assert.equal(signal.votesFor, 3);
  assert.equal(signal.votesTotal, 4);
  assert.equal(signal.agreement, 0.75);
  assert.ok(signal.confidence > 50 && signal.confidence <= 100);
  assert.ok(['STRONG', 'MODERATE', 'WEAK'].includes(signal.tier));
  assert.equal(tierDescription(signal.tier).includes('consensus'), true);
  // Unanimous strong votes with strong evidence must grade as STRONG.
  const strong = buildConsensus([vote('a', 'EVEN', 0.9), vote('b', 'EVEN', 0.9), vote('c', 'EVEN', 0.9)], 'EVEN', { evidence: 0.9 });
  assert.equal(strong.tier, 'STRONG');
  assert.equal(strong.confidence >= 72, true);
  assert.equal(buildConsensus([], 'EVEN'), null);
});

test('every completed digit scan emits a signal with an engines-agreed tally', () => {
  for (const family of ['even-odd', 'matches', 'over-under']) {
    const feed = makeFeed(family === 'matches' ? 7 : 3);
    const progress = [];
    const result = runResearchRanking(family, feed, analyzeDigits(feed.ticks), 1, (percent, stage) => progress.push({ percent, stage }));
    assert.ok(result.signal, `expected a signal for ${family}`);
    assert.ok(result.signal.label.length > 0);
    assert.ok(result.signal.votesTotal >= 8, `expected a full engine council for ${family}`);
    assert.ok(result.signal.votesFor >= 1);
    assert.ok(result.signal.confidence >= 0 && result.signal.confidence <= 100);
    assert.ok(progress.length >= 3, 'expected staged progress updates');
    assert.equal(progress[0].percent <= progress.at(-1).percent, true);
    assert.equal(progress.at(-1).percent, 100);
    for (const entry of progress) {
      assert.ok(entry.percent >= 0 && entry.percent <= 100);
      assert.ok(entry.stage.length > 0);
    }
  }
});

test('the even/odd council leans to the observed parity side on a constant stream', () => {
  const feed = makeFeed(7);
  const votes = evenOddCouncil(analyzeDigits(feed.ticks), feed.ticks, 1);
  assert.ok(votes.length >= 8);
  const odd = votes.filter((entry) => entry.side === 'ODD').length;
  const even = votes.filter((entry) => entry.side === 'EVEN').length;
  assert.ok(odd > even, `expected ODD majority, got odd=${odd} even=${even}`);
});

test('the matches council picks the constant digit on a constant stream', () => {
  const feed = makeFeed(4);
  const votes = matchesCouncil(analyzeDigits(feed.ticks), feed.ticks, 1);
  assert.ok(votes.length >= 8);
  const picked = votes.filter((entry) => entry.side === 'MATCH 4').length;
  assert.ok(picked >= votes.length / 2, `expected MATCH 4 majority, got ${picked}/${votes.length}`);
});

test('the over/under council counts support and opposition for a contract', () => {
  const feed = makeFeed(2);
  const result = runResearchRanking('over-under', feed, analyzeDigits(feed.ticks), 1);
  assert.ok(result.overUnder);
  const contract = result.overUnder.candidates[0].contract;
  const votes = overUnderCouncil(result.overUnder, contract);
  assert.equal(votes.length, result.overUnder.engines.filter((engine) => engine.probabilities).length);
  const label = `${contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${contract.barrier}`;
  for (const entry of votes) {
    assert.ok(entry.side === label || entry.side === `OPPOSE ${label}`);
  }
});

test('the rise/fall council votes RISE / FALL / WAIT and builds a consensus every time', () => {
  const rising = Array.from({ length: 600 }, (_, index) => ({ epoch: 1700000000 + index, quote: 100 + index * 0.05 }));
  const votes = riseFallCouncil(
    {
      tickCount: 600, currentQuote: 130, windows: [],
      trendScore: 0.8, dowScore: 0.7, dowStructure: 'Higher highs and higher lows',
      momentumScore: 0.6, breadthScore: 0.4, rocScore: 0.5, ema50Score: 0.6,
      biasScore: 0.75, bias: 'RISE', entryState: 'Directional alignment (unconfirmed)',
      rsi14: 72, ema9: 120, ema21: 115, ema50: 110, macdHistogram: 0.4,
      roc20: 0.02, averageTickMove14: 0.05, shortVolatility: 0.2, longVolatility: 0.15,
      volatilityRatio: 1.3, volatilityRegime: 'Expanding', upPercent100: 62, downPercent100: 38,
      unchangedPercent100: 0, latestStreak: '3 rising', historical: { horizon: 5, sample: 200, rise: 120, fall: 80, unchanged: 0 },
      lastEpoch: 1700000600,
    },
    { horizon: 5, sample: 200, rise: 120, fall: 80, unchanged: 0 },
    rising.map((tick) => tick.quote),
  );
  assert.ok(votes.length >= 10);
  for (const entry of votes) assert.ok(['RISE', 'FALL', 'WAIT'].includes(entry.side));
  const label = pickMajority(votes);
  const signal = buildConsensus(votes, label, { evidence: 0.7 });
  assert.ok(signal);
  assert.equal(signal.label, label);
  assert.ok(signal.votesTotal >= 10);
});
