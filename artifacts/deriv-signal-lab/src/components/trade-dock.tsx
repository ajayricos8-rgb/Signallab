import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Bot, ChevronDown, ChevronUp, Loader2, Settings2, ShieldCheck, WifiOff, Zap } from 'lucide-react';
import { DerivConnectionStatusBadge } from '@/components/deriv-connection-card';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { SignalBotWindow } from '@/components/signal-bot-window';
import { TradeConfirmationDialog } from '@/components/trade-confirmation-dialog';
import { useSignalBotContext } from '@/components/signal-bot-provider';
import type { SignalBotPlan } from '@/hooks/use-signal-bot';
import {
  DIGIT_TARGETS,
  canApplySignal,
  type TradeRecommendation,
  TRADE_FAMILIES,
  draftBarriers,
  isValidDraftStake,
  type TradeContractType,
  type TradeFamily,
} from '@/lib/trade-draft';
import { barrierFor, formatAmount, type DerivTradeRequest } from '@/lib/deriv-trading';
import {
  SIGNAL_BOT_ENTRY_MODES,
  SIGNAL_BOT_ENTRY_MODE_LABELS,
  SIGNAL_BOT_LIMITS,
  defaultSignalBotConfig,
  maxLadderStake,
  recommendedRuns,
  resolveMaxRuns,
  sanitizeSignalBotConfig,
} from '@/lib/signal-bot/plan.ts';
import type { SignalBotConfig } from '@/lib/signal-bot/types.ts';
import { decideAutoRun, type AutoRunState } from '@/lib/signal-bot/auto.ts';
import { researchAdvisory } from '@/lib/engine-lab/execution';
import type { ResearchFusion } from '@/lib/engine-lab/fusion';
import type { MasterDecision } from '@/lib/signal-engine/master-decision.ts';
import type { ResearchDecision } from '@/lib/engine-lab/types';
import type { SignalStrength } from '@/lib/signal-engine/confidence';
import { describeEntryEvidence, entryModeLabel, isEntryPlan, type EntryPlan } from '@/lib/signal-engine/entry.ts';
import {
  TRADE_DURATION_UNITS,
  draftDurationIssue,
  formatTradeDuration,
  type DurationSupport,
  type TradeDurationUnit,
} from '@/lib/trade-duration';

type MarketChoice = { code: string; name: string };

/** The finished analysis behind `recommendation`; drives the signal bot. */
export type SignalAnalysisBrief = {
  /** Changes whenever a new analysis finishes, so the dock can pop open. */
  runId: number;
  confidence: number;
  strength: SignalStrength;
  marketName: string;
  ranAt: number;
  /** Entry the analysis planned for this signal (point/level + time window). */
  entry?: EntryPlan | null;
  researchDecision?: ResearchDecision | null;
  /** What the 300-engine library contributed to this signal's probability. */
  research?: ResearchFusion | null;
  /** Layer 6 decision that travels with the signal (validity + verdict). */
  master?: MasterDecision | null;
  /** Layer-3 verdict the bot page shows next to the loaded signal. */
  confirmation?: {
    status: 'confirmed' | 'adjusted' | 'cautious' | 'contradicted';
    edgePts: number;
    decisive: boolean;
  } | null;
};

type TradeDockProps = {
  /** Latest finished signal; "Use signal" copies it into the draft only. */
  recommendation?: TradeRecommendation | null;
  /** Increment to apply `recommendation` from outside (e.g. the signal card). */
  applyRequest?: number;
  family: TradeFamily;
  marketCode: string | null;
  marketName: string | null;
  // Rise/Fall has a manual draft market; digit panels use their existing market picker.
  marketChoices?: readonly MarketChoice[];
  onMarketChange?: (code: string) => void;
  /** Research / tick expiry in ticks. Time-based trade durations are kept separate. */
  expiry: number | null;
  expiryOptions: number[];
  onExpiryChange: (ticks: number | null) => void;
  expiryVerified: boolean;
  /** Deriv-reported contract support for the selected market, when available. */
  contracts?: readonly DurationSupport[];
  /** Finished analysis for `recommendation`; enables Load and Run. */
  analysis?: SignalAnalysisBrief | null;
};

const fieldClass =
  'flex min-w-0 flex-col gap-1 text-[10px] font-bold uppercase tracking-[0.04em] text-slate-300 lg:flex-1';
const controlClass =
  'h-9 w-full min-w-0 rounded-lg border border-[#385677] bg-[#162f50] px-2 text-xs font-semibold normal-case tracking-normal text-white outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-300/35 disabled:cursor-not-allowed disabled:opacity-60';

const COLLAPSED_KEY = 'signal-lab-trade-dock-collapsed';
const BOT_CONFIG_KEY = 'signal-lab-signal-bot-config';
/** Auto is a switch, not a stake setting, so it is stored on its own. */
const AUTO_KEY = 'signal-lab-signal-bot-auto';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Auto starts off: a fresh browser never trades without a deliberate click. */
function readAuto(): boolean {
  try {
    return window.localStorage.getItem(AUTO_KEY) === '1';
  } catch {
    return false;
  }
}

