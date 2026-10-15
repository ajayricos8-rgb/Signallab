// Shared Run Analysis flow for every tool: wait for market data if needed,
// analyse all markets in parallel workers with a live percentage, then rank
// the results so the strongest signal is shown immediately.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMarketFeed, type MarketFeedEntry } from '@/components/market-feed-provider';
import type { AnalysisProgressView, MarketProgressState } from '@/components/signal/signal-ui';
import type { ScanJobResult } from '@/lib/signal-engine/scan-protocol';
import { rankScanResults } from '@/lib/signal-engine/scan-rank';
import { runScan, type ScanFailure, type ScanMarketJob } from '@/lib/signal-engine/scan-runner';

export type ScanRun<R extends ScanJobResult, M> = {
  id: number;
  ranAt: number;
  results: R[];
  failures: ScanFailure[];
  durationMs: number;
  workers: number;
  marketsScanned: number;
  meta: M;
};

export type StartScanOptions<M> = {
  symbols: string[];
  /** Usable ticks a market needs before it can be analysed. */
  minimumTicks: number;
  usableTicks: (entry: MarketFeedEntry) => number;
  buildJobs: (entries: MarketFeedEntry[]) => { jobs: ScanMarketJob[]; skipped: ScanFailure[] };
  meta: M;
};

const DATA_PHASE = 6;
const SCAN_PHASE = 92;
const DATA_TIMEOUT_MS = 25_000;

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function useSignalScan<R extends ScanJobResult, M>(memoryKey: string) {
  const feed = useMarketFeed();
  const [run, setRun] = useState<ScanRun<R, M> | null>(() => (feed.memory.get(memoryKey) as ScanRun<R, M> | undefined) ?? null);
  const [progress, setProgress] = useState<AnalysisProgressView | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const start = useCallback(async (options: StartScanOptions<M>): Promise<ScanRun<R, M> | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    const relevant = () => feed.getSnapshot().filter((entry) => options.symbols.includes(entry.symbol));
    const view = (entries: MarketFeedEntry[], state: MarketProgressState) => entries.map((entry) => ({ symbol: entry.symbol, name: entry.name, state, percent: 0 }));
    let entries = relevant();
    // Progress appears the instant Run Analysis is pressed.
    setProgress({ percent: 1, stage: 'Starting analysis…', completed: 0, total: entries.length, markets: view(entries, 'waiting') });
    try {
      const ready = (entry: MarketFeedEntry) => options.usableTicks(entry) >= options.minimumTicks;
      if (!entries.length || entries.some((entry) => !ready(entry) && !entry.error)) {
        await feed.waitForData({
          symbols: options.symbols,
          minimumTicks: options.minimumTicks,
          timeoutMs: DATA_TIMEOUT_MS,
          signal: controller.signal,
          onUpdate: (loaded, total) => {
            const snapshot = relevant();
            setProgress({
              percent: 1 + (DATA_PHASE - 1) * (total ? loaded / total : 0),
              stage: `Loading live market data from Deriv · ${loaded}/${total} markets ready`,
              detail: 'Analysis starts automatically as soon as the data arrives.',
              completed: 0,
              total: snapshot.length,
              markets: snapshot.map((entry) => ({ symbol: entry.symbol, name: entry.name, state: ready(entry) ? 'queued' : 'waiting', percent: 0 })),
            });
          },
        });
        entries = relevant();
      }
      const { jobs, skipped } = options.buildJobs(entries);
      if (!jobs.length) {
        throw new Error(skipped.length
          ? `No market could be analysed yet: ${skipped[0].name} — ${skipped[0].message}`
          : 'No market data has arrived from Deriv yet. Check your internet connection and press Run Analysis again.');
      }
      const states = new Map(jobs.map((job) => [job.symbol, { symbol: job.symbol, name: job.name, state: 'queued' as MarketProgressState, percent: 0 }]));
      for (const failure of skipped) states.set(failure.symbol, { symbol: failure.symbol, name: failure.name, state: 'failed', percent: 0 });
      const snapshotStates = () => [...states.values()].map((state) => ({ ...state }));
      setProgress({ percent: DATA_PHASE, stage: `Analysing ${jobs.length} markets`, completed: 0, total: jobs.length, markets: snapshotStates() });
      const outcome = await runScan(jobs, {
        signal: controller.signal,
        onProgress: (update) => {
          for (const active of update.active) {
            const state = states.get(active.symbol);
            if (state && state.state !== 'done' && state.state !== 'failed') { state.state = 'running'; state.percent = active.fraction * 100; }
          }
          setProgress({
            percent: DATA_PHASE + SCAN_PHASE * update.fraction,
            stage: update.stage,
            completed: update.completed,
            total: update.total,
            markets: snapshotStates(),
          });
        },
        onResult: (result) => {
          const state = states.get(result.symbol);
          if (state) { state.state = 'done'; state.percent = 100; }
        },
        onFailure: (failure) => {
          const state = states.get(failure.symbol);
          if (state) state.state = 'failed';
        },
      });
      setProgress({ percent: 99, stage: 'Selecting the strongest signal', completed: jobs.length, total: jobs.length, markets: snapshotStates() });
      const ranked = rankScanResults(outcome.results as R[]);
      if (!ranked.length) throw new Error(outcome.failures[0]?.message ?? 'The engines could not analyse any market. Please try again.');
      const next: ScanRun<R, M> = {
        id: Date.now(), ranAt: Date.now(), results: ranked, failures: [...skipped, ...outcome.failures],
        durationMs: outcome.durationMs, workers: outcome.workers, marketsScanned: jobs.length, meta: options.meta,
      };
      feed.memory.set(memoryKey, next);
      setRun(next);
      return next;
    } catch (cause) {
      if (!isAbort(cause)) setError(cause instanceof Error ? cause.message : 'The analysis could not finish. Please try again.');
      return null;
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setProgress(null);
      }
    }
  }, [feed, memoryKey]);

  return { run, progress, error, scanning: progress !== null, start, cancel };
}
