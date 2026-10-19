/// <reference lib="webworker" />
// Runs one market analysis per message so the trading UI stays responsive.
import { runScanJob, type WorkerRequest, type WorkerResponse } from './scan-protocol.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
// structuredClone can refuse exotic payloads; a JSON round-trip keeps the
// progress/result stream alive instead of killing the worker thread.
const post = (message: WorkerResponse) => {
  try {
    scope.postMessage(message);
  } catch {
    try {
      scope.postMessage(JSON.parse(JSON.stringify(message)) as WorkerResponse);
    } catch {
      // Unpostable message: stay silent, the runner's timeout takes over.
    }
  }
};

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if ('handshake' in request) {
    post({ type: 'pong' });
    return;
  }
  const { jobId, job } = request;
  let lastPostedAt = 0;
  let lastStage = '';
  try {
    const result = runScanJob(job, (fraction, stage) => {
      const now = Date.now();
      // Throttle chatty progress, but always forward stage changes.
      if (stage === lastStage && now - lastPostedAt < 100) return;
      lastPostedAt = now;
      lastStage = stage;
      post({ jobId, type: 'progress', fraction, stage });
    });
    post({ jobId, type: 'result', result });
  } catch (error) {
    post({ jobId, type: 'error', message: error instanceof Error && error.message ? error.message : 'The analysis engines could not finish.' });
  }
};
