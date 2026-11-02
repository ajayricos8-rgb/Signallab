// Layer 8 on the tool pages: the forged model.
//
// The card is deliberately explicit about three things a "unified AI" claim
// usually hides: what the model was TRAINED ON (the engines' replayed state,
// the AI layers, the calculations and the Deriv knowledge base), how it was
// MEASURED (a purged chronological holdout, scored once), and what it actually
// DID to the call on screen (confirmed, trimmed or vetoed — or nothing at all).
import { BrainCircuit, CircleSlash, Coins, Cpu, Flame, Gauge, ShieldCheck, Sparkles } from 'lucide-react';
import type { ForgeFusion, ForgedModel } from '@/lib/forge/types';
import { forgeKnowledgeReport } from '@/lib/forge/forge';

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

const DECISION_COPY: Record<ForgeFusion['decision'], { label: string; badge: string }> = {
  confirm: { label: 'Confirmed · voting', badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' },
  trim: { label: 'Trimmed the edge', badge: 'border-amber-500/40 bg-amber-500/10 text-amber-500' },
  veto: { label: 'Vetoed the entry', badge: 'border-rose-500/40 bg-rose-500/10 text-rose-500' },
  inert: { label: 'No vote on this market', badge: 'border-border bg-background/50 text-muted-foreground' },
};

export function ForgeModelCard({ model, fusion }: { model: ForgedModel; fusion?: ForgeFusion | null }) {
  const { card, metrics } = model;
  const knowledge = forgeKnowledgeReport(card.family);
  const decision = DECISION_COPY[fusion?.decision ?? 'inert'];
  const validated = metrics.validated && model.weight > 0;

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="forge-model-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Flame size={12} /> Primary signal model · Forge · engines + AI + research + calculations</div>
          <h3 className="mt-1 text-sm font-bold">{card.name}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span className="mono">{card.id} · v{card.version}</span>
            <span className="inline-flex items-center gap-1"><Cpu size={10} /> {card.parameters.toLocaleString()} params</span>
            <span className="mono">{card.shape.join('→')}</span>
            <span className="inline-flex items-center gap-1"><BrainCircuit size={10} /> {knowledge.summary.total} knowledge entries</span>
            <span className="inline-flex items-center gap-1 text-emerald-500"><Coins size={10} /> free</span>
            <span className="mono">{card.license}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] ${decision.badge}`} data-testid="forge-model-state">
            {fusion?.decision === 'veto' ? <CircleSlash size={11} className="mr-1 inline" /> : <ShieldCheck size={11} className="mr-1 inline" />}
            {decision.label}
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"><Gauge size={10} /> drive <strong className="mono text-foreground">{fusion?.drive ?? model.drive}/100</strong></span>
        </div>
      </div>

      <p className="mt-2 rounded-lg border border-border bg-background/30 px-3 py-2 text-[11px] leading-relaxed text-foreground/80" data-testid="forge-analysis">
        {model.analysis}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric
          label="Holdout hit rate"
          value={`${pct(metrics.accuracy)} vs ${pct(metrics.baselineAccuracy)}`}
          hint="Accuracy on replayed calls the forged model never trained on, against the no-edge rate."
        />
        <Metric
          label="Brier skill"
          value={pct(metrics.brierSkill)}
          hint="Improvement over the fair rate on the holdout slice. Negative means the model was worse than chance."
        />
        <Metric
          label="Paired z / bar"
          value={`${metrics.z === null ? '—' : metrics.z.toFixed(2)} / ${metrics.zBar.toFixed(2)}`}
          hint="Statistical strength of that improvement against the bar this fit had to clear. The bar rises with the number of candidates compared."
        />
        <Metric
          label="Rows"
          value={`${metrics.trainRows} / ${metrics.validationRows} / ${metrics.holdoutRows}`}
          hint="Train / validation / holdout rows, split chronologically with a purge gap."
        />
        <Metric
          label="Residual kept"
          value={pct(metrics.residualScale, 0)}
          hint="How much of the network's own correction survived validation. Zero means the forge is publishing the audited ensemble unchanged."
        />
        <Metric
          label="Temperature"
          value={metrics.temperature.toFixed(2)}
          hint="Scalar fitted on the validation slice so the forged probabilities are neither over- nor under-confident."
        />
      </div>

      <div className="mt-3 rounded-lg border border-border bg-background/30 px-3 py-2 text-[11px] leading-relaxed" data-testid="forge-fusion-note">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          <Sparkles size={11} /> What it did to this signal
        </div>
        <p className="mt-1 text-foreground/80">{fusion?.note ?? model.note}</p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
          <span>Forge view <strong className="mono text-foreground">{pct(fusion?.modelProbability ?? model.probability)}</strong></span>
          <span>published after Forge <strong className="mono text-foreground">{pct(fusion?.probability ?? model.probability)}</strong></span>
          <span>fair <strong className="mono text-foreground">{pct(model.fair)}</strong></span>
          <span>edge <strong className="mono text-foreground">{model.edgePts >= 0 ? '+' : ''}{model.edgePts.toFixed(2)} pts</strong></span>
          <span>weight <strong className="mono text-foreground">{pct(fusion?.weight ?? 0, 0)}</strong></span>
          <span>
            contribution <strong className={`mono ${(fusion?.contributionPts ?? 0) > 0 ? 'text-emerald-500' : (fusion?.contributionPts ?? 0) < 0 ? 'text-rose-500' : 'text-foreground'}`}>
              {(fusion?.contributionPts ?? 0) >= 0 ? '+' : ''}{(fusion?.contributionPts ?? 0).toFixed(2)} pts
            </strong>
          </span>
        </div>
      </div>

      <details className="mt-3 rounded-lg border border-border bg-background/20 px-3 py-2 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer font-semibold text-foreground/80">Why it passed or failed its gate</summary>
        <ul className="mt-2 space-y-1">
          {metrics.gate.map((line) => <li key={line}>· {line}</li>)}
        </ul>
      </details>

      <details className="mt-2 rounded-lg border border-border bg-background/20 px-3 py-2 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer font-semibold text-foreground/80">Curriculum · what it was taught, in order</summary>
        <ol className="mt-2 space-y-1.5">
          {card.stages.map((stage, index) => (
            <li key={stage.id}>
              <span className="font-semibold text-foreground/80">{index + 1}. {stage.label}</span>
              <span className="mono"> · {stage.size.toLocaleString()}</span>
              <div className="leading-snug">{stage.detail}</div>
            </li>
          ))}
        </ol>
        <p className="mt-2">Teachers distilled into every label: {card.teachers.join(' · ')}.</p>
      </details>

      <details className="mt-2 rounded-lg border border-border bg-background/20 px-3 py-2 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer font-semibold text-foreground/80">Knowledge base v{knowledge.summary.version} · {knowledge.summary.total} entries · {knowledge.markets} markets in the atlas</summary>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {knowledge.summary.byDomain.map((entry) => (
            <span key={entry.domain} className="rounded-full border border-border px-1.5 py-0.5">{entry.domain} {entry.count}</span>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {knowledge.summary.byUse.map((entry) => (
            <span key={entry.use} className="rounded-full border border-border px-1.5 py-0.5">{entry.use} {entry.count}</span>
          ))}
        </div>
        <div className="mt-2">
          <div className="font-semibold text-foreground/70">Rules that can only remove conviction</div>
          <ul className="mt-1 space-y-0.5">{knowledge.summary.vetoes.map((line) => <li key={line}>· {line}</li>)}</ul>
        </div>
      </details>

      <details className="mt-2 rounded-lg border border-border bg-background/20 px-3 py-2 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer font-semibold text-foreground/80">Model card · {card.features.length} frozen inputs</summary>
        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <div><dt className="inline font-semibold text-foreground/70">Task: </dt><dd className="inline">{card.task}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Activation: </dt><dd className="inline">{card.activation} · {card.optimizer}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Learning rate: </dt><dd className="inline mono">{card.learningRate}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">L2: </dt><dd className="inline mono">{card.l2}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Distillation: </dt><dd className="inline mono">{pct(card.distillation, 0)} of each label</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Epochs: </dt><dd className="inline mono">{card.epochsRun}/{card.epochsPlanned} (kept {card.bestEpoch})</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Seed: </dt><dd className="inline mono">{card.seed}</dd></div>
          <div><dt className="inline font-semibold text-foreground/70">Knowledge: </dt><dd className="inline mono">v{card.knowledgeVersion}</dd></div>
          <div className="sm:col-span-2"><dt className="inline font-semibold text-foreground/70">Origin: </dt><dd className="inline">{card.origin}</dd></div>
          <div className="sm:col-span-2"><dt className="inline font-semibold text-foreground/70">Runtime: </dt><dd className="inline">{card.runtime}</dd></div>
        </dl>
        <div className="mt-2">
          <div className="font-semibold text-foreground/70">Inputs</div>
          <div className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
            {card.features.map((feature) => (
              <div key={feature.key}><span className="mono">{feature.index.toString().padStart(2, '0')}</span> {feature.label}</div>
            ))}
          </div>
        </div>
      </details>

      <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
        Forge is fitted from scratch on this market’s own replayed calls whenever Run Analysis runs: it uses the engines, the AI,
        origin-aligned research and neural forecasts, the calculations and the Deriv knowledge syllabus. Nothing is downloaded and no
        account, key or per-token cost is involved. It may move the published probability only after passing its purged,
        chronological holdout gate; then it can confirm, trim or hard-veto entry. It never places an order.
      </p>
    </section>
  );
}

/** Fail-closed state: keep Forge visible even when the replay is too thin to fit. */
export function ForgeUnavailableCard({ family, label }: { family: 'digit' | 'rise-fall'; label: string }) {
  return (
    <section className="rounded-xl border border-dashed border-border bg-card/70 p-4 sm:p-5" data-testid="forge-model-card" data-forge-state="unavailable">
      <div className="eyebrow flex items-center gap-1.5"><Flame size={12} /> Primary signal model · Forge</div>
      <h3 className="mt-1 text-sm font-bold">Forge was not fitted for this call</h3>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        The {family === 'digit' ? 'digit contract' : 'Rise/Fall'} replay for {label} did not provide enough settled, causal rows and usable votes to meet Forge’s existing training and holdout gates. The tool keeps the validated upstream estimate unchanged rather than weakening those gates.
      </p>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        When the required replay is available, Forge combines engines, AI, independent research, horizon-matched neural forecasts, calculations and the Deriv knowledge syllabus. Live payout and proposal checks remain separate.
      </p>
    </section>
  );
}
