import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  Play,
  Radio,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { analyzeRiseFall, type Bias, type HistoricalOutcomes, type MarketTick, type RiseFallAnalysis } from '@/lib/rise-fall-analysis';

type DerivWireMessage = {
  msg_type?: string;
  req_id?: number;
  time?: number | string;
  echo_req?: { ticks_history?: string };
  error?: { code?: string; message?: string };
  history?: { prices?: Array<number | string>; times?: Array<number | string> };
  tick?: { quote?: number | string; epoch?: number | string; symbol?: string };
};

type FeedStatus = 'connecting' | 'loading' | 'live' | 'reconnecting' | 'error';
type Horizon = { unit: 'ticks' | 'minutes'; value: number };
type FeedTick = MarketTick;
type MarketInfo = {
  historyLoaded: boolean;
  lastLiveTickAt: number | null;
  rejectedTicks: number;
  error: string;
};
type HorizonEvaluation = {
  horizon: Horizon;
  historical: HistoricalOutcomes;
  directionalSupport: number | null;
  qualified: boolean;
  reasons: string[];
};
type MarketRow = {
  market: (typeof SYMBOLS)[number];
  ticks: FeedTick[];
  info: MarketInfo;
  analysis: RiseFallAnalysis;
  fresh: boolean;
  sourceAgeMs: number | null;
  technicalEligible: boolean;
  reasons: string[];
  horizonEvaluations: HorizonEvaluation[];
  bestHorizon: HorizonEvaluation | null;
};
type ScanSnapshot = {
  ranAt: number;
  rows: MarketRow[];
  bestCandidate: { marketCode: string; horizon: Horizon } | null;
};

const REQUIRED_TICKS = 500;
const REQUIRED_HISTORICAL_SAMPLES = 100;
const REQUIRED_DIRECTIONAL_OUTCOMES = 50;
const STALE_AFTER_MS = 15_000;
const HISTORY_COUNT = 2_000;
// Deriv market-data WebSocket. The app ID identifies this client to Deriv; live
// ticks and history are public data and need no account token. The identifier
// travels in the query string because browsers cannot set custom headers on
// WebSocket connections. Unset falls back to Deriv's public test ID 1089.
const DERIV_APP_ID = (import.meta.env.VITE_DERIV_APP_ID || '').trim() || '1089';
const USING_TEST_APP_ID = !import.meta.env.VITE_DERIV_APP_ID?.trim();
const SYMBOLS = [
  { code: 'R_10', name: 'Volatility 10 Index' },
  { code: 'R_25', name: 'Volatility 25 Index' },
  { code: 'R_50', name: 'Volatility 50 Index' },
  { code: 'R_75', name: 'Volatility 75 Index' },
  { code: 'R_100', name: 'Volatility 100 Index' },
  { code: '1HZ10V', name: 'Volatility 10 (1s) Index' },
  { code: '1HZ15V', name: 'Volatility 15 (1s) Index' },
  { code: '1HZ25V', name: 'Volatility 25 (1s) Index' },
  { code: '1HZ30V', name: 'Volatility 30 (1s) Index' },
  { code: '1HZ50V', name: 'Volatility 50 (1s) Index' },
  { code: '1HZ75V', name: 'Volatility 75 (1s) Index' },
  { code: '1HZ90V', name: 'Volatility 90 (1s) Index' },
  { code: '1HZ100V', name: 'Volatility 100 (1s) Index' },
] as const;
const HORIZONS: Horizon[] = [
  ...Array.from({ length: 10 }, (_, index) => ({ unit: 'ticks' as const, value: index + 1 })),
  ...Array.from({ length: 15 }, (_, index) => ({ unit: 'minutes' as const, value: index + 1 })),
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function emptyMarketInfo(): MarketInfo {
  return { historyLoaded: false, lastLiveTickAt: null, rejectedTicks: 0, error: '' };
}

function emptyMarketMap<T>(symbols: readonly { code: string }[], makeValue: () => T): Record<string, T> {
  return Object.fromEntries(symbols.map(({ code }) => [code, makeValue()]));
}

function normalizeHistory(prices: Array<number | string>, times: Array<number | string>): FeedTick[] {
  const ticks: FeedTick[] = [];
  const count = Math.min(prices.length, times.length);
  for (let index = 0; index < count; index += 1) {
    const quote = Number(prices[index]);
    const epoch = Number(times[index]);
    if (Number.isFinite(quote) && Number.isFinite(epoch) && quote > 0 && epoch > 0) ticks.push({ quote, epoch });
  }
  return deduplicateAndSort(ticks);
}

function deduplicateAndSort(ticks: FeedTick[]): FeedTick[] {
  const unique = new Map<string, FeedTick>();
  for (const tick of ticks) {
    if (!Number.isFinite(tick.quote) || !Number.isFinite(tick.epoch) || tick.quote <= 0 || tick.epoch <= 0) continue;
    unique.set(`${tick.epoch}:${tick.quote}`, tick);
  }
  return [...unique.values()].sort((left, right) => left.epoch - right.epoch).slice(-HISTORY_COUNT);
}

function historicalOutcomesByTicks(ticks: FeedTick[], horizonTicks: number): HistoricalOutcomes {
  const prices = ticks.map(({ quote }) => quote);
  const expiry = Math.max(1, Math.floor(horizonTicks));
  const sampleEnd = prices.length - expiry;
  const sampleStart = Math.max(0, prices.length - 500);
  let rise = 0;
  let fall = 0;
  let unchanged = 0;

  for (let index = sampleStart; index < sampleEnd; index += 1) {
    const entry = prices[index];
    const exit = prices[index + expiry];
    if (exit > entry) rise += 1;
    else if (exit < entry) fall += 1;
    else unchanged += 1;
  }

  return { horizon: expiry, sample: rise + fall + unchanged, rise, fall, unchanged };
}

function historicalOutcomesByMinutes(ticks: FeedTick[], minutes: number): HistoricalOutcomes {
  const durationSeconds = Math.max(60, Math.floor(minutes) * 60);
  const sampleStart = Math.max(0, ticks.length - HISTORY_COUNT);
  const firstCompleteAt = ticks.length ? ticks.at(-1)!.epoch - durationSeconds : 0;
  let endIndex = sampleStart + 1;
  let rise = 0;
  let fall = 0;
  let unchanged = 0;

  for (let startIndex = sampleStart; startIndex < ticks.length; startIndex += 1) {
    const entry = ticks[startIndex];
    if (entry.epoch > firstCompleteAt) break;
    const targetEpoch = entry.epoch + durationSeconds;
    if (endIndex <= startIndex) endIndex = startIndex + 1;
    while (endIndex < ticks.length && ticks[endIndex].epoch < targetEpoch) endIndex += 1;
    if (endIndex >= ticks.length) break;
    const exit = ticks[endIndex].quote;
    if (exit > entry.quote) rise += 1;
    else if (exit < entry.quote) fall += 1;
    else unchanged += 1;
  }

  return { horizon: durationSeconds, sample: rise + fall + unchanged, rise, fall, unchanged };
}

function formatQuote(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 2 }).format(value);
}

