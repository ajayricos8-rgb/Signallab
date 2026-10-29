// Structural checks on the shipped AI Even Switcher bot.
//
// The bot is a strategy file, so the things that stop it trading are wiring
// mistakes: a scan that never runs before the purchase conditions, a Markov
// read the entry branches never see, a mode variable nothing flips, or a
// recovery that can never revert. These assertions pin that wiring down
// without a browser, the same way the AI Vision bot is pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const XML_PATH = new URL("../src/lib/bot-store/bots/ai-even-switcher.xml", import.meta.url);
// Normalise the serialised formatting: these assertions are about wiring,
// not about whether an attribute sits on the same line as its tag.
const XML = (await readFile(XML_PATH, 'utf8')).replace(/>\s+</g, '><');

const types = [...XML.matchAll(/<block type="([^"]+)"/g)].map((match) => match[1]);
const has = (type) => types.includes(type);
const count = (type) => types.filter((entry) => entry === type).length;
const section = (rootType, nextTypes) => {
  const start = XML.indexOf(`<block type="${rootType}"`);
  if (start < 0) return "";
  const following = nextTypes
    .map((type) => XML.indexOf(`<block type="${type}"`, start + 1))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  return XML.slice(start, following ?? XML.length);
};
const before = section("before_purchase", ["after_purchase"]);
const after = section("after_purchase", []);

test("the bot is a complete Even/Odd DBot program", () => {
  ["trade_definition", "trade_definition_market", "trade_definition_tradetype",
    "trade_definition_tradeoptions", "before_purchase", "after_purchase"].forEach((type) => {
    assert.ok(has(type), `missing mandatory block ${type}`);
  });
  assert.match(XML, /<field name="TRADETYPE_LIST">evenodd<\/field>/);
  assert.ok(has("trade_again"), "the bot restarts its cycle after a settlement");
  assert.equal(count("purchase"), 3, "primary Even + recovery Even + recovery Odd");
  assert.equal((XML.match(/<field name="PURCHASE_LIST">DIGITEVEN<\/field>/g) ?? []).length, 2);
  assert.equal((XML.match(/<field name="PURCHASE_LIST">DIGITODD<\/field>/g) ?? []).length, 1);
});

test("every cycle scans all markets and stands on the strongest", () => {
  assert.match(before, /signal_lab_scan_markets/, "the all-markets scan runs per cycle");
  assert.match(before, /<field name="FAMILY">even-odd<\/field>/);
  assert.match(before, /signal_lab_switch_to_best/, "the bot moves to the scanned market");
  const scanAt = before.indexOf("signal_lab_scan_markets");
  const purchaseAt = before.indexOf('type="purchase"');
  assert.ok(scanAt < purchaseAt, "the scan happens before any purchase can fire");
  // The scanner still ranks all markets; the entry gate independently requires a measured edge.
  assert.match(before, /<value name="MIN_SCORE"><shadow type="math_number" id="evScanFloor"><field name="NUM">0<\/field>/);
});

test("the Markov read measures the even transition chance at the settling tick", () => {
  assert.equal(count("m_transition"), 5, "one transition per even digit");
  for (const digit of [0, 2, 4, 6, 8])
    assert.match(before, new RegExp(`id="evT${digit}To"><field name="NUM">${digit}<\\/field>`));
  assert.equal(count("ticks"), 7, "each transition, the share read and the sample count use the real tick list");
  assert.equal(count("last_digit"), 5, "each transition starts from the current digit");
  // A buy's entry tick is the tick AFTER the purchase, so every transition
  // looks duration+1 ticks out: the tick that settles the contract.
  for (const digit of [0, 2, 4, 6, 8]) {
    assert.match(
      before,
      new RegExp(`id="evHz${digit}"><field name="OP">ADD</field><value name="A"><block type="variables_get" id="evT${digit}Hor"><field name="VAR" id="evVar03">ai duration</field></block></value><value name="B"><shadow type="math_number" id="evHz${digit}One"><field name="NUM">1</field>`),
      `transition to ${digit} targets the settling tick`,
    );
  }
});

