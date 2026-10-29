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
  // The stake variable is read by trade options BEFORE the first Purchase
  // conditions run, so it must be initialised in INITIALIZATION — otherwise
  // the first cycle's amount is unset.
  assert.match(xml, /<statement name="INITIALIZATION">[\s\S]*?aiInitStakeVar/);
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
  assert.match(hedgeXml, /<block type="hedge_purchase"/);
  assert.match(hedgeXml, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(hedgeXml, /<field name="HEDGE_LIST">PUT<\/field>/);

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

  assert.ok(
    parsed?.warnings.some((warning) => /Both hedge legs open at the same time/i.test(warning)),
    "the simultaneous-legs behaviour is stated up front",
  );

  const xml = buildDbotAiStrategyXml(parsed);
  assert.match(xml, /<field name="PURCHASE_LIST">CALL<\/field>/);
  assert.match(xml, /<field name="HEDGE_LIST">PUT<\/field>/);
  // Both legs live in ONE doubled hedge purchase block: it sends the two
  // buy requests together, so the opposite positions open in the same
  // second. Side-by-side Purchase blocks could never do that (the second
  // buy was silently dropped by the engine's single-contract scope), and
  // a Purchase carrying a <next> makes Blockly refuse the workspace — so
  // neither the plain purchase block nor the old alternating pattern may
  // appear in a hedged strategy.
  const hedgeBlocks = [...xml.matchAll(/<block type="hedge_purchase"[^>]*>([\s\S]*?)<\/block>/g)];
  assert.equal(hedgeBlocks.length, 1);
  for (const [, inner] of hedgeBlocks) assert.doesNotMatch(inner, /<next>/);
  assert.doesNotMatch(xml, /<block type="purchase"/);
  assert.doesNotMatch(xml, /ai hedge leg/);

  const overUnder = parseDbotAiDescription("Hedging bot: buy both over and under barrier 5 on R_50");
  assert.equal(overUnder?.hedge, true);
  assert.equal(overUnder?.family, "over-under");

  const base = parseDbotAiDescription("Build a fall bot on R_75 stake 0.5 for 3 ticks");
  assert.equal(applyDbotAiEdit(base, "make it a hedging bot")?.hedge, true);
});

