// Dashboard sections F–H of the AI Digit Bot panel, plus the engine-status and
// performance ledgers. Nothing here merges live and analysis results.
import {
  Activity,
  AlertTriangle,
  ClipboardList,
  Cpu,
  FileClock,
  LineChart,
  Lock,
  ScrollText,
  Wallet,
} from 'lucide-react';
import type { MonitoredContract } from '@/lib/digit-bot/types';
import { CONTRACT_LABELS } from '@/lib/digit-bot/types';
import type { PerformanceMetrics } from '@/lib/digit-bot/performance';
import type { DigitBotController } from '@/hooks/use-digit-bot';
import { Panel, ReasonList, StatTile, formatClock, formatMoney, formatPercent, formatSignedMoney } from '@/components/premium-bot/bot-panels';

/** SECTION F — account and risk. */
export function BotAccountRiskPanel({ bot }: { bot: DigitBotController }) {
  const account = bot.account;
  const risk = bot.risk;
  const currency = account.currency || bot.accountCurrency;
  const sessionLossUsed = account.sessionPnl < 0 ? Math.abs(account.sessionPnl) : 0;
  const dailyLossUsed = account.dailyPnl < 0 ? Math.abs(account.dailyPnl) : 0;
  return (
    <Panel
      eyebrow="Account and risk"
      title="Authoritative balance and configured limits"
      icon={<Wallet size={16} />}
      testId="bot-account-risk"
      aside={
        <span className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${bot.accountType === 'real' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-background/60 text-muted-foreground'}`}>
          {bot.accountType === 'real' ? 'Real account' : bot.accountType === 'demo' ? 'Demo account' : 'No account'}
        </span>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Deriv balance" value={formatMoney(account.currentBalance, currency)} hint={account.lastReconciledAt ? `Reconciled ${formatClock(account.lastReconciledAt)}` : 'Not yet reconciled with Deriv'} tone={account.balanceDiscrepancy ? 'bad' : 'default'} testId="bot-balance" />
        <StatTile label="Session P/L" value={formatSignedMoney(account.sessionPnl, currency)} hint={`Session started ${account.sessionStartedAt ? formatClock(account.sessionStartedAt) : '—'}`} tone={account.sessionPnl > 0 ? 'good' : account.sessionPnl < 0 ? 'bad' : 'default'} />
        <StatTile label="Realised daily P/L" value={formatSignedMoney(account.dailyPnl, currency)} hint={`Day ${account.dayKey ?? '—'}`} tone={account.dailyPnl > 0 ? 'good' : account.dailyPnl < 0 ? 'bad' : 'default'} />
        <StatTile label="Open-contract exposure" value={formatMoney(account.openExposure, currency)} hint={`${bot.contracts.filter((contract) => !contract.isSold).length} open live contract(s)`} />
        <StatTile label="Stake" value={formatMoney(risk?.stake ?? null, currency)} hint={bot.riskConfig.stakeMode === 'fixed' ? 'Fixed stake — never increased after a loss' : `${bot.riskConfig.percentOfBalance}% of balance, capped`} />
        <StatTile label="Daily loss limit" value={formatMoney(bot.riskConfig.maxDailyLoss, currency)} hint={`Used ${formatMoney(dailyLossUsed, currency)}`} tone={dailyLossUsed >= bot.riskConfig.maxDailyLoss ? 'bad' : 'default'} />
        <StatTile label="Session loss limit" value={formatMoney(bot.riskConfig.maxSessionLoss, currency)} hint={`Used ${formatMoney(sessionLossUsed, currency)}`} />
        <StatTile label="Consecutive losses" value={`${account.consecutiveLosses} / ${bot.riskConfig.maxConsecutiveLosses}`} hint={`Longest streak ${account.longestLosingStreak}`} tone={account.consecutiveLosses >= bot.riskConfig.maxConsecutiveLosses ? 'bad' : 'default'} />
        <StatTile label="Trades today" value={`${account.tradesToday} / ${bot.riskConfig.maxDailyTrades}`} />
        <StatTile label="Entries remaining" value={`${bot.entriesRemaining} / ${bot.riskConfig.maxEntriesPerSession}`} hint="Session allowance" />
        <StatTile label="Max drawdown" value={formatMoney(account.maxDrawdown, currency)} hint="Peak-to-trough of realised equity" />
        <StatTile
          label="Session time left"
          value={bot.sessionMinutesRemaining === null ? '—' : `${bot.sessionMinutesRemaining.toFixed(0)} min`}
          hint={`Limit ${bot.riskConfig.maxSessionMinutes} min`}
        />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-background/35 p-3">
          <div className="flex items-center gap-2 text-xs font-bold"><Lock size={13} className="text-primary" /> What stops a purchase</div>
          {risk && !risk.allowed ? <div className="mt-2"><ReasonList reasons={risk.violations} tone="warn" /></div> : <p className="mt-2 text-[11px] text-muted-foreground">No risk limit is currently blocking a purchase. The maximum possible loss of the next stake is {formatMoney(risk?.maxPossibleLoss ?? null, currency)}.</p>}
          {risk?.notes.length ? <div className="mt-2"><ReasonList reasons={risk.notes} /></div> : null}
        </div>
        <div className="rounded-lg border border-border bg-background/35 p-3">
          <div className="flex items-center gap-2 text-xs font-bold"><AlertTriangle size={13} className="text-primary" /> Stake policy</div>
          <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
            <li>Fixed stake by default; optional conservative percentage-of-balance mode.</li>
            <li>No martingale, no doubling after a loss, no recovery cycles, no leverage.</li>
            <li>The stake is capped at {bot.riskConfig.maxStakeShareOfBalance}% of the live balance and between {formatMoney(bot.riskConfig.minStake, currency)} and {formatMoney(bot.riskConfig.maxStake, currency)}.</li>
            <li>Trading stops automatically if account information is unavailable or the local ledger disagrees with Deriv.</li>
          </ul>
        </div>
      </div>
    </Panel>
  );
}

/** SECTION G — live trade monitor. */
export function BotTradeMonitor({ bot }: { bot: DigitBotController }) {
  const contracts = bot.contracts;
  return (
    <Panel
      eyebrow="Live trade monitor"
      title="Contracts purchased and monitored until Deriv settles them"
      icon={<Activity size={16} />}
      testId="bot-trade-monitor"
      aside={<span className="mono text-[10px] text-muted-foreground">{bot.outcomes.length} purchase outcome(s) this session</span>}
    >
      {!contracts.length ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          No contract has been purchased yet. Live entries appear here the moment Deriv confirms them and stay until settlement.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border" role="region" aria-label="Live trade monitor table">
          <table className="w-full min-w-[820px] border-collapse text-[10px]">
            <thead>
              <tr className="bg-background/60">
                {['Contract id', 'Type', 'Barrier', 'Purchase price', 'Entry time', 'Status', 'Final digit', 'Result', 'Realised P/L'].map((heading) => (
                  <th key={heading} scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contracts.map((contract: MonitoredContract) => {
                const settled = contract.settledProfit !== null;
                return (
                  <tr key={contract.contractId} data-testid={`bot-contract-${contract.contractId}`}>
                    <td className="mono border-b border-border px-2 py-1.5">{contract.contractId}</td>
                    <td className="border-b border-border px-2 py-1.5">{contract.contractType ? CONTRACT_LABELS[contract.contractType as keyof typeof CONTRACT_LABELS] ?? contract.contractType : '—'}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{contract.barrierDigit ?? '—'}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{formatMoney(contract.stake, bot.account.currency || bot.accountCurrency)}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{contract.purchaseTime ? formatClock(contract.purchaseTime * 1_000) : '—'}</td>
                    <td className="border-b border-border px-2 py-1.5 text-muted-foreground">{contract.status ?? '—'}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{contract.exitDigit ?? '—'}</td>
                    <td className="border-b border-border px-2 py-1.5">
                      {!settled ? <span className="text-muted-foreground">open — nothing is realised until Deriv settles</span> : contract.settledProfit! > 0 ? <span className="text-emerald-600 dark:text-emerald-400">won</span> : <span className="text-destructive">lost</span>}
                    </td>
                    <td className={`mono border-b border-border px-2 py-1.5 ${contract.settledProfit === null ? 'text-muted-foreground' : contract.settledProfit > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
                      {settled ? formatSignedMoney(contract.settledProfit, contract.currency ?? '') : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {bot.outcomes.length ? (
        <div className="mt-3 space-y-1.5">
          {bot.outcomes.slice(0, 5).map((outcome) => (
            <div key={`${outcome.decisionId}-${outcome.at}`} className={`rounded-lg border px-3 py-2 text-[10px] leading-relaxed ${outcome.status === 'confirmed' ? 'border-emerald-500/25 bg-emerald-500/5' : outcome.status === 'unreconciled' || outcome.status === 'timeout' ? 'border-amber-500/30 bg-amber-500/5' : 'border-border bg-background/40'}`}>
              <span className="mono font-semibold uppercase">{outcome.status}</span>
              <span className="mono ml-2 text-muted-foreground">{formatClock(outcome.at)}</span>
              <div className="text-muted-foreground">{outcome.message}</div>
            </div>
          ))}
        </div>
      ) : null}
      {bot.safety.autoPauseReasons.some((reason) => reason.startsWith('A purchase request')) ? (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          A purchase request may have reached Deriv without a receipt. The bot reconciled the account and will not send another order until the position is confirmed.
        </div>
      ) : null}
    </Panel>
  );
}

/** SECTION H — decision log. */
export function BotDecisionLog({ bot }: { bot: DigitBotController }) {
  return (
    <Panel
      eyebrow="Decision log"
      title="Every cycle, including the ones that did not trade"
      icon={<ScrollText size={16} />}
      testId="bot-decision-log"
      aside={<span className="mono text-[10px] text-muted-foreground">{bot.cycleLog.length} entr{bot.cycleLog.length === 1 ? 'y' : 'ies'} · {bot.cycleRunning ? 'cycle running' : bot.lastCycleAt ? `last ${formatClock(bot.lastCycleAt)}` : 'idle'}</span>}
    >
      {!bot.cycleLog.length ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">No decision has been recorded yet. Cycle entries appear here with the reasons the bot traded or refused to.</p>
      ) : (
        <ul className="space-y-2">
          {bot.cycleLog.map((entry) => (
            <li key={entry.decisionId} className="rounded-lg border border-border bg-background/40 p-3" data-testid={`bot-log-${entry.decisionId}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`mono rounded-full border px-2 py-0.5 text-[9px] font-bold ${entry.action === 'TRADE' ? 'border-primary/40 bg-primary/10 text-primary' : entry.action === 'BLOCKED' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
                  {entry.action}
                </span>
                <span className="mono text-[10px] text-muted-foreground">{formatClock(entry.cycleAt)}</span>
                <span className="text-[10px] font-semibold">{entry.mode} mode</span>
                {entry.executed ? <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">ORDER SENT</span> : null}
                <span className="mono ml-auto text-[9px] text-muted-foreground">{entry.durationMs} ms</span>
              </div>
              <div className="mt-1.5 text-[11px] font-semibold">{entry.contract ?? 'No qualifying contract'}</div>
              <div className="mono mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                <span>p {formatPercent(entry.probability)}</span>
                <span>break-even {formatPercent(entry.breakEvenProbability)}</span>
                <span>EV {formatSignedMoney(entry.expectedValue, bot.account.currency || bot.accountCurrency)}</span>
                <span>stake {formatMoney(entry.stake, bot.account.currency || bot.accountCurrency)}</span>
              </div>
              <div className="mt-2"><ReasonList reasons={entry.reasons} limit={4} /></div>
              <div className="mt-2 flex flex-wrap gap-1">
                {entry.reasonCodes.slice(0, 8).map((code) => (
                  <code key={code} className="mono rounded border border-border bg-background/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">{code}</code>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function MetricsGrid({ metrics, currency, label }: { metrics: PerformanceMetrics; currency: string; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/35 p-3">
      <div className="text-xs font-bold">{label}</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Scored predictions" value={metrics.resolved} hint={`${metrics.sample} recorded`} />
        <StatTile label="Traded" value={metrics.traded} hint={metrics.winRate === null ? 'No settled trades' : `Win rate ${formatPercent(metrics.winRate, 1)}`} />
        <StatTile label="Net P/L" value={formatSignedMoney(metrics.netProfit, currency)} tone={metrics.netProfit > 0 ? 'good' : metrics.netProfit < 0 ? 'bad' : 'default'} />
        <StatTile label="Return on stake" value={metrics.returnOnStake === null ? '—' : formatPercent(metrics.returnOnStake, 2)} hint={`Stakes ${formatMoney(metrics.grossStake, currency)}`} />
        <StatTile label="Average win" value={formatMoney(metrics.averageWin, currency)} />
        <StatTile label="Average loss" value={formatMoney(metrics.averageLoss, currency)} />
        <StatTile label="Max drawdown" value={formatMoney(metrics.maximumDrawdown, currency)} />
        <StatTile label="Longest losing streak" value={metrics.longestLosingStreak} />
        <StatTile label="Brier score" value={metrics.brier === null ? '—' : metrics.brier.toFixed(4)} hint="Mean squared error of the win forecast" />
        <StatTile label="Log loss" value={metrics.logLoss === null ? '—' : metrics.logLoss.toFixed(4)} />
        <StatTile label="Calibration error" value={metrics.calibrationError === null ? '—' : metrics.calibrationError.toFixed(4)} hint="Expected calibration error across deciles" />
        <StatTile label="Skill vs baseline" value={metrics.skill === null ? '—' : metrics.skill.toFixed(4)} hint="Brier improvement over always predicting the base rate" tone={(metrics.skill ?? 0) > 0 ? 'good' : 'default'} />
      </div>
    </div>
  );
}

/** Performance and learning (specification section 17) plus engine status. */
export function BotPerformancePanel({ bot }: { bot: DigitBotController }) {
  const currency = bot.account.currency || bot.accountCurrency;
  const groups = (keyOf: (record: (typeof bot.records)[number]) => string) => {
    const map = new Map<string, typeof bot.records>();
    for (const record of bot.records) map.set(keyOf(record), [...(map.get(keyOf(record)) ?? []), record]);
    return [...map.entries()].slice(0, 6);
  };
  return (
    <Panel
      eyebrow="Performance and learning"
      title="Measured results, kept separate per operating mode"
      icon={<LineChart size={16} />}
      testId="bot-performance"
      aside={
        bot.hasMixedDatasets
          ? <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">Datasets kept separate — never merged</span>
          : <span className="mono text-[10px] text-muted-foreground">{bot.records.length} prediction(s) recorded</span>
      }
    >
      <div className="space-y-3">
        <MetricsGrid metrics={bot.metrics} currency={currency} label="Live trading (real Deriv purchases on the connected account)" />
        <MetricsGrid metrics={bot.analysisMetrics} currency={currency} label="Analysis only (predictions scored, never traded)" />

        {bot.walkForward ? (
          <div className="rounded-lg border border-border bg-background/35 p-3 text-[10px] leading-relaxed text-muted-foreground">
            <div className="flex items-center gap-2 text-xs font-bold text-foreground"><FileClock size={13} /> Chronological (walk-forward) comparison</div>
            <p className="mt-1">{bot.walkForward.note}</p>
            <div className="mono mt-2 grid gap-1 sm:grid-cols-2">
              <span>first half · Brier {bot.walkForward.firstHalf.brier === null ? '—' : bot.walkForward.firstHalf.brier.toFixed(4)} · net {formatSignedMoney(bot.walkForward.firstHalf.netProfit, currency)}</span>
              <span>second half · Brier {bot.walkForward.secondHalf.brier === null ? '—' : bot.walkForward.secondHalf.brier.toFixed(4)} · net {formatSignedMoney(bot.walkForward.secondHalf.netProfit, currency)}</span>
            </div>
          </div>
        ) : null}

        {bot.records.length ? (
          <div className="grid gap-3 lg:grid-cols-3">
            {[{ label: 'By symbol', key: (record: (typeof bot.records)[number]) => record.symbol },
              { label: 'By contract family', key: (record: (typeof bot.records)[number]) => record.family },
              { label: 'By contract', key: (record: (typeof bot.records)[number]) => `${record.contractType}${record.barrier === null ? '' : ` ${record.barrier}`}` }].map(({ label, key }) => (
              <div key={label} className="rounded-lg border border-border bg-background/35 p-3">
                <div className="text-xs font-bold">{label}</div>
                <ul className="mt-2 space-y-1 text-[10px] text-muted-foreground">
                  {groups(key).map(([name, rows]) => (
                    <li key={name} className="mono flex justify-between gap-2">
                      <span>{name}</span>
                      <span>n={rows.length} · win {formatPercent(rows.filter((row) => row.won === true).length / Math.max(1, rows.filter((row) => row.resolved).length), 0)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex items-start gap-2 rounded-lg border border-border bg-background/30 px-3 py-2.5 text-[10px] leading-relaxed text-muted-foreground">
          <ClipboardList size={14} className="mt-0.5 shrink-0 text-primary" />
          <span>
            Predictions that never traded are still scored against the digit that actually appeared, so calibration and Brier scores reflect the model rather than only the trades it took. Passing software tests is not evidence of profitability, and no result on this panel implies the edge will persist.
          </span>
        </div>
      </div>
    </Panel>
  );
}

/** Engine status: what each of the fourteen engines last reported. */
export function BotEnginePanel({ bot }: { bot: DigitBotController }) {
  const engines = bot.decision?.engines ?? [];
  return (
    <Panel eyebrow="Engine status" title="The fourteen coordinated engines" icon={<Cpu size={16} />} testId="bot-engines">
      {!engines.length ? (
        <p className="text-[11px] text-muted-foreground">Engine output appears after the first decision cycle.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {engines.map((finding) => (
            <div key={finding.engine} className="rounded-lg border border-border bg-background/35 p-3" data-testid={`bot-engine-${finding.engine}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold">{finding.engine} · {finding.name}</span>
                <span className={`mono rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase ${finding.status === 'ok' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : finding.status === 'degraded' ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>
                  {finding.status}
                </span>
              </div>
              <div className="mono mt-1 text-[10px] text-muted-foreground">data quality {formatPercent(finding.dataQuality, 0)}{finding.confidence === null ? '' : ` · confidence ${formatPercent(finding.confidence, 0)}`}</div>
              <div className="mt-2"><ReasonList reasons={finding.reasons} limit={2} /></div>
            </div>
          ))}
        </div>
      )}
      {bot.decision?.models.length ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border" role="region" aria-label="Model evidence table">
          <table className="w-full min-w-[760px] border-collapse text-[9px]">
            <thead>
              <tr className="bg-background/60">
                {['Model', 'Family', 'Status', 'Tuning sample', 'Tuning Brier', 'Holdout sample', 'Holdout Brier', 'Skill vs baseline', 'Calibration error', 'Ensemble weight'].map((heading) => (
                  <th key={heading} scope="col" className="border-b border-border px-2 py-1.5 text-left uppercase tracking-wider text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bot.decision.models.map((model) => (
                <tr key={model.key} data-testid={`bot-model-${model.key}`}>
                  <td className="mono border-b border-border px-2 py-1.5 font-semibold">{model.key} · {model.label}</td>
                  <td className="border-b border-border px-2 py-1.5 text-muted-foreground">{model.kind}</td>
                  <td className="border-b border-border px-2 py-1.5">
                    <span className={`mono rounded-full border px-1.5 py-0.5 ${model.status === 'contributing' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-border bg-background/60 text-muted-foreground'}`}>{model.status}</span>
                  </td>
                  <td className="mono border-b border-border px-2 py-1.5">{model.tuningSample}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{model.tuningBrier === null ? '—' : model.tuningBrier.toFixed(4)}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{model.validationSample}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{model.validationBrier === null ? '—' : model.validationBrier.toFixed(4)}</td>
                  <td className={`mono border-b border-border px-2 py-1.5 ${(model.skill ?? 0) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>{model.skill === null ? '—' : model.skill.toFixed(4)}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{model.validationCalibrationError === null ? '—' : model.validationCalibrationError.toFixed(4)}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{formatPercent(model.weight, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
