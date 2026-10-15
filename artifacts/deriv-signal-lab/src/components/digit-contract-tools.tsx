import { snapshotAge } from '@/lib/over-under/structure';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock3,
  Database,
  Play,
  Radio,
  ShieldAlert,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import {
  analyzeDigits,

  supportedTickDurations,
  type DigitAnalysis,

} from '@/lib/digit-analysis';
import { analyzePriceContext } from '@/lib/price-context';
import { useDerivDigitFeed } from '@/hooks/use-deriv-digit-feed';
import { TradeDock } from '@/components/trade-dock';
import { DigitDeepPanel } from '@/components/quant/digit-deep-panel';
import { OverUnderEnginePanel } from '@/components/over-under-engine-panel';
import type { OverUnderReport } from '@/lib/over-under/ensemble';
import type { DigitResearchMessage, DigitResearchRequest } from '@/lib/digit-research.worker';
import { isProgressMessage } from '@/lib/digit-research.worker';
import { AnalysisProgress, SignalConfidenceCard, type AnalysisProgressState } from '@/components/analysis-signal';

import { FAMILY_CONTRACTS, MINIMUM_DIGIT_TICKS, type DigitFamily, type RankedCandidate } from '@/lib/digit-signals';
type Feed = ReturnType<typeof useDerivDigitFeed>;

type DigitScanSnapshot = {
  ranAt: number;
  symbol: string;
  selectedDuration: number | null;
  latestDigit: number | null;
  analysis: DigitAnalysis;
  freshAtRun: boolean;
  /** Last validated tick epoch the scan was fitted on, for the age lifecycle. */
  asOfEpoch: number;
  /** Best-ranked candidate. Always present unless a hard data gate stopped the scan. */
  candidate: RankedCandidate | null;
  /** Candidate that passed every evidence gate; only this one may pre-fill a ticket. */
  qualifiedCandidate: RankedCandidate | null;
  candidates: RankedCandidate[];
  reason: string;
  /** Soft data notice: the signal is still published, this explains its limits. */
  dataNotice: string;
  blocked: boolean;
  overUnder?: OverUnderReport;
};

const DIGITS = Array.from({ length: 10 }, (_, digit) => digit);


const FAMILY_DETAILS: Record<DigitFamily, { title: string; eyebrow: string; description: string; empty: string }> = {
  'over-under': {
    title: 'Over/Under digit research',
    eyebrow: 'DIGITOVER · DIGITUNDER',
    description: 'Twelve fitted models across eight engine families analyze the current digit structure together, and the deep quant plus AI synthesis engines vote on the result. Every completed scan publishes a Deriv-supported barrier from 1–8 at your research tick expiry with its engine agreement and confidence score; the strict settlement and chronological gates decide whether that signal is gate-qualified or diagnostic.',
    empty: 'No contract-and-barrier combination has enough validated evidence at this expiry to rank yet.',
  },
  'even-odd': {
    title: 'Even/Odd digit research',
    eyebrow: 'DIGITEVEN · DIGITODD',
    description: 'Choose a tick expiry reported by Deriv, or let the scan use the first supported expiry. Even and Odd are compared using historical outcomes conditioned on the current digit parity, then every frequency, transition, run-structure, quant and AI engine votes. Zero is even; both sides use actual final digits.',
    empty: 'No parity combination has enough validated evidence at this expiry to rank yet.',
  },
  matches: {
    title: 'Matches digit research',
    eyebrow: 'DIGITMATCH',
    description: 'Choose a tick expiry reported by Deriv, or let the scan use the first supported expiry. When DIGITMATCH is supported, the engine ranks the full valid final-digit domain from 0 through 9—including zero—using outcomes conditioned on the current final digit, and publishes the leader with its engine agreement and confidence score.',
    empty: 'No target digit has enough validated evidence at this expiry to rank yet.',
  },
};



function formatQuote(value: number | undefined, precision: number | null): string {
  if (value === undefined || !Number.isFinite(value) || precision === null) return '—';
  return value.toFixed(precision);
}

function formatRate(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatInterval(interval: { lower: number; upper: number } | null): string {
  return interval ? `${formatRate(interval.lower)}–${formatRate(interval.upper)}` : '—';
}

function formatDifference(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const points = value * 100;
  return `${points > 0 ? '+' : ''}${points.toFixed(1)} pp`;
}

function formatMetric(value: number | null, decimalPlaces = 3): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(decimalPlaces);
}

function formatIndicator(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : Number(value.toPrecision(5)).toString();
}

function feedStatusLabel(feed: Feed): string {
  if (feed.status === 'live') return feed.fresh ? 'Live · fresh' : 'Live · stale';
  if (feed.status === 'connecting') return 'Connecting to Deriv';
  if (feed.status === 'loading') return 'Loading verified market data';
  if (feed.status === 'reconnecting') return 'Reconnecting';
  return 'Feed error';
}

