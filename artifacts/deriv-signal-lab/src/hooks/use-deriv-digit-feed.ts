import { useEffect, useRef, useState } from 'react';
import { extractFinalDigit, precisionFromPipSize, type DigitObservation } from '@/lib/digit-analysis';

type WireMessage = {
  msg_type?: string;
  req_id?: number;
  time?: number | string;
  error?: { code?: string; message?: string };
  active_symbols?: unknown[];
  contracts_for?: { available?: unknown[] };
  history?: { prices?: Array<number | string>; times?: Array<number | string> };
  pip_size?: number | string;
  tick?: { symbol?: string; quote?: number | string; epoch?: number | string; pip_size?: number | string };
  subscription?: { id?: string };
  echo_req?: { ticks_history?: string; contracts_for?: string };
};

export type DigitMarketSymbol = {
  symbol: string;
  name: string;
  market: string;
  symbolType: string;
  pipSize: number | null;
  precision: number | null;
  exchangeOpen: boolean | null;
  tradingSuspended: boolean | null;
};

export type DigitContractSupport = {
  contractType: string;
  expiryType: string;
  minDuration: number | null;
  maxDuration: number | null;
  barriers: number[];
  targets: number[];
  digitRangeKnown: boolean;
};

export type DigitFeedStatus = 'connecting' | 'loading' | 'live' | 'reconnecting' | 'error';

type PendingRequest = { kind: 'history' | 'contracts'; symbol: string };

const HISTORY_LIMIT = 2_000;
const STALE_AFTER_MS = 15_000;
const DERIV_APP_ID = (import.meta.env.VITE_DERIV_APP_ID || '').trim() || '1089';
const USING_TEST_APP_ID = !import.meta.env.VITE_DERIV_APP_ID?.trim();

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseFiniteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value: unknown): number | null {
  const number = parseFiniteNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function parseDigitList(value: unknown, expandRange = false): number[] {
  if (!Array.isArray(value)) return [];
  const values = value.map(parseInteger).filter((item): item is number => item !== null && item >= 0 && item <= 9);
  if (expandRange && values.length === 2 && values[0] <= values[1]) {
    return Array.from({ length: values[1] - values[0] + 1 }, (_, index) => values[0] + index);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function normalizeActiveSymbols(rawSymbols: unknown[]): DigitMarketSymbol[] {
  const symbols: DigitMarketSymbol[] = [];
  for (const raw of rawSymbols) {
    const item = asRecord(raw);
    if (!item) continue;
    const symbol = typeof item.underlying_symbol === 'string' ? item.underlying_symbol : '';
    if (!symbol) continue;
    const pipSizeValue = parseFiniteNumber(item.pip_size);
    const precision = pipSizeValue === null ? null : precisionFromPipSize(pipSizeValue);
    symbols.push({
      symbol,
      name: typeof item.underlying_symbol_name === 'string' && item.underlying_symbol_name ? item.underlying_symbol_name : symbol,
      market: typeof item.market === 'string' ? item.market : 'Unknown market',
      symbolType: typeof item.underlying_symbol_type === 'string' ? item.underlying_symbol_type : 'Unknown type',
      pipSize: precision === null ? null : pipSizeValue,
      precision,
      exchangeOpen: item.exchange_is_open === 0 || item.exchange_is_open === 1 ? item.exchange_is_open === 1 : null,
      tradingSuspended: item.is_trading_suspended === 0 || item.is_trading_suspended === 1 ? item.is_trading_suspended === 1 : null,
    });
  }
  return symbols.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeContractSupport(rawContracts: unknown[]): DigitContractSupport[] {
  const output: DigitContractSupport[] = [];
  for (const raw of rawContracts) {
    const item = asRecord(raw);
    if (!item || typeof item.contract_type !== 'string') continue;
    const availableBarriers = parseDigitList(item.available_barriers);
    const lastDigitRange = parseDigitList(item.last_digit_range, true);
    const barriers = availableBarriers.length ? availableBarriers : lastDigitRange;
    // DIGITMATCH's target domain is the ten displayed digits. Keep zero explicit;
    // this is a contract-rule domain, not a market-data estimate.
    const targets = item.contract_type === 'DIGITMATCH'
      ? Array.from({ length: 10 }, (_, digit) => digit)
      : lastDigitRange.length ? lastDigitRange : barriers;
    output.push({
      contractType: item.contract_type,
      expiryType: typeof item.expiry_type === 'string' ? item.expiry_type : '',
      minDuration: parseInteger(item.min_contract_duration),
      maxDuration: parseInteger(item.max_contract_duration),
      barriers,
      targets,
      digitRangeKnown: item.contract_type === 'DIGITMATCH' || barriers.length > 0 || lastDigitRange.length > 0,
    });
  }
  return output;
}

function samePipSize(left: number, right: number): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return scale > 0 && Math.abs(left - right) <= scale * 1e-12;
}

function normalizeHistory(
  symbol: string,
  prices: Array<number | string>,
  times: Array<number | string>,
  responsePipSize: number | null,
  metadata: DigitMarketSymbol,
): DigitObservation[] {
  const effectivePipSize = responsePipSize;
  if (metadata.pipSize === null || effectivePipSize === null || !samePipSize(effectivePipSize, metadata.pipSize)) return [];
  const precision = precisionFromPipSize(effectivePipSize);
  if (precision === null) return [];
  const observations: DigitObservation[] = [];
  const count = Math.min(prices.length, times.length);
  for (let index = 0; index < count; index += 1) {
    const quote = parseFiniteNumber(prices[index]);
    const epoch = parseInteger(times[index]);
    if (quote === null || quote < 0 || epoch === null || epoch <= 0) continue;
    const digit = extractFinalDigit(quote, effectivePipSize);
    if (digit === null) continue;
    observations.push({ symbol, quote, epoch, pipSize: effectivePipSize, precision, digit });
  }
  return sortAndBound(observations);
}

function sortAndBound(observations: DigitObservation[]): DigitObservation[] {
  const unique = new Map<string, DigitObservation>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.quote) || !Number.isFinite(observation.epoch) || !Number.isInteger(observation.digit) || observation.digit < 0 || observation.digit > 9) continue;
    unique.set(`${observation.epoch}:${observation.quote}`, observation);
  }
  return [...unique.values()].sort((left, right) => left.epoch - right.epoch).slice(-HISTORY_LIMIT);
}

