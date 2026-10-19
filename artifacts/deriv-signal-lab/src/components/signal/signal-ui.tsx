// Shared signal UI for every tool: scan progress, the signal card with its
// confidence score and engine agreement, the engine vote list and the
// cross-market ranking.
import { ArrowDownRight, ArrowUpRight, BadgeCheck, BrainCircuit, CheckCircle2, CircleDashed, Cpu, Gauge, Loader2, MinusCircle, ShieldAlert, Sparkles, XCircle } from 'lucide-react';
import type { EngineVote, SignalStrength, VoteTally } from '@/lib/signal-engine/confidence';
import type { ConfirmationReport } from '@/lib/signal-engine/confirmation';
import type { DigitMarketState, QuoteMarketState } from '@/lib/signal-engine/market-state';
import type { AiSynthesis } from '@/lib/signal-engine/ai-synthesis';

export type MarketProgressState = 'queued' | 'running' | 'done' | 'failed' | 'waiting';

export type AnalysisProgressView = {
  percent: number;
  stage: string;
  detail?: string;
  completed: number;
  total: number;
  markets: Array<{ symbol: string; name: string; state: MarketProgressState; percent: number }>;
};

const STRENGTH_TONE: Record<SignalStrength, string> = {
  STRONG: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  MODERATE: 'border-sky-500/40 bg-sky-500/10 text-sky-500',
  WEAK: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
};

const STRENGTH_STROKE: Record<SignalStrength, string> = {
  STRONG: 'stroke-emerald-500',
  MODERATE: 'stroke-sky-500',
  WEAK: 'stroke-amber-500',
};

export function formatPercent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
}

export function formatAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

export function shortMarketName(name: string): string {
  return name.replace(/ Index$/, '').replace(/^Volatility /, 'Vol ');
}

