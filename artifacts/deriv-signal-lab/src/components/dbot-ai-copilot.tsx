import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleHelp,
  Database,
  Grip,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  Play,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { useDerivTrading } from "@/components/deriv-trading-provider";
import {
  useMarketFeed,
  type MarketFeedEntry,
} from "@/components/market-feed-provider";
import { useSignalScan } from "@/hooks/use-signal-scan";
import { scopeSettlements } from "@/lib/engine-lab/execution";
import {
  DIGIT_SIGNAL_MIN_TICKS,
  type DigitSignalFamily,
} from "@/lib/signal-engine/digit-signal";
import { RISE_FALL_MIN_TICKS } from "@/lib/signal-engine/rise-fall-signal";
import { digitTicksOf } from "@/lib/market-feed";
import { FAMILY_CONTRACTS, type DigitFamily } from "@/lib/digit-signals";
import {
  supportedTickDurations,
  type DigitContractCandidate,
} from "@/lib/digit-analysis";
import { rebaseEntryPlan, type EntryPlan } from "@/lib/signal-engine/entry";
import type {
  ScanFailure,
  ScanMarketJob,
} from "@/lib/signal-engine/scan-runner";
import type { ScanJobResult } from "@/lib/signal-engine/scan-protocol";
import {
  applyDbotAiEdit,
  buildDbotAiStrategyXml,
  dbotAiFamilyLabel,
  describeDbotAiStrategy,
  parseDbotAiDescription,
  type DbotAiAnalysisSnapshot,
  type DbotAiFamily,
  type DbotAiStrategyRequest,
} from "@/lib/dbot-ai";

export type DbotAiBlockInfo = {
  type: string;
  name: string;
  category: string;
  description: string;
};

type DbotAiRunMeta = { family: DbotAiFamily; duration: number; scope: string };
type ChatMessage = { role: "assistant" | "user"; text: string };
type Viewport = { width: number; height: number };
type LauncherPosition = { left: number; top: number };

type DbotAiCopilotProps = {
  ready: boolean;
  accountConnected: boolean;
  accountType: "demo" | "real" | "unknown";
  botRunning: boolean;
  aiRuntimeRegistered: boolean;
  blockRegistry: DbotAiBlockInfo[];
  runNotice: string;
  onClearAnalysis: () => void;
  onLoadStrategy: (xml: string, name: string) => void;
  onLoadAndRun: (
    xml: string,
    name: string,
    analysis: DbotAiAnalysisSnapshot,
  ) => void;
};

const ALL_MARKETS = "all";
const LAUNCHER_STORAGE_KEY = "signal-lab-dbot-ai-launcher-position-v1";
const FAMILY_OPTIONS: Array<{ value: DbotAiFamily; label: string }> = [
  { value: "rise-fall", label: "Rise / Fall" },
  { value: "over-under", label: "Over / Under" },
  { value: "even-odd", label: "Even / Odd" },
  { value: "matches", label: "Matches" },
];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function readLauncherPosition(): LauncherPosition {
  if (typeof window === "undefined") return { left: 720, top: 520 };
  try {
    const stored = window.localStorage.getItem(LAUNCHER_STORAGE_KEY);
    if (stored) {
      const candidate = JSON.parse(stored) as Partial<LauncherPosition>;
      if (Number.isFinite(candidate.left) && Number.isFinite(candidate.top)) {
        return {
          left: clamp(
            Number(candidate.left),
            8,
            Math.max(8, window.innerWidth - 68),
          ),
          top: clamp(
            Number(candidate.top),
            8,
            Math.max(8, window.innerHeight - 80),
          ),
        };
      }
    }
  } catch {
    // Private browsing and malformed local storage use the default position.
  }
  return {
    left: Math.max(12, window.innerWidth - 78),
    top: Math.max(88, window.innerHeight - 168),
  };
}

function currentViewport(): Viewport {
  return typeof window === "undefined"
    ? { width: 1024, height: 768 }
    : { width: window.innerWidth, height: window.innerHeight };
}

function contractsFor(
  entry: MarketFeedEntry,
  family: DigitFamily,
  duration: number,
): { contracts?: DigitContractCandidate[]; skip?: string } {
  if (!entry.contractsLoaded) {
    return {
      skip: entry.contractError || "Waiting for Deriv contract metadata",
    };
  }
  if (!entry.contracts.length) {
    return {
      skip:
        entry.contractError ||
        "No Deriv contracts were returned for this market",
    };
  }
  const supports = entry.contracts.filter(
    (contract) =>
      FAMILY_CONTRACTS[family].includes(contract.contractType) &&
      contract.expiryType.toLowerCase() === "tick",
  );
  if (!supports.length)
    return { skip: "Deriv does not list this contract family for the market" };
  const atDuration = supports.filter((support) =>
    supportedTickDurations(support.minDuration, support.maxDuration).includes(
      duration,
    ),
  );
  if (!atDuration.length)
    return { skip: `${duration} tick expiry is not offered for this family` };
  const contracts: DigitContractCandidate[] = [];
  for (const support of atDuration) {
    if (
      family === "over-under" &&
      (support.contractType === "DIGITOVER" ||
        support.contractType === "DIGITUNDER")
    ) {
      for (const barrier of support.barriers) {
        if (Number.isInteger(barrier) && barrier >= 1 && barrier <= 8)
          contracts.push({
            family,
            contractType: support.contractType,
            barrier,
          });
      }
    } else if (
      family === "even-odd" &&
      (support.contractType === "DIGITEVEN" ||
        support.contractType === "DIGITODD")
    ) {
      contracts.push({ family, contractType: support.contractType });
    } else if (family === "matches" && support.contractType === "DIGITMATCH") {
      for (const targetDigit of support.targets) {
        if (
          Number.isInteger(targetDigit) &&
          targetDigit >= 0 &&
          targetDigit <= 9
        )
          contracts.push({ family, contractType: "DIGITMATCH", targetDigit });
      }
    }
  }
  return contracts.length
    ? { contracts }
    : { skip: "No supported contract was verified in the family range" };
}

function signalOf(result: ScanJobResult) {
  return result.best;
}

function contractLabel(result: ScanJobResult): string {
  return result.kind === "digit" ? result.best.label : result.best.direction;
}

function winProbability(result: ScanJobResult): number {
  return result.kind === "digit"
    ? result.best.probability
    : result.best.winEstimate;
}

function durationLabel(result: ScanJobResult, digitDuration: number): string {
  if (result.kind === "digit")
    return `${digitDuration} ${digitDuration === 1 ? "tick" : "ticks"}`;
  return result.best.horizon.unit === "ticks"
    ? `${result.best.horizon.value} ${result.best.horizon.value === 1 ? "tick" : "ticks"}`
    : `${result.best.horizon.value} ${result.best.horizon.value === 1 ? "minute" : "minutes"}`;
}

function selectedContract(result: ScanJobResult) {
  if (result.kind === "rise-fall") {
    return {
      contractType:
        result.best.direction === "RISE" ? ("CALL" as const) : ("PUT" as const),
      direction: result.best.direction,
      digitSide: undefined,
      paritySide: undefined,
      barrier: undefined,
      targetDigit: undefined,
    };
  }
  const contract = result.best.contract;
  return {
    contractType: contract.contractType,
    direction: undefined,
    digitSide:
      contract.family === "over-under" ? contract.contractType : undefined,
    paritySide:
      contract.family === "even-odd" ? contract.contractType : undefined,
    barrier: contract.family === "over-under" ? contract.barrier : undefined,
    targetDigit:
      contract.family === "matches" ? contract.targetDigit : undefined,
  };
}

