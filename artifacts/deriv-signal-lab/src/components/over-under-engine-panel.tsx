import { BrainCircuit, ChevronDown, Layers3, ShieldAlert } from 'lucide-react';
import { ENGINE_FAMILIES, type EngineFamily } from '@/lib/over-under/features';
import { contractProbability, type EngineEvidence, type OverUnderReport } from '@/lib/over-under/ensemble';
import type { SignalConsensus } from '@/lib/signal-confidence';
import { AnalysisProgress, type AnalysisProgressState } from '@/components/analysis-signal';

const rate = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
const fixed = (value: number | null | undefined, digits = 3) => value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const points = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`;
const metricClass = 'rounded-lg border border-border bg-background/35 px-3 py-2';

function Metric({ label, value }: { label: string; value: string }) {
  return <div className={metricClass}><div className="eyebrow">{label}</div><div className="mono mt-1 text-xs font-semibold">{value}</div></div>;
}

function EngineRow({ engine, report }: { engine: EngineEvidence; report: OverUnderReport }) {
  const candidate = report.signal?.candidate ?? report.selected ?? report.candidates[0];
  const probability = candidate && engine.probabilities ? contractProbability(engine.probabilities, candidate.contract) : null;
  return (
    <div className="rounded-lg border border-border/80 bg-background/30 p-3" data-testid={`over-under-engine-${engine.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-[11px] font-semibold">{engine.label}</h5>
        <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${engine.status === 'contributing' ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}>
          {engine.status === 'contributing' ? `${rate(engine.weight)} weight` : engine.status === 'sparse' ? 'Sparse · no vote' : 'No tuning edge · no vote'}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px]">
        <div><div className="text-muted-foreground">Model estimate</div><div className="mono mt-0.5 font-semibold">{rate(probability)}</div></div>
        <div><div className="text-muted-foreground">Tuning Brier skill</div><div className="mono mt-0.5">{rate(engine.tuningSkill)}</div></div>
        <div><div className="text-muted-foreground">Context / fit N</div><div className="mono mt-0.5">{engine.support}</div></div>
      </div>
      {engine.note && <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{engine.note}.</p>}
    </div>
  );
}

