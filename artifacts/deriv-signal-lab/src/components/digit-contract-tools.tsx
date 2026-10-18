import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Play, Radio, ShieldAlert, Square, Wifi, WifiOff, Zap } from 'lucide-react';
import { analyzeDigits, supportedTickDurations, type DigitAnalysis, type DigitContractCandidate } from '@/lib/digit-analysis';
import { analyzePriceContext } from '@/lib/price-context';
import { FAMILY_CONTRACTS, type DigitFamily } from '@/lib/digit-signals';
import { digitTicksOf } from '@/lib/market-feed';
import { DIGIT_SIGNAL_MIN_TICKS, type DigitContractSignal, type DigitMarketAnalysis } from '@/lib/signal-engine/digit-signal';
import type { ScanFailure, ScanMarketJob } from '@/lib/signal-engine/scan-runner';
import type { OverUnderReport } from '@/lib/over-under/ensemble';
import type { TradeRecommendation } from '@/lib/trade-draft';
import { explainSignal } from '@/lib/signal-engine/confidence';
import { entryModeLabel } from '@/lib/signal-engine/entry.ts';
import { useMarketFeed, type MarketFeedEntry, type MarketFeedValue } from '@/components/market-feed-provider';
import { useSignalScan } from '@/hooks/use-signal-scan';
import { TradeDock } from '@/components/trade-dock';
import { EntryPlanCard } from '@/components/signal/entry-plan-card';
import { DigitDeepPanel } from '@/components/quant/digit-deep-panel';
import { OverUnderEnginePanel } from '@/components/over-under-engine-panel';
import {
  AnalysisEnginePanel, AnalysisProgressPanel, ConfirmationPanel, EngineVotesPanel, MarketRankingTable, SignalCard, StrengthBadge, formatPercent, shortMarketName,
} from '@/components/signal/signal-ui';

const ALL_MARKETS = 'all';
const DIGITS = Array.from({ length: 10 }, (_, digit) => digit);
const DEFAULT_DURATIONS = Array.from({ length: 10 }, (_, index) => index + 1);
const ENGINE_COUNT = 12;

type DigitRunMeta = { family: DigitFamily; duration: number; scope: string };

const FAMILY_DETAILS: Record<DigitFamily, { title: string; eyebrow: string; description: string }> = {
  'over-under': {
    title: 'Over/Under signals',
    eyebrow: 'DIGITOVER · DIGITUNDER',
    description: 'Run Analysis scans every volatility market with 12 engines — Markov, n-gram, hidden-Markov, frequency, entropy, streak, trend, pattern, ARIMA, GARCH, an LSTM neural network and gradient-boosted trees — and returns the strongest Over/Under barrier (1–8).',
  },
  'even-odd': {
    title: 'Even/Odd signals',
    eyebrow: 'DIGITEVEN · DIGITODD',
    description: 'Run Analysis scans every volatility market with the same 12 digit engines, including the LSTM and gradient-boosted models, and returns the strongest Even or Odd call. Zero counts as even.',
  },
  matches: {
    title: 'Matches signals',
    eyebrow: 'DIGITMATCH',
    description: 'Run Analysis scans every volatility market with 12 digit engines, including the LSTM and gradient-boosted models, and returns the target digit (0–9) with the strongest evidence.',
  },
};

function formatQuote(value: number | undefined, precision: number | null): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return precision === null ? String(value) : value.toFixed(precision);
}

function formatMetric(value: number | null, decimalPlaces = 3): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(decimalPlaces);
}

function formatIndicator(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : Number(value.toPrecision(5)).toString();
}

function directionOf(contract: DigitContractCandidate): 'up' | 'down' | 'neutral' {
  if (contract.family !== 'over-under') return 'neutral';
  return contract.contractType === 'DIGITOVER' ? 'up' : 'down';
}

function durationLabel(ticks: number): string {
  return `${ticks} ${ticks === 1 ? 'tick' : 'ticks'}`;
}

