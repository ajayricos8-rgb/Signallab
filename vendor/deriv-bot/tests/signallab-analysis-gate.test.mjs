import test from "node:test";
import assert from "node:assert/strict";

const listeners = new Map();
const parentMessages = [];
globalThis.window = {
  parent: { postMessage: (...args) => parentMessages.push(args) },
  location: { origin: "https://signal-lab.test" },
  addEventListener: (type, listener) => listeners.set(type, listener),
  setInterval: () => 1,
  clearInterval: () => undefined,
};

const feed = await import("../src/services/signallab-feed.ts");
const originalNow = Date.now;
let clock = 1_800_000_000_000;
Date.now = () => clock;

function sendFeed(quotes, firstEpoch = Math.floor(clock / 1_000)) {
  const ticks = quotes.map((quote, index) => [firstEpoch + index, quote]);
  listeners.get("message")({
    origin: window.location.origin,
    source: window.parent,
    data: {
      source: "signal-lab",
      type: "signal-lab-feed",
      reset: true,
      markets: [
        { symbol: "R_100", name: "Volatility 100 Index", pipSize: 0.01, ticks },
      ],
    },
  });
}

function snapshot(overrides = {}) {
  return {
    analysisId: "run-1:rise-fall:R_100:CALL::::1",
    family: "rise-fall",
    symbol: "R_100",
    contractType: "CALL",
    barrier: null,
    targetDigit: null,
    generatedAt: clock,
    asOfEpoch: Math.floor(clock / 1_000),
    maxAgeMs: 60_000,
    validForTicks: 10,
    tradeable: true,
    entry: {
      action: "enter-now",
      trigger: "immediate",
      windowTicks: 2,
      priceLevel: null,
      priceCondition: null,
      tolerance: null,
      contextDigits: [],
    },
    ...overrides,
  };
}

function setSnapshot(value) {
  return feed.setSignalLabAnalysisSnapshot(value);
}

function gate(
  family = "rise-fall",
  symbol = "R_100",
  id = "run-1:rise-fall:R_100:CALL::::1",
  contractType = "CALL",
  barrier = 0,
  targetDigit = 0,
) {
  return feed.getSignalLabAnalysisGate(
    family,
    symbol,
    id,
    contractType,
    barrier,
    targetDigit,
  );
}

test("the analysis gate only accepts a fresh exact market, family and analysis key", () => {
  feed.connectSignalLabBridge();
  sendFeed([100.11, 100.12, 100.13]);
  assert.equal(setSnapshot(snapshot()), true);
  assert.equal(gate(), true);
  assert.equal(gate("over-under"), false);
  assert.equal(gate("rise-fall", "R_75"), false);
  assert.equal(gate("rise-fall", "R_100", "another-run"), false);
  assert.equal(gate("rise-fall", "R_100", undefined, "PUT"), false);

  assert.equal(
    setSnapshot(snapshot({ contractType: "DIGITMATCH" })),
    false,
    "family and contract type must agree",
  );
  assert.equal(
    setSnapshot(snapshot({ family: "differs" })),
    false,
    "Differs is not an analysis family",
  );
  assert.equal(
    setSnapshot(snapshot({ analysisId: "" })),
    false,
    "the generated strategy must carry an exact analysis key",
  );
  assert.equal(
    setSnapshot(
      snapshot({
        entry: {
          action: "enter-on-trigger",
          trigger: "immediate",
          windowTicks: 2,
          priceLevel: null,
          priceCondition: null,
          tolerance: null,
          contextDigits: [],
        },
      }),
    ),
    false,
    "a delayed entry needs a real trigger",
  );
});

