// Wiring checks for the Higher/Lower "Invalid barrier" fixes in the vendor
// workspace: the engine's 5-tick floor for barrier contracts, the
// prediction guard (a digit must never become a price barrier), the
// hedge block's load-time row sync and Deriv-suggested barrier defaults,
// and the Trade options shape sync that keeps a hedge-only workspace to
// exactly two barrier/prediction configurations. The engine and blocks
// are browser code, so these pin the load-bearing source lines the way
// the shipped-bot tests pin XML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const helpers = await readFile(
  new URL("../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/helpers.js", import.meta.url),
  "utf8",
);
const purchase = await readFile(
  new URL("../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/trade/Purchase.js", import.meta.url),
  "utf8",
);
const tradeOptions = await readFile(
  new URL("../../../vendor/deriv-bot/src/external/bot-skeleton/scratch/blocks/Binary/Trade Definition/trade_definition_tradeoptions.js", import.meta.url),
  "utf8",
);
const hedgeBlock = await readFile(
  new URL("../../../vendor/deriv-bot/src/external/bot-skeleton/scratch/blocks/Binary/Before Purchase/hedge_purchase.js", import.meta.url),
  "utf8",
);

test("barrier price-contract requests are floored at 5 ticks before they reach Deriv", () => {
  assert.match(helpers, /export const barrierDurationFloor/, "the floor exists");
  assert.match(helpers, /PRICE_BARRIER_CONTRACT_TYPES/, "all price-barrier contracts are covered, not only Higher/Lower");
  for (const type of ["'CALL'", "'PUT'", "'ONETOUCH'", "'NOTOUCH'", "'EXPIRYRANGE'", "'UPORDOWN'"])
    assert.ok(helpers.includes(type), `floor covers ${type}`);
  assert.match(
    helpers,
    /trade_option\.barrierOffset != null \|\| trade_option\.secondBarrierOffset != null/,
    "either barrier offset triggers the floor",
  );
  assert.match(helpers, /trade_option\.duration_unit === 't'/, "only tick durations");
  assert.match(helpers, /Number\(trade_option\.duration\) < 5/, "only below the offered minimum");
  // Both request builders route through it: subscriptions (proposals) and
  // direct buys (hedge legs with their own offsets buy direct).
  assert.match(helpers, /duration: barrierDurationFloor\(type, trade_option\)/, "proposals are floored");
  assert.match(helpers, /duration: barrierDurationFloor\(contract_type, trade_option\)/, "direct buys are floored");
});

test("a digit prediction can never be sent as a price barrier", () => {
  assert.match(helpers, /PREDICTION_CONTRACT_TYPES/, "prediction mapping is allow-listed");
  for (const type of ["'DIGITOVER'", "'DIGITUNDER'", "'DIGITMATCH'", "'DIGITDIFF'"])
    assert.ok(helpers.includes(type), `prediction allowed for ${type}`);
  assert.match(
    helpers,
    /PREDICTION_CONTRACT_TYPES\.includes\(type\) && trade_option\.prediction != null/,
    "proposals only map prediction→barrier for digit contracts",
  );
  assert.match(
    helpers,
    /PREDICTION_CONTRACT_TYPES\.includes\(contract_type\) && trade_option\.prediction != null/,
    "direct buys only map prediction→barrier for digit contracts",
  );
  // The hedge sanitize is contract-aware at the leg level too.
  assert.match(purchase, /const sanitizeBarrierOptions = \(contractType, options\)/);
  assert.match(purchase, /type\.startsWith\('DIGIT'\)/, "digit legs keep predictions, price legs cannot inherit one");
  assert.match(purchase, /legTradeOptions\(contract_type, main_options\)/);
  assert.match(purchase, /legTradeOptions\(hedge_contract_type, hedge_options\)/);
});

test("the hedge block syncs its rows on load and defaults to Deriv-suggested barriers", () => {
  assert.match(hedgeBlock, /is_load_event/, "loads are detected explicitly");
  assert.match(
    hedgeBlock,
    /is_load_event && event\.type === window\.Blockly\.Events\.BLOCK_CREATE/,
    "rows sync on load even with the flyout open",
  );
  assert.match(hedgeBlock, /applyDefaultBarriers/, "rows default from contracts_for");
  assert.match(hedgeBlock, /contracts_for\s*\n?\s*\.getBarriers\(symbol, trade_type, duration_unit, barrier_types\)/);
  assert.match(hedgeBlock, /target\?\.isShadow\(\)/, "only built-in shadow defaults are ever written");
});

test("Trade options hides barrier/prediction when the workspace is hedge-only", () => {
  assert.match(tradeOptions, /isHedgeOnlyWorkspace\(\)/, "the shape check exists");
  assert.match(tradeOptions, /block\.type === 'hedge_purchase'/, "hedge block detected");
  assert.match(tradeOptions, /block\.type === 'purchase' \|\| block\.type === 'payout'/, "a plain buyer keeps the inputs");
  assert.match(tradeOptions, /syncHedgeOnlyShape\(\)/, "the sync is a named operation");
  for (const input of ["BARRIEROFFSET", "SECONDBARRIEROFFSET", "PREDICTION_LABEL", "PREDICTION"])
    assert.match(tradeOptions, new RegExp(`this\\.removeInput\\('${input}', true\\)`), `${input} is removed`);
  // The sync runs ahead of the flyout guard so loads shed the inputs.
  const syncAt = tradeOptions.indexOf("this.syncHedgeOnlyShape()");
  const guardAt = tradeOptions.indexOf("window.Blockly.derivWorkspace.isFlyoutVisible", syncAt - 2000);
  assert.ok(syncAt > 0 && (guardAt === -1 || guardAt > syncAt), "sync runs before the flyout early-return");
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
