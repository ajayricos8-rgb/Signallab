import { useMemo, useState } from 'react';
import { Activity, Calculator, ShieldAlert } from 'lucide-react';
import { useMarketFeed } from '@/components/market-feed-provider';
import { calculateRiskScenario, summarizeDigits } from '@/lib/dbot-market-tools';

const money = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
const fieldClass = 'mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary';

/** An independent, read-only desk. It never changes the running strategy. */
export function DbotMarketTools() {
  const feed = useMarketFeed();
  const [windowSize, setWindowSize] = useState(100);
  const [selected, setSelected] = useState('');
  const [balance, setBalance] = useState('100');
  const [stake, setStake] = useState('1');
  const [multiplier, setMultiplier] = useState('2');
  const [losses, setLosses] = useState('5');
  const [payout, setPayout] = useState('1.95');
  const markets = useMemo(() => feed.markets.map(market => ({ ...market, summary: summarizeDigits(market.ticks, windowSize) })), [feed.markets, windowSize]);
  const active = markets.find(market => market.symbol === selected) ?? markets[0];
  // Empty fields are invalid, not zero. All values are hypothetical.
  const number = (value: string) => value.trim() ? Number(value) : NaN;
  const risk = calculateRiskScenario({ balance: number(balance), stake: number(stake), multiplier: number(multiplier), losses: number(losses), payout: number(payout) });

  return <div className="space-y-5 py-5" data-testid="dbot-market-tools">
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 sm:p-6">
      <div className="dbot-kicker"><Activity size={12} /> MARKET TOOLS</div>
      <h3 className="mt-2 text-xl font-extrabold tracking-tight">Digits &amp; risk desk</h3>
      <p className="mt-1.5 max-w-3xl text-xs leading-5 text-muted-foreground sm:text-sm">Watch the shared volatility feed and explore a hypothetical loss sequence alongside your bot. These tools do not place trades or change its settings.</p>
    </div>
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="dbot-digits-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><div className="dbot-kicker"><Activity size={12} /> LIVE FEED</div><h3 id="dbot-digits-title" className="mt-2 text-base font-bold">Volatility market digit monitor</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">A simultaneous snapshot of the markets Signal Lab streams, not a forecast or a market selection for your bot.</p></div>
        <label className="text-xs font-semibold">Tick window <select value={windowSize} onChange={event => setWindowSize(Number(event.target.value))} className="ml-2 rounded-lg border border-border bg-background px-2 py-2 text-xs" data-testid="dbot-digit-window"><option value={50}>50 ticks</option><option value={100}>100 ticks</option><option value={500}>500 ticks</option><option value={1000}>1,000 ticks</option><option value={2000}>2,000 ticks</option></select></label>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[580px] text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Market</th><th className="px-3 py-2">Feed</th><th className="px-3 py-2">Verified digits</th><th className="px-3 py-2">Last</th><th className="px-3 py-2">Even</th><th className="px-3 py-2">Odd</th><th className="px-3 py-2"><span className="sr-only">Details</span></th></tr></thead>
          <tbody>{markets.map(market => {
            const s = market.summary;
            const pct = (count: number) => s.sample ? `${(100 * count / s.sample).toFixed(1)}%` : '—';
            return <tr key={market.symbol} className="border-t border-border" data-testid={`dbot-market-${market.symbol}`}><th scope="row" className="px-3 py-3 font-semibold">{market.name}<span className="ml-1 text-[10px] font-normal text-muted-foreground">{market.symbol}</span></th><td className="px-3 py-3"><span className={market.fresh ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>{market.fresh ? 'Live' : market.ticks.length ? 'Stale' : 'Waiting'}</span></td><td className="px-3 py-3">{s.sample}/{s.considered}</td><td className="px-3 py-3">{s.lastDigit ?? '—'}</td><td className="px-3 py-3">{pct(s.even)}</td><td className="px-3 py-3">{pct(s.odd)}</td><td className="px-3 py-3"><button type="button" onClick={() => setSelected(market.symbol)} className="font-bold text-primary hover:underline" aria-label={`View ${market.name} digit details`}>View</button></td></tr>;
          })}</tbody>
        </table>
      </div>
      {!markets.length && <p className="mt-3 text-xs text-muted-foreground">Waiting for markets from the shared feed.</p>}
      {active && <div className="mt-4 rounded-lg border border-border bg-background/40 p-3" data-testid="dbot-digit-detail"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold">{active.name} · last-digit distribution</h4><span className="text-[10px] text-muted-foreground">{active.fresh ? 'Live' : 'Not live'} · {active.summary.sample} verified of {active.summary.considered} ticks</span></div><div className="mt-3 grid grid-cols-5 gap-1.5 sm:grid-cols-10">{active.summary.counts.map((count, digit) => <div key={digit} className="rounded-md border border-border bg-card px-1 py-2 text-center"><div className="text-xs font-bold">{digit}</div><div className="mt-1 text-[10px] text-muted-foreground">{active.summary.sample ? `${(100 * count / active.summary.sample).toFixed(1)}%` : '—'}</div><div className="text-[10px] text-muted-foreground">{count} ticks</div></div>)}</div></div>}
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">Unknown-precision digits are excluded. Stale data is shown for context only; historical frequencies do not predict the next digit. A live feed does not confirm contract availability.</p>
    </section>
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="dbot-risk-title">
      <div className="dbot-kicker"><Calculator size={12} /> SCENARIO PLANNER</div><h3 id="dbot-risk-title" className="mt-2 text-base font-bold">Loss-sequence &amp; payout calculator</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Enter hypothetical values in the same currency. Payout is the total returned on a win, including stake.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {([['Balance', balance, setBalance, '0.01'], ['Initial stake', stake, setStake, '0.01'], ['Loss multiplier', multiplier, setMultiplier, '0.1'], ['Consecutive losses', losses, setLosses, '1'], ['Total payout', payout, setPayout, '0.01']] as const).map(([label, value, setter, step]) => <label key={label} className="text-[11px] font-bold">{label}<input type="number" step={step} value={value} onChange={event => setter(event.target.value)} className={fieldClass} /></label>)}
      </div>
      {!risk ? <p role="alert" className="mt-4 text-xs text-amber-600 dark:text-amber-400">Enter positive balance, stake and payout; multiplier 1–10; and 1–12 whole losses.</p> : <>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3"><div className="rounded-lg border border-border bg-background/40 p-3"><div className="text-[10px] text-muted-foreground">Total simulated loss</div><div className="mt-1 text-lg font-bold">{money(risk.totalLoss)}</div></div><div className="rounded-lg border border-border bg-background/40 p-3"><div className="text-[10px] text-muted-foreground">Share of entered balance</div><div className="mt-1 text-lg font-bold">{money(risk.percentBalance)}%</div></div><div className="rounded-lg border border-border bg-background/40 p-3"><div className="text-[10px] text-muted-foreground">Break-even win rate</div><div className="mt-1 text-lg font-bold">{risk.payoutBelowStake ? 'Not attainable' : `${money(risk.breakEvenPercent)}%`}</div></div></div>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-xs"><thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Loss #</th><th className="px-3 py-2">Stake</th><th className="px-3 py-2">Cumulative loss</th><th className="px-3 py-2">Balance</th></tr></thead><tbody>{risk.ladder.map(row => <tr key={row.number} className="border-t border-border"><td className="px-3 py-2">{row.number}</td><td className="px-3 py-2">{money(row.stake)}</td><td className="px-3 py-2">{money(row.cumulative)}</td><td className="px-3 py-2">{row.affordable ? 'Within entered balance' : 'Exceeds entered balance'}</td></tr>)}</tbody></table></div>
      </>}
      <div className="mt-4 flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] leading-5 text-muted-foreground"><ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" /><p>Illustration only, assuming each listed stake is lost in full. It does not enforce limits, account for broker minimums, rounding, changing payouts or open positions, or prevent losses. A progression can exhaust a balance quickly; test on demo.</p></div>
    </section>
  </div>;
}
