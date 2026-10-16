import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRADE_DURATION_UNITS,
  draftDurationIssue,
  durationSeconds,
  formatTradeDuration,
  parseContractDuration,
  supportedTradeTicks,
} from '../src/lib/trade-duration.ts';
import { normalizeContractSupport } from '../src/lib/deriv-digit-metadata.ts';

const tickContracts = normalizeContractSupport([
  { contract_type: 'DIGITOVER', expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t' },
  { contract_type: 'DIGITUNDER', expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t' },
]);
const timeContracts = [
  {
    contractType: 'CALL', expiryType: 'intraday', minDuration: null, maxDuration: null,
    barriers: [], targets: [], digitRangeKnown: false,
    durationBounds: { min: { value: 15, unit: 's' }, max: { value: 1, unit: 'h' } },
  },
];

test('contract durations parse units without converting ticks to wall time', () => {
  assert.deepEqual(parseContractDuration('5t'), { value: 5, unit: 't' });
  assert.deepEqual(parseContractDuration('60s'), { value: 60, unit: 's' });
  assert.deepEqual(parseContractDuration('2m'), { value: 2, unit: 'm' });
  assert.deepEqual(parseContractDuration(7), { value: 7, unit: 't' });
  assert.equal(parseContractDuration('1.5t'), null);
  assert.equal(parseContractDuration('0s'), null);
  assert.equal(parseContractDuration('soon'), null);
  assert.equal(durationSeconds({ value: 2, unit: 'm' }), 120);
  assert.equal(durationSeconds({ value: 5, unit: 't' }), null);
  assert.equal(formatTradeDuration(1, 't'), '1 tick');
  assert.equal(formatTradeDuration(3, 'm'), '3 minutes');
});

test('reported duration bounds survive contract normalization', () => {
  assert.deepEqual(tickContracts[0].durationBounds, { min: { value: 1, unit: 't' }, max: { value: 10, unit: 't' } });
  assert.deepEqual(supportedTradeTicks(tickContracts, 'DIGITOVER'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('tick trade durations must sit inside the Deriv-reported range', () => {
  assert.equal(draftDurationIssue(5, 't', 'DIGITOVER', tickContracts, true), '');
  assert.notEqual(draftDurationIssue(11, 't', 'DIGITOVER', tickContracts, true), '');
  assert.notEqual(draftDurationIssue(5, 't', 'DIGITMATCH', tickContracts, true), '');
  assert.notEqual(draftDurationIssue(0, 't', 'DIGITOVER', tickContracts, true), '');
  assert.notEqual(draftDurationIssue(null, 't', 'DIGITOVER', tickContracts, true), '');
  assert.notEqual(draftDurationIssue(2.5, 't', 'DIGITOVER', tickContracts, true), '');
});

test('seconds and minutes validate against reported time ranges in seconds', () => {
  assert.equal(draftDurationIssue(30, 's', 'CALL', timeContracts, true), '');
  assert.equal(draftDurationIssue(30, 'm', 'CALL', timeContracts, true), '');
  assert.notEqual(draftDurationIssue(10, 's', 'CALL', timeContracts, true), '');
  assert.notEqual(draftDurationIssue(61, 'm', 'CALL', timeContracts, true), '');
  // Tick-only digit contracts have no reported time durations.
  assert.notEqual(draftDurationIssue(60, 's', 'DIGITOVER', tickContracts, true), '');
});

test('unverified drafts defer to the live Deriv proposal instead of claiming support', () => {
  assert.equal(draftDurationIssue(60, 's', 'CALL', undefined, false), '');
  assert.equal(draftDurationIssue(5, 't', 'CALL', undefined, false), '');
  assert.notEqual(draftDurationIssue(-1, 's', 'CALL', undefined, false), '');
});


test('trade duration dropdown exposes ticks, seconds and minutes with explicit labels', () => {
  assert.deepEqual(TRADE_DURATION_UNITS, [
    { value: 't', label: 'Ticks' }, { value: 's', label: 'Seconds' }, { value: 'm', label: 'Minutes' },
  ]);
  assert.equal(formatTradeDuration(3, 't'), '3 ticks');
  assert.equal(formatTradeDuration(30, 's'), '30 seconds');
  assert.equal(formatTradeDuration(1, 'm'), '1 minute');
});
