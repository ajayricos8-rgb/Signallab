// Frame side of the Signal Lab account link.
//
// The Signal Lab shell already holds the connected Deriv account. Instead of
// asking the operator to log in to DBot a second time, it mints a single-use
// authenticated socket (`connect-account` → one-time `wss` URL) and posts it
// here. This module adopts that socket as DBot's own API connection and marks
// the client as authorized with the account snapshot the data bridge already
// shares — the token itself never crosses the iframe boundary.
//
// Everything is guarded: if the socket, the symbols request or a subscription
// fails, the workspace still renders and the shell is told `account-error`, so
// a broken link can never take the bot builder down with it.
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import APIMiddleware from '@/external/bot-skeleton/services/api/api-middleware';
import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import ApiHelpers from '@/external/bot-skeleton/services/api/api-helpers';
import {
  CONNECTION_STATUS,
  setAccountList,
  setAuthData,
  setConnectionStatus,
  setIsAuthorized,
} from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import type { TAuthData } from '@/types/api-types';
import { getSignalLabAccount, getSignalLabMarkets } from './signallab-feed';

const FRAME_SOURCE = 'signal-lab-dbot';
/** A socket that cannot authenticate a bot in this window is a failed link. */
const OPEN_TIMEOUT_MS = 15_000;
/** Symbols are a nice-to-have: the builder must not wait on them. */
const SYMBOLS_TIMEOUT_MS = 8_000;

type LinkedAccount = { grantId: number; accountId: string };

let socket: WebSocket | null = null;
let linked: LinkedAccount | null = null;
/** Bumped on every connect/disconnect so a slow socket cannot win a race. */
let revision = 0;

function post(message: Record<string, unknown>) {
  if (typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage({ source: FRAME_SOURCE, ...message }, window.location.origin);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const next = new WebSocket(url);
    const timer = setTimeout(() => {
      next.close();
      reject(new Error('The Signal Lab account socket did not open in time.'));
    }, OPEN_TIMEOUT_MS);
    next.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(next);
      },
      { once: true },
    );
    next.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        try {
          next.close();
        } catch {
          // Closing an already broken socket is not an error worth reporting.
        }
        reject(new Error('The Signal Lab account socket was refused.'));
      },
      { once: true },
    );
  });
}

/** Auth payload shaped from the account snapshot the shell already posted. */
function buildAuthData(account: LinkedAccount, accountType: 'demo' | 'real' | null): TAuthData {
  const snapshot = getSignalLabAccount();
  const is_virtual = (accountType ?? snapshot?.accountType) === 'real' ? 0 : 1;
  const currency = snapshot?.currency || 'USD';
  const balance = snapshot?.balance ?? 0;
  const account_entry = {
    loginid: account.accountId,
    currency,
    is_virtual,
    balance,
    landing_company_name: is_virtual ? 'virtual' : 'svg',
    landing_company_shortcode: is_virtual ? 'virtual' : 'svg',
    email: '',
    group: 'row',
    account_type: 'trading',
  };
  return {
    account_list: [account_entry],
    balance,
    country: '',
    currency,
    email: '',
    fullname: '',
    is_virtual,
    landing_company_fullname: '',
    landing_company_name: account_entry.landing_company_name,
    linked_to: [],
    local_currencies: {},
    loginid: account.accountId,
    preferred_language: 'EN',
    scopes: ['read', 'trade', 'payments', 'admin'],
    upgradeable_landing_companies: [],
    user_id: 0,
  } as unknown as TAuthData;
}

/**
 * Adopt the authenticated socket as DBot's API connection. The public socket
 * DBot opened for itself is closed afterwards; the status is re-asserted so a
 * late `close` event from it cannot mark the workspace as disconnected.
 */
function adoptSocket(next: WebSocket, account: LinkedAccount, accountType: 'demo' | 'real' | null) {
  const previous = api_base.api;
  const api = new DerivAPIBasic({
    connection: next,
    middleware: new APIMiddleware({}),
  });
  api_base.api = api as unknown as typeof api_base.api;
  api_base.token = '';
  api_base.account_id = account.accountId;
  api_base.is_authorized = true;

  const auth = buildAuthData(account, accountType);
  setAccountList(auth.account_list);
  setAuthData(auth);
  setIsAuthorized(true);
  setConnectionStatus(CONNECTION_STATUS.OPENED);

  if (previous && previous !== api_base.api) {
    try {
      previous.disconnect();
    } catch {
      // The anonymous socket is already being thrown away.
    }
    // `onsocketclose` runs on the old socket and sets CLOSED; keep the truth.
    window.setTimeout(() => setConnectionStatus(CONNECTION_STATUS.OPENED), 0);
  }

  try {
    api_base.toggleRunButton(false);
  } catch {
    // The run panel may not have painted yet.
  }

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    const ended = linked;
    linked = null;
    setConnectionStatus(CONNECTION_STATUS.CLOSED);
    setIsAuthorized(false);
    try {
      api_base.is_authorized = false;
    } catch {
      // Nothing else to reset.
    }
    if (ended) {
      post({
        type: 'account-disconnected',
        grantId: ended.grantId,
        reason: 'connection-lost',
      });
    }
  });
}

