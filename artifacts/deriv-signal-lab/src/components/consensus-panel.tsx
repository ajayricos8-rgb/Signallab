import { tierDescription, type AnalysisProgress, type ConsensusSignal } from '@/lib/engine-consensus';

/** Determinate scan progress bar with stage label and percentage. */
export function ScanProgressBar({ progress }: { progress: AnalysisProgress | null }) {
  if (!progress) return null;
  const percent = Math.max(0, Math.min(100, progress.percent));
  return (
    <div className="mt-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2.5" data-testid="analysis-progress" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-[11px] font-semibold">
        <span className="text-primary">{progress.stage}</span>
        <span className="mono text-primary" data-testid="analysis-progress-percent">{percent}%</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** Confidence score, tier badge and engines-agreed tally for one consensus signal. */
export function ConsensusCard({ signal }: { signal: ConsensusSignal }) {
  const agreementPercent = Math.round(signal.agreement * 100);
  const tierTone = signal.tier === 'STRONG'
    ? 'border-primary/30 bg-primary/10 text-primary'
    : signal.tier === 'MODERATE'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-500'
      : 'border-border bg-secondary/60 text-muted-foreground';
  return (
    <div className="w-full max-w-sm rounded-xl border border-primary/25 bg-primary/5 px-4 py-3" data-testid="consensus-card">
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-primary">Engine consensus · research estimate</div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] text-muted-foreground">Confidence score</div>
          <div className="text-3xl font-extrabold tracking-[-0.04em] text-primary" data-testid="consensus-confidence">{signal.confidence}%</div>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${tierTone}`} data-testid="consensus-tier">{signal.tier}</span>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span data-testid="consensus-agreement">Engines agreed {signal.votesFor} / {signal.votesTotal}</span>
          <span className="mono">{agreementPercent}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-primary" style={{ width: `${agreementPercent}%` }} />
        </div>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{tierDescription(signal.tier)}.{signal.note ? ` ${signal.note}` : ''}</p>
    </div>
  );
}
