import { Loader2 } from 'lucide-react';
import type { SignalConsensus } from '@/lib/signal-confidence';

export type AnalysisProgressState = { percent: number; phase: string };

const toneFor = (percent: number) => (percent >= 100 ? 'bg-emerald-500' : 'bg-primary');

/**
 * Live percentage for a running scan. Every tool reports real phase progress
 * (engines fitted, outcomes measured, markets scanned) rather than a fake timer,
 * so the number always reflects work that has actually finished.
 */
export function AnalysisProgress({ progress, label = 'Analysis progress', compact = false }: {
  progress: AnalysisProgressState | null;
  label?: string;
  compact?: boolean;
}) {
  if (!progress) return null;
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  return (
    <div className={compact ? 'mt-3' : 'mt-4'} data-testid="analysis-progress" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          {percent < 100 && <Loader2 size={13} className="shrink-0 animate-spin text-primary" />}
          <span className="truncate">{label}</span>
        </span>
        <span className="mono shrink-0 text-sm font-extrabold text-primary" data-testid="analysis-progress-percent">{percent}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <div className={`h-full rounded-full transition-[width] duration-200 ease-out ${toneFor(percent)}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1.5 truncate text-[10px] text-muted-foreground" data-testid="analysis-progress-phase">{progress.phase}</div>
    </div>
  );
}

const gradeTone: Record<SignalConsensus['grade'], string> = {
  'very strong': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  strong: 'border-primary/30 bg-primary/10 text-primary',
  moderate: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
  weak: 'border-orange-500/30 bg-orange-500/10 text-orange-500',
  'very weak': 'border-destructive/30 bg-destructive/10 text-destructive',
};

const stanceTone = {
  support: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-500',
  oppose: 'border-rose-500/25 bg-rose-500/5 text-rose-500',
  neutral: 'border-border bg-background/40 text-muted-foreground',
} as const;

const stanceLabel = { support: 'Supports', oppose: 'Against', neutral: 'Abstains' } as const;

/**
 * The published answer after every completed scan: how many engines agreed, how
 * many engine families backed it, and the evidence confidence score with the
 * factors behind it. Confidence is an evidence score, never a win probability.
 */
export function SignalConfidenceCard({ consensus, title = 'Engine consensus and confidence', showVotes = false }: {
  consensus: SignalConsensus | null;
  title?: string;
  showVotes?: boolean;
}) {
  if (!consensus) return null;
  const percent = consensus.confidencePercent;
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="signal-confidence-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow">{title}</div>
          <h3 className="mt-1 text-sm font-bold">{consensus.enginesAgreed} of {consensus.enginesTotal} engines agree</h3>
          <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-muted-foreground">
            {consensus.familiesAgreed}/{consensus.familiesTotal} engine families support the signal · weighted agreement {(consensus.weightedAgreement * 100).toFixed(0)}%
            {consensus.enginesAbstained ? ` · ${consensus.enginesAbstained} engine${consensus.enginesAbstained === 1 ? '' : 's'} abstained on insufficient evidence` : ''}
            {consensus.enginesOpposed ? ` · ${consensus.enginesOpposed} voted against` : ''}.
          </p>
        </div>
        <div className="text-right">
          <div className="mono text-3xl font-extrabold tracking-[-0.05em] text-primary" data-testid="signal-confidence-percent">{percent}%</div>
          <div className="eyebrow mt-0.5">confidence score</div>
          <span className={`mt-2 inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${gradeTone[consensus.grade]}`} data-testid="signal-confidence-grade">{consensus.grade}</span>
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {consensus.factors.map((factor) => (
          <div key={factor.id} className="rounded-lg border border-border bg-background/35 px-3 py-2" data-testid={`confidence-factor-${factor.id}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="eyebrow">{factor.label}</span>
              <span className="mono text-[11px] font-bold">{Math.round(factor.score * 100)}%</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.round(factor.score * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">{factor.detail}</p>
          </div>
        ))}
      </div>

      {showVotes && (
        <details className="mt-3 rounded-lg border border-border bg-background/25" data-testid="signal-engine-votes">
          <summary className="cursor-pointer px-3 py-2.5 text-[11px] font-semibold">Inspect every engine vote ({consensus.votes.length})</summary>
          <div className="space-y-2 border-t border-border p-3">
            {consensus.votes.map((vote) => (
              <div key={`${vote.family}-${vote.id}`} className={`rounded-lg border px-3 py-2 ${stanceTone[vote.stance]}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-bold">{vote.label}</span>
                  <span className="mono text-[10px] font-semibold uppercase tracking-[0.08em]">{stanceLabel[vote.stance]}{vote.weight > 0 ? ` · weight ${(vote.weight * 100).toFixed(1)}%` : ' · no weight'}</span>
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{vote.detail}</p>
              </div>
            ))}
          </div>
        </details>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Confidence is an evidence score built from engine agreement, measured edge, held-out skill and sample size. It is not a calibrated win probability, a payout model or a guarantee about the next outcome.
      </p>
    </section>
  );
}