function formatPct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`;
}

function formatSigned(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function formatAge(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

function formatEpoch(epoch: number | null): string {
  if (epoch === null) return '—';
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatHorizon(horizon: Horizon): string {
  return `${horizon.value} ${horizon.unit === 'ticks' ? (horizon.value === 1 ? 'tick' : 'ticks') : (horizon.value === 1 ? 'minute' : 'minutes')}`;
}

function sameHorizon(left: Horizon, right: Horizon): boolean {
  return left.unit === right.unit && left.value === right.value;
}

function biasTone(bias: Bias): string {
  if (bias === 'RISE') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500';
  if (bias === 'FALL') return 'border-rose-500/30 bg-rose-500/10 text-rose-500';
  return 'border-amber-500/30 bg-amber-500/10 text-amber-500';
}

function useDerivMarkets(symbols: typeof SYMBOLS) {
  const [ticksBySymbol, setTicksBySymbol] = useState<Record<string, FeedTick[]>>(() => emptyMarketMap(symbols, () => []));
  const [marketInfo, setMarketInfo] = useState<Record<string, MarketInfo>>(() => emptyMarketMap(symbols, emptyMarketInfo));
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('connecting');
  const [feedError, setFeedError] = useState('');
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState<number | null>(null);
  const latestTickRef = useRef<Record<string, FeedTick | null>>({});

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let requestTimers: number[] = [];
    let reconnectAttempt = 0;
    let socket: WebSocket | null = null;
    const requestSymbols = new Map<number, string>();

    latestTickRef.current = {};
    setTicksBySymbol(emptyMarketMap(symbols, () => []));
    setMarketInfo(emptyMarketMap(symbols, emptyMarketInfo));
    setFeedStatus('connecting');
    setFeedError('');
    setServerClockOffsetMs(null);

    const clearConnectionTimers = () => {
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      requestTimers.forEach((timer) => window.clearTimeout(timer));
      requestTimers = [];
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(connect, delayMs);
    };

    const connect = () => {
      if (disposed) return;
      setFeedStatus(reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
      try {
        socket = new WebSocket(`wss://api.derivws.com/trading/v1/options/ws/public?app_id=${encodeURIComponent(DERIV_APP_ID)}`);
        socket.onopen = () => {
          if (disposed || !socket) return;
          reconnectAttempt = 0;
          requestSymbols.clear();
          clearConnectionTimers();
          setFeedStatus('loading');
          setFeedError('');
          setServerClockOffsetMs(null);
          setMarketInfo((current) => Object.fromEntries(symbols.map(({ code }) => [code, {
            ...current[code], historyLoaded: false, lastLiveTickAt: null, error: '',
          }])));
          heartbeatTimer = window.setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ping: 1 }));
          }, 30_000);
          socket.send(JSON.stringify({ time: 1, req_id: 1 }));

          symbols.forEach((market, index) => {
            const reqId = 100 + index;
            requestSymbols.set(reqId, market.code);
            const timer = window.setTimeout(() => {
              if (socket?.readyState !== WebSocket.OPEN) return;
              socket.send(JSON.stringify({
                ticks_history: market.code,
                end: 'latest',
                count: HISTORY_COUNT,
                style: 'ticks',
                subscribe: 1,
                req_id: reqId,
              }));
            }, index * 100);
            requestTimers.push(timer);
          });
        };

        socket.onmessage = (event) => {
          if (disposed) return;
          let message: DerivWireMessage;
          try {
            message = JSON.parse(String(event.data)) as DerivWireMessage;
          } catch {
            setFeedError('Deriv sent a message that could not be parsed.');
            return;
          }

          if (message.error) {
            const code = message.req_id === undefined ? undefined : requestSymbols.get(message.req_id);
            if (code) {
              setMarketInfo((current) => ({
                ...current,
                [code]: { ...(current[code] ?? emptyMarketInfo()), error: message.error?.message || message.error?.code || 'Deriv rejected this market request.' },
              }));
            } else {
              setFeedError(message.error.message || message.error.code || 'Deriv returned a market-data error.');
            }
            return;
          }

          if (message.msg_type === 'time' && message.time !== undefined) {
            const serverTime = Number(message.time);
            if (Number.isFinite(serverTime) && serverTime > 0) setServerClockOffsetMs(serverTime * 1000 - Date.now());
            return;
          }

          if (message.history?.prices && message.history.times) {
            const code = (message.req_id === undefined ? undefined : requestSymbols.get(message.req_id)) ?? message.echo_req?.ticks_history;
            if (!code || !symbols.some((market) => market.code === code)) return;
            const historical = normalizeHistory(message.history.prices, message.history.times);
            setTicksBySymbol((current) => {
              const merged = deduplicateAndSort([...historical, ...(current[code] ?? [])]);
              latestTickRef.current[code] = merged.at(-1) ?? null;
              return { ...current, [code]: merged };
            });
            setMarketInfo((current) => ({
              ...current,
              [code]: {
                ...(current[code] ?? emptyMarketInfo()),
                historyLoaded: historical.length > 0,
                error: historical.length ? '' : 'Deriv returned no valid tick history for this symbol.',
              },
            }));
            return;
          }

          if (!message.tick) return;
          const code = message.tick.symbol;
          if (!code || !symbols.some((market) => market.code === code)) return;
          const quote = Number(message.tick.quote);
          const epoch = Number(message.tick.epoch);
          if (!Number.isFinite(quote) || !Number.isFinite(epoch) || quote <= 0 || epoch <= 0) {
            setMarketInfo((current) => ({
              ...current,
              [code]: { ...(current[code] ?? emptyMarketInfo()), rejectedTicks: (current[code]?.rejectedTicks ?? 0) + 1 },
            }));
            return;
          }

          const previous = latestTickRef.current[code];
          if (previous && epoch < previous.epoch) {
            setMarketInfo((current) => ({
              ...current,
              [code]: { ...(current[code] ?? emptyMarketInfo()), rejectedTicks: (current[code]?.rejectedTicks ?? 0) + 1 },
            }));
            return;
          }
          if (previous && epoch === previous.epoch && quote === previous.quote) {
            setMarketInfo((current) => ({
              ...current,
              [code]: { ...(current[code] ?? emptyMarketInfo()), lastLiveTickAt: Date.now() },
            }));
            return;
          }

          const liveTick = { quote, epoch };
          latestTickRef.current[code] = liveTick;
          setTicksBySymbol((current) => ({
            ...current,
            [code]: deduplicateAndSort([...(current[code] ?? []), liveTick]),
          }));
          setMarketInfo((current) => ({
            ...current,
            [code]: { ...(current[code] ?? emptyMarketInfo()), lastLiveTickAt: Date.now(), error: '' },
          }));
          setFeedStatus('live');
        };

        socket.onerror = () => {
          if (!disposed) {
            setFeedError('The Deriv WebSocket reported a connection error. Retrying automatically.');
            setFeedStatus('reconnecting');
          }
        };
        socket.onclose = () => {
          if (disposed) return;
          clearConnectionTimers();
          setFeedStatus('reconnecting');
          setServerClockOffsetMs(null);
          setMarketInfo((current) => Object.fromEntries(symbols.map(({ code }) => [code, {
            ...(current[code] ?? emptyMarketInfo()), historyLoaded: false, lastLiveTickAt: null,
          }])));
          scheduleReconnect();
        };
      } catch (error) {
        setFeedError(error instanceof Error ? error.message : 'Could not open the Deriv WebSocket.');
        setFeedStatus('error');
        scheduleReconnect();
      }
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      clearConnectionTimers();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [symbols]);

  return { ticksBySymbol, marketInfo, feedStatus, feedError, serverClockOffsetMs };
}

