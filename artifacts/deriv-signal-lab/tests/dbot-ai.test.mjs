import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDbotAiStrategyXml,
  inferDbotAiFamily,
  parseDbotAiDescription,
} from "../src/lib/dbot-ai.ts";

function tagCount(xml, tag) {
  return {
    open: (xml.match(new RegExp(`<${tag}(?:\\s|>)`, "g")) ?? []).length,
    close: (xml.match(new RegExp(`</${tag}>`, "g")) ?? []).length,
  };
}

test("the local builder recognises the supported Deriv contract families", () => {
  assert.equal(
    inferDbotAiFamily("Build a CALL and PUT momentum bot"),
    "rise-fall",
  );
  assert.equal(inferDbotAiFamily("Use an under 4 digit barrier"), "over-under");
  assert.equal(inferDbotAiFamily("Trade odd digits"), "even-odd");
  assert.equal(inferDbotAiFamily("Match digit 7"), "matches");
  assert.equal(inferDbotAiFamily("Trade differs"), null);
  assert.equal(inferDbotAiFamily("Compare matches and differs"), null);
  assert.equal(inferDbotAiFamily("Make a safe bot"), null);
});

test("Rise/Fall XML uses the selected market, direction and bounded trade settings", () => {
  const xml = buildDbotAiStrategyXml({
    family: "rise-fall",
    symbol: "R_75",
    direction: "FALL",
    duration: 3,
    stake: 0.5,
    maxTrades: 20,
    lossLimit: 4,
    profitTarget: 6,
    cooldownSeconds: 2,
    analysisId: "run-1",
  });
  assert.match(xml, /<field name="SYMBOL_LIST">R_75<\/field>/);
  assert.match(xml, /<field name="FAMILY">rise-fall<\/field>/);
  assert.match(xml, /<field name="SYMBOL">R_75<\/field>/);
  assert.match(xml, /<field name="ANALYSIS_ID">run-1<\/field>/);
  assert.match(xml, /<field name="CONTRACT_TYPE">PUT<\/field>/);
  assert.match(xml, /<field name="BARRIER">0<\/field>/);
  assert.match(xml, /<field name="TARGET_DIGIT">0<\/field>/);
  assert.match(
    xml,
    /<block type="signal_lab_analysis_gate" id="aiAnalysisGate"/,
  );
  assert.match(xml, /<field name="TRADETYPE_LIST">risefall<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">PUT<\/field>/);
  assert.match(xml, /<field name="NUM">0\.5<\/field>/);
  assert.match(xml, /<field name="NUM">20<\/field>/);
  assert.match(xml, /<field name="NUM">-4<\/field>/);
  assert.match(xml, /<field name="NUM">6<\/field>/);
  assert.match(xml, /<field name="NUM">3<\/field>/);
  assert.match(xml, /<block type="trade_again"/);
  assert.equal(tagCount(xml, "block").open, tagCount(xml, "block").close);
});

test("digit family XML sets the correct contract, prediction and reusable guard", () => {
  const over = buildDbotAiStrategyXml({
    family: "over-under",
    symbol: "1HZ100V",
    duration: 4,
    digitSide: "DIGITUNDER",
    barrier: 7,
  });
  assert.match(over, /<field name="TRADETYPE_LIST">overunder<\/field>/);
  assert.match(over, /<field name="PURCHASE_LIST">DIGITUNDER<\/field>/);
  assert.match(over, /<field name="CONTRACT_TYPE">DIGITUNDER<\/field>/);
  assert.match(over, /<field name="BARRIER">7<\/field>/);
  assert.match(over, /<field name="NUM">7<\/field>/);
  assert.match(over, /has_prediction="true"/);

  const parity = buildDbotAiStrategyXml({
    family: "even-odd",
    symbol: "R_100",
    duration: 2,
    paritySide: "DIGITODD",
  });
  assert.match(parity, /<field name="TRADETYPE_LIST">evenodd<\/field>/);
  assert.match(parity, /<field name="PURCHASE_LIST">DIGITODD<\/field>/);
  assert.match(parity, /has_prediction="false"/);

  const match = buildDbotAiStrategyXml({
    family: "matches",
    symbol: "R_50",
    duration: 1,
    targetDigit: 9,
  });
  assert.match(match, /<field name="TRADETYPE_LIST">matchesdiffers<\/field>/);
  assert.match(match, /<field name="PURCHASE_LIST">DIGITMATCH<\/field>/);
  assert.match(match, /<field name="TARGET_DIGIT">9<\/field>/);
  assert.match(match, /<field name="NUM">9<\/field>/);

  for (const xml of [over, parity, match]) {
    assert.match(xml, /<block type="procedures_defreturn"/);
    assert.match(xml, /<block type="procedures_callreturn"/);
    assert.match(xml, /<block type="total_profit"/);
    assert.match(xml, /<block type="total_runs"/);
    assert.equal(tagCount(xml, "block").open, tagCount(xml, "block").close);
  }
});

test("generated settings are clamped and XML text is escaped", () => {
  const xml = buildDbotAiStrategyXml({
    family: "matches",
    symbol: "<img src=x>",
    duration: 99,
    stake: 50,
    targetDigit: 99,
    procedureName: "Guard <unsafe> & trade",
    maxTrades: 900,
  });
  assert.match(xml, /<field name="SYMBOL_LIST">R_100<\/field>/);
  assert.match(xml, /<field name="NUM">10<\/field>/);
  assert.match(xml, /<field name="NUM">500<\/field>/);
  assert.match(xml, /Guard unsafe trade/);
  assert.doesNotMatch(xml, /<img/);
});

test("prompt parsing extracts a family, market, stake, duration and custom block name", () => {
  const parsed = parseDbotAiDescription(
    'Build a fall bot on R_75 with stake 0.6 for 3 ticks and create a block called "Session Gate"',
  );
  assert.ok(parsed);
  assert.equal(parsed.family, "rise-fall");
  assert.equal(parsed.symbol, "R_75");
  assert.equal(parsed.direction, "FALL");
  assert.equal(parsed.stake, 0.6);
  assert.equal(parsed.duration, 3);
  assert.equal(parsed.procedureName, "Session Gate");

  const risk = parseDbotAiDescription(
    "Build an under 4 strategy on R_100, stake $1, currency is EUR, max 8 trades, stop loss 6, profit target 12",
  );
  assert.equal(risk?.currency, "EUR");
  assert.equal(risk?.stake, 1);
  assert.equal(risk?.maxTrades, 8);
  assert.equal(risk?.lossLimit, 6);
  assert.equal(risk?.profitTarget, 12);
  assert.match(
    buildDbotAiStrategyXml(risk),
    /<field name="CURRENCY_LIST">EUR<\/field>/,
  );

  const vision = parseDbotAiDescription("Create an AI Vision over-under bot");
  assert.equal(vision?.family, "over-under");
  assert.equal(vision?.usedVisionAi, true);
});