test("the selected contract type and digit parameters are bound to the analysis", () => {
  sendFeed([100.11, 100.12, 100.13]);
  const overUnderId = "run-2:over-under:R_100:DIGITOVER:5::1";
  assert.equal(
    setSnapshot(
      snapshot({
        analysisId: overUnderId,
        family: "over-under",
        contractType: "DIGITOVER",
        barrier: 5,
        entry: {
          action: "enter-now",
          trigger: "immediate",
          windowTicks: 2,
          priceLevel: null,
          priceCondition: null,
          tolerance: null,
          contextDigits: [],
        },
      }),
    ),
    true,
  );
  assert.equal(
    gate("over-under", "R_100", overUnderId, "DIGITOVER", 5, 0),
    true,
  );
  assert.equal(
    gate("over-under", "R_100", overUnderId, "DIGITUNDER", 5, 0),
    false,
  );
  assert.equal(
    gate("over-under", "R_100", overUnderId, "DIGITOVER", 6, 0),
    false,
  );

  const matchesId = "run-3:matches:R_100:DIGITMATCH::7:1";
  assert.equal(
    setSnapshot(
      snapshot({
        analysisId: matchesId,
        family: "matches",
        contractType: "DIGITMATCH",
        barrier: null,
        targetDigit: 7,
      }),
    ),
    true,
  );
  assert.equal(gate("matches", "R_100", matchesId, "DIGITMATCH", 0, 7), true);
  assert.equal(gate("matches", "R_100", matchesId, "DIGITMATCH", 0, 8), false);
});

test("an analysis entry must remain inside its age, tick window and trigger", () => {
  sendFeed([100.11, 100.12, 100.13]);
  assert.equal(
    setSnapshot(
      snapshot({
        entry: {
          action: "enter-on-trigger",
          trigger: "digit",
          windowTicks: 2,
          priceLevel: null,
          priceCondition: null,
          tolerance: null,
          contextDigits: [3],
        },
      }),
    ),
    true,
  );
  assert.equal(
    gate(),
    true,
    "the latest digit matches the measured entry context",
  );

  sendFeed([100.11, 100.12, 100.14]);
  assert.equal(gate(), false, "a changed digit cannot reuse the entry signal");

  sendFeed([100.11, 100.12, 100.13]);
  assert.equal(
    setSnapshot(
      snapshot({ asOfEpoch: Math.floor(clock / 1_000) - 4, validForTicks: 2 }),
    ),
    true,
  );
  assert.equal(
    gate(),
    false,
    "a signal outside its measured tick-validity window must not trade",
  );

  sendFeed([100.11, 100.12, 100.13]);
  assert.equal(setSnapshot(snapshot({ generatedAt: clock - 61_000 })), true);
  assert.equal(gate(), false, "an expired snapshot must not trade");

  assert.equal(setSnapshot(snapshot({ tradeable: false })), true);
  assert.equal(gate(), false, "a non-tradeable master verdict must not enter");
});

test("quote and digit triggers use the latest shared feed value", () => {
  sendFeed([100.11, 100.12, 100.13]);
  const quoteEntry = {
    action: "enter-on-trigger",
    trigger: "quote",
    windowTicks: 2,
    priceLevel: 100.14,
    priceCondition: "below",
    tolerance: 0.02,
    contextDigits: [],
  };
  assert.equal(setSnapshot(snapshot({ entry: quoteEntry })), true);
  assert.equal(gate(), true, "a below-level entry inside tolerance is allowed");

  sendFeed([100.11, 100.12, 100.17]);
  assert.equal(
    gate(),
    false,
    "the opposite side of the quote trigger is not allowed",
  );

  sendFeed([100.11, 100.12, 100.13]);
  assert.equal(
    setSnapshot(
      snapshot({
        entry: {
          action: "enter-now",
          trigger: "immediate",
          windowTicks: 2,
          priceLevel: null,
          priceCondition: null,
          tolerance: null,
          contextDigits: [],
        },
      }),
    ),
    true,
  );
  assert.equal(gate(), true);
  clock += 16_000;
  assert.equal(
    gate(),
    false,
    "a stale market feed must close even an immediate entry gate",
  );
});

test.after(() => {
  Date.now = originalNow;
});
