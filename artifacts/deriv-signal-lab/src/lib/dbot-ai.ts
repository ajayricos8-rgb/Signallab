export type DbotAiFamily =
  | "rise-fall"
  | "higher-lower"
  | "over-under"
  | "even-odd"
  | "matches"
  | "differs";
/**
 * The entry-logic shape of the bot, independent of the contract family:
 * - standard: buy the named side whenever the risk gate passes;
 * - markov: only enter when the measured digit-transition chance for the
 *   chosen side clears a threshold (`m_transition` blocks);
 * - streak: enter after N same-parity/same-side digits (or rises/falls) in
 *   a row, following the run or fading it (`streakMode`);
 * - momentum: follow the measured tick slope — Rise while rising, Fall
 *   while falling (`q_slope`);
 * - reversal: fade extremes — RSI overbought/oversold on Rise/Fall, a long
 *   parity/over-under run faded on digit contracts;
 * - switcher: trade the primary strategy until a loss, then switch to a
 *   Markov + market-scan recovery mode and revert once the session is back
 *   in profit;
 * - comprehensive: scan all markets + Markov gate + profit/loss guards +
 *   the standard risk gate, all at once;
 * - ai: let the AI analysis decide entries (Vision entry signal on
 *   Over/Under, the all-markets scan everywhere else).
 */
export type DbotAiArchetype =
  | "standard"
  | "markov"
  | "streak"
  | "momentum"
  | "reversal"
  | "switcher"
  | "comprehensive"
  | "ai";
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
  /** Entry-logic shape (default "standard"). */
  archetype?: DbotAiArchetype;
  /**
   * Signed barrier offset for Higher/Lower (e.g. 1 → "+1", -1.5 → "-1.5").
   * Defaults: +1 for Higher, -1 for Lower.
   */
  barrierOffset?: number;
  /** Signed barrier offset for the second (hedge) leg of a hedged Higher/Lower. */
  hedgeBarrierOffset?: number;
  /** Markov transition chance (percent) the chosen side must clear. */
  markovThreshold?: number;
  /** Run length a streak/reversal entry waits for (default 3). */
  streakLength?: number;
  /** Follow a run or trade against it (streak archetype; default "follow"). */
  streakMode?: "follow" | "fade";
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
  markov: { id: "aiMarkovVariable", name: "ai markov" },
  mode: { id: "aiModeVariable", name: "ai mode" },
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
  const contractFamily =
    request.family === "rise-fall" || request.family === "higher-lower"
      ? "callput"
      : "digits";
  const tradeType =
    request.family === "rise-fall"
      ? "callput"
      : request.family === "higher-lower"
        ? "higherlower"
        : request.family === "over-under"
          ? "overunder"
          : request.family === "even-odd"
            ? "evenodd"
            : "matchesdiffers";
  // When the strategy hedges, the prediction/barrier configuration lives on
  // the hedge block's Purchase 1 / Purchase 2 rows — Trade options carries
  // no third one (the workspace also hides these inputs in that shape).
  const hedged = Boolean(request.hedge && hedgePurchase(request));
  const prediction = hedged
    ? null
    : request.family === "over-under"
      ? clamp(Math.round(numberOr(request.barrier, 5)), 1, 8)
      : request.family === "matches" || request.family === "differs"
        ? clamp(Math.round(numberOr(request.targetDigit, 5)), 0, 9)
        : null;
  const barrierOffset =
    request.family === "higher-lower" && !hedged ? resolvedBarrierOffset(request) : null;
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
  if (usesMarkov(request))
    initializations.push(variablesSet("aiInitMarkovVar", "markov", numberValue("aiInitMarkovValue", 0)));
  if (isSwitcher(request))
    initializations.push(variablesSet("aiInitModeVar", "mode", numberValue("aiInitModeValue", 0)));
  const initialization = initializations.length
    ? `<statement name="INITIALIZATION">${chainStatements(initializations)}</statement>`
    : "";
  const optionBarrier =
    barrierOffset !== null
      ? `<field name="BARRIEROFFSETTYPE_LIST">${barrierOffset < 0 ? "-" : "+"}</field><value name="BARRIEROFFSET">${numberBlock("aiBarrierOffset", Math.abs(barrierOffset))}</value>`
      : "";
  const tradeOptions = `<block type="trade_definition_tradeoptions" id="aiTradeOptions"><mutation has_first_barrier="${barrierOffset !== null ? "true" : "false"}" has_second_barrier="false" has_prediction="${hasPrediction ? "true" : "false"}"></mutation><field name="DURATIONTYPE_LIST">${durationUnit}</field><field name="CURRENCY_LIST">${escapeXml(currency)}</field>${optionBarrier}<value name="DURATION">${numberBlock("aiDuration", durationValue)}</value><value name="AMOUNT">${amount}</value>${optionPrediction}</block>`;
  const market = `<block type="trade_definition_market" id="aiMarket"><field name="MARKET_LIST">volidx</field><field name="SUBMARKET_LIST">random_index</field><field name="SYMBOL_LIST">${escapeXml(cleanSymbol(request.symbol))}</field><next><block type="trade_definition_tradetype" id="aiTradeType"><field name="TRADETYPECAT_LIST">${contractFamily}</field><field name="TRADETYPE_LIST">${tradeType}</field><next><block type="trade_definition_contracttype" id="aiContractType"><field name="TYPE_LIST">both</field><next><block type="trade_definition_candleinterval" id="aiCandleInterval"><field name="CANDLEINTERVAL_LIST">60</field><next><block type="trade_definition_restartbuysell" id="aiRestartBuySell"><field name="TIME_MACHINE_ENABLED">FALSE</field><next><block type="trade_definition_restartonerror" id="aiRestartOnError"><field name="RESTARTONERROR">TRUE</field></block></next></block></next></block></next></block></next></block></next></block>`;
  return `<block type="trade_definition" id="aiTradeDefinition" x="24" y="24">${initialization}<statement name="TRADE_OPTIONS">${market}</statement><statement name="SUBMARKET">${tradeOptions}</statement></block>`;
}

