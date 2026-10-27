// Layer 6 on screen: the one decision the engines, the AI and the calculations
// produced together, how long it is worth acting on, and what invalidates it.
//
// The card leads with the verdict and the measured validity window rather than
// the raw probability, because that is the pair a user acts on: which call, and
// for how many ticks. Everything below it is the audit trail — the per-source
// pool with weights and skills, the decay curve the window came from, and the
// exact entry instruction the bot will follow.
import { ArrowDownRight, ArrowUpRight, BrainCircuit, CheckCircle2, Clock3, Crosshair, Gauge, Layers, MinusCircle, ShieldAlert, Sparkles, Timer, XCircle, Zap } from 'lucide-react';
import type { MasterDecision, MasterSourceId } from '@/lib/signal-engine/master-decision.ts';
import { formatPercent } from '@/components/signal/signal-ui';

const VERDICT: Record<MasterDecision['verdict'], {
  label: string;
  tone: string;
  dot: string;
  icon: typeof Zap;
  blurb: string;
}> = {
  TRADE_NOW: {
    label: 'Trade now',
    tone: 'border-emerald-500/45 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    icon: Zap,
    blurb: 'The edge cleared its own error bar and the entry is due on the next tick.',
  },
  TRADE_ON_ENTRY: {
    label: 'Trade on trigger',
    tone: 'border-sky-500/45 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    dot: 'bg-sky-500',
    icon: Crosshair,
    blurb: 'The edge is decisive and the planned entry earned its wait out of sample.',
  },
  SPECULATIVE: {
    label: 'Speculative',
    tone: 'border-amber-500/45 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    icon: ShieldAlert,
    blurb: 'The edge is real enough to watch but sits inside its own measurement error.',
  },
  NO_EDGE: {
    label: 'No measured edge',
    tone: 'border-border bg-background/50 text-muted-foreground',
    dot: 'bg-muted-foreground/50',
    icon: MinusCircle,
    blurb: 'The best candidate is still shown, but the analysis cannot certify a short-term entry.',
  },
};

const SOURCE_ORDER: MasterSourceId[] = ['engines', 'ai', 'analysis', 'research', 'neural', 'forge'];
const SOURCE_SHORT: Record<MasterSourceId, string> = {
  engines: 'Engines',
  ai: 'AI',
  analysis: 'Analysis',
  research: 'Research',
  neural: 'Neural',
  forge: 'Forge',
};

