// Layer 7 on the tool pages: what the embedded, free neural model saw.
//
// The card is deliberately as explicit about the model's provenance as about
// its forecast: it is trained inside the app on this market's own feed, it
// costs nothing to run, and it only moves a published probability once it has
// beaten chance on ticks it never saw. Showing the measured score next to the
// forecast is what keeps a neural network an evidence source instead of an
// authority.
import { BrainCircuit, CircleSlash, Coins, Cpu, ShieldCheck, Sparkles } from 'lucide-react';
import type { NeuralDigitForecast, NeuralFusion, NeuralQuoteForecast } from '@/lib/neural/models';
import type { NeuralMetrics } from '@/lib/neural/train';

const pct = (value: number | null, digits = 1) => (value === null || !Number.isFinite(value) ? '—' : `${(100 * value).toFixed(digits)}%`);

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/35 px-3 py-2" title={hint}>
      <div className="eyebrow">{label}</div>
      <div className="mono mt-1 text-xs font-semibold">{value}</div>
      {hint ? <div className="mt-0.5 text-[9px] leading-snug text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function DigitDistribution({ forecast }: { forecast: NeuralDigitForecast }) {
  const peak = Math.max(...forecast.distribution, 0.0001);
  return (
    <div className="mt-3" data-testid="neural-digit-distribution">
      <div className="flex items-baseline justify-between">
        <div className="eyebrow">Next-digit probability</div>
        <div className="text-[10px] text-muted-foreground">flat odds 10.0% per digit</div>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1.5 sm:grid-cols-10">
        {forecast.distribution.map((probability, digit) => {
          const top = digit === forecast.topDigit;
          return (
            <div
              key={digit}
              className={`rounded-md border px-1.5 py-1.5 text-center ${top ? 'border-primary/60 bg-primary/10' : 'border-border bg-background/40'}`}
              title={`Digit ${digit}: ${pct(probability)}`}
            >
              <div className={`mono text-sm font-bold ${top ? 'text-primary' : 'text-foreground'}`}>{digit}</div>
              <div className="mono text-[9px] text-muted-foreground">{pct(probability, 1)}</div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                <div className={`h-full rounded-full ${top ? 'bg-primary' : 'bg-muted-foreground/40'}`} style={{ width: `${Math.max(3, (probability / peak) * 100)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuoteDistribution({ forecast }: { forecast: NeuralQuoteForecast }) {
  const rows = [
    { label: 'Rise', value: forecast.probabilityUp, className: 'bg-emerald-500' },
    { label: 'Fall', value: forecast.probabilityDown, className: 'bg-rose-500' },
  ];
  return (
    <div className="mt-3" data-testid="neural-quote-distribution">
      <div className="flex items-baseline justify-between">
        <div className="eyebrow">Next move probability</div>
        <div className="text-[10px] text-muted-foreground">flat odds 50.0% per direction</div>
      </div>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <div className="w-9 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{row.label}</div>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
              <div className={`h-full rounded-full ${row.className}`} style={{ width: `${Math.max(2, row.value * 100)}%` }} />
            </div>
            <div className="mono w-12 text-right text-[10px] font-semibold">{pct(row.value)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricGrid({ metrics }: { metrics: NeuralMetrics }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      <Metric
        label="Holdout hit rate"
        value={`${pct(metrics.accuracy)} vs ${pct(metrics.baselineAccuracy)}`}
        hint="Accuracy on ticks the network never trained on, against guessing at chance."
      />
      <Metric
        label="Brier skill"
        value={pct(metrics.brierSkill)}
        hint="Improvement over the no-edge baseline on the holdout slice. Negative means the model was worse than chance."
      />
      <Metric
        label="Paired z"
        value={metrics.z === null ? '—' : metrics.z.toFixed(2)}
        hint="Statistical strength of that improvement. The model needs z ≥ 2 before it can carry any weight."
      />
      <Metric
        label="Rows"
        value={`${metrics.trainRows} / ${metrics.validationRows} / ${metrics.holdoutRows}`}
        hint="Train / validation / holdout rows, split chronologically with a purge gap."
      />
      <Metric
        label="Temperature"
        value={metrics.temperature.toFixed(2)}
        hint="Softmax scaling fitted on the validation slice to keep the probabilities honest."
      />
      <Metric
        label="Log-loss skill"
        value={pct(metrics.logLossSkill)}
        hint="Cross-entropy improvement over the flat baseline."
      />
    </div>
  );
}

export function NeuralModelCard({ forecast, fusion }: { forecast: NeuralDigitForecast | NeuralQuoteForecast; fusion?: NeuralFusion | null }) {
  const { model, metrics } = forecast;
  const validated = metrics.validated && forecast.weight > 0;
  const state = validated ? 'validated' : metrics.brierSkill !== null && metrics.brierSkill > 0 ? 'close' : 'no-edge';
  const badge = validated
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
    : state === 'close'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
      : 'border-border bg-background/50 text-muted-foreground';
  const badgeText = validated ? 'Validated · voting' : state === 'close' ? 'Close · not voting' : 'No vote on this market';

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="neural-model-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><BrainCircuit size={12} /> Layer 7 · free embedded neural model</div>
          <h3 className="mt-1 text-sm font-bold">{model.name}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span className="mono">{model.id} · v{model.version}</span>
            <span className="inline-flex items-center gap-1"><Cpu size={10} /> {model.parameters.toLocaleString()} params</span>
            <span className="mono">{model.shape.join('→')}</span>
            <span className="inline-flex items-center gap-1 text-emerald-500"><Coins size={10} /> free</span>
            <span className="mono">{model.license}</span>
          </div>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] ${badge}`} data-testid="neural-model-state">
          {validated ? <ShieldCheck size={11} className="mr-1 inline" /> : <CircleSlash size={11} className="mr-1 inline" />}
          {badgeText}
        </span>
      </div>

      {forecast.kind === 'digit' ? <DigitDistribution forecast={forecast} /> : <QuoteDistribution forecast={forecast} />}

      <MetricGrid metrics={metrics} />

      <div className="mt-3 rounded-lg border border-border bg-background/30 px-3 py-2 text-[11px] leading-relaxed" data-testid="neural-fusion-note">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          <Sparkles size={11} /> What it did to this signal
        </div>
        <p className="mt-1 text-foreground/80">{fusion?.note ?? forecast.note}</p>
        {fusion ? (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            <span>model view <strong className="mono text-foreground">{pct(fusion.probability)}</strong></span>
            <span>fair <strong className="mono text-foreground">{pct(fusion.fair)}</strong></span>
            <span>weight <strong className="mono text-foreground">{pct(fusion.weight, 0)}</strong></span>
            <span>
              contribution <strong className={`mono ${fusion.contributionPts > 0 ? 'text-emerald-500' : fusion.contributionPts < 0 ? 'text-rose-500' : 'text-foreground'}`}>
                {fusion.contributionPts >= 0 ? '+' : ''}{fusion.contributionPts.toFixed(2)} pts
              </strong>
            </span>
          </div>
        ) : null}
      </div>

      <details className="mt-3 rounded-lg border border-border bg-background/20 px-3 py-2 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer font-semibold text-foreground/80">Model card &amp; training details</summary>
        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <div><dt className="inline font-semibold text-foreground/70">Task: </dt><dd className="inline">{model.task}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Activation: </dt><dd className="inline">{model.activation} · {model.optimizer}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Learning rate: </dt><dd className="inline mono">{model.learningRate}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">L2: </dt><dd className="inline mono">{model.l2}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Epochs: </dt><dd className="inline mono">{model.epochsRun}/{model.epochsPlanned} (kept {model.bestEpoch})</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Seed: </dt><dd className="inline mono">{model.seed}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Train / val / holdout: </dt><dd className="inline mono">{model.trainRows} / {model.validationRows} / {model.holdoutRows}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Temperature: </dt><dd className="inline mono">{model.temperature.toFixed(2)}</dd></div>
          <div className="sm:col-span-2"><dt className="inline font-semibold text-foreground/70">Origin: </dt><dd className="inline">{model.origin}</dd></div>
          <div className="sm:col-span-2"><dt className="inline font-semibold text-foreground/70">Runtime: </dt><dd className="inline">{model.runtime}</dd></div>
        </dl>
      </details>

      <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
        The network is fitted from scratch on this market’s own ticks whenever Run Analysis runs — nothing is downloaded and no
        account, key or per-token cost is involved. It is one more measured source: its forecast is blended into the published
        probability only after it beats the no-edge baseline on a purged, chronological holdout it never saw.
      </p>
    </section>
  );
}