function defaultSymbol(symbols: DigitMarketSymbol[]): string {
  return symbols.find(({ symbol, precision }) => symbol === '1HZ15V' && precision !== null)?.symbol
    ?? symbols.find(({ market, precision }) => precision !== null && /synthetic/i.test(market))?.symbol
    ?? symbols.find(({ precision }) => precision !== null)?.symbol
    ?? symbols[0]?.symbol
    ?? '';
}

export function useDerivDigitFeed() {
  const [symbols, setSymbols] = useState<DigitMarketSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [ticks, setTicks] = useState<DigitObservation[]>([]);
  const [contracts, setContracts] = useState<DigitContractSupport[]>([]);
  const [status, setStatus] = useState<DigitFeedStatus>('connecting');
  const [feedError, setFeedError] = useState('');
  const [contractError, setContractError] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [contractsLoaded, setContractsLoaded] = useState(false);
  const [precisionError, setPrecisionError] = useState('');
  const [lastLiveTickAt, setLastLiveTickAt] = useState<number | null>(null);
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [connectionReady, setConnectionReady] = useState(false);
  const [symbolsLoaded, setSymbolsLoaded] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const selectedSymbolRef = useRef(selectedSymbol);
  const symbolsRef = useRef(symbols);
  const ticksRef = useRef(ticks);
  const subscriptionIdRef = useRef<string | null>(null);
  const pendingRequestsRef = useRef(new Map<number, PendingRequest>());
  const requestIdRef = useRef(100);
  const lastLiveTickRef = useRef<DigitObservation | null>(null);

  selectedSymbolRef.current = selectedSymbol;
  symbolsRef.current = symbols;
  ticksRef.current = ticks;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | null = null;

    const nextRequestId = () => {
      requestIdRef.current = requestIdRef.current >= 2_000_000_000 ? 100 : requestIdRef.current + 1;
      return requestIdRef.current;
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
        socket = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(DERIV_APP_ID)}`);
        socketRef.current = socket;
        socket.onopen = () => {
          if (disposed || !socket) return;
          reconnectAttempt = 0;
          setConnectionReady(true);
          setSymbolsLoaded(false);
          setStatus('loading');
          setFeedError('');
          setServerClockOffsetMs(null);
          setLastLiveTickAt(null);
          lastLiveTickRef.current = null;
          pendingRequestsRef.current.clear();
          socket.send(JSON.stringify({ time: 1, req_id: nextRequestId() }));
          socket.send(JSON.stringify({ active_symbols: 'full', req_id: 1 }));
        };
        socket.onmessage = (event) => {
          if (disposed) return;
          let message: WireMessage;
          try {
            message = JSON.parse(String(event.data)) as WireMessage;
          } catch {
            setFeedError('Deriv sent a response that could not be parsed.');
            return;
          }

          if (message.error) {
            const pending = message.req_id === undefined ? undefined : pendingRequestsRef.current.get(message.req_id);
            const detail = message.error.message || message.error.code || 'Deriv rejected the request.';
            if (pending?.kind === 'contracts' && pending.symbol === selectedSymbolRef.current) setContractError(detail);
            else if (!pending || pending.symbol === selectedSymbolRef.current) setFeedError(detail);
            if (pending && message.req_id !== undefined) pendingRequestsRef.current.delete(message.req_id);
            return;
          }

          if (message.msg_type === 'time' && message.time !== undefined) {
            const serverTime = parseFiniteNumber(message.time);
            if (serverTime !== null && serverTime > 0) setServerClockOffsetMs(serverTime * 1_000 - Date.now());
            return;
          }

          if (message.msg_type === 'active_symbols') {
            const discovered = normalizeActiveSymbols(message.active_symbols ?? []);
            setSymbols(discovered);
            setSymbolsLoaded(true);
            if (!discovered.length) setFeedError('Deriv returned no active symbols with usable metadata.');
            const current = selectedSymbolRef.current;
            if (!current || !discovered.some(({ symbol }) => symbol === current)) setSelectedSymbol(defaultSymbol(discovered));
            return;
          }

          if (message.msg_type === 'contracts_for') {
            const pending = message.req_id === undefined ? undefined : pendingRequestsRef.current.get(message.req_id);
            const symbol = pending?.kind === 'contracts' ? pending.symbol : message.echo_req?.contracts_for;
            if (symbol && symbol === selectedSymbolRef.current) {
              const rawContracts = message.contracts_for?.available ?? [];
              setContracts(normalizeContractSupport(rawContracts));
              setContractsLoaded(true);
              setContractError(rawContracts.length ? '' : 'Deriv reports no digit contracts for this symbol.');
            }
            if (message.req_id !== undefined) pendingRequestsRef.current.delete(message.req_id);
            return;
          }

          if (message.msg_type === 'history' && message.history?.prices && message.history.times) {
            const pending = message.req_id === undefined ? undefined : pendingRequestsRef.current.get(message.req_id);
            const symbol = pending?.kind === 'history' ? pending.symbol : message.echo_req?.ticks_history;
            if (message.req_id !== undefined) pendingRequestsRef.current.delete(message.req_id);
            if (!symbol || symbol !== selectedSymbolRef.current) return;
            const metadata = symbolsRef.current.find((candidate) => candidate.symbol === symbol);
            if (!metadata) return;
            const historyPipSize = parseFiniteNumber(message.pip_size);
            const normalized = normalizeHistory(symbol, message.history.prices, message.history.times, historyPipSize, metadata);
            if (historyPipSize === null) {
              setPrecisionError('History response did not include Deriv pip_size; historical digits cannot be verified.');
              setHistoryLoaded(false);
            } else if (metadata.pipSize === null || metadata.precision === null) {
              setPrecisionError('Verified active-symbol pip precision is unavailable; digit analysis is blocked.');
              setHistoryLoaded(false);
            } else if (!samePipSize(historyPipSize, metadata.pipSize)) {
              setPrecisionError('History pip precision conflicts with active-symbol metadata; digit analysis is blocked.');
              setHistoryLoaded(false);
            } else if (!normalized.length) {
              setPrecisionError('History contains no quote that can be safely converted to its displayed digit.');
              setHistoryLoaded(false);
            } else {
              setPrecisionError('');
              setTicks((current) => {
                const merged = sortAndBound([...normalized, ...current.filter((tick) => tick.symbol === symbol)]);
                ticksRef.current = merged;
                return merged;
              });
              setHistoryLoaded(true);
            }
            return;
          }

          if (message.msg_type !== 'tick' || !message.tick) return;
          const symbol = typeof message.tick.symbol === 'string' ? message.tick.symbol : '';
          if (!symbol || symbol !== selectedSymbolRef.current) return;
          const metadata = symbolsRef.current.find((candidate) => candidate.symbol === symbol);
          const quote = parseFiniteNumber(message.tick.quote);
          const epoch = parseInteger(message.tick.epoch);
          const pipSize = parseFiniteNumber(message.tick.pip_size);
          if (!metadata || metadata.pipSize === null || metadata.precision === null || quote === null || epoch === null || pipSize === null || quote < 0 || epoch <= 0) {
            setPrecisionError('Live tick is missing a valid quote, timestamp or pip precision; digit analysis is blocked.');
            return;
          }
          if (!samePipSize(pipSize, metadata.pipSize)) {
            setPrecisionError('Live tick pip precision conflicts with active-symbol metadata; digit analysis is blocked.');
            return;
          }
          const digit = extractFinalDigit(quote, pipSize);
          if (digit === null) {
            setPrecisionError('The quote cannot be represented at the verified pip precision; digit analysis is blocked.');
            return;
          }
          const observation: DigitObservation = { symbol, quote, epoch, pipSize, precision: metadata.precision, digit };
          const previous = lastLiveTickRef.current ?? ticksRef.current.at(-1) ?? null;
          if (previous && epoch < previous.epoch) return;
          if (previous && epoch === previous.epoch && quote === previous.quote) {
            setLastLiveTickAt(Date.now());
            return;
          }
          lastLiveTickRef.current = observation;
          setLastLiveTickAt(Date.now());
          setPrecisionError('');
          setStatus('live');
          setTicks((current) => {
            const merged = sortAndBound([...current.filter((tick) => tick.symbol === symbol), observation]);
            ticksRef.current = merged;
            return merged;
          });
          if (message.subscription?.id) subscriptionIdRef.current = message.subscription.id;
        };
        socket.onerror = () => {
          if (!disposed) {
            setFeedError('Deriv WebSocket reported a connection error; retrying.');
            setStatus('reconnecting');
          }
        };
        socket.onclose = () => {
          if (disposed) return;
          setConnectionReady(false);
          setSymbolsLoaded(false);
          setStatus('reconnecting');
          setLastLiveTickAt(null);
          setServerClockOffsetMs(null);
          lastLiveTickRef.current = null;
          subscriptionIdRef.current = null;
          scheduleReconnect();
        };
      } catch (error) {
        setConnectionReady(false);
        setFeedError(error instanceof Error ? error.message : 'Could not open the Deriv WebSocket.');
        setStatus('error');
        scheduleReconnect();
      }
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (socket && socket.readyState === WebSocket.OPEN && subscriptionIdRef.current) {
        socket.send(JSON.stringify({ forget: subscriptionIdRef.current, req_id: nextRequestId() }));
      }
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    const symbol = selectedSymbol;
    if (!connectionReady || !symbolsLoaded || !symbol || !socket || socket.readyState !== WebSocket.OPEN) return;
    const metadata = symbols.find((candidate) => candidate.symbol === symbol);
    if (!metadata) return;

    if (subscriptionIdRef.current) {
      socket.send(JSON.stringify({ forget: subscriptionIdRef.current, req_id: ++requestIdRef.current }));
      subscriptionIdRef.current = null;
    }
    setTicks([]);
    ticksRef.current = [];
    lastLiveTickRef.current = null;
    setLastLiveTickAt(null);
    setHistoryLoaded(false);
    setContractsLoaded(false);
    setContracts([]);
    setContractError('');
    setPrecisionError(metadata.precision === null ? 'Verified pip precision is unavailable; digit analysis is blocked.' : '');
    setFeedError('');
    setStatus('loading');

    const historyReqId = ++requestIdRef.current;
    const contractsReqId = ++requestIdRef.current;
    const ticksReqId = ++requestIdRef.current;
    pendingRequestsRef.current.set(historyReqId, { kind: 'history', symbol });
    pendingRequestsRef.current.set(contractsReqId, { kind: 'contracts', symbol });
    socket.send(JSON.stringify({
      ticks_history: symbol,
      end: 'latest',
      count: HISTORY_LIMIT,
      style: 'ticks',
      req_id: historyReqId,
    }));
    socket.send(JSON.stringify({ contracts_for: symbol, req_id: contractsReqId }));
    socket.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: ticksReqId }));

    return () => {
      const currentSocket = socketRef.current;
      if (currentSocket?.readyState === WebSocket.OPEN && subscriptionIdRef.current) {
        currentSocket.send(JSON.stringify({ forget: subscriptionIdRef.current, req_id: ++requestIdRef.current }));
      }
      subscriptionIdRef.current = null;
    };
  }, [connectionReady, symbolsLoaded, selectedSymbol, symbols]);

  const selectedMarket = symbols.find((candidate) => candidate.symbol === selectedSymbol) ?? null;
  const latest = ticks.at(-1) ?? null;
  const receiveAgeMs = lastLiveTickAt === null ? null : now - lastLiveTickAt;
  const sourceAgeMs = latest === null || serverClockOffsetMs === null ? null : now + serverClockOffsetMs - latest.epoch * 1_000;
  const fresh = status === 'live'
    && receiveAgeMs !== null
    && Math.abs(receiveAgeMs) <= STALE_AFTER_MS
    && sourceAgeMs !== null
    && Math.abs(sourceAgeMs) <= STALE_AFTER_MS;

  return {
    symbols,
    selectedSymbol,
    setSelectedSymbol,
    selectedMarket,
    ticks,
    contracts,
    status,
    feedError,
    contractError,
    precisionError,
    historyLoaded,
    contractsLoaded,
    serverClockOffsetMs,
    fresh,
    sourceAgeMs,
    receiveAgeMs,
    usingTestAppId: USING_TEST_APP_ID,
  };
}