test("the parity score blends Markov with even share, and entries are precision-gated", () => {
  // Raw Markov is measured first, then blended 65/35 with the even-digit
  // share so thin transition rows cannot swing the gate on noise alone.
  assert.match(before, /id="evMarkovSet">\s*<field name="VAR" id="evVar14">ai markov raw<\/field>/);
  assert.match(before, /type="m_even_share" id="evShareBlock"/);
  assert.match(before, /id="evBlendShareW"><field name="NUM">0\.35<\/field>/);
  assert.match(before, /id="evBlendRawW"><field name="NUM">0\.65<\/field>/);
  assert.match(before, /id="evBlendSet"><field name="VAR" id="evVar05">ai markov<\/field>/, "the blend is what the gates read");
  // Primary entries are confirmed: no Even into a full-margin Odd read.
  assert.match(before, /type="logic_compare" id="evPrimaryGate"><field name="OP">GTE<\/field>/);
  assert.match(before, /id="evPrimaryGateIf"[\s\S]*?id="evBuyPrimary"/, "the primary buy sits inside the confirmation gate");
  // Market roaming happens only in primary mode: recovery keeps its warm
  // 1000-tick history instead of trading it for a cold stream every cycle.
  assert.match(before, /type="logic_operation" id="evSwitchAnd"/);
  assert.match(before, /type="logic_compare" id="evRoamModeCheck"><field name="OP">EQ<\/field>/);
  assert.match(XML, /id="evIn06"><field name="NUM">54<\/field>/, "the threshold ships at 54 for the less noisy blend");
  assert.match(before, /id="evPrimaryGateThreshold"><field name="VAR" id="evVar06">ai markov threshold<\/field>/, "primary Even requires score >= threshold");
});

test("the parity read is shrunk by its own sample size before anything gates on it", () => {
  // Ten-bin transition rows on a cold stream are mostly noise, so the blend is
  // pulled toward a fair 50% by n / (n + 64): a deep history keeps almost all
  // of its deviation, a thin one keeps under half of it.
  assert.match(before, /type="lists_length" id="evTickCountLen"/, "the read counts the ticks it learned from");
  assert.match(before, /id="evTickCountSet">\s*<field name="VAR" id="evVar22">ai tick count<\/field>/);
  assert.match(before, /id="evShrinkSet">\s*<field name="VAR" id="evVar05">ai markov<\/field>/, "the blend itself is what gets shrunk");
  assert.match(before, /id="evShrinkPriorN"><field name="NUM">64<\/field>/, "the prior is 64 ticks");
  assert.match(before, /id="evShrinkCentre"><field name="NUM">50<\/field>/, "shrinkage is toward a fair 50%");
  // Order matters: the shrink has to happen before the side probability is read.
  const shrinkAt = before.indexOf('id="evShrinkSet"');
  const sideAt = before.indexOf('id="evSideProbSet"');
  assert.ok(shrinkAt > 0 && shrinkAt < sideAt, "the shrunk score is what the side probability and the gates read");
});

