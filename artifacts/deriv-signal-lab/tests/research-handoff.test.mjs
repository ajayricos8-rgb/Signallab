import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsResearchContract } from '../src/components/signal/research-handoff.ts';

test('research handoff requires exact verified contract and barrier or target', () => {
  const supported = [
    { contractType: 'DIGITOVER', barrier: 4 },
    { contractType: 'DIGITMATCH', targetDigit: 3 },
    { contractType: 'DIGITEVEN' },
  ];
  assert.equal(supportsResearchContract({ contractType: 'DIGITOVER', barrier: 4 }, supported), true);
  assert.equal(supportsResearchContract({ contractType: 'DIGITOVER', barrier: 5 }, supported), false);
  assert.equal(supportsResearchContract({ contractType: 'DIGITMATCH', targetDigit: 3 }, supported), true);
  assert.equal(supportsResearchContract({ contractType: 'DIGITMATCH', targetDigit: 4 }, supported), false);
  assert.equal(supportsResearchContract({ contractType: 'DIGITEVEN' }, supported), true);
  assert.equal(supportsResearchContract({ contractType: 'DIGITODD' }, supported), false);
  assert.equal(supportsResearchContract({ contractType: 'DIGITEVEN' }, undefined), false);
});
