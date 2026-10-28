export type DbotAiFamily = "rise-fall" | "over-under" | "even-odd" | "matches";
export type DbotAiDirection = "RISE" | "FALL";
export type DbotAiDigitSide = "DIGITOVER" | "DIGITUNDER";
export type DbotAiParitySide = "DIGITEVEN" | "DIGITODD";
export type DbotAiDurationUnit = "t" | "m";

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
};

export type ParsedBotDescription = DbotAiStrategyRequest & {
  usedVisionAi: boolean;
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

function riskGateDefinition(
  request: Required<
    Pick<
      DbotAiStrategyRequest,
      "procedureName" | "maxTrades" | "lossLimit" | "profitTarget"
    >
  >,
): string {
  const lowerLoss = comparisonBlock(
    "aiGateLoss",
    "GT",
    "total_profit",
    -request.lossLimit,
  );
  const belowTarget = comparisonBlock(
    "aiGateProfit",
    "LT",
    "total_profit",
    request.profitTarget,
  );
  const belowRunLimit = comparisonBlock(
    "aiGateTrades",
    "LT",
    "total_runs",
    request.maxTrades,
  );
  return `<block type="procedures_defreturn" id="aiRiskDefinition" x="24" y="700"><mutation></mutation><field name="NAME">${escapeXml(request.procedureName)}</field><comment pinned="false" h="72" w="260">Custom AI safety block: permits entries only while the session P/L and trade cap remain inside the configured limits.</comment><value name="RETURN"><block type="logic_operation" id="aiGateOuterAnd"><field name="OP">AND</field><value name="A"><block type="logic_operation" id="aiGateInnerAnd"><field name="OP">AND</field><value name="A">${lowerLoss}</value><value name="B">${belowTarget}</value></block></value><value name="B">${belowRunLimit}</value></block></value></block>`;
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
      : request.family === "matches"
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
  const tradeOptions = `<block type="trade_definition_tradeoptions" id="aiTradeOptions"><mutation has_first_barrier="false" has_second_barrier="false" has_prediction="${hasPrediction ? "true" : "false"}"></mutation><field name="DURATIONTYPE_LIST">${durationUnit}</field><field name="CURRENCY_LIST">${escapeXml(currency)}</field><value name="DURATION">${numberBlock("aiDuration", durationValue)}</value><value name="AMOUNT">${numberBlock("aiStake", stake)}</value>${optionPrediction}</block>`;
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
  return "DIGITMATCH";
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

function beforePurchase(
  request: DbotAiStrategyRequest,
  procedureName: string,
): string {
  const purchaseType = selectedPurchase(request);
  const riskGate = `<block type="procedures_callreturn" id="aiEntryGateCall"><mutation name="${escapeXml(procedureName)}"></mutation></block>`;
  // Only strategies built from an analysis have a snapshot to validate. A
  // prompt-built strategy must not contain a gate with an impossible empty key.
  const condition = request.analysisId
    ? `<block type="logic_operation" id="aiEntryConditions"><field name="OP">AND</field><value name="A">${riskGate}</value><value name="B">${analysisGate(request)}</value></block>`
    : riskGate;
  return `<block type="before_purchase" id="aiBeforePurchase" x="24" y="300"><statement name="BEFOREPURCHASE_STACK"><block type="controls_if" id="aiEntryGate"><value name="IF0">${condition}</value><statement name="DO0"><block type="purchase" id="aiPurchase"><field name="PURCHASE_LIST">${purchaseType}</field></block></statement></block></statement></block>`;
}

function afterPurchase(cooldownSeconds: number): string {
  return `<block type="after_purchase" id="aiAfterPurchase" x="700" y="300"><statement name="AFTERPURCHASE_STACK"><block type="timeout" id="aiCooldown"><statement name="TIMEOUTSTACK"><block type="trade_again" id="aiTradeAgain"></block></statement><value name="SECONDS">${numberBlock("aiCooldownSeconds", cooldownSeconds)}</value></block></statement></block>`;
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
  const resolved = { procedureName, maxTrades, lossLimit, profitTarget };
  return `<?xml version="1.0" encoding="UTF-8"?><xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">${tradeRoot(input, duration, durationUnit, stake, currency)}${riskGateDefinition(resolved)}${beforePurchase(input, procedureName)}${afterPurchase(cooldownSeconds)}</xml>`;
}

/** Best-effort family recognition for the local prompt builder. */
export function inferDbotAiFamily(description: string): DbotAiFamily | null {
  const prompt = description.toLowerCase();
  if (/\b(even|odd|parity)\b/.test(prompt)) return "even-odd";
  if (/\b(differs?|digit differs?|not matches?)\b/.test(prompt)) return null;
  if (/\b(matches?|digit match|match digit)\b/.test(prompt)) return "matches";
  if (/\b(over|under|barrier)\b/.test(prompt)) return "over-under";
  if (/\b(rise|fall|call|put|bullish|bearish|upward|downward)\b/.test(prompt))
    return "rise-fall";
  return null;
}

function familyFromSignalName(description: string): DbotAiFamily | null {
  return inferDbotAiFamily(description);
}

function readStake(description: string): number {
  const amount =
    description.match(
      /(?:stake|amount|base stake|bet)\s*(?:of|is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
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
  return market ? cleanSymbol(market) : cleanSymbol(fallback);
}

function readProcedureName(description: string): string {
  const named = description.match(
    /\b(?:block|function)\s+(?:called|named)\s+["“']([^"”']{2,44})["”']/i,
  )?.[1];
  return cleanProcedureName(named);
}

/** Turns a natural-language request into a bounded, reviewable block strategy. */
export function parseDbotAiDescription(
  description: string,
  fallbackMarket = "R_100",
  fallbackCurrency = "USD",
): ParsedBotDescription | null {
  const family = familyFromSignalName(description);
  if (!family) return null;
  const duration = readDuration(description, family);
  const prompt = description.toLowerCase();
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
    usedVisionAi: /\bvision\b/.test(prompt) && family === "over-under",
  };
  if (family === "rise-fall") {
    return {
      ...shared,
      direction: /\b(fall|put|bearish|downward)\b/.test(prompt)
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
      /\b(?:target|digit|match(?:es)?(?:\s+digit)?)\s*(?:of|is|=|:|to|on)?\s*(\d)\b/i,
    )?.[1] ?? 5,
  );
  return { ...shared, targetDigit: clamp(targetDigit, 0, 9) };
}

export function dbotAiFamilyLabel(family: DbotAiFamily): string {
  if (family === "rise-fall") return "Rise/Fall";
  if (family === "over-under") return "Over/Under";
  if (family === "even-odd") return "Even/Odd";
  return "Matches";
}
