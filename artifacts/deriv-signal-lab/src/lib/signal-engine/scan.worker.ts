/// <reference lib="webworker" />
// Runs one market analysis per message so the trading UI stays responsive.
import { runScanJob, type WorkerRequest, type WorkerResponse } from './scan-protocol.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: WorkerResponse) => scope.postMessage(message);

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { jobId, job } = event.data;
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
    post({ jobId, type: 'error', message: error instanceof Error ? error.message : 'The analysis engines could not finish.' });
  }
};
