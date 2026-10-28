export type DbotAiFamily = "rise-fall" | "over-under" | "even-odd" | "matches" | "differs";
export type DbotAiDirection = "RISE" | "FALL";
export type DbotAiDigitSide = "DIGITOVER" | "DIGITUNDER";
export type DbotAiParitySide = "DIGITEVEN" | "DIGITODD";
export type DbotAiDurationUnit = "t" | "m";
/** How the stake moves after each settled contract. */
export type DbotAiStakingPlan = "flat" | "martingale" | "reverse-martingale" | "dalembert";
/** An entry filter on the bot market's own last digit (`last_digit` block). */
export type DbotAiDigitFilter =
  | { kind: "equals"; digit: number }
  | { kind: "parity"; parity: "even" | "odd" }
  | { kind: "over"; digit: number }
  | { kind: "under"; digit: number };

export type DbotAiStrategyRequest = {
  family: DbotAiFamily;
  symbol: string;
  duration: number;
  durationUnit?: DbotAiDurationUnit;
  currency?: string;
  stake?: number;
  direction?: DbotAiDirection;
  digitSide?: DbotAiDigitSide;
  barrier?: number;
  paritySide?: DbotAiParitySide;
  targetDigit?: number;
  /** Blockly's user-defined procedure becomes a reusable custom block. */
  procedureName?: string;
  /** Exact Signal Lab analysis snapshot required by the generated entry gate. */
  analysisId?: string;
  maxTrades?: number;
  lossLimit?: number;
  profitTarget?: number;
  cooldownSeconds?: number;
  /** Stake progression after each trade (default flat). */
  stakingPlan?: DbotAiStakingPlan;
  /** Martingale / reverse-martingale multiplier (default 2). */
  stakeMultiplier?: number;
  /** D'Alembert unit added after a loss and removed after a win. */
  stakeStep?: number;
  /** Hard ceiling for a progressed stake. */
  maxStake?: number;
  /** Stop entering after this many losses in a row. */
  stopAfterLossStreak?: number;
  /** Stop entering after this many wins in a row. */
  stopAfterWinStreak?: number;
  /** Only enter when the last digit passes this filter. */
  digitFilter?: DbotAiDigitFilter;
  /** Scan every shared market first and trade the strongest one. */
  scanMarkets?: boolean;
  /** Minimum scan lean (0–1) the best market must clear. */
  scanMinScore?: number;
  /** Buy both sides at once (rise+fall, or over+under on one barrier). */
  hedge?: boolean;
  /** Paper-trade with the virtual blocks instead of real purchases. */
  virtual?: boolean;
};

export type ParsedBotDescription = DbotAiStrategyRequest & {
  usedVisionAi: boolean;
  /** Plain-language notes for anything described that was NOT built. */
  warnings: string[];
};

export type DbotAiAnalysisSnapshot = {
  analysisId: string;
  family: DbotAiFamily;
  symbol: string;
  contractType:
    | "CALL"
    | "PUT"
    | "DIGITOVER"
    | "DIGITUNDER"
    | "DIGITEVEN"
    | "DIGITODD"
    | "DIGITMATCH";
  barrier: number | null;
  targetDigit: number | null;
  generatedAt: number;
  asOfEpoch: number;
  maxAgeMs: number;
  validForTicks: number;
  tradeable: boolean;
  entry: {
    action: "enter-now" | "enter-on-trigger" | "no-edge";
    trigger: "immediate" | "quote" | "digit";
    windowTicks: number;
    priceLevel: number | null;
    priceCondition: "above" | "below" | null;
    tolerance: number | null;
    contextDigits: number[];
  };
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));
const numberOr = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? Number(value) : fallback;
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function cleanSymbol(symbol: string): string {
  const candidate = symbol.trim().toUpperCase();
  return /^(?:R_\d{1,3}|1HZ\d{1,3}V)$/.test(candidate) ? candidate : "R_100";
}

function cleanCurrency(currency: string | undefined): string {
  const candidate = (currency ?? "").trim().toUpperCase();
  return /^[A-Z]{3,5}$/.test(candidate) ? candidate : "USD";
}

