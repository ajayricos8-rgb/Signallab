import { useState } from 'react';
import { BadgeCheck, CircleSlash, Eye, EyeOff, KeyRound, Link2, Loader2, RotateCw, ShieldCheck } from 'lucide-react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { DERIV_APP_ID, USING_TEST_APP_ID } from '@/lib/deriv-app-id';
import { readStoredPat } from '@/lib/deriv-rest';
import { formatAmount } from '@/lib/deriv-trading';

/** Where a Personal Access Token is created for a Deriv application. */
const DERIV_DASHBOARD_URL = 'https://developers.deriv.com/dashboard';

const STATUS_LABEL: Record<string, string> = {
  disconnected: 'Not connected',
  authorizing: 'Verifying token',
  connecting: 'Opening trading socket',
  connected: 'Connected',
  error: 'Connection problem',
};

export function DerivConnectionStatusBadge({
  compact = false,
  variant = 'default',
}: {
  compact?: boolean;
  /** `dock` keeps the pill legible on the always-dark trade dock. */
  variant?: 'default' | 'dock';
}) {
  const trading = useDerivTrading();
  const connected = trading.status === 'connected';
  const busy = trading.status === 'authorizing' || trading.status === 'connecting';
  const tone = connected
    ? variant === 'dock'
      ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    : trading.status === 'error'
      ? variant === 'dock'
        ? 'border-rose-300/40 bg-rose-300/10 text-rose-200'
        : 'border-destructive/30 bg-destructive/10 text-destructive'
      : variant === 'dock'
        ? 'border-[#385677] bg-[#162f50] text-slate-200'
        : 'border-border bg-secondary/60 text-muted-foreground';
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${tone}`}
      data-testid="deriv-connection-status"
      aria-live="polite"
    >
      {connected ? <BadgeCheck size={12} /> : busy ? <Loader2 size={12} className="animate-spin" /> : <CircleSlash size={12} />}
      {compact && connected && trading.activeAccount ? trading.activeAccount.accountId : STATUS_LABEL[trading.status]}
    </span>
  );
}

export function DerivConnectionCard({ compact = false }: { compact?: boolean }) {
  const trading = useDerivTrading();
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [revealToken, setRevealToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const connected = trading.status === 'connected';
  const busy = submitting || trading.status === 'authorizing' || trading.status === 'connecting';
  const canReconnect = !connected && (trading.accounts.length > 0 || Boolean(readStoredPat()));

  async function handleConnect() {
    if (busy) return;
    setSubmitting(true);
    try {
      await trading.connect(token, { remember });
      setToken('');
      setRevealToken(false);
    } finally {
      setSubmitting(false);
    }
  }

  /** Reuses the stored token (and the last account) without re-entering it. */
  async function handleReconnect() {
    if (busy) return;
    const stored = readStoredPat();
    if (!stored) return;
    setSubmitting(true);
    try {
      await trading.connect(stored, { accountId: trading.activeAccount?.accountId });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className={`rounded-xl border border-card-border bg-card/90 panel-glow ${compact ? 'p-4' : 'p-4 sm:p-5'}`}
      data-testid="deriv-connection-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <KeyRound size={16} />
        </span>
        <div className="min-w-0">
          <div className="eyebrow">Deriv access</div>
          <h3 className="text-sm font-bold tracking-tight">Personal Access Token connection</h3>
        </div>
        <span className="ml-auto">
          <DerivConnectionStatusBadge />
        </span>
      </div>

      {!compact && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Create a Personal Access Token (PAT) with the <strong className="text-foreground">trade</strong> scope in the
          Deriv dashboard, then paste it here. The token is exchanged for a single-use, 120-second WebSocket
          credential per account — it is never written into the market-data feed or the app ID.
        </p>
      )}

      {trading.status === 'error' && trading.error && (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive" role="alert" data-testid="deriv-connection-error">
          {trading.error}
        </div>
      )}

      {!connected ? (
        <div className="mt-3 space-y-3">
          {canReconnect && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
              <span className="text-[11px] text-muted-foreground">
                A token is already stored in this browser. Reconnect with it, or paste a different token below.
              </span>
              <button
                type="button"
                onClick={() => void handleReconnect()}
                disabled={busy}
                className="focus-ring ml-auto inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-primary/40 px-3 text-xs font-bold text-primary transition-colors hover:bg-primary/10 disabled:opacity-60"
                data-testid="button-deriv-reconnect"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}
                Reconnect
              </button>
            </div>
          )}
          <label className="block">
            <span className="eyebrow">Personal Access Token</span>
            <div className="mt-1 flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  type={revealToken ? 'text' : 'password'}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleConnect();
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your Deriv PAT"
                  className="mono h-10 w-full rounded-lg border border-border bg-background px-3 pr-10 text-xs outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30"
                  data-testid="deriv-pat-input"
                  aria-label="Deriv Personal Access Token"
                />
                <button
                  type="button"
                  onClick={() => setRevealToken((value) => !value)}
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label={revealToken ? 'Hide token' : 'Show token'}
                  data-testid="button-toggle-pat-visibility"
                >
                  {revealToken ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleConnect()}
                disabled={busy || !token.trim()}
                className="focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="button-deriv-connect"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
                {busy ? 'Connecting' : 'Connect'}
              </button>
            </div>
          </label>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                data-testid="checkbox-remember-pat"
              />
              Remember on this device
            </label>
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck size={13} className="text-primary" />
              Stored only in this browser; sent only to Deriv.
            </span>
            <a
              href={DERIV_DASHBOARD_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="focus-ring inline-flex items-center gap-1 font-semibold text-primary hover:underline"
              data-testid="link-deriv-dashboard"
            >
              Create a PAT
              <span aria-hidden="true">↗</span>
            </a>
          </div>

          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Application ID in use: <span className="mono font-semibold text-foreground">{DERIV_APP_ID}</span>
            {USING_TEST_APP_ID ? ' (Deriv test ID — set VITE_DERIV_APP_ID to register your own app)' : ''}. It travels as
            the <span className="mono">Deriv-App-ID</span> header on REST calls, exactly as the market-data feed uses it.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="eyebrow">Trading account</span>
              <select
                value={trading.activeAccount?.accountId ?? ''}
                onChange={(event) => void trading.selectAccount(event.target.value)}
                className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-xs font-semibold outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
                data-testid="deriv-account-select"
              >
                {trading.accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.accountType === 'real' ? 'Real' : 'Demo'} · {account.accountId} · {account.currency}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
              <div className="eyebrow">Balance</div>
              <div className="mono mt-1 text-sm font-bold" data-testid="deriv-balance">
                {formatAmount(trading.balance, trading.currency || (trading.activeAccount?.currency ?? ''))}
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {trading.activeAccount?.accountType === 'real'
                  ? 'Real-money account — trades settle against this balance.'
                  : 'Demo account — virtual funds only.'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => trading.refresh()}
              className="focus-ring inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-bold transition-colors hover:border-primary/50 hover:text-primary"
              data-testid="button-deriv-refresh"
            >
              <RotateCw size={14} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => trading.disconnect()}
              className="focus-ring inline-flex h-9 items-center gap-2 rounded-lg border border-destructive/40 px-3 text-xs font-bold text-destructive transition-colors hover:bg-destructive/10"
              data-testid="button-deriv-disconnect"
            >
              <CircleSlash size={14} />
              Disconnect and forget token
            </button>
            <span className="text-[10px] text-muted-foreground" aria-live="polite">
              {trading.connectedAt
                ? `Session opened ${new Date(trading.connectedAt).toLocaleTimeString()} · stream: balance, portfolio, contracts`
                : 'Trading socket active'}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
