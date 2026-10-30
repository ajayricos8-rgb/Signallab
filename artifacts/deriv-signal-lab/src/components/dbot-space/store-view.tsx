// The Bot store: Deriv's quick-strategy presets and the AI bots Signal Lab
// ships. The catalog itself lives in ./bot-store.ts and is unchanged.
import { useMemo, useState } from 'react';
import { ArrowRight, BookOpen, CheckCircle2, Library, Search, ShieldAlert, Sparkles, X } from 'lucide-react';
import { STRATEGIES, type Strategy, type StrategyCategory } from './bot-store';

const CATEGORIES: Array<'All' | StrategyCategory> = ['All', 'AI', 'Progression', 'Reverse progression', 'Sequence'];

export function StoreView({ onUse }: { onUse: (strategy: Strategy) => void }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'All' | StrategyCategory>('All');
  const [details, setDetails] = useState<Strategy | null>(null);

  const matching = useMemo(() => {
    const needle = search.toLowerCase().trim();
    return STRATEGIES.filter((strategy) => (
      (category === 'All' || strategy.category === category)
      && `${strategy.name} ${strategy.short} ${strategy.category}`.toLowerCase().includes(needle)
    ));
  }, [search, category]);

  function use(strategy: Strategy) {
    setDetails(null);
    onUse(strategy);
  }

  return (
    <div className="py-5" data-testid="dbot-store">
      <div className="dbot-store-intro flex flex-wrap items-center justify-between gap-5 rounded-xl border border-primary/20 p-5 sm:p-6">
        <div>
          <span className="dbot-kicker"><Sparkles size={12} /> STRATEGY LIBRARY</span>
          <h3 className="mt-2 text-xl font-extrabold tracking-[-.035em]">A head start for your next bot.</h3>
          <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">
            Explore Deriv&rsquo;s quick strategies, set your own parameters, and open the generated blocks in the builder.
            The AI bots load as complete strategy files and keep their own settings in the &ldquo;Run once at start&rdquo; block.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card/75 px-3 py-2 text-xs font-semibold">
          <Library size={15} className="text-primary" />
          <span>{STRATEGIES.length} strategies</span>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-extrabold">Explore strategies</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">Free templates · customisable before use</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search strategies"
              aria-label="Search strategies"
              data-testid="dbot-store-search"
              className="h-9 w-48 rounded-lg border border-border bg-card pl-9 pr-3 text-xs outline-none focus:border-primary"
            />
          </label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as 'All' | StrategyCategory)}
            aria-label="Filter strategies"
            className="h-9 rounded-lg border border-border bg-card px-3 text-xs font-semibold outline-none focus:border-primary"
            data-testid="dbot-store-filter"
          >
            {CATEGORIES.map((entry) => <option key={entry}>{entry}</option>)}
          </select>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {matching.map((strategy) => {
          const Icon = strategy.icon;
          return (
            <article
              key={strategy.id}
              className="dbot-strategy-card flex min-h-[210px] flex-col rounded-xl border border-border bg-card p-4"
              data-testid={`dbot-strategy-${strategy.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <span className={`dbot-strategy-icon dbot-icon-${strategy.accent}`}><Icon size={19} /></span>
                <span className="rounded-full border border-border px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground">
                  {strategy.category}
                </span>
              </div>
              <h4 className="mt-4 text-sm font-extrabold tracking-tight">{strategy.name}</h4>
              <p className="mt-1.5 flex-1 text-xs leading-5 text-muted-foreground">{strategy.short}</p>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                <button type="button" onClick={() => setDetails(strategy)} className="text-[11px] font-semibold text-muted-foreground hover:text-foreground">
                  Learn more
                </button>
                <button
                  type="button"
                  onClick={() => use(strategy)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-bold text-primary hover:underline"
                  data-testid={`dbot-use-${strategy.id}`}
                >
                  Use strategy <ArrowRight size={13} />
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {!matching.length && (
        <div className="mt-4 rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No strategies match that search. Try another term or filter.
        </div>
      )}

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[.06] p-4 text-xs leading-5 text-muted-foreground">
        <ShieldAlert size={17} className="mt-0.5 shrink-0 text-amber-500" />
        <p>
          <strong className="text-foreground">Trade responsibly.</strong> These are staking templates and model-driven
          strategies, not predictions or guarantees. Every strategy can lose money; review the generated blocks and
          test on a demo account first.
        </p>
      </div>

      {details && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
          role="presentation"
          onMouseDown={() => setDetails(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="dbot-details-title"
            className="max-h-[86dvh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="dbot-kicker"><BookOpen size={12} /> STRATEGY DETAILS</div>
                <h3 id="dbot-details-title" className="mt-2 text-xl font-extrabold">{details.name}</h3>
              </div>
              <button
                type="button"
                onClick={() => setDetails(null)}
                aria-label="Close strategy details"
                className="rounded-md p-1 text-muted-foreground hover:bg-secondary"
              >
                <X size={18} />
              </button>
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">{details.detail}</p>
            <p className="mt-4 rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-600 dark:text-amber-300">
              <strong>Risk note:</strong> {details.risk}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setDetails(null)} className="dbot-outline-button">Close</button>
              <button
                type="button"
                onClick={() => use(details)}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
              >
                <CheckCircle2 size={14} /> Use strategy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
