import { useMemo } from 'react';
import { analyzeEvenOdd } from '@/lib/quant/even-odd';
import { analyzeOverUnder } from '@/lib/quant/over-under';
import { analyzeMatches } from '@/lib/quant/matches';
import { evenOddInsight, overUnderInsight, matchesInsight } from '@/lib/quant/ai-insights';

const metricClass = 'rounded-lg border border-border bg-background/35 px-3 py-2';
function Metric({ label, value }: { label: string; value: string }) {
  return <div className={metricClass}><div className="eyebrow">{label}</div><div className="mono mt-1 text-xs font-semibold">{value}</div></div>;
}

export function DigitDeepPanel({ digits, family }: { digits: number[]; family: 'even-odd' | 'over-under' | 'matches' }) {
  if (family === 'even-odd') {
    const m = useMemo(() => (digits.length >= 20 ? analyzeEvenOdd(digits) : null), [digits]);
    const insight = useMemo(() => (m ? evenOddInsight(m) : null), [m]);
    if (!m) return <div className="text-xs text-muted-foreground">Need at least 20 digits.</div>;
    return (
      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow" data-testid="even-odd-deep-panel">
        <div className="eyebrow">Deep quantitative engine · Even/Odd</div>
        <h3 className="mt-1 text-sm font-bold">Parity, combinatorics & randomness engines</h3>
        {insight && <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs"><strong>{insight.verdict}</strong><ul className="mt-1 list-disc pl-4 text-[10px] text-muted-foreground">{insight.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Even (N=50)" value={`${(m.parityProportion50.even * 100).toFixed(1)}%`} />
          <Metric label="Even (N=100)" value={`${(m.parityProportion100.even * 100).toFixed(1)}%`} />
          <Metric label="Even (N=500)" value={`${(m.parityProportion500.even * 100).toFixed(1)}%`} />
          <Metric label="Chi-square" value={`${m.chiSquare.toFixed(2)} (p ${m.chiSquareP === null ? 'n/a' : m.chiSquareP.toFixed(3)})`} />
          <Metric label="Wilson even" value={`${(m.wilsonEven.lower * 100).toFixed(1)}–${(m.wilsonEven.upper * 100).toFixed(1)}%`} />
          <Metric label="Current streak" value={`${m.currentStreak.parity} x${m.currentStreak.length}`} />
          <Metric label="Max even/odd streak" value={`${m.maxEvenStreak} / ${m.maxOddStreak}`} />
          <Metric label="Alternation ratio" value={`${(m.alternationRatio * 100).toFixed(1)}%`} />
          <Metric label="Wald-Wolfowitz z" value={`${m.waldWolfowitz.z.toFixed(2)} (p ${m.waldWolfowitz.p.toFixed(3)})`} />
          <Metric label="E→E / E→O" value={`${(m.markovTransitions.evenToEven * 100).toFixed(1)}% / ${(m.markovTransitions.evenToOdd * 100).toFixed(1)}%`} />
          <Metric label="O→E / O→O" value={`${(m.markovTransitions.oddToEven * 100).toFixed(1)}% / ${(m.markovTransitions.oddToOdd * 100).toFixed(1)}%`} />
          <Metric label="Higher-order contexts" value={String(Object.keys(m.higherOrder).length)} />
        </div>
      </section>
    );
  }
  if (family === 'over-under') {
    const m = useMemo(() => (digits.length >= 20 ? analyzeOverUnder(digits) : null), [digits]);
    const insight = useMemo(() => (m ? overUnderInsight(m) : null), [m]);
    if (!m) return <div className="text-xs text-muted-foreground">Need at least 20 digits.</div>;
    return (
      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow" data-testid="over-under-deep-panel">
        <div className="eyebrow">Deep quantitative engine · Over/Under</div>
        <h3 className="mt-1 text-sm font-bold">Barrier, threshold & probability distribution engines</h3>
        {insight && <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs"><strong>{insight.verdict}</strong><ul className="mt-1 list-disc pl-4 text-[10px] text-muted-foreground">{insight.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Shannon entropy" value={`${m.shannonEntropy.toFixed(3)} bits`} />
          <Metric label="Normalized entropy" value={m.normalizedEntropy.toFixed(3)} />
          <Metric label="Chi-square (10-cell)" value={`${m.chiSquare.toFixed(2)} (p ${m.chiSquareP === null ? 'n/a' : m.chiSquareP.toFixed(3)})`} />
          {m.zScores.map((z, i) => <Metric key={i} label={`Digit ${i} z-score`} value={z.toFixed(2)} />)}
        </div>
        <div className="mt-3 text-[10px] text-muted-foreground">
          Cumulative under probabilities: {m.cumulative.map((c) => `U${c.barrier}=${(c.under * 100).toFixed(1)}%`).join(' · ')}
        </div>
      </section>
    );
  }
  // matches
  const m = useMemo(() => (digits.length >= 20 ? analyzeMatches(digits) : null), [digits]);
  const insight = useMemo(() => (m ? matchesInsight(m) : null), [m]);
  if (!m) return <div className="text-xs text-muted-foreground">Need at least 20 digits.</div>;
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow" data-testid="matches-deep-panel">
      <div className="eyebrow">Deep quantitative engine · Matches</div>
      <h3 className="mt-1 text-sm font-bold">Exact digit precision, recurrence & spectral engines</h3>
      {insight && <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs"><strong>{insight.verdict}</strong><ul className="mt-1 list-disc pl-4 text-[10px] text-muted-foreground">{insight.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {m.drought.map((v, i) => <Metric key={i} label={`Digit ${i} drought`} value={`${v} ticks`} />)}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Permutation entropy" value={m.permutationEntropy.toFixed(3)} />
        <Metric label="Top FFT peak" value={m.fftPeaks[0] ? `${m.fftPeaks[0].freq.toFixed(3)} (${m.fftPeaks[0].magnitude.toFixed(2)})` : '—'} />
        <Metric label="ACF lag1" value={m.autocorrelation[0]?.toFixed(3) ?? '—'} />
        <Metric label="Recurrence intervals (digit 0)" value={`mean ${m.recurrenceIntervals[0].mean.toFixed(1)} / max ${m.recurrenceIntervals[0].max}`} />
      </div>
      <div className="mt-3 text-[10px] text-muted-foreground">
        Top patterns: {m.higherOrderPatterns.slice(0, 5).map((p) => `${p.pattern}(${p.count})`).join(' · ')}
      </div>
    </section>
  );
}
