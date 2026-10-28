import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyDbotAiEdit,
  buildDbotAiStrategyXml,
  describeDbotAiStrategy,
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
  assert.equal(inferDbotAiFamily("Trade differs"), "differs");
  assert.equal(inferDbotAiFamily("Build a differs bot on digit 3"), "differs");
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
  assert.match(xml, /<field name="TRADETYPE_LIST">callput<\/field>/);
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
    analysisId: "over-analysis",
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
    analysisId: "match-analysis",
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

 test("prompt strategies do not include an unfulfillable empty analysis gate", () => {
  const parsed = parseDbotAiDescription("Trade rise on R_100");
  const xml = buildDbotAiStrategyXml(parsed);
  assert.doesNotMatch(xml, /signal_lab_analysis_gate/);
  assert.match(xml, /procedures_callreturn/);
  assert.match(xml, /<field name="PURCHASE_LIST">CALL<\/field>/);
});

test("differs builds a DIGITDIFF purchase with a prediction", () => {
  const parsed = parseDbotAiDescription("Build a differs bot on R_50, digit 3, stake 1");
  assert.equal(parsed?.family, "differs");
  assert.equal(parsed?.targetDigit, 3);
  const xml = buildDbotAiStrategyXml(parsed);
  assert.match(xml, /<field name="TRADETYPE_LIST">matchesdiffers<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">DIGITDIFF<\/field>/);
  assert.match(xml, /has_prediction="true"/);
  assert.equal(tagCount(xml, "block").open, tagCount(xml, "block").close);
});

test("martingale builds a stake variable, init and after-purchase progression", () => {
  const parsed = parseDbotAiDescription(
    "Build an even digit martingale bot on volatility 100, stake 0.5, multiply by 2.2 after a loss, max stake 20, stop after 4 consecutive losses, wait 5 seconds between trades",
  );
  assert.equal(parsed?.family, "even-odd");
  assert.equal(parsed?.symbol, "R_100");
  assert.equal(parsed?.stakingPlan, "martingale");
  assert.equal(parsed?.stakeMultiplier, 2.2);
  assert.equal(parsed?.maxStake, 20);
  assert.equal(parsed?.stopAfterLossStreak, 4);
  assert.equal(parsed?.cooldownSeconds, 5);
  const xml = buildDbotAiStrategyXml(parsed);
  assert.match(xml, /<variables>/);
  assert.match(xml, /ai stake/);
  assert.match(xml, /ai loss streak/);
  assert.match(xml, /variables_get/);
  assert.match(xml, /contract_check_result/);
  assert.match(xml, /math_arithmetic/);
  assert.match(xml, /logic_null/);
  assert.equal(tagCount(xml, "block").open, tagCount(xml, "block").close);
  assert.match(describeDbotAiStrategy(parsed), /martingale ×2\.2/);
});

test("scan, hedge, virtual and digit-filter requests build their blocks", () => {
  const scan = parseDbotAiDescription("Scan all markets and trade the best market rise on R_100");
  assert.equal(scan?.scanMarkets, true);
  const scanXml = buildDbotAiStrategyXml(scan);
  assert.match(scanXml, /signal_lab_scan_markets/);
  assert.match(scanXml, /signal_lab_switch_to_best/);
  assert.match(scanXml, /signal_lab_scan_tradeable/);

  const hedge = parseDbotAiDescription("Hedge bot: buy both rise and fall on V75 1s");
  assert.equal(hedge?.hedge, true);
  assert.equal(hedge?.symbol, "1HZ75V");
  const hedgeXml = buildDbotAiStrategyXml(hedge);
  assert.match(hedgeXml, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(hedgeXml, /<field name="PURCHASE_LIST">PUT<\/field>/);

  const virtual = parseDbotAiDescription("Paper trade over 5 on R_25 in virtual mode, only buy when last digit is 7");
  assert.equal(virtual?.virtual, true);
  assert.deepEqual(virtual?.digitFilter, { kind: "equals", digit: 7 });
  const virtualXml = buildDbotAiStrategyXml(virtual);
  assert.match(virtualXml, /signal_lab_virtual_buy/);
  assert.match(virtualXml, /signal_lab_virtual_settle/);
  assert.match(virtualXml, /last_digit/);
  assert.doesNotMatch(virtualXml, /<block type="purchase"/);
  for (const xml of [scanXml, hedgeXml, virtualXml]) {
    assert.equal(tagCount(xml, "block").open, tagCount(xml, "block").close);
  }
});

test("unsupported concepts are reported as warnings, never silently dropped", () => {
  const parsed = parseDbotAiDescription("Build a rise bot on R_100 when RSI is below 30");
  assert.ok(parsed?.warnings.some((warning) => /RSI|indicator/i.test(warning)));
});

test("follow-up edits change only what they mention", () => {
  const base = parseDbotAiDescription("Build a fall bot on R_75 stake 0.5 for 3 ticks");
  const edited = applyDbotAiEdit(base, "make it martingale x3 and change stake to 1, switch to R_50");
  assert.equal(edited?.stakingPlan, "martingale");
  assert.equal(edited?.stakeMultiplier, 3);
  assert.equal(edited?.stake, 1);
  assert.equal(edited?.symbol, "R_50");
  assert.equal(edited?.direction, "FALL");
  assert.equal(edited?.duration, 3);
  assert.equal(applyDbotAiEdit(base, "what is a martingale?"), null);
});

test("a bare 'hedging bot' request builds a two-legged hedge, not a one-sided bot", () => {
  // Regression: \bhedge\b did not match "hedging", and with no contract
  // family named the parser returned a plain rise/fall bot (or nothing).
  const parsed = parseDbotAiDescription("Build a hedging bot on R_100 stake 1 for 5 ticks");
  assert.equal(parsed?.hedge, true);
  assert.equal(parsed?.family, "rise-fall");
  assert.ok(
    parsed?.warnings.some((warning) => /hedges Rise\/Fall/i.test(warning)),
    "the defaulted family is stated, not silent",
  );

  const xml = buildDbotAiStrategyXml(parsed);
  assert.match(xml, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">PUT<\/field>/);
  // The stock Purchase block has no next-statement connector, so a Purchase
  // carrying a <next> makes Blockly refuse the whole workspace
  // ("Next statement does not exist"). Each hedge leg must sit alone.
  const purchaseBlocks = [...xml.matchAll(/<block type="purchase"[^>]*>([\s\S]*?)<\/block>/g)];
  assert.equal(purchaseBlocks.length, 2);
  for (const [, inner] of purchaseBlocks) assert.doesNotMatch(inner, /<next>/);
  assert.match(xml, /aiHedgeLegMain/);
  assert.match(xml, /aiHedgeLegOpposite/);

  const overUnder = parseDbotAiDescription("Hedging bot: buy both over and under barrier 5 on R_50");
  assert.equal(overUnder?.hedge, true);
  assert.equal(overUnder?.family, "over-under");

  const base = parseDbotAiDescription("Build a fall bot on R_75 stake 0.5 for 3 ticks");
  assert.equal(applyDbotAiEdit(base, "make it a hedging bot")?.hedge, true);
});

test("every family's TRADETYPE_LIST is a real key of the vendor opposites map", () => {
  // The trade engine's trade_definition generator expands
  // `opposites[trade_type.toUpperCase()]` when Run is pressed. Any value that
  // is not one of those keys makes code generation throw before the bot
  // executes a single block, so the workspace sits on "Bot is starting" with
  // zero trades (Rise/Fall shipped as "risefall" instead of "callput"). Pin
  // the builder's emissions to the vendor config itself so they cannot drift.
  const configSource = readFileSync(
    new URL(
      "../../../vendor/deriv-bot/src/external/bot-skeleton/constants/config.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const oppositesSection = configSource.slice(
    configSource.indexOf("opposites: {"),
    configSource.indexOf("BARRIER_TYPES"),
  );
  const oppositesKeys = new Set(
    [...oppositesSection.matchAll(/^\s+([A-Z]+): \[/gm)].map((m) => m[1]),
  );
  assert.ok(oppositesKeys.has("CALLPUT"), "vendor opposites parsed");
  const cases = [
    [{ family: "rise-fall", symbol: "R_100", direction: "CALL" }, "callput"],
    [
      { family: "over-under", symbol: "R_100", digitSide: "DIGITOVER", barrier: 3 },
      "digits",
    ],
    [{ family: "even-odd", symbol: "R_100", paritySide: "DIGITEVEN" }, "digits"],
    [{ family: "matches", symbol: "R_100", targetDigit: 4 }, "digits"],
    [{ family: "differs", symbol: "R_100", targetDigit: 4 }, "digits"],
  ];
  for (const [request, category] of cases) {
    const xml = buildDbotAiStrategyXml({ duration: 3, stake: 1, ...request });
    const tradeType = xml.match(/<field name="TRADETYPE_LIST">([^<]+)<\/field>/)?.[1];
    assert.ok(tradeType, `${request.family} emits TRADETYPE_LIST`);
    assert.ok(
      oppositesKeys.has(tradeType.toUpperCase()),
      `${request.family} TRADETYPE_LIST=${tradeType} must be a vendor opposites key`,
    );
    assert.match(
      xml,
      new RegExp(`<field name="TRADETYPECAT_LIST">${category}</field>`),
    );
  }
});

test("no post-trade cooldown unless one is requested", () => {
  const fast = buildDbotAiStrategyXml({
    family: "rise-fall",
    symbol: "R_100",
    direction: "CALL",
    duration: 2,
    stake: 1,
  });
  assert.ok(!fast.includes('type="timeout"'), "default bot re-arms with no timeout wait");
  assert.match(fast, /<block type="trade_again" id="aiTradeAgain"><\/block>/);

  const slow = buildDbotAiStrategyXml({
    family: "rise-fall",
    symbol: "R_100",
    direction: "CALL",
    duration: 2,
    stake: 1,
    cooldownSeconds: 7,
  });
  assert.match(slow, /<block type="timeout" id="aiCooldown"/);
  assert.match(slow, /<field name="NUM">7<\/field>/);
});
