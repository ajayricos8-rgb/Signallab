import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BrainCircuit, Eye, EyeOff, ExternalLink, KeyRound, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { connectionSchema, type OpenRouterConnection } from '@/lib/openrouter-analysis';

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
      if (!response.ok) throw new Error('API server could not verify the OpenRouter connection.');
      const result = connectionSchema.parse(await response.json());
      if (!signal?.aborted) setConnection(result);
    } catch {
      if (!signal?.aborted) { setConnection(null); setError('Connection could not be verified. Check that the API server is running and can reach OpenRouter.'); }
    } finally { if (!signal?.aborted) setBusy(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const timer = setInterval(() => { void check(controller.signal); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [check]);

  const connected = !error && connection?.status === 'connected';
  const notConfigured = connection?.status === 'not_configured';
  const unavailable = connection?.status === 'unavailable';
  const label = busy ? 'Verifying…' : connected ? 'Connected' : notConfigured ? 'Not configured' : unavailable ? 'Unavailable' : 'Checking…';

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setSaveError('Paste your OpenRouter API key first. It starts with sk-or-v1- and is found at openrouter.ai/keys.');
      return;
    }
    if (!trimmed.startsWith('sk-')) {
      setSaveError('OpenRouter keys start with sk-or-v1-. Copy the full key from https://openrouter.ai/keys.');
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
      if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not save the key.');
      const result = connectionSchema.parse(body);
      setConnection(result);
      setApiKey('');
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Could not save the API key.');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setSaveError('');
    try {
      const response = await fetch('/api/openrouter/key', {
        method: 'DELETE',
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not clear the key.');
      const result = connectionSchema.parse(body);
      setConnection(result);
      setSaveSuccess(false);
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
        <span role="status" className={`rounded-full border px-3 py-1 text-xs font-bold ${connected && !busy ? 'border-emerald-500/40 text-emerald-500' : notConfigured ? 'border-amber-500/40 text-amber-500' : unavailable ? 'border-rose-500/30 bg-rose-500/5 text-rose-500' : 'border-border text-muted-foreground'}`}>{label}</span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{error || connection?.message || 'Checking the server-side API key and available free models…'}</p>

      {connection?.status === 'unavailable' && connection.configured && (
        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300" role="status" data-testid="openrouter-troubleshoot">
          <div className="font-bold">Troubleshooting</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            <li><strong>401 invalid key:</strong> Re-copy the full key from <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline">openrouter.ai/keys</a> — it must start with <span className="mono">sk-or-v1-</span>. Rotate if it was shared in chat.</li>
            <li><strong>402 no credits:</strong> Add credits at <a href="https://openrouter.ai/credits" target="_blank" rel="noreferrer" className="underline">openrouter.ai/credits</a>. Even free models need a non-negative balance.</li>
            <li><strong>429 rate limited:</strong> Free tier is 20/min, 50/day (1,000/day after $10). Wait a minute or add fallback models.</li>
            <li><strong>Network / sandbox:</strong> The API server needs outbound HTTPS to <span className="mono">https://openrouter.ai/api/v1</span>. Restricted sandboxes (allowlist: github/npm/pypi only) block this — the key is still saved and will verify when network is available. Check server logs and firewall/allowlist.</li>
          </ul>
          <div className="mt-2 text-[10px] text-muted-foreground">Docs: <a href="https://openrouter.ai/docs/api_reference/overview" target="_blank" rel="noreferrer" className="underline">API overview</a> · <a href="https://openrouter.ai/docs/api_reference/limits" target="_blank" rel="noreferrer" className="underline">Limits</a> · <a href="https://openrouter.ai/docs/api_reference/errors-and-debugging" target="_blank" rel="noreferrer" className="underline">Errors</a></div>
        </div>
      )}

      {connection?.maskedKey && connection.configured && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px]">
          <KeyRound size={12} className="text-primary" />
          <span className="font-semibold">Stored key:</span>
          <span className="mono text-foreground">{connection.maskedKey}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${connection.keySource === 'env' ? 'border-sky-500/30 bg-sky-500/10 text-sky-600' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'}`}>
            {connection.keySource === 'env' ? 'from server env' : 'stored via Settings'}
          </span>
        </div>
      )}

      {/* API Key input */}
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
            onClick={() => void handleSave()}
            disabled={saving || !apiKey.trim()}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="openrouter-save-key"
          >
            {saving ? <><RefreshCw size={14} className="mr-2 animate-spin" /> Saving…</> : 'Save key'}
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
          {connection?.canClearStored && (
            <button type="button" onClick={() => void handleClear()} disabled={clearing} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-50" data-testid="openrouter-clear-key">
              <Trash2 size={12} /> {clearing ? 'Clearing…' : 'Clear stored key'}
            </button>
          )}
          {connection && <span className="text-[11px] text-muted-foreground">{connection.freeModels} free models · Checked {new Date(connection.checkedAt).toLocaleTimeString()}</span>}
        </div>

        {connection?.envConfigured && (
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            The API server already has <span className="mono">OPENROUTER_API_KEY</span> set in its environment. That key takes priority. To use a different key from Settings, clear the environment variable and restart the server, then paste the new key here.
          </p>
        )}
      </div>

      <ul className="mt-4 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
        <li>Each Run Analysis randomly selects a free text model (including <span className="mono">openrouter/free</span> router). It reviews public market ticks, engine forecasts, holdout calculations and the measured entry plan, then selects an engine-generated candidate.</li>
        <li><ShieldCheck size={12} className="mr-1 inline text-primary" />The key stays on the API server. No key, Deriv token, account details or trading history is sent from your browser to OpenRouter. Only public market evidence is shared. Rotate the key immediately at <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline">openrouter.ai/keys</a> if it was pasted anywhere else.</li>
        <li>The requested outlook is 10–15 ticks, not guaranteed validity. Measured entry windows remain authoritative. Free providers can be busy or quota-limited; an AI failure is labelled and engine-only results remain available. Free quotas are 20/min and 50/day (1,000/day after $10 lifetime credits).</li>
      </ul>
    </section>
  );
}
