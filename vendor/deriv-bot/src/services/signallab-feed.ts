// Same-origin tick/account bridge: installed when the embedded DBot app starts.
type Tick = [number, number];
type Market = { symbol: string; name: string; pipSize: number | null; ticks: Tick[] };
type Account = {
  accountId: string; accountType: 'demo' | 'real' | 'unknown'; balance: number | null; currency: string;
  openPositions: Array<Record<string, unknown>>; openProfit: number; realizedProfit: number; closedTrades: number; updatedAt: number;
};
const LIMIT = 1_000;
const FALLBACK: Array<[string, string]> = [
  ['R_10', 'Volatility 10 Index'], ['R_25', 'Volatility 25 Index'], ['R_50', 'Volatility 50 Index'],
  ['R_75', 'Volatility 75 Index'], ['R_100', 'Volatility 100 Index'],
];
let markets: Market[] = [];
let account: Account | null = null;
let connected = false;
let installed = false;
const listeners = new Set<() => void>();
const waiters = new Set<() => void>();
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function notify() {
  listeners.forEach((listener) => listener());
  [...waiters].forEach((resolve) => resolve());
}
function receive(event: MessageEvent) {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  const message = event.data;
  if (!message || typeof message !== 'object' || message.source !== 'signal-lab') return;
  if (message.type === 'signal-lab-feed' && Array.isArray(message.markets)) {
    if (message.reset === true) markets = [];
    for (const item of message.markets) {
      if (!item || typeof item.symbol !== 'string' || !Array.isArray(item.ticks)) continue;
      const old = markets.find((market) => market.symbol === item.symbol);
      const incoming = item.ticks.filter((tick: unknown): tick is Tick => Array.isArray(tick)
        && tick.length >= 2 && finite(tick[0]) && finite(tick[1]));
      const ticks = message.reset === true || !old ? incoming
        : [...old.ticks.filter(([epoch]) => !incoming.some(([next]) => next === epoch)), ...incoming]
          .sort(([a], [b]) => a - b);
      const next = {
        symbol: item.symbol,
        name: typeof item.name === 'string' ? item.name : item.symbol,
        pipSize: finite(item.pipSize) ? item.pipSize : null,
        ticks: ticks.slice(-LIMIT),
      };
      if (old) markets[markets.indexOf(old)] = next;
      else markets.push(next);
    }
    connected = true;
    notify();
  } else if (message.type === 'signal-lab-account') {
    account = typeof message.accountId !== 'string' || !message.accountId ? null : {
      accountId: message.accountId,
      accountType: message.accountType === 'demo' || message.accountType === 'real' ? message.accountType : 'unknown',
      balance: finite(message.balance) ? message.balance : null,
      currency: typeof message.currency === 'string' ? message.currency : '',
      openPositions: Array.isArray(message.openPositions) ? message.openPositions.slice(0, 20) : [],
      openProfit: finite(message.openProfit) ? message.openProfit : 0,
      realizedProfit: finite(message.realizedProfit) ? message.realizedProfit : 0,
      closedTrades: finite(message.closedTrades) ? message.closedTrades : 0,
      updatedAt: finite(message.updatedAt) ? message.updatedAt : Date.now(),
    };
    notify();
  } else if (message.type === 'signal-lab-bridge' && message.live === false) {
    markets = []; account = null; connected = false; notify();
  }
}
export function connectSignalLabBridge() {
  if (installed || typeof window === 'undefined' || window.parent === window) return;
  installed = true;
  window.addEventListener('message', receive);
  window.parent.postMessage({ source: 'signal-lab-dbot', type: 'feed-subscribe' }, window.location.origin);
}
export function getSignalLabMarkets(): Market[] { return [...markets].sort((a, b) => a.symbol.localeCompare(b.symbol)); }
export function getSignalLabTicks(symbol: string): number[] { return markets.find((m) => m.symbol === symbol)?.ticks.map(([, q]) => q) ?? []; }
export function getSignalLabLastTick(symbol: string): number | null { return getSignalLabTicks(symbol).at(-1) ?? null; }
export function getSignalLabLastDigit(symbol: string): number | null {
  const market = markets.find((m) => m.symbol === symbol); const quote = market?.ticks.at(-1)?.[1];
  if (!market || quote === undefined) return null;
  const places = market.pipSize ? Math.max(0, Math.round(-Math.log10(market.pipSize))) : 2;
  return Number(quote.toFixed(places).replace('.', '').slice(-1));
}
export function getSignalLabTickChange(symbol: string, lookback = 1): number | null {
  const ticks = markets.find((m) => m.symbol === symbol)?.ticks ?? [];
  const current = ticks.at(-1)?.[1]; const previous = ticks[Math.max(0, ticks.length - Math.max(1, Math.floor(lookback)) - 1)]?.[1];
  return current === undefined || previous === undefined ? null : current - previous;
}
export function getSignalLabMarketOptions(): Array<[string, string]> {
  const entries = getSignalLabMarkets();
  return entries.length ? entries.map(({ symbol, name }) => [`${name} (${symbol})`, symbol]) : FALLBACK;
}
export function isSignalLabConnected(): boolean { return connected; }
export function getSignalLabAccount(): Account | null { return account ? { ...account, openPositions: [...account.openPositions] } : null; }
export function getSignalLabBalance(): number | null { return account?.balance ?? null; }
export function getSignalLabOpenPositions(): Array<Record<string, unknown>> { return [...(account?.openPositions ?? [])]; }
function waitFor<T>(read: () => T | null, ms: number): Promise<T | null> {
  const current = read(); if (current !== null) return Promise.resolve(current);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(read()); };
    waiters.add(done); timer = setTimeout(done, Math.max(0, ms));
  });
}
export function waitForSignalLabTicks(symbol: string, ms = 5_000): Promise<number[]> {
  return waitFor(() => getSignalLabTicks(symbol).length ? getSignalLabTicks(symbol) : null, ms).then((value) => value ?? []);
}
export function waitForSignalLabAccount(ms = 5_000): Promise<Account | null> { return waitFor(getSignalLabAccount, ms); }
export function subscribeSignalLabBridge(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
