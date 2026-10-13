import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDigits } from '../src/lib/digit-analysis.ts';
import { runResearchRanking } from '../src/lib/digit-signals.ts';
import {
  normalizeActiveSymbols,
  normalizeContractSupport,
  normalizeResponsePipSize,
  parseTickDuration,
} from '../src/lib/deriv-digit-metadata.ts';

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
const rank = (family, feed, duration = 1) => runResearchRanking(family, feed, analyzeDigits(feed.ticks), duration);

test('legacy active-symbol fields populate verified market metadata', () => {
  assert.equal(selectedMarket.symbol, 'R_100');
  assert.equal(selectedMarket.name, 'Volatility 100 Index');
  assert.equal(selectedMarket.precision, 2);
  assert.equal(selectedMarket.pipSize, 0.01);
});

test('new active-symbol fields remain supported', () => {
  const [market] = normalizeActiveSymbols([{
    underlying_symbol: 'TEST', underlying_symbol_name: 'Test market', pip_size: 0.001,
  }]);
  assert.equal(market.symbol, 'TEST');
  assert.equal(market.precision, 3);
  assert.equal(market.name, 'Test market');
});

test('response decimal-place counts resolve to the verified symbol pip', () => {
  assert.equal(normalizeResponsePipSize(2, 0.01), 0.01);
  assert.equal(normalizeResponsePipSize('3', 0.001), 0.001);
  assert.equal(normalizeResponsePipSize(0, 1), 1);
  assert.equal(normalizeResponsePipSize(1, 1), 1);
  assert.equal(normalizeResponsePipSize(0.01, 0.01), 0.01);
  assert.equal(normalizeResponsePipSize(3, 0.01), null);
  assert.equal(normalizeResponsePipSize(null, 0.01), null);
  assert.equal(normalizeResponsePipSize(2, null), null);
});

test('tick-unit duration strings are parsed without accepting time-based durations', () => {
  assert.equal(parseTickDuration('1t'), 1);
  assert.equal(parseTickDuration('10t'), 10);
  assert.equal(parseTickDuration(4), 4);
  assert.equal(parseTickDuration('60s'), null);
  assert.equal(parseTickDuration('1.5t'), null);
  assert.equal(contracts[0].minDuration, 1);
  assert.equal(contracts[0].maxDuration, 10);
});

test('Over/Under uses the valid digit domain when optional barrier lists are absent', () => {
  assert.deepEqual(contracts.find((contract) => contract.contractType === 'DIGITOVER').barriers, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(contracts.find((contract) => contract.contractType === 'DIGITUNDER').barriers, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const [restricted] = normalizeContractSupport([{
    contract_type: 'DIGITOVER', expiry_type: 'tick', available_barriers: [2, 4],
    min_contract_duration: '1t', max_contract_duration: '5t',
  }]);
  assert.deepEqual(restricted.barriers, [2, 4]);
});

test('Even/Odd produces the observed parity signal rather than a permanent WAIT', () => {
  assert.equal(rank('even-odd', makeFeed()).candidates[0].label, 'EVEN');
  assert.equal(rank('even-odd', makeFeed(7)).candidates[0].label, 'ODD');
});

test('Over/Under ranks supported strict-barrier signals', () => {
  const result = rank('over-under', makeFeed());
  assert.equal(result.reason, '');
  assert.equal(result.candidates[0].contract.contractType, 'DIGITUNDER');
  assert.equal(result.candidates[0].outcomes.empiricalHitRate, 1);
  assert.equal(result.candidates.length, 18);
});

test('Matches produces a digit signal including zero and evaluates all ten targets', () => {
  for (let digit = 0; digit <= 9; digit += 1) {
    const result = rank('matches', makeFeed(digit));
    assert.equal(result.candidates[0].label, `MATCH ${digit}`);
    assert.equal(result.candidates.length, 10);
    assert.equal(result.candidates[0].outcomes.hits, 1999);
  }
});

test('selected expiry changes settlement horizons and remains limited to supported durations', () => {
  const result = rank('matches', makeFeed(), 5);
  assert.equal(result.candidates[0].outcomes.durationTicks, 5);
  assert.equal(result.candidates[0].outcomes.sample, 1995);
  assert.equal(rank('matches', makeFeed(), 11).candidates.length, 0);
  assert.equal(rank('matches', makeFeed(), null).candidates.length, 0);
});

test('unavailable, stale, suspended or invalid data returns a blocking reason without fabricating signals', () => {
  for (const override of [
    { fresh: false }, { contractsLoaded: false }, { historyLoaded: false },
    { ticks: [] }, { precisionError: 'Precision mismatch' }, { contracts: [] },
    { selectedMarket: { ...selectedMarket, tradingSuspended: true } },
    { selectedMarket: { ...selectedMarket, exchangeOpen: false } },
  ]) {
    const result = rank('matches', { ...makeFeed(), ...override });
    assert.equal(result.candidates.length, 0);
    assert.notEqual(result.reason, '');
  }
});