export function StrengthBadge({ strength, className = '' }: { strength: SignalStrength; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.12em] ${STRENGTH_TONE[strength]} ${className}`} data-testid="signal-strength">
      {strength === 'STRONG' ? <Sparkles size={12} /> : strength === 'MODERATE' ? <CheckCircle2 size={12} /> : <ShieldAlert size={12} />}
      {strength}
    </span>
  );
}

export function ConfidenceRing({ value, strength, size = 104 }: { value: number; strength: SignalStrength; size?: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`Confidence ${clamped} out of 100`} data-testid="signal-confidence">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={radius} className="fill-none stroke-secondary" strokeWidth="9" />
        <circle
          cx="50" cy="50" r={radius}
          className={`fill-none ${STRENGTH_STROKE[strength]} transition-[stroke-dashoffset] duration-700`}
          strokeWidth="9" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="mono text-2xl font-extrabold leading-none">{clamped}<span className="text-sm">%</span></span>
        <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Confidence</span>
      </div>
    </div>
  );
}

/** Segmented bar: agree / neutral / against / abstain. */
export function VoteBar({ tally }: { tally: VoteTally }) {
  const segments = [
    { count: tally.agreeing, tone: 'bg-emerald-500', label: 'agree' },
    { count: tally.neutral, tone: 'bg-muted-foreground/40', label: 'neutral' },
    { count: tally.against, tone: 'bg-rose-500', label: 'against' },
    { count: tally.abstained, tone: 'bg-transparent border border-dashed border-muted-foreground/40', label: 'abstained' },
  ];
  return (
    <div className="flex h-2.5 w-full gap-0.5" aria-hidden="true">
      {segments.flatMap((segment) => Array.from({ length: segment.count }, (_, index) => (
        <span key={`${segment.label}-${index}`} className={`h-full flex-1 rounded-sm ${segment.tone}`} />
      )))}
    </div>
  );
}

export function AnalysisProgressPanel({ progress, engineCount }: { progress: AnalysisProgressView; engineCount: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  return (
    <section className="animate-rise-in rounded-xl border border-primary/30 bg-card/95 p-4 panel-glow sm:p-5" aria-live="polite" aria-busy="true" data-testid="analysis-progress">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow flex items-center gap-1.5"><Loader2 size={12} className="animate-spin text-primary" /> Analysis in progress</div>
          <div className="mt-1 truncate text-sm font-semibold" data-testid="analysis-progress-stage">{progress.stage}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{progress.detail ?? `${progress.completed} of ${progress.total} markets complete · ${engineCount} engines per market`}</div>
        </div>
        <div className="mono text-3xl font-extrabold tracking-[-0.04em] text-primary sm:text-4xl" data-testid="analysis-progress-percent">{percent}%</div>
      </div>
      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Analysis progress">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${percent}%` }} />
      </div>
      {progress.markets.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {progress.markets.map((market) => (
            <span
              key={market.symbol}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold ${market.state === 'done' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : market.state === 'running' ? 'border-primary/40 bg-primary/10 text-primary' : market.state === 'failed' ? 'border-rose-500/30 bg-rose-500/10 text-rose-500' : 'border-border bg-background/40 text-muted-foreground'}`}
              title={market.name}
            >
              {market.state === 'done' ? <CheckCircle2 size={11} /> : market.state === 'running' ? <Loader2 size={11} className="animate-spin" /> : market.state === 'failed' ? <XCircle size={11} /> : <CircleDashed size={11} />}
              {shortMarketName(market.name)}
              {market.state === 'running' && <span className="mono">{Math.round(market.percent)}%</span>}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export type SignalMetric = { label: string; value: string; hint?: string };

export type SignalCardProps = {
  eyebrow: string;
  label: string;
  direction: 'up' | 'down' | 'neutral';
  marketName: string;
  marketCode: string;
  duration: string;
  confidence: number;
  strength: SignalStrength;
  tally: VoteTally;
  metrics: SignalMetric[];
  generatedAt: number;
  now: number;
  verified?: boolean;
  /** Plain-language explanation of what drives the confidence. */
  insight?: string;
  notes?: string[];
  onUse?: () => void;
  useLabel?: string;
};

export function SignalCard(props: SignalCardProps) {
  const { tally } = props;
  const tone = props.direction === 'up' ? 'text-emerald-500' : props.direction === 'down' ? 'text-rose-500' : 'text-primary';
  return (
    <article className="signal-panel animate-rise-in rounded-xl border border-card-border p-4 panel-glow sm:p-6" data-testid="signal-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="eyebrow">{props.eyebrow}</div>
        <div className="flex flex-wrap items-center gap-2">
          {props.verified && <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold text-emerald-500"><BadgeCheck size={12} /> Verified edge</span>}
          <StrengthBadge strength={props.strength} />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className={`flex items-center gap-2 text-4xl font-extrabold tracking-[-0.05em] sm:text-5xl ${tone}`} data-testid="signal-label">
            {props.direction === 'up' ? <ArrowUpRight className="h-9 w-9 shrink-0 sm:h-11 sm:w-11" /> : props.direction === 'down' ? <ArrowDownRight className="h-9 w-9 shrink-0 sm:h-11 sm:w-11" /> : null}
            <span className="truncate">{props.label}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
            <span className="rounded-md border border-border bg-background/50 px-2 py-1" data-testid="signal-market">{props.marketName} <span className="mono text-muted-foreground">· {props.marketCode}</span></span>
            <span className="rounded-md border border-border bg-background/50 px-2 py-1" data-testid="signal-duration">{props.duration}</span>
          </div>
        </div>
        <ConfidenceRing value={props.confidence} strength={props.strength} />
      </div>
      <div className="mt-4 rounded-lg border border-border bg-background/40 p-3" data-testid="signal-engines">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-bold"><span className="mono text-emerald-500">{tally.agreeing}</span> of {tally.total} engines agree</div>
          <div className="text-[10px] text-muted-foreground">{tally.against} against · {tally.neutral} neutral{tally.abstained ? ` · ${tally.abstained} abstained` : ''} · {formatPercent(tally.weightedAgreement, 0)} skill-weighted</div>
        </div>
        <VoteBar tally={tally} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {props.metrics.map((metric) => (
          <div key={metric.label} className="rounded-lg border border-border bg-background/35 px-3 py-2" title={metric.hint}>
            <div className="eyebrow">{metric.label}</div>
            <div className="mono mt-1 text-sm font-bold">{metric.value}</div>
          </div>
        ))}
      </div>
      {props.insight && <p className="mt-3 rounded-lg border border-border bg-background/30 px-3 py-2 text-[11px] leading-relaxed text-foreground/80" data-testid="signal-insight">{props.insight}</p>}
      {props.notes && props.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-[11px] text-amber-600 dark:text-amber-400">{props.notes.map((note) => <li key={note}>• {note}</li>)}</ul>
      )}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-[10px] leading-relaxed text-muted-foreground">Generated {formatAgo(props.generatedAt, props.now)}. Confidence measures engine evidence (agreement, edge, held-out backtest, validation), not a guaranteed win rate. Synthetic indices are random; trade responsibly.</div>
        {props.onUse && (
          <button type="button" onClick={props.onUse} className="focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-primary/50 bg-primary/10 px-4 text-xs font-bold text-primary transition-colors hover:bg-primary/15" data-testid="button-use-signal">
            {props.useLabel ?? 'Use signal in trade ticket'}
          </button>
        )}
      </div>
    </article>
  );
}

export function EngineVotesPanel({ votes, title, valueKind, fair }: { votes: EngineVote[]; title: string; valueKind: 'probability' | 'score'; fair?: number }) {
  const ordered = [...votes].sort((a, b) => {
    const rank = { agree: 0, neutral: 1, against: 2, abstain: 3 } as const;
    return rank[a.vote] - rank[b.vote] || b.weight - a.weight;
  });
  const maxWeight = Math.max(0.0001, ...votes.map((vote) => vote.weight));
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="engine-votes">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><div className="eyebrow flex items-center gap-1.5"><Cpu size={12} /> Engine votes</div><h3 className="mt-1 text-sm font-bold">{title}</h3></div>
        {fair !== undefined && <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">Fair probability <span className="mono font-semibold text-foreground">{formatPercent(fair)}</span></span>}
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {ordered.map((vote) => (
          <div key={vote.id} className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 py-2" data-testid={`engine-vote-${vote.id}`}>
            {vote.vote === 'agree' ? <CheckCircle2 size={16} className="text-emerald-500" /> : vote.vote === 'against' ? <XCircle size={16} className="text-rose-500" /> : vote.vote === 'neutral' ? <MinusCircle size={16} className="text-muted-foreground" /> : <CircleDashed size={16} className="text-muted-foreground/60" />}
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">{vote.label}</div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1 w-20 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary/70" style={{ width: `${(vote.weight / maxWeight) * 100}%` }} /></div>
                <span className="truncate text-[9px] text-muted-foreground">{vote.vote === 'abstain' ? 'Not enough matching history to vote' : `weight ${formatPercent(vote.weight, 0)}${vote.skill !== null ? ` · skill ${vote.skill >= 0 ? '+' : ''}${(vote.skill * 100).toFixed(1)}%` : ''}`}</span>
              </div>
            </div>
            <div className="text-right">
              <div className={`text-[10px] font-bold uppercase ${vote.vote === 'agree' ? 'text-emerald-500' : vote.vote === 'against' ? 'text-rose-500' : 'text-muted-foreground'}`}>{vote.vote === 'abstain' ? 'abstain' : vote.vote}</div>
              <div className="mono text-[11px] font-semibold">{vote.value === null ? '—' : valueKind === 'probability' ? formatPercent(vote.value) : `${vote.value >= 0 ? '+' : ''}${vote.value.toFixed(2)}`}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export type RankingRow = {
  symbol: string;
  name: string;
  label: string;
  direction: 'up' | 'down' | 'neutral';
  duration: string;
  confidence: number;
  strength: SignalStrength;
  agreeing: number;
  total: number;
  winChance: string;
  fresh: boolean;
  /** Entry point/entry time the analysis planned for this market. */
  entry?: string;
};

export function MarketRankingTable({ rows, selected, onSelect, failures }: { rows: RankingRow[]; selected: string | null; onSelect: (symbol: string) => void; failures?: Array<{ symbol: string; name: string; message: string }> }) {
  const showEntry = rows.some((row) => Boolean(row.entry));
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="market-ranking">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><div className="eyebrow">Cross-market scan</div><h3 className="mt-1 text-sm font-bold">Every market ranked by confidence</h3></div>
        <span className="text-[10px] text-muted-foreground">Tap a market to inspect its signal</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              <th className="px-2 py-2">#</th><th className="px-2 py-2">Market</th><th className="px-2 py-2">Signal</th>{showEntry && <th className="px-2 py-2">Entry</th>}<th className="px-2 py-2">Confidence</th><th className="px-2 py-2">Engines</th><th className="px-2 py-2 text-right">Win chance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.symbol}
                onClick={() => onSelect(row.symbol)}
                className={`cursor-pointer border-b border-border/60 last:border-0 hover:bg-secondary/50 ${selected === row.symbol ? 'bg-primary/5' : ''}`}
                data-testid={`ranking-row-${row.symbol}`}
                aria-selected={selected === row.symbol}
              >
                <td className="px-2 py-2.5 mono text-muted-foreground">{index + 1}</td>
                <td className="px-2 py-2.5"><div className="font-semibold">{shortMarketName(row.name)}</div><div className="mono text-[10px] text-muted-foreground">{row.symbol}{row.fresh ? '' : ' · stale'}</div></td>
                <td className="px-2 py-2.5"><span className={`font-extrabold ${row.direction === 'up' ? 'text-emerald-500' : row.direction === 'down' ? 'text-rose-500' : 'text-primary'}`}>{row.label}</span><div className="text-[10px] text-muted-foreground">{row.duration}</div></td>
                {showEntry && <td className="px-2 py-2.5 text-[10px] text-muted-foreground" data-testid={`ranking-entry-${row.symbol}`}>{row.entry ?? '—'}</td>}
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-2"><span className="mono w-9 font-bold">{row.confidence}%</span><div className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full ${row.strength === 'STRONG' ? 'bg-emerald-500' : row.strength === 'MODERATE' ? 'bg-sky-500' : 'bg-amber-500'}`} style={{ width: `${row.confidence}%` }} /></div></div>
                  <div className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{row.strength}</div>
                </td>
                <td className="px-2 py-2.5 mono">{row.agreeing}/{row.total}</td>
                <td className="px-2 py-2.5 text-right mono">{row.winChance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failures && failures.length > 0 && (
        <div className="mt-2 text-[10px] text-muted-foreground">Skipped: {failures.map((failure) => `${shortMarketName(failure.name)} (${failure.message})`).join('; ')}</div>
      )}
    </section>
  );
}

const CONFIRMATION_TONE: Record<ConfirmationReport['status'], string> = {
  confirmed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  adjusted: 'border-sky-500/40 bg-sky-500/10 text-sky-500',
  cautious: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  contradicted: 'border-rose-500/40 bg-rose-500/10 text-rose-500',
};

/** Layer 1: every analysis engine, by its own measured work. */
export function AnalysisEnginePanel({
  state,
  marketName,
}: {
  state: DigitMarketState | QuoteMarketState;
  marketName: string;
}) {
  const significant = state.engines.filter((engine) => engine.strength > 0 || (engine.pValue !== null && engine.pValue < 0.05));
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="analysis-engines-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Cpu size={12} /> Layer 1 · analysis engines</div>
          <h3 className="mt-1 text-sm font-bold">{state.engines.length} engines measured {shortMarketName(marketName)}</h3>
        </div>
        <span className="rounded-full border border-border bg-background/50 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em]">{state.regime}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Predictability</div><div className="mono mt-1 text-sm font-bold">{formatPercent(state.predictability, 0)}</div></div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Analysis confidence</div><div className="mono mt-1 text-sm font-bold">{formatPercent(state.confidence, 0)}</div></div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Significant tests</div><div className="mono mt-1 text-sm font-bold">{significant.length}/{state.engines.length}</div></div>
      </div>
      <p className="mt-3 rounded-lg border border-border bg-background/30 px-3 py-2 text-[11px] leading-relaxed text-foreground/80">{state.summary}</p>
      <div className="mt-3 divide-y divide-border/60">
        {state.engines.map((engine) => (
          <div key={engine.id} className="py-2" data-testid={`analysis-engine-${engine.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-xs font-semibold">{engine.label}</div>
              <div className={`text-[10px] font-bold uppercase ${engine.strength > 0 ? 'text-primary' : 'text-muted-foreground'}`}>
                {engine.pValue === null ? 'descriptive' : `p ${engine.pValue.toFixed(4)}`}
              </div>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{engine.verdict}</div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1 w-24 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.round(engine.strength * 100)}%` }} /></div>
              <span className="text-[9px] text-muted-foreground">strength {formatPercent(engine.strength, 0)} · sample {engine.sample}</span>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Calculation detail</summary>
              <p className="mono mt-1 text-[10px] leading-relaxed text-muted-foreground">{engine.detail}</p>
            </details>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">The analysis layer only measures structure; it does not vote on a contract. Its validated prior is handed to the confirmation layer, which may move a probability by at most a couple of points.</p>
    </section>
  );
}

/** Layer 3: the calculation + AI confirmation of a prediction. */
export function ConfirmationPanel({ report }: { report: ConfirmationReport }) {
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="confirmation-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Sparkles size={12} /> Layer 3 · calculation + AI confirmation</div>
          <h3 className="mt-1 text-sm font-bold">Does the edge survive out of sample?</h3>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] ${CONFIRMATION_TONE[report.status]}`} data-testid="confirmation-status">
          {report.status}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Probability</div><div className="mono mt-1 text-sm font-bold">{formatPercent(report.probabilityBefore)} → {formatPercent(report.probability)}</div></div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Confirmed edge</div><div className="mono mt-1 text-sm font-bold">{report.edgePts >= 0 ? '+' : ''}{report.edgePts.toFixed(1)} pts</div></div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Calibration</div><div className="mono mt-1 text-sm font-bold">{report.calibration.method === 'none' ? 'kept raw' : report.calibration.method}</div></div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Decisive</div><div className={`mono mt-1 text-sm font-bold ${report.decisive ? 'text-emerald-500' : 'text-amber-500'}`}>{report.decisive ? 'yes' : 'not yet'}</div></div>
      </div>
      <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><span className="text-muted-foreground">Brier skill</span> <span className="mono font-semibold">{report.calibration.skill === null ? '—' : `${report.calibration.skill >= 0 ? '+' : ''}${(report.calibration.skill * 100).toFixed(1)}%`}</span><div className="text-[9px] text-muted-foreground">{report.calibration.evaluationSample} unseen rows</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><span className="text-muted-foreground">AI stack</span> <span className="mono font-semibold">{report.ai.stackSkill === null ? '—' : `${report.ai.stackSkill >= 0 ? '+' : ''}${(report.ai.stackSkill * 100).toFixed(1)}%`}</span><div className="text-[9px] text-muted-foreground">{report.ai.agreement > 0 ? 'agrees with the engines' : report.ai.agreement < 0 ? 'opposes the engines' : 'neutral'}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><span className="text-muted-foreground">Analysis check</span> <span className="mono font-semibold">{report.state.agreement > 0 ? 'supports' : report.state.agreement < 0 ? 'opposes' : 'neutral'}</span><div className="text-[9px] text-muted-foreground">{report.state.regime} · {formatPercent(report.state.predictability, 0)} predictability</div></div>
      </div>
      <ul className="mt-3 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
        {report.reasons.map((reason) => <li key={reason}>• {reason}</li>)}
      </ul>
    </section>
  );
}

/**
 * Layer 4: the measured error bar. This is the honest counterpart to the
 * headline probability -- it is the number a user should read before sizing a
 * stake, because it says how far the point estimate could plausibly move.
 */
export type PrecisionView = {
  standardError: number | null;
  interval: { probability: number; lower: number; upper: number } | null;
  reliability: { sample: number; miscalibration: number; expectedCalibrationError: number | null; brierSkillScore: number | null };
  shrinkFactor: number;
  beforePrecision?: number;
  selectionDebitPts: number;
  edgeZ: number | null;
};

export function PrecisionPanel({ block, candidates, fair }: { block: PrecisionView; candidates?: number; fair?: number }) {
  const se = block.standardError;
  const low = block.interval ? block.interval.lower : se === null ? null : (block.interval?.probability ?? 0) - 2 * se;
  const high = block.interval ? block.interval.upper : se === null ? null : (block.interval?.probability ?? 0) + 2 * se;
  const suppressed = block.shrinkFactor < 0.35;
  const clears = fair !== undefined && low !== null && low > fair;
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="precision-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Gauge size={12} /> Layer 4 · measured precision</div>
          <h3 className="mt-1 text-sm font-bold">How far could this estimate move?</h3>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] ${suppressed ? 'border-amber-500/40 bg-amber-500/10 text-amber-500' : clears ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-border bg-background/40 text-muted-foreground'}`} data-testid="precision-status">
          {suppressed ? 'not measurable' : clears ? 'clears fair odds' : 'measured'}
        </span>
      </div>
      {low !== null && high !== null ? (
        <div className="mt-3 rounded-lg border border-border bg-background/40 p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-muted-foreground">95% range for the true win rate</span>
            <span className="mono text-lg font-bold" data-testid="precision-interval">
              {formatPercent(low)} – {formatPercent(high)}
            </span>
          </div>
          <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-border/60">
            <div
              className="absolute inset-y-0 rounded-full bg-primary/70"
              style={{
                left: `${Math.max(0, Math.min(100, low * 100))}%`,
                right: `${Math.max(0, Math.min(100, 100 - high * 100))}%`,
              }}
            />
            {fair !== undefined ? (
              <div className="absolute inset-y-0 w-px bg-emerald-500" style={{ left: `${Math.max(0, Math.min(100, fair * 100))}%` }} title={`Fair odds ${formatPercent(fair, 0)}`} />
            ) : null}
          </div>
          <div className="mono mt-1.5 text-center text-[11px] font-semibold">{formatPercent(block.interval?.probability ?? 0)}</div>
        </div>
      ) : (
        <p className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Not enough held-out rows behind this contract to put a number on how far it could move. Treat the probability as unmeasured.
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2" title="How much of the raw edge survived out of sample">
          <div className="eyebrow">Edge kept</div>
          <div className="mono mt-1 text-sm font-bold">{formatPercent(block.shrinkFactor, 0)}</div>
        </div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2" title="Held-out ticks used to measure this">
          <div className="eyebrow">Sample</div>
          <div className="mono mt-1 text-sm font-bold">{block.reliability.sample} ticks</div>
        </div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2" title="Per-tick standard error of the estimate">
          <div className="eyebrow">Std error</div>
          <div className="mono mt-1 text-sm font-bold">{se === null ? '—' : se.toFixed(4)}</div>
        </div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2" title="How many contracts or durations the scan ranked before picking this one">
          <div className="eyebrow">Ranked</div>
          <div className="mono mt-1 text-sm font-bold">{candidates ?? 1}</div>
        </div>
      </div>
      <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><span className="text-muted-foreground">Edge z</span> <span className="mono font-semibold">{block.edgeZ === null ? '—' : block.edgeZ.toFixed(2)}</span><div className="text-[9px] text-muted-foreground">edge ÷ its own error</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><span className="text-muted-foreground">Calibration error</span> <span className="mono font-semibold">{block.reliability.expectedCalibrationError === null ? '—' : formatPercent(block.reliability.expectedCalibrationError)}</span><div className="text-[9px] text-muted-foreground">{block.reliability.brierSkillScore === null ? 'no holdout score' : `${(block.reliability.brierSkillScore * 100).toFixed(1)}% Brier skill`}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><span className="text-muted-foreground">Winner's curse</span> <span className="mono font-semibold">{block.selectionDebitPts > 0.05 ? `−${block.selectionDebitPts.toFixed(1)} pts` : 'none'}</span><div className="text-[9px] text-muted-foreground">{block.selectionDebitPts > 0.05 ? 'charged for winning the ranking' : 'stood out on its own'}</div></div>
      </div>
      <p className="mt-3 rounded-lg border border-border bg-background/30 px-3 py-2 text-[11px] leading-relaxed text-foreground/80" data-testid="precision-note">
        {suppressed
          ? 'This contract did not clear the pool-wide bar, so the precision layer pulled it back toward no edge. Trade it only if you accept that the measured edge is inside the noise.'
          : clears && fair !== undefined
            ? `Even the bottom of the range sits above the ${formatPercent(fair, 0)} fair odds, so the edge is not an artefact of how it was measured.`
            : block.selectionDebitPts > 0.05
              ? `The published number is already net of a ${block.selectionDebitPts.toFixed(1)} point charge for having been picked out of ${candidates ?? 1} candidates.`
              : `The published number stands on its own measured error bar, not on winning a ranking.`}
      </p>
    </section>
  );
}

/** Layer 5: the quant measurement suite and its rule-based AI verdict. */
export function AiSynthesisCard({ synthesis }: { synthesis: AiSynthesis }) {
  const stable = synthesis.consensus.direction !== null && synthesis.consensus.agreeing >= Math.ceil(synthesis.consensus.windows / 2);
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="ai-synthesis-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><BrainCircuit size={12} /> Layer 5 · quant engines + AI synthesis</div>
          <h3 className="mt-1 text-sm font-bold">Every angle, one verdict</h3>
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] ${stable ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-amber-500/40 bg-amber-500/10 text-amber-500'}`}
          data-testid="ai-synthesis-verdict"
        >
          {synthesis.verdict}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2">
          <div className="eyebrow">Cross-window stability</div>
          <div className="mono mt-1 text-sm font-bold">{synthesis.consensus.agreeing}/{synthesis.consensus.windows} windows</div>
          <div className="text-[9px] text-muted-foreground">{synthesis.consensus.direction ?? 'no stable direction'}</div>
        </div>
        <div className="rounded-lg border border-border bg-background/35 px-3 py-2">
          <div className="eyebrow">Measurement suite</div>
          <div className="mono mt-1 text-sm font-bold">{synthesis.family}</div>
          <div className="text-[9px] text-muted-foreground">distribution · runs · recurrence · spectrum · regime</div>
        </div>
      </div>
      <ul className="mt-3 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
        {synthesis.bullets.map((bullet) => <li key={bullet}>• {bullet}</li>)}
      </ul>
      <p className="mt-2 text-[10px] text-muted-foreground">{synthesis.risk}</p>
    </section>
  );
}