function FamilyDiagnostics({ family, report }: { family: EngineFamily; report: OverUnderReport }) {
  const diagnostics = report.diagnostics;
  const candidate = report.signal?.candidate ?? report.selected ?? report.candidates[0];
  const barrier = candidate?.contract.barrier ?? 4;
  if (family === 'markov') return (
    <div className="space-y-2 text-[10px]">
      <div className="text-muted-foreground">Fitted on the first {report.validation.trainSample} observations only. N-grams forecast exactly {report.horizon} ticks ahead.</div>
      <div className="grid grid-cols-2 gap-2">{diagnostics.ngrams.map((row) => <Metric key={row.order} label={`Order ${row.order} · ${row.context}`} value={`${row.support} historical matches`} />)}</div>
      {diagnostics.regimes.map((regime) => <div key={regime.state} className={metricClass}>Hidden state {regime.state + 1}: posterior <strong>{rate(regime.probability)}</strong> · digit mean {fixed(regime.mean, 2)} · variance {fixed(regime.variance, 2)} · persistence {rate(regime.persistence)}</div>)}
      <p className="text-muted-foreground">HMM: {diagnostics.hmmIterations} Baum–Welch iterations. States are learned statistical regimes, not verified market phases.</p>
    </div>
  );
  if (family === 'frequency') return (
    <div className="space-y-2 text-[10px]">
      {diagnostics.windows.map((window) => {
        const under = window.counts.slice(0, barrier).reduce((a, b) => a + b, 0);
        const over = window.counts.slice(barrier + 1).reduce((a, b) => a + b, 0);
        return <div key={window.window} className={metricClass}><div className="font-semibold">Last {window.window} ticks · n={window.sample}</div><div className="mt-1">Barrier {barrier}: under {under} · equal {window.counts[barrier]} · over {over}</div><div className="mono mt-1 text-muted-foreground">χ² {fixed(window.chiSquare, 2)} · df 9 · p {window.chiSquareP !== null && window.chiSquareP < 0.0001 ? '< 0.0001' : fixed(window.chiSquareP, 4)}</div></div>;
      })}
      <div className="grid grid-cols-5 gap-1">{diagnostics.windows[1].zScores.map((z, digit) => <div key={digit} className="rounded border border-border p-1.5 text-center"><div className="font-semibold">{digit}</div><div className="mono mt-1 text-muted-foreground">Z {fixed(z, 1)}</div></div>)}</div>
      <p className="text-muted-foreground">Nominal uniform-null tests assume independent ticks. Multiple digits/windows are inspected; a low count or negative Z-score does not make a digit “due”.</p>
    </div>
  );
  if (family === 'information') return (
    <div className="space-y-2 text-[10px]">
      {diagnostics.windows.map((window) => <div key={window.window} className={metricClass}><div className="font-semibold">{window.window}-tick information window</div><div className="mono mt-1">H {fixed(window.entropyBits)} / 3.322 bits · normalized {fixed(window.normalizedEntropy)}</div><div className="mono mt-1 text-muted-foreground">LZ78 {window.compression.phrases} phrases · coding ratio {fixed(window.compression.ratio, 2)}</div></div>)}
      <p className="text-muted-foreground">Lower coding ratios indicate repetitions; ratios above 1 mean no compression. This estimates compressibility, not exact Kolmogorov complexity. High marginal entropy alone does not prove independence.</p>
      <p className="text-muted-foreground">Information-based shrinkage reserves {rate(report.baselineWeight)} of the final distribution for the rolling-frequency baseline.</p>
    </div>
  );
  if (family === 'streaks') {
    const selected = diagnostics.streaks.find((row) => row.barrier === barrier)!;
    return <div className="space-y-2 text-[10px]"><div className={metricClass}><div className="font-semibold">Barrier {barrier} · current {selected.side} run × {selected.length}</div><div className="mono mt-1">Geometric tail {rate(selected.tailProbability)} · block probability {rate(selected.blockProbability)}</div><div className="mono mt-1">Z {fixed(selected.zScore, 2)} · independent continuation {rate(selected.independentContinuation)}</div><div className="mt-1 text-muted-foreground">Max over {selected.maxOver} / under {selected.maxUnder} · {selected.reversalAnomaly ? 'Rare-run anomaly flagged' : 'No rare-run anomaly'}</div></div><p className="text-muted-foreground">Equal-to-barrier ticks break Over/Under runs. Under independence, even a rare streak leaves continuation probability unchanged. An anomaly informs the research diagnostics, never an automatic reversal trade.</p></div>;
  }
  if (family === 'trend') return (
    <div className="space-y-2 text-[10px]"><div className="grid grid-cols-2 gap-2"><Metric label="Digit SMA 10 / 50" value={`${fixed(diagnostics.trend.sma10, 2)} / ${fixed(diagnostics.trend.sma50, 2)}`} /><Metric label="Digit EMA 12 / 26" value={`${fixed(diagnostics.trend.ema12, 2)} / ${fixed(diagnostics.trend.ema26, 2)}`} /><Metric label="MACD / signal" value={`${fixed(diagnostics.trend.macd)} / ${fixed(diagnostics.trend.signal)}`} /><Metric label="MACD histogram" value={fixed(diagnostics.trend.histogram)} /></div><p className="text-muted-foreground">SMA10 relative to barrier {barrier}: {fixed(diagnostics.trend.sma10 - barrier, 2)}. A fitted regression maps these causal features to the selected {report.horizon}-tick outcome. A moving average crossing alone is not a signal.</p></div>
  );
  if (family === 'patterns') return (
    <div className="space-y-2 text-[10px]">{diagnostics.patterns.map((pattern) => <div key={pattern.template} className={metricClass}><div className="font-semibold">{pattern.template}</div><div className="mt-1 text-muted-foreground">{pattern.support} training matches · {pattern.probabilities && candidate ? `${rate(contractProbability(pattern.probabilities, candidate.contract))} smoothed conditional estimate` : 'Too sparse to vote'}</div></div>)}<p className="text-muted-foreground">Exact 3–5 digit subsequences and fixed, bounded regex-style templates use only fully observed successors at this expiry. They are pooled as one correlated evidence family.</p></div>
  );
  if (family === 'time-series') return (
    <div className="space-y-2 text-[10px]"><div className={metricClass}><div className="font-semibold">Selected ARIMA({diagnostics.arima.p},{diagnostics.arima.d},1)</div><div className="mono mt-1">Training AIC {fixed(diagnostics.arima.aic, 1)} · innovation variance {fixed(diagnostics.arima.innovationVariance)}</div></div><div className={metricClass}><div className="font-semibold">GARCH(1,1) parameters</div><div className="mono mt-1">ω {fixed(diagnostics.garch.omega)} · α {fixed(diagnostics.garch.alpha)} · β {fixed(diagnostics.garch.beta)}</div><div className="mono mt-1">{report.horizon}-tick mean {fixed(diagnostics.garch.forecastMean, 2)} · variance {fixed(diagnostics.garch.forecastVariance, 2)}</div></div><p className="text-muted-foreground">Bounded ARIMA candidate search with conditional least squares; GARCH uses a stationary quasi-likelihood grid fit. Gaussian digit buckets are an approximation, subject to the same validation gates.</p></div>
  );
  return (
    <div className="space-y-2 text-[10px]"><div className={metricClass}><div className="font-semibold">LSTM · trained locally</div><div className="mt-1">{diagnostics.ml.lstm.samples} training sequences · {diagnostics.ml.lstm.epochs} epochs · {diagnostics.ml.lstm.parameters} parameters</div><div className="mono mt-1 text-muted-foreground">Training log loss {fixed(diagnostics.ml.lstm.initialLoss)} → {fixed(diagnostics.ml.lstm.finalLoss)}</div></div><div className={metricClass}><div className="font-semibold">Gradient boosting · trained locally</div><div className="mt-1">{diagnostics.ml.boosting.samples} rows · {diagnostics.ml.boosting.features} features · {diagnostics.ml.boosting.rounds} rounds · depth {diagnostics.ml.boosting.depth}</div><div className="mono mt-1 text-muted-foreground">Training log loss {fixed(diagnostics.ml.boosting.initialLoss)} → {fixed(diagnostics.ml.boosting.finalLoss)}</div></div><p className="text-muted-foreground">A ten-digit classification head preserves equality losses when deriving each binary contract probability. Features include digit history, averages, entropy, compressibility, streaks and tick time deltas. Training loss is not held-out accuracy. These small implementations are not the XGBoost or LightGBM libraries.</p></div>
  );
}