test("hedge legs share the trade-options stake and carry per-leg predictions; paper hedges open both sides together", () => {
  const parsed = parseDbotAiDescription(
    "Hedge bot on R_100 stake 2, hedge leg at 50%, buy both rise and fall for 5 ticks",
  );
  assert.equal(parsed?.hedge, true);
  assert.equal(parsed?.hedgeStakePercent, 50);
  // "buy both rise and fall": the first named side carries the main stake.
  assert.equal(parsed?.direction, "RISE");
  const xml = buildDbotAiStrategyXml(parsed);
  assert.ok(xml.indexOf('PURCHASE_LIST">CALL') < xml.indexOf('HEDGE_LIST">PUT'), "main leg (CALL) is the first contract of the pair");
  // The hedging block has NO second-leg stake configuration — both legs
  // stake the Trade options amount — and the unapplied percentage is
  // called out in the parse warnings instead of being silently dropped.
  assert.doesNotMatch(xml, /SECOND_STAKE/);
  assert.ok(
    parsed?.warnings.some((warning) => /no separate second-leg stake|requested hedge percentage was not applied/i.test(warning)),
    "the unapplied hedge percentage is stated, not silent",
  );
  assert.match(describeDbotAiStrategy(parsed), /both sides open together, same stake/);
  // Default builds ship martingale recovery plus the take-profit/stop-loss
  // risk gate — the hedge bot above named no staking plan, and still gets one.
  assert.equal(parsed?.stakingPlan, "martingale");
  assert.match(xml, /aiStakeGrow/);

  // Over/Under hedges carry a Prediction input per leg on the block.
  const overUnderXml = buildDbotAiStrategyXml(
    parseDbotAiDescription("Hedging bot: buy both over and under barrier 5 on R_50"),
  );
  assert.match(overUnderXml, /<mutation has_prediction="true"/);
  assert.match(overUnderXml, /<value name="PREDICTION">/);
  assert.match(overUnderXml, /<value name="HEDGE_PREDICTION">/);
  assert.doesNotMatch(overUnderXml, /SECOND_STAKE/);

  // Matches hedges against Differs on the same digit, per-leg prediction.
  const matches = parseDbotAiDescription("Hedge digit matches 7 on R_100 stake 1");
  assert.equal(matches?.hedge, true);
  const matchesXml = buildDbotAiStrategyXml(matches);
  assert.match(matchesXml, /<field name="PURCHASE_LIST">DIGITMATCH<\/field>/);
  assert.match(matchesXml, /<field name="HEDGE_LIST">DIGITDIFF<\/field>/);
  assert.match(matchesXml, /<value name="HEDGE_PREDICTION">/);

  // A staking plan coexists with the hedge: both legs stake the Trade
  // options amount, which reads the progressed stake variable, so the two
  // legs move together.
  const martingaleHedge = buildDbotAiStrategyXml({
    family: "rise-fall", symbol: "R_100", duration: 5, stake: 1,
    hedge: true, stakingPlan: "martingale", stakeMultiplier: 2,
  });
  assert.match(martingaleHedge, /aiStakeGrow/);
  assert.match(martingaleHedge, /<block type="hedge_purchase"/);
  assert.doesNotMatch(martingaleHedge, /SECOND_STAKE/);

  // Paper positions are ledger entries, not engine contracts: a virtual
  // hedge opens both directions in the same pass.
  const paper = parseDbotAiDescription("Virtual hedge bot: paper trade both rise and fall on R_100");
  assert.equal(paper?.virtual, true);
  assert.equal(paper?.hedge, true);
  const paperXml = buildDbotAiStrategyXml(paper);
  assert.equal([...paperXml.matchAll(/signal_lab_virtual_buy/g)].length, 2);
  assert.match(paperXml, /<field name="DIRECTION">rise<\/field>/);
  assert.match(paperXml, /<field name="DIRECTION">fall<\/field>/);
  assert.doesNotMatch(paperXml, /<block type="purchase"/);
  for (const x of [xml, matchesXml, martingaleHedge, paperXml]) {
    assert.equal(tagCount(x, "block").open, tagCount(x, "block").close);
  }
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

test("every built bot ships martingale, take profit and stop loss as standard", () => {
  const plain = parseDbotAiDescription("Build an even bot on R_100 stake 0.5");
  assert.equal(plain?.stakingPlan, "martingale", "no staking named -> martingale is standard");
  assert.equal(plain?.stakeMultiplier, 2);
  assert.ok(plain?.lossLimit > 0 && plain?.profitTarget > 0, "TP/SL always set");
  const xml = buildDbotAiStrategyXml(plain);
  assert.match(xml, /aiStakeGrow/, "martingale progression is generated");
  assert.match(xml, /total_profit/, "risk gate reads session P/L");

  // Flat staking is the explicit opt-out, in any of its usual wordings.
  for (const wording of ["flat staking", "fixed stake", "no martingale", "same stake every trade"]) {
    const flat = parseDbotAiDescription(`Rise bot on R_50, ${wording}, stake 1`);
    assert.equal(flat?.stakingPlan, "flat", wording);
  }
});

test("the builder understands the staking systems Deriv traders name", () => {
  const cases = [
    ["Even bot, Fibonacci staking, stake 0.35", "fibonacci"],
    ["Odd bot with reverse d'Alembert step 0.25", "reverse-dalembert"],
    ["Rise bot with Paroli, stop after 3 wins in a row", "reverse-martingale"],
    ["Under 6 bot, Oscar's grind", "reverse-dalembert"],
    ["Even bot using the 1-3-2-6 system", "reverse-martingale"],
    ["Fall bot, labouchere staking", "dalembert"],
    ["Rise bot, double the stake after each loss", "martingale"],
    ["Rise bot, increase stake after losing", "martingale"],
    ["Even bot, Kelly staking at 2 per trade", "flat"],
    ["Odd bot staking 2% of my balance", "flat"],
  ];
  for (const [prompt, plan] of cases)
    assert.equal(parseDbotAiDescription(prompt)?.stakingPlan, plan, prompt);

  // Approximated systems are flagged, never silently substituted.
  const flags = [
    ["Under 6 bot, Oscar's grind", /Oscar's Grind.*Reverse D'Alembert/],
    ["Even bot using the 1-3-2-6 system", /1-3-2-6.*reverse martingale/],
    ["Fall bot, labouchere staking", /Labouchère.*D'Alembert/],
    ["Even bot, Kelly staking at 2 per trade", /Kelly and percent-of-balance/],
    ["Odd bot staking 2% of my balance", /Kelly and percent-of-balance/],
  ];
  for (const [prompt, pattern] of flags)
    assert.ok(
      parseDbotAiDescription(prompt)?.warnings.some((warning) => pattern.test(warning)),
      prompt,
    );

  // Fibonacci generates the two-variable ladder, balanced XML included.
  const fib = parseDbotAiDescription("Even bot on R_75, Fibonacci, stake 0.35, stop loss 10");
  const fibXml = buildDbotAiStrategyXml(fib);
  assert.match(fibXml, /ai previous stake/);
  assert.match(fibXml, /aiFibGrow/);
  assert.match(fibXml, /aiFibCap/);
  assert.match(describeDbotAiStrategy(fib), /Fibonacci ladder/);
  assert.equal(tagCount(fibXml, "block").open, tagCount(fibXml, "block").close);
});

test("plain-word stakes, TP/SL, trade caps and durations are read faithfully", () => {
  assert.equal(parseDbotAiDescription("Rise bot, $2 per trade on R_100")?.stake, 2);
  assert.equal(parseDbotAiDescription("Even bot, risk 1 per trade")?.stake, 1);
  const tpsl = parseDbotAiDescription("Fall bot on R_75 stake 1, TP 12, SL 6");
  assert.equal(tpsl?.profitTarget, 12);
  assert.equal(tpsl?.lossLimit, 6);
  const stops = parseDbotAiDescription("Rise bot, stop when up 15, stop when down 8");
  assert.equal(stops?.profitTarget, 15);
  assert.equal(stops?.lossLimit, 8);
  assert.equal(parseDbotAiDescription("Odd bot, stop after 40 trades")?.maxTrades, 40);
  assert.equal(parseDbotAiDescription("Odd bot, 15 trades only")?.maxTrades, 15);
  const secs = parseDbotAiDescription("Rise bot on R_100 for 5 seconds stake 1");
  assert.equal(secs?.duration, 5, "seconds are honoured as ticks, not dropped to 1");
  assert.ok(secs?.warnings.some((warning) => /seconds duration was read as/.test(warning)));
});

test("named-but-unbuilt contract families are explained in warnings", () => {
  const mixed = parseDbotAiDescription("Over 5 bot on R_100, but make it a touch strategy");
  assert.ok(mixed?.warnings.some((warning) => /Touch\/No Touch/.test(warning)));
  const inOut = parseDbotAiDescription("Rise bot on R_100 with ends between logic");
  assert.ok(inOut?.warnings.some((warning) => /In\/Out contracts/.test(warning)));
  // Higher/Lower graduated: it now builds as itself (never rebuilt as
  // another family), covered in full by the next test.
  assert.equal(
    parseDbotAiDescription("Higher lower bot on R_100 stake 1")?.family,
    "higher-lower",
    "a pure Higher/Lower request builds a Higher/Lower bot",
  );
});

test("Higher/Lower is a first-class family with a 5-tick floor", () => {
  assert.equal(inferDbotAiFamily("Build a higher/lower bot"), "higher-lower");
  assert.equal(inferDbotAiFamily("a higher lower hedging bot"), "higher-lower", "the bare space-separated pair name counts");
  assert.equal(inferDbotAiFamily("higher-lower bot on R_50"), "higher-lower");
  assert.equal(inferDbotAiFamily("buy higher with a barrier of +1"), "higher-lower");
  assert.equal(inferDbotAiFamily("Use an under 4 digit barrier"), "over-under");

  const parsed = parseDbotAiDescription(
    "higher/lower bot, buy higher barrier +1.5, duration 1 tick, stake 1",
  );
  assert.equal(parsed?.family, "higher-lower");
  assert.equal(parsed?.direction, "RISE", "the pair name does not pick the side");
  assert.equal(parsed?.barrierOffset, 1.5);
  assert.ok(
    parsed?.warnings.some((warning) => /5 ticks|invalid barrier/i.test(warning)),
    "the 1-tick request is explained, not silently built",
  );

  const xml = buildDbotAiStrategyXml(parsed);
  assert.match(xml, /<field name="TRADETYPECAT_LIST">callput<\/field>/);
  assert.match(xml, /<field name="TRADETYPE_LIST">higherlower<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">CALL<\/field>/);
  // The single-purchase barrier lives in Trade options…
  assert.match(xml, /has_first_barrier="true"/);
  assert.match(xml, /<field name="BARRIEROFFSETTYPE_LIST">\+<\/field>/);
  assert.match(xml, /<value name="BARRIEROFFSET">/);
  // …and the duration never goes out below Deriv's 5-tick Higher/Lower offer.
  assert.match(xml, /id="aiDuration"><field name="NUM">5<\/field>/);
  assert.match(describeDbotAiStrategy(parsed), /Higher \+1\.5/);
  assert.match(describeDbotAiStrategy(parsed), /5t/);
});

test("a hedged bot carries exactly two barrier/prediction configurations", () => {
  // The user's case: Higher/Lower hedge. Both offsets sit on the hedge
  // block's rows and Trade options carries NOTHING — no third config.
  const parsed = parseDbotAiDescription(
    "build a higher lower hedging bot on R_100 with stake 0.35, higher barrier +1 and lower barrier -1",
  );
  assert.equal(parsed?.family, "higher-lower");
  assert.equal(parsed?.hedge, true);
  const xml = buildDbotAiStrategyXml(parsed);
  const tradeOptions = xml.slice(
    xml.indexOf("trade_definition_tradeoptions"),
    xml.indexOf("before_purchase"),
  );
  assert.doesNotMatch(tradeOptions, /BARRIEROFFSET/, "no barrier in Trade options");
  assert.doesNotMatch(tradeOptions, /PREDICTION/, "no prediction in Trade options");
  assert.match(tradeOptions, /has_first_barrier="false" has_second_barrier="false" has_prediction="false"/);
  assert.match(xml, /<block type="hedge_purchase" id="aiHedgePurchase">/);
  assert.match(xml, /has_prediction="false" has_first_barrier="true"/);
  assert.match(xml, /<field name="BARRIEROFFSETTYPE_LIST">\+<\/field>/);
  assert.match(xml, /<field name="HEDGE_BARRIEROFFSETTYPE_LIST">-<\/field>/);
  assert.match(xml, /<value name="BARRIEROFFSET">/);
  assert.match(xml, /<value name="HEDGE_BARRIEROFFSET">/);
  assert.match(xml, /<field name="PURCHASE_LIST">CALL<\/field><field name="HEDGE_LIST">PUT<\/field>/);
  // And the hedge duration floors at 5 ticks like any Higher/Lower.
  assert.match(xml, /id="aiDuration"><field name="NUM">5<\/field>/);

  // Same rule for digit hedges: predictions live on the hedge block only.
  const overUnder = buildDbotAiStrategyXml(
    parseDbotAiDescription("hedge over under barrier 5 on R_100"),
  );
  const digitOptions = overUnder.slice(
    overUnder.indexOf("trade_definition_tradeoptions"),
    overUnder.indexOf("before_purchase"),
  );
  assert.doesNotMatch(digitOptions, /PREDICTION/, "digit hedge keeps Trade options clean too");
  assert.match(overUnder, /<value name="PREDICTION">/);
  assert.match(overUnder, /<value name="HEDGE_PREDICTION">/);
});

test("strategy archetypes build their measured entry blocks", () => {
  const markov = parseDbotAiDescription("markov even odd bot on R_50 stake 0.5");
  assert.equal(markov?.archetype, "markov");
  const markovXml = buildDbotAiStrategyXml(markov);
  assert.equal((markovXml.match(/type="m_transition"/g) ?? []).length, 5, "five even transitions summed");
  assert.match(markovXml, /ai markov/, "the measurement lives in a variable");
  assert.match(markovXml, /id="aiMarkovGateBar"><field name="NUM">53<\/field>/, "default bar is fair (50) + 3");
  assert.match(describeDbotAiStrategy(markov), /Markov-gated/);

  const momentum = parseDbotAiDescription("momentum rise fall bot on R_75");
  assert.equal(momentum?.archetype, "momentum");
  const momentumXml = buildDbotAiStrategyXml(momentum);
  assert.match(momentumXml, /type="q_slope"/);
  assert.equal((momentumXml.match(/type="purchase"/g) ?? []).length, 2, "slope picks CALL or PUT per tick");

  const reversal = parseDbotAiDescription("reversal bot fading RSI extremes on R_100, 5 ticks");
  assert.equal(reversal?.archetype, "reversal");
  const reversalXml = buildDbotAiStrategyXml(reversal);
  assert.match(reversalXml, /type="q_rsi"/);
  assert.equal((reversalXml.match(/type="purchase"/g) ?? []).length, 2);

  const streak = parseDbotAiDescription("streak bot: after 4 even digits in a row follow the run, even odd R_25");
  assert.equal(streak?.archetype, "streak");
  assert.equal(streak?.streakLength, 4);
  const streakXml = buildDbotAiStrategyXml(streak);
  assert.match(streakXml, /type="m_parity_run"/);

  const comprehensive = parseDbotAiDescription("comprehensive over under bot barrier 5");
  assert.equal(comprehensive?.archetype, "comprehensive");
  assert.equal(comprehensive?.scanMarkets, true);
  const comprehensiveXml = buildDbotAiStrategyXml(comprehensive);
  assert.match(comprehensiveXml, /type="r_loss_guard"/);
  assert.match(comprehensiveXml, /type="r_profit_guard"/);
  assert.match(comprehensiveXml, /type="m_transition"/, "comprehensive includes the Markov gate");

  const ai = parseDbotAiDescription("AI based over under bot barrier 4");
  assert.equal(ai?.archetype, "ai");
  assert.match(buildDbotAiStrategyXml(ai), /type="x_ai_should_buy"/);
});

test("the strategy switcher builds a primary → Markov recovery → revert machine", () => {
  const parsed = parseDbotAiDescription(
    "an AI even bot that analyses all markets and trades the suitable one, after a loss it switches strategy to markov plus ai and after recovery it reverts back to even odd",
  );
  assert.equal(parsed?.family, "even-odd");
  assert.equal(parsed?.archetype, "switcher");
  assert.equal(parsed?.scanMarkets, true, "switchers stand on the scanned market");
  assert.ok(parsed?.warnings.some((warning) => /Switcher built/.test(warning)));

  const xml = buildDbotAiStrategyXml(parsed);
  assert.match(xml, /ai mode/, "mode variable declared");
  assert.match(xml, /id="aiInitModeVar"/, "mode initialised at start");
  assert.match(xml, /type="signal_lab_scan_markets"/);
  assert.match(xml, /type="signal_lab_switch_to_best"/);
  assert.equal((xml.match(/type="m_transition"/g) ?? []).length, 5, "Markov recovery measurement");
  assert.equal((xml.match(/type="purchase"/g) ?? []).length, 3, "primary Even + recovery Even + recovery Odd");
  assert.match(xml, /id="aiPurchasePrimary"/);
  assert.match(xml, /id="aiPurchaseRecoveryOther"/, "recovery can take the favoured parity");
  // After purchase: a loss flips to mode 1; a win back at/above zero flips to 0.
  assert.match(xml, /id="aiModeSwitchSet"/);
  assert.match(xml, /id="aiModeRevertSet"/);
  assert.match(xml, /id="aiModeRecoveredProfit"/, "revert reads the session profit");
  // Standard equipment still applies.
  assert.match(xml, /procedures_defreturn/, "risk gate present");
  assert.equal(parsed?.stakingPlan, "martingale");
});

test("cross-family recovery asks are answered honestly", () => {
  const parsed = parseDbotAiDescription(
    "even odd bot, after a loss switch to rise and fall recovery, revert after recovery",
  );
  assert.equal(parsed?.archetype, "switcher");
  assert.ok(
    parsed?.warnings.some((warning) => /single Trade options trade type|stays inside/.test(warning)),
    "the Rise/Fall recovery limit is named, with Markov covering the role",
  );
});

test("follow-up edits can change the strategy shape", () => {
  const base = parseDbotAiDescription("even bot on R_100 stake 0.5");
  const asMarkov = applyDbotAiEdit(base, "make it a Markov bot");
  assert.equal(asMarkov?.archetype, "markov");
  const asSwitcher = applyDbotAiEdit(base, "turn it into a strategy switcher with markov recovery");
  assert.equal(asSwitcher?.archetype, "switcher");
  assert.equal(asSwitcher?.scanMarkets, true);
  const marketMove = applyDbotAiEdit(base, "switch to R_50");
  assert.equal(marketMove?.symbol, "R_50");
  assert.notEqual(marketMove?.archetype, "switcher", "switching MARKET is not a strategy switcher");

  const hl = parseDbotAiDescription("higher/lower bot on R_100 barrier +1");
  const widened = applyDbotAiEdit(hl, "change the barrier offset to +2.5");
  assert.equal(widened?.barrierOffset, 2.5);
});
