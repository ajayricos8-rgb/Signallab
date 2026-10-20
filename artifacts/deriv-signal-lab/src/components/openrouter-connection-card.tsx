import { useCallback, useEffect, useState } from 'react';
import { BrainCircuit, RefreshCw, ShieldCheck } from 'lucide-react';
import { connectionSchema, type OpenRouterConnection } from '@/lib/openrouter-analysis';

export function OpenRouterConnectionCard() {
  const [connection, setConnection] = useState<OpenRouterConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  const label = busy ? 'Verifying…' : connected ? 'Connected' : connection?.status === 'not_configured' ? 'Not configured' : 'Unavailable';

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="openrouter-connection">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><BrainCircuit size={13} /> AI analysis provider</div>
          <h2 className="mt-1 text-lg font-bold tracking-tight">OpenRouter</h2>
        </div>
        <span role="status" className={`rounded-full border px-3 py-1 text-xs font-bold ${connected && !busy ? 'border-emerald-500/40 text-emerald-500' : 'border-amber-500/40 text-amber-500'}`}>{label}</span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{error || connection?.message || 'Checking the server-side API key and available free models…'}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void check(undefined, true)} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold disabled:opacity-50" data-testid="openrouter-refresh">
          <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Test connection
        </button>
        {connection && <span className="text-[11px] text-muted-foreground">{connection.freeModels} free models · Checked {new Date(connection.checkedAt).toLocaleTimeString()}</span>}
      </div>
      <ul className="mt-4 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
        <li>Each Run Analysis randomly selects a free text model. It reviews public market ticks, engine forecasts, holdout calculations and the measured entry plan, then selects an engine-generated candidate.</li>
        <li><ShieldCheck size={12} className="mr-1 inline text-primary" />The key stays on the API server. No key, Deriv token, account details or trading history is sent from your browser to OpenRouter. Only public market evidence is shared.</li>
        <li>The requested outlook is 10–15 ticks, not guaranteed validity. Measured entry windows remain authoritative. Free providers can be busy or quota-limited; an AI failure is labelled and engine-only results remain available.</li>
      </ul>
    </section>
  );
}