function createMarketRow(
  market: (typeof SYMBOLS)[number],
  ticks: FeedTick[],
  info: MarketInfo,
  now: number,
  feedStatus: FeedStatus,
  serverClockOffsetMs: number | null,
): MarketRow {
  const analysis = analyzeRiseFall(ticks, 5);
  const receiveAgeMs = info.lastLiveTickAt === null ? null : now - info.lastLiveTickAt;
  const sourceAgeMs = analysis.lastEpoch === null || serverClockOffsetMs === null
    ? null
    : now + serverClockOffsetMs - analysis.lastEpoch * 1000;
  const fresh = feedStatus === 'live'
    && receiveAgeMs !== null
    && Math.abs(receiveAgeMs) <= STALE_AFTER_MS
    && sourceAgeMs !== null
    && Math.abs(sourceAgeMs) <= STALE_AFTER_MS;

  const reasons: string[] = [];
  if (info.error) reasons.push(info.error);
  if (!info.historyLoaded) reasons.push('Waiting for validated history.');
  if (ticks.length < REQUIRED_TICKS) reasons.push(`Need ${REQUIRED_TICKS - ticks.length} more valid ticks.`);
  if (!fresh) reasons.push('Live tick or server-time freshness is not confirmed.');
  if (analysis.bias === 'WAIT') reasons.push('Composite directional evidence is mixed or below threshold.');

  const directionSign = analysis.bias === 'RISE' ? 1 : analysis.bias === 'FALL' ? -1 : 0;
  const requiredStructure = analysis.bias === 'RISE'
    ? 'Higher highs and higher lows'
    : analysis.bias === 'FALL'
      ? 'Lower highs and lower lows'
      : '';
  if (directionSign && analysis.dowStructure !== requiredStructure) reasons.push('Swing structure does not confirm the directional bias.');
  if (directionSign && analysis.trendScore * directionSign < 0.12) reasons.push('Rolling-window trend does not align strongly enough.');
  if (directionSign && analysis.momentumScore * directionSign < 0.1) reasons.push('Momentum does not align with the directional bias.');
  if (directionSign && analysis.entryState !== 'Directional alignment (unconfirmed)') reasons.push(`Entry alignment is ${analysis.entryState.toLowerCase()}.`);
  if (directionSign && (analysis.volatilityRatio === null || analysis.volatilityRegime === 'Insufficient history')) reasons.push('Volatility context is unavailable.');

  const technicalEligible = reasons.length === 0 && directionSign !== 0;
  return { market, ticks, info, analysis, fresh, sourceAgeMs, technicalEligible, reasons, horizonEvaluations: [], bestHorizon: null };
}

