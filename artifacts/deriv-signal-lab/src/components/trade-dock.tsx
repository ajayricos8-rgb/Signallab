import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Bot, ChevronDown, ChevronUp, Loader2, Settings2, ShieldCheck, WifiOff } from 'lucide-react';
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
import { researchExecutionIssue } from '@/lib/engine-lab/execution';
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

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
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
      ranAt: analysis?.ranAt ?? 0,
      confirmation: analysis?.confirmation ?? null,
    };
  }, [analysis, analysisEntryReady, expiryOptions, family, loadedEntry, marketName, recommendation]);

  const botResearchIssue = botPlan ? researchExecutionIssue(botPlan.researchDecision) : null;
  const botRuns = botPlan ? resolveMaxRuns(botConfig, botPlan.recommendedRuns) : 0;
  // The bot always waits for the analysis entry; immediate is the analysis's own
  // conclusion that there is no timing edge to wait for.
  const botEntryWaits = Boolean(botPlan && botPlan.entry.trigger !== 'immediate');
  // A finished signal whose analysis has no engine entry (restored, older runs).
  const analysisEntryMissing = Boolean(recommendation && canApplySignal(recommendation, family, expiryOptions) && !analysisEntryReady);
  const ladderTop = maxLadderStake({ ...botConfig, baseStake: stakeValue ?? botConfig.baseStake });

  // A finished analysis pops the dock open so Load and Run is reachable.
  const lastAnalysisRunId = useRef(analysis?.runId ?? 0);
  useEffect(() => {
    const runId = analysis?.runId ?? 0;
    if (runId === 0 || runId === lastAnalysisRunId.current) return;
    lastAnalysisRunId.current = runId;
    if (botPlan) setCollapsed(false);
  }, [analysis, botPlan]);

  function handleLoadAndRun() {
    if (!botPlan) {
      setTicketIssue(
        analysisEntryMissing
          ? 'This signal has no entry from the engine analysis. Run Analysis again so the bot can load a planned entry.'
          : 'Run Analysis to generate a signal before loading the bot.',
      );
      return;
    }
    if (botResearchIssue) {
      setTicketIssue(botResearchIssue);
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
    signalBot.loadAndRun(botPlan, { ...botConfig, baseStake: stakeValue });
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
              {botPlan && (
                <button
                  type="button"
                  onClick={handleLoadAndRun}
                  disabled={bot.running || !stakeValid || Boolean(botResearchIssue)}
                  title={
                    botResearchIssue ?? (bot.running
                      ? 'The bot is trading this signal. Press Stop on the bot page to end the run.'
                      : `Buy ${botPlan.contractLabel} on ${botPlan.symbol} for ${botRuns} run${botRuns === 1 ? '' : 's'}, one contract at a time, ${entryModeLabel(botPlan.entry).toLowerCase()}.`)
                  }
                  className={`focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-extrabold transition-colors disabled:cursor-not-allowed ${botResearchIssue ? 'border border-amber-400/30 bg-amber-400/10 text-amber-200' : 'bg-emerald-400 text-[#052e1e] hover:bg-emerald-300 disabled:opacity-55'}`}
                  data-testid={`button-load-and-run-${family}`}
                >
                  {bot.running ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}
                  {bot.running ? 'Running…' : botResearchIssue ? 'Observation only' : 'Load and Run'}
                </button>
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
                      ? `Signal ready: ${botPlan.contractLabel} on ${botPlan.symbol} · ${botRuns} run${botRuns === 1 ? '' : 's'}${botConfig.maxRuns > 0 ? ' (your runs box)' : ' from the analysis'} · ${entryModeLabel(botPlan.entry)} · ${describeEntryEvidence(botPlan.entry)}${botPlan.confirmation ? ` · confirmation ${botPlan.confirmation.status} (${botPlan.confirmation.edgePts >= 0 ? '+' : ''}${botPlan.confirmation.edgePts.toFixed(1)} pts${botPlan.confirmation.decisive ? ', decisive' : ''})` : ''}.`
                      : analysisEntryMissing
                        ? 'The loaded signal has no entry from the engine analysis. Run Analysis again to plan it.'
                        : 'Run Analysis to load a signal into the bot.'}
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
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
                  ? `Load and Run trades this signal ${botRuns} time${botRuns === 1 ? '' : 's'}, one contract at a time, with the stake and martingale set above. The entry always comes from this analysis: ${entryModeLabel(botPlan.entry)}${botPlan.entry.mode === 'immediate' ? ' — ' : ` — ${botPlan.entry.detail} `}`
                  : ''}
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
