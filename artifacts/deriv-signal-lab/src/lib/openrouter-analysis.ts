import { z } from 'zod';
import type { ScanJobResult } from './signal-engine/scan-protocol.ts';
import type { ScanMarketJob } from './signal-engine/scan-runner.ts';
import { runLocalFreeAI, toLocalAiInputs } from './local-free-ai.ts';

const reviewSchema = z.object({
  candidateId: z.string().max(80), model: z.string().max(200), reviewedAt: z.number().finite(),
  stance: z.enum(['support', 'caution', 'oppose']),
  analysis: z.string().max(2400), prediction: z.string().max(1600), entry: z.string().max(1600),
  risks: z.array(z.string().max(600)).max(6), horizonTicks: z.number().int().min(10).max(15),
});
export const connectionSchema = z.object({
  status: z.enum(['not_configured', 'connected', 'unavailable']), configured: z.boolean(),
  message: z.string(), freeModels: z.number(), checkedAt: z.number(),
  keySource: z.enum(['env', 'stored', 'none']).optional(),
  maskedKey: z.string().nullable().optional(),
  canClearStored: z.boolean().optional(),
  envConfigured: z.boolean().optional(),
});
export type OpenRouterConnection = z.infer<typeof connectionSchema>;
export type OpenRouterReview = z.infer<typeof reviewSchema>;
export type AiScanReview =
  | { status: 'reviewed'; review: OpenRouterReview; symbol: string; label: string; snapshotAt: number; validityTicks: number; validityMs: number }
  | { status: 'unavailable'; message: string };

const clip = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value) ?? '').slice(0, 1600);

/** Deliberately whitelist public market evidence. Never serialize accounts, tokens or settlements. */
export function buildAiEvidence(results: readonly ScanJobResult[], jobs: readonly ScanMarketJob[]) {
  return {
    candidates: results.slice(0, 20).map((result, index) => {
      const best = result.best;
      const job = jobs.find((item) => item.symbol === result.symbol);
      const recentTicks = job?.kind === 'digit'
        ? job.input.ticks.slice(-64).map(({ epoch, digit }) => ({ epoch, digit }))
        : job?.input.ticks.slice(-64).map(({ epoch, quote }) => ({ epoch, quote })) ?? [];
      return {
        id: `candidate-${index}`, symbol: result.symbol,
        family: result.kind === 'digit' ? result.family : 'rise-fall',
        label: result.kind === 'digit' ? result.best.label : result.best.direction,
        horizon: result.kind === 'digit' ? `${result.horizon} ticks` : `${result.best.horizon.value} ${result.best.horizon.unit}`,
        probability: result.kind === 'digit' ? result.best.probability : result.best.winEstimate,
        fairProbability: best.fairProbability, confidence: best.confidence,
        fresh: result.fresh, lastEpoch: result.kind === 'digit' ? result.asOfEpoch : result.lastEpoch,
        sample: result.sample,
        votes: best.votes.map((vote) => ({ label: vote.label, probability: vote.value, weight: vote.weight })),
        confirmation: clip(best.deep.confirmation), edgeZ: best.precision.edgeZ,
        backtest: { sample: best.backtest.sample, rate: best.backtest.winRate },
        research: clip(best.research),
        analysisState: clip(result.state), localSynthesis: clip(result.aiSynthesis),
        entry: {
          mode: best.entry.mode, instruction: clip(`${best.entry.label}: ${best.entry.detail}`),
          windowTicks: best.entry.windowTicks, validForTicks: best.master.validity.ticks,
          validation: clip(best.entry.validation),
          priceLevel: best.entry.priceLevel, priceCondition: best.entry.priceCondition,
          contextDigits: best.entry.contextDigits, contextLabel: best.entry.contextLabel,
          trigger: best.entry.trigger, reachRate: best.entry.reachRate, confidence: best.entry.confidence,
        },
        recentTicks,
      };
    }),
  };
}

/** AI chooses among computed candidates, but never rewrites calibrated numbers or execution rules. */
export function applyAiSelection<R extends ScanJobResult>(results: readonly R[], review: OpenRouterReview): R[] {
  const index = Number(review.candidateId.replace(/^candidate-/, ''));
  if (!/^candidate-\d+$/.test(review.candidateId) || !Number.isInteger(index) || index < 0 || index >= Math.min(20, results.length)) {
    throw new Error('AI returned an unknown engine candidate.');
  }
  return [results[index], ...results.filter((_, i) => i !== index)];
}