function evaluateHorizon(row: MarketRow, horizon: Horizon): HorizonEvaluation {
  const historical = horizon.unit === 'ticks'
    ? historicalOutcomesByTicks(row.ticks, horizon.value)
    : historicalOutcomesByMinutes(row.ticks, horizon.value);
  const reasons = [...row.reasons];
  if (historical.sample < REQUIRED_HISTORICAL_SAMPLES) {
    reasons.push(`Only ${historical.sample} completed outcomes at this duration; ${REQUIRED_HISTORICAL_SAMPLES} required.`);
  }

  const isRise = row.analysis.bias === 'RISE';
  const isFall = row.analysis.bias === 'FALL';
  const alignedCount = isRise ? historical.rise : isFall ? historical.fall : 0;
  const oppositeCount = isRise ? historical.fall : isFall ? historical.rise : 0;
  const directionalCount = alignedCount + oppositeCount;
  const directionalSupport = directionalCount > 0 ? (alignedCount - oppositeCount) / directionalCount : null;
  if (row.analysis.bias !== 'WAIT' && directionalCount < REQUIRED_DIRECTIONAL_OUTCOMES) {
    reasons.push(`Only ${directionalCount} non-equal outcomes; ${REQUIRED_DIRECTIONAL_OUTCOMES} required for duration comparison.`);
  }
  if (row.analysis.bias !== 'WAIT' && directionalSupport !== null && directionalSupport <= 0) {
    reasons.push('Observed Rise/Fall outcomes at this duration do not align with the composite direction.');
  }
  if (row.analysis.bias !== 'WAIT' && directionalSupport === null) {
    reasons.push('No non-equal outcomes are available to compare this duration.');
  }

  return {
    horizon,
    historical,
    directionalSupport,
    qualified: row.technicalEligible && reasons.length === 0 && directionalSupport !== null && directionalSupport > 0,
    reasons,
  };
}

function evaluateMarketDurations(row: MarketRow): MarketRow {
  const horizonEvaluations = HORIZONS.map((horizon) => evaluateHorizon(row, horizon));
  const bestHorizon = horizonEvaluations
    .filter((evaluation) => evaluation.qualified)
    .sort((left, right) => (right.directionalSupport ?? -Infinity) - (left.directionalSupport ?? -Infinity))[0] ?? null;
  return { ...row, horizonEvaluations, bestHorizon };
}

function bestCandidate(rows: MarketRow[]): { row: MarketRow; evaluation: HorizonEvaluation } | null {
  return rows
    .filter((row) => row.bestHorizon !== null)
    .map((row) => ({ row, evaluation: row.bestHorizon! }))
    .sort((left, right) => {
      const supportDifference = (right.evaluation.directionalSupport ?? -Infinity) - (left.evaluation.directionalSupport ?? -Infinity);
      return supportDifference || Math.abs(right.row.analysis.biasScore) - Math.abs(left.row.analysis.biasScore);
    })[0] ?? null;
}

