export type DbotAiFamily = "rise-fall" | "over-under" | "even-odd" | "matches" | "differs";
export type DbotAiDirection = "RISE" | "FALL";
export type DbotAiDigitSide = "DIGITOVER" | "DIGITUNDER";
export type DbotAiParitySide = "DIGITEVEN" | "DIGITODD";
export type DbotAiDurationUnit = "t" | "m";
/** How the stake moves after each settled contract. */
export type DbotAiStakingPlan =
  | "flat"
  | "martingale"
  | "reverse-martingale"
  | "dalembert"
  | "reverse-dalembert"
  | "fibonacci";
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
  /**
   * Trade both sides at once (rise+fall, over+under on one barrier, ...):
   * the generated strategy uses the doubled hedge purchase block, which
   * opens both opposite positions in the same second.
   */
  hedge?: boolean;
  /**
   * Hedge-leg stake as a percentage of the main stake (default 100).
   * Applied to virtual/paper hedges; real hedges stake the Trade options
   * amount on both legs (the hedge purchase block has no second stake).
   */
  hedgeStakePercent?: number;
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
  prevStake: { id: "aiPrevStakeVariable", name: "ai previous stake" },
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
  // TRADETYPE_LIST must be a key of the vendor trade engine's `opposites`
  // map (vendor .../bot-skeleton/constants/config.ts: CALLPUT, OVERUNDER,
  // EVENODD, MATCHESDIFFERS): the trade_definition generator expands
  // `opposites[trade_type.toUpperCase()]` when you press Run, and any other
  // value makes code generation throw before the bot executes a single
  // block — the workspace then sits on "Bot is starting" with zero trades.
  // Rise/Fall is "callput", not "risefall" (see the shipped strategy XMLs,
  // e.g. vendor src/xml/martingale.xml).
  const contractFamily = request.family === "rise-fall" ? "callput" : "digits";
  const tradeType =
    request.family === "rise-fall"
      ? "callput"
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
  // A stake progression reads the amount from the "ai stake" variable.
  // Trade options re-evaluate on every cycle (BinaryBotPrivateStart runs
  // per loop), so After purchase can line up the next stake before it is
  // read. A flat strategy keeps the plain stake number.
  const amountFromVariable = Boolean(request.stakingPlan && request.stakingPlan !== "flat");
  const amount = amountFromVariable
    ? variablesGet("aiStakeAmount", "stake")
    : numberBlock("aiStake", stake);
  // Trade options are read BEFORE the first Purchase conditions run, so a
  // variable they depend on must be set in INITIALIZATION (which the engine
  // runs once, before the trading loop) — initialising it in Purchase
  // conditions is one cycle too late and the first amount reads as unset.
  const initializations: string[] = [];
  if (amountFromVariable)
    initializations.push(variablesSet("aiInitStakeVar", "stake", numberValue("aiInitStakeValue", stake)));
  if (request.stopAfterLossStreak)
    initializations.push(variablesSet("aiInitLossStreakVar", "lossStreak", numberValue("aiInitLossStreakValue", 0)));
  if (request.stopAfterWinStreak)
    initializations.push(variablesSet("aiInitWinStreakVar", "winStreak", numberValue("aiInitWinStreakValue", 0)));
  const initialization = initializations.length
    ? `<statement name="INITIALIZATION">${chainStatements(initializations)}</statement>`
    : "";
  const tradeOptions = `<block type="trade_definition_tradeoptions" id="aiTradeOptions"><mutation has_first_barrier="false" has_second_barrier="false" has_prediction="${hasPrediction ? "true" : "false"}"></mutation><field name="DURATIONTYPE_LIST">${durationUnit}</field><field name="CURRENCY_LIST">${escapeXml(currency)}</field><value name="DURATION">${numberBlock("aiDuration", durationValue)}</value><value name="AMOUNT">${amount}</value>${optionPrediction}</block>`;
  const market = `<block type="trade_definition_market" id="aiMarket"><field name="MARKET_LIST">volidx</field><field name="SUBMARKET_LIST">random_index</field><field name="SYMBOL_LIST">${escapeXml(cleanSymbol(request.symbol))}</field><next><block type="trade_definition_tradetype" id="aiTradeType"><field name="TRADETYPECAT_LIST">${contractFamily}</field><field name="TRADETYPE_LIST">${tradeType}</field><next><block type="trade_definition_contracttype" id="aiContractType"><field name="TYPE_LIST">both</field><next><block type="trade_definition_candleinterval" id="aiCandleInterval"><field name="CANDLEINTERVAL_LIST">60</field><next><block type="trade_definition_restartbuysell" id="aiRestartBuySell"><field name="TIME_MACHINE_ENABLED">FALSE</field><next><block type="trade_definition_restartonerror" id="aiRestartOnError"><field name="RESTARTONERROR">TRUE</field></block></next></block></next></block></next></block></next></block></next></block>`;
  return `<block type="trade_definition" id="aiTradeDefinition" x="24" y="24">${initialization}<statement name="TRADE_OPTIONS">${market}</statement><statement name="SUBMARKET">${tradeOptions}</statement></block>`;
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
  // Matches and Differs are opposites on the same trade type and digit.
  if (request.family === "matches") return "DIGITDIFF";
  if (request.family === "differs") return "DIGITMATCH";
  return null;
}

