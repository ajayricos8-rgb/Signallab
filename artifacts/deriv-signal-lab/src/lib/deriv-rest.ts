// Deriv Options REST client + Personal Access Token (PAT) storage.
//
// Deriv's v1 Options API authenticates REST calls with
//   Authorization: Bearer <PAT>
//   Deriv-App-ID: <application id>   (required for PAT authentication)
// and issues short-lived, single-use OTP WebSocket URLs through
//   POST /trading/v1/options/accounts/{accountId}/otp
//
// The PAT is entered by the user. It is stored only in this browser (see
// `persistPat`) and is sent only to Deriv. If a browser blocks the direct
// cross-origin call, the request is retried once through the workspace's own
// API service, which forwards the same headers verbatim.
import { DERIV_APP_ID, DERIV_REST_BASE_URL } from './deriv-app-id.ts';

export type DerivAccountType = 'demo' | 'real';

export type DerivAccount = {
  accountId: string;
  balance: number | null;
  currency: string;
  group: string | null;
  status: string | null;
  accountType: DerivAccountType | null;
};

const PAT_STORAGE_KEY = 'signal-lab-deriv-pat';
/** Requests only ever touch Deriv's Options API surface. */
const DERIV_PROXY_PATH = '/api/deriv';

export class DerivRestError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly unauthorized: boolean;

  constructor(message: string, options: { status?: number | null; code?: string | null } = {}) {
    super(message);
    this.name = 'DerivRestError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.unauthorized = this.status === 401 || this.status === 403;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `undefined` when no PAT is stored or browser storage is unavailable. */
export function readStoredPat(): string {
  try {
    return (window.localStorage.getItem(PAT_STORAGE_KEY) ?? window.sessionStorage.getItem(PAT_STORAGE_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Stores the PAT for the current browser only. `remember` keeps it across
 * restarts in localStorage; otherwise it lives in sessionStorage and is
 * discarded when the tab closes.
 */
export function persistPat(pat: string, remember: boolean): void {
  try {
    if (remember) {
      window.localStorage.setItem(PAT_STORAGE_KEY, pat);
      window.sessionStorage.removeItem(PAT_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(PAT_STORAGE_KEY, pat);
      window.localStorage.removeItem(PAT_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable (private mode); the session still works in memory.
  }
}

export function forgetStoredPat(): void {
  try {
    window.localStorage.removeItem(PAT_STORAGE_KEY);
    window.sessionStorage.removeItem(PAT_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function buildHeaders(token: string, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Deriv-App-ID': DERIV_APP_ID,
  };
  if (withBody) headers['Content-Type'] = 'application/json';
  return headers;
}

async function requestJson(
  token: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<unknown> {
  const headers = buildHeaders(token, init.body !== undefined);
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  let response: Response;
  try {
    response = await fetch(`${DERIV_REST_BASE_URL}${path}`, {
      method: init.method,
      headers,
      body,
      cache: 'no-store',
    });
  } catch {
    // A browser blocks reads of cross-origin responses that carry no CORS
    // headers. Retry once through this workspace's API service, which forwards
    // the Authorization and Deriv-App-ID headers unchanged.
    try {
      response = await fetch(`${DERIV_PROXY_PATH}${path}`, {
        method: init.method,
        headers,
        body,
        cache: 'no-store',
      });
    } catch {
      throw new DerivRestError(
        'Deriv could not be reached from this browser. Check the network connection and try again.',
      );
    }
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = asRecord(payload);
    const errors = envelope?.errors;
    const first = Array.isArray(errors) ? asRecord(errors[0]) : null;
    const message =
      (typeof first?.message === 'string' && first.message) ||
      (response.status === 401
        ? 'Deriv rejected the access token. Confirm the token has the trade scope and the Deriv-App-ID header matches the registered application.'
        : `Deriv returned HTTP ${response.status}.`);
    throw new DerivRestError(message, {
      status: response.status,
      code: typeof first?.code === 'string' ? first.code : null,
    });
  }
  return payload;
}

function normalizeAccount(raw: unknown): DerivAccount | null {
  const item = asRecord(raw);
  if (!item) return null;
  const accountId = typeof item.account_id === 'string' ? item.account_id.trim() : '';
  const currency = typeof item.currency === 'string' ? item.currency.trim() : '';
  if (!accountId || !currency) return null;
  const rawBalance = item.balance;
  const balance = typeof rawBalance === 'number' && Number.isFinite(rawBalance)
    ? rawBalance
    : typeof rawBalance === 'string' && rawBalance.trim() && Number.isFinite(Number(rawBalance))
      ? Number(rawBalance)
      : null;
  const accountType = item.account_type === 'demo' || item.account_type === 'real' ? item.account_type : null;
  return {
    accountId,
    balance,
    currency,
    group: typeof item.group === 'string' ? item.group : null,
    status: typeof item.status === 'string' ? item.status : null,
    accountType,
  };
}

/** `GET /trading/v1/options/accounts` — the accounts the PAT can trade. */
export async function fetchDerivAccounts(token: string): Promise<DerivAccount[]> {
  const payload = await requestJson(token, '/trading/v1/options/accounts', { method: 'GET' });
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) {
    throw new DerivRestError('Deriv returned an unexpected accounts response.');
  }
  const accounts = data.map(normalizeAccount).filter((account): account is DerivAccount => account !== null);
  if (!accounts.length) {
    throw new DerivRestError(
      'This token has no active Options accounts. Create one in the Deriv dashboard, or check that the token has the trade scope.',
    );
  }
  return accounts;
}

/**
 * `POST /trading/v1/options/accounts/{accountId}/otp` — a single-use WebSocket
 * URL, valid for 120 seconds, already scoped to the account's demo or real
 * channel.
 */
export async function requestDerivOtp(token: string, accountId: string): Promise<string> {
  const payload = await requestJson(
    token,
    `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    { method: 'POST' },
  );
  const url = asRecord(asRecord(payload)?.data)?.url;
  if (typeof url !== 'string' || !url.startsWith('wss://')) {
    throw new DerivRestError('Deriv did not return a usable WebSocket URL for this account.');
  }
  return url;
}