function cleanProcedureName(name: string | undefined): string {
  const cleaned = (name ?? "AI Risk Gate")
    .replace(/[<>"'&]/g, "")
    .replace(/[^\p{L}\p{N}_ -]/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 44);
  return cleaned || "AI Risk Gate";
}

function numberBlock(id: string, value: number): string {
  return `<shadow type="math_number" id="${id}"><field name="NUM">${escapeXml(String(value))}</field></shadow>`;
}

function comparisonBlock(
  id: string,
  operator: "GT" | "LT",
  valueBlock: "total_profit" | "total_runs",
  threshold: number,
): string {
  return `<block type="logic_compare" id="${id}"><field name="OP">${operator}</field><value name="A"><block type="${valueBlock}" id="${id}Value"></block></value><value name="B">${numberBlock(`${id}Limit`, threshold)}</value></block>`;
}

/** Workspace variables the generated strategy may declare, with stable ids. */
const AI_VARIABLES = {
  stake: { id: "aiStakeVariable", name: "ai stake" },
  lossStreak: { id: "aiLossStreakVariable", name: "ai loss streak" },
  winStreak: { id: "aiWinStreakVariable", name: "ai win streak" },
} as const;
type AiVariableKey = keyof typeof AI_VARIABLES;

function variablesSection(keys: AiVariableKey[]): string {
  if (!keys.length) return "";
  const entries = keys
    .map((key) => {
      const variable = AI_VARIABLES[key];
      return `<variable type="" id="${variable.id}" islocal="false" iscloud="false">${escapeXml(variable.name)}</variable>`;
    })
    .join("");
  return `<variables>${entries}</variables>`;
}

function variableField(key: AiVariableKey): string {
  const variable = AI_VARIABLES[key];
  return `<field name="VAR" id="${variable.id}" variabletype="">${escapeXml(variable.name)}</field>`;
}

function variablesGet(id: string, key: AiVariableKey): string {
  return `<block type="variables_get" id="${id}">${variableField(key)}</block>`;
}

function variablesSet(id: string, key: AiVariableKey, valueXml: string): string {
  return `<block type="variables_set" id="${id}">${variableField(key)}<value name="VALUE">${valueXml}</value></block>`;
}

function numberValue(id: string, value: number): string {
  return `<block type="math_number" id="${id}"><field name="NUM">${escapeXml(String(value))}</field></block>`;
}

function arithmetic(id: string, op: "ADD" | "MINUS" | "MULTIPLY", a: string, b: string): string {
  return `<block type="math_arithmetic" id="${id}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
}

function compareValues(id: string, op: "EQ" | "GT" | "GTE" | "LT" | "LTE", a: string, b: string): string {
  return `<block type="logic_compare" id="${id}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
}

/** Fold boolean blocks into one AND tree (a single block passes through). */
function andAll(idPrefix: string, conditions: string[]): string {
  if (conditions.length === 1) return conditions[0];
  let combined = conditions[0];
  for (let index = 1; index < conditions.length; index += 1) {
    combined = `<block type="logic_operation" id="${idPrefix}And${index}"><field name="OP">AND</field><value name="A">${combined}</value><value name="B">${conditions[index]}</value></block>`;
  }
  return combined;
}

/** Chain statement blocks with <next> so they run top to bottom. */
function chainStatements(blocks: string[]): string {
  if (!blocks.length) return "";
  let chained = blocks[blocks.length - 1];
  for (let index = blocks.length - 2; index >= 0; index -= 1) {
    const block = blocks[index];
    const closing = block.lastIndexOf("</block>");
    chained = `${block.slice(0, closing)}<next>${chained}</next>${block.slice(closing)}`;
  }
  return chained;
}

/** "set <var> to <initial> if it has never been set" — the quick-strategy init pattern. */
function initVariableIfNull(id: string, key: AiVariableKey, initial: number): string {
  const isNull = compareValues(
    `${id}Null`,
    "EQ",
    variablesGet(`${id}Get`, key),
    `<block type="logic_null" id="${id}NullValue"></block>`,
  );
  return `<block type="controls_if" id="${id}"><value name="IF0">${isNull}</value><statement name="DO0">${variablesSet(`${id}Set`, key, numberValue(`${id}Initial`, initial))}</statement></block>`;
}

function riskGateDefinition(
  request: Required<
    Pick<
      DbotAiStrategyRequest,
      "procedureName" | "maxTrades" | "lossLimit" | "profitTarget"
    >
  > &
    Pick<DbotAiStrategyRequest, "stopAfterLossStreak" | "stopAfterWinStreak">,
): string {
  const conditions = [
    comparisonBlock("aiGateLoss", "GT", "total_profit", -request.lossLimit),
    comparisonBlock("aiGateProfit", "LT", "total_profit", request.profitTarget),
    comparisonBlock("aiGateTrades", "LT", "total_runs", request.maxTrades),
  ];
  if (request.stopAfterLossStreak)
    conditions.push(
      compareValues(
        "aiGateLossStreak",
        "LT",
        variablesGet("aiGateLossStreakGet", "lossStreak"),
        numberBlock("aiGateLossStreakLimit", request.stopAfterLossStreak),
      ),
    );
  if (request.stopAfterWinStreak)
    conditions.push(
      compareValues(
        "aiGateWinStreak",
        "LT",
        variablesGet("aiGateWinStreakGet", "winStreak"),
        numberBlock("aiGateWinStreakLimit", request.stopAfterWinStreak),
      ),
    );
  return `<block type="procedures_defreturn" id="aiRiskDefinition" x="24" y="700"><mutation></mutation><field name="NAME">${escapeXml(request.procedureName)}</field><comment pinned="false" h="72" w="260">Custom AI safety block: permits entries only while the session P/L and trade cap remain inside the configured limits.</comment><value name="RETURN">${andAll("aiGate", conditions)}</value></block>`;
}

function tradeRoot(
  request: DbotAiStrategyRequest,
  duration: number,
  durationUnit: DbotAiDurationUnit,
  stake: number,
  currency: string,
): string {
  const contractFamily = request.family === "rise-fall" ? "callput" : "digits";
  const tradeType =
    request.family === "rise-fall"
      ? "risefall"
      : request.family === "over-under"
        ? "overunder"
        : request.family === "even-odd"
          ? "evenodd"
          : "matchesdiffers";
  const prediction =
    request.family === "over-under"
      ? clamp(Math.round(numberOr(request.barrier, 5)), 1, 8)
      : request.family === "matches" || request.family === "differs"
        ? clamp(Math.round(numberOr(request.targetDigit, 5)), 0, 9)
        : null;
  const hasPrediction = prediction !== null;
  const optionPrediction = hasPrediction
    ? `<value name="PREDICTION">${numberBlock("aiPrediction", prediction)}</value>`
    : "";
  const durationValue =
    durationUnit === "m"
      ? clamp(Math.round(duration), 1, 15)
      : clamp(Math.round(duration), 1, 10);
  // A stake progression reads the amount from the "ai stake" variable, which
  // Purchase conditions initialise and After purchase updates after each
  // result. A flat strategy keeps the plain stake number.
  const amount =
    request.stakingPlan && request.stakingPlan !== "flat"
      ? variablesGet("aiStakeAmount", "stake")
      : numberBlock("aiStake", stake);
  const tradeOptions = `<block type="trade_definition_tradeoptions" id="aiTradeOptions"><mutation has_first_barrier="false" has_second_barrier="false" has_prediction="${hasPrediction ? "true" : "false"}"></mutation><field name="DURATIONTYPE_LIST">${durationUnit}</field><field name="CURRENCY_LIST">${escapeXml(currency)}</field><value name="DURATION">${numberBlock("aiDuration", durationValue)}</value><value name="AMOUNT">${amount}</value>${optionPrediction}</block>`;
  const market = `<block type="trade_definition_market" id="aiMarket"><field name="MARKET_LIST">volidx</field><field name="SUBMARKET_LIST">random_index</field><field name="SYMBOL_LIST">${escapeXml(cleanSymbol(request.symbol))}</field><next><block type="trade_definition_tradetype" id="aiTradeType"><field name="TRADETYPECAT_LIST">${contractFamily}</field><field name="TRADETYPE_LIST">${tradeType}</field><next><block type="trade_definition_contracttype" id="aiContractType"><field name="TYPE_LIST">both</field><next><block type="trade_definition_candleinterval" id="aiCandleInterval"><field name="CANDLEINTERVAL_LIST">60</field><next><block type="trade_definition_restartbuysell" id="aiRestartBuySell"><field name="TIME_MACHINE_ENABLED">FALSE</field><next><block type="trade_definition_restartonerror" id="aiRestartOnError"><field name="RESTARTONERROR">TRUE</field></block></next></block></next></block></next></block></next></block></next></block>`;
  return `<block type="trade_definition" id="aiTradeDefinition" x="24" y="24"><statement name="TRADE_OPTIONS">${market}</statement><statement name="SUBMARKET">${tradeOptions}</statement></block>`;
}

function selectedPurchase(request: DbotAiStrategyRequest): string {
  if (request.family === "rise-fall")
    return request.direction === "FALL" ? "PUT" : "CALL";
  if (request.family === "over-under")
    return request.digitSide === "DIGITUNDER" ? "DIGITUNDER" : "DIGITOVER";
  if (request.family === "even-odd")
    return request.paritySide === "DIGITODD" ? "DIGITODD" : "DIGITEVEN";
  if (request.family === "differs") return "DIGITDIFF";
  return "DIGITMATCH";
}

/** The opposite contract, for a two-legged hedge. Null when there is none. */
function hedgePurchase(request: DbotAiStrategyRequest): string | null {
  if (request.family === "rise-fall")
    return request.direction === "FALL" ? "CALL" : "PUT";
  if (request.family === "over-under")
    return request.digitSide === "DIGITUNDER" ? "DIGITOVER" : "DIGITUNDER";
  if (request.family === "even-odd")
    return request.paritySide === "DIGITODD" ? "DIGITEVEN" : "DIGITODD";
  return null;
}

/** The bot market's own last digit, as an entry-filter condition. */
function digitFilterCondition(filter: DbotAiDigitFilter): string {
  const lastDigit = `<block type="last_digit" id="aiEntryLastDigit"></block>`;
  if (filter.kind === "equals")
    return compareValues("aiEntryDigitEq", "EQ", lastDigit, numberBlock("aiEntryDigitEqValue", filter.digit));
  if (filter.kind === "over")
    return compareValues("aiEntryDigitOver", "GT", lastDigit, numberBlock("aiEntryDigitOverValue", filter.digit));
  if (filter.kind === "under")
    return compareValues("aiEntryDigitUnder", "LT", lastDigit, numberBlock("aiEntryDigitUnderValue", filter.digit));
  const remainder = `<block type="math_modulo" id="aiEntryDigitParity"><value name="DIVIDEND">${lastDigit}</value><value name="DIVISOR">${numberBlock("aiEntryDigitParityTwo", 2)}</value></block>`;
  return compareValues(
    "aiEntryDigitParityEq",
    "EQ",
    remainder,
    numberBlock("aiEntryDigitParityValue", filter.parity === "even" ? 0 : 1),
  );
}

function analysisGate(request: DbotAiStrategyRequest): string {
  const barrier =
    request.family === "over-under"
      ? clamp(Math.round(numberOr(request.barrier, 5)), 1, 8)
      : 0;
  const targetDigit =
    request.family === "matches"
      ? clamp(Math.round(numberOr(request.targetDigit, 5)), 0, 9)
      : 0;
  return `<block type="signal_lab_analysis_gate" id="aiAnalysisGate"><field name="FAMILY">${request.family}</field><field name="SYMBOL">${escapeXml(cleanSymbol(request.symbol))}</field><field name="CONTRACT_TYPE">${selectedPurchase(request)}</field><field name="BARRIER">${barrier}</field><field name="TARGET_DIGIT">${targetDigit}</field><field name="ANALYSIS_ID">${escapeXml((request.analysisId ?? "").slice(0, 180))}</field></block>`;
}

/** Rough net-profit multiple a virtual (paper) position books on a win. */
function virtualPayout(request: DbotAiStrategyRequest): number {
  if (request.family === "matches") return 8;
  if (request.family === "differs") return 0.1;
  if (request.family === "over-under") {
    const barrier = clamp(Math.round(numberOr(request.barrier, 5)), 1, 8);
    const winDigits = request.digitSide === "DIGITUNDER" ? barrier : 9 - barrier;
    return Math.max(0.05, Math.round(((10 - winDigits) / Math.max(1, winDigits)) * 100) / 100);
  }
  return 0.95;
}

function virtualDirection(request: DbotAiStrategyRequest): string {
  if (request.family === "rise-fall") return request.direction === "FALL" ? "fall" : "rise";
  if (request.family === "over-under") return request.digitSide === "DIGITUNDER" ? "under" : "over";
  if (request.family === "even-odd") return request.paritySide === "DIGITODD" ? "odd" : "even";
  return "match";
}

function beforePurchase(
  request: DbotAiStrategyRequest,
  procedureName: string,
  baseStake: number,
): string {
  const purchaseType = selectedPurchase(request);
  const riskGate = `<block type="procedures_callreturn" id="aiEntryGateCall"><mutation name="${escapeXml(procedureName)}"></mutation></block>`;
  const conditions = [riskGate];
  // Only strategies built from an analysis have a snapshot to validate. A
  // prompt-built strategy must not contain a gate with an impossible empty key.
  if (request.analysisId) conditions.push(analysisGate(request));
  if (request.digitFilter) conditions.push(digitFilterCondition(request.digitFilter));
  if (request.scanMarkets)
    conditions.push(`<block type="signal_lab_scan_tradeable" id="aiScanTradeable"></block>`);
  const condition = andAll("aiEntry", conditions);

  const purchase = `<block type="purchase" id="aiPurchase"><field name="PURCHASE_LIST">${purchaseType}</field></block>`;
  const hedgeType = request.hedge ? hedgePurchase(request) : null;
  const hedgeBlock = hedgeType
    ? `<block type="purchase" id="aiHedgePurchase"><field name="PURCHASE_LIST">${hedgeType}</field></block>`
    : null;
  const barrierOrDigit =
    request.family === "over-under"
      ? clamp(Math.round(numberOr(request.barrier, 5)), 1, 8)
      : clamp(Math.round(numberOr(request.targetDigit, 5)), 0, 9);
  const virtualBuy = `<block type="signal_lab_virtual_buy" id="aiVirtualBuy"><field name="DIRECTION">${virtualDirection(request)}</field><field name="MARKET_LIST">${escapeXml(cleanSymbol(request.symbol))}</field><value name="STAKE">${numberBlock("aiVirtualStake", baseStake)}</value><value name="PAYOUT">${numberBlock("aiVirtualPayout", virtualPayout(request))}</value><value name="BARRIER">${numberBlock("aiVirtualBarrier", barrierOrDigit)}</value></block>`;
  const entryAction = request.virtual
    ? virtualBuy
    : hedgeBlock
      ? chainStatements([purchase, hedgeBlock])
      : purchase;
  const entryIf = `<block type="controls_if" id="aiEntryGate"><value name="IF0">${condition}</value><statement name="DO0">${entryAction}</statement></block>`;

  const prelude: string[] = [];
  if (request.stakingPlan && request.stakingPlan !== "flat")
    prelude.push(initVariableIfNull("aiInitStake", "stake", baseStake));
  if (request.stopAfterLossStreak)
    prelude.push(initVariableIfNull("aiInitLossStreak", "lossStreak", 0));
  if (request.stopAfterWinStreak)
    prelude.push(initVariableIfNull("aiInitWinStreak", "winStreak", 0));
  if (request.scanMarkets) {
    const scanFamily = request.family === "differs" ? "matches" : request.family;
    prelude.push(
      `<block type="signal_lab_scan_markets" id="aiScanMarkets"><field name="FAMILY">${scanFamily}</field><value name="DURATION">${numberBlock("aiScanDuration", 20)}</value><value name="MIN_SCORE">${numberBlock("aiScanMinScore", clamp(numberOr(request.scanMinScore, 0.05), 0, 1))}</value></block>`,
      `<block type="controls_if" id="aiScanSwitch"><value name="IF0"><block type="signal_lab_scan_tradeable" id="aiScanSwitchCheck"></block></value><statement name="DO0"><block type="signal_lab_switch_to_best" id="aiScanSwitchToBest"></block></statement></block>`,
    );
  }
  if (request.virtual)
    prelude.push(`<block type="signal_lab_virtual_settle" id="aiVirtualSettle"></block>`);

  const stack = chainStatements([...prelude, entryIf]);
  return `<block type="before_purchase" id="aiBeforePurchase" x="24" y="300"><statement name="BEFOREPURCHASE_STACK">${stack}</statement></block>`;
}

/** After-purchase stake progression + streak bookkeeping for one result. */
function progressionStatements(request: DbotAiStrategyRequest, baseStake: number): string[] {
  const statements: string[] = [];
  const won = `<block type="contract_check_result" id="aiResultWin"><field name="CHECK_RESULT">win</field></block>`;
  const plan = request.stakingPlan ?? "flat";
  if (plan === "martingale" || plan === "reverse-martingale") {
    const multiplier = clamp(numberOr(request.stakeMultiplier, 2), 1.1, 10);
    const grow = variablesSet(
      "aiStakeGrow",
      "stake",
      arithmetic("aiStakeGrowCalc", "MULTIPLY", variablesGet("aiStakeGrowGet", "stake"), numberValue("aiStakeGrowFactor", multiplier)),
    );
    const reset = variablesSet("aiStakeReset", "stake", numberValue("aiStakeResetValue", baseStake));
    statements.push(
      `<block type="controls_if" id="aiStakeProgression"><mutation else="1"></mutation><value name="IF0">${won}</value><statement name="DO0">${plan === "martingale" ? reset : grow}</statement><statement name="ELSE">${plan === "martingale" ? grow : reset}</statement></block>`,
    );
  } else if (plan === "dalembert") {
    const step = clamp(numberOr(request.stakeStep, baseStake), 0.01, 10_000);
    const up = variablesSet(
      "aiStakeUp",
      "stake",
      arithmetic("aiStakeUpCalc", "ADD", variablesGet("aiStakeUpGet", "stake"), numberValue("aiStakeUpStep", step)),
    );
    const down = variablesSet(
      "aiStakeDown",
      "stake",
      arithmetic("aiStakeDownCalc", "MINUS", variablesGet("aiStakeDownGet", "stake"), numberValue("aiStakeDownStep", step)),
    );
    statements.push(
      `<block type="controls_if" id="aiStakeProgression"><mutation else="1"></mutation><value name="IF0">${won}</value><statement name="DO0">${down}</statement><statement name="ELSE">${up}</statement></block>`,
      // Never let a D'Alembert step take the stake below the base stake.
      `<block type="controls_if" id="aiStakeFloor"><value name="IF0">${compareValues("aiStakeFloorCheck", "LT", variablesGet("aiStakeFloorGet", "stake"), numberValue("aiStakeFloorValue", baseStake))}</value><statement name="DO0">${variablesSet("aiStakeFloorSet", "stake", numberValue("aiStakeFloorBase", baseStake))}</statement></block>`,
    );
  }
  if (plan !== "flat" && request.maxStake) {
    const ceiling = clamp(request.maxStake, baseStake, 50_000);
    statements.push(
      `<block type="controls_if" id="aiStakeCap"><value name="IF0">${compareValues("aiStakeCapCheck", "GT", variablesGet("aiStakeCapGet", "stake"), numberValue("aiStakeCapValue", ceiling))}</value><statement name="DO0">${variablesSet("aiStakeCapSet", "stake", numberValue("aiStakeCapBase", ceiling))}</statement></block>`,
    );
  }
  if (request.stopAfterLossStreak || request.stopAfterWinStreak) {
    const onWin: string[] = [];
    const onLoss: string[] = [];
    if (request.stopAfterWinStreak) {
      onWin.push(
        variablesSet("aiWinStreakUp", "winStreak", arithmetic("aiWinStreakUpCalc", "ADD", variablesGet("aiWinStreakUpGet", "winStreak"), numberValue("aiWinStreakUpOne", 1))),
      );
      onLoss.push(variablesSet("aiWinStreakReset", "winStreak", numberValue("aiWinStreakResetZero", 0)));
    }
    if (request.stopAfterLossStreak) {
      onLoss.push(
        variablesSet("aiLossStreakUp", "lossStreak", arithmetic("aiLossStreakUpCalc", "ADD", variablesGet("aiLossStreakUpGet", "lossStreak"), numberValue("aiLossStreakUpOne", 1))),
      );
      onWin.push(variablesSet("aiLossStreakReset", "lossStreak", numberValue("aiLossStreakResetZero", 0)));
    }
    statements.push(
      `<block type="controls_if" id="aiStreakUpdate"><mutation else="1"></mutation><value name="IF0">${won}</value><statement name="DO0">${chainStatements(onWin)}</statement><statement name="ELSE">${chainStatements(onLoss)}</statement></block>`,
    );
  }
  return statements;
}

function afterPurchase(request: DbotAiStrategyRequest, baseStake: number, cooldownSeconds: number): string {
  const again = `<block type="timeout" id="aiCooldown"><statement name="TIMEOUTSTACK"><block type="trade_again" id="aiTradeAgain"></block></statement><value name="SECONDS">${numberBlock("aiCooldownSeconds", cooldownSeconds)}</value></block>`;
  const stack = request.virtual
    ? again
    : chainStatements([...progressionStatements(request, baseStake), again]);
  return `<block type="after_purchase" id="aiAfterPurchase" x="700" y="300"><statement name="AFTERPURCHASE_STACK">${stack}</statement></block>`;
}

/**
 * Generates a real DBot Blockly workspace using the registered Deriv blocks.
 * The reusable risk gate is a Blockly procedure definition, so it appears as a
 * custom block in the strategy and is called by the entry conditions.
 */
export function buildDbotAiStrategyXml(input: DbotAiStrategyRequest): string {
  const family = input.family;
  const durationUnit: DbotAiDurationUnit =
    family === "rise-fall" && input.durationUnit === "m" ? "m" : "t";
  const duration =
    durationUnit === "m"
      ? clamp(Math.round(numberOr(input.duration, 1)), 1, 15)
      : clamp(Math.round(numberOr(input.duration, 1)), 1, 10);
  const stake = clamp(numberOr(input.stake, 0.35), 0.35, 10);
  const currency = cleanCurrency(input.currency);
  const procedureName = cleanProcedureName(input.procedureName);
  const maxTrades = clamp(Math.round(numberOr(input.maxTrades, 25)), 1, 500);
  const lossLimit = clamp(numberOr(input.lossLimit, 3), 0.35, 10_000);
  const profitTarget = clamp(numberOr(input.profitTarget, 5), 0.35, 10_000);
  const cooldownSeconds = clamp(numberOr(input.cooldownSeconds, 2), 0, 300);
  const resolved = {
    procedureName,
    maxTrades,
    lossLimit,
    profitTarget,
    stopAfterLossStreak: input.stopAfterLossStreak
      ? clamp(Math.round(input.stopAfterLossStreak), 1, 100)
      : undefined,
    stopAfterWinStreak: input.stopAfterWinStreak
      ? clamp(Math.round(input.stopAfterWinStreak), 1, 100)
      : undefined,
  };
  const normalized: DbotAiStrategyRequest = {
    ...input,
    stopAfterLossStreak: resolved.stopAfterLossStreak,
    stopAfterWinStreak: resolved.stopAfterWinStreak,
  };
  const variableKeys: AiVariableKey[] = [];
  if (input.stakingPlan && input.stakingPlan !== "flat") variableKeys.push("stake");
  if (resolved.stopAfterLossStreak) variableKeys.push("lossStreak");
  if (resolved.stopAfterWinStreak) variableKeys.push("winStreak");
  return `<?xml version="1.0" encoding="UTF-8"?><xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">${variablesSection(variableKeys)}${tradeRoot(normalized, duration, durationUnit, stake, currency)}${riskGateDefinition(resolved)}${beforePurchase(normalized, procedureName, stake)}${afterPurchase(normalized, stake, cooldownSeconds)}</xml>`;
}

/** Best-effort family recognition for the local prompt builder. */
export function inferDbotAiFamily(description: string): DbotAiFamily | null {
  const prompt = description.toLowerCase();
  if (/\b(even|odd|parity)\b/.test(prompt)) return "even-odd";
  // Differs is a real DBot contract (DIGITDIFF on the matches/differs trade
  // type), so the builder supports it. It stays out of the AI *analysis*
  // families, which only measure Matches.
  if (/\b(differs?|digit differs?|not matches?|does ?n['’]?t match)\b/.test(prompt))
    return "differs";
  if (/\b(matches?|digit match|match digit)\b/.test(prompt)) return "matches";
  if (/\b(over|under|barrier)\b/.test(prompt)) return "over-under";
  if (/\b(rise|fall|call|put|bullish|bearish|upward|downward|go long|go short)\b/.test(prompt))
    return "rise-fall";
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

/** "stake of two dollars" reads as naturally as "stake 2". */
function wordsToNumbers(text: string): string {
  return text.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b/gi,
    (word) => String(NUMBER_WORDS[word.toLowerCase()] ?? word),
  );
}

function readStakingPlan(description: string): {
  stakingPlan: DbotAiStakingPlan;
  stakeMultiplier?: number;
  stakeStep?: number;
  maxStake?: number;
} {
  const prompt = description.toLowerCase();
  const multiplierMatch = prompt.match(
    /(?:multiply(?:\s+the\s+stake)?\s+by|multiplier\s*(?:of|x|×)?|\bx|×|\btimes)\s*(\d+(?:\.\d+)?)/,
  );
  const stakeMultiplier = multiplierMatch
    ? clamp(Number(multiplierMatch[1]), 1.1, 10)
    : undefined;
  const maxStakeMatch = prompt.match(
    /\bmax(?:imum)?\s+stake\s*(?:of|is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/,
  );
  const maxStake = maxStakeMatch ? clamp(Number(maxStakeMatch[1]), 0.35, 50_000) : undefined;
  if (/\b(reverse|anti)[-\s]?martingale\b/.test(prompt) || /\b(double|increase|multiply)[^.]*\bafter\s+(?:a\s+)?win/.test(prompt))
    return { stakingPlan: "reverse-martingale", stakeMultiplier: stakeMultiplier ?? 2, maxStake };
  if (/\bd['’]?alembert\b/.test(prompt)) {
    const stepMatch = prompt.match(/(?:step|unit|by)\s*(?:of\s*)?\$?\s*(\d+(?:\.\d+)?)/);
    return { stakingPlan: "dalembert", stakeStep: stepMatch ? clamp(Number(stepMatch[1]), 0.01, 10_000) : undefined, maxStake };
  }
  if (
    /\bmartingale\b/.test(prompt) ||
    /\b(double|multiply|increase)\b[^.]*\bafter\s+(?:a\s+)?loss/.test(prompt) ||
    /\brecover(?:y|ing)?\b[^.]*\bloss/.test(prompt)
  )
    return { stakingPlan: "martingale", stakeMultiplier: stakeMultiplier ?? 2, maxStake };
  const stepMatch = prompt.match(/\bincrease\s+(?:the\s+)?stake\s+by\s+\$?\s*(\d+(?:\.\d+)?)[^.]*\bafter\s+(?:a\s+)?loss/);
  if (stepMatch)
    return { stakingPlan: "dalembert", stakeStep: clamp(Number(stepMatch[1]), 0.01, 10_000), maxStake };
  return { stakingPlan: "flat", maxStake };
}

function readStreakStops(description: string): {
  stopAfterLossStreak?: number;
  stopAfterWinStreak?: number;
} {
  const prompt = description.toLowerCase();
  const loss = prompt.match(
    /\bstop[^.]*?\bafter\s+(\d+)\s*(?:consecutive\s+|straight\s+)?(?:losses|losing(?:\s+trades)?|losses\s+in\s+a\s+row)\b/,
  ) ?? prompt.match(/\b(\d+)\s*(?:consecutive\s+)?losses\s+in\s+a\s+row/);
  const win = prompt.match(
    /\bstop[^.]*?\bafter\s+(\d+)\s*(?:consecutive\s+|straight\s+)?(?:wins|winning(?:\s+trades)?|wins\s+in\s+a\s+row)\b/,
  ) ?? prompt.match(/\b(\d+)\s*(?:consecutive\s+)?wins\s+in\s+a\s+row/);
  return {
    stopAfterLossStreak: loss ? clamp(Number(loss[1]), 1, 100) : undefined,
    stopAfterWinStreak: win ? clamp(Number(win[1]), 1, 100) : undefined,
  };
}

function readCooldown(description: string): number | undefined {
  const match = description.match(
    /\b(?:wait|pause|cooldown|delay|gap|rest)(?:\s+of)?\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?|s)\b/i,
  ) ?? description.match(/\b(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?)\s*(?:between|after each|cooldown|pause|wait)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return clamp(/min/i.test(match[2]) ? value * 60 : value, 0, 300);
}

function readDigitFilter(description: string): DbotAiDigitFilter | undefined {
  const prompt = description.toLowerCase();
  const equals = prompt.match(
    /\b(?:only\s+)?(?:buy|trade|enter|purchase)\b[^.]*?\b(?:when|if|after)\b[^.]*?\bdigit\s*(?:is|=|equals?)?\s*(\d)\b/,
  ) ?? prompt.match(/\bafter\s+(?:a\s+)?digit\s+(\d)\b/) ?? prompt.match(/\blast\s+digit\s+(?:is|=)\s*(\d)\b/);
  if (equals) return { kind: "equals", digit: clamp(Number(equals[1]), 0, 9) };
  const over = prompt.match(/\blast\s+digit\s+(?:is\s+)?(?:over|above|greater than|>)\s*(\d)\b/);
  if (over) return { kind: "over", digit: clamp(Number(over[1]), 0, 9) };
  const under = prompt.match(/\blast\s+digit\s+(?:is\s+)?(?:under|below|less than|<)\s*(\d)\b/);
  if (under) return { kind: "under", digit: clamp(Number(under[1]), 0, 9) };
  if (/\b(?:only\s+)?(?:buy|trade|enter)\b[^.]*?\b(?:when|if|after)\b[^.]*?\bdigit\s+is\s+even\b/.test(prompt) || /\bafter\s+an?\s+even\s+digit\b/.test(prompt))
    return { kind: "parity", parity: "even" };
  if (/\b(?:only\s+)?(?:buy|trade|enter)\b[^.]*?\b(?:when|if|after)\b[^.]*?\bdigit\s+is\s+odd\b/.test(prompt) || /\bafter\s+an?\s+odd\s+digit\b/.test(prompt))
    return { kind: "parity", parity: "odd" };
  return undefined;
}

/** Concepts real users ask for that this mapper cannot build yet — named, never faked. */
function readWarnings(description: string): string[] {
  const prompt = description.toLowerCase();
  const warnings: string[] = [];
  if (/\b(rsi|macd|bollinger|ema|sma|stochastic|moving average|indicator)\b/.test(prompt))
    warnings.push(
      "Indicator conditions (RSI/MACD/Bollinger/EMA) were not generated — this builder does not wire indicator blocks yet. After loading, add an Indicators block from the DBot toolbox into Purchase conditions; everything else you described is built.",
    );
  if (/\b(candle|candlestick|engulfing|doji|hammer|pin bar)\b/.test(prompt))
    warnings.push(
      "Candle-pattern entries were not generated. The strategy uses the contract and conditions described; candle blocks (OHLC) can be added from the toolbox after loading.",
    );
  if (/\b(accumulator|multiplier contract|multipliers|vanilla|barrier option|turbo)\b/.test(prompt))
    warnings.push(
      "Only Rise/Fall and digit contracts are generated here — accumulators, multipliers and vanillas are not part of this builder.",
    );
  if (/\b(crash|boom|step index|jump index|forex|gold|crypto|bitcoin|eth|stock)\b/.test(prompt))
    warnings.push(
      "That market is outside the volatility indices this workspace shares with Signal Lab, so the strategy was built on the closest volatility market instead. Change the market block in DBot if you need another asset.",
    );
  if (/\b(sell (?:at|when|if)|early sell|close early|cash out)\b/.test(prompt))
    warnings.push(
      "Early-sell logic was not generated; digit and rise/fall contracts here run to expiry. A Sell conditions block can be added in DBot for contracts that support selling.",
    );
  if (/\b(every (hour|morning|day)|at \d{1,2}(:\d{2})?\s*(am|pm)|schedule|time of day)\b/.test(prompt))
    warnings.push(
      "Clock-based scheduling was not generated; the bot trades whenever it is running and its conditions pass.",
    );
  return warnings;
}

function familyFromSignalName(description: string): DbotAiFamily | null {
  return inferDbotAiFamily(description);
}

function readStake(description: string): number {
  const amount =
    description.match(
      /(?:stake|amount|base stake|bet)\s*(?:of|is|to|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
    ) ?? description.match(/\$\s*(\d+(?:\.\d+)?)/);
  return amount ? clamp(Number(amount[1]), 0.35, 10) : 0.35;
}

function readRiskSetting(description: string, kind: "loss" | "profit"): number {
  const match =
    kind === "loss"
      ? description.match(
          /\b(?:loss limit|max(?:imum)? loss|stop[- ]loss)\s*(?:of|at|to|is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
        )
      : description.match(
          /\b(?:profit target|take[- ]profit|target profit)\s*(?:of|at|to|is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
        );
  return match
    ? clamp(Number(match[1]), 0.35, 10_000)
    : kind === "loss"
      ? 5
      : 5;
}

function readMaxTrades(description: string): number {
  const match =
    description.match(
      /\b(?:max(?:imum)?\s*(?:trades|runs)|(?:trades|runs)\s*(?:limit|max))\s*(?:of|is|=|:)?\s*(\d+)\b/i,
    ) ?? description.match(/\bmax(?:imum)?\s+(\d+)\s+(?:trades|runs)\b/i);
  return match ? clamp(Number(match[1]), 1, 500) : 25;
}

function readDuration(
  description: string,
  family: DbotAiFamily,
): { duration: number; durationUnit: DbotAiDurationUnit } {
  const minutes =
    family === "rise-fall"
      ? description.match(/\b(\d+)\s*(?:minutes?|mins?)\b/i)
      : null;
  if (minutes)
    return { duration: clamp(Number(minutes[1]), 1, 15), durationUnit: "m" };
  const ticks = description.match(/\b(\d+)\s*(?:ticks?|t)\b/i);
  return {
    duration: ticks ? clamp(Number(ticks[1]), 1, 10) : 1,
    durationUnit: "t",
  };
}

function readMarket(description: string, fallback: string): string {
  const market = description.match(/\b(?:R_\d{1,3}|1HZ\d{1,3}V)\b/i)?.[0];
  if (market) return cleanSymbol(market);
  // "Volatility 100 (1s)", "vol 75 1s", "V100", "R 50" all name real markets.
  const friendly = description.match(
    /\b(?:volatility|vol|v|r)[\s_-]?(\d{2,3})\b(?:\s*\(?\s*(1s|one second)\s*\)?)?/i,
  );
  if (friendly) {
    const level = friendly[1];
    const oneSecond = Boolean(friendly[2]) || /\b1s\b/i.test(description);
    return cleanSymbol(oneSecond ? `1HZ${level}V` : `R_${level}`);
  }
  return cleanSymbol(fallback);
}

function readProcedureName(description: string): string {
  const named = description.match(
    /\b(?:block|function)\s+(?:called|named)\s+["“']([^"”']{2,44})["”']/i,
  )?.[1];
  return cleanProcedureName(named);
}

/** Turns a natural-language request into a bounded, reviewable block strategy. */
export function parseDbotAiDescription(
  rawDescription: string,
  fallbackMarket = "R_100",
  fallbackCurrency = "USD",
): ParsedBotDescription | null {
  const description = wordsToNumbers(rawDescription);
  const family = familyFromSignalName(description);
  if (!family) return null;
  const duration = readDuration(description, family);
  const prompt = description.toLowerCase();
  const procedureName = readProcedureName(description);
  const hedge =
    /\bhedge\b/.test(prompt) ||
    /\bbuy\s+both\b/.test(prompt) ||
    /\bboth\s+(?:sides|directions|rise\s+and\s+fall|over\s+and\s+under)\b/.test(prompt);
  const shared = {
    family,
    symbol: readMarket(description, fallbackMarket),
    currency: cleanCurrency(
      description.match(/\bcurrency\s*(?:is|of|=|:)?\s*([A-Z]{3,5})\b/i)?.[1] ??
        fallbackCurrency,
    ),
    ...duration,
    stake: readStake(description),
    maxTrades: readMaxTrades(description),
    lossLimit: readRiskSetting(description, "loss"),
    profitTarget: readRiskSetting(description, "profit"),
    procedureName,
    cooldownSeconds: readCooldown(description),
    ...readStakingPlan(description),
    ...readStreakStops(description),
    digitFilter: readDigitFilter(description),
    scanMarkets:
      /\bscan\s+(?:all|every)\s+markets?\b/.test(prompt) ||
      /\ball[- ]markets?\s+scan\b/.test(prompt) ||
      /\b(?:trade|find|pick|choose)\s+the\s+best\s+market\b/.test(prompt) ||
      /\bbest\s+market\b[^.]*\bscan\b/.test(prompt),
    hedge: hedge || undefined,
    virtual: /\b(virtual|paper\s+trad\w*)\b/.test(prompt) || undefined,
    usedVisionAi: /\bvision\b/.test(prompt) && family === "over-under",
    warnings: readWarnings(description),
  };
  if (family === "rise-fall") {
    return {
      ...shared,
      direction: /\b(fall|put|bearish|downward|go short)\b/.test(prompt)
        ? "FALL"
        : "RISE",
    };
  }
  if (family === "over-under") {
    const barrier = clamp(
      Number(
        description.match(
          /\b(?:barrier|over|under)\s*(?:of|=|:)?\s*(\d)\b/i,
        )?.[1] ?? 5,
      ),
      1,
      8,
    );
    return {
      ...shared,
      digitSide:
        /\bunder\b/i.test(prompt) && !/\bover\b/i.test(prompt)
          ? "DIGITUNDER"
          : "DIGITOVER",
      barrier,
    };
  }
  if (family === "even-odd")
    return {
      ...shared,
      paritySide:
        /\bodd\b/i.test(prompt) && !/\beven\b/i.test(prompt)
          ? "DIGITODD"
          : "DIGITEVEN",
    };
  const targetDigit = Number(
    description.match(
      /\b(?:target|digit|match(?:es)?(?:\s+digit)?|differs?(?:\s+(?:from|digit))?)\s*(?:of|is|=|:|to|on|from)?\s*(\d)\b/i,
    )?.[1] ?? 5,
  );
  return { ...shared, targetDigit: clamp(targetDigit, 0, 9) };
}

/**
 * Apply a follow-up edit ("change the stake to 1", "make it martingale x2.2",
 * "switch to R_50", "add a stop after 3 losses") to the strategy already on
 * screen. Only the settings the follow-up actually mentions are changed;
 * everything else carries over, so iterating on a bot is a conversation.
 */
export function applyDbotAiEdit(
  previous: ParsedBotDescription,
  rawEdit: string,
): ParsedBotDescription | null {
  const edit = wordsToNumbers(rawEdit);
  const prompt = edit.toLowerCase();
  if (!/\b(change|make|switch|set|add|remove|update|instead|use|turn|also|now)\b/.test(prompt))
    return null;
  const next: ParsedBotDescription = { ...previous, warnings: [...readWarnings(edit)] };
  let touched = false;
  const family = familyFromSignalName(edit);
  if (family && family !== previous.family) {
    const reparsed = parseDbotAiDescription(edit, previous.symbol, previous.currency);
    if (reparsed) return { ...previous, ...reparsed, procedureName: previous.procedureName };
  }
  if (/\b(?:R_\d{1,3}|1HZ\d{1,3}V|volatility|vol\s*\d|v\d{2,3}\b)/i.test(edit)) {
    next.symbol = readMarket(edit, previous.symbol);
    touched = true;
  }
  if (/\bstake\b|\$\s*\d/.test(prompt)) {
    next.stake = readStake(edit);
    touched = true;
  }
  if (/\b(martingale|alembert|flat staking|fixed stake|double|multiply|increase\s+(?:the\s+)?stake)\b/.test(prompt)) {
    if (/\b(flat|fixed|no martingale|remove)/.test(prompt) && !/\bmartingale\b/.test(prompt.replace("no martingale", ""))) {
      next.stakingPlan = "flat";
      next.stakeMultiplier = undefined;
      next.stakeStep = undefined;
    } else {
      Object.assign(next, readStakingPlan(edit));
    }
    touched = true;
  }
  if (/\bstop\b[^.]*\b(loss|win)/.test(prompt) || /\bin a row\b/.test(prompt)) {
    Object.assign(next, readStreakStops(edit));
    touched = true;
  }
  if (/\b(stop[- ]?loss|loss limit)\b/.test(prompt)) {
    next.lossLimit = readRiskSetting(edit, "loss");
    touched = true;
  }
  if (/\b(take[- ]?profit|profit target)\b/.test(prompt)) {
    next.profitTarget = readRiskSetting(edit, "profit");
    touched = true;
  }
  if (/\b(max|trades|runs)\b/.test(prompt)) {
    next.maxTrades = readMaxTrades(edit);
    touched = true;
  }
  if (/\b(wait|pause|cooldown|delay|gap|rest)\b/.test(prompt)) {
    next.cooldownSeconds = readCooldown(edit) ?? next.cooldownSeconds;
    touched = true;
  }
  if (/\b(duration|ticks?|minutes?)\b/.test(prompt)) {
    Object.assign(next, readDuration(edit, next.family));
    touched = true;
  }
  if (/\bscan\b/.test(prompt)) {
    next.scanMarkets = !/\b(no|stop|remove|without)\b[^.]*\bscan\b/.test(prompt);
    touched = true;
  }
  if (/\bhedge\b/.test(prompt)) {
    next.hedge = !/\b(no|remove|without)\b[^.]*\bhedge\b/.test(prompt);
    touched = true;
  }
  if (/\b(virtual|paper|real purchases?|live trading)\b/.test(prompt)) {
    next.virtual = /\b(virtual|paper)\b/.test(prompt);
    touched = true;
  }
  if (/\blast digit\b|\bdigit is\b|\bafter (?:a )?digit\b/.test(prompt)) {
    next.digitFilter = readDigitFilter(edit);
    touched = true;
  }
  if (next.family === "rise-fall" && /\b(rise|fall|call|put)\b/.test(prompt)) {
    next.direction = /\b(fall|put)\b/.test(prompt) ? "FALL" : "RISE";
    touched = true;
  }
  if (next.family === "over-under" && /\b(over|under|barrier)\b/.test(prompt)) {
    const barrier = edit.match(/\b(?:barrier|over|under)\s*(?:of|=|:)?\s*(\d)\b/i)?.[1];
    if (barrier) next.barrier = clamp(Number(barrier), 1, 8);
    next.digitSide = /\bunder\b/.test(prompt) ? "DIGITUNDER" : /\bover\b/.test(prompt) ? "DIGITOVER" : next.digitSide;
    touched = true;
  }
  if (next.family === "even-odd" && /\b(even|odd)\b/.test(prompt)) {
    next.paritySide = /\bodd\b/.test(prompt) ? "DIGITODD" : "DIGITEVEN";
    touched = true;
  }
  if ((next.family === "matches" || next.family === "differs") && /\bdigit\s*(\d)\b/.test(prompt)) {
    next.targetDigit = clamp(Number(prompt.match(/\bdigit\s*(\d)\b/)?.[1] ?? next.targetDigit ?? 5), 0, 9);
    touched = true;
  }
  return touched ? next : null;
}

/** One-line, plain-language summary of everything a request will build. */
export function describeDbotAiStrategy(request: DbotAiStrategyRequest): string {
  const parts: string[] = [`${dbotAiFamilyLabel(request.family)} on ${request.symbol}`];
  if (request.family === "rise-fall") parts.push(request.direction === "FALL" ? "Fall" : "Rise");
  if (request.family === "over-under")
    parts.push(`${request.digitSide === "DIGITUNDER" ? "Under" : "Over"} ${request.barrier ?? 5}`);
  if (request.family === "even-odd") parts.push(request.paritySide === "DIGITODD" ? "Odd" : "Even");
  if (request.family === "matches") parts.push(`Matches ${request.targetDigit ?? 5}`);
  if (request.family === "differs") parts.push(`Differs from ${request.targetDigit ?? 5}`);
  parts.push(`stake ${request.stake ?? 0.35} ${request.currency ?? "USD"}`);
  parts.push(`${request.duration}${request.durationUnit === "m" ? "m" : "t"}`);
  if (request.stakingPlan === "martingale")
    parts.push(`martingale ×${request.stakeMultiplier ?? 2}${request.maxStake ? ` capped at ${request.maxStake}` : ""}`);
  if (request.stakingPlan === "reverse-martingale")
    parts.push(`reverse martingale ×${request.stakeMultiplier ?? 2}${request.maxStake ? ` capped at ${request.maxStake}` : ""}`);
  if (request.stakingPlan === "dalembert")
    parts.push(`D'Alembert step ${request.stakeStep ?? request.stake ?? 0.35}`);
  if (request.stopAfterLossStreak) parts.push(`stop after ${request.stopAfterLossStreak} losses in a row`);
  if (request.stopAfterWinStreak) parts.push(`stop after ${request.stopAfterWinStreak} wins in a row`);
  if (request.digitFilter) {
    const filter = request.digitFilter;
    parts.push(
      filter.kind === "equals"
        ? `only after digit ${filter.digit}`
        : filter.kind === "parity"
          ? `only after an ${filter.parity} digit`
          : filter.kind === "over"
            ? `only when last digit > ${filter.digit}`
            : `only when last digit < ${filter.digit}`,
    );
  }
  if (request.scanMarkets) parts.push("scans all markets and trades the strongest");
  if (request.hedge) parts.push("hedged (both sides)");
  if (request.virtual) parts.push("virtual/paper trades only");
  if (request.cooldownSeconds) parts.push(`${request.cooldownSeconds}s between trades`);
  parts.push(`stop loss ${request.lossLimit ?? 5}, profit target ${request.profitTarget ?? 5}, max ${request.maxTrades ?? 25} trades`);
  return parts.join(" · ");
}

export function dbotAiFamilyLabel(family: DbotAiFamily): string {
  if (family === "rise-fall") return "Rise/Fall";
  if (family === "over-under") return "Over/Under";
  if (family === "even-odd") return "Even/Odd";
  if (family === "differs") return "Differs";
  return "Matches";
}
