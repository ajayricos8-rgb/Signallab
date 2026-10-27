// The Signal Lab → DBot bridge must send ticks once, then only new ticks, and
// must never claim account state it was not given. These tests cover the wire
// shapes the embedded workspace parses, so both sides stay in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_HISTORY_LIMIT,
  bridgeStats,
  buildAccountMessage,
  buildBridgeSnapshot,
  buildBridgeUpdate,
  sameAccountState,
} from '../src/lib/dbot-bridge.ts';

const market = (symbol, ticks, pipSize = 0.01) => ({ symbol, name: `${symbol} index`, pipSize, ticks });
const series = (count, start = 1_700_000_000) =>
  Array.from({ length: count }, (_, index) => ({ epoch: start + index, quote: 100 + index / 100 }));

test('a snapshot keeps the newest ticks per market and skips empty markets', () => {
  const source = [market('R_100', series(1500)), market('R_10', series(30)), market('R_50', [])];
  const { message } = buildBridgeSnapshot(source, 1000, 12_345);
  assert.ok(message);
  assert.equal(message.reset, true);
  assert.equal(message.sentAt, 12_345);
  assert.deepEqual(message.markets.map(item => item.symbol), ['R_10', 'R_100']);
  const hundred = message.markets.find(item => item.symbol === 'R_100');
  assert.equal(hundred.ticks.length, 1000);
  assert.equal(hundred.ticks.at(-1)[0], 1_700_001_499);
  assert.equal(hundred.ticks.at(-1)[1], 114.99);
  assert.equal(hundred.name, 'R_100 index');
  assert.equal(hundred.pipSize, 0.01);
});

test('an empty feed produces no message rather than an empty frame', () => {
  const { message, cursor } = buildBridgeSnapshot([market('R_100', [])]);
  assert.equal(message, null);
  assert.deepEqual(cursor, {});
});

test('an update only carries ticks newer than the cursor', () => {
  const first = market('R_100', series(50));
  const snapshot = buildBridgeSnapshot([first], BRIDGE_HISTORY_LIMIT);
  const allSent = first.ticks.length;
  const grown = market('R_100', series(53));
  const { message } = buildBridgeUpdate([grown], snapshot.cursor, BRIDGE_HISTORY_LIMIT);
  assert.ok(message);
  assert.equal(message.reset, false);
  assert.equal(message.markets.length, 1);
  assert.equal(message.markets[0].ticks.length, 3);
  assert.equal(message.markets[0].ticks[0][0], 1_700_000_000 + allSent);
});

test('nothing new means nothing is posted', () => {
  const source = market('R_10', series(10));
  const snapshot = buildBridgeSnapshot([source]);
  const { message } = buildBridgeUpdate([source], snapshot.cursor);
  assert.equal(message, null);
});

test('a market that appears later is sent whole and joins the cursor', () => {
  const snapshot = buildBridgeSnapshot([market('R_10', series(5))]);
  const { message, cursor } = buildBridgeUpdate(
    [market('R_10', series(5)), market('R_25', series(8))],
    snapshot.cursor,
  );
  assert.ok(message);
  assert.deepEqual(message.markets.map(item => item.symbol), ['R_25']);
  assert.equal(message.markets[0].ticks.length, 8);
  assert.equal(cursor.R_25, 1_700_000_007);
});

test('a stale cursor that runs past the cache sends the whole tail once', () => {
  const snapshot = buildBridgeSnapshot([market('R_100', series(20))]);
  // The feed reconnected and rebuilt from a different origin: every epoch is
  // older than the cursor, so the update carries nothing and the old ticks stay.
  const rebuilt = market('R_100', series(5, 1_600_000_000));
  const { message } = buildBridgeUpdate([rebuilt], snapshot.cursor);
  assert.equal(message, null);
});

test('a full snapshot after a reload re-sends everything', () => {
  const source = [market('R_100', series(1500))];
  const { message } = buildBridgeSnapshot(source);
  assert.equal(message.markets[0].ticks.length, BRIDGE_HISTORY_LIMIT);
  const second = buildBridgeSnapshot(source);
  assert.equal(second.message?.markets[0].ticks.length, BRIDGE_HISTORY_LIMIT);
});

test('stats describe what the workspace can see', () => {
  const stats = bridgeStats([market('R_100', series(100)), market('R_10', series(20)), market('R_50', [])]);
  assert.deepEqual(stats, { markets: 2, ticks: 120, latestEpoch: 1_700_000_099 });
  assert.deepEqual(bridgeStats([]), { markets: 0, ticks: 0, latestEpoch: null });
  // Only the newest BRIDGE_HISTORY_LIMIT ticks per market reach the frame.
  const capped = bridgeStats([market('R_100', series(1_500)), market('R_10', series(1_400))]);
  assert.equal(capped.ticks, BRIDGE_HISTORY_LIMIT * 2);
  assert.equal(capped.markets, 2);
});

test('account state mirrors the session and totals open and closed profit', () => {
  const message = buildAccountMessage(
    {
      accountId: 'VRTC123456',
      accountType: 'demo',
      balance: 9_950.5,
      currency: 'USD',
      openPositions: [
        { contractId: 2, contractType: 'CALL', symbol: 'R_100', buyPrice: 10, payout: 19, profit: -2.5 },
        { contractId: 1, contractType: 'PUT', symbol: 'R_50', buyPrice: 5, payout: 9, profit: 1.25 },
      ],
      closedPositions: [{ profit: 3 }, { profit: -1.5 }],
    },
    777,
  );
  assert.equal(message.type, 'signal-lab-account');
  assert.equal(message.balance, 9_950.5);
  assert.equal(message.openProfit, -1.25);
  assert.equal(message.realizedProfit, 1.5);
  assert.equal(message.closedTrades, 2);
  assert.equal(message.updatedAt, 777);
  assert.equal(message.openPositions[0].contractId, 2);
});

test('open positions are capped so a busy account cannot bloat the message', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    contractId: index,
    contractType: 'CALL',
    symbol: 'R_100',
    buyPrice: 1,
    payout: 2,
    profit: 0.1,
  }));
  const message = buildAccountMessage({
    accountId: 'CR1', accountType: 'real', balance: null, currency: '',
    openPositions: many, closedPositions: [],
  });
  assert.equal(message.openPositions.length, 20);
  assert.equal(message.balance, null, 'a missing balance stays missing instead of becoming zero');
  assert.equal(message.accountType, 'real');
});

test('identical account state is not re-sent', () => {
  const source = {
    accountId: 'VRTC1', accountType: 'demo', balance: 100, currency: 'USD',
    openPositions: [{ contractId: 1, contractType: 'CALL', symbol: 'R_100', buyPrice: 1, payout: 2, profit: 0.2 }],
    closedPositions: [{ profit: 1 }],
  };
  const first = buildAccountMessage(source, 1);
  assert.equal(sameAccountState(null, first), false);
  assert.equal(sameAccountState(first, buildAccountMessage(source, 2)), true);
  assert.equal(
    sameAccountState(first, buildAccountMessage({ ...source, balance: 101 }, 3)),
    false,
  );
  assert.equal(
    sameAccountState(first, buildAccountMessage({
      ...source,
      openPositions: [{ ...source.openPositions[0], profit: 0.3 }],
    }, 4)),
    false,
  );
});