/** Contracts Deriv reports for this market and duration (defaults when not yet loaded). */
function contractsFor(entry: MarketFeedEntry, family: DigitFamily, duration: number): { contracts?: DigitContractCandidate[]; skip?: string } {
  if (!entry.contractsLoaded || !entry.contracts.length) return {};
  const supports = entry.contracts.filter((contract) => FAMILY_CONTRACTS[family].includes(contract.contractType) && contract.expiryType.toLowerCase() === 'tick');
  if (!supports.length) return { skip: 'Deriv does not list this contract type here' };
  const atDuration = supports.filter((support) => supportedTickDurations(support.minDuration, support.maxDuration).includes(duration));
  if (!atDuration.length) return { skip: `${durationLabel(duration)} expiry is not offered here` };
  const contracts: DigitContractCandidate[] = [];
  for (const support of atDuration) {
    if (family === 'over-under' && (support.contractType === 'DIGITOVER' || support.contractType === 'DIGITUNDER')) {
      for (const barrier of support.barriers) if (Number.isInteger(barrier) && barrier >= 1 && barrier <= 8) contracts.push({ family, contractType: support.contractType, barrier });
    } else if (family === 'even-odd' && (support.contractType === 'DIGITEVEN' || support.contractType === 'DIGITODD')) {
      contracts.push({ family, contractType: support.contractType });
    } else if (family === 'matches' && support.contractType === 'DIGITMATCH') {
      for (const targetDigit of support.targets) if (Number.isInteger(targetDigit) && targetDigit >= 0 && targetDigit <= 9) contracts.push({ family, contractType: 'DIGITMATCH', targetDigit });
    }
  }
  return contracts.length ? { contracts } : { skip: 'No supported contract in the scanned range' };
}

function recommendationFor(result: DigitMarketAnalysis, signal: DigitContractSignal): TradeRecommendation {
  const contract = signal.contract;
  return {
    symbol: result.symbol,
    contractType: contract.contractType,
    barrier: contract.family === 'over-under' ? contract.barrier : contract.family === 'matches' ? contract.targetDigit : undefined,
    duration: result.horizon,
    durationUnit: 't',
    label: signal.label,
  };
}