function PricePath({ ticks, marketName }: { ticks: FeedTick[]; marketName: string }) {
  const points = ticks.slice(-100);
  if (points.length < 2) {
    return (
      <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-4 text-center text-sm text-muted-foreground">
        Waiting for valid Deriv tick history. No sample or simulated prices are shown.
      </div>
    );
  }
  const quotes = points.map(({ quote }) => quote);
  const minimum = Math.min(...quotes);
  const maximum = Math.max(...quotes);
  const spread = maximum - minimum || Math.max(Math.abs(maximum) * 0.000001, 1);
  const chartWidth = 900;
  const chartHeight = 180;
  const padding = 8;
  const coordinates = quotes.map((quote, index) => {
    const x = padding + (index / (quotes.length - 1)) * (chartWidth - padding * 2);
    const y = chartHeight - padding - ((quote - minimum) / spread) * (chartHeight - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const last = coordinates.at(-1)!.split(',').map(Number);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background/40 px-2 py-3">
      <svg className="h-44 w-full" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={`${marketName} validated tick price path`}>
        <polyline points={coordinates.join(' ')} fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={last[0]} cy={last[1]} r="4" fill="hsl(var(--primary))" />
      </svg>
      <div className="flex justify-between px-2 text-[10px] text-muted-foreground mono">
        <span>{formatQuote(quotes[0])}</span>
        <span>{marketName} · {points.length} latest ticks</span>
        <span>{formatQuote(quotes.at(-1))}</span>
      </div>
    </div>
  );
}

function FeedBadge({ status, freshMarkets }: { status: FeedStatus; freshMarkets: number }) {
  const tone = status === 'live' && freshMarkets > 0
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
    : status === 'error'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-500';
  const label = status === 'live' ? `${freshMarkets} fresh markets` : status === 'connecting' ? 'Connecting to Deriv' : status === 'loading' ? 'Loading market history' : status === 'reconnecting' ? 'Reconnecting' : 'Feed error';
  return (
    <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${tone}`} aria-live="polite" data-testid="deriv-feed-status">
      {status === 'live' && freshMarkets > 0 ? <Wifi size={14} /> : status === 'error' ? <WifiOff size={14} /> : <Radio size={14} className={status === 'connecting' || status === 'reconnecting' ? 'animate-pulse-line' : ''} />}
      {label}
    </div>
  );
}

function WindowTable({ analysis }: { analysis: RiseFallAnalysis }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-card-border bg-card/80">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead><tr className="border-b border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><th className="px-3 py-3">Window</th><th className="px-3 py-3">Read</th><th className="px-3 py-3 text-right">Score</th></tr></thead>
        <tbody>{analysis.windows.map((window) => (
          <tr key={window.window} className="border-b border-border/60 last:border-0">
            <td className="px-3 py-2.5 font-semibold">{window.window} ticks</td>
            <td className="px-3 py-2.5 text-muted-foreground">{window.direction}</td>
            <td className="px-3 py-2.5 text-right mono">{formatSigned(window.score)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function HistoricalOutcomeCard({ row, historical, horizon }: { row: MarketRow; historical: HistoricalOutcomes | null; horizon: Horizon | null }) {
  const sample = historical?.sample ?? 0;
  const items = [
    { name: 'Rise', count: historical?.rise ?? 0, tone: 'bg-emerald-500' },
    { name: 'Fall', count: historical?.fall ?? 0, tone: 'bg-rose-500' },
    { name: 'Unchanged', count: historical?.unchanged ?? 0, tone: 'bg-muted-foreground/50' },
  ];
  return (
    <article className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="expiry-baseline">
      <div className="flex items-center justify-between gap-3">
        <div><div className="eyebrow">{horizon ? `Observed outcomes · ${formatHorizon(horizon)}` : 'Observed outcomes · no selected duration'}</div><h3 className="mt-1 text-base font-bold">{row.market.name}</h3></div>
        <BarChart3 size={17} className="text-primary" />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{historical ? `${sample} completed historical comparisons. Rise is final > entry; Fall is final < entry; equality is separate.` : 'No duration has been selected by the engines. Run Analysis to test all supported horizons; no duration is implied here.'}</p>
      <div className="mt-4 space-y-3">
        {items.map((item) => {
          const share = sample ? (item.count / sample) * 100 : 0;
          return <div key={item.name}>
            <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">{item.name}</span><span className="mono font-semibold">{historical ? `${item.count} · ${share.toFixed(1)}%` : '—'}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full ${item.tone}`} style={{ width: `${share}%` }} /></div>
          </div>;
        })}
      </div>
      <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-muted-foreground">Past movement only—not forecast probability, calibrated win rate, or a replay of actual contract terms. Minute horizons use the first observed tick at/after the target timestamp.</div>
    </article>
  );
}