function readBotConfig(): SignalBotConfig {
  try {
    const stored = window.localStorage.getItem(BOT_CONFIG_KEY);
    return sanitizeSignalBotConfig(stored ? (JSON.parse(stored) as Partial<SignalBotConfig>) : null);
  } catch {
    return defaultSignalBotConfig();
  }
}

/** Compact numeric field for the bot row of the dock. */
function BotNumberField({
  label,
  value,
  min,
  max,
  step,
  hint,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint?: string;
  testId: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[10px] font-bold uppercase tracking-[0.04em] text-slate-300">
      {label}
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : min);
        }}
        className={controlClass}
        data-testid={testId}
        title={hint}
      />
    </label>
  );
}

export function TradeDock({
  recommendation,
  applyRequest = 0,
  family,
  marketCode,
  marketName,
  marketChoices,
  onMarketChange,
  expiry,
  expiryOptions,
  onExpiryChange,
  expiryVerified,
  contracts,
  analysis = null,
}: TradeDockProps) {
  const trading = useDerivTrading();
  const signalBot = useSignalBotContext();
  const bot = signalBot.bot;
  const [contractType, setContractType] = useState<TradeContractType>(
    TRADE_FAMILIES[family].contracts[0].value,
  );
  const [barrier, setBarrier] = useState(0);
  const [targetDigit, setTargetDigit] = useState(0);
  const [stake, setStake] = useState('1.00');
  const [stakeTouched, setStakeTouched] = useState(false);
  const [ticketIssue, setTicketIssue] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [durationUnit, setDurationUnit] = useState<TradeDurationUnit>('t');
  const [timeDurationText, setTimeDurationText] = useState('');
  const [botConfig, setBotConfig] = useState<SignalBotConfig>(readBotConfig);
  const [botSpeed, setBotSpeed] = useState<'fast' | 'normal'>('normal');
  // Auto: start Load and Run by itself as soon as a signal is generated.
  const [autoRun, setAutoRun] = useState<boolean>(readAuto);
  const [autoNotice, setAutoNotice] = useState<{ state: AutoRunState; note: string } | null>(null);
  const titleId = useId();
  const noteId = useId();
  const bodyId = useId();
  const barriers = draftBarriers(contractType);
  const stakeValid = isValidDraftStake(stake);
  const selectedContract =
    TRADE_FAMILIES[family].contracts.find(({ value }) => value === contractType)
      ?.label ?? '—';
  const contractLabel =
    family === 'over-under'
      ? `${selectedContract} ${barrier}`
      : family === 'matches'
        ? `Matches ${targetDigit}`
        : selectedContract;

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // Keep the toggle state in memory when storage is unavailable.
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(BOT_CONFIG_KEY, JSON.stringify(botConfig));
    } catch {
      // Storage is optional; the configuration is still held in memory.
    }
  }, [botConfig]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_KEY, autoRun ? '1' : '0');
    } catch {
      // Storage is optional; the switch is still held in memory.
    }
  }, [autoRun]);

  const timeDuration = /^\d+$/.test(timeDurationText.trim())
    ? Number(timeDurationText.trim())
    : null;
  const tickDurationValid = expiry !== null && expiryOptions.includes(expiry);
  const durationIssue =
    durationUnit === 't'
      ? tickDurationValid
        ? draftDurationIssue(expiry, 't', contractType, contracts, expiryVerified)
        : ''
      : draftDurationIssue(timeDuration, durationUnit, contractType, contracts, expiryVerified);
  const tradeDuration = durationUnit === 't' ? (tickDurationValid ? expiry : null) : timeDuration;
  const selectedDurationLabel =
    tradeDuration !== null && !durationIssue
      ? formatTradeDuration(tradeDuration, durationUnit)
      : 'Not selected';
  const connected = trading.status === 'connected';
  const currency = trading.currency || trading.activeAccount?.currency || '';
  const stakeValue = stakeValid ? Number(stake.trim()) : null;

  const tradeRequest = useMemo<DerivTradeRequest | null>(() => {
    if (!marketCode || stakeValue === null || tradeDuration === null || durationIssue) return null;
    return {
      contractType,
      symbol: marketCode,
      currency,
      stake: stakeValue,
      duration: tradeDuration,
      durationUnit,
      barrier: barrierFor(
        contractType,
        family === 'over-under' ? barrier : family === 'matches' ? targetDigit : null,
      ),
    };
  }, [
    barrier,
    contractType,
    currency,
    durationIssue,
    durationUnit,
    family,
    marketCode,
    stakeValue,
    targetDigit,
    tradeDuration,
  ]);

  const sameMarket = Boolean(recommendation && recommendation.symbol === marketCode);
  const canUseAnalysis = canApplySignal(recommendation, family, expiryOptions)
    && (sameMarket || Boolean(onMarketChange))
    && !(sameMarket && recommendation.durationUnit === 't' && draftDurationIssue(recommendation.duration, 't', recommendation.contractType, contracts, expiryVerified));
  const recommendationTitle = recommendation
    ? `Copy ${recommendation.label ?? recommendation.contractType} · ${formatTradeDuration(recommendation.duration, recommendation.durationUnit)} on ${recommendation.symbol} into the ticket. No order is placed.`
    : '';

  // The signal the bot would trade: market, contract, tick duration and entry
  // all come from the analysis, never from the manual draft. A loaded signal
  // whose entry did not come out of the engine run is not tradeable.
  const loadedEntry = analysis?.entry ?? null;
  const analysisEntryReady = isEntryPlan(loadedEntry);
  const botPlan = useMemo<SignalBotPlan | null>(() => {
    if (!recommendation || !canApplySignal(recommendation, family, expiryOptions)) return null;
    if (!analysisEntryReady) return null;
    const confidence = analysis?.confidence ?? 0;
    const strength = analysis?.strength ?? 'WEAK';
    return {
      family,
      symbol: recommendation.symbol,
      marketName: analysis?.marketName ?? marketName ?? recommendation.symbol,
      contractType: recommendation.contractType,
      barrierDigit: recommendation.barrier ?? null,
      duration: recommendation.duration,
      durationUnit: recommendation.durationUnit,
      label: recommendation.label ?? recommendation.contractType,
      contractLabel: `${recommendation.label ?? recommendation.contractType} · ${formatTradeDuration(recommendation.duration, recommendation.durationUnit)}`,
      confidence,
      strength,
      recommendedRuns: recommendedRuns({ confidence, strength }),
      entry: loadedEntry,
      researchDecision: analysis?.researchDecision ?? null,
      research: analysis?.research ?? null,
      ranAt: analysis?.ranAt ?? 0,
      confirmation: analysis?.confirmation ?? null,
      master: analysis?.master ?? null,
    };
  }, [analysis, analysisEntryReady, expiryOptions, family, loadedEntry, marketName, recommendation]);

  // Advice only: the research library never blocks Load and Run any more. The
  // bot trades the signal the analysis produced; warnings travel with the run.
  const botResearchNote = botPlan ? researchAdvisory(botPlan.researchDecision) : null;
  const botRuns = botPlan ? resolveMaxRuns(botConfig, botPlan.recommendedRuns) : 0;
  // The bot always waits for the analysis entry; immediate is the analysis's own
  // conclusion that there is no timing edge to wait for.
  const botEntryWaits = Boolean(botPlan && botPlan.entry.trigger !== 'immediate');
  // A finished signal whose analysis has no engine entry (restored, older runs).
  const analysisEntryMissing = Boolean(recommendation && canApplySignal(recommendation, family, expiryOptions) && !analysisEntryReady);
  const ladderTop = maxLadderStake({ ...botConfig, baseStake: stakeValue ?? botConfig.baseStake });
  // The two take profit targets, phrased for the dock's warning line.
  const takeProfitTargets = [
    botConfig.takeProfitWins > 0
      ? `${botConfig.takeProfitWins} winning run${botConfig.takeProfitWins === 1 ? '' : 's'}`
      : '',
    botConfig.takeProfitAmount > 0
      ? `${formatAmount(botConfig.takeProfitAmount, currency)} realised profit`
      : '',
  ].filter(Boolean);
  // What Auto is doing right now, shown under the bot settings. With the switch
  // off the line disappears and Load and Run is a manual button again.
  const autoNoticeText = autoRun
    ? autoNotice?.note ?? 'Auto is on — Run Analysis starts the bot the moment a signal is generated.'
    : '';
  const autoNoticeTone = autoNotice?.state === 'started'
    ? 'text-emerald-200'
    : autoNotice?.state === 'idle'
      ? 'text-slate-300'
      : autoNotice && autoNotice.state !== 'armed'
        ? 'text-amber-200'
        : 'text-sky-200';

  // A finished analysis pops the dock open so Load and Run is reachable.
  const lastAnalysisRunId = useRef(analysis?.runId ?? 0);
  useEffect(() => {
    const runId = analysis?.runId ?? 0;
    if (runId === 0 || runId === lastAnalysisRunId.current) return;
    lastAnalysisRunId.current = runId;
    if (botPlan) setCollapsed(false);
  }, [analysis, botPlan]);

  // The signal Auto has already acted on. Seeded with whatever signal was on
  // screen when the dock mounted, so a run restored from the feed's memory is
  // never re-traded: Auto only fires on a signal generated after it was armed.
  const autoHandoffRunId = useRef<number>(analysis?.runId ?? 0);

  // Auto hands a freshly generated signal straight to Load and Run. The rule
  // itself is pure (`decideAutoRun`); this effect only supplies the facts and
  // performs the handoff once per signal id, so a re-render, a settings change
  // or a tab switch can never start a second run on the same signal.
  useEffect(() => {
    if (!autoRun) {
      setAutoNotice(null);
      return;
    }
    const runId = analysis?.runId ?? 0;
    // The user pressed Load and Run on this very signal while Auto is on: the
    // bot is already trading it, so there is nothing to hand over and nothing
    // to warn about.
    const alreadyTradingThisSignal = bot.running
      && Boolean(bot.plan && analysis?.ranAt && bot.plan.ranAt === analysis.ranAt);
    if (alreadyTradingThisSignal) {
      if (runId > 0) autoHandoffRunId.current = runId;
      return;
    }
    const decision = decideAutoRun({
      enabled: autoRun,
      runId,
      handoffRunId: autoHandoffRunId.current,
      planReady: Boolean(botPlan),
      entryReady: analysisEntryReady,
      botRunning: bot.running,
      connected,
      stakeValid,
      analysisAgeMs: analysis?.ranAt ? Date.now() - analysis.ranAt : null,
      validityMs: botPlan?.master?.validity.ms ?? null,
    });
    if (decision.handoff) autoHandoffRunId.current = runId;
    // Keep the last meaningful message: once a signal is handled the rule
    // reports 'idle', which must not overwrite "Auto started the bot…".
    // The updater is idempotent so a feed tick cannot churn the render.
    if (decision.state !== 'idle') {
      setAutoNotice((current) =>
        current && current.state === decision.state && current.note === decision.note
          ? current
          : { state: decision.state, note: decision.note },
      );
    }
    if (!decision.start || !botPlan || stakeValue === null) return;
    setTicketIssue('');
    setCollapsed(false);
    signalBot.loadAndRun(botPlan, { ...botConfig, baseStake: stakeValue }, botSpeed);
    // Keyed on the facts the rule reads. `botPlan` is rebuilt on every render,
    // but the runId handoff above makes the start idempotent.
  }, [analysis, analysisEntryReady, autoRun, bot.plan, bot.running, botSpeed, botConfig, botPlan, connected, signalBot, stakeValid, stakeValue]);

  /**
   * Auto is armed for the NEXT signal. Switching it on records the signal
   * already on screen as handled, so flipping the switch never trades the
   * analysis the user is looking at — only a new one generated afterwards.
   */
  function handleAutoToggle() {
    const next = !autoRun;
    if (next) autoHandoffRunId.current = analysis?.runId ?? 0;
    setAutoRun(next);
    setAutoNotice(null);
    setTicketIssue('');
  }

  function handleLoadAndRun() {
    if (!botPlan) {
      setTicketIssue(
        analysisEntryMissing
          ? 'This signal has no entry from the engine analysis. Run Analysis again so the bot can load a planned entry.'
          : 'Run Analysis to generate a signal before loading the bot.',
      );
      return;
    }
    if (!connected) {
      setTicketIssue('Connect your Deriv account before running the bot.');
      return;
    }
    if (stakeValue === null) {
      setStakeTouched(true);
      setTicketIssue('Enter a positive stake with up to 2 decimal places.');
      return;
    }
    setTicketIssue('');
    setCollapsed(false);
    signalBot.loadAndRun(botPlan, { ...botConfig, baseStake: stakeValue }, botSpeed);
  }

  function applyAnalysis() {
    if (!canUseAnalysis || !recommendation) return;
    if (recommendation.symbol !== marketCode) onMarketChange?.(recommendation.symbol);
    setContractType(recommendation.contractType);
    if (family === 'over-under' && recommendation.barrier !== undefined) setBarrier(recommendation.barrier);
    if (family === 'matches' && recommendation.barrier !== undefined) setTargetDigit(recommendation.barrier);
    if (recommendation.durationUnit === 't') {
      setDurationUnit('t');
      onExpiryChange(recommendation.duration);
    } else {
      setDurationUnit(recommendation.durationUnit);
      setTimeDurationText(String(recommendation.duration));
    }
    setTicketIssue('');
    setDialogOpen(false);
    setCollapsed(false);
  }

  // External "Use signal" requests (from the signal card) apply the latest
  // recommendation once per increment.
  const handledApplyRequest = useRef(applyRequest);
  useEffect(() => {
    if (applyRequest === handledApplyRequest.current) return;
    handledApplyRequest.current = applyRequest;
    applyAnalysis();
  });

  function handleContractChange(value: TradeContractType) {
    setContractType(value);
    setTicketIssue('');
    setDialogOpen(false);
    const validBarriers = draftBarriers(value);
    if (validBarriers.length && !validBarriers.includes(barrier))
      setBarrier(validBarriers[0]);
  }

  function handleUnitChange(unit: TradeDurationUnit) {
    setDurationUnit(unit);
    setTicketIssue('');
    setDialogOpen(false);
  }

  function handleTradeClick(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStakeTouched(true);
    if (!stakeValid) {
      setTicketIssue('Enter a positive stake with up to 2 decimal places.');
      return;
    }
    if (!marketCode) {
      setTicketIssue('Choose a market before trading.');
      return;
    }
    if (durationUnit === 't' && !tickDurationValid) {
      setTicketIssue('Choose a tick expiry reported by Deriv for this contract.');
      return;
    }
    if (durationIssue) {
      setTicketIssue(durationIssue);
      return;
    }
    if (tradeDuration === null) {
      setTicketIssue('Enter a positive whole-number duration.');
      return;
    }
    setTicketIssue('');
    setDialogOpen(true);
  }

  // Proposal IDs are short-lived, so the dialog requests a fresh quote every
  // time it opens instead of reusing the one it held before it closed.
  function closeDialog(open: boolean) {
    setDialogOpen(open);
  }

  return createPortal(
    <>
      {/* The bot page and the trade menu share one bottom-anchored stack, so
          the bot page always sits directly above the ticket it trades. */}
      <div
        className="pointer-events-none fixed inset-x-0 z-[25] flex flex-col overflow-y-auto md:left-[254px]"
        // Workspace navigation: 48px minimum button + 16px padding + 1px border.
        style={{
          bottom: 'calc(65px + env(safe-area-inset-bottom))',
          maxHeight: 'calc(100dvh - 65px - env(safe-area-inset-bottom))',
        }}
      >
        {signalBot.open && (
          <div className="mx-auto mb-2 w-full max-w-[1500px] px-3 sm:px-6 lg:px-8">
            <SignalBotWindow
              bot={bot}
              family={bot.plan?.family ?? family}
              currency={signalBot.currency || currency}
              expanded={signalBot.expanded}
              onExpandedChange={signalBot.setExpanded}
              onClose={signalBot.hide}
            />
          </div>
        )}
        <section
          className="trade-dock pointer-events-auto w-full border-t border-[#345576] bg-[#0b2140] text-slate-50 shadow-[0_-16px_40px_rgba(3,12,29,0.32)]"
          aria-labelledby={titleId}
          data-testid={`trade-dock-${family}`}
          data-collapsed={collapsed ? 'true' : 'false'}
        >
          <div className={`mx-auto w-full max-w-[1500px] px-4 ${collapsed ? 'py-2' : 'py-3'} sm:px-6 lg:px-8`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-300/10 text-sky-200">
              <Settings2 size={15} />
            </span>
            <h3
              id={titleId}
              className="text-xs font-bold tracking-tight sm:text-sm"
            >
              <span className="sm:hidden">Trade setup</span>
              <span className="hidden sm:inline">Trading configuration</span>
              <span className="ml-1 font-medium text-slate-300">
                · {TRADE_FAMILIES[family].label}
              </span>
            </h3>
            {collapsed && (
              <span className="hidden truncate text-[11px] font-medium text-slate-300 sm:inline">
                {contractLabel} · {selectedDurationLabel}
              </span>
            )}
            <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
              {canUseAnalysis && recommendation && <button
                type="button" onClick={applyAnalysis} data-testid="trade-use-analysis"
                title={recommendationTitle}
                className="focus-ring rounded-lg border border-sky-300/50 bg-sky-300/10 px-2.5 py-2 text-[11px] font-bold text-sky-200"
              >Use signal{recommendation.label ? ` · ${recommendation.label}` : ''}</button>}
              <button
                type="button"
                onClick={handleAutoToggle}
                aria-pressed={autoRun}
                title={
                  autoRun
                    ? 'Auto is on: the bot starts by itself the moment Run Analysis produces a signal. Turn it off to start Load and Run manually.'
                    : 'Auto is off: you start Load and Run yourself. Turn it on and the next analysis starts the bot automatically.'
                }
                className={`focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-bold transition-colors ${
                  autoRun
                    ? 'border-emerald-300/60 bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/25'
                    : 'border-[#385677] bg-[#162f50] text-slate-300 hover:border-sky-300/60 hover:text-white'
                }`}
                data-testid={`button-bot-auto-${family}`}
              >
                <Zap size={12} />
                <span className="hidden sm:inline">Auto {autoRun ? 'on' : 'off'}</span>
                <span className="sm:hidden">Auto</span>
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${autoRun ? 'bg-emerald-300' : 'bg-slate-500'}`}
                />
              </button>
              {botPlan && (
                <>
                <div className="inline-flex h-8 items-center rounded-lg border border-[#385677] bg-[#162f50] p-0.5" role="group" aria-label="Bot execution speed">
                  {(['normal', 'fast'] as const).map((speed) => (
                    <button key={speed} type="button" onClick={() => setBotSpeed(speed)} aria-pressed={botSpeed === speed}
                      className={`h-7 rounded-md px-2 text-[10px] font-bold capitalize transition-colors ${botSpeed === speed ? 'bg-sky-300 text-[#08233c]' : 'text-slate-300 hover:text-white'}`}
                      title={speed === 'fast' ? 'Reduce local polling and between-run delay; network and Deriv execution latency still apply.' : 'Standard polling and run spacing.'}>{speed}</button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleLoadAndRun}
                  disabled={bot.running || !stakeValid}
                  title={
                    bot.running
                      ? 'The bot is trading this signal. Press Stop on the bot page to end the run.'
                      : `Buy ${botPlan.contractLabel} on ${botPlan.symbol} for ${botRuns} run${botRuns === 1 ? '' : 's'}, one contract at a time, ${entryModeLabel(botPlan.entry).toLowerCase()}.`
                  }
                  className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-400 px-2.5 text-[11px] font-extrabold text-[#052e1e] transition-colors hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-55"
                  data-testid={`button-load-and-run-${family}`}
                >
                  {bot.running ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}
                  {bot.running ? 'Running…' : 'Load and Run'}
                </button>
                </>
              )}
              {bot.hasActivity && !signalBot.open && (
                <button
                  type="button"
                  onClick={() => {
                    signalBot.show();
                    setCollapsed(false);
                  }}
                  title="Reopen the bot page"
                  className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-emerald-300/50 bg-emerald-300/10 px-2.5 text-[11px] font-bold text-emerald-200"
                  data-testid={`button-show-bot-${family}`}
                >
                  <Bot size={13} />
                  Bot {bot.summary.started}/{bot.targetRuns}
                </button>
              )}
              <DerivConnectionStatusBadge compact variant="dock" />
              <button
                type="button"
                onClick={() => setCollapsed((value) => !value)}
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#385677] bg-[#162f50] px-2.5 text-[11px] font-bold text-slate-100 transition-colors hover:border-sky-300/60"
                data-testid="trade-dock-toggle"
                title={collapsed ? 'Expand trade setup' : 'Minimize trade setup'}
              >
                {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                <span className="hidden sm:inline">{collapsed ? 'Expand' : 'Minimize'}</span>
                <span className="sm:hidden">{collapsed ? 'Show' : 'Hide'}</span>
              </button>
            </span>
          </div>

            <div id={bodyId} hidden={collapsed} data-testid="trade-dock-body">
              <form
                onSubmit={handleTradeClick}
                className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:flex lg:items-end lg:gap-3"
              >
                {marketChoices && onMarketChange && (
                  <label className={`${fieldClass} lg:min-w-[145px] lg:flex-[1.4]`}>
                    Market
                    <select
                      value={marketCode ?? ''}
                      onChange={(event) => onMarketChange(event.target.value)}
                      className={controlClass}
                      data-testid="trade-market-select"
                    >
                      {marketChoices.map(({ code, name }) => (
                        <option key={code} value={code}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className={fieldClass}>
                  Contract
                  <select
                    value={contractType}
                    onChange={(event) =>
                      handleContractChange(event.target.value as TradeContractType)
                    }
                    className={controlClass}
                    data-testid="trade-contract-select"
                  >
                    {TRADE_FAMILIES[family].contracts.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {family === 'over-under' && (
                  <label className={fieldClass}>
                    Barrier
                    <select
                      value={barrier}
                      onChange={(event) => setBarrier(Number(event.target.value))}
                      className={controlClass}
                      data-testid="trade-barrier-select"
                    >
                      {barriers.map((digit) => (
                        <option key={digit} value={digit}>
                          {digit}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {family === 'matches' && (
                  <label className={fieldClass}>
                    Target digit
                    <select
                      value={targetDigit}
                      onChange={(event) =>
                        setTargetDigit(Number(event.target.value))
                      }
                      className={controlClass}
                      data-testid="trade-target-select"
                    >
                      {DIGIT_TARGETS.map((digit) => (
                        <option key={digit} value={digit}>
                          {digit}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className={fieldClass}>
                  Duration unit
                  <select
                    value={durationUnit}
                    onChange={(event) => handleUnitChange(event.target.value as TradeDurationUnit)}
                    className={controlClass}
                    data-testid="trade-duration-unit-select"
                    aria-label="Trade duration unit"
                  >
                    {TRADE_DURATION_UNITS.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {durationUnit === 't' ? (
                  <label className={fieldClass}>
                    Duration · ticks
                    <select
                      value={tickDurationValid ? expiry : ''}
                      onChange={(event) =>
                        onExpiryChange(
                          event.target.value ? Number(event.target.value) : null,
                        )
                      }
                      disabled={!expiryOptions.length}
                      className={controlClass}
                      data-testid="trade-expiry-select"
                    >
                      <option value="">
                        {expiryOptions.length
                          ? 'Choose expiry…'
                          : expiryVerified
                            ? 'No tick expiries'
                            : 'Loading…'}
                      </option>
                      {expiryOptions.map((ticks) => (
                        <option key={ticks} value={ticks}>
                          {ticks} {ticks === 1 ? 'tick' : 'ticks'}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className={fieldClass}>
                    Duration · {durationUnit === 's' ? 'seconds' : 'minutes'}
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder={durationUnit === 's' ? 'e.g. 60' : 'e.g. 5'}
                      value={timeDurationText}
                      onChange={(event) => {
                        setTimeDurationText(event.target.value);
                        setTicketIssue('');
                      }}
                      aria-invalid={Boolean(durationIssue)}
                      className={controlClass}
                      data-testid="trade-duration-input"
                    />
                  </label>
                )}
                <label className={fieldClass}>
                  Stake {currency ? `· ${currency}` : ''}
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={stake}
                    onChange={(event) => setStake(event.target.value)}
                    onBlur={() => setStakeTouched(true)}
                    aria-invalid={stakeTouched && !stakeValid}
                    className={controlClass}
                    data-testid="trade-stake-input"
                  />
                </label>
                <button
                  type="submit"
                  className={`focus-ring flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#db334b] px-4 text-sm font-extrabold text-white shadow-[0_4px_14px_rgba(219,51,75,0.25)] transition-colors hover:bg-[#f0445a] active:bg-[#bd203b] lg:w-[136px] ${family === 'even-odd' ? 'col-span-3 sm:col-span-2' : 'col-span-2 sm:col-span-1'}`}
                  aria-describedby={noteId}
                  data-testid={`button-trade-${family}`}
                >
                  Trade <ArrowRight size={16} />
                </button>
              </form>
              <div
                className="mt-2 rounded-lg border border-[#2d4c73] bg-[#0f2846] px-2.5 py-2"
                data-testid="trade-bot-config"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.06em] text-emerald-200">
                    <Bot size={12} /> Bot
                  </span>
                  <span className="text-[10px] text-slate-300">
                    Stake {stakeValue === null ? '—' : formatAmount(stakeValue, currency)} from the ticket above · ticks and runs from the analysis.
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {botPlan
                      ? `Signal ready: ${botPlan.contractLabel} on ${botPlan.symbol} · ${botRuns} run${botRuns === 1 ? '' : 's'}${botConfig.maxRuns > 0 ? ' (your runs box)' : ' from the analysis'} · ${entryModeLabel(botPlan.entry)} · ${describeEntryEvidence(botPlan.entry)}${botPlan.confirmation ? ` · confirmation ${botPlan.confirmation.status} (${botPlan.confirmation.edgePts >= 0 ? '+' : ''}${botPlan.confirmation.edgePts.toFixed(1)} pts${botPlan.confirmation.decisive ? ', decisive' : ''})` : ''}${botPlan.research && botPlan.research.total ? ` · research ${botPlan.research.agreeing}/${botPlan.research.total} models${botPlan.research.weight > 0 ? `, folded in at ${Math.round(botPlan.research.weight * 100)}% (${botPlan.research.contributionPts >= 0 ? '+' : ''}${botPlan.research.contributionPts.toFixed(1)} pts)` : ' (checked, no change)'}` : ''}.`
                      : analysisEntryMissing
                        ? 'The loaded signal has no entry from the engine analysis. Run Analysis again to plan it.'
                        : 'Run Analysis to load a signal into the bot.'}
                  </span>
                  {botPlan?.master ? (
                    <span
                      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] ${botPlan.master.verdict === 'NO_EDGE' ? 'border-slate-500/40 bg-slate-500/10 text-slate-300' : botPlan.master.verdict === 'SPECULATIVE' ? 'border-amber-400/40 bg-amber-400/10 text-amber-200' : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'}`}
                      title={botPlan.master.headline}
                      data-testid="dock-master-verdict"
                    >
                      Master {botPlan.master.verdict.replaceAll('_', ' ')} · valid ~{botPlan.master.validity.ticks} tick{botPlan.master.validity.ticks === 1 ? '' : 's'} · conviction {botPlan.master.conviction}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  <BotNumberField
                    label="Martingale ×"
                    value={botConfig.martingaleMultiplier}
                    min={SIGNAL_BOT_LIMITS.martingaleMultiplier.min}
                    max={SIGNAL_BOT_LIMITS.martingaleMultiplier.max}
                    step={0.1}
                    hint="Stake multiplier applied after each loss. 1 keeps every stake flat."
                    testId="bot-multiplier"
                    onChange={(value) => setBotConfig((current) => ({ ...current, martingaleMultiplier: value }))}
                  />
                  <BotNumberField
                    label="Max steps"
                    value={botConfig.maxMartingaleSteps}
                    min={SIGNAL_BOT_LIMITS.maxMartingaleSteps.min}
                    max={SIGNAL_BOT_LIMITS.maxMartingaleSteps.max}
                    step={1}
                    hint="Highest ladder step; past it the stake resets to the base stake. 0 keeps every stake flat."
                    testId="bot-max-steps"
                    onChange={(value) => setBotConfig((current) => ({ ...current, maxMartingaleSteps: value }))}
                  />
                  <BotNumberField
                    label="Stop loss · losses"
                    value={botConfig.stopLossStreak}
                    min={SIGNAL_BOT_LIMITS.stopLossStreak.min}
                    max={SIGNAL_BOT_LIMITS.stopLossStreak.max}
                    step={1}
                    hint="Consecutive losing trades that stop the bot immediately. 0 disables the stop loss."
                    testId="bot-stop-loss"
                    onChange={(value) => setBotConfig((current) => ({ ...current, stopLossStreak: value }))}
                  />
                  <BotNumberField
                    label="Take profit · wins"
                    value={botConfig.takeProfitWins}
                    min={SIGNAL_BOT_LIMITS.takeProfitWins.min}
                    max={SIGNAL_BOT_LIMITS.takeProfitWins.max}
                    step={1}
                    hint="Stop the bot once this many runs have won. 0 turns this target off."
                    testId="bot-take-profit-wins"
                    onChange={(value) => setBotConfig((current) => ({ ...current, takeProfitWins: value }))}
                  />
                  <BotNumberField
                    label="Take profit · amount"
                    value={botConfig.takeProfitAmount}
                    min={SIGNAL_BOT_LIMITS.takeProfitAmount.min}
                    max={SIGNAL_BOT_LIMITS.takeProfitAmount.max}
                    step={0.5}
                    hint={
                      currency
                        ? `Stop the bot once realised profit reaches this amount in ${currency}. 0 turns this target off.`
                        : 'Stop the bot once realised profit reaches this amount in your account currency. 0 turns this target off.'
                    }
                    testId="bot-take-profit-amount"
                    onChange={(value) => setBotConfig((current) => ({ ...current, takeProfitAmount: value }))}
                  />
                  <BotNumberField
                    label="Runs · 0 = analysis"
                    value={botConfig.maxRuns}
                    min={SIGNAL_BOT_LIMITS.maxRuns.min}
                    max={SIGNAL_BOT_LIMITS.maxRuns.max}
                    step={1}
                    hint="Override the number of runs the analysis suggests. 0 uses the analysis."
                    testId="bot-max-runs"
                    onChange={(value) => setBotConfig((current) => ({ ...current, maxRuns: value }))}
                  />
                  <label className={fieldClass}>
                    Entry misses · if it never comes
                    <select
                      value={botConfig.entryMode}
                      onChange={(event) =>
                        setBotConfig((current) => ({
                          ...current,
                          entryMode: event.target.value as SignalBotConfig['entryMode'],
                        }))
                      }
                      className={controlClass}
                      title="The entry point and entry time always come from the analysis. This only picks what the bot does on a run where the entry never arrives: buy at the signal price (the policy the replay scored) or skip that run."
                      data-testid="bot-entry-mode"
                    >
                      {SIGNAL_BOT_ENTRY_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {SIGNAL_BOT_ENTRY_MODE_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {botConfig.martingaleMultiplier > 1 && botConfig.maxMartingaleSteps > 0 && (
                  <p className="mt-1.5 text-[10px] leading-snug text-amber-200" data-testid="bot-ladder-warning">
                    Martingale ladder: {formatAmount(stakeValue ?? botConfig.baseStake, currency)} → up to{' '}
                    {formatAmount(ladderTop, currency)} after {botConfig.maxMartingaleSteps} loss
                    {botConfig.maxMartingaleSteps === 1 ? '' : 'es'} in a row, then back to the base stake.
                  </p>
                )}
                {takeProfitTargets.length > 0 && (
                  <p className="mt-1.5 text-[10px] leading-snug text-emerald-200" data-testid="bot-take-profit-warning">
                    Take profit targets: {takeProfitTargets.join(' or ')}. No new contract is bought once a target is
                    reached; the contract already open is left to settle.
                  </p>
                )}
                {autoNoticeText && (
                  <p
                    className={`mt-1.5 text-[10px] leading-snug ${autoNoticeTone}`}
                    role="status"
                    data-testid="bot-auto-note"
                  >
                    <Zap size={10} className="mr-1 inline" />
                    {autoNoticeText}
                  </p>
                )}
              </div>
              <p
                id={noteId}
                className="mt-2 text-[10px] leading-snug text-slate-300"
              >
                {ticketIssue ? (
                  <span className="font-bold text-rose-300" role="alert">
                    {ticketIssue}{' '}
                  </span>
                ) : stakeTouched && !stakeValid ? (
                  <span className="font-bold text-rose-300" role="alert">
                    Enter a positive stake with up to 2 decimal places.{' '}
                  </span>
                ) : durationIssue ? (
                  <span className="font-bold text-rose-300" role="alert">
                    {durationIssue}{' '}
                  </span>
                ) : null}
                {marketCode ? (
                  <>
                    <span className="sm:hidden">Market {marketCode}. </span>
                    <span className="hidden sm:inline">
                      Market: {marketName ?? marketCode} ({marketCode}).{' '}
                    </span>
                  </>
                ) : (
                  'No market selected. '
                )}
                {recommendation
                  ? 'Manual ticket: Use signal copies the latest analysis into the draft only. '
                  : 'Run Analysis to get a signal you can copy into this ticket. '}
                {botPlan
                  ? `Load and Run trades this signal ${botRuns} time${botRuns === 1 ? '' : 's'}, one contract at a time, with the stake and martingale set above. The entry always comes from this analysis: ${entryModeLabel(botPlan.entry)}${botPlan.entry.mode === 'immediate' ? ' — ' : ` — ${botPlan.entry.detail} `}${takeProfitTargets.length > 0 ? `It also stops at its take profit target${takeProfitTargets.length === 1 ? '' : 's'}: ${takeProfitTargets.join(' or ')}. ` : ''}`
                  : ''}
                {botResearchNote ? (
                  <span className="font-semibold text-amber-200">{botResearchNote} </span>
                ) : null}
                {durationUnit !== 't' && (
                  <>Trade duration is {selectedDurationLabel}. </>
                )}
                {durationUnit !== 't' && !contracts && (
                  <>Deriv confirms time-based availability in the live proposal. </>
                )}
                {connected ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-emerald-300">
                    <ShieldCheck size={12} />
                    {trading.activeAccount?.accountType === 'real' ? 'Real account' : 'Demo account'}{' '}
                    {trading.activeAccount?.accountId} · Trade requests a live Deriv price and buys only after you confirm it.
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-semibold text-amber-200">
                    <WifiOff size={12} />
                    No account connected — Trade opens the PAT connection so you can place this order.
                  </span>
                )}
              </p>
            </div>
        </div>
        </section>
      </div>

      <TradeConfirmationDialog
        open={dialogOpen}
        onOpenChange={closeDialog}
        request={tradeRequest}
        contractLabel={`${contractLabel} · ${selectedDurationLabel}`}
      />
    </>,
    document.body,
  );
}
