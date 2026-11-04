// Message contract between the scan runner and its Web Workers, plus the
// single entry point both the workers and the main-thread fallback execute.
import { analyzeDigitMarket, type DigitMarketAnalysis, type DigitMarketInput } from './digit-signal.ts';
import { analyzeRiseFallMarket, type RiseFallMarketAnalysis, type RiseFallMarketInput } from './rise-fall-signal.ts';

export type ScanJob =
  | { kind: 'digit'; input: DigitMarketInput }
  | { kind: 'rise-fall'; input: RiseFallMarketInput };
export type ScanJobResult = DigitMarketAnalysis | RiseFallMarketAnalysis;

/** `handshake` is sent right after construction to prove the worker script loaded. */
export type WorkerRequest = { jobId: number; job: ScanJob } | { handshake: true };
export type WorkerResponse =
  | { jobId: number; type: 'progress'; fraction: number; stage: string }
  | { jobId: number; type: 'result'; result: ScanJobResult }
  | { jobId: number; type: 'error'; message: string }
  | { type: 'pong' };

/** Shared worker and fallback entry point. AI Analysis must run these full market
 * analyzers (not a lightweight UI-only summary): they build the measurement,
 * quant-synthesis, validated forecast, neural and Forge layers before ranking. */
export function runScanJob(job: ScanJob, onProgress?: (fraction: number, stage: string) => void): ScanJobResult {
  return job.kind === 'digit' ? analyzeDigitMarket(job.input, onProgress) : analyzeRiseFallMarket(job.input, onProgress);
}

export { rankScanResults } from './scan-rank.ts';