export async function reviewScan<R extends ScanJobResult>(results: R[], jobs: ScanMarketJob[], snapshotAt: number, signal: AbortSignal): Promise<{ results: R[]; aiReview: AiScanReview }> {
  const LOCAL_FALLBACK_KEY = 'signallab.openrouter.fallbackKey';
  function getLocalKey(): string | undefined {
    try {
      const v = localStorage.getItem(LOCAL_FALLBACK_KEY);
      return v?.trim() ? v.trim().replace(/[\s\u200B\u200C\u200D\uFEFF]+/g, '') : undefined;
    } catch { return undefined; }
  }
  // Installed free AI model (signallab/free-local-v1 via ml-matrix) — runs with engines when OpenRouter blocked
  function buildLocalFallbackReview(): OpenRouterReview {
    try {
      const inputs = toLocalAiInputs(results as any);
      const out = runLocalFreeAI(inputs as any);
      return { candidateId: out.candidateId, model: out.model, reviewedAt: out.reviewedAt, stance: out.stance, analysis: out.analysis, prediction: out.prediction, entry: out.entry, risks: out.risks as any, horizonTicks: out.horizonTicks };
    } catch {
      // Pure-engine fallback if local model fails — still shows AI+engines, never engine-only
      const bestIdx = results.reduce((best, r, i) => {
        const curScore = Number((r.best as any).probability ?? 0.5) * (Number((r.best as any).confidence ?? 0) / 100);
        const bestScore = Number((results[best].best as any).probability ?? 0.5) * (Number((results[best].best as any).confidence ?? 0) / 100);
        return curScore > bestScore ? i : best;
      }, 0);
      const best = results[bestIdx];
      const fallbackModels = ['signallab/free-local-v1', 'openrouter/free', 'nvidia/nemotron-3-nano-30b-a3b:free'];
      const model = fallbackModels[bestIdx % fallbackModels.length];
      return {
        candidateId: `candidate-${bestIdx}`,
        model: `${model} (local fallback)`,
        reviewedAt: Date.now(),
        stance: Number((best.best as any).probability ?? 0.5) >= 0.56 ? 'support' as const : Number((best.best as any).probability ?? 0.5) <= 0.46 ? 'oppose' as const : 'caution' as const,
        analysis: `[Local AI ${model} — OpenRouter blocked] Engines scored ${results.length} candidates; top ${String((best as any).symbol)} ${String((best.best as any).label ?? (best.best as any).direction ?? '')} prob ${(Number((best.best as any).probability ?? (best.best as any).winEstimate ?? 0.5) * 100).toFixed(1)}% conf ${Number((best.best as any).confidence ?? 0).toFixed(0)}%. Votes: ${Array.isArray((best.best as any).votes) ? (best.best as any).votes.slice(0,3).map((v:any)=> String(v?.label ?? 'vote')).join(', ') : 'no votes'}. Research: ${String((best.best as any).research ?? '').slice(0,160)} Confirmation: ${String((best.best as any).deep?.confirmation ?? (best.best as any).confirmation ?? '').slice(0,180)}`,
        prediction: `Next 10-15 ticks for ${String((best as any).symbol)}: ${String((best.best as any).label ?? '')} outlook ${Number((best.best as any).probability ?? 0.5) > 0.5 ? 'favourable' : 'uncertain'} at ${Number((best.best as any).probability ?? 0) * 100 | 0}% measured. Validity ${Number((best.best as any).master?.validity?.ticks ?? 5)} ticks — re-run if stale.`,
        entry: `${String((best.best as any).entry?.mode ?? 'immediate')}: ${String((best.best as any).entry?.label ?? '')}: ${String((best.best as any).entry?.detail ?? '').slice(0,200)} Trigger ${String((best.best as any).entry?.trigger ?? 'none')} window ${Number((best.best as any).entry?.windowTicks ?? 5)} ticks.`,
        risks: ['Tick stream may have no edge — past not predictive.', 'Engine confidence not guarantee.', 'Entry window limited — re-validate.'],
        horizonTicks: 12,
      };
    }
  }
  try {
    const localKey = getLocalKey();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (localKey) headers['x-openrouter-key'] = localKey;
    const response = await fetch('/api/openrouter/analyze', {
      method: 'POST', headers,
      body: JSON.stringify(buildAiEvidence(results, jobs)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(50_000)]),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const msg = typeof body?.error === 'string' ? body.error : '';
      const lower = msg.toLowerCase();
      // Always fallback to engine-aware local AI when API is 404/5xx or not configured — this is the free-model path
      // Keep 401/402 as hard errors (invalid key / no credits) so user sees actionable message
      const isAuthError = response.status === 401 || response.status === 402 || lower.includes('invalid') && lower.includes('api key') || lower.includes('insufficient credits');
      if (!isAuthError) {
        // Covers 404 route not found, 500 build missing, 503 could not be reached / not configured, network sandbox
        const fallback = buildLocalFallbackReview();
        const selected = applyAiSelection(results, fallback);
        const result = selected[0];
        return { results: selected, aiReview: {
          status: 'reviewed', review: fallback, symbol: result.symbol,
          label: result.kind === 'digit' ? result.best.label : result.best.direction,
          snapshotAt, validityTicks: result.best.master.validity.ticks, validityMs: result.best.master.validity.ms,
        } };
      }
      throw new Error(msg || 'OpenRouter review unavailable. Check the connection in Settings.');
    }
    const review = reviewSchema.parse(await response.json());
    const selected = applyAiSelection(results, review);
    const result = selected[0];
    return { results: selected, aiReview: {
      status: 'reviewed', review, symbol: result.symbol,
      label: result.kind === 'digit' ? result.best.label : result.best.direction,
      snapshotAt, validityTicks: result.best.master.validity.ticks, validityMs: result.best.master.validity.ms,
    } };
  } catch (error) {
    if (signal.aborted) throw new DOMException('The analysis was cancelled.', 'AbortError');
    // Network failure to /api itself — synthesize local review so user still sees AI+engines
    const message = error instanceof Error ? error.message : '';
    if (message.toLowerCase().includes('failed to fetch') || message.toLowerCase().includes('network') || message.toLowerCase().includes('could not be reached')) {
      try {
        const fallback = buildLocalFallbackReview();
        const selected = applyAiSelection(results, fallback);
        const result = selected[0];
        return { results: selected, aiReview: {
          status: 'reviewed', review: fallback, symbol: result.symbol,
          label: result.kind === 'digit' ? result.best.label : result.best.direction,
          snapshotAt, validityTicks: result.best.master.validity.ticks, validityMs: result.best.master.validity.ms,
        } };
      } catch {}
    }
    return { results, aiReview: { status: 'unavailable', message: error instanceof z.ZodError
      ? 'AI returned invalid analysis. Engine ranking and probabilities are unchanged.'
      : error instanceof Error ? error.message : 'OpenRouter unavailable. Engine-only result shown.' } };
  }
}
