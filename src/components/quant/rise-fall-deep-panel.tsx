import { useMemo } from 'react';
import { analyzeRiseFall } from '@/lib/quant/rise-fall';
import { riseFallInsight } from '@/lib/quant/ai-insights';
import { Activity } from 'lucide-react';

const metricClass = 'rounded-lg border border-border bg-background/35 px-3 py-2';

function Metric({ label, value }: { label: string; value: string }) {
  return <div className={metricClass}><div className="eyebrow">{label}</div><div className="mono mt-1 text-xs font-semibold">{value}</div></div>;
}

export function RiseFallDeepPanel({ prices }: { prices: number[] }) {
  const m = useMemo(() => (prices.length >= 10 ? analyzeRiseFall(prices) : null), [prices]);
  const insight = useMemo(() => (m ? riseFallInsight(m) : null), [m]);
  if (!m) return <div className="text-xs text-muted-foreground">Need at least 10 ticks for deep analysis.</div>;
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow" data-testid="rise-fall-deep-panel">
      <div className="flex items-center gap-2"><Activity size={14} className="text-primary" /><div className="eyebrow">Deep quantitative engine · Rise/Fall</div></div>
      <h3 className="mt-1 text-sm font-bold">Velocity, momentum, chaos & trend engines</h3>
      {insight && <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs"><strong>{insight.verdict}</strong><ul className="mt-1 list-disc pl-4 text-[10px] text-muted-foreground">{insight.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Speed 3/5/10" value={`${m.speed3.toFixed(4)} / ${m.speed5.toFixed(4)} / ${m.speed10.toFixed(4)}`} />
        <Metric label="Accel 3/5/10" value={`${m.accel3.toFixed(4)} / ${m.accel5.toFixed(4)} / ${m.accel10.toFixed(4)}`} />
        <Metric label="Imbalance (50)" value={`${(m.imbalance * 100).toFixed(1)}% (${m.positiveTicks}/${m.negativeTicks})`} />
        <Metric label="Tick True Range 10" value={m.tickTrueRange10.toFixed(4)} />
        <Metric label="EMA 5 / 21" value={`${m.ema5.toFixed(4)} / ${m.ema21.toFixed(4)}`} />
        <Metric label="RSI 14" value={m.rsi.toFixed(1)} />
        <Metric label="MACD / signal" value={`${m.macd.toFixed(4)} / ${m.macdSignal.toFixed(4)}`} />
        <Metric label="Bollinger width" value={m.bollingerWidth.toFixed(4)} />
        <Metric label="Hurst H" value={m.hurst.toFixed(3)} />
        <Metric label="Fractal dim" value={m.fractalDimension.toFixed(3)} />
        <Metric label="P(rise|1 up)" value={`${(m.markovTrend.pRiseGiven1 * 100).toFixed(1)}%`} />
        <Metric label="P(rise|3 up)" value={`${(m.markovTrend.pRiseGiven3 * 100).toFixed(1)}%`} />
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">Trend bias {(m.trendBias * 100).toFixed(1)}%. Research only; not a trading signal.</p>
    </section>
  );
}