export function OverUnderEnginePanel({ report, isScanning, inactiveReason, progress = null, consensus = null }: {
  report: OverUnderReport | null;
  isScanning: boolean;
  inactiveReason?: string;
  progress?: AnalysisProgressState | null;
  consensus?: SignalConsensus | null;
}) {
  const activeSelection = !inactiveReason && !isScanning && report?.selected;
  // The published signal is the report's own best-ranked barrier, so the panel
  // always has something concrete to explain instead of a bare WAIT.
  const reference = report?.signal?.candidate ?? report?.selected ?? report?.candidates[0];
  const label = reference ? `${reference.contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${reference.contract.barrier}` : null;
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="over-under-engine-panel" aria-busy={isScanning}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="eyebrow flex items-center gap-2"><BrainCircuit size={14} /> Unified Over/Under analysis</div><h3 className="mt-1 text-base font-bold">Eight engine families. One published signal, counted vote by vote.</h3><p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">All models evaluate the same market and tick expiry. Tuning performance sets family-balanced weights; a later held-out segment checks the combined forecast. Every scan publishes its best-ranked barrier with the engine agreement and confidence score — the gates only decide whether that signal is qualified or diagnostic. Weak engines remain visible but cannot inflate agreement.</p></div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-3 py-1.5 text-[10px] font-semibold text-primary"><Layers3 size={12} /> Barriers 1–8 only</span>
      </div>
      {isScanning && <AnalysisProgress progress={progress} label="Fitting twelve models across eight engine families" />}
      {report ? <>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5"><Metric label="Train / tune / held-out" value={`${report.validation.trainSample} ticks / ${report.validation.tuningSample} / ${report.validation.holdoutSample} outcomes`} /><Metric label="Held-out Brier · lower is better" value={`${fixed(report.validation.ensembleBrier, 4)} vs ${fixed(report.validation.baselineBrier, 4)} baseline`} /><Metric label="Held-out Brier skill" value={rate(report.validation.skill)} /><Metric label="Contributing / fitted models" value={`${report.engines.filter((engine) => engine.weight > 0).length} / ${report.engines.length}`} /><Metric label="Engines agreeing on the signal" value={consensus ? `${consensus.enginesAgreed} / ${consensus.enginesTotal}` : reference ? `${reference.votes.filter((vote) => vote.stance === 'support').length} / ${reference.votes.length}` : '—'} /></div>
        <div className="mt-3 rounded-lg border border-border bg-background/35 px-3 py-2.5 text-[11px] leading-relaxed" data-testid="over-under-consensus">
          <strong className={activeSelection ? 'text-primary' : 'text-amber-500'}>{activeSelection ? `Qualified research candidate: ${label}` : `Signal: ${label ?? 'No candidate'}${reference && !reference.eligible ? ' · best-ranked, gates not passed' : ''}`}</strong>
          {reference && <span className="text-muted-foreground"> · model estimate {rate(reference.probability)} · rolling baseline {rate(reference.baselineProbability)} · lift {points(reference.lift)} · {reference.supportingFamilies}/8 fitted families support · {rate(reference.agreement)} weighted agreement{consensus ? ` · ${consensus.confidencePercent}% confidence across ${consensus.enginesTotal} engines` : ''}.</span>}
        </div>
        {reference && !reference.eligible && reference.reasons.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground" data-testid="over-under-signal-gates">
            <strong className="text-amber-500">Why this signal is diagnostic rather than gate-qualified:</strong>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">{reference.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </div>
        )}
        {inactiveReason && <p role="status" className="mt-2 text-xs text-amber-500">{inactiveReason}</p>}
        <div className="mt-3 rounded-lg border border-border bg-background/35 p-3 text-[11px]" data-testid="over-under-market-structure">
          <div className="font-semibold">Current market structure: {report.diagnostics.structure.status === 'stable' ? 'No large distribution shift detected' : report.diagnostics.structure.status === 'shifted' ? 'Shift detected · barriers blocked' : 'Insufficient evidence'}</div>
          <div className="mono mt-1 text-muted-foreground">Frequency divergence {fixed(report.diagnostics.structure.marginalDivergence)} / {fixed(report.diagnostics.structure.marginalThreshold)} limit · transition divergence {fixed(report.diagnostics.structure.transitionDivergence)} / {fixed(report.diagnostics.structure.transitionThreshold)} limit</div>
          <p className="mt-1 text-muted-foreground">Compares {report.diagnostics.structure.referenceSample} fitted ticks with {report.diagnostics.structure.recentSample} recent ticks. Jensen–Shannon divergence includes both digit balance and sequence ordering. Fixed limits are conservative safety heuristics, not significance tests or proof of stability.</p>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Engine estimates below refer to {label ?? 'the leading diagnostic candidate'}. Weights exclude the {rate(report.baselineWeight)} baseline reserve. Outcomes are spaced {report.horizon} ticks apart; chronological validation is a local diagnostic, not a guarantee of independent samples or future performance.</p>
      </> : <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">{isScanning ? `Fitting local models and checking chronological outcomes in a background worker… ${progress ? `${progress.percent}% · ${progress.phase}` : ''}` : 'Run Analysis to fit all twelve models on real, verified ticks. No model probabilities are shown before a scan.'}</div>}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {ENGINE_FAMILIES.map((family, index) => <details key={family.id} className="group rounded-xl border border-border bg-background/20" data-testid={`over-under-family-${family.id}`}>
          <summary className="flex cursor-pointer list-none items-start gap-3 rounded-xl p-4 focus-visible:outline focus-visible:outline-primary">
            <span className="mono flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[10px] font-bold text-primary">0{index + 1}</span>
            <div className="min-w-0 flex-1"><h4 className="text-xs font-bold">{family.title}</h4><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{family.description}</p></div><ChevronDown size={14} className="mt-1 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t border-border p-4">{report ? <><div className="space-y-2">{report.engines.filter((engine) => engine.family === family.id).map((engine) => <EngineRow key={engine.id} engine={engine} report={report} />)}</div><FamilyDiagnostics family={family.id} report={report} /></> : <p className="text-xs text-muted-foreground">Awaiting a completed scan. The engine abstains if its sample or validation evidence is inadequate.</p>}</div>
        </details>)}
      </div>
      {report && <details className="mt-3 rounded-xl border border-border bg-background/20"><summary className="cursor-pointer p-4 text-xs font-semibold">Inspect the fitted 10 × 10 transition matrix</summary><div className="overflow-x-auto px-4 pb-4"><table className="w-full min-w-[580px] text-center text-[10px]"><caption className="pb-3 text-left text-muted-foreground">Rows = current digit, columns = next digit. Training-only smoothed probabilities; hover for observed counts. Multi-tick forecasts propagate this matrix {report.horizon} times.</caption><thead><tr><th scope="col" className="p-2">From / to</th>{Array.from({ length: 10 }, (_, digit) => <th scope="col" key={digit} className="p-2">{digit}</th>)}</tr></thead><tbody>{report.diagnostics.transitionMatrix.map((row, from) => <tr key={from} className="border-t border-border"><th scope="row" className="p-2">{from}</th>{row.map((probability, to) => <td key={to} className="mono p-2" title={`${report.diagnostics.transitionCounts[from][to]} observed transitions`} style={{ backgroundColor: `hsl(158 60% 40% / ${Math.min(0.45, probability * 0.7)})` }}>{rate(probability)}</td>)}</tr>)}</tbody></table></div></details>}
      <div className="mt-4 flex items-start gap-2 text-[10px] leading-relaxed text-muted-foreground"><ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-500" /><p>More engines cannot create an edge in an independent random stream. Models are correlated, estimates are not calibrated win probabilities, and searching barriers or repeatedly scanning adds selection risk. Barriers are ranked by baseline-relative, validation-aware evidence—not raw hit rate. No payout/expected-value or profitability claim is made; all trades still require your explicit confirmation.</p></div>
    </section>
  );
}
