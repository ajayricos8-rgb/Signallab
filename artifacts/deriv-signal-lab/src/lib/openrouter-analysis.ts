import { z } from 'zod';
import type { ScanJobResult } from './signal-engine/scan-protocol.ts';
import type { ScanMarketJob } from './signal-engine/scan-runner.ts';

const reviewSchema = z.object({
  candidateId: z.string().max(80), model: z.string().max(200), reviewedAt: z.number().finite(),
  stance: z.enum(['support', 'caution', 'oppose']),
  analysis: z.string().max(2400), prediction: z.string().max(1600), entry: z.string().max(1600),
  risks: z.array(z.string().max(600)).max(6), horizonTicks: z.number().int().min(10).max(15),
});
export const connectionSchema = z.object({
  status: z.enum(['not_configured', 'connected', 'unavailable']), configured: z.boolean(),
  message: z.string(), freeModels: z.number(), checkedAt: z.number(),
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
  try {
    const response = await fetch('/api/openrouter/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAiEvidence(results, jobs)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(50_000)]),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(typeof body?.error === 'string' ? body.error : 'OpenRouter review unavailable. Check the connection in Settings.');
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
    return { results, aiReview: { status: 'unavailable', message: error instanceof z.ZodError
      ? 'AI returned invalid analysis. Engine ranking and probabilities are unchanged.'
      : error instanceof Error ? error.message : 'OpenRouter unavailable. Engine-only result shown.' } };
  }
}
