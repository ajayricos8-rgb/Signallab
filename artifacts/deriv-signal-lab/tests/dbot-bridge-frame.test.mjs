// Frame side of the Signal Lab → DBot bridge.
//
// The embedded workspace imports `vendor/deriv-bot/src/services/signallab-feed`
// and must accept only same-origin messages from its parent, keep at most the
// last 1,000 ticks per market, and never invent data it was not sent. A tiny
// fake window stands in for the iframe so the real module runs unmodified.
import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = [];
const posted = [];
const intervals = [];

globalThis.window = {
  parent: {
    postMessage: (message, origin) => posted.push({ message, origin }),
  },
  location: { origin: 'https://signal-lab.test' },
  addEventListener: (type, listener) => {
    if (type === 'message') listeners.push(listener);
  },
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  setInterval: (callback, delay) => {
    const id = setInterval(callback, delay);
    intervals.push(id);
    return id;
  },
};

const feed = await import('../../../vendor/deriv-bot/src/services/signallab-feed.ts');

const ORIGIN = 'https://signal-lab.test';
const parent = globalThis.window.parent;

function deliver(data, { origin = ORIGIN, source = parent } = {}) {
  for (const listener of listeners) listener({ data, origin, source });
}

function snapshot(markets, extra = {}) {
  return { source: 'signal-lab', type: 'signal-lab-feed', reset: true, sentAt: 1, markets, ...extra };
}

test('the bridge asks the parent for data and ignores other origins and senders', () => {
  feed.connectSignalLabBridge();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.type, 'feed-subscribe');
  assert.equal(posted[0].message.source, 'signal-lab-dbot');
  assert.equal(posted[0].origin, ORIGIN);

  deliver(snapshot([{ symbol: 'R_100', name: 'Volatility 100 Index', pipSize: 0.01, ticks: [[10, 100.23]] }]), {
    origin: 'https://evil.test',
  });
  deliver(snapshot([{ symbol: 'R_100', name: 'Volatility 100 Index', pipSize: 0.01, ticks: [[10, 100.23]] }]), {
    source: { not: 'the parent' },
  });
  assert.deepEqual(feed.getSignalLabMarkets(), [], 'foreign messages must not populate the cache');
  assert.equal(feed.isSignalLabConnected(), false);
});

test('a snapshot populates ticks, digits and market options', () => {
  deliver(snapshot([
    { symbol: 'R_100', name: 'Volatility 100 Index', pipSize: 0.01, ticks: [[1, 100.11], [2, 100.4], [3, 100.27]] },
    { symbol: 'R_10', name: 'Volatility 10 Index', pipSize: 0.001, ticks: [[1, 10.123]] },
  ]));
  assert.equal(feed.isSignalLabConnected(), true);
  assert.deepEqual(feed.getSignalLabTicks('R_100'), [100.11, 100.4, 100.27]);
  assert.equal(feed.getSignalLabLastTick('R_100'), 100.27);
  assert.equal(feed.getSignalLabLastDigit('R_100'), 7);
  assert.equal(feed.getSignalLabLastDigit('R_10'), 3, 'a smaller pip size must keep its own precision');
  assert.equal(feed.getSignalLabTickChange('R_100', 2), 100.27 - 100.11);
  assert.equal(feed.getSignalLabTickChange('R_100', 99), 100.27 - 100.11);
  assert.deepEqual(feed.getSignalLabMarketOptions(), [
    ['Volatility 10 Index (R_10)', 'R_10'],
    ['Volatility 100 Index (R_100)', 'R_100'],
  ]);
});

test('an incremental update only appends newer epochs', () => {
  deliver({ source: 'signal-lab', type: 'signal-lab-feed', reset: false, sentAt: 2, markets: [
    { symbol: 'R_100', name: 'Volatility 100 Index', pipSize: 0.01, ticks: [[3, 100.30], [4, 100.55]] },
  ] });
  assert.deepEqual(feed.getSignalLabTicks('R_100'), [100.11, 100.4, 100.3, 100.55], 'an existing epoch is replaced, not duplicated');
  assert.equal(feed.getSignalLabLastTick('R_100'), 100.55);
});

test('the cache keeps the last 1,000 ticks like the DBot tick list', () => {
  const ticks = Array.from({ length: 1_400 }, (_, index) => [index + 1, 200 + index / 100]);
  deliver(snapshot([{ symbol: 'R_50', name: 'Volatility 50 Index', pipSize: 0.01, ticks }]));
  const kept = feed.getSignalLabTicks('R_50');
  assert.equal(kept.length, 1_000);
  assert.equal(kept.at(-1), 213.99);
  assert.equal(kept[0], 200 + 400 / 100);
});

test('the account snapshot is shared and capped, and an empty id clears it', () => {
  deliver({ source: 'signal-lab', type: 'signal-lab-account', accountId: 'VRTC123456', accountType: 'demo',
    balance: 9_900.5, currency: 'USD', openProfit: -1.25, realizedProfit: 12.5, closedTrades: 4, updatedAt: 5,
    openPositions: [
      { contractId: 2, contractType: 'CALL', symbol: 'R_100', buyPrice: 10, payout: 19, profit: -2.5 },
      { contractId: 1, contractType: 'PUT', symbol: 'R_50', buyPrice: 5, payout: 9, profit: 1.25 },
    ] });
  const account = feed.getSignalLabAccount();
  assert.equal(account.accountId, 'VRTC123456');
  assert.equal(feed.getSignalLabBalance(), 9_900.5);
  assert.equal(feed.getSignalLabOpenPositions().length, 2);

  deliver({ source: 'signal-lab', type: 'signal-lab-account', accountId: '' });
  assert.equal(feed.getSignalLabAccount(), null, 'unlinking must drop the account, not keep a stale balance');
});

test('a closed bridge clears ticks and account together', () => {
  deliver(snapshot([{ symbol: 'R_100', name: 'Volatility 100 Index', pipSize: 0.01, ticks: [[1, 100]] }]));
  deliver({ source: 'signal-lab', type: 'signal-lab-bridge', live: false });
  assert.deepEqual(feed.getSignalLabMarkets(), []);
  assert.equal(feed.getSignalLabAccount(), null);
  assert.equal(feed.isSignalLabConnected(), false);
  assert.deepEqual(feed.getSignalLabMarketOptions()[0], ['R_10', 'Volatility 10 Index'], 'the fallback list returns before data');
});

test('a block waiting for ticks fails with a message instead of trading on nothing', async () => {
  await assert.rejects(
    () => feed.waitForSignalLabTicks('R_75', 50),
    /Signal Lab has no ticks for R_75 yet/,
  );
  await assert.rejects(
    () => feed.waitForSignalLabAccount(50),
    /Signal Lab is not connected to an account/,
  );
});

test.after(() => {
  for (const id of intervals) clearInterval(id);
  delete globalThis.window;
});
