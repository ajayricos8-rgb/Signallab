// Entry plan panel: the second half of every Run Analysis result.
//
// The signal card says what to trade; this card says when to trade it — the
// entry point (quote level, or the digit context for the digit families), the
// entry time (ticks and clock estimate), how often the entry actually arrives
// inside the window, and the win-rate change the replay measured for it.
import { AlertTriangle, ArrowDown, ArrowUp, Clock3, Crosshair, Layers, Route, Timer } from 'lucide-react';
import { entryTier, type EntryPlan } from '@/lib/signal-engine/entry.ts';
import { StrengthBadge } from '@/components/signal/signal-ui';

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 1_000 ? 3 : Math.abs(value) >= 1 ? 4 : 6;
  return value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function formatWait(plan: EntryPlan): string {
  if (plan.mode === 'immediate') return 'next tick';
  if (plan.expectedWaitTicks <= 0) return 'usually the next tick';
  const ticks = `${plan.expectedWaitTicks} tick${plan.expectedWaitTicks === 1 ? '' : 's'}`;
  return plan.expectedWaitMs > 0 ? `~${ticks} · ~${(plan.expectedWaitMs / 1_000).toFixed(1)}s` : `~${ticks}`;
}

function StatTile({ label, value, hint, tone = '' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/35 px-3 py-2" title={hint}>
      <div className="eyebrow">{label}</div>
      <div className={`mono mt-1 text-sm font-bold ${tone}`}>{value}</div>
    </div>
  );
}

export function EntryPlanCard({
  entry,
  marketName,
  duration,
  generatedAt,
  now,
}: {
  entry: EntryPlan;
  marketName: string;
  duration: string;
  generatedAt: number;
  now: number;
}) {
  const tier = entryTier(entry);
  const levelLine =
    entry.mode === 'context'
      ? `${entry.contextLabel ?? 'digit context'}`
      : entry.mode === 'immediate'
        ? 'Signal price · next tick'
        : `${formatPrice(entry.priceLevel)} ${entry.priceCondition === 'below' ? '↓' : '↑'}`;
  const age = Math.max(0, Math.floor((now - generatedAt) / 1_000));
  const ago = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ${age % 60}s ago`;

  return (
    <article
      className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5"
      data-testid="entry-plan"
      data-entry-mode={entry.mode}
      data-entry-confidence={entry.confidence}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5">
            <Crosshair size={12} /> Entry point &amp; entry time
          </div>
          <h3 className="mt-1 text-sm font-bold">
            {entry.label} on {marketName} · {duration}
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!entry.measured && entry.mode !== 'immediate' && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.08em] text-amber-600 dark:text-amber-400"
              data-testid="entry-unmeasured"
              title="The replay reached this level on most signals but measured no win-rate gain from waiting for it."
            >
              <AlertTriangle size={10} /> No measured gain
            </span>
          )}
          <span
            className="mono inline-flex items-center gap-1 rounded-full border border-border bg-background/50 px-2 py-1 text-[10px] font-bold"
            data-testid="entry-confidence"
          >
            Entry confidence {entry.confidence}%
          </span>
          <StrengthBadge strength={tier} className="px-2 py-0.5 text-[9px]" />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="Entry point"
          value={levelLine}
          tone={entry.mode === 'context' || entry.mode === 'immediate' ? '' : 'text-primary'}
          hint={
            entry.mode === 'context'
              ? 'Digit contracts settle on the exit tick’s digit: the entry is the tick context, not a price.'
              : entry.mode === 'immediate'
                ? 'No level beat buying at the signal: the bot buys at the first price Deriv quotes.'
                : `The quote level the entry waits for (${entry.priceCondition === 'below' ? 'price ticks down to it' : 'price ticks up to it'}).`
          }
        />
        <StatTile
          label="Entry time"
          value={formatWait(entry)}
          hint="Median wait measured on the replayed signals that reached the entry."
        />
        <StatTile
          label="Valid for"
          value={`${entry.windowTicks} tick${entry.windowTicks === 1 ? '' : 's'}`}
          hint="How long the signal stays worth entering: past the window the bot uses its Entry setting (market or skip)."
        />
        <StatTile
          label="Entry reached"
          value={entry.reachRate === null ? 'measured live' : `${Math.round(entry.reachRate * 100)}%`}
          tone={(entry.reachRate ?? 0) >= 0.7 ? 'text-emerald-500' : (entry.reachRate ?? 0) >= 0.55 ? 'text-sky-500' : ''}
          hint={
            entry.sample
              ? `${Math.round((entry.reachRate ?? 0) * entry.sample)} of ${entry.sample} replayed signals reached the entry inside the window.`
              : undefined
          }
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Route size={11} />
          {entry.trigger === 'quote' ? 'Price-level trigger' : entry.trigger === 'digit' ? 'Tick-context trigger' : 'No trigger — market entry'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Timer size={11} />
          {entry.mode === 'immediate' ? 'bought at the signal price' : entry.priceCondition === 'below' ? 'waits for a lower price' : entry.priceCondition === 'above' ? 'waits for a higher price' : 'waits for the digit context'}
          {entry.priceCondition === 'below' ? <ArrowDown size={11} /> : entry.priceCondition === 'above' ? <ArrowUp size={11} /> : null}
        </span>
        <span className="inline-flex items-center gap-1">
          <Layers size={11} />
          {entry.sample
            ? `${entry.sample} replayed signal${entry.sample === 1 ? '' : 's'}${entry.edgeGainPts !== null ? ` · ${entry.edgeGainPts >= 0 ? '+' : ''}${entry.edgeGainPts.toFixed(1)} pts vs buying at the signal` : ''}`
            : 'not enough replayed signals to measure timing'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock3 size={11} />
          planned {ago}
        </span>
      </div>

      <p className="mt-3 rounded-lg border border-border bg-background/30 px-3 py-2 text-[11px] leading-relaxed text-foreground/80" data-testid="entry-detail">
        {entry.detail}
      </p>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        {entry.mode === 'immediate'
          ? 'Load and Run arms each run on this entry and buys at the first price Deriv quotes; the Entry setting on the trade menu can make it wait for a level instead.'
          : entry.measured
            ? 'Load and Run arms each run on this entry: it waits for the trigger, buys the contract when it fires, and if the window closes first it follows the Entry setting on the trade menu (enter at market, or skip the run).'
            : 'The replays did not confirm a win-rate gain from waiting, so the default Entry setting buys at the signal price. Choose “Always wait for the level” on the trade menu to have the bot wait for this level anyway.'}
      </p>
    </article>
  );
}