function FeedStatusBadge({ feed }: { feed: MarketFeedValue }) {
  const total = feed.markets.length;
  const live = feed.status === 'live' && feed.freshCount > 0;
  const tone = live ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
    : feed.status === 'error' ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-500';
  const label = live ? `${feed.freshCount}/${total} markets live`
    : feed.status === 'reconnecting' ? 'Reconnecting to Deriv'
      : feed.status === 'error' ? 'Feed error'
        : `Loading markets · ${feed.loadedCount}/${total}`;
  return (
    <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${tone}`} aria-live="polite" data-testid="digit-feed-status">
      {live ? <Wifi size={14} /> : feed.status === 'error' ? <WifiOff size={14} /> : <Radio size={14} className="animate-pulse-line" />}
      {label}
    </div>
  );
}

function DigitFrequencyPanel({ analysis, marketName }: { analysis: DigitAnalysis; marketName: string }) {
  const window1000 = analysis.windows.find((window) => window.window === 1_000)!;
  const currentParity = analysis.lastDigit === null ? null : analysis.lastDigit % 2;
  const parityCounts = currentParity === null ? null : analysis.parityTransitions[currentParity];
  const parityTransitionSample = parityCounts?.reduce((sum, count) => sum + count, 0) ?? 0;
  const secondOrderContexts = analysis.secondOrderTransitionProbabilities.flat().filter((row) => row.some((probability) => probability !== null)).length;
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="digit-frequency-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="eyebrow">Digit distribution · {marketName}</div><h3 className="mt-1 text-sm font-bold">All ten final digits</h3><p className="mt-1 text-[11px] text-muted-foreground">Validated live ticks · rolling features use the latest 1,000 digits.</p></div>
        <div className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">N <span className="mono ml-1 font-semibold text-foreground">{analysis.sampleSize}</span></div>
      </div>
      <div className="mt-4 space-y-2.5">
        {DIGITS.map((digit) => {
          const count = analysis.digitCounts[digit];
          const rate = analysis.digitFrequencies[digit];
          const gap = window1000.gapsSinceAppearance[digit];
          return (
            <div key={digit} className="grid grid-cols-[22px_112px_46px_minmax(0,1fr)] items-center gap-2 text-[10px]" data-testid={`digit-frequency-${digit}`}>
              <span className="mono font-bold">{digit}</span>
              <div className="leading-tight"><span className="mono text-muted-foreground">{count} · {formatPercent(rate)}</span><span className="mono block text-[8px] text-muted-foreground">95% Wilson {analysis.digitIntervals95[digit] ? `${formatPercent(analysis.digitIntervals95[digit]!.lower)}–${formatPercent(analysis.digitIntervals95[digit]!.upper)}` : '—'}</span></div>
              <span className="mono text-muted-foreground" title="Ticks since last appearance">{gap === null ? 'gap —' : `gap ${gap}`}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${rate === null ? 0 : Math.min(100, rate * 500)}%` }} /></div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><div className="eyebrow">Entropy</div><div className="mono mt-1 text-xs font-semibold">{analysis.entropyBits === null ? '—' : `${analysis.entropyBits.toFixed(3)} bits`} <span className="text-[9px] text-muted-foreground">/ 3.322 max</span></div></div>
        <div><div className="eyebrow">Parity count</div><div className="mono mt-1 text-xs font-semibold">Even {analysis.parityCounts[0]} · Odd {analysis.parityCounts[1]}</div></div>
        <div><div className="eyebrow">Current runs</div><div className="mono mt-1 text-xs font-semibold">Digit {analysis.currentDigitRun} · parity {analysis.currentParityRun}</div></div>
        <div><div className="eyebrow">Parity after current</div><div className="mono mt-1 text-[10px] font-semibold">{parityTransitionSample ? `from ${currentParity === 0 ? 'even' : 'odd'} · E ${formatPercent(parityCounts![0] / parityTransitionSample)} · O ${formatPercent(parityCounts![1] / parityTransitionSample)}` : '—'}</div></div>
        <div><div className="eyebrow">Conditional entropy</div><div className="mono mt-1 text-[10px] font-semibold">{analysis.conditionalEntropyBits === null ? '—' : `${analysis.conditionalEntropyBits.toFixed(3)} bits`} · MI {analysis.mutualInformationBits === null ? '—' : `${analysis.mutualInformationBits.toFixed(3)} bits`}</div></div>
        <div><div className="eyebrow">Second-order contexts</div><div className="mono mt-1 text-[10px] font-semibold">{secondOrderContexts}/100 with ≥5 observations</div></div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground"><span>Most frequent: {analysis.mostFrequentDigit ?? '—'}</span><span>Least observed: {analysis.leastObservedDigit ?? '—'}</span><span>Bars are scaled so 20% fills the bar.</span></div>
      <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">Intervals are one-vs-rest Wilson estimates, not simultaneous intervals across all digits; observed hot/cold frequencies and entropy describe history, not a next-tick guarantee.</p>
    </section>
  );
}

