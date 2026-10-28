// Wiring checks for the Higher/Lower "Invalid barrier" fixes in the vendor
// workspace: the engine's 5-tick floor for barrier contracts and the Trade
// options shape sync that keeps a hedge-only workspace to exactly two
// barrier/prediction configurations. The engine and blocks are browser
// code, so these pin the load-bearing source lines the way the shipped-bot
// tests pin XML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const helpers = await readFile(
  new URL("../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/helpers.js", import.meta.url),
  "utf8",
);
const tradeOptions = await readFile(
  new URL("../../../vendor/deriv-bot/src/external/bot-skeleton/scratch/blocks/Binary/Trade Definition/trade_definition_tradeoptions.js", import.meta.url),
  "utf8",
);

test("barrier CALL/PUT requests are floored at 5 ticks before they reach Deriv", () => {
  assert.match(helpers, /export const barrierDurationFloor/, "the floor exists");
  assert.match(helpers, /\['CALL', 'PUT'\]\.includes\(contract_type\)/, "only Higher/Lower-style contracts");
  assert.match(helpers, /trade_option\.barrierOffset != null/, "only requests actually carrying a barrier");
  assert.match(helpers, /trade_option\.duration_unit === 't'/, "only tick durations");
  assert.match(helpers, /Number\(trade_option\.duration\) < 5/, "only below the offered minimum");
  // Both request builders route through it: subscriptions (proposals) and
  // direct buys (hedge legs with their own offsets buy direct).
  assert.match(helpers, /duration: barrierDurationFloor\(type, trade_option\)/, "proposals are floored");
  assert.match(helpers, /duration: barrierDurationFloor\(contract_type, trade_option\)/, "direct buys are floored");
});

test("Trade options hides barrier/prediction when the workspace is hedge-only", () => {
  assert.match(tradeOptions, /isHedgeOnlyWorkspace\(\)/, "the shape check exists");
  assert.match(tradeOptions, /block\.type === 'hedge_purchase'/, "hedge block detected");
  assert.match(tradeOptions, /block\.type === 'purchase' \|\| block\.type === 'payout'/, "a plain buyer keeps the inputs");
  assert.match(tradeOptions, /removeHedgeManagedInputs\(\)/, "the managed inputs can be removed");
  for (const input of ["BARRIEROFFSET", "SECONDBARRIEROFFSET", "PREDICTION_LABEL", "PREDICTION"])
    assert.match(tradeOptions, new RegExp(`this\\.removeInput\\('${input}', true\\)`), `${input} is removed`);
  // Shape syncs on block create/delete (covers workspace loads and edits)…
  assert.match(tradeOptions, /BLOCK_CREATE[\s\S]{0,120}BLOCK_DELETE/, "create/delete events resync the shape");
  // …and the API-driven shape rebuilds refuse to re-add the inputs.
  assert.match(
    tradeOptions,
    /updateBarrierInputs\(should_use_default_type, should_use_default_values\) \{\s*\n\s*\/\/ In a hedge-only workspace/,
    "barrier rebuilds respect the hedge-only shape",
  );
  assert.match(
    tradeOptions,
    /updatePredictionInput\(should_use_default_value\) \{\s*\n\s*\/\/ In a hedge-only workspace/,
    "prediction rebuilds respect the hedge-only shape",
  );
});
