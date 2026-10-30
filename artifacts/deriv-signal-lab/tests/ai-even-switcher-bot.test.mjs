// Structural checks on the shipped AI Even Switcher v2 bot.
//
// The bot is a strategy file, so the things that stop it trading are wiring
// mistakes: a decision the entry branches never see, a side variable nothing
// reads, a stake input fed by the wrong quote, or a brake that can never
// release. These assertions pin that wiring down without a browser, the same
// way the price presets are pinned — and they pin the v2 contract the v1 bot
// broke: both Even and Odd are bought by analysis, never by the P&L.
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
const init = section("trade_definition", ["tick_analysis", "before_purchase", "after_purchase"]);
const tick = section("tick_analysis", ["before_purchase", "after_purchase"]);
const before = section("before_purchase", ["after_purchase"]);
const after = section("after_purchase", []);

test("the bot is a complete Even/Odd DBot program", () => {
  ["trade_definition", "trade_definition_market", "trade_definition_tradetype",
    "trade_definition_tradeoptions", "tick_analysis", "before_purchase", "after_purchase"].forEach((type) => {
    assert.ok(has(type), `missing mandatory block ${type}`);
  });
  assert.match(XML, /<field name="TRADETYPE_LIST">evenodd<\/field>/);
  assert.match(XML, /<field name="TRADETYPECAT_LIST">digits<\/field>/);
  // Even/Odd takes no barrier and no digit prediction: the trade options say
  // so explicitly, or the contract rejects the purchase inputs.
  assert.match(XML, /has_first_barrier="false" has_second_barrier="false" has_prediction="false"/);
  assert.ok(has("trade_again"), "the bot restarts its cycle after a settlement");
});

test("both sides are bought, and the side comes from the analysis", () => {
  assert.equal(count("purchase"), 2, "one Even purchase, one Odd purchase — no recovery-only Odd");
  assert.equal((XML.match(/<field name="PURCHASE_LIST">DIGITEVEN<\/field>/g) ?? []).length, 1);
  assert.equal((XML.match(/<field name="PURCHASE_LIST">DIGITODD<\/field>/g) ?? []).length, 1);
  // The purchase branch reads the scored side: side == 1 buys Even, else Odd.
  const sideAt = before.indexOf('>ai side</field>');
  const evenAt = before.indexOf('PURCHASE_LIST">DIGITEVEN');
  const oddAt = before.indexOf('PURCHASE_LIST">DIGITODD');
  assert.ok(sideAt > 0 && sideAt < evenAt && evenAt < oddAt,
    "the side read comes first, Even on the == 1 branch, Odd on the else");
});

test("the ensemble is scored fresh every cycle in cadence mode", () => {
  assert.equal(count("x_parity_decision"), 2, "one score at arming, one per tick");
  assert.equal((XML.match(/<field name="REQUIRE">always<\/field>/g) ?? []).length, 2);
  assert.match(tick, /x_parity_decision/, "the tick section re-scores before the gates run");
  assert.match(tick, />ai decision<\//, "the fresh plan is stored where the gates read it");
  assert.match(tick, /x_parity_decision_part/, "ready and side are unpacked from the plan");
});

test("entries need a ready model, a record, a readable market and cool books", () => {
  assert.match(before, /x_parity_risk/, "the session risk block guards the entry");
  assert.match(before, /PART">stand-down/, "a broken graded record vetoes the entry");
  assert.match(before, /PART">dna-score/, "unreadable markets are refused");
  assert.match(before, /PART">skill/, "a skill-less blend is refused");
  assert.match(before, />ai loss streak<\//, "the losing-streak cool-off is wired");
  assert.match(before, />ai max drawdown<\//, "the drawdown pause is wired");
  assert.match(before, /x_parity_reason/, "entries journal why the model said yes");
});

test("the stake is sized from the side probability and its own quote", () => {
  assert.equal(count("x_parity_stake"), 1, "one stake computation per cycle");
  assert.match(tick, /PART">probability/, "the stake reads the side probability");
  assert.match(tick, /PART">quote/, "the stake reads the winning side's own quote");
  assert.match(XML, /<value name="AMOUNT">.*>stake<\//s, "the computed stake feeds the trade options");
});

test("the scout roams the digit markets under a floor and a dwell", () => {
  assert.equal(count("x_parity_auto_market"), 1);
  assert.match(tick, /<field name="MODE">suitable<\/field>/);
  assert.match(tick, />ai scout floor<\//);
  assert.match(tick, />ai scout dwell<\//);
  assert.match(tick, />ai market<\//, "the chosen market is remembered for the journal");
});

test("every skip names its gate and every settlement teaches the journal", () => {
  assert.equal(count("x_parity_reason"), 2, "entry reasons and skip reasons");
  for (const report of ["x_parity_forecast", "x_parity_payouts", "x_parity_audit",
      "x_parity_league", "x_parity_dna", "x_parity_brain", "x_parity_reverse"]) {
    assert.match(after, new RegExp(report), `the journal prints ${report}`);
  }
  assert.match(init, /x_parity_dna/, "arming prints the market fingerprint first");
  assert.match(init, /x_parity_brain/, "arming prints the AI core");
  assert.match(init, /x_parity_reverse/, "arming prints the reverse engineering");
});

test("the shipped knobs match the documented defaults", () => {
  const knob = (name, value) => new RegExp(
    `${name}<\\/field><value name="VALUE"><block type="math_number"[^>]*><field name="NUM">${value}<\\/field>`);
  for (const [name, value] of [
      ["ai duration", "5"], ["ai payout", "1.95"], ["ai entry slip", "1"],
      ["ai loss streak stop", "4"], ["ai max drawdown", "15"], ["ai dna floor", "35"],
      ["ai scout floor", "15"], ["ai scout dwell", "90"], ["ai loss limit", "30"],
      ["ai profit target", "50"], ["ai stake percent", "2"], ["ai max stake", "1.5"],
      ["ai kelly fraction", "0.1"], ["ai skill floor", "-1"],
  ]) assert.match(init, knob(name, value), `knob ${name} ships as ${value}`);
});

test("the cool-off counter follows the settled contract, not the balance", () => {
  assert.equal(count("contract_check_result"), 1);
  assert.match(after, /<field name="CHECK_RESULT">win<\/field>/);
  const resetAt = after.indexOf('CHECK_RESULT">win');
  const streakAt = after.indexOf('>ai loss streak</field>', resetAt);
  assert.ok(streakAt > resetAt, "a win resets the streak right where the result is checked");
});

test("the session brakes stop the cycle on ruin or target", () => {
  assert.equal(count("x_parity_risk"), 2, "risk guards the entry and the restart");
  const brakesAt = after.indexOf("x_parity_risk");
  const againAt = after.indexOf('type="trade_again"');
  assert.ok(brakesAt > 0 && brakesAt < againAt, "the restart is gated on the risk block");
  assert.match(after, />ai loss limit<\//);
  assert.match(after, />ai profit target<\//);
});