export function PriceContextPanel({ precision, analysis }: { precision: number | null; analysis: ReturnType<typeof analyzePriceContext> }) {
  const asOf = analysis.asOfEpoch === null ? '—' : new Date(analysis.asOfEpoch * 1_000).toLocaleTimeString();
  const priceMetrics = [
    { label: 'EMA 9', value: formatQuote(analysis.ema9 ?? undefined, precision) },
    { label: 'EMA 21', value: formatQuote(analysis.ema21 ?? undefined, precision) },
    { label: 'EMA 50', value: formatQuote(analysis.ema50 ?? undefined, precision) },
    { label: 'RSI 14', value: analysis.rsi14 === null ? '—' : `${formatMetric(analysis.rsi14, 1)} / 100` },
    { label: 'ROC · 14 ticks', value: analysis.roc14Percent === null ? '—' : `${formatMetric(analysis.roc14Percent, 3)}%` },
    { label: 'Volatility · 50 ticks', value: analysis.realizedVolatility50Percent === null ? '—' : `${formatMetric(analysis.realizedVolatility50Percent, 4)}%` },
    { label: 'Latest Δ price', value: analysis.latestDelta === null ? '—' : formatIndicator(analysis.latestDelta) },
    { label: 'Latest simple return', value: analysis.latestSimpleReturn === null ? '—' : `${formatMetric(analysis.latestSimpleReturn * 100, 4)}%` },
    { label: 'Mean return · 20 ticks', value: analysis.meanReturn20 === null ? '—' : `${formatMetric(analysis.meanReturn20 * 100, 4)}%` },
    { label: 'Return volatility · 20 ticks', value: analysis.returnVolatility20 === null ? '—' : `${formatMetric(analysis.returnVolatility20 * 100, 4)}%` },
    { label: 'Momentum · 10 ticks', value: analysis.momentum10 === null ? '—' : formatIndicator(analysis.momentum10) },
    { label: 'Normalized momentum · 10', value: formatMetric(analysis.normalizedMomentum10, 2) },
    { label: 'MAD of price changes · 50', value: formatIndicator(analysis.medianAbsoluteDeviation50) },
    { label: 'Return autocorrelation · lag 1', value: formatMetric(analysis.returnAutocorrelation1, 3) },
  ];
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="price-context-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="eyebrow">Price context</div><h3 className="mt-1 text-sm font-bold">Tick-price technical context</h3><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Calculated from validated quotes in the latest 1,000 ticks. These describe recent price behaviour; they do not by themselves establish a profitable next-outcome signal.</p></div>
        <div className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">N <span className="mono ml-1 font-semibold text-foreground">{analysis.sampleSize}</span><span className="ml-2">as of {asOf}</span></div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {priceMetrics.map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">{label}</div><div className="mono mt-1 text-xs font-semibold">{value}</div></div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">MACD · 12 / 26 / 9</div><div className="mono mt-1 text-[10px] font-semibold">Line {formatIndicator(analysis.macdLine)} · Signal {formatIndicator(analysis.macdSignal)} · Hist {formatIndicator(analysis.macdHistogram)}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Confirmed tick swings · 3-tick pivot</div><div className="mt-1 text-[10px] font-semibold">{analysis.swingStructure}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Price-change quantiles · last 50</div><div className="mono mt-1 text-[10px] font-semibold">P05 {formatIndicator(analysis.priceChangeQuantiles50?.p05 ?? null)} · Median {formatIndicator(analysis.priceChangeQuantiles50?.p50 ?? null)} · P95 {formatIndicator(analysis.priceChangeQuantiles50?.p95 ?? null)}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Tick direction · last 50</div><div className="mono mt-1 text-[10px] font-semibold">↑ {formatMetric(analysis.positiveTickRate50 === null ? null : analysis.positiveTickRate50 * 100, 1)}% · ↓ {formatMetric(analysis.negativeTickRate50 === null ? null : analysis.negativeTickRate50 * 100, 1)}% · flat {formatMetric(analysis.unchangedTickRate50 === null ? null : analysis.unchangedTickRate50 * 100, 1)}%</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Return shape · last 50</div><div className="mono mt-1 text-[10px] font-semibold">Skew {formatMetric(analysis.returnSkewness50, 2)} · lag-1 autocorrelation {formatMetric(analysis.returnAutocorrelation1, 2)}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Bollinger bands · 20 ticks ±2σ</div><div className="mono mt-1 text-[10px] font-semibold">{analysis.bollinger20 ? `Lower ${formatQuote(analysis.bollinger20.lower, precision)} · Mid ${formatQuote(analysis.bollinger20.mid, precision)} · Upper ${formatQuote(analysis.bollinger20.upper, precision)}` : 'Need 20 valid quotes'}</div></div>
      </div>
    </section>
  );
}

