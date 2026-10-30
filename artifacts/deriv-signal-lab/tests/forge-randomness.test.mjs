import test from "node:test";
import assert from "node:assert/strict";
import {
  auditDigitRandomness,
  forecastDigitAt,
  forecastNextDigit,
  RANDOMNESS_AUDIT,
} from "../src/lib/forge/randomness-audit.ts";

function sfc32(seed) {
  let a = 0x9e3779b9;
  let b = 0x243f6a88 + seed;
  let c = 0xb7e15162;
  let d = 0x12345678 ^ (seed * 7919);
  const next = () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let index = 0; index < 40; index += 1) next();
  return next;
}

const fairDigits = (seed, count) => {
  const random = sfc32(seed);
  return Array.from({ length: count }, () => Math.floor(random() * 10));
};

const repeatingCycle = (count) =>
  Array.from({ length: count }, (_, index) => index % 10);

test("next-digit probabilities are finite, normalized, and ordered", () => {
  const forecast = forecastNextDigit(repeatingCycle(1_000));
  assert.ok(forecast);
  assert.equal(forecast.probabilities.length, 10);
  assert.ok(
    forecast.probabilities.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ),
  );
  assert.ok(
    Math.abs(
      forecast.probabilities.reduce((sum, value) => sum + value, 0) - 1,
    ) < 1e-12,
  );
  assert.deepEqual(forecast.topDigits, [0, 1, 2]);
  assert.ok(forecast.probabilities[0] > 0.8);
  assert.equal(forecast.previousDigit, 9);
});

test("a forecast at a historical origin cannot see rewritten future digits", () => {
  const original = fairDigits(11, 900);
  const origin = 500;
  const changedFuture = [
    ...original.slice(0, origin),
    ...Array.from(
      { length: original.length - origin },
      (_, index) => (index * 7 + 3) % 10,
    ),
  ];
  const before = forecastDigitAt(original, origin);
  const after = forecastDigitAt(changedFuture, origin);
  assert.deepEqual(after, before);
});

test("the walk-forward probe detects a real repeatable transition on its later rows", () => {
  const result = auditDigitRandomness(repeatingCycle(2_000), {
    selectionPool: 13,
  });
  assert.equal(result.forecastRows, 2_000 - RANDOMNESS_AUDIT.warmupTicks);
  assert.equal(result.passedHistoricalScreen, true);
  assert.ok(result.brierSkill > 0.8, `brier skill ${result.brierSkill}`);
  assert.ok(result.logLossSkill > 0.5, `log-loss skill ${result.logLossSkill}`);
  assert.ok(
    result.pairedZ >= result.zBar,
    `${result.pairedZ} must clear ${result.zBar}`,
  );
  assert.equal(
    result.chiSquare,
    0,
    "a deterministic cycle can be frequency-uniform while still having serial structure",
  );
  assert.ok(Math.abs(result.normalizedEntropy - 1) < 1e-12);
});

test("an iid fair digit stream does not pass the selection-aware screen", () => {
  const result = auditDigitRandomness(fairDigits(91, 2_000), {
    selectionPool: 13,
  });
  assert.equal(result.forecastRows, 2_000 - RANDOMNESS_AUDIT.warmupTicks);
  assert.equal(result.passedHistoricalScreen, false);
  assert.equal(result.fairBrier, 0.9);
  assert.ok(result.fairLogLoss > 2.3 && result.fairLogLoss < 2.4);
  assert.ok(result.zBar > RANDOMNESS_AUDIT.minimumZ);
});

test("thin data and invalid symbols fail closed instead of creating a forecast claim", () => {
  const result = auditDigitRandomness([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1, 1.5,
  ]);
  assert.equal(result.sampleSize, 10);
  assert.equal(result.forecastRows, 0);
  assert.equal(result.passedHistoricalScreen, false);
  assert.equal(result.brierSkill, null);
  assert.equal(result.chiSquarePValue, null);
});

test("the frequency chi-square diagnostic is descriptive and bounded", () => {
  const result = auditDigitRandomness(repeatingCycle(1_000));
  assert.equal(result.chiSquare, 0);
  assert.ok(result.chiSquarePValue >= 0 && result.chiSquarePValue <= 1);
  assert.ok(result.chiSquarePValue > 0.99);
  assert.equal(result.repeatedDigitRate, 0);
  assert.ok(result.repeatedDigitZ < 0);
});
