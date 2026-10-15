import test from 'node:test';
import assert from 'node:assert/strict';
import { runScanJob } from '../src/lib/signal-engine/scan-protocol.ts';
import { runScan } from '../src/lib/signal-engine/scan-runner.ts';

// In-process stand-in for a browser Web Worker running scan.worker.ts: same
// message protocol, executed asynchronously on this thread.
class FakeWorker {
  static created = 0;
  constructor() { FakeWorker.created += 1; this.onmessage = null; this.onerror = null; this.terminated = false; }
  postMessage({ jobId, job }) {
    setTimeout(() => {
      if (this.terminated) return;
      const emit = (data) => { if (!this.terminated) this.onmessage?.({ data }); };
      try {
        const result = runScanJob(job, (fraction, stage) => emit({ jobId, type: 'progress', fraction, stage }));
        emit({ jobId, type: 'result', result });
      } catch (error) {
        emit({ jobId, type: 'error', message: error.message });
      }
    }, 0);
  }
  terminate() { this.terminated = true; }
}

const digitJob = (symbol, length = 900) => ({
  kind: 'digit', symbol, name: `Market ${symbol}`,
  input: { family: 'even-odd', symbol, name: `Market ${symbol}`, horizon: 1, fresh: true, ticks: Array.from({ length }, (_, index) => ({ epoch: 1_700_000_000 + index, digit: (index * 3 + symbol.length) % 10 })) },
});

test('worker pool analyses every market, reports monotonic progress and isolates failures', async () => {
  globalThis.Worker = FakeWorker;
  const progress = [];
  const finished = [];
  const failed = [];
  const outcome = await runScan([digitJob('A'), digitJob('BB'), digitJob('CCC', 100), digitJob('DDDD')], {
    maxWorkers: 2,
    onProgress: (update) => progress.push(update.fraction),
    onResult: (result) => finished.push(result.symbol),
    onFailure: (failure) => failed.push(failure.symbol),
  });
  assert.equal(outcome.results.length, 3);
  assert.deepEqual(outcome.failures.map((failure) => failure.symbol), ['CCC']);
  assert.match(outcome.failures[0].message, /500/);
  assert.deepEqual(finished.sort(), ['A', 'BB', 'DDDD']);
  assert.deepEqual(failed, ['CCC']);
  assert.equal(outcome.workers, 2);
  assert.equal(progress.at(-1), 1);
  for (let index = 1; index < progress.length; index += 1) assert.ok(progress[index] >= progress[index - 1] - 1e-9, 'progress never moves backwards');
  for (const result of outcome.results) {
    assert.ok(['EVEN', 'ODD'].includes(result.best.label));
    assert.equal(result.best.votes.length, 12);
  }
});

test('a cancelled scan stops its workers and rejects with AbortError', async () => {
  globalThis.Worker = FakeWorker;
  const controller = new AbortController();
  const pending = runScan([digitJob('A'), digitJob('B')], { maxWorkers: 1, signal: controller.signal, onProgress: () => {} });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});