function buildAnalysisSnapshot(
  result: ScanJobResult,
  runId: number,
  ranAt: number,
  family: DbotAiFamily,
  digitDuration: number,
  feedEntry: MarketFeedEntry | undefined,
): DbotAiAnalysisSnapshot | null {
  const signal = signalOf(result);
  const action = signal.master.entry.action;
  // The ranked candidate the user selected is ALWAYS loadable. On synthetic
  // indices the precision layer honestly collapses most scans toward zero
  // measured edge, so gating the snapshot on a decisive verdict meant Run
  // Analysis almost never produced a strategy that could trade — the bot
  // loaded, ran, and its entry gate stayed shut forever. The verdict remains
  // on screen with its measured edge; whether to run the strongest candidate
  // anyway is the user's call, confirmed at Load and Run.
  const tradeable = true;
  const familyForStrategy: DbotAiFamily =
    result.kind === "digit" ? result.family : "rise-fall";
  if (familyForStrategy !== family) return null;
  const contract = selectedContract(result);
  const entry: EntryPlan = signal.entry;
  const liveQuote = feedEntry?.ticks.at(-1)?.quote ?? null;
  const rebasedEntry = rebaseEntryPlan(entry, liveQuote);
  const asOfEpoch =
    result.kind === "digit"
      ? result.asOfEpoch
      : (result.lastEpoch ?? feedEntry?.ticks.at(-1)?.epoch ?? 0);
  if (!Number.isFinite(asOfEpoch) || asOfEpoch <= 0) return null;
  const analysisId = [
    runId,
    family,
    result.symbol,
    contract.contractType,
    contract.barrier ?? "",
    contract.targetDigit ?? "",
    digitDuration,
  ].join(":");
  // A no-edge master action carries no timing to wait for; the candidate is
  // entered immediately while the snapshot is fresh (the bot's risk gate and
  // trade caps still apply). Tradeable actions keep their measured trigger.
  const trigger =
    action === "enter-now" || action === "no-edge" ? "immediate" : entry.trigger;
  const contextDigits =
    trigger === "digit" ? [...(entry.contextDigits ?? [])] : [];
  const priceLevel = trigger === "quote" ? rebasedEntry.priceLevel : null;
  const priceCondition =
    trigger === "quote" ? rebasedEntry.priceCondition : null;
  if (
    (action === "enter-on-trigger" && trigger === "immediate") ||
    (trigger === "digit" && contextDigits.length === 0) ||
    (trigger === "quote" && (priceLevel === null || priceCondition === null))
  ) {
    return null;
  }
  const normalizedEntryAction =
    action === "enter-on-trigger" ? "enter-on-trigger" : "enter-now";
  // Floor of 60 ticks for the same reason as validForTicks below: loading the
  // strategy and booting the bot takes real ticks on a 1-second market, and a
  // 3-tick measured window would expire before the first Purchase conditions
  // evaluate. The snapshot's validForTicks still bounds the whole entry.
  const entryWindow = Math.max(
    60,
    Math.min(
      500,
      signal.master.entry.windowTicks,
      Math.max(60, signal.master.validity.ticks),
      entry.windowTicks,
    ),
  );
  const snapshot: DbotAiAnalysisSnapshot = {
    analysisId,
    family,
    symbol: result.symbol,
    contractType: contract.contractType,
    barrier: contract.barrier ?? null,
    targetDigit: contract.targetDigit ?? null,
    generatedAt: ranAt,
    asOfEpoch,
    maxAgeMs: 15 * 60_000,
    validForTicks: Math.max(
      // The measured decay window is the signal's own, but a one-tick entry
      // would close the live gate on the very first tick — before the bot
      // has placed it or run its after-purchase cooldown. A floor keeps the
      // entry alive long enough to trade the measured signal instead of
      // expiring it on arrival.
      60,
      Math.min(500, Math.round(signal.master.validity.ticks)),
    ),
    tradeable,
    entry: {
      action: normalizedEntryAction,
      trigger,
      windowTicks: entryWindow,
      priceLevel,
      priceCondition,
      tolerance: trigger === "quote" ? rebasedEntry.tolerance : null,
      contextDigits,
    },
  };
  return snapshot;
}

