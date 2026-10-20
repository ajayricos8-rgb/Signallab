import { AlertTriangle, BrainCircuit } from 'lucide-react';
import type { AiScanReview } from '@/lib/openrouter-analysis';

export function OpenRouterReviewCard({ review, now }: { review: AiScanReview; now: number }) {
  if (review.status === 'unavailable') return (
    <aside className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs" role="status" data-testid="openrouter-review-unavailable">
      <div className="flex items-center gap-2 font-bold text-amber-500"><AlertTriangle size={14} /> Engine-only result · external AI unavailable</div>
      <p className="mt-2 text-muted-foreground">{review.message}</p>
      <p className="mt-1 text-muted-foreground">No external AI signal was generated. Check OpenRouter in Settings; engine calculations are unchanged.</p>
    </aside>
  );
  const ai = review.review;
  const expired = now - review.snapshotAt >= review.validityMs;
  const tone = ai.stance === 'support' ? 'text-emerald-500' : 'text-amber-500';
  return (
    <article className="rounded-xl border border-primary/30 bg-card/90 p-4 panel-glow sm:p-5" data-testid="openrouter-review">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><BrainCircuit size={13} /> External AI + engines + calculations</div>
          <h3 className="mt-1 text-sm font-bold">{review.label} · {review.symbol}</h3>
          <p className="mono mt-1 text-[11px] text-muted-foreground">{ai.model} · randomly selected free model</p>
        </div>
        <span className={`rounded-full border border-current px-2.5 py-1 text-[10px] font-bold uppercase ${tone}`}>{ai.stance === 'support' ? 'AI supports candidate' : ai.stance === 'oppose' ? 'AI opposes entry' : 'AI advises caution'}</span>
      </div>
      <div className="mt-4 grid gap-4 text-xs leading-relaxed md:grid-cols-3">
        {[['Analysis', ai.analysis], [`Prediction · next ${ai.horizonTicks} ticks`, ai.prediction], ['Entry & invalidation', ai.entry]].map(([title, body]) => (
          <div key={title}><h4 className="mb-1 font-bold text-foreground">{title}</h4><p className="whitespace-pre-line text-muted-foreground">{body}</p></div>
        ))}
      </div>
      <ul className="mt-3 list-inside list-disc space-y-1 text-[11px] text-muted-foreground">{ai.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul>
      <p className={`mt-3 rounded-lg border border-border p-2 text-[11px] ${expired ? 'text-amber-500' : 'text-muted-foreground'}`}>
        {expired ? 'The measured entry window elapsed during analysis — re-run before acting. ' : ''}
        AI outlook: {ai.horizonTicks} ticks. Engine-measured validity: {review.validityTicks} tick{review.validityTicks === 1 ? '' : 's'} from the market snapshot, not from the AI response.
        {' '}AI selects among computed candidates; it cannot increase the measured probability, alter the entry trigger, or certify a stronger signal. No outcome is guaranteed.
      </p>
    </article>
  );
}
