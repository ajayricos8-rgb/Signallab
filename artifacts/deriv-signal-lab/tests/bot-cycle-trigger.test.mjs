// The premium bots are tick-driven: a new tick is the event that makes them
// re-decide, and the configured interval is only a watchdog. These tests pin the
// rule down, because the previous scheduler waited a whole decision interval
// (1.5–2 s) after the conditions were already met.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOT_CYCLE_MIN_SPACING_MS,
  shouldStartBotCycle,
} from '../src/hooks/use-bot-cycle-trigger.ts';
import { defaultRiskConfig } from '../src/lib/digit-bot/types.ts';
import { defaultRiseFallConfig } from '../src/lib/rise-fall-bot/types.ts';
import { defaultHedgingBotConfig } from '../src/lib/hedging-bot/types.ts';
import { defaultMafiaBotConfig } from '../src/lib/mafia-bot/types.ts';
import { BOT_CONFIG_VERSION, configNeedsReset, markConfigVersion } from '../src/lib/bot-config-version.ts';

test('the spacing floor only deduplicates, it never waits a decision interval', () => {
  assert.ok(BOT_CYCLE_MIN_SPACING_MS <= 250, 'a new tick must not be held for longer than a fraction of a second');
  assert.equal(shouldStartBotCycle({ now: 1_000, lastCycleAt: 0, minSpacingMs: BOT_CYCLE_MIN_SPACING_MS }), true);
  assert.equal(shouldStartBotCycle({ now: 1_050, lastCycleAt: 1_000, minSpacingMs: BOT_CYCLE_MIN_SPACING_MS }), false);
  assert.equal(shouldStartBotCycle({ now: 1_200, lastCycleAt: 1_000, minSpacingMs: BOT_CYCLE_MIN_SPACING_MS }), true);
});

test('every tick evaluates, so a condition that appears is acted on in the same second', () => {
  // Two ticks 900 ms apart, with the old 1 500 ms interval these would have been
  // coalesced into one cycle and the first opportunity would have been skipped.
  const first = shouldStartBotCycle({ now: 10_000, lastCycleAt: 9_100, minSpacingMs: BOT_CYCLE_MIN_SPACING_MS });
  const second = shouldStartBotCycle({ now: 10_900, lastCycleAt: 10_000, minSpacingMs: BOT_CYCLE_MIN_SPACING_MS });
  assert.equal(first, true);
  assert.equal(second, true);
});

test('force always runs, for Start and for the operator button', () => {
  assert.equal(shouldStartBotCycle({ now: 5_000, lastCycleAt: 5_000, minSpacingMs: 10_000, force: true }), true);
  assert.equal(shouldStartBotCycle({ now: 5_000, lastCycleAt: 5_000, minSpacingMs: 10_000, force: false }), false);
});

test('a nonsense spacing never blocks the cycle', () => {
  assert.equal(shouldStartBotCycle({ now: 5_000, lastCycleAt: 5_000, minSpacingMs: Number.NaN }), true);
  assert.equal(shouldStartBotCycle({ now: 5_000, lastCycleAt: 5_000, minSpacingMs: -50 }), true);
});

test('no bot is shipped with a deny-by-default expected-value brake', () => {
  // The brake exists and can be switched on, but the entry is the rule the
  // operator configured, not a second statistical veto after the rule fired.
  assert.equal(defaultRiseFallConfig().requirePositiveExpectedValue, false);
  assert.equal(defaultHedgingBotConfig().requirePositiveExpectedValue, false);
});

test('no bot ships with a multi-second decision interval as its entry cadence', () => {
  assert.ok(defaultRiskConfig().decisionIntervalMs <= 1_000);
  assert.ok(defaultRiseFallConfig().decisionIntervalMs <= 1_000);
  assert.ok(defaultHedgingBotConfig().decisionIntervalMs <= 1_000);
  assert.ok(defaultMafiaBotConfig().decisionIntervalMs <= 1_000);
});

test('the digit bot may re-enter on the next tick, not ten ticks later', () => {
  const config = defaultRiskConfig();
  assert.ok(config.minTicksBetweenEntries <= 1, 'an entry must not be held ten ticks after the previous one');
  assert.ok(config.cooldownAfterContractMs <= 1_000, 'the post-settlement cooldown must stay under a second');
});

test('a stored config older than the current shape is rebuilt from defaults', () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
  };
  try {
    const key = 'signal-lab-digital-bot-config';
    assert.equal(configNeedsReset(key), true, 'no marker means a legacy config');
    markConfigVersion(key);
    assert.equal(store.get(`${key}-version`), String(BOT_CONFIG_VERSION));
    assert.equal(configNeedsReset(key), false);

    store.set(`${key}-version`, String(BOT_CONFIG_VERSION - 1));
    assert.equal(configNeedsReset(key), true, 'an older marker is migrated once');

    // Each bot migrates on its own marker: one bot resetting must not silently
    // re-default a bot whose stored configuration is already current.
    markConfigVersion(key);
    assert.equal(configNeedsReset(key), false);
    assert.equal(configNeedsReset('signal-lab-mafia-bot-config'), true);

    delete globalThis.window;
    assert.equal(configNeedsReset(key), false, 'no storage is not a reset');
    markConfigVersion(key);
  } finally {
    delete globalThis.window;
  }
});
