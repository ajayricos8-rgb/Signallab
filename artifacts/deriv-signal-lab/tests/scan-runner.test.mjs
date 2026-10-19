import test from 'node:test';
import assert from 'node:assert/strict';
import { runScanJob } from '../src/lib/signal-engine/scan-protocol.ts';
import { runScan } from '../src/lib/signal-engine/scan-runner.ts';

// In-process stand-in for a browser Web Worker running scan.worker.ts: same
// message protocol (handshake included), executed asynchronously on this thread.
class FakeWorker {
  static created = 0;
  constructor() { FakeWorker.created += 1; this.onmessage = null; this.onerror = null; this.terminated = false; }
  postMessage(request) {
    setTimeout(() => {
      if (this.terminated) return;
      const emit = (data) => { if (!this.terminated) this.onmessage?.({ data }); };
      if (request.handshake) { emit({ type: 'pong' }); return; }
      const { jobId, job } = request;
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

// A worker whose script never loads: every post fires an error event with an
// empty message, exactly like a 404 / wrong-MIME / blocked worker script.
class NeverLoadsWorker {
  constructor() { this.onmessage = null; this.onerror = null; }
  postMessage() { setTimeout(() => this.onerror?.({ preventDefault() {}, message: '' }), 0); }
  terminate() {}
}

// Pongs the handshake, then crashes the first job it is given (thread death
// mid-analysis); every later job analyses normally.
class CrashesOnceWorker {
  static crashed = 0;
  constructor() { this.onmessage = null; this.onerror = null; this.terminated = false; this.crashedJob = false; }
  postMessage(request) {
    setTimeout(() => {
      if (this.terminated) return;
      const emit = (data) => { if (!this.terminated) this.onmessage?.({ data }); };
      if (request.handshake) { emit({ type: 'pong' }); return; }
      const { jobId, job } = request;
      if (!CrashesOnceWorker.crashed) {
        CrashesOnceWorker.crashed += 1;
        this.crashedJob = true;
        this.onerror?.({ preventDefault() {}, message: '' });
        return;
      }
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

// A worker thread that never sends anything back (silence after a deploy).
class SilentWorker {
  constructor() { this.onmessage = null; this.onerror = null; }
  postMessage() {}
  terminate() {}
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

test('workers whose script never loads fall back to the main thread and still return every signal', async () => {
  globalThis.Worker = NeverLoadsWorker;
  const finished = [];
  const failed = [];
  const outcome = await runScan([digitJob('A'), digitJob('BB'), digitJob('CCC')], {
    maxWorkers: 2,
    handshakeTimeoutMs: 250,
    onProgress: () => {},
    onResult: (result) => finished.push(result.symbol),
    onFailure: (failure) => failed.push(failure.symbol),
  });
  assert.equal(outcome.results.length, 3, 'every market must still be analysed');
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(failed, []);
  assert.deepEqual(finished.sort(), ['A', 'BB', 'CCC']);
  assert.equal(outcome.workers, 0, 'no usable worker was ever counted');
  for (const result of outcome.results) assert.ok(['EVEN', 'ODD'].includes(result.best.label));
});

test('a worker that dies mid-analysis retries the job once and the scan still finishes', async () => {
  globalThis.Worker = CrashesOnceWorker;
  CrashesOnceWorker.crashed = 0;
  const failed = [];
  const outcome = await runScan([digitJob('A'), digitJob('BB')], {
    maxWorkers: 1,
    onProgress: () => {},
    onFailure: (failure) => failed.push(failure.symbol),
  });
  assert.equal(CrashesOnceWorker.crashed, 1);
  assert.equal(outcome.results.length, 2, 'the crashed job must be retried, not failed');
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(failed, []);
});

test('a silent worker is retired by the handshake watchdog and its markets are analysed inline', async () => {
  globalThis.Worker = SilentWorker;
  const outcome = await runScan([digitJob('A'), digitJob('BB')], {
    maxWorkers: 2,
    handshakeTimeoutMs: 120,
    onProgress: () => {},
  });
  assert.equal(outcome.results.length, 2);
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.workers, 0);
});

test('every scan result carries the quant + AI synthesis layer', async () => {
  globalThis.Worker = FakeWorker;
  const outcome = await runScan([digitJob('A')], { maxWorkers: 1, onProgress: () => {} });
  const synthesis = outcome.results[0].aiSynthesis;
  assert.ok(synthesis, 'aiSynthesis must be part of every result');
  assert.ok(synthesis.verdict.length > 0);
  assert.ok(synthesis.bullets.length >= 2);
  assert.ok(synthesis.consensus.windows > 0);
  assert.equal(typeof synthesis.consensus.detail, 'string');
});