function describeAvailableBlocks(blocks: DbotAiBlockInfo[]): string {
  if (!blocks.length)
    return "The DBot workspace registry is still connecting. Open this panel again in a moment to list its live blocks.";
  const categoryCounts = new Map<string, number>();
  for (const block of blocks) {
    categoryCounts.set(
      block.category,
      (categoryCounts.get(block.category) ?? 0) + 1,
    );
  }
  const categories = [...categoryCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
  const preferred = blocks.filter(
    (block) =>
      block.type.startsWith("vision_") ||
      block.type.startsWith("x_ai_") ||
      block.type.startsWith("signal_lab_"),
  );
  const list = preferred
    .slice(0, 10)
    .map((block) =>
      block.description
        ? `${block.name} — ${block.description.slice(0, 90)}`
        : block.name,
    )
    .join("; ");
  return `I can see ${blocks.length} live DBot blocks across ${categories || "the registered categories"}. Vision AI and Signal Lab blocks include: ${list || "none registered yet"}. Ask me to create a named reusable block, for example “create a block called Daily Guard”; Blockly registers that custom procedure when you load the generated strategy.`;
}

function displayVerdict(result: ScanJobResult): string {
  return result.best.master.verdict.replaceAll("_", " ");
}

/** Blocks whose type, name or category matches a plain-language topic. */
function blocksForTopic(blocks: DbotAiBlockInfo[], topic: string): DbotAiBlockInfo[] {
  const needle = topic.toLowerCase().trim();
  const prefixes: Record<string, string[]> = {
    scan: ["signal_lab_scan", "signal_lab_switch", "vision_market", "x_market"],
    hedging: ["signal_lab_hedge"],
    virtual: ["signal_lab_virtual"],
    vision: ["vision_", "x_ai_"],
    ai: ["vision_", "x_ai_"],
    "signal lab": ["signal_lab_"],
    account: ["signal_lab_balance", "signal_lab_account", "signal_lab_open", "signal_lab_profit", "signal_lab_connected"],
    tick: ["signal_lab_last", "signal_lab_tick", "signal_lab_ticks"],
    gate: ["signal_lab_analysis_gate", "signal_lab_gate_reason"],
    analysis: ["signal_lab_analysis_gate", "signal_lab_gate_reason", "vision_analyse", "vision_go"],
  };
  const matched = Object.entries(prefixes).find(([key]) => needle.includes(key));
  if (matched)
    return blocks.filter((block) => matched[1].some((prefix) => block.type.startsWith(prefix)));
  return blocks.filter(
    (block) =>
      block.type.toLowerCase().includes(needle.replace(/\s+/g, "_")) ||
      block.name.toLowerCase().includes(needle) ||
      block.category.toLowerCase().includes(needle),
  );
}

function describeTopicBlocks(blocks: DbotAiBlockInfo[], topic: string): string {
  const found = blocksForTopic(blocks, topic);
  if (!found.length)
    return `I could not find registered blocks matching “${topic}” yet. Ask “show available blocks” for the full registry, or describe the strategy you want and I will build it from the blocks that exist.`;
  const list = found
    .slice(0, 12)
    .map((block) => (block.description ? `${block.name} — ${block.description.slice(0, 110)}` : block.name))
    .join("; ");
  return `${found.length} registered block${found.length === 1 ? "" : "s"} for ${topic}: ${list}${found.length > 12 ? ` …and ${found.length - 12} more in the toolbox.` : ""} Describe a strategy that uses them (for example “scan all markets and trade the best”) and I will wire the blocks for you.`;
}

/**
 * The builder's bot knowledge: strategy patterns, how the workspace runs, and
 * why a bot can look alive yet never trade. Answers are local and factual;
 * anything the builder cannot generate is said plainly (see parse warnings).
 */
function answerBotQuestion(prompt: string): string | null {
  const text = prompt.toLowerCase();
  const asks = /\b(what|how|why|explain|teach|tell me|can you|do you|which|when|help)\b/.test(text) || text.includes("?");
  if (!asks) return null;
  if (/\b(not trading|no trades|never (buys|trades|opens)|won'?t (buy|trade|open)|no positions|not opening|runs but)\b/.test(text))
    return "A bot that runs but never buys is almost always waiting on a condition in Purchase conditions. Check, in order: (1) the Signal Lab analysis gate — print the “Signal Lab gate status” block with a Notify block and it will say exactly what is holding entries (expired analysis, wrong market, waiting for a digit/price trigger); (2) the risk gate procedure — session profit/target or the trade cap may already be hit; (3) Run Analysis again and use Load and Run so the analysis key in the blocks matches the loaded snapshot; (4) account linked and balance above the stake. If the gate status says “ok” and it still does not buy, the Journal tab shows the refused proposal reason from Deriv.";
  if (/\bmartingale\b/.test(text) && !/\breverse|anti\b/.test(text))
    return "Martingale multiplies the stake after every loss (×2 by default) and resets to the base stake after a win, aiming to recover losses with one win. It does not change the odds — long losing streaks make the stake explode — so always pair it with a max stake and a session loss limit. I can build it: try “even bot on R_100, stake 0.35, martingale x2.2, max stake 10, stop loss 5”.";
  if (/\b(reverse|anti)[-\s]?martingale\b/.test(text))
    return "Reverse martingale multiplies the stake after a WIN and resets after a loss, pressing winning streaks instead of chasing losses. One loss wipes the streak's gains, so cap it (max stake / wins-in-a-row stop). Try: “rise bot on R_75, reverse martingale x2, stop after 3 wins in a row”.";
  if (/\bd['’]?alembert\b/.test(text))
    return "D'Alembert moves the stake by a fixed step: up one step after a loss, down one step after a win, never below the base stake. It grows much more slowly than martingale. Try: “over 4 on R_50, stake 0.5, d'Alembert step 0.5”.";
  if (/\bhedg/.test(text))
    return "Hedging here means opening both sides at once (Rise+Fall, or Over+Under on one barrier). The two payouts rarely sum to more than both stakes, so a plain hedge usually locks in a small loss — it only makes sense when one side is priced rich. The Hedging blocks (Signal Lab → Hedging) count open legs/pairs and the open profit so a strategy can balance itself. I can build the two-purchase pattern: “hedge bot, buy both rise and fall on R_100”.";
  if (/\bvirtual|paper\b/.test(text))
    return "Virtual blocks paper-trade: “Virtual trade” records a position at the live quote, “Settle virtual positions” books the win/loss on a 10,000 paper balance, and the profit/runs/wins/balance blocks report the rehearsal. Nothing is sent to Deriv. Ask for a bot “in virtual mode” and I generate the settle-then-buy pattern for you.";
  if (/\bscan\b|\bbest market\b|\ball markets\b/.test(text))
    return "The All markets scan blocks score every volatility market Signal Lab is streaming (rise/fall lean or digit lean over the last N ticks), remember the strongest, and “Switch to the best market from the last scan” moves the running bot onto it so the next Purchase trades there. Try: “scan all markets and trade the best market, even digits, stake 0.5”.";
  if (/\b(analysis gate|gate|signal lab analysis)\b/.test(text))
    return "The Signal Lab AI analysis gate is an entry condition, not an order: it is true only while the exact analysis that built the strategy is still fresh (same market, contract and analysis key, inside its measured entry window and tick validity). Strategies from AI Analysis → Load and Run carry it automatically. The companion “gate status” block explains in one line why the gate is open or closed — print it in the journal when a bot seems to wait forever.";
  if (/\b(stop loss|loss limit|take profit|profit target|risk)\b/.test(text))
    return "Every strategy I build carries a reusable risk-gate procedure: entries stop when session profit falls to the loss limit, reaches the profit target, or the trade cap is hit — plus optional stops after N losses/wins in a row. Say e.g. “stop loss 5, profit target 10, max 30 trades, stop after 3 consecutive losses”. These guard entries; they cannot close a contract that is already open.";
  if (/\b(demo|real|account|balance|connect|link)\b/.test(text))
    return "DBot trades whichever Deriv account is connected in Signal Lab (it auto-links the same account). The account chip at the top of DBot Space shows demo vs real — test every new bot on demo first. Signal Lab account blocks (balance, open positions, realised profit, account id, connected) let a strategy read that same account; orders still go through the normal Purchase block.";
  if (/\b(save|export|download|import|load (a |my )?bot|xml)\b/.test(text))
    return "Use the builder's own save/import controls (toolbar above the canvas) to store a strategy as XML or reload one. Strategies I generate load straight onto the canvas with Load guarded draft; from there you can edit and save them like any hand-built bot.";
  if (/\b(run|start|stop)\b[^.]*\b(bot|strategy)\b/.test(text))
    return "Load a strategy onto the canvas, check the market/stake/limits in the blocks, then press Run in the DBot panel (keep this browser tab open while it runs). AI Analysis → Load and Run does the loading and starting in one step with the analysis gate attached. Stop ends new entries; contracts already open still settle on Deriv.";
  if (/\b(differs|matches|even|odd|over|under|rise|fall)\b/.test(text) && /\b(difference|mean|better|vs|versus)\b/.test(text))
    return "Families: Rise/Fall pays on direction; Over/Under on the last digit vs a barrier 1–8 (equality loses); Even/Odd on digit parity (0 is even); Matches pays ~8–9× when the last digit equals your target; Differs pays a small amount when it does not. Lower payout = higher win rate needed is already priced in — none is 'better', they differ in variance. I can build any of them; AI Analysis measures Rise/Fall, Over/Under, Even/Odd and Matches.";
  if (/\b(what can you|help|capabilit|features|options)\b/.test(text))
    return "Describe a bot in plain words and I build real DBot blocks: Rise/Fall, Over/Under, Even/Odd, Matches and Differs on any volatility market (try “V100 1s”), stake, duration (ticks or minutes for Rise/Fall), stop loss / profit target / trade cap, martingale, reverse martingale or D'Alembert staking with a max stake, stop after N losses/wins in a row, last-digit entry filters (“only buy when last digit is 7”), all-markets scan trading the strongest market, two-sided hedges, virtual/paper mode, cooldowns, and named reusable custom blocks (“create a block called Session Gate”). I also answer questions about blocks — try “scan blocks” or “why is my bot not trading?” — and edit the bot on screen: “make it martingale x3”, “change stake to 1”. Indicator (RSI/MACD) conditions are the one thing I will flag instead of faking.";
  return null;
}

export function DbotAiCopilot({
  ready,
  accountConnected,
  accountType,
  botRunning,
  aiRuntimeRegistered,
  blockRegistry,
  runNotice,
  onClearAnalysis,
  onLoadStrategy,
  onLoadAndRun,
}: DbotAiCopilotProps) {
  const trading = useDerivTrading();
  const feed = useMarketFeed();
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"builder" | "analysis">("builder");
  const [viewport, setViewport] = useState<Viewport>(currentViewport);
  const [position, setPosition] =
    useState<LauncherPosition>(readLauncherPosition);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Describe any bot in plain words — Rise/Fall, Over/Under, Even/Odd, Matches or Differs, with martingale/D'Alembert staking, streak stops, last-digit entry filters, all-markets scan, hedging or virtual mode — and I build the real DBot blocks with a reusable risk gate. Ask “what can you do?”, search blocks (“scan blocks”), or edit the bot on screen (“make it martingale x3”).",
    },
  ]);
  const [builtStrategy, setBuiltStrategy] = useState<{
    xml: string;
    parsed: ReturnType<typeof parseDbotAiDescription>;
    missing: string[];
  } | null>(null);
  const [family, setFamily] = useState<DbotAiFamily>("rise-fall");
  const [scope, setScope] = useState(ALL_MARKETS);
  const [duration, setDuration] = useState(1);
  const [stake, setStake] = useState(0.35);
  const [lossLimit, setLossLimit] = useState(5);
  const [profitTarget, setProfitTarget] = useState(5);
  const [maxTrades, setMaxTrades] = useState(25);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [scanRequestAt, setScanRequestAt] = useState<number | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const draggedRef = useRef(false);
  const requestTimerRef = useRef<number | null>(null);

  const registryTypes = useMemo(
    () => new Set(blockRegistry.map((block) => block.type)),
    [blockRegistry],
  );
  const registryReady =
    blockRegistry.length > 0 &&
    aiRuntimeRegistered &&
    registryTypes.has("signal_lab_analysis_gate");
  const markets = feed.markets;
  const analysis = useSignalScan<ScanJobResult, DbotAiRunMeta>(
    "dbot-ai-analysis",
  );
  const currentRun =
    (scanRequestAt === null || (analysis.run?.ranAt ?? 0) >= scanRequestAt) &&
    analysis.run?.meta.family === family &&
    analysis.run.meta.duration === duration &&
    analysis.run.meta.scope === scope
      ? analysis.run
      : null;
  const currentResult = currentRun
    ? (currentRun.results.find((result) => result.symbol === selectedSymbol) ??
      currentRun.results[0] ??
      null)
    : null;
  const isCurrentBest = Boolean(
    currentRun &&
    currentResult &&
    currentRun.results[0]?.symbol === currentResult.symbol,
  );
  const selectedSignal = currentResult ? signalOf(currentResult) : null;
  const signalTradeable = Boolean(
    selectedSignal &&
    (selectedSignal.master.verdict === "TRADE_NOW" ||
      selectedSignal.master.verdict === "TRADE_ON_ENTRY" ||
      // A speculative signal still carries a measured, positive edge; it is
      // smaller than its error bar, so it is traded at the usual stake rather
      // than size-down, but it is a market the analysis can act on. Only an
      // honest NO_EDGE verdict leaves the strategy without an entry.
      selectedSignal.master.verdict === "SPECULATIVE") &&
    selectedSignal.master.entry.action !== "no-edge",
  );
  const selectedMarket = markets.find(
    (entry) => entry.symbol === currentResult?.symbol,
  );
  const accountReady =
    accountConnected &&
    trading.status === "connected" &&
    Boolean(trading.activeAccount);
  const accountCurrency =
    trading.currency || trading.activeAccount?.currency || "USD";

  useEffect(() => {
    const onResize = () => setViewport(currentViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setPosition((previous) => ({
      left: clamp(previous.left, 8, Math.max(8, viewport.width - 68)),
      top: clamp(previous.top, 8, Math.max(8, viewport.height - 80)),
    }));
  }, [viewport.height, viewport.width]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LAUNCHER_STORAGE_KEY,
        JSON.stringify(position),
      );
    } catch {
      // The launcher remains movable for this session if storage is unavailable.
    }
  }, [position]);

  useEffect(() => {
    if (!loadingRun) return;
    if (
      botRunning ||
      /could not|failed|error|missing|invalid|disconnected/i.test(runNotice)
    ) {
      setLoadingRun(false);
      return;
    }
    if (requestTimerRef.current !== null)
      window.clearTimeout(requestTimerRef.current);
    requestTimerRef.current = window.setTimeout(
      () => setLoadingRun(false),
      15_000,
    );
    return () => {
      if (requestTimerRef.current !== null)
        window.clearTimeout(requestTimerRef.current);
      requestTimerRef.current = null;
    };
  }, [botRunning, loadingRun, runNotice]);

  const panelWidth = Math.min(
    expanded ? 720 : 448,
    Math.max(300, viewport.width - 24),
  );
  const panelHeight = minimized
    ? 60
    : Math.min(expanded ? 790 : 640, Math.max(330, viewport.height - 112));
  const panelLeft = clamp(
    position.left + 58 - panelWidth,
    12,
    Math.max(12, viewport.width - panelWidth - 12),
  );
  const panelTop = clamp(
    position.top - panelHeight - 14,
    12,
    Math.max(12, viewport.height - panelHeight - 86),
  );

  const onLauncherPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: position.left,
        top: position.top,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [position.left, position.top],
  );

  const onLauncherPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (drag.moved) {
        setPosition({
          left: clamp(drag.left + dx, 8, Math.max(8, viewport.width - 68)),
          top: clamp(drag.top + dy, 8, Math.max(8, viewport.height - 80)),
        });
      }
    },
    [viewport.height, viewport.width],
  );

  const onLauncherPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (drag?.pointerId !== event.pointerId) return;
      draggedRef.current = drag.moved;
      dragRef.current = null;
    },
    [],
  );

  function openLauncher() {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    setOpen((previous) => !previous);
    setMinimized(false);
  }

  const runAnalysis = useCallback(async () => {
    if (analysis.scanning) return;
    setScanRequestAt(Date.now());
    if (!botRunning) onClearAnalysis();
    const symbols =
      scope === ALL_MARKETS ? [] : [scope];
    const next = await analysis.start({
      symbols,
      minimumTicks:
        family === "rise-fall" ? RISE_FALL_MIN_TICKS : DIGIT_SIGNAL_MIN_TICKS,
      usableTicks: (entry) =>
        family === "rise-fall"
          ? entry.ticks.length
          : entry.ticks.reduce(
              (count, tick) => count + (tick.digit === null ? 0 : 1),
              0,
            ),
      entryReady: (entry) => family === "rise-fall" || entry.contractsLoaded || Boolean(entry.contractError),
      meta: { family, duration, scope },
      buildJobs: (entries) => {
        const jobs: ScanMarketJob[] = [];
        const skipped: ScanFailure[] = [];
        const usable = entries.filter((entry) =>
          !symbols.length || symbols.includes(entry.symbol),
        );
        for (const entry of usable) {
          if (entry.tradingSuspended === true) {
            skipped.push({
              symbol: entry.symbol,
              name: entry.name,
              message: "trading suspended",
            });
            continue;
          }
          if (family === "rise-fall") {
            if (entry.ticks.length < RISE_FALL_MIN_TICKS) {
              skipped.push({
                symbol: entry.symbol,
                name: entry.name,
                message:
                  entry.error || `only ${entry.ticks.length} ticks loaded`,
              });
              continue;
            }
            jobs.push({
              kind: "rise-fall",
              symbol: entry.symbol,
              name: entry.name,
              input: {
                symbol: entry.symbol,
                name: entry.name,
                ticks: entry.ticks.map(({ epoch, quote }) => ({
                  epoch,
                  quote,
                })),
                digitTicks: digitTicksOf(entry.ticks),
                settlements: scopeSettlements(
                  trading.closedPositions,
                  entry.symbol,
                  "rise-fall",
                  trading.currency,
                ),
                settlementCurrency: trading.currency,
                fresh: entry.fresh,
                marketsInScan: usable.length,
              },
            });
            continue;
          }
          const digitFamily = family as DigitSignalFamily;
          const ticks = digitTicksOf(entry.ticks);
          if (ticks.length < DIGIT_SIGNAL_MIN_TICKS) {
            skipped.push({
              symbol: entry.symbol,
              name: entry.name,
              message:
                entry.error ||
                (entry.ticks.length && !ticks.length
                  ? "digit precision unavailable"
                  : `only ${ticks.length} validated digit ticks`),
            });
            continue;
          }
          const support = contractsFor(
            entry,
            digitFamily as DigitFamily,
            duration,
          );
          if (support.skip) {
            skipped.push({
              symbol: entry.symbol,
              name: entry.name,
              message: support.skip,
            });
            continue;
          }
          jobs.push({
            kind: "digit",
            symbol: entry.symbol,
            name: entry.name,
            input: {
              family: digitFamily,
              symbol: entry.symbol,
              name: entry.name,
              horizon: duration,
              ticks,
              quoteTicks: entry.ticks.map(({ epoch, quote }) => ({
                epoch,
                quote,
              })),
              settlements: scopeSettlements(
                trading.closedPositions,
                entry.symbol,
                digitFamily as DigitFamily,
                trading.currency,
              ),
              settlementCurrency: trading.currency,
              fresh: entry.fresh,
              contracts: support.contracts,
              marketsInScan: usable.length,
            },
          });
        }
        return { jobs, skipped };
      },
    });
    if (next) setSelectedSymbol(next.results[0]?.symbol ?? null);
  }, [
    analysis,
    botRunning,
    duration,
    family,
    feed,
    onClearAnalysis,
    scope,
    trading.closedPositions,
    trading.currency,
  ]);

  function submitBuilderMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = chatInput.trim();
    if (!prompt) return;
    setChatInput("");
    setMessages((previous) => [...previous, { role: "user", text: prompt }]);
    const reply = (text: string) =>
      setMessages((previous) => [...previous, { role: "assistant", text }]);

    // 1) Block-registry questions, including topic searches ("scan blocks").
    const topicBlocks = prompt.match(
      /\b(?:show|list|which|what|find|give me)?\s*(?:the\s+|all\s+)?([a-z][a-z\s]{2,24}?)\s+blocks?\b/i,
    );
    const asksForAllBlocks =
      /\b(show|list|what|which|available|registered)\b[\s\S]*\bblocks?\b/i.test(prompt) &&
      !topicBlocks?.[1]?.trim();
    if (asksForAllBlocks) {
      reply(describeAvailableBlocks(blockRegistry));
      return;
    }
    if (topicBlocks?.[1]?.trim() && /\b(show|list|which|what|find|blocks? for|blocks?)\b/i.test(prompt) && !/\b(build|create|make|generate)\b/i.test(prompt)) {
      reply(describeTopicBlocks(blockRegistry, topicBlocks[1].trim()));
      return;
    }

    // 2) A follow-up edit to the strategy already on screen.
    const finishBuild = (
      parsed: NonNullable<ReturnType<typeof parseDbotAiDescription>>,
      verb: string,
    ) => {
      const xml = buildDbotAiStrategyXml(parsed);
      const types = [
        ...new Set(
          [...xml.matchAll(/<block type="([^"]+)"/g)].map((match) => match[1]),
        ),
      ];
      const missing = blockRegistry.length
        ? types.filter((type) => !registryTypes.has(type))
        : types;
      setBuiltStrategy({ xml, parsed, missing });
      const blockNames = types
        .map(
          (type) =>
            blockRegistry.find((block) => block.type === type)?.name ?? type,
        )
        .join(", ");
      const extra = parsed.usedVisionAi
        ? " The live Vision AI blocks are registered in this workspace; the AI Vision Over/Under bot in the Bot store trades them end-to-end."
        : "";
      const warningText = parsed.warnings.length
        ? ` Not built: ${parsed.warnings.join(" ")}`
        : "";
      const missingNote = missing.length
        ? ` I cannot verify these block registrations yet: ${missing.join(", ")}.`
        : "";
      reply(
        `${verb}: ${describeDbotAiStrategy({ ...parsed, currency: parsed.currency ?? accountCurrency })}. Blocks: ${blockNames}. The reusable “${parsed.procedureName}” procedure guards every entry.${warningText}${extra}${missingNote} Review the blocks before running — and you can keep editing in plain words (“make it martingale x2”, “switch to R_50”). Your prompt stays in this browser; this builder uses a local block mapper, not an external chat API.`,
      );
    };
    if (builtStrategy?.parsed) {
      const edited = applyDbotAiEdit(builtStrategy.parsed, prompt);
      if (edited) {
        finishBuild(edited, "Updated the strategy");
        return;
      }
    }

    // 3) Bot knowledge questions.
    const answer = answerBotQuestion(prompt);
    if (answer) {
      reply(answer);
      return;
    }

    // 4) Build a new strategy from the description.
    const parsed = parseDbotAiDescription(
      prompt,
      selectedMarket?.symbol ?? "R_100",
      accountCurrency,
    );
    if (!parsed) {
      reply(
        "I need a contract family to build from — Rise/Fall, Over/Under, Even/Odd, Matches or Differs. For example: “Build an even bot on R_100, stake 0.5, martingale x2, stop after 3 losses”. Ask “what can you do?” for everything I understand, or “show available blocks” for the live registry.",
      );
      return;
    }
    finishBuild(parsed, "Built a block strategy");
  }

  const resultRequest = useMemo<DbotAiStrategyRequest | null>(() => {
    if (!currentResult || !currentRun || !selectedSignal) return null;
    const contract = selectedContract(currentResult);
    const request: DbotAiStrategyRequest = {
      family,
      symbol: currentResult.symbol,
      currency: accountCurrency,
      duration:
        currentResult.kind === "rise-fall"
          ? currentResult.best.horizon.value
          : duration,
      durationUnit:
        currentResult.kind === "rise-fall" &&
        currentResult.best.horizon.unit === "minutes"
          ? "m"
          : "t",
      stake,
      direction: contract.direction,
      digitSide: contract.digitSide,
      paritySide: contract.paritySide,
      barrier: contract.barrier,
      targetDigit: contract.targetDigit,
      analysisId: [
        currentRun.id,
        family,
        currentResult.symbol,
        contract.contractType,
        contract.barrier ?? "",
        contract.targetDigit ?? "",
        duration,
      ].join(":"),
      procedureName: `${dbotAiFamilyLabel(family)} Analysis Gate`,
      maxTrades,
      lossLimit,
      profitTarget,
      // No post-trade pause: the next entry is evaluated as soon as the
      // previous contract settles, so cadence is set by duration alone.
      cooldownSeconds: 0,
    };
    return request;
  }, [
    accountCurrency,
    currentResult,
    currentRun,
    duration,
    family,
    lossLimit,
    maxTrades,
    profitTarget,
    selectedSignal,
    stake,
  ]);

  const analysisXml = useMemo(
    () => (resultRequest ? buildDbotAiStrategyXml(resultRequest) : ""),
    [resultRequest],
  );
  const selectedAnalysisSnapshot = useMemo(() => {
    if (!currentResult || !currentRun) return null;
    return buildAnalysisSnapshot(
      currentResult,
      currentRun.id,
      currentRun.ranAt,
      family,
      duration,
      selectedMarket,
    );
  }, [currentResult, currentRun, duration, family, selectedMarket]);
  const snapshotReady = Boolean(
    currentResult?.fresh &&
    selectedMarket?.fresh &&
    selectedAnalysisSnapshot &&
    currentRun &&
    Date.now() >= currentRun.ranAt - 60_000 &&
    Date.now() - currentRun.ranAt <= selectedAnalysisSnapshot.maxAgeMs,
  );

  const handleLoadAndRun = useCallback(() => {
    if (
      !currentResult ||
      !currentRun ||
      !analysisXml ||
      !selectedAnalysisSnapshot ||
      !snapshotReady
    )
      return;
    if (
      !ready ||
      !accountReady ||
      botRunning ||
      loadingRun ||
      analysis.scanning ||
      analysis.error
    )
      return;
    if (!registryReady) return;
    // A weak (NO_EDGE) verdict no longer blocks loading — the user decides —
    // but it is named plainly before anything starts, on demo and real alike.
    const weakEdge = !signalTradeable;
    if (weakEdge || accountType === "real") {
      const edgeText = weakEdge
        ? `The master measured no decisive edge on this candidate (${selectedSignal ? `${selectedSignal.master.edgePts >= 0 ? "+" : ""}${selectedSignal.master.edgePts.toFixed(1)} pts` : "unmeasured"}); it is the strongest market from this scan, not a certified edge. `
        : "";
      const accountText =
        accountType === "real"
          ? `This will start ${contractLabel(currentResult)} on ${currentResult.name} using your REAL Deriv account. `
          : `This will start ${contractLabel(currentResult)} on ${currentResult.name}. `;
      if (
        !window.confirm(
          `${edgeText}${accountText}The strategy has a ${lossLimit} loss limit and ${maxTrades} trade cap, but losses are possible. Continue?`,
        )
      )
        return;
    }
    setLoadingRun(true);
    onLoadAndRun(
      analysisXml,
      `AI ${dbotAiFamilyLabel(family)} · ${currentResult.symbol}`,
      selectedAnalysisSnapshot,
    );
  }, [
    accountReady,
    accountType,
    analysis.error,
    analysis.scanning,
    analysisXml,
    botRunning,
    currentResult,
    currentRun,
    family,
    lossLimit,
    loadingRun,
    maxTrades,
    onLoadAndRun,
    ready,
    registryReady,
    selectedAnalysisSnapshot,
    selectedSignal,
    signalTradeable,
    snapshotReady,
  ]);

  // Derive the panel size from the viewport so its edge controls remain reachable
  // above Signal Lab's fixed bottom navigation on mobile.
  const panelStyle = open
    ? {
        left: panelLeft,
        top: panelTop,
        width: panelWidth,
        height: minimized ? 60 : panelHeight,
      }
    : undefined;

  return (
    <>
      {open && (
        <div
          className="fixed z-[80] overflow-hidden rounded-[18px] border border-cyan-300/20 bg-[#07111e]/[.97] text-slate-100 shadow-[0_20px_90px_rgba(0,0,0,.58),0_0_45px_rgba(34,211,238,.09)] backdrop-blur-2xl"
          style={panelStyle}
          role="dialog"
          aria-modal="false"
          aria-label="DBot AI Copilot"
          data-testid="dbot-ai-panel"
        >
          <div className="flex h-[60px] items-center gap-3 border-b border-cyan-100/10 bg-gradient-to-r from-cyan-300/[.10] via-sky-400/[.06] to-violet-400/[.08] px-3.5">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-200/30 bg-cyan-200/[.10] text-cyan-200 shadow-[0_0_22px_rgba(34,211,238,.14)]">
              <BrainCircuit size={19} />
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,.9)]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[.16em]">
                SIGNAL COPILOT{" "}
                <span className="rounded border border-cyan-100/15 px-1 py-0.5 text-[8px] tracking-[.12em] text-cyan-100/60">
                  DBOT AI
                </span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-slate-400">
                {registryReady
                  ? `${blockRegistry.length} registered blocks · runtime verified`
                  : ready
                    ? "Checking the live block registry…"
                    : "Waiting for DBot workspace…"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMinimized((value) => !value)}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white"
              aria-label={minimized ? "Restore AI panel" : "Minimize AI panel"}
              title={minimized ? "Restore" : "Minimize"}
              data-testid="dbot-ai-minimize"
            >
              <Minus size={15} />
            </button>
            {!minimized && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white"
                aria-label={
                  expanded ? "Make AI panel compact" : "Expand AI panel"
                }
                title={expanded ? "Compact" : "Expand"}
                data-testid="dbot-ai-expand"
              >
                {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-400/15 hover:text-rose-200"
              aria-label="Close AI panel"
              data-testid="dbot-ai-close"
            >
              <X size={16} />
            </button>
          </div>
          {!minimized && (
            <>
              <div
                className="flex h-11 items-stretch gap-1 border-b border-white/[.08] px-3 pt-1"
                role="tablist"
                aria-label="AI Copilot tools"
              >
                {(
                  [
                    { id: "builder", label: "Bot Builder", icon: Sparkles },
                    { id: "analysis", label: "AI Analysis", icon: Activity },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === id}
                    onClick={() => setActiveTab(id)}
                    data-testid={`dbot-ai-tab-${id}`}
                    className={`inline-flex items-center gap-2 border-b-2 px-3 text-[11px] font-bold transition ${activeTab === id ? "border-cyan-300 text-cyan-100" : "border-transparent text-slate-500 hover:text-slate-200"}`}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
                <span className="ml-auto inline-flex items-center gap-1 self-center text-[9px] text-slate-500">
                  <Grip size={12} /> drag launcher to move
                </span>
              </div>
              <div className="h-[calc(100%-104px)] overflow-y-auto overscroll-contain p-3.5 sm:p-4">
                {activeTab === "builder" ? (
                  <section
                    className="flex h-full min-h-0 flex-col"
                    data-testid="dbot-ai-builder"
                  >
                    <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-cyan-200/10 bg-cyan-200/[.035] p-3 text-[10px] leading-4 text-slate-400">
                      <CircleHelp
                        size={14}
                        className="mt-0.5 shrink-0 text-cyan-200"
                      />
                      <span>
                        Describe a strategy in natural language. The local
                        builder uses the registered Deriv and Signal Lab blocks,
                        creates a reusable Blockly procedure for risk limits,
                        and keeps unverified contract families out of the
                        analysis.
                      </span>
                    </div>
                    <div
                      className="mb-3 rounded-xl border border-white/[.08] bg-white/[.025] p-3"
                      data-testid="dbot-ai-registry-status"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-slate-200">
                          <Database size={13} className="text-cyan-200" /> Live
                          block registry
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${registryReady ? "bg-emerald-300/10 text-emerald-200" : "bg-amber-300/10 text-amber-200"}`}
                        >
                          {registryReady
                            ? "READY"
                            : ready
                              ? "VERIFYING"
                              : "CONNECTING"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[9px] leading-4 text-slate-500">
                        {blockRegistry.length
                          ? `AI Core: ${blockRegistry.some((block) => block.type === "vision_analyse") ? "registered" : "not found"} · analysis gate: ${registryTypes.has("signal_lab_analysis_gate") ? "registered" : "not found"} · ${blockRegistry.length} block types visible`
                          : "Waiting for the embedded Blockly workspace to report its registered definitions and generators."}
                      </p>
                      {blockRegistry.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer select-none text-[9px] font-semibold text-cyan-200/80">
                            Browse visible AI and Signal Lab blocks
                          </summary>
                          <div className="mt-2 flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                            {blockRegistry
                              .filter(
                                (block) =>
                                  block.type.startsWith("vision_") ||
                                  block.type.startsWith("x_ai_") ||
                                  block.type.startsWith("signal_lab_"),
                              )
                              .slice(0, 28)
                              .map((block) => (
                                <span
                                  key={block.type}
                                  className="rounded-md border border-white/[.08] bg-black/20 px-1.5 py-1 text-[8px] text-slate-400"
                                  title={`${block.type}: ${block.description}`}
                                >
                                  {block.name}
                                </span>
                              ))}
                          </div>
                        </details>
                      )}
                    </div>
                    <div
                      className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1"
                      aria-live="polite"
                      data-testid="dbot-ai-chat-history"
                    >
                      {messages.map((message, index) => (
                        <div
                          key={`${message.role}-${index}`}
                          className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[92%] rounded-2xl px-3 py-2.5 text-[10px] leading-[1.55] ${message.role === "user" ? "rounded-br-md border border-cyan-200/20 bg-cyan-300/[.12] text-cyan-50" : "rounded-bl-md border border-white/[.09] bg-white/[.045] text-slate-300"}`}
                          >
                            {message.text}
                          </div>
                        </div>
                      ))}
                      {builtStrategy && (
                        <div
                          className="rounded-xl border border-emerald-300/20 bg-emerald-300/[.05] p-3"
                          data-testid="dbot-ai-built-strategy"
                        >
                          <div className="flex items-center gap-2 text-[10px] font-extrabold text-emerald-100">
                            <Check size={13} /> Blockly strategy ready ·{" "}
                            {dbotAiFamilyLabel(builtStrategy.parsed!.family)}
                          </div>
                          <div className="mt-1 text-[9px] text-slate-400">
                            {builtStrategy.parsed!.symbol} · stake{" "}
                            {builtStrategy.parsed!.stake}{" "}
                            {builtStrategy.parsed!.currency ?? accountCurrency}{" "}
                            · {builtStrategy.parsed!.duration}
                            {builtStrategy.parsed!.durationUnit === "m"
                              ? "m"
                              : "t"}{" "}
                            · reusable “{builtStrategy.parsed!.procedureName}”
                            block
                          </div>
                          {builtStrategy.missing.length > 0 && (
                            <p className="mt-2 text-[9px] text-amber-200">
                              Registry verification still needs:{" "}
                              {builtStrategy.missing.join(", ")}
                            </p>
                          )}
                          <p className="mt-2 text-[9px] leading-4 text-amber-100/80">
                            Review the draft and its risk limits before running it.
                            Use AI Analysis → Load and Run to start an
                            analysis-gated strategy.
                          </p>
                          <button
                            type="button"
                            disabled={
                              !ready || builtStrategy.missing.length > 0
                            }
                            onClick={() =>
                              onLoadStrategy(
                                builtStrategy.xml,
                                `AI ${dbotAiFamilyLabel(builtStrategy.parsed!.family)} Strategy`,
                              )
                            }
                            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-emerald-200/20 bg-emerald-200/[.10] px-3 py-2 text-[10px] font-bold text-emerald-100 transition hover:bg-emerald-200/[.17] disabled:cursor-not-allowed disabled:opacity-40"
                            data-testid="dbot-ai-load-strategy"
                          >
                            <ArrowDownToLine size={13} /> Load guarded draft
                          </button>
                        </div>
                      )}
                    </div>
                    <form
                      onSubmit={submitBuilderMessage}
                      className="mt-3 flex items-end gap-2 rounded-xl border border-white/10 bg-[#0b1827] p-2 focus-within:border-cyan-200/35"
                    >
                      <textarea
                        value={chatInput}
                        onChange={(event) => setChatInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        rows={2}
                        maxLength={600}
                        aria-label="Describe a DBot strategy"
                        placeholder="e.g. Build a fall bot on R_75, stake 0.5, stop loss 4…"
                        className="max-h-24 min-h-10 flex-1 resize-none bg-transparent px-2 py-1.5 text-[10px] leading-4 text-slate-100 outline-none placeholder:text-slate-600"
                        data-testid="dbot-ai-chat-input"
                      />
                      <button
                        type="submit"
                        disabled={!chatInput.trim()}
                        className="mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-200 text-slate-950 transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label="Send strategy request"
                        data-testid="dbot-ai-chat-send"
                      >
                        <Send size={15} />
                      </button>
                    </form>
                    <p className="mt-2 text-[8px] leading-3 text-slate-600">
                      Local block mapper · no external chat API · review every
                      block and test with a demo account.
                    </p>
                  </section>
                ) : (
                  <section className="space-y-3" data-testid="dbot-ai-analysis">
                    <div className="rounded-xl border border-cyan-200/10 bg-gradient-to-br from-cyan-300/[.07] via-transparent to-violet-300/[.05] p-3.5">
                      <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.15em] text-cyan-100">
                        <Activity size={14} /> Market Analysis
                      </div>
                      <p className="mt-1.5 text-[9px] leading-4 text-slate-400">
                        Choose a Deriv contract family. Signal Lab analyzes the
                        shared live feed and ranks every market; the strongest
                        candidate is always loadable as a DBot strategy, with
                        its measured edge shown so you decide whether to run
                        it.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-[9px] font-bold uppercase tracking-[.08em] text-slate-500">
                        Contract family
                        <select
                          value={family}
                          onChange={(event) => {
                            setFamily(event.target.value as DbotAiFamily);
                            setSelectedSymbol(null);
                          }}
                          disabled={analysis.scanning}
                          className="mt-1.5 h-9 w-full rounded-lg border border-white/10 bg-[#0b1827] px-2 text-[10px] font-semibold normal-case tracking-normal text-slate-100 outline-none focus:border-cyan-200/40"
                          data-testid="dbot-ai-family-select"
                        >
                          {FAMILY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-[9px] font-bold uppercase tracking-[.08em] text-slate-500">
                        Markets
                        <select
                          value={scope}
                          onChange={(event) => {
                            setScope(event.target.value);
                            setSelectedSymbol(null);
                          }}
                          disabled={analysis.scanning}
                          className="mt-1.5 h-9 w-full rounded-lg border border-white/10 bg-[#0b1827] px-2 text-[10px] font-semibold normal-case tracking-normal text-slate-100 outline-none focus:border-cyan-200/40"
                          data-testid="dbot-ai-market-scope"
                        >
                          <option value={ALL_MARKETS}>
                            All {markets.length} volatility markets
                          </option>
                          {markets.map((entry) => (
                            <option key={entry.symbol} value={entry.symbol}>
                              {entry.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {family !== "rise-fall" && (
                        <label className="col-span-2 text-[9px] font-bold uppercase tracking-[.08em] text-slate-500">
                          Digit contract expiry
                          <select
                            value={duration}
                            onChange={(event) =>
                              setDuration(Number(event.target.value))
                            }
                            disabled={analysis.scanning}
                            className="mt-1.5 h-9 w-full rounded-lg border border-white/10 bg-[#0b1827] px-2 text-[10px] font-semibold normal-case tracking-normal text-slate-100 outline-none focus:border-cyan-200/40"
                            data-testid="dbot-ai-duration"
                          >
                            {Array.from(
                              { length: 10 },
                              (_, index) => index + 1,
                            ).map((ticks) => (
                              <option key={ticks} value={ticks}>
                                {ticks} {ticks === 1 ? "tick" : "ticks"}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <label className="text-[8px] font-bold uppercase tracking-[.07em] text-slate-500">
                        Stake · {accountCurrency}
                        <input
                          type="number"
                          min="0.35"
                          max="10"
                          step="0.05"
                          value={stake}
                          onChange={(event) =>
                            setStake(Number(event.target.value) || 0.35)
                          }
                          className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-[#0b1827] px-2 text-[10px] font-semibold text-white outline-none focus:border-cyan-200/40"
                          data-testid="dbot-ai-stake"
                        />
                      </label>
                      <label className="text-[8px] font-bold uppercase tracking-[.07em] text-slate-500">
                        Loss cap · {accountCurrency}
                        <input
                          type="number"
                          min="0.35"
                          max="10000"
                          step="0.5"
                          value={lossLimit}
                          onChange={(event) =>
                            setLossLimit(Number(event.target.value) || 0.35)
                          }
                          className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-[#0b1827] px-2 text-[10px] font-semibold text-white outline-none focus:border-cyan-200/40"
                          data-testid="dbot-ai-loss-limit"
                        />
                      </label>
                      <label className="text-[8px] font-bold uppercase tracking-[.07em] text-slate-500">
                        Profit target · {accountCurrency}
                        <input
                          type="number"
                          min="0.35"
                          max="10000"
                          step="0.5"
                          value={profitTarget}
                          onChange={(event) =>
                            setProfitTarget(Number(event.target.value) || 0.35)
                          }
                          className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-[#0b1827] px-2 text-[10px] font-semibold text-white outline-none focus:border-cyan-200/40"
                          data-testid="dbot-ai-profit-target"
                        />
                      </label>
                      <label className="text-[8px] font-bold uppercase tracking-[.07em] text-slate-500">
                        Trade cap
                        <input
                          type="number"
                          min="1"
                          max="500"
                          step="1"
                          value={maxTrades}
                          onChange={(event) =>
                            setMaxTrades(Number(event.target.value) || 1)
                          }
                          className="mt-1 h-8 w-full rounded-lg border border-white/10 bg-[#0b1827] px-2 text-[10px] font-semibold text-white outline-none focus:border-cyan-200/40"
                          data-testid="dbot-ai-max-trades"
                        />
                      </label>
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[.08] bg-white/[.025] p-2.5">
                      <div className="min-w-0">
                        <div className="text-[9px] font-bold text-slate-200">
                          Live shared feed
                        </div>
                        <div className="mt-0.5 truncate text-[8px] text-slate-500">
                          {feed.freshCount} live · {feed.loadedCount}/
                          {markets.length} histories ready · {feed.status}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (analysis.scanning) analysis.cancel();
                          else void runAnalysis();
                        }}
                        disabled={!markets.length}
                        className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[10px] font-extrabold transition disabled:opacity-40 ${analysis.scanning ? "border border-white/10 bg-white/[.06] text-slate-200" : "bg-cyan-200 text-slate-950 hover:bg-cyan-100"}`}
                        data-testid="dbot-ai-run-analysis"
                      >
                        {analysis.scanning ? (
                          <>
                            <X size={13} /> Stop scan
                          </>
                        ) : (
                          <>
                            <Play size={13} fill="currentColor" /> Run Analysis
                          </>
                        )}
                      </button>
                    </div>
                    {analysis.progress && (
                      <div
                        className="rounded-xl border border-cyan-200/10 bg-cyan-200/[.035] p-3"
                        aria-live="polite"
                        data-testid="dbot-ai-progress"
                      >
                        <div className="flex items-center justify-between gap-2 text-[9px] font-semibold text-slate-300">
                          <span className="flex min-w-0 items-center gap-2">
                            <LoaderCircle
                              size={13}
                              className="shrink-0 animate-spin text-cyan-200"
                            />
                            <span className="truncate">
                              {analysis.progress.stage}
                            </span>
                          </span>
                          <span className="mono shrink-0 text-cyan-100">
                            {Math.round(analysis.progress.percent)}%
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[.08]">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-violet-300 transition-[width]"
                            style={{
                              width: `${clamp(analysis.progress.percent, 1, 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {analysis.error && !analysis.scanning && (
                      <div
                        className="rounded-xl border border-rose-300/15 bg-rose-300/[.05] p-3 text-[9px] leading-4 text-rose-100"
                        role="alert"
                        data-testid="dbot-ai-analysis-error"
                      >
                        {analysis.error}
                      </div>
                    )}
                    {currentRun && currentResult && selectedSignal ? (
                      <>
                        <div
                          className="rounded-xl border border-cyan-200/15 bg-cyan-200/[.045] p-3.5"
                          data-testid="dbot-ai-best-market"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[8px] font-extrabold uppercase tracking-[.15em] text-cyan-200">
                              {isCurrentBest
                                ? "Top ranked market"
                                : "Selected market"}{" "}
                              · {currentRun.marketsScanned} scanned
                            </div>
                            <span
                              className={`rounded-full px-2 py-1 text-[8px] font-bold ${signalTradeable ? "bg-emerald-300/10 text-emerald-200" : "bg-amber-300/10 text-amber-200"}`}
                            >
                              {displayVerdict(currentResult)}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-end justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="truncate text-[15px] font-extrabold text-white">
                                {currentResult.name}
                              </h3>
                              <div className="mt-0.5 text-[10px] font-bold text-cyan-100">
                                {currentResult.symbol} ·{" "}
                                {contractLabel(currentResult)} ·{" "}
                                {durationLabel(currentResult, duration)}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="mono text-xl font-extrabold text-white">
                                {selectedSignal.confidence}%
                              </div>
                              <div className="text-[8px] text-slate-500">
                                signal confidence
                              </div>
                            </div>
                          </div>
                          <p className="mt-2 text-[9px] leading-4 text-slate-400">
                            {selectedSignal.master.headline}
                          </p>
                          <div className="mt-2 grid grid-cols-3 gap-1.5 text-[8px]">
                            <div className="rounded-lg bg-black/20 px-2 py-1.5">
                              <div className="text-slate-600">Win estimate</div>
                              <div className="mono mt-0.5 font-bold text-slate-200">
                                {(100 * winProbability(currentResult)).toFixed(
                                  1,
                                )}
                                %
                              </div>
                            </div>
                            <div className="rounded-lg bg-black/20 px-2 py-1.5">
                              <div className="text-slate-600">Freshness</div>
                              <div className="mt-0.5 font-bold text-slate-200">
                                {currentResult.fresh ? "Live" : "Not live"}
                              </div>
                            </div>
                            <div className="rounded-lg bg-black/20 px-2 py-1.5">
                              <div className="text-slate-600">Master edge</div>
                              <div className="mono mt-0.5 font-bold text-slate-200">
                                {selectedSignal.master.edgePts >= 0 ? "+" : ""}
                                {selectedSignal.master.edgePts.toFixed(1)} pts
                              </div>
                            </div>
                          </div>
                        </div>
                        <div
                          className="space-y-1.5"
                          data-testid="dbot-ai-market-ranking"
                        >
                          <div className="flex items-center justify-between px-0.5">
                            <div className="text-[9px] font-extrabold uppercase tracking-[.12em] text-slate-500">
                              Market ranking
                            </div>
                            <div className="text-[8px] text-slate-600">
                              Select a row to prepare its strategy
                            </div>
                          </div>
                          {currentRun.results
                            .slice(0, 5)
                            .map((result, index) => (
                              <button
                                key={result.symbol}
                                type="button"
                                onClick={() => setSelectedSymbol(result.symbol)}
                                className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition ${result.symbol === currentResult.symbol ? "border-cyan-200/25 bg-cyan-200/[.07]" : "border-white/[.06] bg-white/[.02] hover:border-white/15"}`}
                                data-testid={`dbot-ai-ranked-${result.symbol}`}
                              >
                                <span className="mono flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/[.06] text-[8px] font-extrabold text-slate-400">
                                  {index + 1}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[9px] font-bold text-slate-200">
                                    {result.name}{" "}
                                    <span className="font-normal text-slate-500">
                                      {result.symbol}
                                    </span>
                                  </span>
                                  <span className="mt-0.5 block truncate text-[8px] text-slate-500">
                                    {contractLabel(result)} ·{" "}
                                    {displayVerdict(result)} ·{" "}
                                    {result.best.confidence}%
                                  </span>
                                </span>
                                <ChevronDown
                                  className="-rotate-90 shrink-0 text-slate-600"
                                  size={13}
                                />
                              </button>
                            ))}
                        </div>
                        <div className="rounded-xl border border-amber-200/10 bg-amber-200/[.035] p-3 text-[8px] leading-4 text-slate-400">
                          <div className="mb-1 flex items-center gap-1.5 font-bold text-amber-100">
                            <ShieldAlert size={12} /> Evidence, not a guarantee
                          </div>
                          The strongest ranked candidate can always be loaded —
                          when its measured edge is small the panel says so and
                          Load and Run asks you to confirm. The exact analysis
                          key, market, entry window, session loss cap and run
                          limit are still checked inside the generated DBot
                          blocks on every tick. Synthetic-index outcomes remain
                          uncertain; use a demo account first.
                        </div>
                        {!signalTradeable && (
                          <div
                            className="rounded-lg border border-amber-200/15 bg-amber-200/[.04] px-3 py-2 text-[9px] leading-4 text-amber-100"
                            data-testid="dbot-ai-weak-edge"
                          >
                            Best available candidate: the master measured no
                            decisive edge on this scan (
                            {selectedSignal.master.edgePts >= 0 ? "+" : ""}
                            {selectedSignal.master.edgePts.toFixed(1)} pts).
                            Load and Run still works — it will ask you to
                            confirm, and the strategy keeps its loss cap and
                            trade limit.
                          </div>
                        )}
                        {!accountReady && (
                          <div className="rounded-lg border border-amber-200/15 bg-amber-200/[.04] px-3 py-2 text-[9px] text-amber-100">
                            Link a Deriv account in DBot Space before using Load
                            and Run.
                          </div>
                        )}
                        {runNotice && (
                          <div
                            className="rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-[9px] leading-4 text-slate-300"
                            role="status"
                            data-testid="dbot-ai-run-notice"
                          >
                            {runNotice}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={handleLoadAndRun}
                          disabled={
                            !ready ||
                            !registryReady ||
                            !accountReady ||
                            !snapshotReady ||
                            Boolean(analysis.error) ||
                            botRunning ||
                            loadingRun ||
                            analysis.scanning
                          }
                          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-200 to-sky-200 px-4 text-[11px] font-extrabold text-slate-950 shadow-[0_5px_26px_rgba(34,211,238,.16)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                          data-testid="dbot-ai-load-and-run"
                        >
                          {loadingRun ? (
                            <LoaderCircle size={15} className="animate-spin" />
                          ) : botRunning ? (
                            <Activity size={15} />
                          ) : (
                            <Play size={14} fill="currentColor" />
                          )}
                          {loadingRun
                            ? "Loading strategy…"
                            : botRunning
                              ? "DBot strategy running"
                              : !snapshotReady
                                ? "Run a fresh analysis to load"
                                : "Load and Run"}
                        </button>
                      </>
                    ) : (
                      !analysis.progress && (
                        <div
                          className="rounded-xl border border-dashed border-white/10 bg-white/[.02] px-4 py-7 text-center"
                          data-testid="dbot-ai-analysis-empty"
                        >
                          <Activity
                            size={20}
                            className="mx-auto text-cyan-200/70"
                          />
                          <div className="mt-2 text-[11px] font-bold text-slate-200">
                            Analyze a contract family
                          </div>
                          <p className="mx-auto mt-1 max-w-sm text-[9px] leading-4 text-slate-500">
                            Run the appropriate Signal Lab engine across the
                            selected volatility markets. The strongest market
                            and contract will appear here with a ranked
                            comparison.
                          </p>
                        </div>
                      )
                    )}
                  </section>
                )}
              </div>
            </>
          )}
        </div>
      )}
      <button
        type="button"
        onPointerDown={onLauncherPointerDown}
        onPointerMove={onLauncherPointerMove}
        onPointerUp={onLauncherPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
          draggedRef.current = false;
        }}
        onClick={openLauncher}
        className="fixed z-[81] flex h-[58px] w-[58px] touch-none select-none flex-col items-center justify-center rounded-[20px] border border-cyan-100/35 bg-[#07111e] text-cyan-100 shadow-[0_0_0_1px_rgba(34,211,238,.10),0_0_28px_rgba(34,211,238,.28),0_12px_35px_rgba(0,0,0,.50)] transition hover:scale-[1.04] hover:border-cyan-100/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/70 active:cursor-grabbing"
        style={{
          left: position.left,
          top: position.top,
          cursor: dragRef.current ? "grabbing" : "grab",
        }}
        aria-label={open ? "Close AI Copilot" : "Open AI Copilot"}
        aria-expanded={open}
        title="Drag to move · click to open AI Copilot"
        data-testid="dbot-ai-launcher"
      >
        <span className="pointer-events-none absolute inset-[4px] rounded-[16px] border border-cyan-100/[.08]" />
        <BrainCircuit size={22} strokeWidth={2.1} />
        <span className="mt-0.5 text-[8px] font-black tracking-[.2em]">AI</span>
        <span className="pointer-events-none absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[#07111e] bg-cyan-200 shadow-[0_0_12px_rgba(34,211,238,.95)]" />
      </button>
    </>
  );
}
