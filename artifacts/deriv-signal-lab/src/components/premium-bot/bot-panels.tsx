// Dashboard sections B–E of the AI Digit Bot panel, plus the small display
// primitives they share. Every figure rendered here comes from the engine
// findings — nothing is estimated for display.
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Binary,
  Gauge,
  Grid3x3,
  Hash,
  Layers,
  Radio,
  ShieldQuestion,
  Target,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type {
  CandidateRecord,
  DataQualityFinding,
  DigitIntelligenceFindings,
  EnsembleFinding,
  ModelEvidence,
} from '@/lib/digit-bot/types';
import { CONTRACT_LABELS } from '@/lib/digit-bot/types';
import { assessExpectedValue, evConfidenceFromReturn, EV_BAND_LABELS, formatEvConfidence } from '@/lib/ev-confidence';
import type { DigitBotController } from '@/hooks/use-digit-bot';

export function formatPercent(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
}

export function formatPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const points = value * 100;
  return `${points > 0 ? '+' : ''}${points.toFixed(2)} pp`;
}

export function formatMoney(value: number | null | undefined, currency = '', digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}${currency ? ` ${currency}` : ''}`;
}

export function formatSignedMoney(value: number | null | undefined, currency = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${formatMoney(value, currency)}`;
}

export function formatClock(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) return '—';
  return new Date(epochMs).toLocaleTimeString();
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  testId,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  testId?: string;
}) {
  const toneClass = tone === 'good'
    ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'bad'
        ? 'text-destructive'
        : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2" data-testid={testId}>
      <div className="eyebrow">{label}</div>
      <div className={`mono mt-1 text-sm font-semibold ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Panel({ title, eyebrow, icon, children, aside, testId }: {
  title: string;
  eyebrow: string;
  icon: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  testId?: string;
}) {
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-primary">{icon}</span>
          <div>
            <div className="eyebrow">{eyebrow}</div>
            <h3 className="mt-1 text-sm font-bold tracking-tight">{title}</h3>
          </div>
        </div>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ReasonList({ reasons, tone = 'muted', limit }: { reasons: readonly string[]; tone?: 'muted' | 'warn'; limit?: number }) {
  const rows = limit ? reasons.slice(0, limit) : reasons;
  if (!rows.length) return <p className="text-[11px] text-muted-foreground">No reasons recorded.</p>;
  return (
    <ul className="space-y-1">
      {rows.map((reason, index) => (
        <li key={`${index}-${reason.slice(0, 24)}`} className={`flex gap-2 text-[11px] leading-relaxed ${tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
          <span aria-hidden className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-current" />
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

function StreamHealthBadge({ feedFresh, feedStatus, connected }: { feedFresh: boolean; feedStatus: string; connected: boolean }) {
  const tone = feedFresh && connected
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    : feedStatus === 'error' || feedStatus === 'reconnecting'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return (
    <span className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold ${tone}`} data-testid="bot-stream-health" aria-live="polite">
      {feedFresh && connected ? <Wifi size={13} /> : <WifiOff size={13} />}
      {feedFresh && connected ? 'Live ticks · trading socket open' : connected ? 'Trading socket open · tick feed not fresh' : 'Trading socket not open'}
    </span>
  );
}

/** SECTION B — live market status. */
export function BotMarketStatus({ bot }: { bot: DigitBotController }) {
  const quality: DataQualityFinding | null = bot.dataQuality;
  const sourceAgeSeconds = quality?.sourceAgeMs === null || quality?.sourceAgeMs === undefined ? null : Math.abs(quality.sourceAgeMs) / 1_000;
  return (
    <Panel
      eyebrow="Live market status"
      title="Data the bot is acting on"
      icon={<Activity size={16} />}
      testId="bot-market-status"
      aside={<StreamHealthBadge feedFresh={quality?.fresh ?? false} feedStatus={bot.feedStatus} connected={bot.connected} />}
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Deriv connection"
          value={bot.connected ? 'Authenticated' : bot.connected === false ? 'Not connected' : '—'}
          hint={bot.accountType ? `${bot.accountType === 'demo' ? 'Demo' : 'Real'} account authorized` : 'No account authorized — trading is blocked'}
          tone={bot.connected ? 'good' : 'warn'}
          testId="bot-connection-state"
        />
        <StatTile label="Symbol" value={bot.symbol || '—'} hint={bot.marketName || 'No active symbol metadata'} />
        <StatTile
          label="Current quote"
          value={bot.quote === null ? '—' : bot.quote.toFixed(bot.precision ?? 2)}
          hint={bot.precision === null ? 'Verified precision unavailable' : `${bot.precision} displayed decimal places`}
        />
        <StatTile label="Latest last digit" value={bot.lastDigit === null ? '—' : bot.lastDigit} hint="From the newest validated tick" />
        <StatTile
          label="Tick-stream health"
          value={quality ? quality.status : '—'}
          hint={quality ? `${quality.gapsDetected} interruption(s) · max gap ${quality.maxGapMs === null ? '—' : `${Math.round(quality.maxGapMs / 1_000)}s`}` : 'No assessment yet'}
          tone={quality?.fresh ? 'good' : quality ? 'warn' : 'default'}
          testId="bot-tick-health"
        />
        <StatTile label="Last tick" value={formatClock(quality?.lastTickAt ?? null)} hint={sourceAgeSeconds === null ? 'Source age unknown' : `Source age ${sourceAgeSeconds.toFixed(1)}s`} />
        <StatTile label="Valid ticks collected" value={bot.tickCount} hint={quality ? `${quality.duplicatesDropped} duplicate tick(s) ignored` : undefined} />
        <StatTile
          label="Effective sample"
          value={bot.decision ? Math.round(bot.records.length ? bot.decision.candidates[0]?.effectiveSample ?? 0 : 0) : 0}
          hint="Serial-dependence adjusted digits behind the estimates"
        />
      </div>
      {quality && !quality.fresh ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300" role="status">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {quality.precisionVerified
              ? 'The live tick stream is stale or interrupted. New trades stay disabled until genuine ticks resume; the bot never substitutes generated ticks.'
              : 'Decimal precision could not be verified for this symbol, so final digits are not trusted and no trade can be placed.'}
          </span>
        </div>
      ) : null}
    </Panel>
  );
}

/** SECTION C — AI analysis panel. */
export function BotAnalysisPanel({ bot, models, ensemble }: { bot: DigitBotController; models: ModelEvidence[]; ensemble: EnsembleFinding | null }) {
  const decision = bot.decision;
  const selected = decision?.selected ?? null;
  const contributing = models.filter((model) => model.status === 'contributing');
  // EV confidence of the selected contract, priced at the live Deriv payout.
  // Without a quoted payout there is no honest expectancy, so the tile stays '—'.
  const selectedEv = selected
    ? assessExpectedValue({
      probability: selected.estimatedProbability,
      conservativeProbability: selected.probabilityLowerBound,
      stake: selected.stake,
      payout: selected.payout,
    })
    : null;
  return (
    <Panel
      eyebrow="AI analysis"
      title="Current decision and its evidence"
      icon={<Gauge size={16} />}
      testId="bot-ai-analysis"
      aside={
        <span className="rounded-full border border-border bg-background/50 px-3 py-1 text-[10px] font-semibold text-muted-foreground" data-testid="bot-ai-source">
          {decision ? (decision.ai.source === 'external-model' ? 'External model + engines' : 'Statistical decision engine') : 'Waiting for a decision cycle'}
        </span>
      }
    >
      {!decision ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The bot has not completed a decision cycle yet. Press Start to begin analysing live ticks. Until then no contract is evaluated and no order is placed.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="signal-panel rounded-xl border border-card-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className={`text-2xl font-extrabold tracking-[-0.04em] ${decision.action === 'TRADE' ? 'text-primary' : decision.action === 'BLOCKED' ? 'text-destructive' : 'text-amber-500'}`} data-testid="bot-signal">
                {decision.action === 'TRADE' ? 'TRADE' : decision.action === 'BLOCKED' ? 'BLOCKED' : 'NO TRADE'}
              </div>
              <span className="mono text-[10px] text-muted-foreground">{decision.decisionId}</span>
            </div>
            <p className="mt-1 text-xs font-semibold">{decision.actionLabel}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Selected contract"
                value={selected ? `${CONTRACT_LABELS[selected.contractType]}${selected.barrier === null ? '' : ` ${selected.barrier}`}` : 'None'}
                hint={selected?.winningCondition ?? 'No candidate qualified'}
              />
              <StatTile
                label="Estimated win probability"
                value={formatPercent(selected?.estimatedProbability ?? null)}
                hint={selected ? `Interval ${formatPercent(selected.probabilityLowerBound)} – ${formatPercent(selected.probabilityUpperBound)}` : 'No estimate'}
              />
              <StatTile
                label="Break-even probability"
                value={formatPercent(selected?.breakEvenProbability ?? null)}
                hint={selected?.breakEvenProbability === null || selected === null ? 'Needs a live payout' : `${formatPoints((selected.estimatedProbability ?? 0) - selected.breakEvenProbability)} above break-even`}
                tone={selected && selected.breakEvenProbability !== null && selected.estimatedProbability > selected.breakEvenProbability ? 'good' : 'default'}
              />
              <StatTile
                label="Available payout"
                value={formatMoney(selected?.payout ?? null, bot.accountCurrency)}
                hint={selected?.stake === null || selected === null ? 'No proposal yet' : `Stake ${formatMoney(selected.stake, bot.accountCurrency)}`}
              />
              <StatTile
                label="Expected value"
                value={formatSignedMoney(selected?.expectedValue ?? null, bot.accountCurrency)}
                hint={selected?.conservativeExpectedValue === null || selected === null ? undefined : `Conservative ${formatSignedMoney(selected.conservativeExpectedValue, bot.accountCurrency)}`}
                tone={selected && (selected.conservativeExpectedValue ?? 0) > 0 ? 'good' : selected ? 'warn' : 'default'}
              />
              <StatTile
                label="EV confidence"
                value={selectedEv ? formatEvConfidence(selectedEv.confidence) : '—'}
                hint={selectedEv
                  ? `${EV_BAND_LABELS[selectedEv.band]} · conservative ${formatEvConfidence(selectedEv.pointConfidence)} · ${selectedEv.expectedValuePerStake >= 0 ? '+' : ''}${(selectedEv.expectedValuePerStake * 100).toFixed(1)}% per unit staked`
                  : 'Needs a live payout: no payout, no expected value'}
                tone={selectedEv ? (selectedEv.band === 'high' ? 'good' : selectedEv.band === 'low' ? 'warn' : 'default') : 'default'}
                testId="bot-ev-confidence"
              />
              <StatTile
                label="Probability uncertainty"
                value={formatPercent(selected?.uncertainty ?? null)}
                hint="Posterior spread combined with model disagreement"
              />
              <StatTile
                label="Model agreement"
                value={ensemble ? formatPercent(ensemble.agreement, 1) : '—'}
                hint={ensemble ? `${ensemble.supportingModels} contributing model(s)` : 'No ensemble yet'}
              />
              <StatTile
                label="Data quality"
                value={bot.dataQuality ? `${(bot.dataQuality.quality * 100).toFixed(0)}%` : '—'}
                hint={bot.dataQuality?.precisionVerified ? 'Precision verified' : 'Precision unverified'}
                tone={bot.dataQuality?.fresh ? 'good' : 'warn'}
              />
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-background/35 p-3">
              <div className="text-xs font-bold">Why this decision</div>
              <div className="mt-2"><ReasonList reasons={decision.reasons} /></div>
              <div className="mt-3 flex flex-wrap gap-1">
                {decision.reasonCodes.map((code) => (
                  <code key={code} className="mono rounded border border-border bg-background/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">{code}</code>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/35 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold">Walk-forward model validation</div>
                <span className={`mono text-[10px] ${ensemble?.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  {ensemble ? (ensemble.valid ? 'VALIDATED' : 'NOT VALIDATED') : 'NO REPORT'}
                </span>
              </div>
              {ensemble ? (
                <div className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  <div>Holdout Brier <span className="mono text-foreground">{ensemble.validationBrier === null ? '—' : ensemble.validationBrier.toFixed(4)}</span> vs rolling baseline <span className="mono text-foreground">{ensemble.baselineBrier === null ? '—' : ensemble.baselineBrier.toFixed(4)}</span></div>
                  <div>Improvement lower bound <span className="mono text-foreground">{ensemble.improvementLower === null ? '—' : ensemble.improvementLower.toFixed(5)}</span> — it must stay above zero to qualify.</div>
                  <div>Baseline shrinkage weight <span className="mono text-foreground">{formatPercent(ensemble.baselineWeight, 0)}</span>; horizon {ensemble.horizon} tick(s).</div>
                  {!ensemble.valid && ensemble.reason ? <div className="text-amber-600 dark:text-amber-400">{ensemble.reason}</div> : null}
                  <div className="pt-1">
                    {contributing.length
                      ? `Contributing models: ${contributing.map((model) => `${model.key} (${model.label}) weight ${formatPercent(model.weight, 0)}`).join('; ')}.`
                      : 'No model earned ensemble weight on the tuning segment, so the bot cannot claim a predictive edge.'}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Models are fitted once at least 200 validated ticks exist for this symbol.</p>
              )}
            </div>
          </div>

          {decision.ai.rejectedExternalReason ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              <ShieldQuestion size={14} className="mt-0.5 shrink-0" />
              <span>An external AI answer was rejected and the statistical decision was used instead: {decision.ai.rejectedExternalReason}</span>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** SECTION D — digit heatmap. */
export function BotDigitHeatmap({ bot }: { bot: DigitBotController }) {
  const digits: DigitIntelligenceFindings | null = bot.digits;
  const byWindow = (size: number) => digits?.windows.find((window) => window.window === size) ?? null;
  const short = byWindow(25);
  const medium = byWindow(100);
  const long = byWindow(1_000) ?? digits?.windows.at(-1) ?? null;
  const transitionRow = digits?.transitions.currentRow ?? null;
  const digitsList = Array.from({ length: 10 }, (_, digit) => digit);

  return (
    <Panel
      eyebrow="Digit heatmap"
      title="Digits 0–9 across short, medium and long windows"
      icon={<Grid3x3 size={16} />}
      testId="bot-digit-heatmap"
      aside={<span className="mono text-[10px] text-muted-foreground">N = {digits?.sampleSize ?? 0} validated digits</span>}
    >
      {!digits ? (
        <p className="text-[11px] text-muted-foreground">Waiting for validated ticks. Frequencies are only shown for genuine observed digits.</p>
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-border" role="region" aria-label="Digit frequency heatmap">
            <table className="w-full min-w-[620px] border-collapse text-[10px]">
              <thead>
                <tr className="bg-background/60">
                  <th scope="col" className="sticky left-0 z-10 border-b border-r border-border bg-card px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">Digit</th>
                  <th scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">25 ticks</th>
                  <th scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">100 ticks</th>
                  <th scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">Long window ({long?.window ?? 0})</th>
                  <th scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">vs 10% baseline</th>
                  <th scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">Uncertainty (±2 s.e.)</th>
                  <th scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">Last seen</th>
                  <th scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">Next-digit row</th>
                </tr>
              </thead>
              <tbody>
                {digitsList.map((digit) => {
                  const shortRate = short?.frequencies[digit] ?? null;
                  const mediumRate = medium?.frequencies[digit] ?? null;
                  const longRate = long?.frequencies[digit] ?? null;
                  const deviation = long?.baselineDeviation[digit] ?? 0;
                  const sample = long?.sample ?? 0;
                  const uncertainty = longRate === null || sample <= 0 ? null : 2 * Math.sqrt((longRate * (1 - longRate)) / sample);
                  const gap = long?.gapsSinceAppearance[digit] ?? null;
                  const transition = transitionRow ? transitionRow[digit] : null;
                  const intensity = longRate === null ? 0 : Math.min(0.55, 0.08 + longRate * 2.2);
                  return (
                    <tr key={digit} data-testid={`bot-heatmap-digit-${digit}`}>
                      <th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-card px-2 py-1.5 text-left">
                        <span className="mono text-xs font-bold">{digit}</span>
                      </th>
                      <td className="border-b border-border px-2 py-1.5" style={{ backgroundColor: `hsl(var(--primary) / ${shortRate === null ? 0 : Math.min(0.5, 0.06 + shortRate * 2)})` }}>
                        <span className="mono">{formatPercent(shortRate, 1)}</span>
                      </td>
                      <td className="border-b border-border px-2 py-1.5" style={{ backgroundColor: `hsl(var(--primary) / ${mediumRate === null ? 0 : Math.min(0.5, 0.06 + mediumRate * 2)})` }}>
                        <span className="mono">{formatPercent(mediumRate, 1)}</span>
                      </td>
                      <td className="border-b border-border px-2 py-1.5" style={{ backgroundColor: `hsl(var(--primary) / ${intensity})` }}>
                        <span className="mono">{formatPercent(longRate, 1)}</span>
                      </td>
                      <td className={`mono border-b border-border px-2 py-1.5 ${Math.abs(deviation) < 0.01 ? 'text-muted-foreground' : deviation > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                        {formatPoints(deviation)}
                      </td>
                      <td className="mono border-b border-border px-2 py-1.5 text-muted-foreground">{formatPercent(uncertainty, 1)}</td>
                      <td className="mono border-b border-border px-2 py-1.5 text-muted-foreground">{gap === null ? 'never' : `${gap} ticks ago`}</td>
                      <td className="mono border-b border-border px-2 py-1.5 text-muted-foreground">{transition === null ? '—' : formatPercent(transition, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Parity (all validated)" value={`Even ${digits.parityCounts[0]} · Odd ${digits.parityCounts[1]}`} />
            <StatTile label="Current runs" value={`Digit ${digits.streaks.currentDigitRun} · Parity ${digits.streaks.currentParityRun}`} hint={`Longest parity run ${digits.streaks.longestParityRun}`} />
            <StatTile
              label="Distribution test"
              value={digits.distribution.chiSquarePValue === null ? 'withheld' : `p = ${digits.distribution.chiSquarePValue.toFixed(4)}`}
              hint={digits.distribution.chiSquarePValue === null ? 'Fewer than 5 expected observations per digit' : `χ² = ${digits.distribution.chiSquare?.toFixed(2)} (df 9, critical ${digits.distribution.criticalValue})`}
              tone={digits.distribution.significantAt95 ? 'warn' : 'default'}
            />
            <StatTile label="Entropy" value={digits.entropyBits === null ? '—' : `${digits.entropyBits.toFixed(3)} bits`} hint={`Normalised ${digits.normalizedEntropy === null ? '—' : digits.normalizedEntropy.toFixed(3)} of 3.322 max`} />
          </div>

          <div className="rounded-lg border border-border bg-background/30 p-3 text-[10px] leading-relaxed text-muted-foreground">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground"><Binary size={13} /> Observed rows for the newest digit</div>
            <p className="mt-1">
              {digits.transitions.currentRowSample > 0
                ? `${digits.transitions.currentRowSample} historical transitions out of digit ${digits.lastDigit}; two-digit suffix support ${digits.transitions.pairSample}.`
                : 'No transition has yet been observed out of the newest digit, so no conditional row is shown.'}
            </p>
            <ReasonList reasons={digits.notes} />
          </div>
        </div>
      )}
    </Panel>
  );
}

/** SECTION E — candidate comparison table. */
export function BotCandidateTable({ bot }: { bot: DigitBotController }) {
  const rows = bot.candidates;
  const eligible = rows.filter((row) => row.eligible);
  return (
    <Panel
      eyebrow="Candidate comparison"
      title="Every evaluated contract, including rejected ones"
      icon={<Target size={16} />}
      testId="bot-candidate-table"
      aside={
        <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
          <span className="mono rounded border border-border bg-background/60 px-2 py-1">{rows.length} evaluated</span>
          <span className="mono rounded border border-border bg-background/60 px-2 py-1">{eligible.length} qualified</span>
          <span className="mono rounded border border-border bg-background/60 px-2 py-1">quotes: Deriv proposals only</span>
        </div>
      }
    >
      {!rows.length ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No candidate has been evaluated yet. The table fills in once a decision cycle runs and Deriv reports which digit contracts this symbol supports.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border" role="region" aria-label="Candidate comparison table">
          <table className="w-full min-w-[900px] border-collapse text-[10px]">
            <thead>
              <tr className="bg-background/60">
                {['Contract', 'Family', 'Barrier / target', 'Estimated probability', 'Break-even', 'Payout', 'Expected value', 'EV confidence', 'Qualification', 'Rejection reason'].map((heading) => (
                  <th key={heading} scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row: CandidateRecord) => (
                <tr key={row.id} className={row.eligible ? 'bg-primary/5' : ''} data-testid={`bot-candidate-${row.id}`}>
                  <td className="mono border-b border-border px-2 py-1.5 font-semibold">{CONTRACT_LABELS[row.contractType]}{row.barrier === null ? '' : ` ${row.barrier}`}</td>
                  <td className="border-b border-border px-2 py-1.5 text-muted-foreground">{row.family}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{row.barrier ?? '—'}</td>
                  <td className="mono border-b border-border px-2 py-1.5">
                    {formatPercent(row.estimatedProbability)}
                    <span className="ml-1 text-muted-foreground">± {formatPercent(row.uncertainty, 1)}</span>
                  </td>
                  <td className="mono border-b border-border px-2 py-1.5">{formatPercent(row.breakEvenProbability)}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{row.returnOnStake === null ? '—' : formatEvConfidence(evConfidenceFromReturn(row.returnOnStake))}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{formatMoney(row.payout, bot.accountCurrency)}</td>
                  <td className={`mono border-b border-border px-2 py-1.5 ${(row.conservativeExpectedValue ?? 0) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                    {formatSignedMoney(row.expectedValue, bot.accountCurrency)}
                    <span className="ml-1">{row.conservativeExpectedValue === null ? '' : `(${formatSignedMoney(row.conservativeExpectedValue, '')})`}</span>
                  </td>
                  <td className="border-b border-border px-2 py-1.5">
                    <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold ${row.eligible ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-border bg-background/60 text-muted-foreground'}`}>
                      {row.eligible ? 'QUALIFIED' : 'NOT ELIGIBLE'}
                    </span>
                  </td>
                  <td className="border-b border-border px-2 py-1.5 text-muted-foreground">
                    {row.eligible ? (row.reasonCodes.includes('EXPECTED_VALUE_POSITIVE') ? 'Passed every gate' : '—') : row.rejectionReasons[0] ?? '—'}
                    {!row.eligible && row.rejectionReasons.length > 1 ? <span className="ml-1 text-[9px]">(+{row.rejectionReasons.length - 1} more)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-[10px] text-muted-foreground">
        <span><ArrowLeftRight size={11} className="mr-1 inline" />Deriv reports which barriers and target digits exist for this symbol and tick expiry; that list is the authority, not this table.</span>
        <span><Hash size={11} className="mr-1 inline" />Over wins above its barrier, Under wins below it: a digit equal to the barrier loses both.</span>
        <span><BarChart3 size={11} className="mr-1 inline" />Highest win rate is not the ranking criterion — conservative expected value is.</span>
        <span><Layers size={11} className="mr-1 inline" />Barriers are never chosen because a digit appeared frequently.</span>
        <span><Radio size={11} className="mr-1 inline" />Payouts are the live Deriv proposals; a missing quote shows as “—”, never as an assumed payout.</span>
      </div>
    </Panel>
  );
}
