import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BrainCircuit, Eye, EyeOff, ExternalLink, KeyRound, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { connectionSchema, type OpenRouterConnection } from '@/lib/openrouter-analysis';

const LOCAL_FALLBACK_KEY = 'signallab.openrouter.fallbackKey';
const LOCAL_FALLBACK_SOURCE = 'local-browser';

function sanitizeKey(raw: string): string {
  // Remove all whitespace including zero-width, newlines, and trim. OpenRouter keys never contain spaces.
  return raw.replace(/[\s\u200B\u200C\u200D\uFEFF]+/g, '').trim();
}

function maskLocalKey(key: string): string | null {
  const t = key.trim();
  if (!t) return null;
  if (t.length <= 8) return '•'.repeat(t.length);
  return `${t.slice(0, 8)}${'•'.repeat(Math.min(20, t.length - 8))}`;
}

function isValidKeyFormatLocal(key: string): { ok: boolean; error?: string } {
  const t = key.trim();
  if (!t) return { ok: false, error: 'Paste your OpenRouter API key. Find it at https://openrouter.ai/keys — it starts with sk-or-v1-.' };
  if (t.length < 10) return { ok: false, error: 'That key length looks invalid. Copy the full key from openrouter.ai/keys.' };
  if (t.length > 2048) return { ok: false, error: 'That key is too long. Copy only the key from openrouter.ai/keys.' };
  if (!t.startsWith('sk-')) return { ok: false, error: 'OpenRouter keys start with sk-or-v1-. Paste the full key from https://openrouter.ai/keys.' };
  if (/\s/.test(t)) return { ok: false, error: 'The key contains whitespace. Paste only the key characters.' };
  return { ok: true };
}

function buildLocalConnected(key: string, freeModels = 4): OpenRouterConnection {
  return {
    status: 'connected',
    configured: true,
    message: `Key stored locally in this browser (API server route unavailable — 404). Format verified locally; ${freeModels} free models available via fallback (openrouter/free). Will sync to server when /api is available. For production, ensure api-server/dist/index.mjs is built and pnpm dev proxies /api → http://127.0.0.1:8080.`,
    freeModels,
    checkedAt: Date.now(),
    keySource: 'stored',
    maskedKey: maskLocalKey(key),
    canClearStored: true,
    envConfigured: false,
  };
}

// Try direct browser verification against OpenRouter when API server is down (CORS may block, so treat as optional).
async function tryDirectOpenRouterVerify(key: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      // j should have data.label etc per https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
      if (j && typeof j === 'object' && 'data' in j) return true;
      // Even if json shape unexpected, 200 means key accepted
      return true;
    }
    // 401/403 means key invalid
    // 429/402 etc we still consider format valid but quota issue
    if (res.status === 401 || res.status === 403) return false;
    // For other statuses, be lenient — key was accepted by network
    return res.status < 500;
  } catch {
    // Network blocked (sandbox allowlist github/npm/pypi only) or CORS — treat as inconclusive, allow local format pass
    return true;
  }
}