function selectedPurchase(request: DbotAiStrategyRequest): string {
  // Higher/Lower trades the same CALL/PUT contracts as Rise/Fall; the
  // barrier in Trade options (or on the hedge block) is what makes them
  // Higher/Lower instead of at-the-money Rise/Fall.
  if (request.family === "rise-fall" || request.family === "higher-lower")
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
  if (request.family === "rise-fall" || request.family === "higher-lower")
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

/** The strategy's archetype, defaulting to the plain gated purchase. */
function archetypeOf(request: DbotAiStrategyRequest): DbotAiArchetype {
  return request.archetype ?? "standard";
}

/** Archetypes whose entries read the Markov transition measurement. */
function usesMarkov(request: DbotAiStrategyRequest): boolean {
  const archetype = archetypeOf(request);
  return (
    (archetype === "markov" || archetype === "comprehensive" || archetype === "switcher") &&
    (request.family === "even-odd" ||
      request.family === "over-under" ||
      request.family === "matches")
  );
}

/** A switcher needs a digit family its Markov recovery can measure. */
function isSwitcher(request: DbotAiStrategyRequest): boolean {
  return archetypeOf(request) === "switcher" && usesMarkov(request) && !request.virtual;
}

/**
 * The main leg's signed Higher/Lower barrier offset. Unspecified offsets
 * point away from spot in the traded direction (+1 Higher, -1 Lower).
 */
function resolvedBarrierOffset(request: DbotAiStrategyRequest): number {
  if (Number.isFinite(request.barrierOffset) && request.barrierOffset !== 0)
    return clamp(Number(request.barrierOffset), -10_000, 10_000);
  return request.direction === "FALL" ? -1 : 1;
}

/**
 * The hedge leg's signed offset: a named value, else the SAME barrier as
 * the main leg — Deriv's own hedge rows carry one barrier level on both
 * rows (Higher +0.39 / Lower +0.39), which makes the pair complementary:
 * exactly one leg wins (bar the barrier itself). Mirrored offsets
 * (+1 / −1) instead open a middle zone where BOTH legs lose.
 */
function resolvedHedgeBarrierOffset(request: DbotAiStrategyRequest): number {
  if (Number.isFinite(request.hedgeBarrierOffset) && request.hedgeBarrierOffset !== 0)
    return clamp(Number(request.hedgeBarrierOffset), -10_000, 10_000);
  return resolvedBarrierOffset(request);
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
  // The analysis gate has no Higher/Lower family (analysis never produces
  // one); map it to its Rise/Fall sibling so the field stays valid.
  const gateFamily = request.family === "higher-lower" ? "rise-fall" : request.family;
  return `<block type="signal_lab_analysis_gate" id="aiAnalysisGate"><field name="FAMILY">${gateFamily}</field><field name="SYMBOL">${escapeXml(cleanSymbol(request.symbol))}</field><field name="CONTRACT_TYPE">${selectedPurchase(request)}</field><field name="BARRIER">${barrier}</field><field name="TARGET_DIGIT">${targetDigit}</field><field name="ANALYSIS_ID">${escapeXml((request.analysisId ?? "").slice(0, 180))}</field></block>`;
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
  if (request.family === "rise-fall" || request.family === "higher-lower")
    return request.direction === "FALL" ? "fall" : "rise";
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
  if (request.family === "rise-fall" || request.family === "higher-lower")
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

/**
 * The archetype that will actually be built for this family: momentum on a
 * digit contract becomes a digit-run follow, reversal on digits becomes a
 * run fade, and shapes a family cannot express fall back to standard. The
 * parser warns by name whenever the built shape differs from the asked one.
 */
function effectiveArchetype(request: DbotAiStrategyRequest): DbotAiArchetype {
  const archetype = archetypeOf(request);
  const digitFamily =
    request.family === "even-odd" ||
    request.family === "over-under" ||
    request.family === "matches" ||
    request.family === "differs";
  if (archetype === "momentum" && digitFamily) return "streak";
  if (archetype === "reversal" && (request.family === "matches" || request.family === "differs"))
    return "standard";
  if (archetype === "streak" && (request.family === "matches" || request.family === "differs"))
    return "standard";
  if (archetype === "switcher" && !isSwitcher(request)) return "standard";
  return archetype;
}

/** The last-1000-ticks list every Vision Lab measurement reads. */
function ticksBlock(id: string): string {
  return `<block type="ticks" id="${id}"></block>`;
}

/** One measured Markov transition: P(digit becomes `to` after `horizon` ticks | digit is `from`). */
function markovTransition(id: string, to: number, horizon: number): string {
  return `<block type="m_transition" id="${id}"><value name="FROM"><block type="last_digit" id="${id}From"></block></value><value name="TO">${numberBlock(`${id}To`, to)}</value><value name="HORIZON">${numberBlock(`${id}Horizon`, horizon)}</value><value name="LIST">${ticksBlock(`${id}Ticks`)}</value></block>`;
}

/** The digits that WIN the configured side — the Markov sum measures their combined chance. */
function markovDigitSet(request: DbotAiStrategyRequest): number[] {
  if (request.family === "even-odd")
    return request.paritySide === "DIGITODD" ? [1, 3, 5, 7, 9] : [0, 2, 4, 6, 8];
  if (request.family === "over-under") {
    const barrier = clamp(Math.round(numberOr(request.barrier, 5)), 1, 8);
    return request.digitSide === "DIGITUNDER"
      ? Array.from({ length: barrier }, (_, digit) => digit)
      : Array.from({ length: 9 - barrier }, (_, index) => barrier + 1 + index);
  }
  if (request.family === "matches")
    return [clamp(Math.round(numberOr(request.targetDigit, 5)), 0, 9)];
  return [];
}

/**
 * The Markov bar: the measured chance must beat the FAIR chance of the
 * digit set (10% per digit) by a small margin, unless the user set one.
 */
function markovThresholdFor(request: DbotAiStrategyRequest): number {
  if (Number.isFinite(request.markovThreshold))
    return clamp(Number(request.markovThreshold), 1, 99);
  return clamp(markovDigitSet(request).length * 10 + 3, 1, 99);
}

/** "set ai markov to Σ P(last digit → each winning digit)" — the Markov read. */
function markovPrelude(request: DbotAiStrategyRequest): string {
  const digits = markovDigitSet(request);
  // A buy's entry tick is the tick AFTER the purchase, so the digit that
  // settles a D-tick contract prints D+1 ticks after the last digit in
  // hand — the Markov sums measure the transition to THAT tick.
  const horizon = clamp(Math.round(numberOr(request.duration, 1)) + 1, 2, 11);
  let sum = markovTransition(`aiMarkovT${digits[digits.length - 1]}`, digits[digits.length - 1], horizon);
  for (let index = digits.length - 2; index >= 0; index -= 1) {
    sum = arithmetic(
      `aiMarkovSum${digits[index]}`,
      "ADD",
      markovTransition(`aiMarkovT${digits[index]}`, digits[index], horizon),
      sum,
    );
  }
  return variablesSet("aiMarkovSet", "markov", sum);
}

/** "ai markov ≥ threshold": the measured transition chance clears its bar. */
function markovCondition(request: DbotAiStrategyRequest, idPrefix = "aiMarkovGate"): string {
  return compareValues(
    idPrefix,
    "GTE",
    variablesGet(`${idPrefix}Get`, "markov"),
    numberBlock(`${idPrefix}Bar`, markovThresholdFor(request)),
  );
}

/** The signed run measurement for streak/reversal entries (+ first side, − second side). */
function runMeasurement(request: DbotAiStrategyRequest, idPrefix: string): string {
  if (request.family === "even-odd")
    return `<block type="m_parity_run" id="${idPrefix}Run"><value name="LIST">${ticksBlock(`${idPrefix}Ticks`)}</value></block>`;
  if (request.family === "over-under")
    return `<block type="m_over_under_run" id="${idPrefix}Run"><value name="BARRIER">${numberBlock(`${idPrefix}Barrier`, clamp(Math.round(numberOr(request.barrier, 5)), 1, 8))}</value><value name="LIST">${ticksBlock(`${idPrefix}Ticks`)}</value></block>`;
  return `<block type="q_streak" id="${idPrefix}Run"><value name="LIST">${ticksBlock(`${idPrefix}Ticks`)}</value></block>`;
}

/** The two purchase contracts a dynamic entry chooses between, first side then second. */
function dynamicSides(request: DbotAiStrategyRequest): [string, string] {
  if (request.family === "even-odd") return ["DIGITEVEN", "DIGITODD"];
  if (request.family === "over-under") return ["DIGITOVER", "DIGITUNDER"];
  return ["CALL", "PUT"];
}

function purchaseBlock(id: string, contractType: string): string {
  return `<block type="purchase" id="${id}"><field name="PURCHASE_LIST">${contractType}</field></block>`;
}

/**
 * The branch conditions of a dynamic (side-choosing) entry for momentum,
 * reversal and streak archetypes: [first-side signal, second-side signal].
 */
function dynamicBranchConditions(request: DbotAiStrategyRequest): [string, string] {
  const archetype = effectiveArchetype(request);
  const runLength = clamp(Math.round(numberOr(request.streakLength, 3)), 2, 10);
  const fade =
    archetype === "reversal" || (archetype === "streak" && request.streakMode === "fade");
  if (archetype === "momentum") {
    const slope = (idPrefix: string) =>
      `<block type="q_slope" id="${idPrefix}Slope"><value name="LIST">${ticksBlock(`${idPrefix}Ticks`)}</value></block>`;
    return [
      compareValues("aiDynUp", "GT", slope("aiDynUp"), numberBlock("aiDynUpZero", 0)),
      compareValues("aiDynDown", "LT", slope("aiDynDown"), numberBlock("aiDynDownZero", 0)),
    ];
  }
  if (
    archetype === "reversal" &&
    (request.family === "rise-fall" || request.family === "higher-lower")
  ) {
    const rsi = (idPrefix: string) =>
      `<block type="q_rsi" id="${idPrefix}Rsi"><value name="LIST">${ticksBlock(`${idPrefix}Ticks`)}</value><value name="PERIOD">${numberBlock(`${idPrefix}Period`, 14)}</value></block>`;
    // Oversold (RSI < 30) fades up into a Rise; overbought (RSI > 70) into a Fall.
    return [
      compareValues("aiDynUp", "LT", rsi("aiDynUp"), numberBlock("aiDynUpBar", 30)),
      compareValues("aiDynDown", "GT", rsi("aiDynDown"), numberBlock("aiDynDownBar", 70)),
    ];
  }
  // Streak (and digit reversal = streak fade): a run of N on one side.
  const up = compareValues(
    "aiDynUp",
    "GTE",
    runMeasurement(request, "aiDynUp"),
    numberBlock("aiDynUpBar", runLength),
  );
  const down = compareValues(
    "aiDynDown",
    "LTE",
    runMeasurement(request, "aiDynDown"),
    numberBlock("aiDynDownBar", -runLength),
  );
  // Following buys the side that is running; fading buys the other one.
  return fade ? [down, up] : [up, down];
}

/** True when the entry picks its side per tick instead of a fixed side. */
function dynamicEntry(request: DbotAiStrategyRequest): boolean {
  if (request.virtual || hedgeActive(request) || request.analysisId) return false;
  const archetype = effectiveArchetype(request);
  return archetype === "momentum" || archetype === "reversal" || archetype === "streak";
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
  // Fixed-side archetype gates stack onto the same entry condition. (The
  // side-choosing archetypes branch below instead, and the switcher's
  // Markov gate lives inside its recovery branch.)
  const archetype = effectiveArchetype(request);
  if ((archetype === "markov" || archetype === "comprehensive") && usesMarkov(request))
    conditions.push(markovCondition(request));
  if (archetype === "comprehensive") {
    conditions.push(
      `<block type="r_loss_guard" id="aiCompLossGuard"><value name="LIMIT">${numberBlock("aiCompLossLimit", clamp(numberOr(request.lossLimit, 5), 0.35, 10_000))}</value></block>`,
      `<block type="r_profit_guard" id="aiCompProfitGuard"><value name="TARGET">${numberBlock("aiCompProfitTarget", clamp(numberOr(request.profitTarget, 5), 0.35, 10_000))}</value></block>`,
    );
    if (request.family === "rise-fall" || request.family === "higher-lower")
      conditions.push(
        compareValues(
          "aiCompTrend",
          request.direction === "FALL" ? "LT" : "GT",
          `<block type="q_slope" id="aiCompSlope"><value name="LIST">${ticksBlock("aiCompTicks")}</value></block>`,
          numberBlock("aiCompTrendZero", 0),
        ),
      );
  }
  if (archetype === "ai" && request.family === "over-under" && !request.virtual)
    conditions.push(
      `<block type="x_ai_should_buy" id="aiAiSignal"><value name="MIN_EDGE">${numberBlock("aiAiMinEdge", 0)}</value></block>`,
    );
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
            : request.family === "higher-lower"
              ? (() => {
                  // Each leg carries its own signed barrier offset on the
                  // block's Purchase 1 / Purchase 2 rows — the only two
                  // barrier configurations in the workspace.
                  const mainOffset = resolvedBarrierOffset(request);
                  const hedgeOffset = resolvedHedgeBarrierOffset(request);
                  return `<mutation has_prediction="false" has_first_barrier="true" has_second_barrier="false"></mutation><field name="BARRIEROFFSETTYPE_LIST">${mainOffset < 0 ? "-" : "+"}</field><field name="HEDGE_BARRIEROFFSETTYPE_LIST">${hedgeOffset < 0 ? "-" : "+"}</field><value name="BARRIEROFFSET">${numberBlock("aiHedgeBarrierOffset", Math.abs(mainOffset))}</value><value name="HEDGE_BARRIEROFFSET">${numberBlock("aiHedgeSecondBarrierOffset", Math.abs(hedgeOffset))}</value>`;
                })()
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
  // Side-choosing archetypes nest their signal branches inside the shared
  // entry condition, so every gate above is evaluated exactly once.
  const branchedAction = (): string | null => {
    if (request.virtual || hedged) return null;
    if (isSwitcher(request)) {
      const [firstSide, secondSide] = dynamicSides(request);
      const primary = purchaseBlock("aiPurchasePrimary", purchaseType);
      const modeIsPrimary = compareValues(
        "aiModeCheck",
        "EQ",
        variablesGet("aiModeCheckGet", "mode"),
        numberBlock("aiModeCheckValue", 0),
      );
      const recoveryMain = markovCondition(request, "aiRecoveryGate");
      const mainPurchase = purchaseBlock("aiPurchaseRecovery", purchaseType);
      // Even/Odd's digit sets partition 0–9, so the opposite side's Markov
      // chance is the complement of the measured one and the recovery can
      // trade whichever parity the transitions favour. Over/Under sets do
      // not partition (the barrier digit loses both ways), so that
      // recovery only buys its configured side when it clears the bar.
      if (request.family === "even-odd") {
        const recoveryOther = compareValues(
          "aiRecoveryOtherGate",
          "LTE",
          variablesGet("aiRecoveryOtherGet", "markov"),
          numberBlock("aiRecoveryOtherBar", 100 - markovThresholdFor(request)),
        );
        const otherPurchase = purchaseBlock(
          "aiPurchaseRecoveryOther",
          purchaseType === firstSide ? secondSide : firstSide,
        );
        return `<block type="controls_if" id="aiModeBranch"><mutation elseif="2"></mutation><value name="IF0">${modeIsPrimary}</value><statement name="DO0">${primary}</statement><value name="IF1">${recoveryMain}</value><statement name="DO1">${mainPurchase}</statement><value name="IF2">${recoveryOther}</value><statement name="DO2">${otherPurchase}</statement></block>`;
      }
      return `<block type="controls_if" id="aiModeBranch"><mutation elseif="1"></mutation><value name="IF0">${modeIsPrimary}</value><statement name="DO0">${primary}</statement><value name="IF1">${recoveryMain}</value><statement name="DO1">${mainPurchase}</statement></block>`;
    }
    if (dynamicEntry(request)) {
      const [firstSide, secondSide] = dynamicSides(request);
      const [firstSignal, secondSignal] = dynamicBranchConditions(request);
      return `<block type="controls_if" id="aiSignalBranch"><mutation elseif="1"></mutation><value name="IF0">${firstSignal}</value><statement name="DO0">${purchaseBlock("aiPurchaseFirst", firstSide)}</statement><value name="IF1">${secondSignal}</value><statement name="DO1">${purchaseBlock("aiPurchaseSecond", secondSide)}</statement></block>`;
    }
    return null;
  };
  const branched = branchedAction();
  const entryIf = `<block type="controls_if" id="aiEntryGate"><value name="IF0">${condition}</value><statement name="DO0">${branched ?? entryAction}</statement></block>`;

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
    const scanFamily =
      request.family === "differs"
        ? "matches"
        : request.family === "higher-lower"
          ? "rise-fall"
          : request.family;
    prelude.push(
      `<block type="signal_lab_scan_markets" id="aiScanMarkets"><field name="FAMILY">${scanFamily}</field><value name="DURATION">${numberBlock("aiScanDuration", 20)}</value><value name="MIN_SCORE">${numberBlock("aiScanMinScore", clamp(numberOr(request.scanMinScore, 0.05), 0, 1))}</value></block>`,
      `<block type="controls_if" id="aiScanSwitch"><value name="IF0"><block type="signal_lab_scan_tradeable" id="aiScanSwitchCheck"></block></value><statement name="DO0"><block type="signal_lab_switch_to_best" id="aiScanSwitchToBest"></block></statement></block>`,
    );
  }
  // The Markov read runs after any market switch, on the market the bot is
  // actually standing on, and before the entry gate reads it.
  if (usesMarkov(request)) prelude.push(markovPrelude(request));
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
  // Switcher mode machine: a loss moves the bot into Markov recovery
  // (mode 1); it stays there until a win returns the session to profit,
  // then reverts to the primary strategy (mode 0).
  const modeStatements: string[] = [];
  if (isSwitcher(request)) {
    const won = `<block type="contract_check_result" id="aiModeResultWin"><field name="CHECK_RESULT">win</field></block>`;
    const recovered = compareValues(
      "aiModeRecovered",
      "GTE",
      `<block type="total_profit" id="aiModeRecoveredProfit"></block>`,
      numberBlock("aiModeRecoveredZero", 0),
    );
    modeStatements.push(
      `<block type="controls_if" id="aiModeUpdate"><mutation else="1"></mutation><value name="IF0">${won}</value><statement name="DO0"><block type="controls_if" id="aiModeRevert"><value name="IF0">${recovered}</value><statement name="DO0">${variablesSet("aiModeRevertSet", "mode", numberValue("aiModeRevertValue", 0))}</statement></block></statement><statement name="ELSE">${variablesSet("aiModeSwitchSet", "mode", numberValue("aiModeSwitchValue", 1))}</statement></block>`,
    );
  }
  const stack = request.virtual
    ? again
    : chainStatements([...modeStatements, ...progressionStatements(request, baseStake), again]);
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
    (family === "rise-fall" || family === "higher-lower") && input.durationUnit === "m"
      ? "m"
      : "t";
  const duration =
    durationUnit === "m"
      ? clamp(Math.round(numberOr(input.duration, 1)), 1, 15)
      : // Higher/Lower is only offered from 5 ticks up: a shorter barrier
        // contract is rejected by Deriv as "Invalid barrier", so the
        // generated strategy never asks for one.
        clamp(Math.round(numberOr(input.duration, 1)), family === "higher-lower" ? 5 : 1, 10);
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
    // The resolved duration is what Trade options will trade, so signal
    // blocks that look `duration` ticks ahead (Markov horizon) read it too.
    duration,
    durationUnit,
    stopAfterLossStreak: resolved.stopAfterLossStreak,
    stopAfterWinStreak: resolved.stopAfterWinStreak,
  };
  const variableKeys: AiVariableKey[] = [];
  if (input.stakingPlan && input.stakingPlan !== "flat") variableKeys.push("stake");
  if (input.stakingPlan === "fibonacci") variableKeys.push("prevStake");
  if (resolved.stopAfterLossStreak) variableKeys.push("lossStreak");
  if (resolved.stopAfterWinStreak) variableKeys.push("winStreak");
  if (usesMarkov(normalized)) variableKeys.push("markov");
  if (isSwitcher(normalized)) variableKeys.push("mode");

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
  // Higher/Lower must be read before Over/Under: both talk about barriers,
  // but only Higher/Lower names the pair (or a side next to "barrier").
  if (
    /\bhigher[\s/-]+(?:and[\s]+)?lower\b/.test(prompt) ||
    /\blower[\s/-]+(?:and[\s]+)?higher\b/.test(prompt) ||
    /\b(?:buy|trade|go)\s+(?:higher|lower)\b/.test(prompt) ||
    /\b(?:higher|lower)\b[^.]{0,40}\bbarrier\b/.test(prompt)
  )
    return "higher-lower";
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

/**
 * The entry-logic shape the description asks for. Order matters: a bot
 * that "switches to Markov after a loss" is a switcher first; "Markov" on
 * its own is the gated Markov bot; "comprehensive" stacks everything.
 */
function readArchetype(description: string): {
  archetype: DbotAiArchetype;
  streakLength?: number;
  streakMode?: "follow" | "fade";
  markovThreshold?: number;
} {
  const prompt = description.toLowerCase();
  const thresholdMatch = prompt.match(
    /\b(?:markov|transition|confidence|probability|chance)\b[^.]*?(\d{2}(?:\.\d+)?)\s*(?:%|percent)/,
  );
  const markovThreshold = thresholdMatch
    ? clamp(Number(thresholdMatch[1]), 1, 99)
    : undefined;
  const streakMatch =
    prompt.match(/\bafter\s+(\d+)\s+(?:\w+\s+){0,2}?(?:in a row|streak|straight)\b/) ??
    prompt.match(/\b(\d+)\s+(?:\w+\s+){0,2}?in a row\b/) ??
    prompt.match(/\bstreak\s+(?:of\s+)?(\d+)\b/) ??
    prompt.match(/\brun\s+of\s+(\d+)\b/);
  const streakLength = streakMatch ? clamp(Number(streakMatch[1]), 2, 10) : undefined;
  const streakMode: "follow" | "fade" | undefined = /\b(fade|against|opposite|reverse|reversal)\b/.test(
    prompt,
  )
    ? "fade"
    : /\b(follow|ride|with the)\b/.test(prompt)
      ? "follow"
      : undefined;
  if (
    /\bswitch\w*/.test(prompt) ||
    /\bafter\s+(?:a\s+)?loss\b[^.]*\b(?:change|move|use)\b/.test(prompt) ||
    /\brecovery\s+(?:mode|strategy|bot)\b/.test(prompt) ||
    /\b(?:revert|switch\s+back|go\s+back)\b[^.]*\b(?:after|when|once)\b/.test(prompt)
  )
    return { archetype: "switcher", markovThreshold };
  if (/\bmarkov\b|\btransition\s+(?:matrix|table|probabilit)/.test(prompt))
    return { archetype: "markov", markovThreshold };
  if (/\bcomprehensive\b|\ball[-\s]?in[-\s]?one\b|\bfull[-\s]?(?:featured|bot|strategy|package)\b|\beverything\b[^.]*\b(?:bot|strategy)\b/.test(prompt))
    return { archetype: "comprehensive", markovThreshold, streakLength, streakMode };
  if (/\bmomentum\b|\btrend[-\s]?follow\w*\b|\bfollow\s+the\s+trend\b/.test(prompt))
    return { archetype: "momentum" };
  if (/\breversal\b|\bmean[-\s]?revert\w*\b|\boverbought\b|\boversold\b/.test(prompt))
    return { archetype: "reversal", streakLength, streakMode: "fade" };
  if (/\bstreak\b|\bin a row\b|\brun\s+of\s+\d+\b|\bconsecutive\s+(?:even|odd|digits?|rises?|falls?)\b/.test(prompt))
    return { archetype: "streak", streakLength, streakMode };
  if (
    /\bai[-\s]?(?:based|powered|driven)\b/.test(prompt) ||
    /\buse\s+(?:the\s+)?ai\b/.test(prompt) ||
    /\bai\s+(?:analysis|decides|chooses|picks|signals?|bot|trading)\b/.test(prompt) ||
    /\bartificial\s+intelligence\b/.test(prompt)
  )
    return { archetype: "ai" };
  return { archetype: "standard" };
}

/**
 * Signed Higher/Lower barrier offsets: "barrier +1.5", "higher at +1 and
 * lower at -2". Per-side values are returned by side; the parse branch
 * assigns them to the main/hedge legs by the traded direction.
 */
function readBarrierOffsets(description: string): {
  higherOffset?: number;
  lowerOffset?: number;
  barrierOffset?: number;
} {
  const prompt = description.toLowerCase();
  const signed = (match: RegExpMatchArray | null) =>
    match ? clamp(Number(match[1].replace(/\s+/g, "")), -10_000, 10_000) : undefined;
  return {
    higherOffset: signed(prompt.match(/\bhigher\b[^.]*?([+-]\s*\d+(?:\.\d+)?)/)),
    lowerOffset: signed(prompt.match(/\blower\b[^.]*?([+-]\s*\d+(?:\.\d+)?)/)),
    barrierOffset: signed(
      prompt.match(/\bbarrier(?:\s+offset)?\s*(?:of|=|:|at|to)?\s*([+-]?\s*\d+(?:\.\d+)?)/) ??
        prompt.match(/\boffset\s*(?:of|=|:|at|to)?\s*([+-]?\s*\d+(?:\.\d+)?)/),
    ),
  };
}

/**
 * Warnings for archetype asks the chosen family/resolution changes —
 * computed from the resolved request, so parse and edits agree.
 */
function archetypeWarnings(request: DbotAiStrategyRequest, description: string): string[] {
  const prompt = description.toLowerCase();
  const warnings: string[] = [];
  const asked = archetypeOf(request);
  const built = effectiveArchetype(request);
  if (asked === "switcher" && built !== "switcher") {
    warnings.push(
      request.virtual
        ? "A strategy switcher needs real contract results, so the paper version trades the primary strategy only."
        : "The strategy switcher was built for Even/Odd or Over/Under (its recovery mode measures digit transitions); this family trades the primary strategy with the standard risk gate instead.",
    );
  }
  if (built === "switcher") {
    warnings.push(
      "Switcher built: the primary strategy trades until a loss, then the bot switches to Markov-transition recovery (mode 1, with the all-markets scan choosing where to stand) and reverts to the primary strategy once the session profit is back at or above zero. Martingale recovery runs alongside.",
    );
    if (/\b(rise|fall)\b/.test(prompt))
      warnings.push(
        "The recovery stays inside this workspace's trade type: one DBot workspace has a single Trade options trade type, so a Rise/Fall recovery leg cannot be bought from an Even/Odd (or Over/Under) bot — the Markov + AI recovery covers that role here. Run a separate Rise/Fall bot alongside if you want both.",
      );
  }
  if (asked === "momentum" && built === "streak")
    warnings.push(
      "Momentum on a digit contract is measured as the digit run: the bot follows a run of same-side digits (the digit equivalent of a price trend).",
    );
  if (asked === "markov" && !usesMarkov(request))
    warnings.push(
      "Markov transition gating measures last-digit probabilities, so it applies to Even/Odd, Over/Under and Matches; this family was built with the standard entry gate.",
    );
  if (asked === "ai" && request.family !== "over-under")
    warnings.push(
      "AI entries here come from the Signal Lab all-markets analysis: every shared market is scored each cycle and the bot trades the strongest one. (The Vision AI entry signal block prices Over/Under barriers, so it is wired automatically when you ask for an AI Over/Under bot.)",
    );
  if (
    request.family === "higher-lower" &&
    request.durationUnit !== "m" &&
    Number.isFinite(request.duration) &&
    Number(request.duration) < 5
  )
    warnings.push(
      "Higher/Lower is only offered from 5 ticks up — Deriv rejects shorter barrier contracts as an invalid barrier — so the duration was set to 5 ticks.",
    );
  return warnings;
}

/** Concepts real users ask for that this mapper cannot build yet — named, never faked. */
function readWarnings(description: string): string[] {
  const prompt = description.toLowerCase();
  const warnings: string[] = [];
  if (/\b(macd|bollinger|stochastic)\b/.test(prompt))
    warnings.push(
      "MACD/Bollinger/Stochastic conditions were not generated — this builder wires the measured blocks it has (RSI for reversal bots, slope for momentum, Markov transitions and runs for digits). After loading, MACD/Bollinger blocks can be added from the DBot toolbox into Purchase conditions; everything else you described is built.",
    );
  if (/\brsi\b/.test(prompt) && !/\b(reversal|overbought|oversold)\b/.test(prompt))
    warnings.push(
      "That custom RSI rule was not generated — the builder wires RSI as the reversal archetype (fade above 70, fade below 30): ask for a \"reversal\" bot to get it. Other RSI blocks live in the DBot toolbox.",
    );
  if (/\b(ema|sma|moving average)\b/.test(prompt))
    warnings.push(
      "Moving-average crossover conditions were not generated; momentum here is measured with the regression-slope block. EMA/SMA blocks live in the DBot Indicators toolbox if you want the crossover version.",
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
  // (Higher/Lower IS generated: barrier offsets land in Trade options for a
  // single purchase, or on the hedge block's two rows when hedging.)
  if (/\btouch/.test(prompt))
    warnings.push(
      "Touch/No Touch is a barrier contract this builder does not generate. In DBot: set the trade type to Touch/No Touch with minutes/hours duration and a barrier offset; the Purchase hedge block carries a barrier offset on each of its Purchase 1 / Purchase 2 rows if you hedge it.",
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
    family === "rise-fall" || family === "higher-lower"
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
    // Higher/Lower defaults to its 5-tick minimum; a shorter named value
    // is floored at 5 by the strategy builder (and warned about).
    duration: ticks ? clamp(Number(ticks[1]), 1, 10) : family === "higher-lower" ? 5 : 1,
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

/** Append the warnings that depend on the fully resolved request. */
function withArchetypeWarnings(
  parsed: ParsedBotDescription,
  description: string,
): ParsedBotDescription {
  return {
    ...parsed,
    warnings: [...parsed.warnings, ...archetypeWarnings(parsed, description)],
  };
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
  const archetypeRead = readArchetype(description);
  const namedFamily = familyFromSignalName(description);
  // A hedge request that names no contract family ("build a hedging bot")
  // still needs one pair of opposite contracts: default to Rise/Fall
  // (CALL + PUT) and say so in the warnings, instead of building nothing.
  // An archetype request ("a Markov bot", "a strategy switcher") likewise
  // implies the family that archetype measures.
  const archetypeFamily: DbotAiFamily | null =
    archetypeRead.archetype === "momentum" || archetypeRead.archetype === "reversal"
      ? "rise-fall"
      : archetypeRead.archetype === "ai"
        ? "over-under"
        : archetypeRead.archetype === "standard"
          ? null
          : "even-odd";
  const family = namedFamily ?? (hedge ? "rise-fall" : archetypeFamily);
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
    archetype: archetypeRead.archetype,
    streakLength: archetypeRead.streakLength,
    streakMode: archetypeRead.streakMode,
    markovThreshold: archetypeRead.markovThreshold,
    scanMarkets:
      /\bscan\s+(?:all|every)\s+markets?\b/.test(prompt) ||
      /\ball[- ]markets?\s+scan\b/.test(prompt) ||
      /\b(?:trade|find|pick|choose)\s+the\s+best\s+market\b/.test(prompt) ||
      /\bbest\s+market\b[^.]*\bscan\b/.test(prompt) ||
      /\banalys\w*\s+(?:all|every)\s+markets?\b/.test(prompt) ||
      // Switchers, comprehensive and AI bots stand on the strongest
      // scanned market by design.
      archetypeRead.archetype === "switcher" ||
      archetypeRead.archetype === "comprehensive" ||
      archetypeRead.archetype === "ai",
    hedge: hedge || undefined,
    hedgeStakePercent,
    virtual: virtual || undefined,
    usedVisionAi:
      (/\bvision\b/.test(prompt) || archetypeRead.archetype === "ai") &&
      family === "over-under",
    warnings: [
      ...readWarnings(description),
      ...(hedge && !namedFamily
        ? [
            "No contract family was named, so this hedges Rise/Fall. Ask for over/under, even/odd or matches hedging to hedge a different pair.",
          ]
        : []),
      ...(!namedFamily && !hedge && archetypeFamily
        ? [
            `No contract family was named, so this ${archetypeRead.archetype} bot was built on ${dbotAiFamilyLabel(archetypeFamily)} — name a family (rise/fall, higher/lower, even/odd, over/under, matches) to build it elsewhere.`,
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
    // The family name itself ("rise/fall bot") names both sides, so pair
    // phrases are stripped before looking for the side the user picked.
    const sidePrompt = prompt.replace(
      /\brise[\s/-]+(?:and[\s]+)?fall\b|\bfall[\s/-]+(?:and[\s]+)?rise\b/g,
      " ",
    );
    const fallAt = sidePrompt.search(/\b(fall|put|bearish|downward|go short)\b/);
    const riseAt = sidePrompt.search(/\b(rise|call|bullish|upward|go long)\b/);
    const direction =
      hedge && riseAt !== -1 && fallAt !== -1
        ? riseAt < fallAt
          ? "RISE"
          : "FALL"
        : fallAt !== -1
          ? "FALL"
          : "RISE";
    return withArchetypeWarnings({ ...shared, direction }, description);
  }
  if (family === "higher-lower") {
    const sidePrompt = prompt.replace(
      /\bhigher[\s/-]+(?:and[\s]+)?lower\b|\blower[\s/-]+(?:and[\s]+)?higher\b/g,
      " ",
    );
    const lowerAt = sidePrompt.search(/\b(lower|put|fall)\b/);
    const higherAt = sidePrompt.search(/\b(higher|call|rise)\b/);
    const direction: DbotAiDirection =
      hedge && higherAt !== -1 && lowerAt !== -1
        ? higherAt < lowerAt
          ? "RISE"
          : "FALL"
        : lowerAt !== -1
          ? "FALL"
          : "RISE";
    const offsets = readBarrierOffsets(description);
    return withArchetypeWarnings(
      {
        ...shared,
        direction,
        barrierOffset:
          direction === "FALL"
            ? (offsets.lowerOffset ?? offsets.barrierOffset)
            : (offsets.higherOffset ?? offsets.barrierOffset),
        hedgeBarrierOffset:
          direction === "FALL" ? offsets.higherOffset : offsets.lowerOffset,
      },
      description,
    );
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
    return withArchetypeWarnings(
      {
        ...shared,
        digitSide:
          /\bunder\b/i.test(prompt) && !/\bover\b/i.test(prompt)
            ? "DIGITUNDER"
            : "DIGITOVER",
        barrier,
      },
      description,
    );
  }
  if (family === "even-odd")
    return withArchetypeWarnings(
      {
        ...shared,
        paritySide:
          /\bodd\b/i.test(prompt) && !/\beven\b/i.test(prompt)
            ? "DIGITODD"
            : "DIGITEVEN",
      },
      description,
    );
  const targetDigit = Number(
    description.match(
      /\b(?:target|digit|match(?:es)?(?:\s+digit)?|differs?(?:\s+(?:from|digit))?)\s*(?:of|is|=|:|to|on|from)?\s*(\d)\b/i,
    )?.[1] ?? 5,
  );
  return withArchetypeWarnings(
    { ...shared, targetDigit: clamp(targetDigit, 0, 9) },
    description,
  );
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
  // "Change the barrier offset" on a Higher/Lower bot mentions the word
  // barrier, which alone would read as Over/Under — a barrier edit is not
  // a family change.
  const barrierEditOnHigherLower =
    previous.family === "higher-lower" &&
    family === "over-under" &&
    /\b(barrier|offset)\b/.test(prompt) &&
    !/\bover\b|\bunder\b/.test(prompt);
  if (family && family !== previous.family && !barrierEditOnHigherLower) {
    const reparsed = parseDbotAiDescription(edit, previous.symbol, previous.currency);
    if (reparsed) return { ...previous, ...reparsed, procedureName: previous.procedureName };
  }
  if (/\b(?:R_\d{1,3}|1HZ\d{1,3}V|volatility|vol\s*\d|v\d{2,3}\b)/i.test(edit)) {
    next.symbol = readMarket(edit, previous.symbol);
    touched = true;
  }
  // "make it a Markov bot", "turn it into a strategy switcher", "use
  // momentum entries": swap the entry-logic shape, keeping the rest.
  const archetypeEdit = readArchetype(edit);
  const wantsSwitcher =
    archetypeEdit.archetype === "switcher" &&
    /\b(strateg\w*|markov|recover\w*|modes?|switcher|loss|revert)\b/.test(prompt);
  if (
    archetypeEdit.archetype !== "standard" &&
    (archetypeEdit.archetype !== "switcher" || wantsSwitcher) &&
    archetypeEdit.archetype !== previous.archetype
  ) {
    next.archetype = archetypeEdit.archetype;
    if (archetypeEdit.streakLength) next.streakLength = archetypeEdit.streakLength;
    if (archetypeEdit.streakMode) next.streakMode = archetypeEdit.streakMode;
    if (archetypeEdit.markovThreshold) next.markovThreshold = archetypeEdit.markovThreshold;
    if (
      archetypeEdit.archetype === "switcher" ||
      archetypeEdit.archetype === "comprehensive" ||
      archetypeEdit.archetype === "ai"
    )
      next.scanMarkets = true;
    next.warnings = [...next.warnings, ...archetypeWarnings(next, edit)];
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
  if (
    (next.family === "rise-fall" || next.family === "higher-lower") &&
    /\b(rise|fall|call|put|higher|lower)\b/.test(prompt)
  ) {
    next.direction = /\b(fall|put|lower)\b/.test(prompt) ? "FALL" : "RISE";
    touched = true;
  }
  if (next.family === "higher-lower" && /\b(barrier|offset)\b/.test(prompt)) {
    const offsets = readBarrierOffsets(edit);
    const main =
      next.direction === "FALL"
        ? (offsets.lowerOffset ?? offsets.barrierOffset)
        : (offsets.higherOffset ?? offsets.barrierOffset);
    const hedgeLeg = next.direction === "FALL" ? offsets.higherOffset : offsets.lowerOffset;
    if (main !== undefined) next.barrierOffset = main;
    if (hedgeLeg !== undefined) next.hedgeBarrierOffset = hedgeLeg;
    if (main !== undefined || hedgeLeg !== undefined) touched = true;
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
  if (request.family === "higher-lower") {
    const main = resolvedBarrierOffset(request);
    if (request.hedge) {
      const higher = request.direction === "FALL" ? resolvedHedgeBarrierOffset(request) : main;
      const lower = request.direction === "FALL" ? main : resolvedHedgeBarrierOffset(request);
      parts.push(
        higher === lower
          ? `barrier ${formatOffset(higher)} on both legs`
          : `Higher ${formatOffset(higher)} / Lower ${formatOffset(lower)}`,
      );
    } else {
      parts.push(`${request.direction === "FALL" ? "Lower" : "Higher"} ${formatOffset(main)}`);
    }
  }
  if (request.family === "over-under")
    parts.push(`${request.digitSide === "DIGITUNDER" ? "Under" : "Over"} ${request.barrier ?? 5}`);
  if (request.family === "even-odd") parts.push(request.paritySide === "DIGITODD" ? "Odd" : "Even");
  if (request.family === "matches") parts.push(`Matches ${request.targetDigit ?? 5}`);
  if (request.family === "differs") parts.push(`Differs from ${request.targetDigit ?? 5}`);
  parts.push(`stake ${request.stake ?? 0.35} ${request.currency ?? "USD"}`);
  // Show the duration that will actually trade: Higher/Lower floors at 5t.
  const displayDuration =
    request.family === "higher-lower" && request.durationUnit !== "m"
      ? Math.max(5, Math.round(numberOr(request.duration, 5)))
      : request.duration;
  parts.push(`${displayDuration}${request.durationUnit === "m" ? "m" : "t"}`);
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
  const archetype = effectiveArchetype(request);
  if (archetype === "markov" && usesMarkov(request))
    parts.push(`Markov-gated (transition chance ≥ ${markovThresholdFor(request)}%)`);
  if (archetype === "streak")
    parts.push(
      `${request.streakMode === "fade" ? "fades" : "follows"} runs of ${request.streakLength ?? 3}`,
    );
  if (archetype === "momentum") parts.push("momentum entries (follows the tick slope)");
  if (archetype === "reversal")
    parts.push(
      request.family === "rise-fall" || request.family === "higher-lower"
        ? "reversal entries (fades RSI extremes)"
        : `reversal entries (fades runs of ${request.streakLength ?? 3})`,
    );
  if (archetype === "switcher")
    parts.push("strategy switcher (primary → Markov + scan recovery after a loss, reverts in profit)");
  if (archetype === "comprehensive")
    parts.push("comprehensive (scan + Markov gate + profit/loss guards)");
  if (archetype === "ai")
    parts.push(
      request.family === "over-under"
        ? "AI-based entries (Vision entry signal)"
        : "AI-based entries (all-markets analysis picks the market)",
    );
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

function formatOffset(offset: number): string {
  return offset < 0 ? String(offset) : `+${offset}`;
}

export function dbotAiFamilyLabel(family: DbotAiFamily): string {
  if (family === "rise-fall") return "Rise/Fall";
  if (family === "higher-lower") return "Higher/Lower";
  if (family === "over-under") return "Over/Under";
  if (family === "even-odd") return "Even/Odd";
  if (family === "differs") return "Differs";
  return "Matches";
}
