// Shared, multi-market Deriv public feed for the Tools workspace.
//
// One WebSocket (the same public endpoint and app ID as the rest of the app)
// loads 2,000 ticks of history plus a live subscription and contract metadata
// for every volatility index. It lives above the four tool tabs, so switching
// tabs never reloads data and Run Analysis can scan every market immediately.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { normalizeActiveSymbols, normalizeContractSupport, parseFiniteNumber, type DigitContractSupport } from '@/lib/deriv-digit-metadata';
import {
  FALLBACK_SCAN_MARKETS, FEED_HISTORY_LIMIT, historyToTicks, marketFreshness, mergeTicks, resolvePipSize, selectScanMarkets, toFeedTick,
  type FeedTick, type ScanMarket,
} from '@/lib/market-feed';

type WireMessage = {
  msg_type?: string;
  req_id?: number;
  time?: number | string;
  error?: { code?: string; message?: string };
  active_symbols?: unknown[];
  contracts_for?: { available?: unknown[] };
  history?: { prices?: unknown[]; times?: unknown[] };
  pip_size?: number | string;
  tick?: { symbol?: string; quote?: number | string; epoch?: number | string; pip_size?: number | string };
  echo_req?: { ticks_history?: string; contracts_for?: string };
};

export type MarketFeedStatus = 'connecting' | 'loading' | 'live' | 'reconnecting' | 'error';

export type MarketFeedEntry = ScanMarket & {
  ticks: FeedTick[];
  historyLoaded: boolean;
  lastLiveTickAt: number | null;
  error: string;
  contracts: DigitContractSupport[];
  contractsLoaded: boolean;
  contractError: string;
  fresh: boolean;
  receiveAgeMs: number | null;
  sourceAgeMs: number | null;
};

type InternalEntry = Omit<MarketFeedEntry, 'fresh' | 'receiveAgeMs' | 'sourceAgeMs'>;

export type MarketFeedValue = {
  status: MarketFeedStatus;
  error: string;
  markets: MarketFeedEntry[];
  bySymbol: Record<string, MarketFeedEntry>;
  serverClockOffsetMs: number | null;
  now: number;
  usingTestAppId: boolean;
  /** Markets whose history is loaded. */
  loadedCount: number;
  freshCount: number;
  /** Latest data without waiting for the next render (used by Run Analysis). */
  getSnapshot: () => MarketFeedEntry[];
  /** Resolves once enough markets have history (or the timeout passes). */
  waitForData: (options: { minimumTicks: number; symbols?: string[]; isReady?: (entry: MarketFeedEntry) => boolean; timeoutMs: number; signal?: AbortSignal; onUpdate?: (loaded: number, total: number) => void }) => Promise<MarketFeedEntry[]>;
  /** Per-tool memory so a finished analysis survives switching tabs. */
  memory: Map<string, unknown>;
};

// Deriv market-data WebSocket. The app ID identifies this client to Deriv; live
// ticks, history and contract metadata are public data and need no account token.
const DERIV_APP_ID = (import.meta.env.VITE_DERIV_APP_ID || '').trim() || '1089';
const USING_TEST_APP_ID = !import.meta.env.VITE_DERIV_APP_ID?.trim();
const REQUEST_SPACING_MS = 110;
const ACTIVE_SYMBOLS_TIMEOUT_MS = 6_000;

const MarketFeedContext = createContext<MarketFeedValue | null>(null);

function emptyEntry(market: ScanMarket): InternalEntry {
  return { ...market, ticks: [], historyLoaded: false, lastLiveTickAt: null, error: '', contracts: [], contractsLoaded: false, contractError: '' };
}

function withFreshness(entry: InternalEntry, now: number, serverClockOffsetMs: number | null): MarketFeedEntry {
  const freshness = marketFreshness(entry.lastLiveTickAt, entry.ticks.at(-1)?.epoch ?? null, now, serverClockOffsetMs);
  return { ...entry, ...freshness };
}