function MarketScanTable({ rows, hasScan }: { rows: MarketRow[]; hasScan: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-card-border bg-card/80" data-testid="market-scan-table">
      <table className="w-full min-w-[980px] text-left text-xs">
        <thead><tr className="border-b border-border text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          <th className="px-3 py-3">Market</th><th className="px-3 py-3">Feed</th><th className="px-3 py-3">Composite bias</th><th className="px-3 py-3">Swing structure</th><th className="px-3 py-3">Trend / momentum</th><th className="px-3 py-3">Auto duration</th><th className="px-3 py-3">Outcomes</th><th className="px-3 py-3 text-right">Engine decision</th>
        </tr></thead>
        <tbody>{rows.map((row) => {
          const firstReason = row.bestHorizon ? '' : row.horizonEvaluations.find((evaluation) => evaluation.reasons.length > 0)?.reasons[0] ?? row.reasons[0];
          return <tr key={row.market.code} className="border-b border-border/60 align-top last:border-0">
            <td className="px-3 py-3"><div className="font-semibold">{row.market.name}</div><div className="mt-0.5 text-[10px] text-muted-foreground mono">{row.market.code}</div></td>
            <td className="px-3 py-3">{row.info.error ? <span className="text-destructive">Unavailable</span> : row.fresh ? <span className="text-emerald-500">Fresh</span> : <span className="text-amber-500">Waiting / stale</span>}<div className="mt-1 text-[10px] text-muted-foreground">{row.ticks.length} ticks</div></td>
            <td className="px-3 py-3"><span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${biasTone(row.analysis.bias)}`}>{row.analysis.bias}</span><div className="mt-1 text-[10px] text-muted-foreground mono">{formatSigned(row.analysis.biasScore)} evidence</div></td>
            <td className="px-3 py-3 text-muted-foreground">{row.analysis.dowStructure}</td>
            <td className="px-3 py-3 text-muted-foreground mono">{formatSigned(row.analysis.trendScore)} / {formatSigned(row.analysis.momentumScore)}</td>
            <td className="px-3 py-3 font-semibold">{row.bestHorizon ? formatHorizon(row.bestHorizon.horizon) : '—'}</td>
            <td className="px-3 py-3 text-muted-foreground mono">{row.bestHorizon ? row.bestHorizon.historical.sample : '—'}</td>
            <td className="px-3 py-3 text-right">{row.bestHorizon ? <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2 size={13} /> Candidate</span> : <span className="text-muted-foreground">{hasScan ? 'No qualifying duration' : 'Run Analysis to scan'}</span>}{row.bestHorizon === null && hasScan && firstReason && <div className="mt-1 max-w-52 text-left text-[10px] leading-relaxed text-muted-foreground">{firstReason}</div>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}

export function RiseFallTool() {
  const [now, setNow] = useState(Date.now());
  const [scanSnapshot, setScanSnapshot] = useState<ScanSnapshot | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const { ticksBySymbol, marketInfo, feedStatus, feedError, serverClockOffsetMs } = useDerivMarkets(SYMBOLS);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const liveRows = useMemo(() => SYMBOLS.map((market) => createMarketRow(
    market,
    ticksBySymbol[market.code] ?? [],
    marketInfo[market.code] ?? emptyMarketInfo(),
    now,
    feedStatus,
    serverClockOffsetMs,
  )), [ticksBySymbol, marketInfo, now, feedStatus, serverClockOffsetMs]);
  const freshCount = liveRows.filter((row) => row.fresh).length;
  const resultRows = scanSnapshot?.rows ?? liveRows;
  const candidateRef = scanSnapshot?.bestCandidate;
  const candidateRow = candidateRef ? scanSnapshot?.rows.find((row) => row.market.code === candidateRef.marketCode) ?? null : null;
  const candidateEvaluation = candidateRow?.horizonEvaluations.find((evaluation) => candidateRef && sameHorizon(evaluation.horizon, candidateRef.horizon)) ?? null;
  const scanCandidate = candidateRow && candidateEvaluation?.qualified ? { row: candidateRow, evaluation: candidateEvaluation } : null;
  const chartRow = scanCandidate?.row ?? resultRows.find((row) => row.ticks.length > 1) ?? resultRows[0];
  const chartHorizon = scanCandidate?.evaluation.horizon ?? null;
  const chartHistorical = scanCandidate?.evaluation.historical ?? null;

  function handleRunAnalysis() {
    if (isScanning) return;
    setIsScanning(true);
    window.setTimeout(() => {
      const rows = liveRows.map((row) => evaluateMarketDurations({
        ...row,
        info: { ...row.info },
        ticks: [...row.ticks],
        reasons: [...row.reasons],
      }));
      const candidate = bestCandidate(rows);
      setScanSnapshot({
        ranAt: Date.now(),
        rows,
        bestCandidate: candidate ? { marketCode: candidate.row.market.code, horizon: candidate.evaluation.horizon } : null,
      });
      setIsScanning(false);
    }, 80);
  }

  const scanSummary = !scanSnapshot
    ? 'Run Analysis checks every configured market against all 25 durations. It chooses a duration only when the data, combined engines and that duration’s observed outcomes pass the gates.'
    : scanCandidate
      ? `${scanCandidate.row.market.name} is the highest-ranked qualifying research candidate at ${formatHorizon(scanCandidate.evaluation.horizon)}. Duration is selected automatically; this remains unvalidated and is not a trade-ready signal.`
      : 'No market-and-duration pair passed every gate. The system returns WAIT rather than forcing a direction or expiry.';

  return (
    <div className="animate-rise-in space-y-5 pt-5" data-testid="rise-fall-analysis">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="eyebrow">Rise/Fall · multi-market research</div>
          <h2 className="mt-1 text-2xl font-extrabold tracking-[-0.04em] sm:text-3xl">Market scan and analysis</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">The scanner requests Deriv tick history and live updates for the supported volatility markets. Run Analysis combines trend, swing structure, momentum, volatility, data quality and expiry-specific historical outcomes; unavailable or stale feeds stay unqualified.</p>
        </div>
        <FeedBadge status={feedStatus} freshMarkets={freshCount} />
      </div>

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(220px,1fr)_auto] sm:items-end">
          <div>
            <div className="eyebrow">Automatic duration selection</div>
            <div className="mt-2 text-sm font-semibold">1–10 ticks · 1–15 minutes</div>
            <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">No manual duration choice. The engines test all 25 horizons per market and select the top qualifying horizon only when technical alignment and expiry-specific historical checks agree; otherwise the output is WAIT.</p>
          </div>
          <button type="button" onClick={handleRunAnalysis} disabled={isScanning} className="focus-ring flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60" data-testid="button-run-analysis">
            <Play size={16} fill="currentColor" />{isScanning ? 'Analyzing markets and durations…' : 'Run Analysis'}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
          <span>{SYMBOLS.length} configured synthetic markets</span>
          <span>{freshCount} currently fresh</span>
          <span>{HORIZONS.length} durations per market</span>
          <span>{USING_TEST_APP_ID ? 'Deriv test app ID 1089' : 'Configured Deriv app ID'}</span>
          <span>{serverClockOffsetMs === null ? 'Server clock unverified' : 'Deriv server time synced'}</span>
          <span>Synthetic tick count is not traded volume</span>
        </div>
        {feedError && <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs leading-relaxed text-destructive" role="alert"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{feedError}</span></div>}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]" data-testid="analysis-summary">
        <article className="signal-panel rounded-xl border border-card-border p-5 panel-glow sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="eyebrow">Trade-grade decision</div>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-amber-500">No auto-trading</span>
          </div>
          <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-5xl font-extrabold tracking-[-0.06em] text-amber-500">WAIT</div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{scanSummary}</p>
            </div>
            {scanCandidate ? (
              <div className={`w-full max-w-sm rounded-xl border px-4 py-3 ${biasTone(scanCandidate.row.analysis.bias)}`}>
                <div className="text-[10px] font-bold uppercase tracking-[0.1em] opacity-80">Auto-selected research candidate · unvalidated</div>
                <div className="mt-2 text-base font-extrabold">{scanCandidate.row.market.name}</div>
                <div className="mt-0.5 text-[10px] mono opacity-80">{scanCandidate.row.market.code}</div>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm font-bold">
                  <span className="inline-flex items-center gap-1.5">{scanCandidate.row.analysis.bias === 'RISE' ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}{scanCandidate.row.analysis.bias}</span>
                  <span className="rounded-full border border-current/20 px-2 py-1 text-xs">{formatHorizon(scanCandidate.evaluation.horizon)}</span>
                </div>
                <div className="mt-2 text-[10px] opacity-80">Observed direction aligns at this expiry · not a probability or forecast.</div>
              </div>
            ) : (
              <div className="w-full max-w-sm rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                {scanSnapshot ? 'No market and duration passed all data, technical and expiry-specific gates.' : 'No analysis has been run yet; no duration is selected.'}
              </div>
            )}
          </div>
          <div className="mt-5 flex items-start gap-2 rounded-lg border border-border bg-background/45 p-3 text-xs leading-relaxed text-muted-foreground">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" />
            <span>The automatic horizon is a research heuristic based on current engine alignment and historical outcomes, not a calibrated forecast. No out-of-sample calibration, live Deriv proposal, payout, break-even or expected-value check is connected; actionable output therefore remains WAIT.</span>
          </div>
          {scanSnapshot && <div className="mt-3 text-[10px] text-muted-foreground">Last scan: {new Date(scanSnapshot.ranAt).toLocaleTimeString()} · every supported horizon evaluated automatically</div>}
        </article>

        <article className="rounded-xl border border-card-border bg-card/90 p-5 panel-glow">
          <div className="flex items-center justify-between gap-3"><div><div className="eyebrow">{scanCandidate ? 'Auto-selected candidate market' : 'Live diagnostics · not a candidate'}</div><h3 className="mt-1 text-base font-bold">{chartRow.market.name}</h3></div><Activity size={18} className={chartRow.fresh ? 'text-emerald-500' : 'text-muted-foreground'} /></div>
          <div className="mt-5 text-3xl font-extrabold tracking-[-0.04em] mono">{formatQuote(chartRow.analysis.currentQuote)}</div>
          <div className="mt-1 text-xs text-muted-foreground">Validated quote · {formatEpoch(chartRow.analysis.lastEpoch)} · source {formatAge(chartRow.sourceAgeMs)}</div>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4">
            <div><div className="eyebrow">Feed sample</div><div className="mt-1 text-sm font-bold">{chartRow.ticks.length} ticks</div></div>
            <div><div className="eyebrow">Auto duration</div><div className="mt-1 text-sm font-bold">{chartHorizon ? formatHorizon(chartHorizon) : '—'}</div></div>
            <div><div className="eyebrow">Expiry outcomes</div><div className="mt-1 text-sm font-bold">{chartHistorical ? `${chartHistorical.sample} observed` : 'No duration selected'}</div></div>
            <div><div className="eyebrow">Swing structure</div><div className="mt-1 text-sm font-bold">{chartRow.analysis.dowStructure}</div></div>
          </div>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <article className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><div className="eyebrow">Validated tick price path</div><h3 className="mt-1 text-base font-bold">{chartRow.market.name}</h3></div><div className="text-xs text-muted-foreground">Price only · no synthetic volume</div></div>
          <PricePath ticks={chartRow.ticks} marketName={chartRow.market.name} />
        </article>
        <HistoricalOutcomeCard row={chartRow} historical={chartHistorical} horizon={chartHorizon} />
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><Database size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Data validation</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Requests up to 2,000 historical ticks and a live subscription per market. Invalid, duplicate and out-of-order ticks are excluded; stale markets do not qualify.</p></div></div>
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><TrendingUp size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Engines that must agree</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Requires fresh data, 500 valid ticks, aligned rolling windows, RSI/EMA/MACD momentum, Dow-style swings, 100-tick breadth, volatility-normalized ROC20, EMA50 position, entry alignment and expiry-specific historical direction.</p></div></div>
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><Clock3 size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Automatic duration limits</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">All 1–10 tick and 1–15 minute horizons are compared automatically. Minute horizons use observed timestamps, not a Deriv contract replay; equality is separate and contract terms are not queried.</p></div></div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><div className="eyebrow">Cross-market scan</div><h3 className="mt-1 text-base font-bold">Automatic duration by symbol</h3></div><span className="text-[10px] text-muted-foreground">{scanSnapshot ? 'Frozen at last Run Analysis' : 'Duration not selected until analysis runs'}</span></div>
        <MarketScanTable rows={resultRows} hasScan={Boolean(scanSnapshot)} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <article className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
          <div className="eyebrow">Rolling technical detail</div><h3 className="mt-1 text-base font-bold">{chartRow.market.name}</h3>
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div><div className="eyebrow">RSI · 14</div><div className="mt-1 font-bold mono">{chartRow.analysis.rsi14 === null ? '—' : chartRow.analysis.rsi14.toFixed(1)}</div></div>
            <div><div className="eyebrow">Volatility regime</div><div className="mt-1 font-bold">{chartRow.analysis.volatilityRegime}</div></div>
            <div><div className="eyebrow">EMA · 9 / 21</div><div className="mt-1 font-bold mono">{formatQuote(chartRow.analysis.ema9)} / {formatQuote(chartRow.analysis.ema21)}</div></div>
            <div><div className="eyebrow">MACD histogram</div><div className="mt-1 font-bold mono">{formatQuote(chartRow.analysis.macdHistogram)}</div></div>
            <div><div className="eyebrow">Mean absolute tick move</div><div className="mt-1 font-bold mono">{formatQuote(chartRow.analysis.averageTickMove14)}</div></div>
            <div><div className="eyebrow">100-tick breadth</div><div className="mt-1 font-bold mono">{formatPct(chartRow.analysis.upPercent100)} up / {formatPct(chartRow.analysis.downPercent100)} down</div></div>
            <div className="col-span-2 flex items-center gap-2 border-t border-border pt-3 text-muted-foreground"><Zap size={14} className="shrink-0 text-primary" />Composite inputs · trend {formatSigned(chartRow.analysis.trendScore)} · momentum {formatSigned(chartRow.analysis.momentumScore)} · swing {formatSigned(chartRow.analysis.dowScore)} · breadth {formatSigned(chartRow.analysis.breadthScore)} · ROC20 {formatSigned(chartRow.analysis.rocScore)} · EMA50 {formatSigned(chartRow.analysis.ema50Score)}</div>
          </div>
        </article>
        <div className="space-y-3"><div className="flex items-center gap-2"><TrendingDown size={16} className="text-primary" /><h3 className="text-sm font-bold">Rolling-window consensus</h3></div><WindowTable analysis={chartRow.analysis} /></div>
      </section>

      <div className="text-[10px] leading-relaxed text-muted-foreground" aria-live="polite">
        {scanSnapshot ? `Run Analysis examined ${scanSnapshot.rows.length} configured markets across all ${HORIZONS.length} durations at ${new Date(scanSnapshot.ranAt).toLocaleTimeString()}.` : 'Run Analysis to evaluate all markets and durations together. Live feed diagnostics continue updating in the background.'} No automatic order placement is available.
      </div>
    </div>
  );
}
