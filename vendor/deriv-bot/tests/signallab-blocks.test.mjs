import test from "node:test";
import assert from "node:assert/strict";

// Runtime tests for the Signal Lab all-markets scan, hedging and virtual
// blocks. The blocks themselves are browser-only Blockly definitions; what
// they emit is one `Bot.*` call each, and these tests cover the runtime those
// calls reach inside the embedded workspace.
const listeners = new Map();
globalThis.window = {
  parent: { postMessage: () => undefined },
  location: { origin: "https://signal-lab.test" },
  addEventListener: (type, listener) => listeners.set(type, listener),
  setInterval: () => 1,
  clearInterval: () => undefined,
  setTimeout: () => 1,
  clearTimeout: () => undefined,
};

const feed = await import("../src/services/signallab-feed.ts");
const originalNow = Date.now;
let clock = 1_800_000_000_000;
let tickEpoch = Math.floor(clock / 1000);
Date.now = () => clock;

function post(data) {
  listeners.get("message")({
    origin: window.location.origin,
    source: window.parent,
    data: { source: "signal-lab", ...data },
  });
}

function sendFeed(markets, reset = true) {
  post({
    type: "signal-lab-feed",
    reset,
    markets: markets.map((market) => ({
      symbol: market.symbol,
      name: market.name,
      pipSize: 0.01,
      ticks: market.ticks.map((quote, index) => [tickEpoch + index, quote]),
    })),
  });
  tickEpoch += 1_000;
}

function rising(quotes) {
  return { symbol: "R_100", name: "Volatility 100 Index", ticks: quotes };
}

function falling(quotes) {
  return { symbol: "R_50", name: "Volatility 50 Index", ticks: quotes };
}

test("the all-markets scan scores every market and remembers the strongest", () => {
  feed.connectSignalLabBridge();
  sendFeed([rising(Array.from({ length: 20 }, (_, i) => 100 + i)), falling(Array.from({ length: 20 }, (_, i) => 100 - i))]);
  const counted = feed.signalLabScanMarkets("rise-fall", 20, 0.05);
  assert.equal(counted, 2, "every market with ticks is scored");
  assert.equal(feed.signalLabScanBest(), "R_100", "the rising market wins the rise/fall scan");
  assert.equal(feed.signalLabScanRank("R_100"), 1);
  assert.equal(feed.signalLabScanRank("R_50"), 2);
  assert.ok(feed.signalLabScanScore("R_100") > 0.9);
  assert.ok(feed.signalLabScanScore("R_50") < -0.9);
  assert.equal(feed.signalLabScanCount(), 2);
  assert.equal(feed.signalLabScanTradeable(), true, "a full lean clears a 0.05 floor");
});

test("a flat market clears no floor", () => {
  sendFeed([rising([100, 100, 100, 100])]);
  feed.signalLabScanMarkets("rise-fall", 4, 0.05);
  assert.equal(feed.signalLabScanBest(), "R_100");
  assert.equal(feed.signalLabScanTradeable(), false, "a flat stream is not a lean");
});

test("the digit scan reads the last digit instead of the quote", () => {
  sendFeed([rising([100.11, 100.12, 100.13, 100.14, 100.15, 100.16, 100.17, 100.18])]);
  feed.signalLabScanMarkets("even-odd", 8, 0.01);
  const state = feed.getSignalLabScanState();
  assert.equal(state.family, "even-odd");
  assert.equal(state.count, 1);
  assert.equal(state.scores.get("R_100"), 0, "digits 1..8 split evenly between even and odd");
  assert.equal(feed.signalLabScanTradeable(), false, "a flat digit stream clears no floor");
});

test("the hedging blocks read the open positions Signal Lab reports", () => {
  sendFeed([rising(Array.from({ length: 5 }, (_, i) => 100 + i))]);
  post({
    type: "signal-lab-account",
    accountId: "VRTC123456",
    accountType: "demo",
    balance: 10_000,
    currency: "USD",
    openPositions: [
      { contractId: 1, contractType: "CALL", symbol: "R_100", buyPrice: 100, payout: 1.9, profit: 1.5 },
      { contractId: 2, contractType: "PUT", symbol: "R_100", buyPrice: 100, payout: 1.9, profit: 0.5 },
      { contractId: 3, contractType: "CALL", symbol: "R_50", buyPrice: 50, payout: 1.9, profit: -0.5 },
    ],
    openProfit: 1.5,
    realizedProfit: 4,
    closedTrades: 6,
    updatedAt: clock,
  });
  assert.equal(feed.signalLabHedgeLegs("R_100"), 2);
  assert.equal(feed.signalLabHedgePairs("R_100"), 1);
  assert.equal(feed.signalLabHedgeBalanced("R_100"), true);
  assert.equal(feed.signalLabHedgeCount(), 3);
  assert.equal(feed.signalLabHedgeProfit(), 1.5);
});

