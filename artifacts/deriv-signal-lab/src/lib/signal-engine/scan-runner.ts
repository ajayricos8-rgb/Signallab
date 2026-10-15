// Parallel market scan: a small pool of Web Workers analyses one market each,
// streaming per-market progress that is folded into one overall percentage.
// Falls back to the main thread when Workers are unavailable.
import type { ScanJob, ScanJobResult, WorkerRequest, WorkerResponse } from './scan-protocol.ts';

export type ScanMarketJob = ScanJob & { symbol: string; name: string };

export type ScanProgressState = {
  /** Overall completion from 0 to 1. */
  fraction: number;
  stage: string;
  completed: number;
  total: number;
  active: Array<{ symbol: string; name: string; fraction: number; stage: string }>;
};

export type ScanFailure = { symbol: string; name: string; message: string };
export type ScanOutcome = { results: ScanJobResult[]; failures: ScanFailure[]; durationMs: number; workers: number };

export type ScanOptions = {
  onProgress: (progress: ScanProgressState) => void;
  onResult?: (result: ScanJobResult) => void;
  onFailure?: (failure: ScanFailure) => void;
  signal?: AbortSignal;
  maxWorkers?: number;
  jobTimeoutMs?: number;
};

export function defaultWorkerCount(): number {
  const cores = typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

function abortError() {
  return new DOMException('The analysis was cancelled.', 'AbortError');
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function runOnMainThread(jobs: ScanMarketJob[], options: ScanOptions): Promise<ScanOutcome> {
  const started = Date.now();
  // Loaded only when Web Workers are unavailable, keeping the engines out of the UI bundle.
  const { runScanJob } = await import('./scan-protocol.ts');
  const results: ScanJobResult[] = [];
  const failures: ScanFailure[] = [];
  for (let index = 0; index < jobs.length; index += 1) {
    if (options.signal?.aborted) throw abortError();
    const job = jobs[index];
    options.onProgress({ fraction: index / jobs.length, stage: `Analysing ${job.name}`, completed: index, total: jobs.length, active: [{ symbol: job.symbol, name: job.name, fraction: 0, stage: 'Starting' }] });
    await yieldToBrowser();
    try {
      const result = runScanJob(job);
      results.push(result);
      options.onResult?.(result);
    } catch (error) {
      const failure = { symbol: job.symbol, name: job.name, message: error instanceof Error ? error.message : 'Analysis failed.' };
      failures.push(failure);
      options.onFailure?.(failure);
    }
  }
  options.onProgress({ fraction: 1, stage: 'Finalizing signal', completed: jobs.length, total: jobs.length, active: [] });
  return { results, failures, durationMs: Date.now() - started, workers: 0 };
}

export function runScan(jobs: ScanMarketJob[], options: ScanOptions): Promise<ScanOutcome> {
  if (!jobs.length) return Promise.resolve({ results: [], failures: [], durationMs: 0, workers: 0 });
  if (typeof Worker === 'undefined') return runOnMainThread(jobs, options);
  const createWorker = () => new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' });
  let probe: Worker;
  try {
    probe = createWorker();
  } catch {
    return runOnMainThread(jobs, options);
  }

  return new Promise<ScanOutcome>((resolve, reject) => {
    const started = Date.now();
    const workerCount = Math.max(1, Math.min(jobs.length, options.maxWorkers ?? defaultWorkerCount()));
    const timeoutMs = options.jobTimeoutMs ?? 90_000;
    const fractions = jobs.map(() => 0);
    const stages = jobs.map(() => 'Queued');
    const running = new Set<number>();
    const results: ScanJobResult[] = [];
    const failures: ScanFailure[] = [];
    let nextJob = 0;
    let completed = 0;
    let finished = false;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    type Slot = { worker: Worker; jobId: number | null; timer: ReturnType<typeof setTimeout> | null; dead: boolean };
    const slots: Slot[] = [];

    const emitProgress = () => {
      progressTimer = null;
      if (finished) return;
      const fraction = fractions.reduce((sum, value) => sum + value, 0) / jobs.length;
      const active = [...running].map((jobId) => ({ symbol: jobs[jobId].symbol, name: jobs[jobId].name, fraction: fractions[jobId], stage: stages[jobId] }));
      const lead = active[0];
      options.onProgress({
        fraction, completed, total: jobs.length, active,
        stage: lead ? `${lead.name}: ${lead.stage}` : completed === jobs.length ? 'Finalizing signal' : 'Preparing markets',
      });
    };
    const scheduleProgress = () => { if (!progressTimer) progressTimer = setTimeout(emitProgress, 80); };

    const cleanup = () => {
      finished = true;
      if (progressTimer) clearTimeout(progressTimer);
      for (const slot of slots) { if (slot.timer) clearTimeout(slot.timer); slot.worker.terminate(); }
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { if (finished) return; cleanup(); reject(abortError()); };
    options.signal?.addEventListener('abort', onAbort);

    const finishJob = (slot: Slot) => {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      if (slot.jobId !== null) { running.delete(slot.jobId); fractions[slot.jobId] = 1; }
      slot.jobId = null;
      completed += 1;
      if (completed === jobs.length) {
        options.onProgress({ fraction: 1, stage: 'Finalizing signal', completed, total: jobs.length, active: [] });
        cleanup();
        resolve({ results, failures, durationMs: Date.now() - started, workers: workerCount });
        return;
      }
      scheduleProgress();
      dispatch(slot);
    };

    const replaceWorker = (slot: Slot) => {
      slot.worker.terminate();
      try {
        slot.worker = createWorker();
        attach(slot);
      } catch {
        // This slot stops taking work; the remaining workers keep going.
        slot.dead = true;
      }
    };

    const failQueuedIfStranded = () => {
      if (slots.some((slot) => !slot.dead)) return;
      while (nextJob < jobs.length) {
        const job = jobs[nextJob];
        failures.push({ symbol: job.symbol, name: job.name, message: 'No analysis worker is available.' });
        nextJob += 1;
        completed += 1;
      }
      if (completed === jobs.length && !finished) {
        cleanup();
        resolve({ results, failures, durationMs: Date.now() - started, workers: workerCount });
      }
    };

    const fail = (slot: Slot, message: string, restart: boolean) => {
      if (slot.jobId === null) return;
      const job = jobs[slot.jobId];
      const failure = { symbol: job.symbol, name: job.name, message };
      failures.push(failure);
      options.onFailure?.(failure);
      if (restart) replaceWorker(slot);
      finishJob(slot);
    };

    const attach = (slot: Slot) => {
      slot.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (finished || slot.jobId === null || message.jobId !== slot.jobId) return;
        if (message.type === 'progress') {
          fractions[message.jobId] = Math.max(fractions[message.jobId], Math.min(0.99, message.fraction));
          stages[message.jobId] = message.stage;
          scheduleProgress();
        } else if (message.type === 'result') {
          results.push(message.result);
          options.onResult?.(message.result);
          finishJob(slot);
        } else {
          fail(slot, message.message, false);
        }
      };
      slot.worker.onerror = (event) => {
        event.preventDefault();
        fail(slot, event.message || 'The analysis worker crashed.', true);
      };
    };

    const dispatch = (slot: Slot) => {
      if (finished || nextJob >= jobs.length) return;
      if (slot.dead) { failQueuedIfStranded(); return; }
      const jobId = nextJob;
      nextJob += 1;
      slot.jobId = jobId;
      running.add(jobId);
      stages[jobId] = 'Starting';
      const job = jobs[jobId];
      const request: WorkerRequest = { jobId, job: job.kind === 'digit' ? { kind: 'digit', input: job.input } : { kind: 'rise-fall', input: job.input } };
      slot.timer = setTimeout(() => fail(slot, 'Analysis timed out for this market.', true), timeoutMs);
      slot.worker.postMessage(request);
      scheduleProgress();
    };

    for (let index = 0; index < workerCount; index += 1) {
      let worker: Worker;
      try {
        worker = index === 0 ? probe : createWorker();
      } catch {
        break;
      }
      const slot: Slot = { worker, jobId: null, timer: null, dead: false };
      slots.push(slot);
      attach(slot);
    }
    for (const slot of slots) dispatch(slot);
    emitProgress();
  });
}
