// Bot store of the rebuilt shell: Deriv's quick-strategy forms and the AI bots
// Signal Lab ships. The catalog data itself lives in ./bot-store.ts and is kept
// byte-for-byte; only the presentation was rebuilt.
import { useMemo, useState } from 'react';
import { ArrowRight, BookOpen, BrainCircuit, CheckCircle2, Library, Search, ShieldAlert, Sparkles, X } from 'lucide-react';
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

  const featured = STRATEGIES.find((strategy) => strategy.id === 'STEP_INDEX_4T_HEDGE');

  return (
    <div className="ws-store" data-testid="dbot-store">
      <section className="ws-store-hero">
        <div className="ws-store-hero-glow" aria-hidden="true" />
        <div className="ws-store-hero-copy">
          <span className="ws-kicker"><Sparkles size={12} /> STRATEGY LIBRARY</span>
          <h3>A head start for your next bot.</h3>
          <p>
            Explore Deriv&rsquo;s quick strategies, set your own parameters, and open the generated blocks in the builder.
            The AI bots load as complete strategy files and keep their own settings in the &ldquo;Run once at start&rdquo; block.
          </p>
        </div>
        <div className="ws-store-count"><Library size={15} /> <span>{STRATEGIES.length} strategies</span></div>
      </section>

      {featured && (
        <section className="ws-featured" data-testid="dbot-store-featured">
          <div className="ws-featured-copy">
            <span className="ws-featured-icon"><BrainCircuit size={19} /></span>
            <div>
              <span className="ws-kicker"><Sparkles size={12} /> NEW IN THE STORE</span>
              <h4>{featured.name}</h4>
              <p>{featured.short}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => use(featured)}
            className="ws-primary-button"
            data-testid="dbot-use-featured"
          >
            Use strategy <ArrowRight size={13} />
          </button>
        </section>
      )}

      <div className="ws-store-toolbar">
        <div>
          <h3 className="ws-toolbar-title">Explore strategies</h3>
          <p className="ws-toolbar-sub">Free templates · customisable before use</p>
        </div>
        <div className="ws-store-filters">
          <label className="ws-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search strategies"
              aria-label="Search strategies"
              data-testid="dbot-store-search"
            />
          </label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as 'All' | StrategyCategory)}
            aria-label="Filter strategies"
            className="ws-select"
            data-testid="dbot-store-filter"
          >
            {CATEGORIES.map((entry) => <option key={entry}>{entry}</option>)}
          </select>
        </div>
      </div>

      <div className="ws-store-grid">
        {matching.map((strategy) => {
          const Icon = strategy.icon;
          return (
            <article
              key={strategy.id}
              className="ws-strategy-card"
              data-testid={`dbot-strategy-${strategy.id}`}
            >
              <div className="ws-strategy-top">
                <span className={`dbot-strategy-icon dbot-icon-${strategy.accent}`}><Icon size={19} /></span>
                <span className="ws-strategy-tag">{strategy.category}</span>
              </div>
              <h4>{strategy.name}</h4>
              <p className="ws-strategy-short">{strategy.short}</p>
              <div className="ws-strategy-foot">
                <button type="button" onClick={() => setDetails(strategy)} className="ws-text-button">
                  Learn more
                </button>
                <button
                  type="button"
                  onClick={() => use(strategy)}
                  className="ws-use-button"
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
        <div className="ws-empty">No strategies match that search. Try another term or filter.</div>
      )}

      <div className="ws-risk-note">
        <ShieldAlert size={17} />
        <p>
          <strong>Trade responsibly.</strong> These are staking templates and model-driven
          strategies, not predictions or guarantees. Every strategy can lose money; review the generated blocks and
          test on a demo account first.
        </p>
      </div>

      {details && (
        <div className="ws-details-backdrop" role="presentation" onMouseDown={() => setDetails(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="dbot-details-title"
            className="ws-details"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="ws-details-head">
              <div>
                <div className="ws-kicker"><BookOpen size={12} /> STRATEGY DETAILS</div>
                <h3 id="dbot-details-title">{details.name}</h3>
              </div>
              <button
                type="button"
                onClick={() => setDetails(null)}
                aria-label="Close strategy details"
                className="ws-details-close"
              >
                <X size={18} />
              </button>
            </div>
            <p className="ws-details-detail">{details.detail}</p>
            <p className="ws-details-risk"><strong>Risk note:</strong> {details.risk}</p>
            <div className="ws-details-actions">
              <button type="button" onClick={() => setDetails(null)} className="ws-button">Close</button>
              <button type="button" onClick={() => use(details)} className="ws-primary-button">
                <CheckCircle2 size={14} /> Use strategy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