function ContractTable({ result }: { result: DigitMarketAnalysis }) {
  const rows = result.contracts.slice(0, result.family === 'over-under' ? 8 : 10);
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="contract-ranking">
      <div className="eyebrow">{shortMarketName(result.name)} · every contract</div>
      <h3 className="mt-1 text-sm font-bold">{result.family === 'over-under' ? 'Barriers ranked by confidence' : result.family === 'even-odd' ? 'Even vs Odd' : 'Target digits ranked by confidence'}</h3>
      <div className="mt-3 space-y-2">
        {rows.map((signal, index) => (
          <div key={signal.label} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2 ${index === 0 ? 'border-primary/30 bg-primary/5' : 'border-border bg-background/25'}`} data-testid={`contract-row-${signal.label.replace(/\s+/g, '-')}`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2"><span className="text-xs font-extrabold">{signal.label}</span><StrengthBadge strength={signal.strength} className="px-1.5 py-0.5 text-[8px]" /></div>
              <div className="mt-1 text-[10px] text-muted-foreground">{signal.tally.agreeing}/{signal.tally.total} engines agree · win {formatPercent(signal.probability)} vs fair {formatPercent(signal.fairProbability, 0)} · backtest {signal.backtest.winRate === null ? '—' : `${formatPercent(signal.backtest.winRate)} (n=${signal.backtest.sample})`}</div>
            </div>
            <div className="mono text-right text-sm font-extrabold">{signal.confidence}%</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LiveMarketPanel({ entry }: { entry: MarketFeedEntry | undefined }) {
  const recent = entry ? entry.ticks.slice(-24) : [];
  const latest = entry?.ticks.at(-1);
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="live-market-panel">
      <div className="flex items-center justify-between gap-3"><div><div className="eyebrow">Live market</div><h3 className="mt-1 text-sm font-bold">{entry?.name ?? 'Waiting for markets'}</h3></div><Activity size={18} className={entry?.fresh ? 'text-emerald-500' : 'text-muted-foreground'} /></div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Quote</div><div className="mono mt-1 text-sm font-semibold">{formatQuote(latest?.quote, entry?.precision ?? null)}</div></div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Last digit</div><div className="mono mt-1 text-sm font-semibold">{latest?.digit ?? '—'}</div></div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Ticks</div><div className="mono mt-1 text-sm font-semibold">{entry?.ticks.length ?? 0}</div></div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1" aria-label="Most recent final digits">
        {recent.map((tick) => (
          <span key={tick.epoch} className={`mono flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold ${tick.digit === null ? 'bg-secondary text-muted-foreground' : tick.digit % 2 === 0 ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300' : 'bg-violet-500/15 text-violet-600 dark:text-violet-300'}`}>{tick.digit ?? '·'}</span>
        ))}
        {!recent.length && <span className="text-[11px] text-muted-foreground">Waiting for live ticks…</span>}
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground">{entry ? (entry.fresh ? 'Live · updating' : entry.historyLoaded ? 'Waiting for the next live tick' : entry.error || 'Loading history…') : ''}</div>
    </section>
  );
}