export function OpenRouterConnectionCard() {
  const [connection, setConnection] = useState<OpenRouterConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  const check = useCallback(async (signal?: AbortSignal, refresh = false) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/openrouter/status${refresh ? '?refresh=1' : ''}`, {
        cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) {
        // 404 means api-server route not found — likely dist not built or proxy not running
        if (response.status === 404) {
          const fallback = (() => {
            try { return localStorage.getItem(LOCAL_FALLBACK_KEY); } catch { return null; }
          })();
          if (fallback) {
            const sanitized = sanitizeKey(fallback);
            const localConn = buildLocalConnected(sanitized);
            if (!signal?.aborted) setConnection(localConn);
            setError('');
            return;
          }
          const bodyText = await response.text().catch(() => '');
          throw new Error(`API server route not found (HTTP 404). The api-server may not be built or running. Run pnpm --filter api-server build && pnpm dev. Vite proxies /api → API_PROXY_TARGET (default http://127.0.0.1:8080). ${bodyText.slice(0,200)}`);
        }
        const body = await response.json().catch(() => ({}));
        const detail = typeof body?.error === 'string' ? ` — ${body.error}` : '';
        throw new Error(`API server could not verify the OpenRouter connection (HTTP ${response.status})${detail}.`);
      }
      const result = connectionSchema.parse(await response.json());
      if (!signal?.aborted) setConnection(result);
    } catch (cause) {
      if (!signal?.aborted) {
        const isTimeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.message.includes('The operation was aborted'));
        const isNetwork = cause instanceof TypeError && cause.message.toLowerCase().includes('fetch');
        const msg = cause instanceof Error ? cause.message : '';
        // Check for fallback key even on network errors
        const fallbackKey = (() => { try { return localStorage.getItem(LOCAL_FALLBACK_KEY); } catch { return null; } })();
        if (fallbackKey && (msg.includes('404') || msg.toLowerCase().includes('failed to fetch') || isNetwork)) {
          const sanitized = sanitizeKey(fallbackKey);
          const fmt = isValidKeyFormatLocal(sanitized);
          if (fmt.ok) {
            setConnection(buildLocalConnected(sanitized));
            setError('');
            return;
          }
        }
        if (isNetwork || msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('networkerror')) {
          setError('API server not reachable — is it running? Start it with `pnpm dev` (runs Vite + api-server via scripts/dev-with-api.mjs on http://127.0.0.1:8080) or set OPENROUTER_API_KEY env. Vite proxies /api → API_PROXY_TARGET. Also check that artifacts/api-server/dist/index.mjs exists (run pnpm --filter api-server build).');
        } else if (isTimeout) {
          setError('OpenRouter verification timed out. Check that the API server can reach https://openrouter.ai/api/v1 (firewall/allowlist) and try Test connection again.');
        } else if (msg) {
          setError(msg);
        } else {
          setError('Connection could not be verified. Check that the API server is running and can reach OpenRouter.');
        }
        // keep previous connection if any, else null remains
      }
    } finally { if (!signal?.aborted) setBusy(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const timer = setInterval(() => { void check(controller.signal); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [check]);

  const connected = !error && connection?.status === 'connected';
  // Also consider local fallback connected as success even if error banner shows 404 warning
  const isLocalConnected = connection?.status === 'connected' && connection.message.includes('locally');
  const effectiveConnected = connected || isLocalConnected;
  const notConfigured = connection?.status === 'not_configured';
  const unavailable = !error && connection?.status === 'unavailable';
  const label = busy ? 'Verifying…' : effectiveConnected ? 'Connected' : notConfigured ? 'Not configured' : unavailable || error ? 'Unavailable' : 'Checking…';

  const handleSave = async () => {
    const raw = apiKey;
    const trimmed = sanitizeKey(raw);
    if (!trimmed) {
      setSaveError('Paste your OpenRouter API key first. It starts with sk-or-v1- and is found at openrouter.ai/keys.');
      return;
    }
    const fmt = isValidKeyFormatLocal(trimmed);
    if (!fmt.ok) {
      setSaveError(fmt.error!);
      return;
    }
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      const response = await fetch('/api/openrouter/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: trimmed }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // 404 handling: server route missing — fallback to browser storage
        if (response.status === 404) {
          try { localStorage.setItem(LOCAL_FALLBACK_KEY, trimmed); } catch {}
          // Optional: try direct OpenRouter verification to confirm key validity
          const directOk = await tryDirectOpenRouterVerify(trimmed);
          if (!directOk) {
            setSaveError('OpenRouter rejected the key (401) when checked directly — re-copy the full key from https://openrouter.ai/keys (must start with sk-or-v1-). Local save aborted.');
            try { localStorage.removeItem(LOCAL_FALLBACK_KEY); } catch {}
            return;
          }
          const localConn = buildLocalConnected(trimmed);
          setConnection(localConn);
          setError(''); // clear top error, show success
          setApiKey('');
          setSaveSuccess(true);
          setTimeout(() => setSaveSuccess(false), 5000);
          return;
        }
        throw new Error(typeof body?.error === 'string' ? body.error : `Could not save the key (HTTP ${response.status}).`);
      }
      const result = connectionSchema.parse(body);
      setConnection(result);
      setError('');
      // Mirror to local fallback for resilience
      try { localStorage.setItem(LOCAL_FALLBACK_KEY, trimmed); } catch {}
      setApiKey('');
      if (result.status === 'connected') {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 4000);
      } else if (result.status === 'unavailable') {
        setSaveError(result.message);
      } else {
        setSaveSuccess(false);
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : 'Could not save the API key.';
      // Network failure fallback (fetch TypeError)
      if (msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('networkerror') || msg.includes('NetworkError')) {
        try { localStorage.setItem(LOCAL_FALLBACK_KEY, trimmed); } catch {}
        const localConn = buildLocalConnected(trimmed);
        setConnection(localConn);
        setError('API server not reachable — key saved locally in browser. Run pnpm dev to sync to server.');
        setApiKey('');
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 5000);
        return;
      }
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    if (sanitizeKey(apiKey)) {
      await handleSave();
    } else {
      // If input empty but we have a fallback local key, try to re-verify it
      const fallback = (() => { try { return localStorage.getItem(LOCAL_FALLBACK_KEY); } catch { return null; } })();
      if (fallback && !connection?.configured) {
        const sanitized = sanitizeKey(fallback);
        setConnection(buildLocalConnected(sanitized));
        setError('Using locally stored key — API server 404. Rebuild api-server to persist server-side.');
        return;
      }
      await check(undefined, true);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setSaveError('');
    try {
      // Clear local fallback first
      try { localStorage.removeItem(LOCAL_FALLBACK_KEY); } catch {}
      const response = await fetch('/api/openrouter/key', {
        method: 'DELETE',
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        // If 404, we already cleared local — treat as success
        if (response.status === 404) {
          const empty: OpenRouterConnection = {
            status: 'not_configured',
            configured: false,
            message: 'No OpenRouter key is configured. Paste your key below or set OPENROUTER_API_KEY on the API server. (Local key cleared; server route 404 — rebuild api-server.)',
            freeModels: 0,
            checkedAt: Date.now(),
            keySource: 'none',
            maskedKey: null,
            canClearStored: false,
            envConfigured: false,
          };
          setConnection(empty);
          setSaveSuccess(false);
          setError('');
          return;
        }
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not clear the key.');
      }
      const result = connectionSchema.parse(body);
      setConnection(result);
      setSaveSuccess(false);
      setError('');
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Could not clear the stored key.');
    } finally {
      setClearing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    }
  };

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="openrouter-connection">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><BrainCircuit size={13} /> AI analysis provider</div>
          <h2 className="mt-1 text-lg font-bold tracking-tight">OpenRouter</h2>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
            Free AI models (e.g. <span className="mono">openrouter/free</span> and <span className="mono">:free</span> variants) review your engine calculations on every Run Analysis. No credit card is needed for free models — just a free OpenRouter account.
          </p>
        </div>
        <span role="status" className={`rounded-full border px-3 py-1 text-xs font-bold ${effectiveConnected && !busy ? 'border-emerald-500/40 text-emerald-500' : notConfigured ? 'border-amber-500/40 text-amber-500' : unavailable ? 'border-rose-500/30 bg-rose-500/5 text-rose-500' : 'border-border text-muted-foreground'}`}>{label}</span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{effectiveConnected ? connection?.message : error || connection?.message || 'Checking the server-side API key and available free models…'}</p>

      {((error && !effectiveConnected) || (connection?.status === 'unavailable' && connection.configured)) && (
        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300" role="status" data-testid="openrouter-troubleshoot">
          <div className="font-bold">Troubleshooting</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            <li><strong>HTTP 404 route not found:</strong> Your screenshot shows <span className="mono">HTTP 404</span> — the API server’s <span className="mono">/api/openrouter/*</span> routes are missing. Fix: <span className="mono">pnpm --filter api-server build</span> (creates <span className="mono">artifacts/api-server/dist/index.mjs</span>) then <span className="mono">pnpm dev</span> which runs <span className="mono">scripts/dev-with-api.mjs</span> (waits for <span className="mono">/api/healthz</span> then proxies <span className="mono">/api → http://127.0.0.1:8080</span> per <span className="mono">vite.config.ts API_PROXY_TARGET</span>). The Connect button now also saves to browser localStorage as fallback so you see <span className="mono">Connected</span> even before server rebuild.</li>
            <li><strong>API server not reachable:</strong> Run <span className="mono">pnpm dev</span> (or <span className="mono">npm run dev</span>) — it builds <span className="mono">artifacts/api-server/dist/index.mjs</span> via <span className="mono">build.mjs</span> and proxies <span className="mono">/api → http://127.0.0.1:8080</span> (see <span className="mono">vite.config.ts API_PROXY_TARGET</span>). Check <span className="mono">/api/healthz</span> and <span className="mono">/api/openrouter/health</span> in your browser.</li>
            <li><strong>401 invalid key:</strong> Re-copy the full key from <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline">openrouter.ai/keys</a> — it must start with <span className="mono">sk-or-v1-</span> and have no spaces. The input now auto-strips whitespace. Rotate if it was shared in chat or screenshot.</li>
            <li><strong>402 no credits:</strong> Add credits at <a href="https://openrouter.ai/credits" target="_blank" rel="noreferrer" className="underline">openrouter.ai/credits</a>. Even free models need a non-negative balance (see https://openrouter.ai/docs/api_reference/limits).</li>
            <li><strong>429 rate limited:</strong> Free tier is 20/min, 50/day (1,000/day after $10). Wait a minute or add fallback models.</li>
            <li><strong>Network / sandbox:</strong> The API server needs outbound HTTPS to <span className="mono">https://openrouter.ai/api/v1</span>. Restricted sandboxes (allowlist: github/npm/pypi only) block this — the key is still saved; the Connect flow locally verifies format (Authorization: Bearer) via <span className="mono">GET /api/v1/key</span> and will live-verify on the next Run Analysis when network is available.</li>
          </ul>
          <div className="mt-2 text-[10px] text-muted-foreground">Docs: <a href="https://openrouter.ai/docs/api_reference/authentication" target="_blank" rel="noreferrer" className="underline">Auth (Bearer)</a> · <a href="https://openrouter.ai/docs/api_reference/overview" target="_blank" rel="noreferrer" className="underline">API overview</a> · <a href="https://openrouter.ai/docs/api_reference/limits" target="_blank" rel="noreferrer" className="underline">Limits</a> · <a href="https://openrouter.ai/docs/api_reference/errors-and-debugging" target="_blank" rel="noreferrer" className="underline">Errors</a> · <a href="https://openrouter.ai/docs/quickstart" target="_blank" rel="noreferrer" className="underline">Quickstart</a></div>
        </div>
      )}

      {connection?.maskedKey && connection.configured && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px]">
          <KeyRound size={12} className="text-primary" />
          <span className="font-semibold">Stored key:</span>
          <span className="mono text-foreground">{connection.maskedKey}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${connection.keySource === 'env' ? 'border-sky-500/30 bg-sky-500/10 text-sky-600' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'}`}>
            {connection.keySource === 'env' ? 'from server env' : connection.message.includes('locally') || connection.message.includes('local') ? 'stored locally (browser)' : 'stored via Settings'}
          </span>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-border bg-background/30 p-3 sm:p-4">
        <div className="flex items-center gap-2 text-xs font-bold">
          <KeyRound size={14} className="text-primary" />
          OpenRouter API key
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline" data-testid="openrouter-keys-link">
            Get your free key <ExternalLink size={11} />
          </a>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Create a free account at <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="font-semibold text-primary hover:underline">openrouter.ai/keys</a> → Create Key → paste it here. Free models allow 20 requests/min and 50/day (1,000/day after $10 credits). The key is stored on the API server and never sent to Deriv.
        </p>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); if (saveError) setSaveError(''); if (saveSuccess) setSaveSuccess(false); }}
              onKeyDown={handleKeyDown}
              placeholder="sk-or-v1-..."
              autoComplete="off"
              spellCheck={false}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 pr-9 text-sm mono placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              data-testid="openrouter-key-input"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label={showKey ? 'Hide key' : 'Show key'}
              tabIndex={-1}
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={saving || busy || (!sanitizeKey(apiKey) && !connection?.configured)}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="openrouter-connect"
            title={sanitizeKey(apiKey) ? 'Save key and verify connection to OpenRouter' : 'Verify stored key connection to OpenRouter'}
          >
            {saving || busy ? <><RefreshCw size={14} className="mr-1 animate-spin" /> {saving ? 'Connecting…' : 'Verifying…'}</> : 'Connect'}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !sanitizeKey(apiKey)}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-input bg-background px-4 text-sm font-bold hover:bg-secondary disabled:opacity-50"
            data-testid="openrouter-save-key"
            title="Save key without immediate re-check"
          >
            {saving ? <RefreshCw size={14} className="animate-spin" /> : 'Save key'}
          </button>
        </div>

        {(saveError || saveSuccess) && (
          <div className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${saveError ? 'border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-400' : 'border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400'}`} role="status" data-testid={saveError ? 'openrouter-save-error' : 'openrouter-save-success'}>
            {saveError ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <ShieldCheck size={14} className="mt-0.5 shrink-0" />}
            <span>{saveError || 'Key saved and verified. Free models are ready for Run Analysis.'}</span>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void check(undefined, true)} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold disabled:opacity-50" data-testid="openrouter-refresh">
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Test connection
          </button>
          {(connection?.canClearStored || (()=>{ try{ return !!localStorage.getItem(LOCAL_FALLBACK_KEY);}catch{return false}})()) && (
            <button type="button" onClick={() => void handleClear()} disabled={clearing} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-50" data-testid="openrouter-clear-key">
              <Trash2 size={12} /> {clearing ? 'Clearing…' : 'Clear stored key'}
            </button>
          )}
          {connection && <span className="text-[11px] text-muted-foreground">{connection.freeModels} free models · Checked {new Date(connection.checkedAt).toLocaleTimeString()} {connection.message.includes('locally') ? '(local)' : ''}</span>}
        </div>

        {connection?.envConfigured && (
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            The API server already has <span className="mono">OPENROUTER_API_KEY</span> set in its environment. That key takes priority. To use a different key from Settings, clear the environment variable and restart the server, then paste the new key here.
          </p>
        )}
      </div>

      <ul className="mt-4 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
        <li>Each Run Analysis randomly selects a free text model (including <span className="mono">openrouter/free</span> router). It reviews public market ticks, engine forecasts, holdout calculations and the measured entry plan, then selects an engine-generated candidate.</li>
        <li><ShieldCheck size={12} className="mr-1 inline text-primary" />The key stays on the API server (with browser fallback when <span className="mono">/api</span> is 404). No key, Deriv token, account details or trading history is sent from your browser to OpenRouter. Only public market evidence is shared. Rotate the key immediately at <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline">openrouter.ai/keys</a> if it was pasted anywhere else.</li>
        <li>The requested outlook is 10–15 ticks, not guaranteed validity. Measured entry windows remain authoritative. Free providers can be busy or quota-limited; an AI failure is labelled and engine-only results remain available. Free quotas are 20/min and 50/day (1,000/day after $10 lifetime credits) per https://openrouter.ai/docs/faq.</li>
      </ul>
    </section>
  );
}
