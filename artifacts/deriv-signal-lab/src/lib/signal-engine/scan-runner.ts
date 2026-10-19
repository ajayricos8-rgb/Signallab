// Parallel market scan: a small pool of Web Workers analyses one market each,
// streaming per-market progress that is folded into one overall percentage.
//
// Workers are an optimisation, never a dependency: every job is guaranteed to
// finish either in a worker or on the main thread. A worker whose script fails
// to load (404, wrong MIME, CSP or proxy quirks, legacy browser), whose thread
// dies mid-job, or that never answers the handshake is detected, replaced once
// and its job retried; a job that loses two workers is analysed inline on the
// main thread. Run Analysis therefore always ends in ranked signals instead of
// a crash banner, on every hosting environment.
import type { ScanJob, ScanJobResult, WorkerRequest, WorkerResponse } from './scan-protocol.ts';
import { runScanJob } from './scan-protocol.ts';

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
  /** How long a freshly created worker may stay silent before it is replaced. */
  handshakeTimeoutMs?: number;
};

export function defaultWorkerCount(): number {
  const cores = typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

function abortError() {
  return new DOMException('The analysis was cancelled.', 'AbortError');
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Analysis failed.';
}

async function runOnMainThread(jobs: ScanMarketJob[], options: ScanOptions): Promise<ScanOutcome> {
  const started = Date.now();
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
      const failure = { symbol: job.symbol, name: job.name, message: failureMessage(error) };
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
    const handshakeMs = options.handshakeTimeoutMs ?? 8_000;
    const maxCreations = workerCount * 3 + 2;
    const fractions = jobs.map(() => 0);
    const stages = jobs.map(() => 'Queued');
    const running = new Set<number>();
    const results: ScanJobResult[] = [];
    const failures: ScanFailure[] = [];
    /** Jobs whose worker died; dispatched before untouched jobs. */
    const retryQueue: number[] = [];
    /** Jobs that lost two workers; only the main thread may run them. */
    const inlineQueue: number[] = [];
    const attempts = jobs.map(() => 0);
    let nextJob = 0;
    let completed = 0;
    let finished = false;
    let creations = 1; // the probe
    let workersUsed = 0;
    let mainThreadBusy = false;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    type Slot = {
      worker: Worker;
      jobId: number | null;
      timer: ReturnType<typeof setTimeout> | null;
      handshakeTimer: ReturnType<typeof setTimeout> | null;
      ready: boolean;
      dead: boolean;
    };
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
      for (const slot of slots) {
        if (slot.timer) clearTimeout(slot.timer);
        if (slot.handshakeTimer) clearTimeout(slot.handshakeTimer);
        slot.worker.terminate();
      }
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { if (finished) return; cleanup(); reject(abortError()); };
    options.signal?.addEventListener('abort', onAbort);

    const settle = () => {
      options.onProgress({ fraction: 1, stage: 'Finalizing signal', completed, total: jobs.length, active: [] });
      cleanup();
      resolve({ results, failures, durationMs: Date.now() - started, workers: workersUsed });
    };

    const completeJob = (jobId: number) => {
      running.delete(jobId);
      fractions[jobId] = 1;
      stages[jobId] = 'Done';
      completed += 1;
      if (completed === jobs.length) { settle(); return; }
      scheduleProgress();
      rebalance();
    };

    const liveSlots = () => slots.some((slot) => !slot.dead);

    /** Main-thread execution: the last-resort path that keeps the scan alive. */
    const pumpInline = () => {
      if (finished || mainThreadBusy || !inlineQueue.length) return;
      const jobId = inlineQueue.shift()!;
      mainThreadBusy = true;
      running.add(jobId);
      stages[jobId] = 'Deep analysis (main thread)';
      scheduleProgress();
      void (async () => {
        await yieldToBrowser();
        if (finished) return;
        try {
          const result = runScanJob(jobs[jobId], (fraction, stage) => {
            if (finished) return;
            fractions[jobId] = Math.max(fractions[jobId], Math.min(0.99, fraction));
            stages[jobId] = stage;
            scheduleProgress();
          });
          results.push(result);
          options.onResult?.(result);
        } catch (error) {
          const failure = { symbol: jobs[jobId].symbol, name: jobs[jobId].name, message: failureMessage(error) };
          failures.push(failure);
          options.onFailure?.(failure);
        }
        mainThreadBusy = false;
        completeJob(jobId);
      })();
    };

    const dispatch = (slot: Slot) => {
      if (finished || slot.dead || !slot.ready || slot.jobId !== null) return;
      const jobId = retryQueue.length ? retryQueue.shift()! : nextJob < jobs.length ? nextJob++ : null;
      if (jobId === null) return;
      slot.jobId = jobId;
      running.add(jobId);
      stages[jobId] = 'Starting';
      const source = jobs[jobId];
      const request: WorkerRequest = { jobId, job: source.kind === 'digit' ? { kind: 'digit', input: source.input } : { kind: 'rise-fall', input: source.input } };
      slot.timer = setTimeout(() => workerFault(slot), timeoutMs);
      slot.worker.postMessage(request);
      scheduleProgress();
    };

    const rebalance = () => {
      if (finished) return;
      if (!liveSlots()) {
        // No worker left: everything outstanding moves to the main thread.
        while (retryQueue.length) inlineQueue.push(retryQueue.shift()!);
        while (nextJob < jobs.length) inlineQueue.push(nextJob++);
      }
      for (const slot of slots) dispatch(slot);
      pumpInline();
    };

    const spawnReplacement = () => {
      if (finished || creations >= maxCreations) return;
      creations += 1;
      let worker: Worker;
      try {
        worker = createWorker();
      } catch {
        return;
      }
      const slot: Slot = { worker, jobId: null, timer: null, handshakeTimer: null, ready: false, dead: false };
      slots.push(slot);
      attach(slot);
    };

    /** A worker misbehaved (script load failure, crash, silence): retire it, retry its job. */
    const workerFault = (slot: Slot) => {
      if (finished || slot.dead) return;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      if (slot.handshakeTimer) clearTimeout(slot.handshakeTimer);
      slot.handshakeTimer = null;
      const jobId = slot.jobId;
      slot.jobId = null;
      slot.dead = true;
      slot.worker.terminate();
      if (jobId !== null) {
        running.delete(jobId);
        if (attempts[jobId] === 0) {
          attempts[jobId] = 1;
          retryQueue.push(jobId);
          stages[jobId] = 'Retrying analysis';
        } else {
          inlineQueue.push(jobId);
        }
      }
      spawnReplacement();
      rebalance();
    };

    const attach = (slot: Slot) => {
      slot.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (finished) return;
        if (message.type === 'pong') {
          if (slot.dead) return;
          if (slot.handshakeTimer) clearTimeout(slot.handshakeTimer);
          slot.handshakeTimer = null;
          if (!slot.ready) {
            slot.ready = true;
            workersUsed += 1;
            rebalance();
          }
          return;
        }
        if (slot.jobId === null || message.jobId !== slot.jobId) return;
        const jobId = slot.jobId;
        if (message.type === 'progress') {
          fractions[jobId] = Math.max(fractions[jobId], Math.min(0.99, message.fraction));
          stages[jobId] = message.stage;
          scheduleProgress();
          return;
        }
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = null;
        slot.jobId = null;
        if (message.type === 'result') {
          results.push(message.result);
          options.onResult?.(message.result);
        } else {
          // The engines themselves threw inside the worker: a real analysis
          // failure for this market, not an infrastructure fault.
          const failure = { symbol: jobs[jobId].symbol, name: jobs[jobId].name, message: message.message || failureMessage(new Error('Analysis failed.')) };
          failures.push(failure);
          options.onFailure?.(failure);
        }
        completeJob(jobId);
        dispatch(slot);
      };
      slot.worker.onerror = (event) => {
        event.preventDefault();
        workerFault(slot);
      };
      slot.handshakeTimer = setTimeout(() => workerFault(slot), handshakeMs);
      slot.worker.postMessage({ handshake: true });
    };

    const first: Slot = { worker: probe, jobId: null, timer: null, handshakeTimer: null, ready: false, dead: false };
    slots.push(first);
    attach(first);
    for (let index = 1; index < workerCount; index += 1) {
      creations += 1;
      let worker: Worker;
      try {
        worker = createWorker();
      } catch {
        break;
      }
      const slot: Slot = { worker, jobId: null, timer: null, handshakeTimer: null, ready: false, dead: false };
      slots.push(slot);
      attach(slot);
    }
    emitProgress();
  });
}
