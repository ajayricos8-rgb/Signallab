import type { AnalysisResponse } from '@workspace/api-client-react';

type DigitHeatmapProps = {
  analysis?: AnalysisResponse | null;
  contractFamily: string;
  isLoading?: boolean;
};

const digits = Array.from({ length: 10 }, (_, digit) => digit);

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function percent(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : '—';
}

function familyName(value: string) {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' / ');
}

function intensity(value: number, maximum: number) {
  if (!Number.isFinite(value) || maximum <= 0) return 'transparent';
  return `hsl(158 62% ${Math.round(49 - (value / maximum) * 18)}% / ${0.10 + (value / maximum) * 0.48})`;
}

function HeatmapSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-label="Loading digit analysis">
      <div className="h-4 w-44 rounded bg-muted" />
      <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
        {digits.map((digit) => <div key={digit} className="h-16 rounded-md bg-muted" />)}
      </div>
      <div className="h-4 w-56 rounded bg-muted" />
      <div className="h-44 rounded-md bg-muted" />
    </div>
  );
}

export function DigitHeatmap({ analysis, contractFamily, isLoading = false }: DigitHeatmapProps) {
  const metrics = analysis?.metrics;
  const counts = metrics?.digitCounts;
  const distribution = metrics?.lastDigitDistribution;
  const transitionCounts = metrics?.transitionCounts;
  const transitionMatrix = metrics?.transitionMatrix;
  const maxDigitCount = counts?.length ? Math.max(...counts) : 0;
  const maxTransitionCount = transitionCounts?.length
    ? Math.max(0, ...transitionCounts.flat().filter(Number.isFinite))
    : 0;

  return (
    <section className="min-w-0 rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" aria-labelledby="digit-heatmap-title">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div className="eyebrow">Digit behavior</div>
          <h2 id="digit-heatmap-title" className="mt-1 text-sm font-bold">Frequency &amp; transition map</h2>
          <p className="mt-1 text-xs text-muted-foreground">Observed last digits and next-digit behavior from the current analysis window.</p>
        </div>
        <span className="mono w-fit rounded-md border border-border bg-background/50 px-2 py-1 text-[10px] text-muted-foreground" data-testid="text-heatmap-family">
          {familyName(contractFamily)}
        </span>
      </div>

      {isLoading ? (
        <div className="mt-5"><HeatmapSkeleton /></div>
      ) : !analysis || !metrics ? (
        <div className="mt-5 flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/30 px-5 text-center" data-testid="empty-digit-heatmap">
          <div className="mono text-[10px] font-medium tracking-[0.14em] text-primary">NO ANALYSIS WINDOW</div>
          <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">Generate a signal to inspect real digit frequencies and transitions. No values are estimated while the window is empty.</p>
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2">
              <div className="eyebrow">Observations</div>
              <div className="mono mt-1 text-sm font-medium">{numberFormat.format(analysis.sampleSize)}</div>
            </div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2">
              <div className="eyebrow">Effective N</div>
              <div className="mono mt-1 text-sm font-medium">{numberFormat.format(metrics.effectiveSampleSize)}</div>
            </div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2">
              <div className="eyebrow">Shannon entropy</div>
              <div className="mono mt-1 text-sm font-medium">{numberFormat.format(metrics.shannonEntropy)} <span className="text-[10px] text-muted-foreground">bits</span></div>
            </div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2">
              <div className="eyebrow">χ² diagnostic p</div>
              <div className="mono mt-1 text-sm font-medium">{percent(metrics.chiSquarePValue)}</div>
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold">Last-digit frequency</h3>
                <p className="mt-0.5 text-[10px] text-muted-foreground">Count and share of observed digits</p>
              </div>
              <span className="mono text-[9px] text-muted-foreground">N = {numberFormat.format(analysis.sampleSize)}</span>
            </div>
            <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-10" role="list" aria-label="Observed digit frequency">
              {digits.map((digit) => {
                const count = counts?.[digit];
                const share = typeof count === 'number' && analysis.sampleSize > 0
                  ? count / analysis.sampleSize
                  : distribution?.[digit];
                const known = typeof count === 'number' && typeof share === 'number';
                return (
                  <div
                    key={digit}
                    role="listitem"
                    aria-label={`Digit ${digit}: ${known ? `${count} observations, ${percent(share)} of sample` : 'no value reported'}`}
                    title={`Digit ${digit} · ${known ? `${count} observations · ${percent(share)} of sample` : 'No value reported'}`}
                    className="rounded-md border border-border/80 px-2 py-2 text-center"
                    style={{ backgroundColor: typeof count === 'number' ? intensity(count, maxDigitCount) : undefined }}
                    data-testid={`heatmap-frequency-${digit}`}
                  >
                    <div className="mono text-xs font-medium">{digit}</div>
                    <div className="mono mt-1 text-[10px] text-foreground">{typeof count === 'number' ? numberFormat.format(count) : '—'}</div>
                    <div className="mono mt-0.5 text-[9px] text-muted-foreground">{percent(share)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold">Previous digit → next digit</h3>
                <p className="mt-0.5 text-[10px] text-muted-foreground">Each cell shows transition count and conditional probability within its row.</p>
              </div>
              <span className="mono text-[9px] text-muted-foreground">ROWS: PREVIOUS · COLUMNS: NEXT</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label="Scrollable digit transition matrix">
              <table className="w-full min-w-[680px] border-collapse text-center" aria-label="Digit transition counts and conditional probabilities">
                <thead>
                  <tr className="bg-background/65">
                    <th scope="col" className="sticky left-0 z-10 min-w-24 border-b border-r border-border bg-card px-2 py-2 text-left text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Prev. / Next</th>
                    {digits.map((digit) => <th scope="col" key={digit} className="border-b border-border px-1 py-2 mono text-[10px] font-medium text-muted-foreground">{digit}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {digits.map((from) => (
                    <tr key={from} className="group">
                      <th scope="row" className="sticky left-0 z-10 border-r border-b border-border bg-card px-2 py-1.5 text-left">
                        <span className="mono text-[10px] font-medium">{from}</span>
                      </th>
                      {digits.map((to) => {
                        const count = transitionCounts?.[from]?.[to];
                        const probability = transitionMatrix?.[from]?.[to];
                        const known = typeof count === 'number' && typeof probability === 'number';
                        return (
                          <td
                            key={to}
                            aria-label={`From ${from} to ${to}: ${known ? `${count} transitions, ${percent(probability)} conditional probability` : 'no value reported'}`}
                            title={`From ${from} to ${to} · ${known ? `${count} transitions · ${percent(probability)} conditional probability` : 'No value reported'}`}
                            className="border-b border-border/70 px-1 py-1"
                            data-testid={`heatmap-transition-${from}-${to}`}
                          >
                            <div className="rounded-sm px-0.5 py-1" style={{ backgroundColor: typeof count === 'number' ? intensity(count, maxTransitionCount) : undefined }}>
                              <div className="mono text-[9px] leading-3">{typeof count === 'number' ? numberFormat.format(count) : '—'}</div>
                              <div className="mono text-[8px] leading-3 text-muted-foreground">{percent(probability)}</div>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-[10px] text-muted-foreground" aria-label="Statistical diagnostic p-values">
            <span>Runs p <strong className="mono font-medium text-foreground">{percent(metrics.runsPValue)}</strong></span>
            <span>Ljung–Box p <strong className="mono font-medium text-foreground">{percent(metrics.ljungBoxPValue)}</strong></span>
            <span>Normality p <strong className="mono font-medium text-foreground">{percent(metrics.normalityPValue)}</strong></span>
            <span className="basis-full leading-relaxed">Diagnostics describe this sample; they do not establish predictability or guarantee future behavior.</span>
          </div>
        </>
      )}
    </section>
  );
}