/**
 * Market metadata from the shared tick bridge, used only when the account
 * socket cannot answer `active_symbols` in time: the Trade definition block
 * needs a market list, and Signal Lab's markets are the ones it can price.
 */
export function seedSymbolsFromBridge(): boolean {
  if (api_base.has_active_symbols) return true;
  const markets = getSignalLabMarkets();
  if (!markets.length) return false;
  api_base.active_symbols = markets.map((market) => ({
    symbol: market.symbol,
    display_name: market.name,
    market: 'synthetic_index',
    market_display_name: 'Derived',
    submarket: 'random_index',
    submarket_display_name: 'Continuous Indices',
    exchange_is_open: 1,
    pip: String(market.pipSize ?? 0.01),
    is_trading_suspended: 0,
  }));
  api_base.has_active_symbols = true;
  try {
    api_base.active_symbols_promise = Promise.resolve();
  } catch {
    // Nothing depends on the promise handle.
  }
  // The Trade definition block reads ApiHelpers' processed symbols, so hand the
  // seeded list over instead of letting it wait for a socket response.
  try {
    const active_symbols = (ApiHelpers.instance as unknown as { active_symbols?: Record<string, unknown> })
      ?.active_symbols;
    if (!active_symbols) return api_base.has_active_symbols;
    active_symbols.active_symbols = api_base.active_symbols;
    active_symbols.is_initialised = true;
    (active_symbols.init_promise as { resolve?: () => void } | undefined)?.resolve?.();
    (active_symbols.processActiveSymbols as (() => void) | undefined)?.();
  } catch {
    // The builder recomputes its own list when it mounts.
  }
  return api_base.has_active_symbols;
}

async function loadSymbols() {
  try {
    const symbols = await withTimeout(api_base.getActiveSymbols(), SYMBOLS_TIMEOUT_MS);
    if (!symbols || !api_base.has_active_symbols) seedSymbolsFromBridge();
  } catch {
    seedSymbolsFromBridge();
  }
}

export function isSignalLabAccountLinked() {
  return linked !== null;
}

/** Connect DBot to the account Signal Lab already holds. Never throws. */
export async function connectSignalLabAccount(input: {
  grantId: number;
  accountId: string;
  url: string;
  accountType: 'demo' | 'real' | null;
}): Promise<void> {
  disconnectSignalLabAccount({ announce: false });
  const attempt = ++revision;
  try {
    const next = await openSocket(input.url);
    // The shell may have re-linked (or unlinked) while this socket opened.
    if (attempt !== revision) {
      try {
        next.close();
      } catch {
        // Already gone.
      }
      return;
    }
    socket = next;
    linked = { grantId: input.grantId, accountId: input.accountId };
    adoptSocket(next, linked, input.accountType);
    post({
      type: 'account-connected',
      accountId: input.accountId,
      grantId: input.grantId,
    });
    // One balance subscription, sent directly: the shell's account snapshot is
    // the source of truth, and a rejected request must never turn into a retry
    // loop on a socket that does not support it.
    try {
      (api_base.api as unknown as { send?: (payload: unknown) => unknown } | null)?.send?.({
        balance: 1,
        subscribe: 1,
        account: 'all',
      });
    } catch {
      // The bridge still reports balance to the shell.
    }
    void loadSymbols();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DBot could not use the Signal Lab account.';
    post({ type: 'account-error', grantId: input.grantId, message });
  }
}

/** Drop the adopted socket; DBot keeps rendering with the shared tick bridge. */
export function disconnectSignalLabAccount({ announce = true }: { announce?: boolean } = {}) {
  revision += 1;
  const ended = linked;
  linked = null;
  if (socket) {
    const current = socket;
    socket = null;
    try {
      current.close();
    } catch {
      // Already gone.
    }
  }
  api_base.is_authorized = false;
  setIsAuthorized(false);
  if (!announce) return;
  // Unlinking is a real end of the session: reconnect DBot's own anonymous
  // socket so the builder, symbols and charts keep working while the operator
  // decides what to link next.
  void Promise.resolve(api_base.init(true)).catch(() => undefined);
  if (ended) {
    post({ type: 'account-disconnected', grantId: ended.grantId, reason: 'unlinked' });
  }
}
