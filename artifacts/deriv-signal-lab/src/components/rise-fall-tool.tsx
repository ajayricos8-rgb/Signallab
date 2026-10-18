import { useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Clock3, Play, Radio, ShieldAlert, Square, TrendingDown, Wifi, WifiOff, Zap } from 'lucide-react';
import { TradeDock } from '@/components/trade-dock';
import { EngineLabPanel } from '@/components/signal/engine-lab-panel';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { scopeSettlements } from '@/lib/engine-lab/execution';
import { digitTicksOf } from '@/lib/market-feed';
import { EntryPlanCard } from '@/components/signal/entry-plan-card';
import { RiseFallDeepPanel } from '@/components/quant/rise-fall-deep-panel';
import { PriceContextPanel } from '@/components/digit-contract-tools';
import { useMarketFeed, type MarketFeedValue } from '@/components/market-feed-provider';
import { useSignalScan } from '@/hooks/use-signal-scan';
import {
  AnalysisEnginePanel, AnalysisProgressPanel, ConfirmationPanel, EngineVotesPanel, MarketRankingTable, SignalCard, StrengthBadge, formatPercent, shortMarketName,
} from '@/components/signal/signal-ui';
import { analyzeRiseFall, type MarketTick, type RiseFallAnalysis } from '@/lib/rise-fall-analysis';
import { analyzePriceContext } from '@/lib/price-context';
import {
  RISE_FALL_ENGINES, RISE_FALL_MIN_TICKS, formatRiseFallHorizon,
  type RiseFallHorizonSignal, type RiseFallMarketAnalysis,
} from '@/lib/signal-engine/rise-fall-signal';
import type { ScanFailure, ScanMarketJob } from '@/lib/signal-engine/scan-runner';
import type { TradeRecommendation } from '@/lib/trade-draft';
import { explainSignal } from '@/lib/signal-engine/confidence';
import { entryModeLabel } from '@/lib/signal-engine/entry.ts';

const ALL_MARKETS = 'all';
const ENGINE_COUNT = RISE_FALL_ENGINES.length;
// The trade ticket accepts tick expiries 1–10; minute signals use the minutes field.
const DRAFT_TICK_EXPIRIES = Array.from({ length: 10 }, (_, index) => index + 1);

type RiseFallRunMeta = { scope: string };

function formatQuote(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 2 }).format(value);
}

function formatPct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`;
}

function formatSigned(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function recommendationFor(result: RiseFallMarketAnalysis, signal: RiseFallHorizonSignal): TradeRecommendation {
  return {
    symbol: result.symbol,
    contractType: signal.direction === 'RISE' ? 'CALL' : 'PUT',
    duration: signal.horizon.value,
    durationUnit: signal.horizon.unit === 'ticks' ? 't' : 'm',
    label: signal.direction,
  };
}

function FeedBadge({ feed }: { feed: MarketFeedValue }) {
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
    <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${tone}`} aria-live="polite" data-testid="deriv-feed-status">
      {live ? <Wifi size={14} /> : feed.status === 'error' ? <WifiOff size={14} /> : <Radio size={14} className="animate-pulse-line" />}
      {label}
    </div>
  );
}