function FeedStatusBadge({ feed }: { feed: Feed }) {
  const live = feed.status === 'live' && feed.fresh;
  const error = feed.status === 'error' || Boolean(feed.feedError);
  const tone = live
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
    : error
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-500';
  return (
    <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${tone}`} aria-live="polite" data-testid="digit-feed-status">
      {live ? <Wifi size={14} /> : error ? <WifiOff size={14} /> : <Radio size={14} className={feed.status === 'connecting' || feed.status === 'reconnecting' ? 'animate-pulse-line' : ''} />}
      {feedStatusLabel(feed)}
    </div>
  );
}

function SymbolPicker({ feed, family }: { feed: Feed; family: DigitFamily }) {
  return (
    <label className="block min-w-0">
      <span className="eyebrow">Market · Deriv active symbols</span>
      <select
        value={feed.selectedSymbol}
        onChange={(event) => feed.setSelectedSymbol(event.target.value)}
        disabled={!feed.symbols.length}
        className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-semibold text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={`Choose market for ${family} analysis`}
        data-testid={`${family}-symbol-select`}
      >
        {!feed.symbols.length && <option value="">Loading available markets…</option>}
        {feed.symbols.map((symbol) => (
          <option key={symbol.symbol} value={symbol.symbol}>
            {symbol.name} · {symbol.symbol}{symbol.precision === null ? ' · digit precision unavailable' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function DigitFrequencyPanel({ analysis }: { analysis: DigitAnalysis }) {
  const window1000 = analysis.windows.find((window) => window.window === 1_000)!;
  const currentRow = analysis.lastDigit === null ? null : analysis.transitionProbabilities[analysis.lastDigit];
  const currentCounts = analysis.lastDigit === null ? null : analysis.transitionCounts[analysis.lastDigit];
  const currentTransitionSample = currentCounts?.reduce((sum, count) => sum + count, 0) ?? 0;
  const currentParity = analysis.lastDigit === null ? null : analysis.lastDigit % 2;
  const parityCounts = currentParity === null ? null : analysis.parityTransitions[currentParity];
  const parityTransitionSample = parityCounts?.reduce((sum, count) => sum + count, 0) ?? 0;
  const nextDigits = currentRow && currentTransitionSample > 0
    ? currentRow.map((probability, digit) => ({ probability, digit, count: currentCounts?.[digit] ?? 0 })).filter((item) => item.probability !== null).sort((left, right) => (right.probability ?? 0) - (left.probability ?? 0)).slice(0, 3)
    : [];

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="digit-frequency-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="eyebrow">Shared digit engine</div><h3 className="mt-1 text-sm font-bold">All ten final digits</h3><p className="mt-1 text-[11px] text-muted-foreground">Validated observations only · rolling features use the latest 1,000 digits.</p></div>
        <div className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">N <span className="mono ml-1 font-semibold text-foreground">{analysis.sampleSize}</span></div>
      </div>
      <div className="mt-4 space-y-2.5">
        {DIGITS.map((digit) => {
          const count = analysis.digitCounts[digit];
          const rate = analysis.digitFrequencies[digit];
          const weighted = analysis.weightedFrequencies[digit];
          const gap = window1000.gapsSinceAppearance[digit];
          const width = rate === null ? 0 : rate * 100;
          return (
            <div key={digit} className="grid grid-cols-[22px_52px_38px_minmax(0,1fr)_74px] items-center gap-2 text-[10px]" data-testid={`digit-frequency-${digit}`}>
              <span className="mono font-bold">{digit}</span>
              <span className="mono text-muted-foreground">{count} · {formatRate(rate)}</span>
              <span className="mono text-muted-foreground" title="Ticks since last appearance in the current rolling window">{gap === null ? 'gap —' : `gap ${gap}`}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} /></div>
              <span className="mono text-right text-muted-foreground">EW {formatRate(weighted)}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><div className="eyebrow">Entropy</div><div className="mono mt-1 text-xs font-semibold">{analysis.entropyBits === null ? '—' : `${analysis.entropyBits.toFixed(3)} bits`} <span className="text-[9px] text-muted-foreground">/ 3.322 max</span></div></div>
        <div><div className="eyebrow">Parity count</div><div className="mono mt-1 text-xs font-semibold">Even {analysis.parityCounts[0]} · Odd {analysis.parityCounts[1]}</div></div>
        <div><div className="eyebrow">Current runs</div><div className="mono mt-1 text-xs font-semibold">Digit {analysis.currentDigitRun} · parity {analysis.currentParityRun}</div></div>
        <div><div className="eyebrow">Observed parity transitions</div><div className="mono mt-1 text-[10px] font-semibold">{parityTransitionSample ? `from ${currentParity === 0 ? 'even' : 'odd'} · E ${formatRate(parityCounts![0] / parityTransitionSample)} · O ${formatRate(parityCounts![1] / parityTransitionSample)} (n=${parityTransitionSample})` : '—'}</div></div>
      </div>
      <div className="mt-4 rounded-lg border border-border bg-background/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-xs font-semibold">Rolling distribution and parity</div><div className="mt-0.5 text-[9px] text-muted-foreground">Window comparisons overlap and are descriptive, not independent samples.</div></div><span className="mono text-[9px] text-muted-foreground">LAST DIGIT {analysis.lastDigit ?? '—'}</span></div>
        <div className="mt-2 space-y-1.5">
          {analysis.windows.filter((window) => [50, 100, 500, 1_000].includes(window.window)).map((window) => (
            <div key={window.window} className="grid grid-cols-[64px_48px_minmax(0,1fr)_auto] items-center gap-2 text-[10px]">
              <span>{window.window} ticks</span><span className="mono text-muted-foreground">n={window.sample}</span><span className="mono text-muted-foreground">H {window.normalizedEntropy === null ? '—' : window.normalizedEntropy.toFixed(2)}</span><span className="mono text-right">E {formatRate(window.evenRate)} · O {formatRate(window.oddRate)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-border bg-background/30 p-3">
        <div className="text-xs font-semibold">Observed transitions from current digit</div>
        <p className="mt-0.5 text-[9px] leading-relaxed text-muted-foreground">{currentTransitionSample ? `${currentTransitionSample} historical transitions out of digit ${analysis.lastDigit}; Laplace-smoothed row estimates are shown only as descriptive statistics.` : 'No preceding transitions from the current digit are present.'}</p>
        {nextDigits.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{nextDigits.map(({ digit, probability, count }) => <span key={digit} className="rounded-md border border-border px-2 py-1 text-[10px]"><span className="mono font-semibold">→ {digit}</span><span className="ml-2 text-muted-foreground">{count} · {formatRate(probability)}</span></span>)}</div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground"><span>Most frequent: {analysis.mostFrequentDigit ?? '—'}</span><span>Least observed: {analysis.leastObservedDigit ?? '—'}</span><span>All digits 0–9 remain in the distribution.</span></div>
    </section>
  );
}


function PriceContextPanel({ feed, analysis }: { feed: Feed; analysis: ReturnType<typeof analyzePriceContext> }) {
  const precision = feed.selectedMarket?.precision ?? null;
  const asOf = analysis.asOfEpoch === null ? '—' : new Date(analysis.asOfEpoch * 1_000).toLocaleTimeString();
  const priceMetrics = [
    { label: 'EMA 9', value: formatQuote(analysis.ema9 ?? undefined, precision) },
    { label: 'EMA 21', value: formatQuote(analysis.ema21 ?? undefined, precision) },
    { label: 'EMA 50', value: formatQuote(analysis.ema50 ?? undefined, precision) },
    { label: 'RSI 14', value: analysis.rsi14 === null ? '—' : `${formatMetric(analysis.rsi14, 1)} / 100` },
    { label: 'ROC · 14 ticks', value: analysis.roc14Percent === null ? '—' : `${formatMetric(analysis.roc14Percent, 3)}%` },
    { label: 'Log-return volatility · 50 ticks', value: analysis.realizedVolatility50Percent === null ? '—' : `${formatMetric(analysis.realizedVolatility50Percent, 4)}%` },
  ];

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="price-context-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="eyebrow">Separate evidence family · price only</div><h3 className="mt-1 text-sm font-bold">Tick-price technical context</h3><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Calculated from validated quotes in the latest 1,000 ticks; this context is not used to rank or predict digit outcomes.</p></div>
        <div className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">N <span className="mono ml-1 font-semibold text-foreground">{analysis.sampleSize}</span><span className="ml-2">as of {asOf}</span></div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {priceMetrics.map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">{label}</div><div className="mono mt-1 text-xs font-semibold">{value}</div></div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_1fr_1.4fr]">
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">MACD · 12 / 26 / 9</div><div className="mono mt-1 text-[10px] font-semibold">Line {formatIndicator(analysis.macdLine)} · Signal {formatIndicator(analysis.macdSignal)} · Hist {formatIndicator(analysis.macdHistogram)}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Confirmed tick swings · 3-tick pivot</div><div className="mt-1 text-[10px] font-semibold">{analysis.swingStructure}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Interpretation limits</div><div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Tick-indexed context only; no candle OHLC, traded-volume confirmation, formal primary/secondary Dow trend, ATR or ADX. It cannot justify a specific final digit.</div></div>
      </div>
    </section>
  );
}

function HistoricalRanking({ family, candidates }: { family: DigitFamily; candidates: RankedCandidate[] }) {
  if (family === 'over-under') return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="over-under-candidate-ranking">
      <div className="eyebrow">Ensemble barrier comparison · 1–8</div>
      <h3 className="mt-1 text-sm font-bold">Current-structure evidence, not easiest hit rate</h3>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Eligible candidates come first, then standardized lift adjusted for held-out Brier skill and engine disagreement. Uniform baseline differs by barrier. Unqualified rows are diagnostics, not recommendations.</p>
      <div className="mt-3 space-y-2">
        {candidates.map((candidate) => candidate.ensemble && <div key={candidate.label} className={`rounded-lg border p-3 ${candidate.ensemble.eligible ? 'border-primary/30 bg-primary/5' : 'border-border bg-background/25'}`}>
          <div className="flex items-center justify-between gap-2"><strong className="text-xs">{candidate.label}</strong><span className={`text-[9px] font-bold ${candidate.ensemble.eligible ? 'text-primary' : 'text-muted-foreground'}`}>{candidate.ensemble.eligible ? 'PASSES GATES' : 'DIAGNOSTIC ONLY'}</span></div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-5"><div><div className="eyebrow">Model estimate</div><div className="mono mt-1">{formatRate(candidate.ensemble.probability)}</div></div><div><div className="eyebrow">Lift / frequency</div><div className="mono mt-1">{formatDifference(candidate.ensemble.lift)}</div></div><div><div className="eyebrow">Holdout skill</div><div className="mono mt-1">{formatRate(candidate.ensemble.validationSkill)}</div></div><div><div className="eyebrow">Engines agree</div><div className="mono mt-1">{candidate.consensus.enginesAgreed}/{candidate.consensus.enginesTotal}</div></div><div><div className="eyebrow">Confidence</div><div className="mono mt-1 font-bold text-primary">{candidate.consensus.confidencePercent}%</div></div></div>
          <p className="mt-2 text-[9px] text-muted-foreground">Uniform {formatRate(candidate.ensemble.uniformProbability)} · rolling {formatRate(candidate.ensemble.baselineProbability)} · equal-loss estimate {formatRate(candidate.ensemble.equalityProbability)} · {candidate.ensemble.validationSample} held-out outcomes.</p>
          {!candidate.ensemble.eligible && <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">{candidate.ensemble.reasons[0]}</p>}
        </div>)}
        {!candidates.length && <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">Run Analysis to compare supported barriers 1–8.</div>}
      </div>
    </section>
  );
  const rows = family === 'matches'
    ? (() => {
      const latestDuration = candidates[0]?.outcomes.durationTicks;
      return candidates.filter((candidate) => candidate.outcomes.durationTicks === latestDuration).slice(0, 10);
    })()
    : candidates.slice(0, 8);
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid={`${family}-candidate-ranking`}>
      <div><div className="eyebrow">Historical candidate ranking</div><h3 className="mt-1 text-sm font-bold">{family === 'matches' ? 'Target digits · selected expiry' : family === 'even-odd' ? 'Parity · selected expiry' : 'Barriers · selected expiry'}</h3><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Gate-qualified candidates lead, then evidence confidence, then smoothed current-context hit rate at the selected expiry. The all-history baseline and in-sample difference are separate; this is not a calibrated or payout-adjusted forecast.</p></div>
      {rows.length ? (
        <div className="mt-3 space-y-2">
          {rows.map((candidate, index) => (
            <div key={`${candidate.outcomes.durationTicks}-${candidate.label}-${index}`} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2 ${index === 0 ? 'border-primary/25 bg-primary/5' : 'border-border bg-background/25'}`}>
              <div className="min-w-0"><div className="truncate text-[11px] font-semibold">{candidate.label} <span className="text-muted-foreground">· {candidate.outcomes.durationTicks} ticks</span> <span className={`ml-1 rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.08em] ${candidate.qualified ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : 'border-amber-500/30 bg-amber-500/10 text-amber-500'}`}>{candidate.qualified ? 'Qualified' : 'Diagnostic'}</span></div><div className="mt-0.5 text-[9px] text-muted-foreground">{candidate.outcomes.hits} / {candidate.outcomes.sample} conditioned · baseline {formatRate(candidate.baseline.empiricalHitRate)} · Δ {formatDifference(candidate.outcomes.empiricalHitRate === null || candidate.baseline.empiricalHitRate === null ? null : candidate.outcomes.empiricalHitRate - candidate.baseline.empiricalHitRate)} · {candidate.consensus.enginesAgreed}/{candidate.consensus.enginesTotal} engines{candidate.outcomes.barrierEqual ? ` · ${candidate.outcomes.barrierEqual} exact-barrier losses` : ''}</div></div>
              <div className="text-right"><div className="eyebrow">Confidence</div><div className="mono text-xs font-bold text-primary">{candidate.consensus.confidencePercent}%</div><div className="eyebrow mt-1">Observed</div><div className="mono text-[10px] font-semibold">{formatRate(candidate.outcomes.empiricalHitRate)}</div><div className="eyebrow mt-1">Nominal 95% range</div><div className="mono text-[9px] text-muted-foreground">{formatInterval(candidate.outcomes.wilson95)}</div></div>
            </div>
          ))}
        </div>
      ) : <div className="mt-4 rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">Run Analysis to rank every supported contract with its engine agreement and confidence score.</div>}
    </section>
  );
}