export function MarketFeedProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<MarketFeedStatus>('connecting');
  const [error, setError] = useState('');
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [version, setVersion] = useState(0);
  const entriesRef = useRef(new Map<string, InternalEntry>());
  const orderRef = useRef<string[]>(FALLBACK_SCAN_MARKETS.map((market) => market.symbol));
  const offsetRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);
  const listenersRef = useRef(new Set<() => void>());
  const memoryRef = useRef(new Map<string, unknown>());

  if (!entriesRef.current.size) for (const market of FALLBACK_SCAN_MARKETS) entriesRef.current.set(market.symbol, emptyEntry(market));

  const flush = useCallback(() => {
    if (flushTimerRef.current !== null) { window.clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setVersion((value) => value + 1);
    for (const listener of listenersRef.current) listener();
  }, []);

  const markDirty = useCallback((delayMs: number) => {
    dirtyRef.current = true;
    if (flushTimerRef.current === null) flushTimerRef.current = window.setTimeout(flush, delayMs);
  }, [flush]);

  const update = useCallback((symbol: string, patch: (entry: InternalEntry) => Partial<InternalEntry>, delayMs = 150) => {
    const entry = entriesRef.current.get(symbol);
    if (!entry) return;
    entriesRef.current.set(symbol, { ...entry, ...patch(entry) });
    markDirty(delayMs);
  }, [markDirty]);

  useEffect(() => {
    const interval = window.setInterval(() => { setNow(Date.now()); flush(); }, 1_000);
    return () => window.clearInterval(interval);
  }, [flush]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let symbolsTimer: number | undefined;
    let requestTimers: number[] = [];
    let requestId = 1_000;
    let marketsRequested = false;
    const pending = new Map<number, { kind: 'history' | 'contracts'; symbol: string }>();

    const clearTimers = () => {
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      if (symbolsTimer !== undefined) window.clearTimeout(symbolsTimer);
      heartbeatTimer = undefined;
      symbolsTimer = undefined;
      requestTimers.forEach((timer) => window.clearTimeout(timer));
      requestTimers = [];
    };

    const send = (payload: Record<string, unknown>) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };

    const requestMarkets = (markets: ScanMarket[]) => {
      if (marketsRequested) return;
      marketsRequested = true;
      const next = new Map<string, InternalEntry>();
      for (const market of markets) {
        const existing = entriesRef.current.get(market.symbol);
        next.set(market.symbol, existing
          ? { ...existing, ...market, pipSize: market.pipSize ?? existing.pipSize, precision: market.precision ?? existing.precision, error: '' }
          : emptyEntry(market));
      }
      entriesRef.current = next;
      orderRef.current = markets.map((market) => market.symbol);
      markDirty(50);
      markets.forEach((market, index) => {
        requestTimers.push(window.setTimeout(() => {
          const historyId = ++requestId;
          pending.set(historyId, { kind: 'history', symbol: market.symbol });
          send({ ticks_history: market.symbol, end: 'latest', count: FEED_HISTORY_LIMIT, style: 'ticks', subscribe: 1, req_id: historyId });
        }, index * REQUEST_SPACING_MS));
      });
      // Contract metadata follows once every history request is on the wire.
      markets.forEach((market, index) => {
        requestTimers.push(window.setTimeout(() => {
          const contractsId = ++requestId;
          pending.set(contractsId, { kind: 'contracts', symbol: market.symbol });
          send({ contracts_for: market.symbol, req_id: contractsId });
        }, (markets.length + index) * REQUEST_SPACING_MS));
      });
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed) return;
      setStatus(reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
      try {
        socket = new WebSocket(`wss://api.derivws.com/trading/v1/options/ws/public?app_id=${encodeURIComponent(DERIV_APP_ID)}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not open the Deriv WebSocket.');
        setStatus('error');
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        if (disposed) return;
        reconnectAttempt = 0;
        marketsRequested = false;
        pending.clear();
        clearTimers();
        setStatus('loading');
        setError('');
        send({ time: 1, req_id: 1 });
        send({ active_symbols: 'full', req_id: 2 });
        heartbeatTimer = window.setInterval(() => send({ ping: 1 }), 30_000);
        // Never stall the scan on metadata: fall back to the known indices.
        symbolsTimer = window.setTimeout(() => requestMarkets(FALLBACK_SCAN_MARKETS), ACTIVE_SYMBOLS_TIMEOUT_MS);
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        let message: WireMessage;
        try {
          message = JSON.parse(String(event.data)) as WireMessage;
        } catch {
          return;
        }
        const request = message.req_id === undefined ? undefined : pending.get(message.req_id);

        if (message.error) {
          const detail = message.error.message || message.error.code || 'Deriv rejected the request.';
          if (message.req_id === 2) { requestMarkets(FALLBACK_SCAN_MARKETS); return; }
          if (request?.kind === 'history') update(request.symbol, () => ({ error: detail }));
          else if (request?.kind === 'contracts') update(request.symbol, () => ({ contractError: detail, contractsLoaded: true }));
          else if (message.req_id !== 1) setError(detail);
          if (message.req_id !== undefined) pending.delete(message.req_id);
          return;
        }

        if (message.msg_type === 'time' && message.time !== undefined) {
          const serverTime = parseFiniteNumber(message.time);
          if (serverTime !== null && serverTime > 0) {
            offsetRef.current = serverTime * 1_000 - Date.now();
            setServerClockOffsetMs(offsetRef.current);
          }
          return;
        }

        if (message.msg_type === 'active_symbols') {
          if (symbolsTimer !== undefined) window.clearTimeout(symbolsTimer);
          requestMarkets(selectScanMarkets(normalizeActiveSymbols(message.active_symbols ?? [])));
          return;
        }

        if (message.msg_type === 'contracts_for') {
          const symbol = request?.kind === 'contracts' ? request.symbol : message.echo_req?.contracts_for;
          if (message.req_id !== undefined) pending.delete(message.req_id);
          if (!symbol) return;
          const available = message.contracts_for?.available ?? [];
          update(symbol, () => ({ contracts: normalizeContractSupport(available), contractsLoaded: true, contractError: available.length ? '' : 'Deriv reported no contracts for this market.' }), 400);
          return;
        }

        if (message.msg_type === 'history' && message.history?.prices && message.history.times) {
          const symbol = request?.kind === 'history' ? request.symbol : message.echo_req?.ticks_history;
          if (message.req_id !== undefined) pending.delete(message.req_id);
          if (!symbol) return;
          const entry = entriesRef.current.get(symbol);
          if (!entry) return;
          const pipSize = resolvePipSize(entry.pipSize, message.pip_size);
          const history = historyToTicks(message.history.prices, message.history.times, pipSize);
          update(symbol, (current) => ({
            pipSize: pipSize ?? current.pipSize,
            ticks: mergeTicks(current.ticks, history),
            historyLoaded: history.length > 0,
            error: history.length ? '' : 'Deriv returned no valid tick history for this market.',
          }), 120);
          setStatus((value) => (value === 'loading' || value === 'connecting' ? 'live' : value));
          return;
        }

        if (message.msg_type === 'tick' && message.tick && typeof message.tick.symbol === 'string') {
          const symbol = message.tick.symbol;
          const entry = entriesRef.current.get(symbol);
          if (!entry) return;
          const pipSize = resolvePipSize(entry.pipSize, message.tick.pip_size);
          const tick = toFeedTick(message.tick.quote, message.tick.epoch, pipSize);
          if (!tick) return;
          const last = entry.ticks.at(-1);
          const receivedAt = Date.now();
          if (last && tick.epoch < last.epoch) return;
          if (last && tick.epoch === last.epoch) {
            entriesRef.current.set(symbol, { ...entry, lastLiveTickAt: receivedAt });
            markDirty(1_000);
            return;
          }
          entriesRef.current.set(symbol, { ...entry, pipSize: pipSize ?? entry.pipSize, ticks: mergeTicks(entry.ticks, [tick]), lastLiveTickAt: receivedAt, error: '' });
          markDirty(1_000);
          setStatus('live');
        }
      };
      socket.onerror = () => {
        if (!disposed) setError('The Deriv connection reported an error. Retrying automatically.');
      };
      socket.onclose = () => {
        if (disposed) return;
        clearTimers();
        setStatus('reconnecting');
        for (const [symbol, entry] of entriesRef.current) entriesRef.current.set(symbol, { ...entry, lastLiveTickAt: null });
        markDirty(50);
        scheduleReconnect();
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      clearTimers();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [markDirty, update]);

  const getSnapshot = useCallback(() => {
    const stamp = Date.now();
    return orderRef.current
      .map((symbol) => entriesRef.current.get(symbol))
      .filter((entry): entry is InternalEntry => Boolean(entry))
      .map((entry) => withFreshness(entry, stamp, offsetRef.current));
  }, []);

  const waitForData = useCallback<MarketFeedValue['waitForData']>(({ minimumTicks, symbols, isReady, timeoutMs, signal, onUpdate }) => new Promise((resolve, reject) => {
    const started = Date.now();
    let timer: number | undefined;
    const relevant = () => getSnapshot().filter((entry) => !symbols?.length || symbols.includes(entry.symbol));
    const finish = (error?: unknown) => {
      listenersRef.current.delete(check);
      if (timer !== undefined) window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(getSnapshot());
    };
    const onAbort = () => finish(new DOMException('The analysis was cancelled.', 'AbortError'));
    function check() {
      const markets = relevant();
      const ready = markets.filter((entry) => isReady ? isReady(entry) : entry.ticks.length >= minimumTicks).length;
      onUpdate?.(ready, markets.length);
      const settled = markets.every((entry) => (isReady ? isReady(entry) : entry.ticks.length >= minimumTicks) || entry.error);
      if ((markets.length && settled) || Date.now() - started >= timeoutMs) finish();
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort);
    listenersRef.current.add(check);
    timer = window.setTimeout(() => finish(), timeoutMs);
    check();
  }), [getSnapshot]);

  const value = useMemo<MarketFeedValue>(() => {
    const markets = orderRef.current
      .map((symbol) => entriesRef.current.get(symbol))
      .filter((entry): entry is InternalEntry => Boolean(entry))
      .map((entry) => withFreshness(entry, now, serverClockOffsetMs));
    return {
      status, error, markets, serverClockOffsetMs, now,
      bySymbol: Object.fromEntries(markets.map((entry) => [entry.symbol, entry])),
      usingTestAppId: USING_TEST_APP_ID,
      loadedCount: markets.filter((entry) => entry.historyLoaded).length,
      freshCount: markets.filter((entry) => entry.fresh).length,
      getSnapshot, waitForData, memory: memoryRef.current,
    };
    // `version` invalidates the memo whenever buffered feed data is flushed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, now, status, error, serverClockOffsetMs, getSnapshot, waitForData]);

  return <MarketFeedContext.Provider value={value}>{children}</MarketFeedContext.Provider>;
}

export function useMarketFeed(): MarketFeedValue {
  const value = useContext(MarketFeedContext);
  if (!value) throw new Error('useMarketFeed must be used inside MarketFeedProvider.');
  return value;
}
