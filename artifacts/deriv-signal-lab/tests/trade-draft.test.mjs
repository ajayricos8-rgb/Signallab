import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGIT_TARGETS,
  TRADE_FAMILIES,
  draftBarriers,
  isValidDraftStake,
} from '../src/lib/trade-draft.ts';

test('each mini-tab exposes only its own draft contract types', () => {
  assert.deepEqual(
    TRADE_FAMILIES['rise-fall'].contracts.map(({ value }) => value),
    ['CALL', 'PUT'],
  );
  assert.deepEqual(
    TRADE_FAMILIES['even-odd'].contracts.map(({ value }) => value),
    ['DIGITEVEN', 'DIGITODD'],
  );
  assert.deepEqual(
    TRADE_FAMILIES['over-under'].contracts.map(({ value }) => value),
    ['DIGITOVER', 'DIGITUNDER'],
  );
  assert.deepEqual(
    TRADE_FAMILIES.matches.contracts.map(({ value }) => value),
    ['DIGITMATCH'],
  );
});

test('draft barriers exclude impossible strict over/under boundaries; matches includes zero', () => {
  assert.deepEqual(draftBarriers('DIGITOVER'), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(draftBarriers('DIGITUNDER'), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(draftBarriers('DIGITMATCH'), []);
  assert.deepEqual(DIGIT_TARGETS, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('draft stake accepts positive decimal amounts, not negative or malformed input', () => {
  for (const value of ['.5', '0.35', '1', '1.00', ' 12.34 '])
    assert.equal(isValidDraftStake(value), true, value);
  for (const value of [
    '',
    '0',
    '0.00',
    '-1',
    '1.234',
    '1e3',
    'NaN',
    'Infinity',
    'abc',
  ])
    assert.equal(isValidDraftStake(value), false, value);
});