/** True when this request builds a real (non-paper) two-legged hedge. */
function hedgeActive(request: DbotAiStrategyRequest): boolean {
  return Boolean(request.hedge && hedgePurchase(request)) && !request.virtual;
}

/** The two leg stakes: the main stake and the hedge leg's share of it. */
function hedgeLegStakes(
  request: DbotAiStrategyRequest,
  baseStake: number,
): { main: number; hedge: number } {
  const percent = clamp(numberOr(request.hedgeStakePercent, 100), 10, 200);
  const hedge = Math.max(0.35, Math.round(baseStake * percent) / 100);
  return { main: baseStake, hedge };
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

/**
 * The opposite paper direction (and its rough payout) for a virtual hedge.
 * Null for Matches/Differs: the virtual blocks have no "differ" direction.
 */
function virtualOpposite(
  request: DbotAiStrategyRequest,
): { direction: string; payout: number } | null {
  if (request.family === "rise-fall")
    return { direction: request.direction === "FALL" ? "rise" : "fall", payout: virtualPayout(request) };
  if (request.family === "over-under") {
    const flipped: DbotAiStrategyRequest = {
      ...request,
      digitSide: request.digitSide === "DIGITUNDER" ? "DIGITOVER" : "DIGITUNDER",
    };
    return {
      direction: request.digitSide === "DIGITUNDER" ? "over" : "under",
      payout: virtualPayout(flipped),
    };
  }
  if (request.family === "even-odd")
    return { direction: request.paritySide === "DIGITODD" ? "even" : "odd", payout: virtualPayout(request) };
  return null;
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
  // The hedge purchase block is the stock Purchase block doubled: it sends
  // both buy requests together, so the two opposite positions open in the
  // same second. Both legs stake the Trade options amount (the block has
  // no second-stake setting). Digit families carry a prediction per leg
  // on the block itself — the same barrier/digit on both sides.
  const hedgeEntry = hedgeType
    ? (() => {
        const predictionValue =
          request.family === "over-under"
            ? clamp(Math.round(numberOr(request.barrier, 5)), 1, 8)
            : clamp(Math.round(numberOr(request.targetDigit, 5)), 0, 9);
        const predictionInputs =
          request.family === "over-under" || request.family === "matches" || request.family === "differs"
            ? `<mutation has_prediction="true" has_first_barrier="false" has_second_barrier="false"></mutation><value name="PREDICTION">${numberBlock("aiHedgePrediction", predictionValue)}</value><value name="HEDGE_PREDICTION">${numberBlock("aiHedgeSecondPrediction", predictionValue)}</value>`
            : "";
        return `<block type="hedge_purchase" id="aiHedgePurchase">${predictionInputs}<field name="PURCHASE_LIST">${purchaseType}</field><field name="HEDGE_LIST">${hedgeType}</field></block>`;
      })()
    : null;
  const barrierOrDigit =
    request.family === "over-under"
      ? clamp(Math.round(numberOr(request.barrier, 5)), 1, 8)
      : clamp(Math.round(numberOr(request.targetDigit, 5)), 0, 9);
  const virtualBuy = `<block type="signal_lab_virtual_buy" id="aiVirtualBuy"><field name="DIRECTION">${virtualDirection(request)}</field><field name="MARKET_LIST">${escapeXml(cleanSymbol(request.symbol))}</field><value name="STAKE">${numberBlock("aiVirtualStake", baseStake)}</value><value name="PAYOUT">${numberBlock("aiVirtualPayout", virtualPayout(request))}</value><value name="BARRIER">${numberBlock("aiVirtualBarrier", barrierOrDigit)}</value></block>`;
  // Paper positions live in the Signal Lab ledger, not the trade engine, so
  // a virtual hedge CAN open both sides in the same pass.
  const paperOpposite = request.virtual && request.hedge ? virtualOpposite(request) : null;
  const virtualHedgeBuy = paperOpposite
    ? `<block type="signal_lab_virtual_buy" id="aiVirtualHedgeBuy"><field name="DIRECTION">${paperOpposite.direction}</field><field name="MARKET_LIST">${escapeXml(cleanSymbol(request.symbol))}</field><value name="STAKE">${numberBlock("aiVirtualHedgeStake", hedgeLegStakes(request, baseStake).hedge)}</value><value name="PAYOUT">${numberBlock("aiVirtualHedgePayout", paperOpposite.payout)}</value><value name="BARRIER">${numberBlock("aiVirtualHedgeBarrier", barrierOrDigit)}</value></block>`
    : null;
  const hedged = hedgeActive(request);
  const entryAction = request.virtual
    ? virtualHedgeBuy
      ? chainStatements([virtualBuy, virtualHedgeBuy])
      : virtualBuy
    : hedged && hedgeEntry
      ? hedgeEntry
      : purchase;
  const entryIf = `<block type="controls_if" id="aiEntryGate"><value name="IF0">${condition}</value><statement name="DO0">${entryAction}</statement></block>`;

  const prelude: string[] = [];
  if (request.stakingPlan && request.stakingPlan !== "flat")
    prelude.push(initVariableIfNull("aiInitStake", "stake", baseStake));
  if (request.stakingPlan === "fibonacci")
    prelude.push(initVariableIfNull("aiInitPrevStake", "prevStake", 0));
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
  } else if (plan === "dalembert" || plan === "reverse-dalembert") {
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
    // D'Alembert climbs after a loss; the reverse climbs after a win.
    const onWin = plan === "dalembert" ? down : up;
    const onLoss = plan === "dalembert" ? up : down;
    statements.push(
      `<block type="controls_if" id="aiStakeProgression"><mutation else="1"></mutation><value name="IF0">${won}</value><statement name="DO0">${onWin}</statement><statement name="ELSE">${onLoss}</statement></block>`,
      // Never let a D'Alembert step take the stake below the base stake.
      `<block type="controls_if" id="aiStakeFloor"><value name="IF0">${compareValues("aiStakeFloorCheck", "LT", variablesGet("aiStakeFloorGet", "stake"), numberValue("aiStakeFloorValue", baseStake))}</value><statement name="DO0">${variablesSet("aiStakeFloorSet", "stake", numberValue("aiStakeFloorBase", baseStake))}</statement></block>`,
    );
  } else if (plan === "fibonacci") {
    // The Fibonacci staking ladder (1, 1, 2, 3, 5, 8 … × base stake) as a
    // two-variable recurrence: after a loss the next stake is the sum of
    // the last two; a win restarts the ladder. The ladder restarts by
    // itself once it passes 21× the base stake, so a long losing streak
    // cannot grow it without bound.
    const resetLadder = chainStatements([
      variablesSet("aiFibResetPrev", "prevStake", numberValue("aiFibResetPrevValue", 0)),
      variablesSet("aiFibReset", "stake", numberValue("aiFibResetValue", baseStake)),
    ]);
    // Advance without a temp variable: stake := stake + prev, then
    // prev := (new stake) − prev = the old stake. Starting from
    // stake = base, prev = 0 the stakes run 1, 1, 2, 3, 5, 8 … × base.
    const advance = chainStatements([
      variablesSet(
        "aiFibGrow",
        "stake",
        arithmetic("aiFibGrowCalc", "ADD", variablesGet("aiFibGrowGet", "stake"), variablesGet("aiFibGrowPrevGet", "prevStake")),
      ),
      variablesSet(
        "aiFibShift",
        "prevStake",
        arithmetic("aiFibShiftCalc", "MINUS", variablesGet("aiFibShiftGet", "stake"), variablesGet("aiFibShiftPrevGet", "prevStake")),
      ),
    ]);
    const cap = Math.round(baseStake * 21 * 100) / 100;
    statements.push(
      `<block type="controls_if" id="aiStakeProgression"><mutation else="1"></mutation><value name="IF0">${won}</value><statement name="DO0">${resetLadder}</statement><statement name="ELSE">${advance}</statement></block>`,
      `<block type="controls_if" id="aiFibCap"><value name="IF0">${compareValues("aiFibCapCheck", "GT", variablesGet("aiFibCapGet", "stake"), numberValue("aiFibCapValue", cap))}</value><statement name="DO0">${chainStatements([
        variablesSet("aiFibCapResetPrev", "prevStake", numberValue("aiFibCapPrevValue", 0)),
        variablesSet("aiFibCapReset", "stake", numberValue("aiFibCapBase", baseStake)),
      ])}</statement></block>`,
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
  // No cooldown: re-arm immediately after settlement. A `timeout` wrapper
  // would only add a needless sleep between the close and the next entry.
  const again =
    cooldownSeconds > 0
      ? `<block type="timeout" id="aiCooldown"><statement name="TIMEOUTSTACK"><block type="trade_again" id="aiTradeAgain"></block></statement><value name="SECONDS">${numberBlock("aiCooldownSeconds", cooldownSeconds)}</value></block>`
      : `<block type="trade_again" id="aiTradeAgain"></block>`;
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
  // Default to no post-trade pause: entries already wait for the previous
  // contract to settle, and users expect a position again on the next ticks.
  // A cooldown is only added when the request asks for one.
  const cooldownSeconds = clamp(numberOr(input.cooldownSeconds, 0), 0, 300);
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
  if (input.stakingPlan === "fibonacci") variableKeys.push("prevStake");
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
  const stepFrom = (text: string) => {
    const stepMatch = text.match(/(?:step|unit|by)\s*(?:of\s*)?\$?\s*(\d+(?:\.\d+)?)/);
    return stepMatch ? clamp(Number(stepMatch[1]), 0.01, 10_000) : undefined;
  };
  // Reverse D'Alembert must be read before D'Alembert (substring) and
  // Oscar's Grind is approximated by it (readWarnings says so).
  if (/\b(reverse|anti)[-\s]?d['’]?alembert\b/.test(prompt) || /\boscar/.test(prompt))
    return { stakingPlan: "reverse-dalembert", stakeStep: stepFrom(prompt), maxStake };
  if (
    /\b(reverse|anti)[-\s]?martingale\b/.test(prompt) ||
    /\bparoli\b/.test(prompt) ||
    /\b1[-–—\s]?3[-–—\s]?2[-–—\s]?[46]\b/.test(prompt) ||
    /\b(double|increase|multiply)\b[^.]*\bafter\s+(?:a\s+|each\s+|every\s+)?(?:win|winning)\b/.test(prompt)
  )
    return { stakingPlan: "reverse-martingale", stakeMultiplier: stakeMultiplier ?? 2, maxStake };
  if (/\bfibonacci\b/.test(prompt))
    return { stakingPlan: "fibonacci", maxStake };
  if (/\bd['’]?alembert\b/.test(prompt) || /\blabouch/.test(prompt) || /\bcancellation system\b/.test(prompt))
    return { stakingPlan: "dalembert", stakeStep: stepFrom(prompt), maxStake };
  // "no martingale" must not read as martingale: the negation only cancels
  // the bare name match, so "no martingale, use d'alembert" (handled above)
  // and "double after a loss" still win on their own wording.
  const martingaleNegated = /\b(no|without|remove|not|never)\s+(?:a\s+|the\s+)?martingale\b/.test(prompt);
  if (
    (!martingaleNegated && /\bmartingale\b/.test(prompt)) ||
    /\b(double|multiply|increase)\b[^.]*\bafter\s+(?:a\s+|each\s+|every\s+)?(?:loss|losing|lose)\b/.test(prompt) ||
    /\brecover(?:y|ing)?\b[^.]*\bloss/.test(prompt)
  )
    return { stakingPlan: "martingale", stakeMultiplier: stakeMultiplier ?? 2, maxStake };
  const stepMatch = prompt.match(/\bincrease\s+(?:the\s+)?stake\s+by\s+\$?\s*(\d+(?:\.\d+)?)[^.]*\bafter\s+(?:a\s+|each\s+|every\s+)?(?:loss|losing)/);
  if (stepMatch)
    return { stakingPlan: "dalembert", stakeStep: clamp(Number(stepMatch[1]), 0.01, 10_000), maxStake };
  // Kelly and percent-of-balance staking size each trade from a live edge
  // or the live balance; a static block strategy cannot, so build flat and
  // say so (readWarnings) instead of silently substituting martingale.
  if (
    /\bkelly\b/.test(prompt) ||
    /\b\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:of\s+)?(?:my\s+|the\s+)?(?:balance|bankroll|account|equity)\b/.test(prompt) ||
    /\bpercent(?:age)?\s+(?:of\s+)?(?:the\s+)?(?:balance|bankroll)\b/.test(prompt)
  )
    return { stakingPlan: "flat", maxStake };
  // Explicit flat/fixed-stake request is the only way to opt out.
  if (
    /\b(flat staking|fixed stake|fixed staking|level staking|constant stake|same stake|no martingale|without martingale|no recovery)\b/.test(
      prompt,
    )
  )
    return { stakingPlan: "flat", maxStake };
  // Standard build: every bot ships with martingale ×2 loss recovery (plus
  // the take profit / stop loss the risk gate always emits). A multiplier
  // named in the prompt ("x2.2") still wins.
  return { stakingPlan: "martingale", stakeMultiplier: stakeMultiplier ?? 2, maxStake };
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
  // Staking systems this builder approximates — the approximation is named
  // so nobody mistakes it for the real sequence.
  if (/\boscar/.test(prompt))
    warnings.push(
      "Oscar's Grind tracks a per-cycle profit target this builder cannot express, so it was built as Reverse D'Alembert (+1 unit after a win, −1 after a loss) — the closest ladder. Add cycle bookkeeping with variables in DBot for true Oscar's Grind.",
    );
  if (/\b1[-–—\s]?3[-–—\s]?2[-–—\s]?[46]\b/.test(prompt))
    warnings.push(
      "The 1-3-2-6/1-3-2-4 sequence needs win-streak state this builder does not generate, so it was built as a reverse martingale (press after wins, reset after a loss). The sequence itself can be added with a step variable in DBot.",
    );
  if (/\blabouch/.test(prompt) || /\bcancellation system\b/.test(prompt))
    warnings.push(
      "Labouchère keeps a written number line this builder cannot express, so it was built as D'Alembert (+1 unit after a loss, −1 after a win) — the closest ladder.",
    );
  if (
    /\bkelly\b/.test(prompt) ||
    /\b\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:of\s+)?(?:my\s+|the\s+)?(?:balance|bankroll|account|equity)\b/.test(prompt) ||
    /\bpercent(?:age)?\s+(?:of\s+)?(?:the\s+)?(?:balance|bankroll)\b/.test(prompt)
  )
    warnings.push(
      "Kelly and percent-of-balance staking size each trade from a live win-rate edge or the live balance, which a generated block strategy cannot recalculate per trade — the bot was built with a flat stake at the amount named. Recompute the stake from the Balance block inside Purchase conditions for true percentage staking.",
    );
  // Contract families Deriv offers that this builder does not generate.
  if (/\b(higher|lower)\b/.test(prompt) && !/\b(over|under|digit|barrier \d|last digit)\b/.test(prompt))
    warnings.push(
      "Higher/Lower is a barrier contract this builder does not generate (it builds Rise/Fall and the digit families). In DBot: set the trade type to Higher/Lower, set the barrier offset in Trade options, and the Purchase hedge block grows per-leg barrier inputs if you hedge it.",
    );
  if (/\btouch/.test(prompt))
    warnings.push(
      "Touch/No Touch is a barrier contract this builder does not generate. In DBot: set the trade type to Touch/No Touch with minutes/hours duration and a barrier offset; the Purchase hedge block grows per-leg barrier inputs if you hedge it.",
    );
  if (/\b(ends? (between|outside)|stays? between|goes outside|in\/?out)\b/.test(prompt))
    warnings.push(
      "In/Out contracts (Ends Between/Outside, Stays Between/Goes Outside) use two barriers and are not generated here. In DBot they live under the In/Out trade types, and the Purchase hedge block grows high/low barrier inputs per leg.",
    );
  if (/\b(high tick|low tick|reset (call|put)|Asian|only ups|only downs|call spread|put spread)\b/.test(prompt))
    warnings.push(
      "That contract family (High/Low Tick, Reset, Asians, Only Ups/Downs, Spreads) is not generated by this builder, which builds Rise/Fall and the digit families. The same market, stake and risk limits were kept.",
    );
  if (/\b\d+\s*(?:seconds?|secs?)\b/.test(prompt) && !/\b(wait|pause|cooldown|gap|between)\b/.test(prompt))
    warnings.push(
      "Durations here are generated in ticks (and minutes for Rise/Fall), so a seconds duration was read as that many ticks. On 2-second markets (R_10–R_100) one tick is about 2 seconds; adjust the Duration block in Trade options if you need exact seconds.",
    );
  if (/\bhedge\b[^.]*\b(after|only if|when|on)\b[^.]*\b(loss|losing|loses)\b/.test(prompt))
    warnings.push(
      "Conditional hedging (opening the opposite only after a loss) was built as an always-on hedge; wrap the Purchase hedge block in an If on the last contract result in DBot for the conditional version.",
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
    ) ??
    description.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:per|each|a|every)\s+trade/i) ??
    description.match(/\b(?:risk|trade with|use|using)\s+(?:a\s+stake\s+of\s+)?\$?\s*(\d+(?:\.\d+)?)\s*(?:usd|dollars?)?\s*(?:per|each|a|every)?\s*trade/i) ??
    description.match(/\$\s*(\d+(?:\.\d+)?)/);
  return amount ? clamp(Number(amount[1]), 0.35, 10) : 0.35;
}

function readRiskSetting(description: string, kind: "loss" | "profit"): number {
  const match =
    kind === "loss"
      ? (description.match(
          /\b(?:loss limit|max(?:imum)? loss|stop[- ]loss|daily loss|session loss)\s*(?:of|at|to|is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
        ) ??
        description.match(/\bSL\s*(?:of|at|to|is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/) ??
        description.match(/\bstop[^.]*?\b(?:when|if)\b[^.]*?\bdown\s*\$?\s*(\d+(?:\.\d+)?)/i) ??
        description.match(/\bstop[^.]*?\bafter losing\s*\$?\s*(\d+(?:\.\d+)?)/i))
      : (description.match(
          /\b(?:profit target|take[- ]profit|target profit|daily profit|session profit)\s*(?:of|at|to|is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
        ) ??
        description.match(/\bTP\s*(?:of|at|to|is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/) ??
        description.match(/\bstop[^.]*?\b(?:when|if)\b[^.]*?\bup\s*\$?\s*(\d+(?:\.\d+)?)/i) ??
        description.match(/\bstop[^.]*?\bafter winning\s*\$?\s*(\d+(?:\.\d+)?)/i));
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
    ) ??
    description.match(/\bmax(?:imum)?\s+(\d+)\s+(?:trades|runs)\b/i) ??
    description.match(/\bstop\s+after\s+(\d+)\s+(?:trades|runs|contracts)\b/i) ??
    description.match(/\b(?:run|take|make|do)\s+(?:only\s+)?(\d+)\s+(?:trades|runs|contracts)\b/i) ??
    description.match(/\b(\d+)\s+(?:trades|runs|contracts)\s+(?:only|in total|max)\b/i);
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
  // "30 seconds": generated durations are ticks/minutes, so read seconds as
  // ticks and let readWarnings say so (never silently default to 1 tick).
  const seconds = description.match(/\b(\d+)\s*(?:seconds?|secs?)\b(?![^.]*\b(?:wait|between|cooldown|pause|gap)\b)/i);
  if (seconds) return { duration: clamp(Number(seconds[1]), 1, 10), durationUnit: "t" };
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
  const prompt = description.toLowerCase();
  // \bhedg (not \bhedge\b) so "hedging" and "hedged" count too: "build a
  // hedging bot" used to fall through every test and produce a plain
  // one-sided rise/fall bot.
  const hedge =
    /\bhedg/.test(prompt) ||
    /\bbuy\s+both\b/.test(prompt) ||
    /\bboth\s+(?:sides|directions)\b/.test(prompt) ||
    /\bopposite\s+(?:sides?|directions?|contracts?|positions?)\b/.test(prompt) ||
    /\b(?:both|buy|trade|cover)\s+(?:the\s+)?(?:rise\s+and\s+fall|fall\s+and\s+rise|over\s+and\s+under|under\s+and\s+over|even\s+and\s+odd|odd\s+and\s+even)\b/.test(
      prompt,
    );
  // "hedge at 50%", "50% on the hedge side", "half the stake on the hedge".
  const hedgePercentMatch =
    prompt.match(/hedg\w*[^.]*?(\d+(?:\.\d+)?)\s*(?:%|percent)/) ??
    prompt.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)[^.]*?hedg/);
  const hedgeStakePercent = !hedge
    ? undefined
    : hedgePercentMatch
      ? clamp(Number(hedgePercentMatch[1]), 10, 200)
      : /\bhalf\b[^.]*\bhedg|\bhedg\w*[^.]*\bhalf\b/.test(prompt)
        ? 50
        : undefined;
  const virtual = /\b(virtual|paper\s+trad\w*)\b/.test(prompt);
  const namedFamily = familyFromSignalName(description);
  // A hedge request that names no contract family ("build a hedging bot")
  // still needs one pair of opposite contracts: default to Rise/Fall
  // (CALL + PUT) and say so in the warnings, instead of building nothing.
  const family = namedFamily ?? (hedge ? "rise-fall" : null);
  if (!family) return null;
  const duration = readDuration(description, family);
  const procedureName = readProcedureName(description);
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
    hedgeStakePercent,
    virtual: virtual || undefined,
    usedVisionAi: /\bvision\b/.test(prompt) && family === "over-under",
    warnings: [
      ...readWarnings(description),
      ...(hedge && !namedFamily
        ? [
            "No contract family was named, so this hedges Rise/Fall. Ask for over/under, even/odd or matches hedging to hedge a different pair.",
          ]
        : []),
      ...(hedge && !virtual
        ? [
            "Both hedge legs open at the same time with the hedge purchase block, each at the Trade options stake. The two legs count as two runs toward the trade cap, and win/loss checks in After purchase read the main leg.",
            ...(hedgeStakePercent !== undefined
              ? [
                  "The hedge purchase block stakes the Trade options amount on both legs, so the requested hedge percentage was not applied to the stake.",
                ]
              : []),
          ]
        : []),
    ],
  };
  if (family === "rise-fall") {
    // In a hedge both sides are named ("buy both rise and fall"): the FIRST
    // named side is the main leg (full stake), the other is the hedge leg.
    const fallAt = prompt.search(/\b(fall|put|bearish|downward|go short)\b/);
    const riseAt = prompt.search(/\b(rise|call|bullish|upward|go long)\b/);
    const direction =
      hedge && riseAt !== -1 && fallAt !== -1
        ? riseAt < fallAt
          ? "RISE"
          : "FALL"
        : fallAt !== -1
          ? "FALL"
          : "RISE";
    return { ...shared, direction };
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
  if (/\b(martingale|alembert|fibonacci|paroli|oscar|labouch|kelly|flat staking|fixed stake|double|multiply|increase\s+(?:the\s+)?stake)\b/.test(prompt) || /\bpercent/.test(prompt)) {
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
  if (/\bhedg/.test(prompt)) {
    next.hedge = !/\b(no|remove|without)\b[^.]*\bhedg/.test(prompt);
    const percentMatch =
      prompt.match(/hedg\w*[^.]*?(\d+(?:\.\d+)?)\s*(?:%|percent)/) ??
      prompt.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)[^.]*?hedg/);
    if (percentMatch) next.hedgeStakePercent = clamp(Number(percentMatch[1]), 10, 200);
    else if (/\bhalf\b[^.]*\bhedg|\bhedg\w*[^.]*\bhalf\b/.test(prompt)) next.hedgeStakePercent = 50;
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
  if (request.stakingPlan === "reverse-dalembert")
    parts.push(`Reverse D'Alembert step ${request.stakeStep ?? request.stake ?? 0.35}`);
  if (request.stakingPlan === "fibonacci")
    parts.push("Fibonacci ladder (1, 1, 2, 3, 5 … × base stake, restarts past ×21)");
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
  if (request.hedge)
    parts.push(
      request.virtual
        ? "hedged (both paper sides together)"
        : "hedged (both sides open together, same stake)",
    );
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