function DigitContractTool({ family }: { family: DigitFamily }) {
  const feed = useDerivDigitFeed();
  const [snapshot, setSnapshot] = useState<DigitScanSnapshot | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgressState | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);
  const [tradeExpiry, setTradeExpiry] = useState<number | null>(null);
  const scanTimer = useRef<number | null>(null);
  const scanWorker = useRef<Worker | null>(null);
  const scanInputs = useRef({ feed, selectedDuration, defaultDuration: null as number | null });
  const latestTick = feed.ticks.at(-1) ?? null;
  const currentAnalysis = useMemo(() => analyzeDigits(feed.ticks), [feed.ticks]);
  const currentPriceContext = useMemo(() => analyzePriceContext(feed.ticks), [feed.ticks]);
  const familyDetails = FAMILY_DETAILS[family];
  const relevantContracts = feed.contracts.filter((contract) => FAMILY_CONTRACTS[family].includes(contract.contractType));
  const availableDurations = [...new Set(relevantContracts
    .filter((contract) => contract.expiryType.toLowerCase() === 'tick')
    .flatMap((contract) => supportedTickDurations(contract.minDuration, contract.maxDuration)))].sort((left, right) => left - right);
  const supportedDurationCount = availableDurations.length;
  const defaultDuration = availableDurations[0] ?? null;
  const durationKey = availableDurations.join(',');
  scanInputs.current = { feed, selectedDuration, defaultDuration };

  useEffect(() => {
    if (selectedDuration === null || !availableDurations.includes(selectedDuration)) setSelectedDuration(defaultDuration);
    if (tradeExpiry === null || !availableDurations.includes(tradeExpiry)) setTradeExpiry(defaultDuration);
  }, [selectedDuration, tradeExpiry, defaultDuration, durationKey]);

  useEffect(() => () => {
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    scanWorker.current?.terminate();
    scanWorker.current = null;
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setSelectedDuration(null);
    setTradeExpiry(null);
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    scanWorker.current?.terminate();
    scanWorker.current = null;
    setIsScanning(false);
    setProgress(null);
  }, [feed.selectedSymbol]);

  useEffect(() => {
    setSnapshot(null);
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    scanWorker.current?.terminate();
    scanWorker.current = null;
    setIsScanning(false);
    setProgress(null);
  }, [selectedDuration]);

  function handleRunAnalysis() {
    if (isScanning) return;
    // The scan starts the instant the button is pressed: no debounce, no
    // waiting for another tick, and the engines report real progress while they
    // work. When no expiry has been chosen yet the first Deriv-supported expiry
    // is used so a signal is still produced immediately.
    const symbol = feed.selectedSymbol;
    const duration = selectedDuration ?? defaultDuration;
    const freshAtRun = feed.fresh;
    const asOfEpoch = feed.ticks.at(-1)?.epoch ?? Math.floor(Date.now() / 1_000);
    const finish = () => {
      if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
      scanTimer.current = null;
      scanWorker.current?.terminate();
      scanWorker.current = null;
      setIsScanning(false);
      setProgress(null);
    };
    const fail = (reason: string) => {
      setSnapshot({
        ranAt: Date.now(), symbol, selectedDuration: duration, latestDigit: currentAnalysis.lastDigit,
        analysis: currentAnalysis, freshAtRun, asOfEpoch, candidate: null, qualifiedCandidate: null,
        candidates: [], reason, dataNotice: '', blocked: true,
      });
      finish();
    };
    setIsScanning(true);
    setSnapshot(null);
    setProgress({ percent: 0, phase: 'Starting the engines' });
    if (duration === null) {
      fail(`Deriv has not reported a tick expiry for ${symbol || 'this symbol'} yet, so no contract can be settled. Reconnect the feed and run analysis again.`);
      return;
    }
    try {
      const worker = new Worker(new URL('../lib/digit-research.worker.ts', import.meta.url), { type: 'module' });
      scanWorker.current = worker;
      worker.onmessage = (event: MessageEvent<DigitResearchMessage>) => {
        if (scanWorker.current !== worker) return;
        if (isProgressMessage(event.data)) { setProgress(event.data.progress); return; }
        if ('error' in event.data) { fail(event.data.error); return; }
        const { analysis, ranking } = event.data;
        const latest = scanInputs.current;
        const latestDuration = latest.selectedDuration ?? latest.defaultDuration;
        if (latest.feed.selectedSymbol !== symbol || latestDuration !== duration) { finish(); return; }
        // A feed that aged during the scan no longer pre-fills a ticket, but the
        // measured signal, its engine agreement and its confidence are still
        // published with the notice below instead of being thrown away.
        const dataNotice = !latest.feed.fresh ? 'Live data aged while the engines were fitting. The signal below describes the scanned window; reconnect and re-run before trading.'
          : latest.feed.precisionError || (!latest.feed.contractsLoaded ? 'Contract rules changed during the scan. Re-run analysis to re-verify them.' : '');
        const best = ranking.signal ?? ranking.candidates[0] ?? null;
        setSnapshot({
          ranAt: Date.now(), symbol, selectedDuration: duration, latestDigit: analysis.lastDigit, analysis, freshAtRun, asOfEpoch,
          candidate: best,
          qualifiedCandidate: best?.qualified ? best : ranking.candidates.find((candidate) => candidate.qualified) ?? null,
          candidates: ranking.candidates,
          reason: ranking.blocked ? ranking.reason : dataNotice ? '' : ranking.reason,
          dataNotice,
          blocked: ranking.blocked,
          overUnder: ranking.overUnder,
        });
        finish();
      };
      worker.onerror = () => { if (scanWorker.current === worker) fail('The analysis worker could not finish. Please run it again.'); };
      scanTimer.current = window.setTimeout(() => fail('The analysis timed out. No result was published; please try again.'), 120_000);
      // Feed callbacks and sockets are deliberately excluded from the worker message.
      worker.postMessage({ family, selectedDuration: duration, feed: {
        selectedMarket: feed.selectedMarket, contractsLoaded: feed.contractsLoaded,
        historyLoaded: feed.historyLoaded, fresh: feed.fresh, precisionError: feed.precisionError,
        ticks: feed.ticks, contracts: feed.contracts,
      } } satisfies DigitResearchRequest);
    } catch {
      fail('The background analysis worker could not start. No research signal is available.');
    }
  }

  const effectiveDuration = selectedDuration ?? defaultDuration;
  const snapshotMatchesSelected = snapshot?.symbol === feed.selectedSymbol && snapshot.selectedDuration === effectiveDuration;
  const shownSnapshot = snapshotMatchesSelected ? snapshot : null;
  const snapshotAgeState = shownSnapshot
    ? snapshotAge(shownSnapshot.asOfEpoch, shownSnapshot.overUnder?.horizon ?? shownSnapshot.selectedDuration ?? 1, feed.ticks.map((tick) => tick.epoch))
    : null;
  const feedBlocked = Boolean(feed.precisionError) || !feed.contractsLoaded || feed.selectedMarket?.tradingSuspended === true || feed.selectedMarket?.exchangeOpen === false;
  /** Hard stop: no candidate could be measured at all. */
  const blockedSnapshot = Boolean(shownSnapshot && (shownSnapshot.blocked || !shownSnapshot.candidate));
  /** The published signal survives aging; only ticket pre-fill is withdrawn. */
  const resultCandidate = shownSnapshot?.candidate ?? null;
  const qualifiedCandidate = shownSnapshot?.qualifiedCandidate ?? null;
  const consensus = resultCandidate?.consensus ?? null;
  const agedOut = snapshotAgeState?.state === 'expired' || snapshotAgeState?.state === 'unavailable';
  const signalIsCurrent = Boolean(resultCandidate) && snapshotAgeState?.state === 'current' && !feedBlocked;
  const candidates = shownSnapshot?.candidates ?? [];
  const signalLabel = isScanning ? `${progress?.percent ?? 0}%` : resultCandidate?.label ?? (shownSnapshot ? 'BLOCKED' : 'READY');
  const signalTone = isScanning ? 'text-amber-500' : resultCandidate ? 'text-primary' : 'text-destructive';
  const statusBadge = isScanning
    ? { text: `Analyzing… ${progress?.percent ?? 0}%`, tone: 'border-amber-500/30 bg-amber-500/10 text-amber-500' }
    : !shownSnapshot
      ? { text: 'Ready to analyze', tone: 'border-border bg-background/40 text-muted-foreground' }
      : blockedSnapshot
        ? { text: 'Blocked · data unavailable', tone: 'border-destructive/30 bg-destructive/10 text-destructive' }
        : signalIsCurrent
          ? { text: `Signal ready · ${consensus?.confidencePercent ?? 0}% confidence`, tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' }
          : agedOut
            ? { text: 'Snapshot expired · re-run analysis', tone: 'border-destructive/30 bg-destructive/10 text-destructive' }
            : { text: 'Signal ready · snapshot aging', tone: 'border-amber-500/30 bg-amber-500/10 text-amber-500' };
  const isReady = Boolean(feed.selectedMarket && feed.historyLoaded && feed.contractsLoaded && feed.fresh && !feed.precisionError);
  const dataQualityLabel = feed.precisionError
    ? 'Blocked · precision mismatch'
    : feed.selectedMarket?.precision !== null && feed.selectedMarket && feed.historyLoaded && feed.contractsLoaded && feed.fresh
      ? 'Precision-checked · fresh'
      : 'Incomplete or stale';
  const gateSummary = resultCandidate && !resultCandidate.qualified && resultCandidate.gateReasons.length
    ? ` Gates not passed: ${resultCandidate.gateReasons.slice(0, 2).join(' ')}`
    : '';
  const signalExplanation = isScanning
    ? `${progress?.phase ?? 'Starting the engines'} — the scan publishes a signal, its engine agreement and its confidence score the moment it reaches 100%.`
    : blockedSnapshot
      ? shownSnapshot?.reason || familyDetails.empty
      : resultCandidate
        ? `${consensus?.enginesAgreed ?? 0} of ${consensus?.enginesTotal ?? 0} engines (${consensus?.familiesAgreed ?? 0}/${consensus?.familiesTotal ?? 0} families) support ${resultCandidate.label} for ${shownSnapshot?.symbol} at ${resultCandidate.outcomes.durationTicks} ticks, with a ${consensus?.confidencePercent ?? 0}% evidence confidence score.${resultCandidate.qualified ? '' : ' This is the best-ranked candidate, not a gate-qualified one.'}${gateSummary} Confidence measures evidence, never a guaranteed outcome.`
        : shownSnapshot?.reason || familyDetails.empty;

  return (
    <div className="animate-rise-in space-y-5 pt-5" data-testid={`${family}-analysis`}>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><div className="eyebrow">{familyDetails.eyebrow} · multi-engine research</div><h2 className="mt-1 text-2xl font-extrabold tracking-[-0.04em] sm:text-3xl">{familyDetails.title}</h2><p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{familyDetails.description} No orders are placed from this tool.</p></div>
        <FeedStatusBadge feed={feed} />
      </div>

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.75fr)_minmax(180px,0.55fr)_minmax(260px,1.2fr)_auto] lg:items-end">
          <SymbolPicker feed={feed} family={family} />
          <label className="block min-w-0">
            <span className="eyebrow">Tick expiry · Deriv metadata</span>
            <select
              value={selectedDuration ?? ''}
              onChange={(event) => setSelectedDuration(event.target.value ? Number(event.target.value) : null)}
              disabled={!feed.contractsLoaded || !availableDurations.length}
              className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-semibold text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={`Choose Deriv-supported tick expiry for ${family} analysis`}
              data-testid={`${family}-duration-select`}
            >
              <option value="">{feed.contractsLoaded ? 'Choose tick expiry…' : 'Loading contract rules…'}</option>
              {availableDurations.map((duration) => <option key={duration} value={duration}>{duration} {duration === 1 ? 'tick' : 'ticks'}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Quote</div><div className="mono mt-1 text-sm font-semibold">{formatQuote(latestTick?.quote, feed.selectedMarket?.precision ?? null)}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Final digit</div><div className="mono mt-1 text-sm font-semibold">{latestTick?.digit ?? '—'}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Verified precision</div><div className="mono mt-1 text-sm font-semibold">{feed.selectedMarket?.precision === null || !feed.selectedMarket ? '—' : `${feed.selectedMarket.precision} dp`}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Valid digit ticks</div><div className="mono mt-1 text-sm font-semibold">{feed.ticks.length}</div></div>
          </div>
          <button type="button" onClick={handleRunAnalysis} disabled={isScanning} className="focus-ring flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60" data-testid={`button-run-analysis-${family}`}>
            <Play size={16} fill="currentColor" />{isScanning ? `Analyzing… ${progress?.percent ?? 0}%` : 'Run Analysis'}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
          <span>{feed.selectedMarket?.name ?? 'No market selected'}{feed.selectedMarket?.market ? ` · ${feed.selectedMarket.market}` : ''}</span>
          <span>{feed.selectedMarket?.exchangeOpen === null || !feed.selectedMarket ? 'Market hours unverified' : feed.selectedMarket.exchangeOpen ? 'Exchange open' : 'Exchange closed'}</span>
          <span>{feed.selectedMarket?.tradingSuspended ? 'Trading suspended' : feed.selectedMarket ? 'Suspension check passed' : 'Suspension unknown'}</span>
          <span>{feed.contractsLoaded ? `${relevantContracts.length} Deriv-supported contract types` : 'Checking contract support'}</span>
          <span>{supportedDurationCount} unique Deriv-supported tick expiries · choose one</span>
          <span>{feed.usingTestAppId ? 'Test app ID 1089' : 'Configured Deriv app ID'}</span>
          <span>Digit count is not traded volume</span>
        </div>
        {feed.feedError && <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs leading-relaxed text-destructive" role="alert"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{feed.feedError}</span></div>}
        {feed.contractError && <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground" role="status"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" /><span>{feed.contractError}</span></div>}
        {feed.precisionError && <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs leading-relaxed text-destructive" role="alert" data-testid="digit-precision-error"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{feed.precisionError}</span></div>}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]" data-testid={`${family}-signal-summary`} aria-busy={isScanning}>
        <article className="signal-panel rounded-xl border border-card-border p-5 panel-glow sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="eyebrow">Digit analysis signal</div><span className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${statusBadge.tone}`} data-testid={`${family}-signal-status`}>{statusBadge.text}</span></div>
          {isScanning && <AnalysisProgress progress={progress} label={`Scanning ${feed.selectedMarket?.name ?? feed.selectedSymbol} · ${family === 'over-under' ? '12 models, 8 engine families' : 'every engine'}`} />}
          <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className={`text-4xl font-extrabold tracking-[-0.06em] sm:text-5xl ${signalTone}`} data-testid={`${family}-signal`} role="status" aria-live="polite">{signalLabel}</div>
              {consensus && !isScanning && (
                <div className="mt-3 flex flex-wrap items-center gap-2" data-testid={`${family}-signal-consensus`}>
                  <span className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-[11px] font-bold text-primary">{consensus.confidencePercent}% confidence · {consensus.grade}</span>
                  <span className="rounded-full border border-border bg-background/40 px-3 py-1.5 text-[11px] font-semibold">{consensus.enginesAgreed}/{consensus.enginesTotal} engines agree</span>
                  <span className="rounded-full border border-border bg-background/40 px-3 py-1.5 text-[11px] font-semibold">{consensus.familiesAgreed}/{consensus.familiesTotal} families</span>
                  <span className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold ${resultCandidate?.qualified ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : 'border-amber-500/30 bg-amber-500/10 text-amber-500'}`}>{resultCandidate?.qualified ? 'Every evidence gate passed' : 'Best-ranked · gates not passed'}</span>
                </div>
              )}
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{signalExplanation}</p>
              {shownSnapshot?.dataNotice && <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-500" role="status"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{shownSnapshot.dataNotice}</span></p>}
              {snapshotAgeState?.notice && <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-500" role="status"><Clock3 size={14} className="mt-0.5 shrink-0" /><span>{snapshotAgeState.notice}</span></p>}
              {snapshotAgeState?.reason && <p className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] leading-relaxed text-destructive" role="alert"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{snapshotAgeState.reason}</span></p>}
            </div>
            {shownSnapshot && resultCandidate ? (
              <div className="w-full max-w-sm rounded-xl border border-primary/25 bg-primary/5 px-4 py-3" data-testid={`${family}-research-candidate`}>
                <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-primary">Analysis signal · {resultCandidate.qualified ? 'gate-qualified' : 'best-ranked evidence'}</div>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-xl font-extrabold">{resultCandidate.label}</span>
                  {consensus && <span className="mono text-sm font-bold text-primary" data-testid={`${family}-candidate-confidence`}>{consensus.confidencePercent}% confidence</span>}
                </div>
                {consensus && <div className="mt-1 text-[10px] font-semibold text-muted-foreground" data-testid={`${family}-candidate-agreement`}>{consensus.enginesAgreed}/{consensus.enginesTotal} engines agree · {consensus.familiesAgreed}/{consensus.familiesTotal} families · {(consensus.weightedAgreement * 100).toFixed(0)}% of voting weight</div>}
                {resultCandidate.ensemble && <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-2 text-[11px]"><strong>{formatRate(resultCandidate.ensemble.probability)}</strong> ensemble estimate · lift {formatDifference(resultCandidate.ensemble.lift)} · {formatRate(resultCandidate.ensemble.agreement)} weighted agreement. Equality loss estimate: {formatRate(resultCandidate.ensemble.equalityProbability)}.</div>}
                <div className="mt-1 text-[10px] text-muted-foreground">{shownSnapshot.symbol} · selected {resultCandidate.outcomes.durationTicks}-tick expiry</div>
                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/70 pt-3 text-xs sm:grid-cols-4"><div><div className="eyebrow">Conditioned rate</div><div className="mono mt-1 font-semibold">{formatRate(resultCandidate.outcomes.empiricalHitRate)}</div></div><div><div className="eyebrow">All-history base</div><div className="mono mt-1 font-semibold">{formatRate(resultCandidate.baseline.empiricalHitRate)}</div></div><div><div className="eyebrow">Nominal 95% interval</div><div className="mono mt-1 font-semibold">{formatInterval(resultCandidate.outcomes.wilson95)}</div></div><div><div className="eyebrow">Sample</div><div className="mono mt-1 font-semibold">{resultCandidate.outcomes.hits} / {resultCandidate.outcomes.sample}</div></div></div>
                <div className="mt-2 text-[10px] text-muted-foreground">Conditional difference vs all-history base: {formatDifference(resultCandidate.outcomes.empiricalHitRate === null || resultCandidate.baseline.empiricalHitRate === null ? null : resultCandidate.outcomes.empiricalHitRate - resultCandidate.baseline.empiricalHitRate)} (in-sample only).</div>
                {resultCandidate.outcomes.barrierEqual > 0 && <div className="mt-2 text-[10px] text-muted-foreground">Exact barrier was observed {resultCandidate.outcomes.barrierEqual} times and counted as a loss.</div>}
                <div className="mt-2 text-[10px] text-muted-foreground">Conditioned on {resultCandidate.outcomes.contextDigit !== null ? `starting digit ${resultCandidate.outcomes.contextDigit}` : resultCandidate.outcomes.contextParity === 0 ? 'an even starting digit' : 'an odd starting digit'}.</div>
              </div>
            ) : (
              <div className="w-full max-w-sm rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{shownSnapshot ? shownSnapshot.reason || familyDetails.empty : 'No scan has been run for this market yet.'}</div>
            )}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3" data-testid={`${family}-evidence-status`}>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Data quality</div><div className="mt-1 text-[11px] font-semibold">{dataQualityLabel}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Model reliability</div><div className="mt-1 text-[11px] font-semibold">{family === 'over-under' ? shownSnapshot?.overUnder ? qualifiedCandidate ? 'Local held-out gates passed' : 'Fitted · gates not passed' : 'Awaiting model fitting' : consensus ? `${consensus.enginesAgreed}/${consensus.enginesTotal} engines agree` : 'Awaiting analysis'}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Confidence score</div><div className="mt-1 text-[11px] font-semibold">{consensus && !isScanning ? `${consensus.confidencePercent}% · ${consensus.grade}` : isScanning ? `Scanning · ${progress?.percent ?? 0}%` : 'Awaiting analysis'}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Historical hit rate</div><div className="mt-1 text-[11px] font-semibold">{resultCandidate ? formatRate(resultCandidate.outcomes.empiricalHitRate) : 'Awaiting valid analysis'}</div></div>
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-background/45 p-3 text-xs leading-relaxed text-muted-foreground"><ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" /><span>{family === 'over-under' ? 'The ensemble is fitted locally with a chronological training/tuning/holdout split. Model weights never use holdout labels. Non-overlapping expiry outcomes and conservative barrier checks reduce—but do not remove—selection risk or serial dependence. Model estimates are not calibrated win probabilities, and no payout/expected-value or profitability guarantee is provided. Historical rates and Wilson ranges below are descriptive only. Re-run analysis as market structure changes.' : 'Historical frequencies and smoothed rankings are descriptive research, not calibrated probabilities. The nominal 95% Wilson interval assumes independent Bernoulli outcomes; overlapping horizons violate that assumption. These rankings are not a payout/expected-value model or a guarantee of future results. Re-run analysis for an updated snapshot.'}</span></div>
          {shownSnapshot && <div className="mt-3 text-[10px] text-muted-foreground">Snapshot {new Date(shownSnapshot.ranAt).toLocaleTimeString()} · {shownSnapshot.analysis.sampleSize} validated digits · live freshness at scan: {shownSnapshot.freshAtRun ? 'confirmed' : 'not confirmed'}</div>}
        </article>

        <article className="rounded-xl border border-card-border bg-card/90 p-5 panel-glow">
          <div className="flex items-center justify-between gap-3"><div><div className="eyebrow">Live selected market</div><h3 className="mt-1 text-base font-bold">{feed.selectedMarket?.name ?? 'Waiting for active symbols'}</h3></div><Activity size={18} className={feed.fresh ? 'text-emerald-500' : 'text-muted-foreground'} /></div>
          <div className="mt-1 text-[10px] text-muted-foreground">{feed.selectedSymbol || 'No active symbol'} · {feed.selectedMarket?.market ?? 'market metadata unavailable'}</div>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4"><div><div className="eyebrow">Feed status</div><div className="mt-1 text-sm font-semibold">{feedStatusLabel(feed)}</div></div><div><div className="eyebrow">Source age</div><div className="mono mt-1 text-sm font-semibold">{feed.sourceAgeMs === null ? '—' : `${Math.max(0, Math.floor(feed.sourceAgeMs / 1000))}s`}</div></div><div><div className="eyebrow">History</div><div className="mt-1 text-sm font-semibold">{feed.historyLoaded ? 'Loaded' : 'Waiting / unavailable'}</div></div><div><div className="eyebrow">Contract rules</div><div className="mt-1 text-sm font-semibold">{feed.contractsLoaded ? 'Queried' : 'Waiting / unavailable'}</div></div></div>
          {feed.selectedMarket?.precision !== null && feed.selectedMarket && <div className="mt-4 rounded-md border border-border bg-background/35 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">Final digits use Deriv pip_size = {feed.selectedMarket.pipSize} and {feed.selectedMarket.precision} displayed decimal places. Any metadata mismatch blocks digit analysis.</div>}
        </article>
      </section>

      {!isScanning && consensus && !blockedSnapshot && <SignalConfidenceCard consensus={consensus} showVotes />}

      {family === 'over-under' && <OverUnderEnginePanel
        report={shownSnapshot?.overUnder ?? null}
        isScanning={isScanning}
        progress={progress}
        consensus={consensus}
        inactiveReason={snapshotAgeState?.reason || (feedBlocked ? 'Live data or contract availability is no longer valid for trading. The measured signal above still describes the scanned window.' : undefined)}
      />}

      <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <DigitFrequencyPanel analysis={shownSnapshot?.analysis ?? currentAnalysis} />
        <HistoricalRanking family={family} candidates={candidates} />
      </section>

      <PriceContextPanel feed={feed} analysis={currentPriceContext} />

      <DigitDeepPanel digits={feed.ticks.map((t) => t.digit)} family={family === 'over-under' ? 'over-under' : family === 'even-odd' ? 'even-odd' : 'matches'} />

      <section className="grid gap-3 md:grid-cols-3">
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><Database size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Verified input pipeline</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Active-symbol pip_size, history pip_size and live tick pip_size must agree. Quotes are decimal-scaled before extracting the last displayed digit; invalid precision blocks analysis.</p></div></div>
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><BarChart3 size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Expiry-aware research</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Each candidate uses the final observed digit exactly N ticks after each historical entry and conditions on the current digit or parity. Overlapping comparisons are not independent and are not a calibration set.</p></div></div>
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><Clock3 size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Research limits</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{family === 'over-under' ? 'Local LSTM, boosted classifiers and chronological validation are available above. Payout/EV gating, probability calibration, external pretrained models, persistent signals and full rolling-refit backtesting are not provided.' : 'Formal multi-horizon Dow analysis, candle-based ATR / ADX, payout/EV gating, model calibration, walk-forward backtesting, persistent signals and machine learning remain unavailable.'} Automatic execution is not offered: the trade dock only sends orders you confirm against a live Deriv quote.</p></div></div>
      </section>

      <div className="text-[10px] leading-relaxed text-muted-foreground" aria-live="polite"><Zap size={12} className="mr-1 inline text-primary" />{shownSnapshot ? `${shownSnapshot.analysis.sampleSize} real validated digits were analyzed for ${shownSnapshot.symbol}.` : isReady ? `Choose one of ${supportedDurationCount} Deriv-supported tick expiries, then run analysis.` : 'Waiting for live data, pip precision, contract metadata and sufficient history.'} No simulated digits or fabricated probabilities are used, and no order is ever sent without your confirmation in the trade dock.</div>

      <TradeDock
        family={family}
        recommendation={family === 'over-under' && !isScanning && signalIsCurrent && qualifiedCandidate?.contract.family === 'over-under' && shownSnapshot?.overUnder ? {
          symbol: shownSnapshot.symbol, contractType: qualifiedCandidate.contract.contractType,
          barrier: qualifiedCandidate.contract.barrier, horizon: shownSnapshot.overUnder.horizon,
        } : null}
        marketCode={feed.selectedSymbol || null}
        marketName={feed.selectedMarket?.name ?? null}
        expiry={tradeExpiry}
        expiryOptions={availableDurations}
        onExpiryChange={setTradeExpiry}
        contracts={feed.contracts}
        expiryVerified={feed.contractsLoaded}
      />
    </div>
  );
}

export function OverUnderTool() { return <DigitContractTool family="over-under" />; }
export function EvenOddTool() { return <DigitContractTool family="even-odd" />; }
export function MatchesTool() { return <DigitContractTool family="matches" />; }
