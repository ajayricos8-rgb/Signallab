import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFinalDigit, precisionFromPipSize } from '../src/lib/digit-analysis.ts';

test('final digit uses the displayed decimal places, not float truncation', () => {
  assert.equal(extractFinalDigit(1234.5, 0.1), 5);
  assert.equal(extractFinalDigit(1234.56, 0.01), 6);
  assert.equal(extractFinalDigit(0.0000007, 0.0000001), 7);
  assert.equal(extractFinalDigit(1.005, 0.001), 5);
  assert.equal(extractFinalDigit(Number('8981.5'), 0.1), 5);
  assert.equal(extractFinalDigit(8981.5, 0.01), 0);
  assert.equal(precisionFromPipSize(0.001), 3);
  assert.equal(precisionFromPipSize(0.015), null);
});