test("the bot grades itself and calibrates the side probability by its own record", () => {
  assert.match(XML, /id="evInitGraded">\s*<field name="VAR" id="evVar24">ai graded<\/field>/, "the record is initialised");
  assert.match(XML, /id="evInitCal">\s*<field name="VAR" id="evVar25">ai calibration<\/field>/);
  assert.match(XML, /id="evInitCalN"><field name="NUM">1<\/field>/, "an empty record calibrates to 1");
  // Every settlement is graded, and a win is counted.
  assert.match(after, /id="evGradedSet"/);
  assert.match(after, /id="evWinsIf"[\s\S]{0,400}?CHECK_RESULT">win</);
  assert.match(after, /id="evRecCmp">[\s\S]{0,400}?<field name="NUM">20<\/field>/, "twenty decisions before the record counts");
  // calibration = (wins / graded) x payout; earned record scales up (capped at
  // 1.25), unearned scales down (floored at 0.35).
  assert.match(after, /id="evCalRaw"><field name="OP">MULTIPLY<\/field>/);
  assert.match(after, /id="evCapSet"[\s\S]{0,200}?<field name="NUM">1.25<\/field>/);
  assert.match(after, /id="evFloorSet"[\s\S]{0,200}?<field name="NUM">0.35<\/field>/);
  // And the calibrated value is what the expected value is computed from.
  const calAt = before.indexOf('id="evSideCalSetE"');
  const evAt = before.indexOf('id="evEvSet"');
  assert.ok(calAt > 0 && calAt < evAt, "the side probability is calibrated before EV");
  assert.match(before, /id="evSideCalFactorE">[\s\S]{0,120}?ai calibration/, "the calibration factor is the multiplier");
});

test("mode 0 buys Even; recovery buys whichever parity clears the Markov bar", () => {
  assert.match(before, /id="evModeBranch"/);
  assert.match(before, /<mutation elseif="2"><\/mutation>/, "three-way branch: primary, recovery Even, recovery Odd");
  assert.match(before, /id="evBuyPrimary"/);
  assert.match(before, /id="evBuyRecoveryEven"/);
  assert.match(before, /id="evBuyRecoveryOdd"/);
  // The Odd branch is the complement bar (100 − threshold) on the same read.
  assert.match(before, /id="evOddBar"/);
  assert.match(before, /<field name="OP">MINUS<\/field>/);
});

test("a loss switches to recovery; a win back in profit reverts and resets", () => {
  assert.match(after, /id="evResultWin"/);
  assert.match(after, /id="evModeSwitch"/, "loss branch sets the mode");
  assert.match(after, /id="evModeSwitchN"><field name="NUM">1<\/field>/);
  assert.match(after, /id="evModeRevert"/, "recovered branch clears the mode");
  assert.match(after, /id="evModeRevertN"><field name="NUM">0<\/field>/);
  assert.match(after, /type="total_profit"/, "the revert reads the session profit");
  assert.match(after, /id="evStakeReset"/, "the stake resets on revert");
  assert.match(after, /id="evNotifySwitch"/, "the switch is announced");
  assert.match(after, /id="evNotifyRevert"/, "the revert is announced");
});

test("risk is standard issue: capped martingale ladder, TP/SL guards, balance cap", () => {
  assert.match(after, /id="evStakeGrow"/, "the capped recovery ladder remains available when explicitly configured");
  assert.match(XML, /id="evIn07"><field name="NUM">1<\/field>/, "flat staking is the default");
  assert.match(after, /id="evLadderCheck"/, "the ladder is checked against its cap");
  assert.match(after, /id="evStakeCapReset"/, "past the cap the ladder restarts");
  // The limits must read a number that actually moves. `r_loss_guard` and
  // `r_profit_guard` read the vision brain's session memory, which only
  // `vision_learn` updates — and this bot learns through `m_transition`, never
  // through the brain. Pinned to those blocks the loss limit and the profit
  // target were permanently true, so the documented stops could never fire.
  // They now compare the trade engine's own session profit, which moves on
  // every settled contract.
  assert.equal(count("r_loss_guard"), 0, "the dead memory guards are gone");
  assert.equal(count("r_profit_guard"), 0, "the dead memory guards are gone");
  assert.equal(count("x_session_profit"), 4, "loss and profit limits read the engine session profit, on entries and on trade-again");
  assert.match(before, /id="evGateLoss"[\s\S]{0,200}?<field name="OP">GT<\/field>/);
  assert.match(before, /id="evGateLossFloor"[\s\S]{0,260}?<field name="NUM">-1<\/field>/, "loss limit is compared against minus the limit");
  assert.match(before, /id="evGateProfit"[\s\S]{0,200}?<field name="OP">LT<\/field>/);
  // Session brakes beside them: drawdown floor and losing-streak stop.
  assert.match(before, /id="evGateDrawdown"[\s\S]{0,600}?ai max drawdown/);
  assert.match(before, /id="evGateStreak"[\s\S]{0,600}?ai loss streak stop/);
  assert.ok(has("r_safe_stake"), "the stake is capped by balance share");
  // The bot only stops at its limits (or manually): trade_again is gated by
  // the guards, never skipped silently.
  assert.match(after, /id="evAgainIf"/);
  assert.match(after, /id="evTradeAgain"/);
  assert.match(after, /id="evNotifyLimit"/);
});

test("session brakes are shipped and initialised", () => {
  for (const [name, value] of [["ai max drawdown", "15"], ["ai loss streak stop", "4"]]) {
    assert.ok(XML.includes(name), `${name} is declared`);
  }
  assert.match(XML, /id="evIs14"[\s\S]{0,160}?ai max drawdown[\s\S]{0,160}?<field name="NUM">15<\/field>/);
  assert.match(XML, /id="evIs15"[\s\S]{0,160}?ai loss streak stop[\s\S]{0,160}?<field name="NUM">4<\/field>/);
});

test("the knobs live in Run once at start, all variables declared", () => {
  const declared = new Set([...XML.matchAll(/<variable type="" id="([^"]+)">([^<]+)<\/variable>/g)].map((m) => m[1]));
  const used = new Set([...XML.matchAll(/<field name="VAR" id="([^"]+)"/g)].map((m) => m[1]));
  for (const id of used) assert.ok(declared.has(id), `variable ${id} is declared`);
  for (const knob of ["ai base stake", "ai markov threshold", "ai multiplier", "ai max steps", "ai loss limit", "ai profit target"])
    assert.ok(XML.includes(knob), `knob "${knob}" exists`);
});
