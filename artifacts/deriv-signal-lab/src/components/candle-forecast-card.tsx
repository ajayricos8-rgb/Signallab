import type { CandleOpenForecastResponse } from '@workspace/api-client-react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock3 } from 'lucide-react';

export type CandleForecastHistoryItem = {
  forecast: CandleOpenForecastResponse;
  actualOutcome?: 'RISE' | 'FALL' | 'FLAT';
};

type CandleForecastCardProps = {
  symbol: string;
  status: string;
  completedCandleCount: number;
  currentCandleEpoch?: number | null;
  currentCandleOpen?: number | null;
  isPending?: boolean;
  error?: string | null;
  forecast?: CandleOpenForecastResponse | null;
  history?: CandleForecastHistoryItem[];
};

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 });

function asPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatEpoch(epoch?: number | null) {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return 'Not available';
  return new Date(epoch * 1000).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function signed(value: number, digits = 3) {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function FeatureValue({ label, value, suffix = '', digits = 3, displayValue }: { label: string; value: number; suffix?: string; digits?: number; displayValue?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/80 bg-background/35 px-2.5 py-2" title={label}>
      <div className="truncate text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
      <div className="mono mt-1 truncate text-xs font-medium">{displayValue ?? `${signed(value, digits)}${suffix}`}</div>
    </div>
  );
}

function ForecastSkeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-label="Loading candle forecast">
      <div className="h-24 rounded-lg bg-muted" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-14 rounded-md bg-muted" />)}</div>
      <div className="h-16 rounded-lg bg-muted" />
    </div>
  );
}