function DigitContractTool({ family }: { family: DigitFamily }) {
  const feed = useMarketFeed();
  const scan = useSignalScan<DigitMarketAnalysis, DigitRunMeta>(`digit:${family}`);
  const [scope, setScope] = useState<string>(ALL_MARKETS);
  const [duration, setDuration] = useState<number>(() => scan.run?.meta.duration ?? 1);
  const [viewSymbol, setViewSymbol] = useState<string | null>(null);
  const [tradeMarket, setTradeMarket] = useState<string | null>(() => scan.run?.results[0]?.symbol ?? null);
  const [tradeExpiry, setTradeExpiry] = useState<number | null>(() => scan.run?.meta.duration ?? 1);
  const [applyRequest, setApplyRequest] = useState(0);
  const details = FAMILY_DETAILS[family];
  const run = scan.run;
  const markets = feed.markets;

  const durations = useMemo(() => {
    const reported = new Set<number>();
    for (const entry of markets) {
      for (const contract of entry.contracts) {
        if (FAMILY_CONTRACTS[family].includes(contract.contractType) && contract.expiryType.toLowerCase() === 'tick') {
          for (const ticks of supportedTickDurations(contract.minDuration, contract.maxDuration)) if (ticks <= 10) reported.add(ticks);
        }
      }
    }
    return reported.size ? [...reported].sort((a, b) => a - b) : DEFAULT_DURATIONS;
  }, [markets, family]);

  const selectedResult = run ? run.results.find((result) => result.symbol === viewSymbol) ?? run.results[0] : null;
  const isBest = Boolean(run && selectedResult && selectedResult.symbol === run.results[0].symbol);
  const signal = selectedResult?.best ?? null;
  const detailSymbol = selectedResult?.symbol ?? tradeMarket ?? (scope !== ALL_MARKETS ? scope : markets[0]?.symbol);
  const detailEntry = markets.find((entry) => entry.symbol === detailSymbol);
  const detailDigits = useMemo(() => digitTicksOf(detailEntry?.ticks ?? []), [detailEntry?.ticks]);
  const detailAnalysis = useMemo(() => analyzeDigits(detailDigits), [detailDigits]);
  const priceContext = useMemo(() => analyzePriceContext(detailEntry?.ticks ?? []), [detailEntry?.ticks]);
  const recommendation = selectedResult && signal ? recommendationFor(selectedResult, signal) : null;
  // Passed to the trade dock so it can pop open and offer Load and Run.
  const analysis = selectedResult && signal
    ? {
        runId: run?.id ?? 0,
        confidence: signal.confidence,
        strength: signal.strength,
        marketName: selectedResult.name,
        ranAt: run?.ranAt ?? 0,
        entry: signal.entry,
        confirmation: {
          status: signal.deep.confirmation.status,
          edgePts: signal.deep.confirmation.edgePts,
          decisive: signal.deep.confirmation.decisive,
        },
      }
    : null;
  const tradeEntry = markets.find((entry) => entry.symbol === (tradeMarket ?? detailSymbol));

  async function handleRunAnalysis() {
    if (scan.scanning) return;
    const symbols = scope === ALL_MARKETS ? feed.getSnapshot().map((entry) => entry.symbol) : [scope];
    const next = await scan.start({
      symbols,
      minimumTicks: DIGIT_SIGNAL_MIN_TICKS,
      usableTicks: (entry) => entry.ticks.reduce((count, tick) => count + (tick.digit === null ? 0 : 1), 0),
      meta: { family, duration, scope },
      buildJobs: (entries) => {
        const jobs: ScanMarketJob[] = [];
        const skipped: ScanFailure[] = [];
        const usable = entries.filter((entry) => symbols.includes(entry.symbol));
        for (const entry of usable) {
          const ticks = digitTicksOf(entry.ticks);
          if (ticks.length < DIGIT_SIGNAL_MIN_TICKS) {
            skipped.push({ symbol: entry.symbol, name: entry.name, message: entry.error || (entry.ticks.length && !ticks.length ? 'digit precision unavailable' : `only ${ticks.length} ticks loaded`) });
            continue;
          }
          if (entry.tradingSuspended === true) { skipped.push({ symbol: entry.symbol, name: entry.name, message: 'trading suspended' }); continue; }
          const support = contractsFor(entry, family, duration);
          if (support.skip) { skipped.push({ symbol: entry.symbol, name: entry.name, message: support.skip }); continue; }
          jobs.push({ kind: 'digit', symbol: entry.symbol, name: entry.name, input: { family, symbol: entry.symbol, name: entry.name, horizon: duration, ticks, fresh: entry.fresh, contracts: support.contracts, marketsInScan: usable.length } });
        }
        return { jobs, skipped };
      },
    });
    if (next) {
      setViewSymbol(next.results[0].symbol);
      setTradeMarket(next.results[0].symbol);
      setTradeExpiry(next.meta.duration);
    }
  }

  return (
    <div className="animate-rise-in space-y-5 pt-5" data-testid={`${family}-analysis`}>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><div className="eyebrow">{details.eyebrow} · {ENGINE_COUNT} prediction engines + analysis layer</div><h2 className="mt-1 text-2xl font-extrabold tracking-[-0.04em] sm:text-3xl">{details.title}</h2><p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{details.description}</p></div>
        <FeedStatusBadge feed={feed} />
      </div>

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_auto] sm:items-end">
          <label className="block min-w-0">
            <span className="eyebrow">Markets to scan</span>
            <select value={scope} onChange={(event) => setScope(event.target.value)} disabled={scan.scanning} className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-semibold text-foreground outline-none focus:border-primary disabled:opacity-60" data-testid={`${family}-scope-select`} aria-label="Markets to scan">
              <option value={ALL_MARKETS}>All {markets.length} volatility markets · auto-pick the best</option>
              {markets.map((entry) => <option key={entry.symbol} value={entry.symbol}>{entry.name} · {entry.symbol}</option>)}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="eyebrow">Contract duration</span>
            <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={scan.scanning} className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-semibold text-foreground outline-none focus:border-primary disabled:opacity-60" data-testid={`${family}-duration-select`} aria-label="Contract duration in ticks">
              {durations.map((ticks) => <option key={ticks} value={ticks}>{durationLabel(ticks)}</option>)}
            </select>
          </label>
          {scan.scanning ? (
            <button type="button" onClick={scan.cancel} className="focus-ring flex h-11 items-center justify-center gap-2 rounded-lg border border-border bg-background px-5 text-sm font-bold text-foreground transition-colors hover:bg-secondary" data-testid="button-cancel-analysis">
              <Square size={14} fill="currentColor" /> Stop
            </button>
          ) : (
            <button type="button" onClick={handleRunAnalysis} className="focus-ring flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-6 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90" data-testid="button-run-analysis">
              <Play size={16} fill="currentColor" /> Run Analysis
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
          <span>{feed.loadedCount}/{markets.length} markets loaded</span>
          <span>{ENGINE_COUNT} prediction engines + {scan.run?.results[0]?.analysisEngineCount ?? 9} analysis engines per market, run in parallel</span>
          <span>{feed.usingTestAppId ? 'Deriv test app ID' : 'Configured Deriv app ID'}</span>
          {run && <span>Last scan {new Date(run.ranAt).toLocaleTimeString()} · {run.marketsScanned} markets · {(run.durationMs / 1000).toFixed(1)}s</span>}
        </div>
        {feed.error && <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400" role="status"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{feed.error}</div>}
      </section>

      {scan.progress && <AnalysisProgressPanel progress={scan.progress} engineCount={ENGINE_COUNT} />}
      {scan.error && !scan.progress && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert" data-testid="analysis-error"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{scan.error}</span></div>
      )}

      {run && selectedResult && signal ? (
        <section className={`grid gap-4 transition-opacity xl:grid-cols-[1.15fr_0.85fr] ${scan.scanning ? 'pointer-events-none opacity-40' : ''}`} aria-busy={scan.scanning} title={scan.scanning ? 'Previous signal — a new analysis is running' : undefined}>
          <div className="space-y-4">
            <SignalCard
              eyebrow={isBest ? `Best signal · ${run.marketsScanned} markets scanned` : `Signal · ${selectedResult.name}`}
              label={signal.label}
              direction={directionOf(signal.contract)}
              marketName={selectedResult.name}
              marketCode={selectedResult.symbol}
              duration={durationLabel(selectedResult.horizon)}
              confidence={signal.confidence}
              strength={signal.strength}
              tally={signal.tally}
              insight={explainSignal(signal.strength, signal.breakdown, signal.tally)}
              verified={signal.verified}
              generatedAt={run.ranAt}
              now={feed.now}
              notes={selectedResult.notes}
              metrics={[
                { label: 'Win chance', value: formatPercent(signal.probability), hint: 'Confirmed probability after out-of-sample calibration, stacking and the analysis check' },
                { label: 'Confirmed edge', value: `${signal.deep.confirmation.edgePts >= 0 ? '+' : ''}${signal.deep.confirmation.edgePts.toFixed(1)} pts`, hint: `${signal.deep.confirmation.status} · out-of-sample calibration ${signal.deep.confirmation.calibration.method}` },
                { label: 'Fair odds', value: formatPercent(signal.fairProbability, 0), hint: 'Win probability with uniformly random digits' },
                { label: 'Backtest', value: signal.backtest.winRate === null ? '—' : `${formatPercent(signal.backtest.winRate)} · ${signal.backtest.sample}`, hint: 'Held-out ticks where the engines favoured this contract: win rate and number of calls' },
                { label: 'History', value: signal.history?.rate == null ? '—' : `${formatPercent(signal.history.rate)}`, hint: signal.history ? `${signal.history.hits}/${signal.history.sample} ${signal.history.context}` : undefined },
                {
                  label: 'Entry point',
                  value: signal.entry.mode === 'immediate' ? 'Next tick' : 'Digit context',
                  hint: `When the bot opens this contract: ${signal.entry.detail}`,
                },
                {
                  label: 'Entry time',
                  value: signal.entry.mode === 'immediate' ? 'Signal tick' : signal.entry.expectedWaitTicks <= 1 ? 'Next matches' : `~${signal.entry.expectedWaitTicks} ticks`,
                  hint: `The entry stays valid for ${signal.entry.windowTicks} ticks; ${signal.entry.reachRate === null ? 'the reach rate is measured live' : `${Math.round(signal.entry.reachRate * 100)}% of replayed ticks matched`}.`,
                },
              ]}
              onUse={() => { setTradeMarket(selectedResult.symbol); setApplyRequest((value) => value + 1); }}
            />
            <ConfirmationPanel report={signal.deep.confirmation} />
            <EntryPlanCard
              entry={signal.entry}
              marketName={shortMarketName(selectedResult.name)}
              duration={durationLabel(selectedResult.horizon)}
              generatedAt={run.ranAt}
              now={feed.now}
            />
            <MarketRankingTable
              rows={run.results.map((result) => ({
                symbol: result.symbol, name: result.name, label: result.best.label, direction: directionOf(result.best.contract),
                duration: durationLabel(result.horizon), confidence: result.best.confidence, strength: result.best.strength,
                agreeing: result.best.tally.agreeing, total: result.best.tally.total, winChance: formatPercent(result.best.probability), fresh: result.fresh,
                entry: entryModeLabel(result.best.entry),
              }))}
              selected={selectedResult.symbol}
              onSelect={setViewSymbol}
              failures={run.failures}
            />
          </div>
          <div className="space-y-4">
            <EngineVotesPanel votes={signal.votes} title={`Why ${signal.label} on ${shortMarketName(selectedResult.name)}`} valueKind="probability" fair={signal.fairProbability} />
            <AnalysisEnginePanel state={selectedResult.state} marketName={selectedResult.name} />
            <ContractTable result={selectedResult} />
          </div>
        </section>
      ) : !scan.progress && (
        <section className="rounded-xl border border-dashed border-border bg-card/60 p-6 text-center" data-testid="analysis-empty">
          <Zap size={22} className="mx-auto text-primary" />
          <h3 className="mt-2 text-base font-bold">Press Run Analysis for a signal</h3>
          <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">The scan starts immediately, shows its progress as a percentage, and finishes with a signal, its confidence score and how many of the {ENGINE_COUNT} engines agree — for the strongest market and every other market scanned.</p>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <LiveMarketPanel entry={detailEntry} />
        <DigitFrequencyPanel analysis={detailAnalysis} marketName={detailEntry ? shortMarketName(detailEntry.name) : '—'} />
      </section>

      {family === 'over-under' && selectedResult && (
        <OverUnderEnginePanel report={selectedResult.report as unknown as OverUnderReport} isScanning={scan.scanning} />
      )}

      <PriceContextPanel precision={detailEntry?.precision ?? null} analysis={priceContext} />

      <DigitDeepPanel digits={detailDigits.map((tick) => tick.digit)} family={family} />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-background/45 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" />
        <span>Every engine is fitted on each market's own recent ticks with a train / tune / held-out split, so backtests never see the data they are scored on. Deriv's synthetic indices are generated by a random number generator: no model can guarantee a win, and confidence is evidence strength rather than a promise. Orders are only placed from the trade ticket after you confirm a live Deriv price.</span>
      </div>

      <TradeDock
        family={family}
        recommendation={recommendation}
        analysis={analysis}
        applyRequest={applyRequest}
        marketCode={tradeMarket ?? detailSymbol ?? null}
        marketName={tradeEntry?.name ?? null}
        marketChoices={markets.map((entry) => ({ code: entry.symbol, name: entry.name }))}
        onMarketChange={setTradeMarket}
        expiry={tradeExpiry}
        expiryOptions={durations}
        onExpiryChange={setTradeExpiry}
        contracts={tradeEntry?.contractsLoaded ? tradeEntry.contracts : undefined}
        expiryVerified={Boolean(tradeEntry?.contractsLoaded)}
      />
    </div>
  );
}

export function OverUnderTool() { return <DigitContractTool family="over-under" />; }
export function EvenOddTool() { return <DigitContractTool family="even-odd" />; }
export function MatchesTool() { return <DigitContractTool family="matches" />; }