function formatPts(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function secondsText(ms: number): string {
  if (ms < 1_000) return '<1 s';
  const seconds = ms / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

function StatTile({ label, value, hint, tone = '' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/35 px-3 py-2" title={hint}>
      <div className="eyebrow">{label}</div>
      <div className={`mono mt-1 text-sm font-bold ${tone}`}>{value}</div>
    </div>
  );
}

export function MasterDecisionCard({
  master,
  marketName,
  duration,
  generatedAt,
  now,
}: {
  master: MasterDecision;
  marketName: string;
  duration: string;
  generatedAt: number;
  now: number;
}) {
  const meta = VERDICT[master.verdict];
  const Icon = meta.icon;
  const elapsed = Math.max(0, now - generatedAt);
  const remaining = Math.max(0, master.validity.ms - elapsed);
  const expired = remaining <= 0 && master.verdict !== 'NO_EDGE';
  const progress = master.validity.ms > 0 ? Math.min(100, (100 * remaining) / master.validity.ms) : 0;
  const directionUp = master.family === 'rise-fall' ? master.label === 'RISE' : null;
  const measured = master.sources.filter((source) => source.probability !== null);
  const curveMax = Math.max(
    0.5,
    ...master.validity.curve.map((point) => Math.abs(point.edgePts ?? 0)),
  );

  return (
    <article
      className="animate-rise-in rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5"
      data-testid="master-decision"
      data-verdict={master.verdict}
      data-valid-ticks={master.validity.ticks}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5">
            <Layers size={12} /> Layer 6 · master decision — engines + AI + calculations + entry
          </div>
          <h3 className="mt-1 flex items-center gap-2 text-sm font-bold">
            <BrainCircuit size={15} className="text-primary" />
            One call for {marketName} · {duration}
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] ${meta.tone}`}
            data-testid="master-verdict"
          >
            <Icon size={12} /> {meta.label}
          </span>
          <span className="mono inline-flex items-center gap-1.5 rounded-full border border-border bg-background/50 px-2 py-1 text-[10px] font-bold" data-testid="master-conviction">
            <Gauge size={11} /> Conviction {master.conviction}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`mono text-xl font-extrabold tracking-[-0.03em] ${master.verdict === 'NO_EDGE' ? 'text-muted-foreground' : master.edgePts >= 0 ? 'text-emerald-500' : 'text-rose-500'}`} data-testid="master-edge">
          {formatPts(master.edgePts)} pts
        </span>
        <span className="text-[11px] text-muted-foreground" data-testid="master-headline">{master.headline}</span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1.1fr_0.9fr]">
        <div className={`rounded-lg border p-3 ${expired ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-background/35'}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="eyebrow flex items-center gap-1"><Clock3 size={11} /> Valid for</div>
            <span className={`mono text-[10px] font-bold ${expired ? 'text-amber-500' : 'text-muted-foreground'}`}>
              {expired ? 'expired — re-run analysis' : `${Math.ceil(remaining / 1_000)}s left`}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="mono text-2xl font-extrabold leading-none" data-testid="master-validity">
              {master.validity.ticks} tick{master.validity.ticks === 1 ? '' : 's'}
            </span>
            <span className="text-xs font-semibold text-muted-foreground">~{secondsText(master.validity.ms)}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/60" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} aria-label="Signal validity remaining">
            <div className={`h-full rounded-full transition-[width] duration-500 ${expired ? 'bg-amber-500' : master.verdict === 'TRADE_NOW' || master.verdict === 'TRADE_ON_ENTRY' ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">
            {master.validity.method === 'measured-decay'
              ? `Measured on ${master.validity.sample} replayed signals: the edge fell from ${master.validity.initialEdgePts.toFixed(1)} to ${master.validity.finalEdgePts.toFixed(1)} pts by the end of the window.`
              : `Only ${master.validity.sample} replayed signals — the signal is treated as valid for the next tick.`}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <StatTile
            label="Edge z"
            value={master.edgeZ === null ? '—' : master.edgeZ.toFixed(2)}
            hint="Edge divided by its own measured standard error. 1.645 is the decisive threshold."
            tone={master.edgeZ !== null && master.edgeZ >= 1.645 ? 'text-emerald-500' : master.edgeZ !== null && master.edgeZ >= 0.5 ? 'text-amber-500' : ''}
          />
          <StatTile label="p (edge > 0)" value={master.pValue === null ? '—' : master.pValue < 0.001 ? '<0.1%' : formatPercent(master.pValue, 1)} hint="One-sided probability that the measured edge is not positive." />
          <StatTile label="Std error" value={master.standardError === null ? '—' : formatPercent(master.standardError, 2)} hint="Combined error bar of the published probability and the source pool." />
          <StatTile
            label="Sources"
            value={`${master.sources.filter((source) => source.weight > 0).length}/${master.sources.length}`}
            hint="Sources with measured out-of-sample skill that carried weight in the pool."
          />
        </div>
      </div>

      {/* Entry decision strip */}
      <div className={`mt-3 rounded-lg border px-3 py-2.5 ${master.entry.action === 'no-edge' ? 'border-border bg-background/40' : 'border-primary/35 bg-primary/5'}`} data-testid="master-entry">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="inline-flex items-center gap-1 font-bold uppercase tracking-[0.08em] text-primary">
            <Timer size={12} /> Entry
          </span>
          <span className="font-semibold" data-testid="master-entry-action">
            {master.entry.action === 'enter-now' ? 'Next tick' : master.entry.action === 'enter-on-trigger' ? `On the ${master.entry.trigger === 'digit' ? 'tick context' : 'planned level'}` : 'No certified entry'}
          </span>
          {master.entry.action !== 'no-edge' && (
            <span className="mono rounded-md border border-border bg-background/50 px-1.5 py-0.5 text-[10px] font-semibold">
              window {master.entry.windowTicks} tick{master.entry.windowTicks === 1 ? '' : 's'} · ~{secondsText(master.entry.windowMs)}
            </span>
          )}
          {master.entry.validated && (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 size={10} /> validated out of sample
            </span>
          )}
          {master.entry.reachRate !== null && (
            <span className="text-[10px] text-muted-foreground">reach {Math.round(master.entry.reachRate * 100)}%</span>
          )}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/85" data-testid="master-entry-instruction">
          {master.entry.instruction}
        </p>
      </div>

      {/* Per-source pool */}
      <div className="mt-3 rounded-lg border border-border bg-background/30 p-3" data-testid="master-sources">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="eyebrow">Evidence pool · weighted by measured out-of-sample skill</div>
          <div className="text-[9px] text-muted-foreground">
            {master.pooled
              ? `Pooled at ${formatPercent(master.pooled.probability)} · ${Math.round(master.pooled.support * 100)}% of weight supports this side`
              : 'No source cleared the skill bar — the decision rests on the audited chain alone'}
            {master.reconciled ? ' · chain reconciled toward the pool' : ''}
          </div>
        </div>
        <div className="mt-2 space-y-1.5">
          {SOURCE_ORDER.map((id) => master.sources.find((source) => source.id === id)).filter(Boolean).map((source) => {
            const item = source!;
            const isSupport = item.stance === 'supports';
            const isAgainst = item.stance === 'opposes';
            return (
              <div key={item.id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-2" data-testid={`master-source-${item.id}`}>
                <div className="text-[10px] font-bold">{SOURCE_SHORT[item.id]}</div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/50">
                      <div className={`h-full rounded-full ${item.weight > 0 ? 'bg-primary/80' : 'bg-muted-foreground/25'}`} style={{ width: `${Math.max(2, item.weight * 100)}%` }} />
                    </div>
                    <span className="mono w-14 shrink-0 text-right text-[9px] text-muted-foreground">{Math.round(item.weight * 100)}% wt</span>
                  </div>
                  <div className="mt-0.5 truncate text-[9px] text-muted-foreground" title={item.detail}>
                    {item.skill === null ? 'no measured skill' : `skill ${item.skill >= 0 ? '+' : ''}${(item.skill * 100).toFixed(1)}% on ${item.sample} rows`}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`mono text-[11px] font-bold ${isSupport ? 'text-emerald-500' : isAgainst ? 'text-rose-500' : 'text-muted-foreground'}`}>
                    {item.probability === null ? '—' : formatPercent(item.probability)}
                  </div>
                  <div className="text-[8px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                    {item.stance === 'unmeasured' ? 'no view' : item.stance}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Decay curve */}
      {master.validity.curve.length > 0 && (
        <div className="mt-3 rounded-lg border border-border bg-background/30 p-3" data-testid="master-decay">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="eyebrow">Edge decay · how long the signal stays worth entering</div>
            <div className="text-[9px] text-muted-foreground">
              {master.validity.stability * 3}/3 chronological thirds agreed
              {master.validity.halfLifeTicks !== null ? ` · half-life ${master.validity.halfLifeTicks} ticks` : ''}
            </div>
          </div>
          <div className="mt-2 flex items-end gap-1" role="img" aria-label="Measured edge by entry delay">
            {master.validity.curve.map((point) => {
              const edge = point.edgePts;
              const height = edge === null ? 2 : Math.max(2, (Math.abs(edge) / curveMax) * 34);
              const inWindow = point.lag > 0 && point.lag <= master.validity.ticks;
              const immediate = point.lag === 0;
              return (
                <div key={point.lag} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={point.rate === null ? `Lag ${point.lag}: not observable` : `Delay ${point.lag} ticks: ${formatPercent(point.rate)} hit rate, ${formatPts(edge ?? 0)} pts (${point.sample} rows)`}>
                  <div
                    className={`w-full rounded-sm ${edge === null ? 'bg-border' : edge >= 0 ? (immediate ? 'bg-primary' : inWindow ? 'bg-emerald-500/80' : 'bg-emerald-500/25') : 'bg-rose-500/40'}`}
                    style={{ height: `${height}px` }}
                  />
                  <span className={`mono text-[8px] ${inWindow || immediate ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>{point.lag}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex items-center justify-between text-[8px] text-muted-foreground">
            <span>0 = enter at the signal</span>
            <span>entry delay in ticks →</span>
          </div>
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-background/30 p-3">
          <div className="eyebrow flex items-center gap-1"><Sparkles size={11} /> Why this call</div>
          <ul className="mt-1.5 space-y-1 text-[10px] leading-relaxed text-muted-foreground" data-testid="master-reasons">
            {master.reasons.map((reason) => <li key={reason}>• {reason}</li>)}
          </ul>
        </div>
        <div className="rounded-lg border border-border bg-background/30 p-3">
          <div className="eyebrow flex items-center gap-1"><XCircle size={11} /> Invalidated by</div>
          <ul className="mt-1.5 space-y-1 text-[10px] leading-relaxed text-muted-foreground" data-testid="master-invalidations">
            {master.invalidate.map((reason) => <li key={reason}>• {reason}</li>)}
          </ul>
        </div>
      </div>

      <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
        <ShieldAlert size={9} className="mr-1 inline" />
        {meta.blurb} Conviction is an evidence score for the decision, not a guaranteed win rate. Synthetic indices are random; trade responsibly.
        {directionUp !== null && <span className="ml-1">{directionUp ? <ArrowUpRight size={9} className="inline" /> : <ArrowDownRight size={9} className="inline" />} Direction is strict: a flat expiry loses both sides.</span>}
        {measured.length === 0 && <span className="ml-1">No independent source measured a view on this market.</span>}
      </p>
    </article>
  );
}