function PricePath({ ticks, marketName }: { ticks: MarketTick[]; marketName: string }) {
  const points = ticks.slice(-100);
  if (points.length < 2) {
    return (
      <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-4 text-center text-sm text-muted-foreground">
        Waiting for valid Deriv tick history. No sample or simulated prices are shown.
      </div>
    );
  }
  const quotes = points.map(({ quote }) => quote);
  const minimum = Math.min(...quotes);
  const maximum = Math.max(...quotes);
  const spread = maximum - minimum || Math.max(Math.abs(maximum) * 0.000001, 1);
  const chartWidth = 900;
  const chartHeight = 180;
  const padding = 8;
  const coordinates = quotes.map((quote, index) => {
    const x = padding + (index / (quotes.length - 1)) * (chartWidth - padding * 2);
    const y = chartHeight - padding - ((quote - minimum) / spread) * (chartHeight - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const last = coordinates.at(-1)!.split(',').map(Number);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background/40 px-2 py-3">
      <svg className="h-44 w-full" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`${marketName} validated tick price path`}>
        <polyline points={coordinates.join(' ')} fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={last[0]} cy={last[1]} r="4" fill="hsl(var(--primary))" />
      </svg>
      <div className="flex justify-between px-2 text-[10px] text-muted-foreground mono">
        <span>{formatQuote(quotes[0])}</span>
        <span>{marketName} · {points.length} latest ticks</span>
        <span>{formatQuote(quotes.at(-1))}</span>
      </div>
    </div>
  );
}

function WindowTable({ analysis }: { analysis: RiseFallAnalysis }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-card-border bg-card/80">
      <table className="w-full min-w-[420px] text-left text-xs">
        <thead><tr className="border-b border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><th className="px-3 py-3">Window</th><th className="px-3 py-3">Read</th><th className="px-3 py-3 text-right">Score</th></tr></thead>
        <tbody>{analysis.windows.map((window) => (
          <tr key={window.window} className="border-b border-border/60 last:border-0">
            <td className="px-3 py-2.5 font-semibold">{window.window} ticks</td>
            <td className="px-3 py-2.5 text-muted-foreground">{window.direction}</td>
            <td className="px-3 py-2.5 text-right mono">{formatSigned(window.score)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function HistoricalOutcomeCard({ marketName, signal }: { marketName: string; signal: RiseFallHorizonSignal | null }) {
  const historical = signal?.historical ?? null;
  const sample = historical?.sample ?? 0;
  const items = [
    { name: 'Rise', count: historical?.rise ?? 0, tone: 'bg-emerald-500' },
    { name: 'Fall', count: historical?.fall ?? 0, tone: 'bg-rose-500' },
    { name: 'Unchanged', count: historical?.unchanged ?? 0, tone: 'bg-muted-foreground/50' },
  ];
  return (
    <article className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="expiry-baseline">
      <div className="flex items-center justify-between gap-3">
        <div><div className="eyebrow">{signal ? `Recent outcomes · ${formatRiseFallHorizon(signal.horizon)}` : 'Recent outcomes'}</div><h3 className="mt-1 text-base font-bold">{marketName}</h3></div>
        <BarChart3 size={17} className="text-primary" />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{historical ? `${sample} completed comparisons over the latest ~500 ticks. Rise is exit > entry; Fall is exit < entry.` : 'Run Analysis to see outcomes at the selected duration.'}</p>
      <div className="mt-4 space-y-3">
        {items.map((item) => {
          const share = sample ? (item.count / sample) * 100 : 0;
          return <div key={item.name}>
            <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">{item.name}</span><span className="mono font-semibold">{historical ? `${item.count} · ${share.toFixed(1)}%` : '—'}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full ${item.tone}`} style={{ width: `${share}%` }} /></div>
          </div>;
        })}
      </div>
    </article>
  );
}

function DurationTable({ result }: { result: RiseFallMarketAnalysis }) {
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="duration-ranking">
      <div className="eyebrow">{shortMarketName(result.name)} · all {result.horizons.length} durations</div>
      <h3 className="mt-1 text-sm font-bold">Durations ranked by confidence</h3>
      <div className="mt-3 space-y-2">
        {result.horizons.slice(0, 8).map((signal, index) => (
          <div key={`${signal.horizon.unit}-${signal.horizon.value}`} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2 ${index === 0 ? 'border-primary/30 bg-primary/5' : 'border-border bg-background/25'}`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2"><span className={`text-xs font-extrabold ${signal.direction === 'RISE' ? 'text-emerald-500' : 'text-rose-500'}`}>{signal.direction}</span><span className="text-xs font-semibold">{formatRiseFallHorizon(signal.horizon)}</span><StrengthBadge strength={signal.strength} className="px-1.5 py-0.5 text-[8px]" /></div>
              <div className="mt-1 text-[10px] text-muted-foreground">{signal.tally.agreeing}/{signal.tally.total} engines agree · backtest {signal.backtest.winRate === null ? '—' : `${formatPercent(signal.backtest.winRate)} (n=${signal.backtest.sample})`} · AI P(rise) {formatPercent(signal.aiProbability)}</div>
            </div>
            <div className="mono text-right text-sm font-extrabold">{signal.confidence}%</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function RiseFallTool() {
  const trading = useDerivTrading();
  const feed = useMarketFeed();
  const scan = useSignalScan<RiseFallMarketAnalysis, RiseFallRunMeta>('rise-fall');
  const [scope, setScope] = useState<string>(ALL_MARKETS);
  const [viewSymbol, setViewSymbol] = useState<string | null>(null);
  const [draftMarketCode, setDraftMarketCode] = useState<string | null>(() => scan.run?.results[0]?.symbol ?? null);
  const [draftExpiry, setDraftExpiry] = useState<number | null>(1);
  const [applyRequest, setApplyRequest] = useState(0);
  const markets = feed.markets;
  const run = scan.run;

  const selectedResult = run ? run.results.find((result) => result.symbol === viewSymbol) ?? run.results[0] : null;
  const isBest = Boolean(run && selectedResult && selectedResult.symbol === run.results[0].symbol);
  const signal = selectedResult?.best ?? null;
  const chartSymbol = selectedResult?.symbol ?? draftMarketCode ?? (scope !== ALL_MARKETS ? scope : markets.find((entry) => entry.ticks.length > 1)?.symbol ?? markets[0]?.symbol);
  const chartEntry = markets.find((entry) => entry.symbol === chartSymbol);
  const chartTicks = chartEntry?.ticks ?? [];
  const liveAnalysis = useMemo(() => analyzeRiseFall(chartTicks.slice(-500), 5), [chartTicks]);
  const priceContext = useMemo(() => analyzePriceContext(chartTicks), [chartTicks]);
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
        researchDecision: signal.researchDecision,
        research: signal.research,
        confirmation: {
          status: signal.deep.confirmation.status,
          edgePts: signal.deep.confirmation.edgePts,
          decisive: signal.deep.confirmation.decisive,
        },
      }
    : null;
  const draftMarket = draftMarketCode ?? chartSymbol ?? null;

  async function handleRunAnalysis() {
    if (scan.scanning) return;
    const symbols = scope === ALL_MARKETS ? feed.getSnapshot().map((entry) => entry.symbol) : [scope];
    const next = await scan.start({
      symbols,
      minimumTicks: RISE_FALL_MIN_TICKS,
      usableTicks: (entry) => entry.ticks.length,
      meta: { scope },
      buildJobs: (entries) => {
        const jobs: ScanMarketJob[] = [];
        const skipped: ScanFailure[] = [];
        const usable = entries.filter((entry) => symbols.includes(entry.symbol));
        for (const entry of usable) {
          if (entry.ticks.length < RISE_FALL_MIN_TICKS) { skipped.push({ symbol: entry.symbol, name: entry.name, message: entry.error || `only ${entry.ticks.length} ticks loaded` }); continue; }
          if (entry.tradingSuspended === true) { skipped.push({ symbol: entry.symbol, name: entry.name, message: 'trading suspended' }); continue; }
          jobs.push({
            kind: 'rise-fall', symbol: entry.symbol, name: entry.name,
            input: { symbol: entry.symbol, name: entry.name, ticks: entry.ticks.map(({ epoch, quote }) => ({ epoch, quote })), digitTicks: digitTicksOf(entry.ticks), settlements: scopeSettlements(trading.closedPositions, entry.symbol, 'rise-fall', trading.currency), settlementCurrency: trading.currency, fresh: entry.fresh, marketsInScan: usable.length },
          });
        }
        return { jobs, skipped };
      },
    });
    if (next) {
      setViewSymbol(next.results[0].symbol);
      setDraftMarketCode(next.results[0].symbol);
    }
  }

  return (
    <div className="animate-rise-in space-y-5 pt-5" data-testid="rise-fall-analysis">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="eyebrow">Rise/Fall · {ENGINE_COUNT} base predictors · 300-entry research library</div>
          <h2 className="mt-1 text-2xl font-extrabold tracking-[-0.04em] sm:text-3xl">Rise/Fall signals</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Scan every volatility market across 25 durations (1–10 ticks, 1–15 minutes). The 300-entry library measures trend, momentum, completed candles, volatility, price structure and sequence statistics. It independently audits the existing 14-model predictor with purged chronological validation, explains every reading and filters automatic entry when evidence is weak. Flat expiry loses both strict directions.</p>
        </div>
        <FeedBadge feed={feed} />
      </div>

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="block min-w-0">
            <span className="eyebrow">Markets to scan · duration is chosen automatically</span>
            <select value={scope} onChange={(event) => setScope(event.target.value)} disabled={scan.scanning} className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-semibold text-foreground outline-none focus:border-primary disabled:opacity-60" data-testid="rise-fall-scope-select" aria-label="Markets to scan">
              <option value={ALL_MARKETS}>All {markets.length} volatility markets · auto-pick the best</option>
              {markets.map((entry) => <option key={entry.symbol} value={entry.symbol}>{entry.name} · {entry.symbol}</option>)}
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
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
          <span>{feed.loadedCount}/{markets.length} markets loaded</span>
          <span>{feed.freshCount} currently live</span>
          <span>{ENGINE_COUNT} base predictors · 300 registered research entries · 12-model audit across 25 durations</span>
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
        <section className={`grid grid-cols-1 gap-4 transition-opacity xl:grid-cols-[1.15fr_0.85fr] ${scan.scanning ? 'pointer-events-none opacity-40' : ''}`} aria-busy={scan.scanning} title={scan.scanning ? 'Previous signal — a new analysis is running' : undefined} data-testid="analysis-summary">
          <div className="space-y-4">
            <SignalCard
              eyebrow={isBest ? `Best signal · ${run.marketsScanned} markets × 25 durations` : `Signal · ${selectedResult.name}`}
              label={signal.direction}
              direction={signal.direction === 'RISE' ? 'up' : 'down'}
              marketName={selectedResult.name}
              marketCode={selectedResult.symbol}
              duration={formatRiseFallHorizon(signal.horizon)}
              confidence={signal.confidence}
              strength={signal.strength}
              tally={signal.tally}
              insight={explainSignal(signal.strength, signal.breakdown, signal.tally)}
              generatedAt={run.ranAt}
              now={feed.now}
              notes={selectedResult.notes}
              metrics={[
                { label: 'Win chance', value: formatPercent(signal.winEstimate), hint: 'Confirmed probability for this direction after calibration, stacking and the analysis check' },
                { label: 'Confirmed edge', value: `${signal.deep.confirmation.edgePts >= 0 ? '+' : ''}${signal.deep.confirmation.edgePts.toFixed(1)} pts`, hint: `${signal.deep.confirmation.status} · out-of-sample calibration ${signal.deep.confirmation.calibration.method}` },
                { label: 'AI P(rise)', value: formatPercent(signal.aiProbability), hint: 'Raw logistic-regression meta-model output' },
                { label: 'Backtest', value: signal.backtest.winRate === null ? '—' : `${formatPercent(signal.backtest.winRate)} · ${signal.backtest.sample}`, hint: `Held-out ${signal.direction} calls at this duration: win rate and number of calls` },
                { label: 'Consensus', value: formatSigned(signal.consensusScore), hint: 'Skill-weighted engine score from -1 (fall) to +1 (rise)' },
                {
                  label: 'Research library',
                  value: signal.research.total ? `${signal.research.agreeing}/${signal.research.total}${signal.research.weight > 0 ? ` · ${signal.research.contributionPts >= 0 ? '+' : ''}${signal.research.contributionPts.toFixed(1)} pts` : ''}` : '—',
                  hint: signal.research.note,
                },
                {
                  label: 'Entry point',
                  value: signal.entry.mode === 'immediate' ? 'Next tick' : signal.entry.mode === 'pullback' ? `Pullback ${signal.entry.priceCondition === 'below' ? '↓' : '↑'}` : `Breakout ${signal.entry.priceCondition === 'above' ? '↑' : '↓'}`,
                  hint: `Where the bot waits to open the trade: ${signal.entry.detail}`,
                },
                {
                  label: 'Entry time',
                  value: signal.entry.mode === 'immediate' ? 'Signal tick' : `~${signal.entry.expectedWaitTicks} tick${signal.entry.expectedWaitTicks === 1 ? '' : 's'}${signal.entry.expectedWaitMs > 0 ? ` · ~${(signal.entry.expectedWaitMs / 1_000).toFixed(1)}s` : ''}`,
                  hint: `The entry stays valid for ${signal.entry.windowTicks} ticks; ${signal.entry.reachRate === null ? 'the reach rate is measured live' : `${Math.round(signal.entry.reachRate * 100)}% of replayed signals got there`}.`,
                },
              ]}
              onUse={() => { setDraftMarketCode(selectedResult.symbol); setApplyRequest((value) => value + 1); }}
            />
            <ConfirmationPanel report={signal.deep.confirmation} />
            <EntryPlanCard
              entry={signal.entry}
              marketName={shortMarketName(selectedResult.name)}
              duration={formatRiseFallHorizon(signal.horizon)}
              generatedAt={run.ranAt}
              now={feed.now}
            />
            <MarketRankingTable
              rows={run.results.map((result) => ({
                symbol: result.symbol, name: result.name, label: result.best.direction, direction: result.best.direction === 'RISE' ? 'up' : 'down',
                duration: formatRiseFallHorizon(result.best.horizon), confidence: result.best.confidence, strength: result.best.strength,
                agreeing: result.best.tally.agreeing, total: result.best.tally.total, winChance: formatPercent(result.best.winEstimate), fresh: result.fresh,
                entry: entryModeLabel(result.best.entry),
              }))}
              selected={selectedResult.symbol}
              onSelect={setViewSymbol}
              failures={run.failures}
            />
          </div>
          <div className="space-y-4">
            <EngineVotesPanel votes={signal.votes} title={`Why ${signal.direction} · ${formatRiseFallHorizon(signal.horizon)} on ${shortMarketName(selectedResult.name)}`} valueKind="score" />
            <AnalysisEnginePanel state={selectedResult.state} marketName={selectedResult.name} />
            <DurationTable result={selectedResult} />
          </div>
        </section>
      ) : !scan.progress && (
        <section className="rounded-xl border border-dashed border-border bg-card/60 p-6 text-center" data-testid="analysis-empty">
          <Zap size={22} className="mx-auto text-primary" />
          <h3 className="mt-2 text-base font-bold">Press Run Analysis for a signal</h3>
          <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">The scan starts immediately, shows its progress as a percentage, and finishes with a RISE or FALL signal, the best duration, its confidence score and how many of the {ENGINE_COUNT} engines agree.</p>
        </section>
      )}

      <EngineLabPanel report={selectedResult?.engineLab} />

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <article className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><div className="eyebrow">Validated tick price path</div><h3 className="mt-1 text-base font-bold">{chartEntry?.name ?? 'Waiting for markets'}</h3></div><div className="text-xs text-muted-foreground">{chartEntry?.fresh ? 'Live' : 'Waiting for live ticks'} · quote {formatQuote(chartTicks.at(-1)?.quote)}</div></div>
          <PricePath ticks={chartTicks} marketName={chartEntry?.name ?? ''} />
        </article>
        <HistoricalOutcomeCard marketName={chartEntry?.name ?? '—'} signal={selectedResult?.symbol === chartSymbol ? signal : null} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <article className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
          <div className="eyebrow">Rolling technical detail</div><h3 className="mt-1 text-base font-bold">{chartEntry?.name ?? '—'}</h3>
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div><div className="eyebrow">RSI · 14</div><div className="mt-1 font-bold mono">{liveAnalysis.rsi14 === null ? '—' : liveAnalysis.rsi14.toFixed(1)}</div></div>
            <div><div className="eyebrow">Volatility regime</div><div className="mt-1 font-bold">{liveAnalysis.volatilityRegime}</div></div>
            <div><div className="eyebrow">EMA · 9 / 21</div><div className="mt-1 font-bold mono">{formatQuote(liveAnalysis.ema9)} / {formatQuote(liveAnalysis.ema21)}</div></div>
            <div><div className="eyebrow">MACD histogram</div><div className="mt-1 font-bold mono">{formatQuote(liveAnalysis.macdHistogram)}</div></div>
            <div><div className="eyebrow">Swing structure</div><div className="mt-1 font-bold">{liveAnalysis.dowStructure}</div></div>
            <div><div className="eyebrow">100-tick breadth</div><div className="mt-1 font-bold mono">{formatPct(liveAnalysis.upPercent100)} up / {formatPct(liveAnalysis.downPercent100)} down</div></div>
            <div className="col-span-2 flex items-center gap-2 border-t border-border pt-3 text-muted-foreground"><Clock3 size={14} className="shrink-0 text-primary" />Trend {formatSigned(liveAnalysis.trendScore)} · momentum {formatSigned(liveAnalysis.momentumScore)} · swing {formatSigned(liveAnalysis.dowScore)} · breadth {formatSigned(liveAnalysis.breadthScore)} · ROC20 {formatSigned(liveAnalysis.rocScore)} · EMA50 {formatSigned(liveAnalysis.ema50Score)}</div>
          </div>
        </article>
        <div className="space-y-3"><div className="flex items-center gap-2"><TrendingDown size={16} className="text-primary" /><h3 className="text-sm font-bold">Rolling-window trend</h3></div><WindowTable analysis={liveAnalysis} /></div>
      </section>

      <PriceContextPanel precision={chartEntry?.precision ?? null} analysis={priceContext} />

      <RiseFallDeepPanel prices={chartTicks.map((tick) => tick.quote)} />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-background/45 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" />
        <span>Engine weights come from accuracy on one held-out slice and the backtest from a later one, so the score is never graded on data it was tuned on. Minute durations have less validation data than tick durations, which lowers their confidence. Volatility indices are random walks: confidence is evidence strength, not a guaranteed result. Orders are only placed from the trade ticket after you confirm a live Deriv price.</span>
      </div>

      <TradeDock
        family="rise-fall"
        recommendation={recommendation}
        analysis={analysis}
        applyRequest={applyRequest}
        marketCode={draftMarket}
        marketName={markets.find(({ symbol }) => symbol === draftMarket)?.name ?? null}
        marketChoices={markets.map((entry) => ({ code: entry.symbol, name: entry.name }))}
        onMarketChange={setDraftMarketCode}
        expiry={draftExpiry}
        expiryOptions={DRAFT_TICK_EXPIRIES}
        onExpiryChange={setDraftExpiry}
        expiryVerified={false}
      />
    </div>
  );
}