export function CandleForecastCard({
  symbol,
  status,
  completedCandleCount,
  currentCandleEpoch,
  currentCandleOpen,
  isPending = false,
  error,
  forecast,
  history = [],
}: CandleForecastCardProps) {
  const direction = forecast?.label;
  const rise = direction === 'RISE';
  const features = forecast?.features;
  const currentEpoch = currentCandleEpoch ?? forecast?.candleEpoch;
  const currentOpen = currentCandleOpen ?? forecast?.openPrice;
  const featureRows = features ? [
    ['EMA spread / ATR', features.emaSpreadAtr],
    ['RSI', features.rsi],
    ['ADX', features.adx],
    ['+DI', features.plusDi],
    ['−DI', features.minusDi],
    ['ATR', features.atr],
    ['Bollinger position', features.bollingerPosition],
    ['Return autocorrelation', features.returnAutocorrelation],
    ['Volatility clustering', features.volatilityClustering],
    ['Efficiency ratio', features.efficiencyRatio],
    ['Opening gap / ATR', features.openingGapAtr],
    ['Up-candle rate', features.upCandleRate],
    ['Trend t-statistic', features.trendTStatistic],
  ] as const : [];

  return (
    <section className="min-w-0 rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" aria-labelledby="candle-forecast-title">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <div className="eyebrow">Candle direction · 1 minute</div>
          <h2 id="candle-forecast-title" className="mt-1 text-sm font-bold">Open-time forecast</h2>
          <p className="mono mt-1 text-[10px] text-muted-foreground">{symbol} <span className="px-1 text-border">/</span> {status}</p>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-background/45 px-2 py-1 text-[10px] text-muted-foreground">
          <Clock3 size={12} aria-hidden="true" />
          <span>{completedCandleCount} completed candles</span>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid="candle-forecast-error">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {isPending ? (
        <div className="mt-5"><ForecastSkeleton /></div>
      ) : forecast ? (
        <>
          <div className={`mt-5 grid gap-4 rounded-lg border p-4 sm:grid-cols-[1fr_auto] sm:items-center ${rise ? 'border-primary/30 bg-primary/5' : 'border-accent/30 bg-accent/5'}`} data-testid="candle-forecast-result">
            <div className="flex items-center gap-3">
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${rise ? 'border-primary/30 bg-primary/10 text-primary' : 'border-accent/30 bg-accent/10 text-accent'}`} aria-hidden="true">
                {rise ? <ArrowUpRight size={23} /> : <ArrowDownRight size={23} />}
              </div>
              <div>
                <div className="eyebrow">Estimated direction</div>
                <div className={`mt-0.5 text-2xl font-extrabold tracking-[-0.04em] ${rise ? 'text-primary' : 'text-accent'}`}>{forecast.label}</div>
                <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{forecast.detail}</div>
              </div>
            </div>
            <div className="flex gap-5 border-t border-border/70 pt-3 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
              <div>
                <div className="eyebrow">Model probability</div>
                <div className="mono mt-1 text-xl font-medium">{asPercent(forecast.probability)}</div>
              </div>
              <div>
                <div className="eyebrow">Confidence</div>
                <div className="mono mt-1 text-xl font-medium">{forecast.confidence.toFixed(1)}<span className="text-xs text-muted-foreground">%</span></div>
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md border border-border bg-background/35 px-2.5 py-2">
              <div className="eyebrow">Candle open</div>
              <div className="mono mt-1 text-xs">{typeof currentOpen === 'number' ? numberFormat.format(currentOpen) : 'Not available'}</div>
            </div>
            <div className="rounded-md border border-border bg-background/35 px-2.5 py-2">
              <div className="eyebrow">Candle epoch</div>
              <div className="mono mt-1 text-[10px]" title={typeof currentEpoch === 'number' ? String(currentEpoch) : undefined}>{formatEpoch(currentEpoch)}</div>
            </div>
            <div className="rounded-md border border-border bg-background/35 px-2.5 py-2">
              <div className="eyebrow">Training sample</div>
              <div className="mono mt-1 text-xs">{numberFormat.format(forecast.sampleSize)} <span className="text-[9px] text-muted-foreground">candles</span></div>
            </div>
            <div className="rounded-md border border-border bg-background/35 px-2.5 py-2">
              <div className="eyebrow">Effective sample</div>
              <div className="mono mt-1 text-xs">{numberFormat.format(forecast.effectiveSampleSize)}</div>
            </div>
          </div>

          {features && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-bold">Feature diagnostics</h3>
                <span className="mono text-[9px] text-muted-foreground">MODEL INPUTS</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                {featureRows.slice(0, 8).map(([label, value]) => <FeatureValue key={label} label={label} value={value} displayValue={label === 'Up-candle rate' ? asPercent(value) : undefined} digits={label === 'RSI' || label === 'ADX' || label === '+DI' || label === '−DI' ? 1 : 3} />)}
              </div>
            </div>
          )}

          <details className="group mt-4 rounded-lg border border-border bg-background/25">
            <summary className="focus-ring cursor-pointer list-none px-3 py-2.5 text-xs font-semibold [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-3">
                <span>Forecast engine details</span>
                <span className="mono text-[9px] font-normal text-muted-foreground">{forecast.engines.length} engines <span className="inline-block transition-transform group-open:rotate-180">⌄</span></span>
              </span>
            </summary>
            <div className="space-y-3 border-t border-border px-3 py-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">{forecast.methodNote}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {forecast.engines.map((engine, index) => (
                  <article key={`${engine.name}-${index}`} className="rounded-md border border-border bg-card/70 p-2.5" data-testid={`candle-engine-${index}`}>
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-[11px] font-bold">{engine.name}</h4>
                      <span className="mono shrink-0 text-[9px] text-primary">{engine.signal} · {numberFormat.format(engine.score)}</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{engine.description}</p>
                    <p className="mt-1.5 text-[10px] leading-relaxed">{engine.detail}</p>
                  </article>
                ))}
              </div>
              {features && (
                <div>
                  <h4 className="mb-2 eyebrow">Complete feature vector</h4>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                    {featureRows.map(([label, value]) => <FeatureValue key={label} label={label} value={value} displayValue={label === 'Up-candle rate' ? asPercent(value) : undefined} digits={label === 'RSI' || label === 'ADX' || label === '+DI' || label === '−DI' ? 1 : 4} />)}
                  </div>
                </div>
              )}
            </div>
          </details>
        </>
      ) : (
        <div className="mt-5 flex min-h-36 flex-col justify-center rounded-lg border border-dashed border-border bg-background/30 px-4" data-testid="empty-candle-forecast">
          <div className="eyebrow">{error ? 'Forecast unavailable' : 'Waiting for forecast'}</div>
          <p className="mt-2 max-w-lg text-xs leading-relaxed text-muted-foreground">
            {error ? 'The latest request did not produce a forecast. The candle context remains available for the next analysis.' : `A one-minute estimate for ${symbol} will appear when a real forecast is available.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            <span>Current open: <strong className="mono font-medium text-foreground">{typeof currentCandleOpen === 'number' ? numberFormat.format(currentCandleOpen) : '—'}</strong></span>
            <span>Epoch: <strong className="mono font-medium text-foreground">{formatEpoch(currentCandleEpoch)}</strong></span>
          </div>
        </div>
      )}

      {forecast && (
        <p className="mt-3 rounded-md border border-accent/20 bg-accent/5 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground" data-testid="candle-forecast-disclaimer">
          Educational estimate only — not financial advice or a guarantee of the next candle. Probability is sample-aware; market outcomes remain uncertain.
        </p>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-bold">Recent settled forecasts</h3>
          <span className="mono text-[9px] text-muted-foreground">{history.length} {history.length === 1 ? 'record' : 'records'}</span>
        </div>
        {history.length ? (
          <ul className="mt-2 divide-y divide-border" aria-label="Recent candle forecast outcomes">
            {history.map((item, index) => {
              const correct = item.actualOutcome === item.forecast.label;
              return (
                <li key={`${item.forecast.symbol}-${item.forecast.candleEpoch}-${index}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2" data-testid={`candle-history-${index}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`mono text-[10px] font-bold ${item.forecast.label === 'RISE' ? 'text-primary' : 'text-accent'}`}>{item.forecast.label}</span>
                      <span className="mono text-[9px] text-muted-foreground">{item.forecast.symbol}</span>
                    </div>
                    <div className="mt-0.5 text-[9px] text-muted-foreground">{formatEpoch(item.forecast.candleEpoch)} · {asPercent(item.forecast.probability)} estimated</div>
                  </div>
                  {item.actualOutcome ? (
                    <span aria-label={`Actual outcome ${item.actualOutcome}; ${item.actualOutcome === 'FLAT' ? 'flat outcome' : correct ? 'aligned with forecast' : 'not aligned with forecast'}`} className={`mono rounded border px-2 py-1 text-[9px] ${item.actualOutcome === 'FLAT' ? 'border-border text-muted-foreground' : correct ? 'border-primary/25 bg-primary/5 text-primary' : 'border-destructive/25 bg-destructive/5 text-destructive'}`}>
                      ACTUAL {item.actualOutcome}{item.actualOutcome !== 'FLAT' ? (correct ? ' · ALIGNED' : ' · MISSED') : ''}
                    </span>
                  ) : <span className="mono rounded border border-border px-2 py-1 text-[9px] text-muted-foreground">PENDING</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 rounded-md bg-background/35 px-3 py-3 text-[10px] leading-relaxed text-muted-foreground">Settled outcomes will be shown here when supplied. No historical results are inferred.</p>
        )}
      </div>

      <div className="sr-only" aria-live="polite">{isPending ? 'Candle forecast is loading' : forecast ? `${forecast.label} forecast loaded` : ''}</div>
    </section>
  );
}