test("the virtual blocks open, settle and book a paper trade", () => {
  sendFeed([rising(Array.from({ length: 5 }, (_, i) => 100 + i))]);
  feed.signalLabVirtualReset();
  assert.equal(feed.signalLabVirtualOpen(), 0);
  assert.equal(feed.signalLabVirtualBalance(), 10_000);

  assert.equal(feed.signalLabVirtualBuy("R_100", "rise", 10, 1.9, 5), true);
  assert.equal(feed.signalLabVirtualOpen(), 1, "the buy opens a position at the live quote");

  // The quote has risen since the buy, so the rise settles as a win.
  sendFeed([rising(Array.from({ length: 6 }, (_, i) => 101 + i))], false);
  assert.equal(feed.signalLabVirtualSettle(), 1);
  assert.equal(feed.signalLabVirtualOpen(), 0);
  assert.equal(feed.signalLabVirtualRuns(), 1);
  assert.equal(feed.signalLabVirtualWins(), 1);
  assert.equal(feed.signalLabVirtualProfit(), 19, "a winning rise pays stake × payout");
  assert.equal(feed.signalLabVirtualBalance(), 10_019);

  // A fall bought at the top settles as a loss.
  sendFeed([rising(Array.from({ length: 6 }, (_, i) => 107 + i))], false);
  feed.signalLabVirtualBuy("R_100", "fall", 10, 1.9, 5);
  sendFeed([rising(Array.from({ length: 7 }, (_, i) => 108 + i))], false);
  feed.signalLabVirtualSettle();
  assert.equal(feed.signalLabVirtualProfit(), 9, "a losing fall costs the stake");
  assert.equal(feed.signalLabVirtualWins(), 1);

  // A digit direction settles against the last digit. A fresh feed snapshot
  // resets the virtual ledger, so this case starts from a clean slate.
  sendFeed([rising([100.07])]);
  feed.signalLabVirtualBuy("R_100", "over", 10, 1.9, 5);
  sendFeed([rising([100.09])], false);
  feed.signalLabVirtualSettle();
  assert.equal(feed.signalLabVirtualProfit(), 19, "digit 9 is over the barrier 5");
  assert.equal(feed.signalLabVirtualWins(), 1);
});

test("a feed reset clears the scan and the virtual ledger", () => {
  sendFeed([rising(Array.from({ length: 5 }, (_, i) => 100 + i))]);
  feed.signalLabScanMarkets("rise-fall", 5, 0);
  feed.signalLabVirtualBuy("R_100", "rise", 10, 1.9, 5);
  sendFeed([]);
  assert.equal(feed.signalLabScanCount(), 0, "a reset clears the scan");
  assert.equal(feed.signalLabScanBest(), "");
  assert.equal(feed.signalLabVirtualOpen(), 0, "a reset clears the virtual ledger");
  assert.equal(feed.signalLabVirtualBalance(), 10_000);
});

test.after(() => {
  Date.now = originalNow;
});

test("the gate status explains why entries are closed, and wide entry windows are accepted", () => {
  sendFeed([rising(Array.from({ length: 10 }, (_, i) => 100 + i))]);
  feed.setSignalLabAnalysisSnapshot(null);
  assert.match(
    feed.getSignalLabAnalysisGateReason("rise-fall", "R_100", "run-1", "CALL", 0, 0),
    /No Signal Lab analysis is loaded/,
  );
  const snapshot = {
    analysisId: "run-1",
    family: "rise-fall",
    symbol: "R_100",
    contractType: "CALL",
    barrier: null,
    targetDigit: null,
    generatedAt: clock,
    asOfEpoch: tickEpoch,
    maxAgeMs: 900_000,
    validForTicks: 200,
    tradeable: true,
    entry: {
      action: "enter-on-trigger",
      trigger: "digit",
      // 300 used to be rejected (>50) even though loading + booting a bot can
      // take longer than 50 ticks on a 1-second market.
      windowTicks: 300,
      priceLevel: null,
      priceCondition: null,
      tolerance: null,
      contextDigits: [7],
    },
  };
  assert.equal(feed.setSignalLabAnalysisSnapshot(snapshot), true);
  assert.match(
    feed.getSignalLabAnalysisGateReason("rise-fall", "R_50", "run-1", "CALL", 0, 0),
    /no ticks for R_50/,
    "a gate on a market without shared ticks says so",
  );
  sendFeed([falling(Array.from({ length: 5 }, (_, i) => 100 - i))], false);
  assert.match(
    feed.getSignalLabAnalysisGateReason("rise-fall", "R_50", "run-1", "CALL", 0, 0),
    /loaded analysis is for R_100/,
    "a wrong-market gate names the analysed market",
  );
  assert.match(
    feed.getSignalLabAnalysisGateReason("rise-fall", "R_100", "run-2", "CALL", 0, 0),
    /does not match this strategy/,
  );
  assert.equal(feed.getSignalLabAnalysisGate("rise-fall", "R_100", "run-1", "CALL", 0, 0), false);
});

test("the data waits resolve empty instead of throwing, so a data block cannot kill a run", async () => {
  sendFeed([]);
  post({ type: "signal-lab-account", accountId: "" });
  assert.deepEqual(await feed.waitForSignalLabTicks("R_999", 0), []);
  assert.equal(await feed.waitForSignalLabAccount(0), null);
});
