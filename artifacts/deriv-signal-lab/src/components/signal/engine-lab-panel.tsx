import { useMemo, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Download, FlaskConical, Search, ShieldCheck, ShieldAlert } from 'lucide-react';
import { ENGINE_CATALOG, ENGINE_CATEGORIES, ENGINE_SOURCES } from '@/lib/engine-lab/catalog';
import type { EngineDefinition, EngineLabReport, EngineReading, EngineStatus } from '@/lib/engine-lab/types';

const STATUS: Record<EngineStatus, { label: string; color: string }> = {
  active: { label: 'Measured', color: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  context: { label: 'Context only', color: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  insufficient: { label: 'Needs more data', color: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  unavailable: { label: 'Unavailable', color: 'border-border bg-secondary/50 text-muted-foreground' },
  alias: { label: 'Shared / alias', color: 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300' },
};
const number = (value: number | null, places = 4) => value === null || !Number.isFinite(value) ? '—' : Math.abs(value) > 100_000 || Math.abs(value) > 0 && Math.abs(value) < 0.0001 ? value.toExponential(2) : Number(value.toFixed(places)).toString();
const percent = (value: number | null) => value === null ? '—' : `${(100 * value).toFixed(1)}%`;
const PAGE_SIZE = 15;

function ReadingRow({ engine, reading }: { engine: EngineDefinition; reading?: EngineReading }) {
  const status = reading ? STATUS[reading.status] : null;
  return (
    <details className="group rounded-lg border border-border bg-background/30" data-testid={`engine-${engine.id}`}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="mono w-8 text-[10px] text-muted-foreground">{String(engine.id).padStart(3, '0')}</span>
        <span className="min-w-0 flex-1 text-xs font-semibold">{engine.name}</span>
        <span className="mono max-w-48 truncate text-right text-[11px] text-foreground" title={String(reading?.value ?? 'Not measured')}>{reading ? typeof reading.value === 'number' ? number(reading.value) : reading.value ?? '—' : 'Not run'}</span>
        <span className={`rounded border px-2 py-0.5 text-[9px] font-semibold ${status?.color ?? 'border-border text-muted-foreground'}`}>{status?.label ?? 'Registered'}</span>
        <ChevronRight size={13} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="space-y-3 border-t border-border px-4 py-3 text-[11px] leading-relaxed">
        <div className="flex flex-wrap gap-2 text-[9px] uppercase tracking-wide text-muted-foreground"><span>{engine.category}</span><span>·</span><span>{engine.role}</span><span>·</span><span>{engine.domain}</span>{reading && <><span>·</span><span>n = {reading.sample.toLocaleString()}</span></>}</div>
        <div><span className="font-bold text-foreground">How it works. </span><span className="text-muted-foreground">{engine.method}</span></div>
        <div><span className="font-bold text-foreground">This result. </span><span className="text-muted-foreground">{reading?.detail ?? 'Run Analysis to evaluate this engine on the selected market, contract and expiry. Missing data will be shown explicitly, not replaced with a made-up score.'}</span></div>
        {reading?.data && <details className="rounded border border-border p-2"><summary className="cursor-pointer text-[10px] font-semibold text-primary">Inspect values / matrix</summary><pre className="mono mt-2 max-h-64 overflow-auto whitespace-pre text-[10px] text-muted-foreground">{JSON.stringify(reading.data, (_key, value) => typeof value === 'number' ? Number(value.toPrecision(7)) : value, 2)}</pre></details>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><BookOpen size={12} className="text-muted-foreground" />{engine.sources.map((key) => { const source = ENGINE_SOURCES[key]; return <span key={key} className="text-[10px] text-muted-foreground"><a href={source.url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2" aria-label={source.title}>[{source.citation}]</a> {source.title}</span>; })}</div>
      </div>
    </details>
  );
}

function downloadReport(report: EngineLabReport) {
  const blob = new Blob([JSON.stringify({ ...report, definitions: ENGINE_CATALOG, sources: ENGINE_SOURCES }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `signal-lab-${report.family}-${report.symbol.replace(/[^a-z0-9_-]/gi, '')}-${report.asOfEpoch ?? 'snapshot'}.json`;
  document.body.append(link); link.click(); link.remove();
  // Give the browser time to begin reading the blob before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One shared inspector on all four tools; one snapshot per selected market. */
export function EngineLabPanel({ report }: { report?: EngineLabReport | null }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const readings = useMemo(() => new Map(report?.readings.map((reading) => [reading.id, reading]) ?? []), [report]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase().replace(/^#/, '');
    return ENGINE_CATALOG.filter((engine) => (category === 'all' || engine.category === category)
      && (status === 'all' || readings.get(engine.id)?.status === status)
      && (!query || String(engine.id) === query || `${engine.name} ${engine.method} ${engine.category}`.toLowerCase().includes(query)));
  }, [search, category, status, readings]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const audit = report?.research;
  const eligible = report?.decision.eligible ?? false;
  return (
    <section className="min-w-0 scroll-mt-24 overflow-hidden rounded-xl border border-card-border bg-card/90 panel-glow" data-testid="engine-lab-panel">
      <div className="border-b border-border bg-primary/[0.035] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary"><FlaskConical size={19} /></div>
            <div><div className="eyebrow">Research library · 17 groups</div><h3 className="mt-1 text-base font-extrabold tracking-tight">300 engines. Every result explained.</h3><p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">Measurements, forecasts, validation and execution rules—not 300 independent votes. Open any engine for its formula, live-snapshot reading, sample and sources.</p></div>
          </div>
          {report && <button type="button" onClick={() => downloadReport(report)} className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-3 py-2 text-[10px] font-semibold hover:bg-secondary" data-testid="export-engine-audit"><Download size={13} /> Export audit</button>}
        </div>
        {report ? <>
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Engine coverage">
            {(Object.entries(STATUS) as Array<[EngineStatus, typeof STATUS[EngineStatus]]>).map(([key, item]) => <button type="button" key={key} onClick={() => { setStatus(status === key ? 'all' : key); setPage(0); }} aria-pressed={status === key} className={`rounded-md border px-2.5 py-1.5 text-[10px] ${item.color} ${status === key ? 'ring-2 ring-primary/50' : ''}`}><strong className="mono mr-1.5">{report.counts[key]}</strong>{item.label}</button>)}
          </div>
          <div className={`mt-4 flex gap-2.5 rounded-lg border p-3 ${eligible ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-amber-500/25 bg-amber-500/5'}`} data-testid="research-decision">
            {eligible ? <ShieldCheck size={17} className="mt-0.5 shrink-0 text-emerald-500" /> : <ShieldAlert size={17} className="mt-0.5 shrink-0 text-amber-500" />}
            <div><div className="text-xs font-bold">{eligible ? 'Evidence-qualified candidate · Load and Run can trade it' : 'Research advice · Load and Run still trades this signal'}</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{report.decision.reasons.join(' ')}</p><p className="mt-1 text-[10px] text-muted-foreground">Advice only: the gates below never hide the ranked signal and never disable automatic execution. A favourable estimated probability is not a guarantee of profit.</p></div>
          </div>
          {report.fusion && report.fusion.total > 0 && (
            <div className="mt-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[10px] leading-relaxed" data-testid="research-fusion">
              <span className="font-bold text-foreground">Folded into the signal: </span>
              {report.fusion.weight > 0
                ? `${Math.round(report.fusion.weight * 100)}% of the traded edge came from this ensemble (${report.fusion.contributionPts >= 0 ? '+' : ''}${report.fusion.contributionPts.toFixed(2)} probability points).`
                : 'this ensemble was checked and left the traded estimate unchanged.'}{' '}
              {report.fusion.agreeing}/{report.fusion.total} models favour the outcome ·{' '}
              {report.fusion.validated
                ? `validated on ${report.fusion.sample} independent holdout rows, so it can raise or lower the estimate`
                : 'not independently validated, so it can only lower the estimate'}
            </div>
          )}
          {report.accounting && report.accounting.sample > 0 && <p className="mt-3 text-[10px] text-muted-foreground">P&amp;L snapshot: {report.accounting.sample} loaded settlements · {report.accounting.currency ?? 'currency not specified'} · account active at scan time. Rerun after switching accounts.</p>}
          <div className="mt-3 text-[10px] text-muted-foreground">{report.symbol} · {report.horizon.value} {report.horizon.unit} · snapshot {report.asOfEpoch ? new Date(report.asOfEpoch * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—'} · {report.sample.digits.toLocaleString()} digits / {report.sample.quotes.toLocaleString()} quotes / {report.sample.candles} closed 1m candles</div>
        </> : <div className="mt-4 rounded-lg border border-dashed border-border p-3 text-[11px] text-muted-foreground">Browse the complete library now. Run Analysis to evaluate all entries, reveal data gaps and inspect the evidence behind a specific contract.</div>}
      </div>
      {audit && <div className="border-b border-border p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="eyebrow">Independent research forecast · {audit.models.length} models</div><span className={`text-[10px] font-semibold ${audit.validated ? 'text-emerald-500' : 'text-amber-500'}`}>{audit.validated ? 'Validation passed' : 'Not independently validated · cannot boost signal'}</span></div>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            ['Tune / calibrate / test', `${audit.tuningSample} / ${audit.calibrationSample} / ${audit.sample}`, 'Chronological, purged, non-overlapping'],
            ['Research estimate', percent(audit.probability), 'Experimental P(selected outcome)'],
            ['Holdout Brier', `${number(audit.brier)} / ${number(audit.baselineBrier)}`, 'Model / no-edge baseline · lower is better'],
            ['Brier skill', percent(audit.skill), 'Positive means better than baseline'],
            ['Corrected loss-test p', number(audit.correctedP), 'Candidate + model search penalty'],
          ].map(([label, value, hint]) => <div key={label} className="rounded-lg border border-border bg-background/30 p-2.5"><div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div><div className="mono mt-1 text-sm font-bold">{value}</div><div className="mt-1 text-[9px] leading-relaxed text-muted-foreground">{hint}</div></div>)}
        </div>
        <details className="mt-3 rounded-lg border border-border bg-background/25 p-3">
          <summary className="cursor-pointer text-[11px] font-semibold">Model weights, contribution and held-out performance</summary>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Weights are learned on the older tuning slice and frozen. Calibration uses the middle slice. Final test results never select a model. Contributions explain the raw research estimate; they are not extra votes added to the main signal.</p>
          <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[600px] text-left text-[10px]"><thead className="text-muted-foreground"><tr>{['Model / family', 'Weight', 'P(outcome)', 'Tune Brier', 'Test Brier', 'Contribution'].map((heading) => <th key={heading} className="border-b border-border px-2 py-2 font-medium">{heading}</th>)}</tr></thead><tbody>{audit.models.map((model) => <tr key={model.id} className="border-b border-border/50 last:border-0"><td className="px-2 py-2 font-semibold">{model.name}<div className="text-[9px] font-normal text-muted-foreground">{model.family}</div></td><td className="mono px-2">{percent(model.weight)}</td><td className="mono px-2">{percent(model.probability)}</td><td className="mono px-2">{number(model.tuningBrier)}</td><td className="mono px-2">{number(model.holdoutBrier)}</td><td className={`mono px-2 ${model.contribution < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{model.contribution > 0 ? '+' : ''}{model.contribution.toFixed(3)} pp</td></tr>)}</tbody></table></div>
          <p className="mt-2 text-[10px] text-muted-foreground">{audit.redundantPairs.length} highly correlated model pairs detected. Frequency variants share one family budget; aliases have no vote.</p>
        </details>
      </div>}
      <div className="p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(180px,1fr)_auto_auto]">
          <label className="relative"><span className="sr-only">Search engines by name, number or method</span><Search size={14} className="pointer-events-none absolute left-3 top-3 text-muted-foreground" /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Search engines, methods or #ID…" className="h-10 w-full rounded-lg border border-border bg-background/60 pl-9 pr-3 text-xs outline-none focus:border-primary" data-testid="engine-search" /></label>
          <label><span className="sr-only">Engine group</span><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(0); }} className="h-10 w-full rounded-lg border border-border bg-background/60 px-3 text-xs outline-none focus:border-primary" data-testid="engine-category"><option value="all">All 17 groups</option>{ENGINE_CATEGORIES.map((group) => <option key={group.name} value={group.name}>{group.name} · {group.last - group.first + 1}</option>)}</select></label>
          <label><span className="sr-only">Engine status</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }} disabled={!report} className="h-10 w-full rounded-lg border border-border bg-background/60 px-3 text-xs outline-none focus:border-primary disabled:opacity-50" data-testid="engine-status"><option value="all">All statuses</option>{Object.entries(STATUS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
        </div>
        <div className="my-3 flex items-center justify-between gap-2 text-[10px] text-muted-foreground"><span>{filtered.length} of 300 entries · open a row to inspect</span><span>{currentPage + 1} / {pages}</span></div>
        <div className="space-y-2">{filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((engine) => <ReadingRow key={`${report?.symbol}-${report?.asOfEpoch}-${engine.id}`} engine={engine} reading={readings.get(engine.id)} />)}</div>
        {!filtered.length && <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">No engines match these filters. Try a different name, number or group.</div>}
        <div className="mt-3 flex items-center justify-between"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="focus-ring inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-[10px] disabled:opacity-35"><ChevronLeft size={13} /> Previous</button><button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)} className="focus-ring inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-[10px] disabled:opacity-35">Next <ChevronRight size={13} /></button></div>
        {report && <details className="mt-4 border-t border-border pt-3"><summary className="cursor-pointer text-[10px] font-semibold text-muted-foreground">Limitations and interpretation</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-muted-foreground">{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
      </div>
    </section>
  );
}
