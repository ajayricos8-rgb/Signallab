// The Rise/Fall premium bot panel.
//
// Port of the reference "Deriv Rise/Fall AI Bot" script into this workspace:
// live ticks → feature engine → decision engine → risk manager → a real CALL or
// PUT purchase on the authorized Deriv account. Every figure rendered here comes
// from the engine modules in `lib/rise-fall-bot` or from Deriv itself — nothing
// is estimated for display, and an order is only ever sent in live mode.
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  CircleStop,
  Download,
  Gauge,
  LineChart,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Siren,
  SlidersHorizontal,
  Terminal,
  Trash2,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DerivConnectionCard, DerivConnectionStatusBadge } from '@/components/deriv-connection-card';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { useRiseFallBot, type RiseFallBotController } from '@/hooks/use-rise-fall-bot';
import {
  Panel,
  ReasonList,
  StatTile,
  formatClock,
  formatMoney,
  formatPercent,
  formatSignedMoney,
} from '@/components/premium-bot/bot-panels';
import { ConfigGroup, Field, NumberInput, SelectInput, ToggleField } from '@/components/premium-bot/bot-form';
import { TRADE_LOG_FILENAME } from '@/lib/rise-fall-bot/performance';
import {
  RISE_FALL_LABELS,
  RISE_FALL_RULE_LABELS,
  RISE_FALL_STAKE_MODES,
  type RiseFallBotMode,
  type RiseFallDirection,
} from '@/lib/rise-fall-bot/types';

const MINIMIZED_KEY = 'signal-lab-rise-fall-bot-minimized';

const MODE_DETAILS: Array<{ id: RiseFallBotMode; label: string; blurb: string; icon: typeof Terminal }> = [
  { id: 'analysis', label: 'Analysis only', blurb: 'Reads live ticks, names the direction and scores the signal afterwards. Never sends an order.', icon: Terminal },
  { id: 'live', label: 'Live trading', blurb: 'Buys real Rise/Fall contracts on the authorized Deriv demo or real account once every gate passes.', icon: TrendingUp },
];

const DURATION_UNITS = [
  { value: 't', label: 'Ticks' },
  { value: 's', label: 'Seconds' },
  { value: 'm', label: 'Minutes' },
];

function readMinimized(): boolean {
  try {
    return window.localStorage.getItem(MINIMIZED_KEY) === 'true';
  } catch {
    return false;
  }
}

function downloadTradeLog(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function directionBadge(direction: RiseFallDirection | null, size: 'sm' | 'lg' = 'sm') {
  if (!direction) return null;
  const Icon = direction === 'CALL' ? ArrowUpRight : ArrowDownRight;
  const tone = direction === 'CALL'
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    : 'border-destructive/40 bg-destructive/10 text-destructive';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border font-extrabold uppercase tracking-[0.06em] ${tone} ${size === 'lg' ? 'px-3 py-1.5 text-sm' : 'px-2 py-0.5 text-[10px]'}`}>
      <Icon size={size === 'lg' ? 16 : 12} />
      {RISE_FALL_LABELS[direction]}
    </span>
  );
}

/** Full operator configuration, collapsed by default while the bot runs. */
function BotConfiguration({ bot }: { bot: RiseFallBotController }) {
  const config = bot.config;
  const pipLabel = bot.pipSize === null ? 'pip size unverified for this symbol' : `1 pip = ${bot.pipSize} on ${bot.symbol || 'this symbol'}`;
  const expiryOptions = bot.supportedTickExpiries.map((ticks) => ({ value: String(ticks), label: `${ticks} tick${ticks === 1 ? '' : 's'} · Deriv-reported` }));
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4" data-testid="rise-fall-config">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Settings are stored in this browser only. They never include a token, an account id or a socket URL. {pipLabel}.
        </p>
        <Button variant="ghost" size="sm" onClick={bot.resetConfig} className="gap-2" data-testid="button-rise-fall-reset-config">
          <RefreshCw size={13} />Reset to defaults
        </Button>
      </div>

      <ConfigGroup title="Market and expiry" description="Deriv decides which expiries exist for this market; the dropdown only lists what it reported.">
        <Field label="Market" hint={bot.marketName || 'No active symbol metadata'}>
          <SelectInput
            value={bot.symbol}
            onChange={bot.selectSymbol}
            disabled={!bot.symbols.length}
            testId="rise-fall-symbol"
            options={bot.symbols.length
              ? bot.symbols.map((symbol) => ({ value: symbol.symbol, label: `${symbol.name} · ${symbol.symbol}` }))
              : [{ value: '', label: 'Loading Deriv active symbols…' }]}
          />
        </Field>
        <Field label="Expiry" hint={bot.contractSupportLoaded ? 'Only Deriv-reported tick expiries are listed.' : 'Waiting for Deriv contract metadata.'}>
          {config.durationUnit === 't' && expiryOptions.length ? (
            <SelectInput
              value={String(config.duration)}
              onChange={(value) => bot.updateConfig({ duration: Number(value) })}
              testId="rise-fall-duration"
              options={expiryOptions.some((option) => option.value === String(config.duration))
                ? expiryOptions
                : [...expiryOptions, { value: String(config.duration), label: `${config.duration} ticks · not reported by Deriv` }]}
            />
          ) : (
            <NumberInput value={config.duration} min={1} onChange={(value) => bot.updateConfig({ duration: value })} testId="rise-fall-duration" />
          )}
        </Field>
        <Field label="Expiry unit">
          <SelectInput value={config.durationUnit} onChange={(value) => bot.updateConfig({ durationUnit: value as 't' | 's' | 'm' })} testId="rise-fall-duration-unit" options={DURATION_UNITS} />
        </Field>
        <Field label="Watchdog interval (ms)" hint="Every new tick is evaluated immediately; this interval only re-checks a quiet feed.">
          <NumberInput value={config.decisionIntervalMs} step={250} min={500} onChange={(value) => bot.updateConfig({ decisionIntervalMs: value })} testId="rise-fall-cycle-interval" />
        </Field>
        <Field label="Maximum tick age (ms)" hint="Older quotes are treated as a stale feed, and stale feeds never trade.">
          <NumberInput value={config.maxTickAgeMs} step={1000} min={2000} onChange={(value) => bot.updateConfig({ maxTickAgeMs: value })} testId="rise-fall-max-tick-age" />
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Money management" description="Three stake models, all clamped to the minimum, maximum and balance share below.">
        <Field label="Stake model" hint={RISE_FALL_STAKE_MODES.find((mode) => mode.id === config.stakeMode)?.blurb}>
          <SelectInput
            value={config.stakeMode}
            onChange={(value) => bot.updateConfig({ stakeMode: value as 'fixed' | 'martingale' | 'percent' })}
            testId="rise-fall-stake-mode"
            options={RISE_FALL_STAKE_MODES.map((mode) => ({ value: mode.id, label: mode.label }))}
          />
        </Field>
        <Field label="Base stake" hint={bot.accountCurrency || 'Account currency unknown'}>
          <NumberInput value={config.baseStake} step={0.05} min={0.35} onChange={(value) => bot.updateConfig({ baseStake: value })} testId="rise-fall-base-stake" />
        </Field>
        <Field label="Minimum stake"><NumberInput value={config.minStake} step={0.05} min={0.35} onChange={(value) => bot.updateConfig({ minStake: value })} testId="rise-fall-min-stake" /></Field>
        <Field label="Maximum stake"><NumberInput value={config.maxStake} step={1} min={0.35} onChange={(value) => bot.updateConfig({ maxStake: value })} testId="rise-fall-max-stake" /></Field>
        <Field label="Stake as % of balance cap" hint="Hard ceiling applied to every model, including the martingale ladder.">
          <NumberInput value={config.maxStakeShareOfBalance} step={0.5} min={0.1} max={100} onChange={(value) => bot.updateConfig({ maxStakeShareOfBalance: value })} testId="rise-fall-balance-cap" />
        </Field>
        <Field label="Risk percentage of balance" hint="Used only by the percentage stake model.">
          <NumberInput value={config.riskPercent} step={0.1} min={0.1} max={25} disabled={config.stakeMode !== 'percent'} onChange={(value) => bot.updateConfig({ riskPercent: value })} testId="rise-fall-risk-percent" />
        </Field>
        <Field label="Martingale multiplier" hint="Used only by the martingale ladder.">
          <NumberInput value={config.martingaleMultiplier} step={0.1} min={1} max={5} disabled={config.stakeMode !== 'martingale'} onChange={(value) => bot.updateConfig({ martingaleMultiplier: value })} testId="rise-fall-martingale-multiplier" />
        </Field>
        <Field label="Maximum martingale steps" hint="Past this step the ladder is exhausted and the stake resets to base.">
          <NumberInput value={config.maxMartingaleSteps} min={0} max={10} disabled={config.stakeMode !== 'martingale'} onChange={(value) => bot.updateConfig({ maxMartingaleSteps: value })} testId="rise-fall-martingale-steps" />
        </Field>
      </ConfigGroup>

      {config.stakeMode === 'martingale' ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300" role="status" data-testid="rise-fall-martingale-warning">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            Martingale multiplies the stake after every loss. At {config.martingaleMultiplier}× and {config.maxMartingaleSteps} steps a losing run reaches
            {' '}{formatMoney(config.baseStake * config.martingaleMultiplier ** Math.min(config.maxMartingaleSteps, 10), bot.accountCurrency)} before it resets, and a
            losing streak can exhaust the balance before the ladder does. The consecutive-loss limit below is the only thing that stops it.
          </span>
        </div>
      ) : null}

      <ConfigGroup title="Risk limits" description="Each limit is checked before every purchase; the first one that fails blocks the order and says so.">
        <Field label="Maximum consecutive losses" hint="Consecutive-loss protection, as in the reference bot.">
          <NumberInput value={config.maxConsecutiveLosses} min={1} onChange={(value) => bot.updateConfig({ maxConsecutiveLosses: value })} testId="rise-fall-max-losses" />
        </Field>
        <Field label="Maximum daily loss" hint={bot.accountCurrency || 'Account currency unknown'}>
          <NumberInput value={config.maxDailyLoss} step={1} onChange={(value) => bot.updateConfig({ maxDailyLoss: value })} testId="rise-fall-daily-loss" />
        </Field>
        <Field label="Daily take profit" hint="Trading stops for the day once realised profit reaches this figure.">
          <NumberInput value={config.dailyTakeProfit} step={1} onChange={(value) => bot.updateConfig({ dailyTakeProfit: value })} testId="rise-fall-daily-target" />
        </Field>
        <Field label="Maximum trades this session" hint="0 means unlimited.">
          <NumberInput value={config.maxTrades} min={0} onChange={(value) => bot.updateConfig({ maxTrades: value })} testId="rise-fall-max-trades" />
        </Field>
        <Field label="Maximum open contracts" hint="1 keeps the bot strictly one position at a time.">
          <NumberInput value={config.maxOpenContracts} min={1} max={10} onChange={(value) => bot.updateConfig({ maxOpenContracts: value })} testId="rise-fall-max-open" />
        </Field>
        <Field label="Cooldown after settlement (ms)">
          <NumberInput value={config.cooldownMs} step={250} min={0} onChange={(value) => bot.updateConfig({ cooldownMs: value })} testId="rise-fall-cooldown" />
        </Field>
        <Field label="Maximum session length (minutes)" hint="0 means the session has no time limit.">
          <NumberInput value={config.maxSessionMinutes} min={0} onChange={(value) => bot.updateConfig({ maxSessionMinutes: value })} testId="rise-fall-session-minutes" />
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Signal engine" description="The feature window the decision rules read, expressed in verified pips so it means the same thing on every market.">
        <Field label="Tick window" hint="Lookback used for the up/down ratios and volatility.">
          <NumberInput value={config.tickWindow} min={10} max={500} onChange={(value) => bot.updateConfig({ tickWindow: value })} testId="rise-fall-tick-window" />
        </Field>
        <Field label="Minimum verified ticks" hint="Collected before the first entry is allowed.">
          <NumberInput value={config.minTicksBeforeTrade} min={5} onChange={(value) => bot.updateConfig({ minTicksBeforeTrade: value })} testId="rise-fall-min-ticks" />
        </Field>
        <Field label="Momentum window (ticks)" hint="Net move summed over this many recent ticks.">
          <NumberInput value={config.momentumTicks} min={2} onChange={(value) => bot.updateConfig({ momentumTicks: value })} testId="rise-fall-momentum-ticks" />
        </Field>
        <Field label="Volatility window (ticks)" hint="Mean absolute tick move over this many recent ticks.">
          <NumberInput value={config.volatilityTicks} min={2} onChange={(value) => bot.updateConfig({ volatilityTicks: value })} testId="rise-fall-volatility-ticks" />
        </Field>
        <Field label="Momentum edge (pips)" hint={pipLabel}>
          <NumberInput value={config.momentumThresholdPips} step={0.5} onChange={(value) => bot.updateConfig({ momentumThresholdPips: value })} testId="rise-fall-momentum-pips" />
        </Field>
        <Field label="Minimum volatility (pips)" hint="Quieter markets are skipped: a flat tape has no priced direction.">
          <NumberInput value={config.minVolatilityPips} step={0.5} onChange={(value) => bot.updateConfig({ minVolatilityPips: value })} testId="rise-fall-min-volatility" />
        </Field>
        <Field label="Strong-momentum ratio" hint="Share of window ticks that must agree with the momentum.">
          <NumberInput value={config.strongRatio} step={0.01} min={0.5} max={1} onChange={(value) => bot.updateConfig({ strongRatio: value })} testId="rise-fall-strong-ratio" />
        </Field>
        <Field label="Continuation ratio" hint="Share of window ticks required by the last-move continuation rule.">
          <NumberInput value={config.continuationRatio} step={0.01} min={0.5} max={1} onChange={(value) => bot.updateConfig({ continuationRatio: value })} testId="rise-fall-continuation-ratio" />
        </Field>
      </ConfigGroup>

      <div className="grid gap-3 lg:grid-cols-2">
        <ToggleField
          label="Adaptive momentum threshold"
          hint={`Scales the momentum edge with measured volatility instead of a fixed pip count, so one configuration behaves consistently across markets. Currently ${bot.features ? `${(Math.max(config.momentumThresholdPips, config.adaptiveThresholds ? config.adaptiveMultiple * Math.abs(bot.features.volatilityPips) : 0)).toFixed(2)} pips` : 'waiting for ticks'}.`}
          checked={config.adaptiveThresholds}
          onChange={(checked) => bot.updateConfig({ adaptiveThresholds: checked })}
          testId="rise-fall-adaptive"
        />
        <Field label="Adaptive multiple" hint="Multiple of the measured mean tick move required as an edge.">
          <NumberInput value={config.adaptiveMultiple} step={0.1} min={0} max={20} disabled={!config.adaptiveThresholds} onChange={(value) => bot.updateConfig({ adaptiveMultiple: value })} testId="rise-fall-adaptive-multiple" />
        </Field>
        <ToggleField
          label="Require positive expected value"
          hint="When the historical sample is large enough, the order is refused unless the live Deriv proposal gives an expected value at or above the minimum below. Thin samples are reported as withheld rather than assumed profitable."
          checked={config.requirePositiveExpectedValue}
          onChange={(checked) => bot.updateConfig({ requirePositiveExpectedValue: checked })}
          testId="rise-fall-require-ev"
        />
        <Field label="Minimum expected value per unit staked" hint="0 means the order must at least break even on the historical rate.">
          <NumberInput value={config.minExpectedValue} step={0.01} min={-1} max={10} disabled={!config.requirePositiveExpectedValue} onChange={(value) => bot.updateConfig({ minExpectedValue: value })} testId="rise-fall-min-ev" />
        </Field>
        <Field label="Minimum historical occurrences" hint="Replayings of this rule needed before the expected-value gate applies.">
          <NumberInput value={config.minEvidenceSample} step={5} min={5} disabled={!config.requirePositiveExpectedValue} onChange={(value) => bot.updateConfig({ minEvidenceSample: value })} testId="rise-fall-min-evidence" />
        </Field>
      </div>
    </div>
  );
}

function LiveActivationDialog({ open, onOpenChange, onConfirm, bot }: { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void; bot: RiseFallBotController }) {
  const trading = useDerivTrading();
  const currency = bot.accountCurrency;
  const ladderStake = bot.config.baseStake * bot.config.martingaleMultiplier ** Math.min(bot.config.maxMartingaleSteps, 10);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Siren size={16} className="text-destructive" /> Activate live Rise/Fall trading</DialogTitle>
          <DialogDescription>
            Live mode buys real Rise/Fall contracts on the authorized Deriv account. Review these settings before continuing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[11px] leading-relaxed">
          <div className={`rounded-lg border px-3 py-2 ${trading.activeAccount?.accountType === 'real' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-background/40 text-muted-foreground'}`}>
            <div className="font-semibold">
              {trading.activeAccount === null
                ? 'No Deriv account is authorized yet. Connect one below or in Settings before the bot can buy.'
                : `${trading.activeAccount.accountType === 'real' ? 'Real' : 'Demo'} account ${trading.activeAccount.accountId} · balance ${formatMoney(trading.balance, currency)}`}
            </div>
            <div className="mt-1">Every confirmed order settles against that account's balance.</div>
          </div>
          <ul className="space-y-1 text-muted-foreground">
            <li>Market {bot.symbol || '—'} · expiry {bot.config.duration} {bot.config.durationUnit === 't' ? 'ticks' : bot.config.durationUnit === 's' ? 'seconds' : 'minutes'}.</li>
            <li>Stake model {RISE_FALL_STAKE_MODES.find((mode) => mode.id === bot.config.stakeMode)?.label} · next stake {formatMoney(bot.nextStake, currency)}.</li>
            {bot.config.stakeMode === 'martingale' ? <li className="text-amber-600 dark:text-amber-400">Martingale can reach {formatMoney(ladderStake, currency)} before the ladder resets.</li> : null}
            <li>Daily loss limit {formatMoney(bot.config.maxDailyLoss, currency)} · daily take profit {formatMoney(bot.config.dailyTakeProfit, currency)} · consecutive-loss stop {bot.config.maxConsecutiveLosses}.</li>
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-live-rise-fall">Keep analysis mode</Button>
          <Button
            variant={trading.activeAccount?.accountType === 'real' ? 'destructive' : 'default'}
            disabled={trading.activeAccount === null}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            data-testid="button-confirm-live-rise-fall"
          >
            Activate live trading
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Total profit and loss, always visible at the top of the bot. */
function ProfitLossStrip({ bot }: { bot: RiseFallBotController }) {
  const currency = bot.accountCurrency;
  const summary = bot.tradeSummary;
  const accountLabel = bot.accountType === 'real' ? 'Real account' : bot.accountType === 'demo' ? 'Demo account' : 'No account connected';
  const tone = (value: number) => (value > 0 ? 'text-emerald-600 dark:text-emerald-400' : value < 0 ? 'text-destructive' : 'text-foreground');
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="rise-fall-profit-loss">
      <div className={`rounded-xl border p-3 ${bot.accountType === 'real' ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-background/40'}`}>
        <span className="eyebrow">Total profit / loss · {accountLabel} (settled)</span>
        <span className={`mono mt-1 block text-2xl font-bold tabular-nums ${tone(summary.netProfit)}`} data-testid="rise-fall-total-pnl">
          {formatSignedMoney(summary.netProfit, currency)}
        </span>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          {summary.purchased} order{summary.purchased === 1 ? '' : 's'} · {summary.wins} won · {summary.losses} lost · {summary.pushes} pushed · {summary.open} open · staked {formatMoney(summary.grossStake, currency)}
          {summary.returnOnStake === null ? '' : ` · return on stake ${formatPercent(summary.returnOnStake, 2)}`}
        </span>
      </div>
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <span className="eyebrow">Account snapshot · {accountLabel}</span>
        <span className="mono mt-1 block text-2xl font-bold tabular-nums" data-testid="rise-fall-balance-snapshot">
          {formatMoney(bot.account.balance, currency)}
        </span>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          Session {formatSignedMoney(bot.account.sessionPnl, currency)} · today {formatSignedMoney(bot.account.dailyPnl, currency)} · open exposure {formatMoney(bot.account.openExposure, currency)} · next stake {formatMoney(bot.nextStake, currency)}
        </span>
      </div>
    </div>
  );
}

function ControlPanel({ bot, onMinimize }: { bot: RiseFallBotController; onMinimize: () => void }) {
  const [showConfig, setShowConfig] = useState(false);
  const [activationOpen, setActivationOpen] = useState(false);
  const running = bot.runState === 'running';
  const paused = bot.runState === 'paused';
  const stopped = bot.runState === 'idle' || bot.runState === 'stopped';
  const statusText = running ? 'Running' : paused ? 'Paused' : 'Stopped';

  return (
    <>
      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="rise-fall-control-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-primary"><ArrowUpRight size={18} /></span>
            <div>
              <div className="eyebrow">Premium bot · rise / fall</div>
              <h2 className="mt-1 text-lg font-bold tracking-tight">Deriv Rise/Fall AI momentum engine</h2>
              <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
                Live ticks feed a momentum and continuation rule set, the risk manager sizes and gates the order, and Deriv settles the CALL or PUT contract.
                In live mode the bot really opens positions on the authorized demo or real account; in analysis mode it records and scores the signal without sending anything.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onMinimize}
              className="focus-ring rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              aria-label="Minimize bot"
              title="Minimize bot"
              data-testid="button-rise-fall-minimize"
            >
              <Minimize2 size={15} />
            </button>
            <div className="flex flex-col items-end gap-2">
              <DerivConnectionStatusBadge />
              <span className={`mono rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${running ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-border bg-background/60 text-muted-foreground'}`} data-testid="rise-fall-status">
                {statusText}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {stopped || paused ? (
            <Button onClick={paused ? bot.resume : bot.start} className="gap-2" data-testid="button-rise-fall-start">
              <Play size={14} fill="currentColor" />{paused ? 'Resume bot' : 'Start bot'}
            </Button>
          ) : (
            <Button variant="secondary" onClick={bot.pause} className="gap-2" data-testid="button-rise-fall-pause"><Pause size={14} />Pause bot</Button>
          )}
          <Button variant="outline" onClick={bot.stop} disabled={stopped && !running} className="gap-2" data-testid="button-rise-fall-stop"><CircleStop size={14} />Stop bot</Button>
          <Button variant="outline" onClick={bot.runCycleNow} disabled={!running} className="gap-2" data-testid="button-rise-fall-cycle">
            <Gauge size={14} />Run cycle now
          </Button>
          <Button variant="ghost" onClick={() => setShowConfig((value) => !value)} className="gap-2" data-testid="button-rise-fall-config">
            <Settings2 size={14} />{showConfig ? 'Hide configuration' : 'Configuration'}
          </Button>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {MODE_DETAILS.map(({ id, label, blurb, icon: Icon }) => {
            const active = bot.mode === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => (id === 'live' ? setActivationOpen(true) : bot.setMode(id))}
                aria-pressed={active}
                className={`focus-ring rounded-xl border p-3 text-left transition-colors ${active ? 'border-primary/60 bg-primary/5' : 'border-border bg-background/35 hover:border-primary/40'}`}
                data-testid={`rise-fall-mode-${id}`}
              >
                <span className="flex items-center gap-2 text-xs font-bold"><Icon size={14} className={active ? 'text-primary' : 'text-muted-foreground'} />{label}</span>
                <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{blurb}</span>
                {active ? <span className="mono mt-2 block text-[9px] font-bold uppercase tracking-[0.08em] text-primary">Active mode</span> : null}
              </button>
            );
          })}
        </div>

        <ProfitLossStrip bot={bot} />

        <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Market</div>
            <div className="mono mt-1 text-sm font-semibold">{bot.symbol || '—'}</div>
            <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{bot.marketName || 'No active symbol metadata'}</div>
          </div>
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Expiry</div>
            <div className="mono mt-1 text-sm font-semibold">{bot.config.duration} {bot.config.durationUnit === 't' ? 'ticks' : bot.config.durationUnit === 's' ? 'seconds' : 'minutes'}</div>
            <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
              {bot.contractSupportLoaded ? `${bot.supportedTickExpiries.length} Deriv-reported tick expiry(ies)` : 'Waiting for Deriv contract metadata'}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Next stake</div>
            <div className="mono mt-1 text-sm font-semibold" data-testid="rise-fall-next-stake">{formatMoney(bot.nextStake, bot.accountCurrency)}</div>
            <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
              {RISE_FALL_STAKE_MODES.find((mode) => mode.id === bot.config.stakeMode)?.label}
              {bot.config.stakeMode === 'martingale' ? ` · step ${bot.martingaleStep}/${bot.config.maxMartingaleSteps}` : ''}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Last cycle</div>
            <div className="mono mt-1 text-sm font-semibold">{bot.lastCycleAt ? formatClock(bot.lastCycleAt) : '—'}</div>
            <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
              {bot.cycleRunning ? 'cycle running' : bot.runState === 'running' ? 'on every new tick' : 'bot not running'}
            </div>
          </div>
        </div>

        {showConfig ? <BotConfiguration bot={bot} /> : null}

        {bot.cycleError ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[11px] leading-relaxed text-destructive" role="alert" data-testid="rise-fall-cycle-error">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{bot.cycleError}</span>
          </div>
        ) : null}

        {bot.feedError ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[11px] leading-relaxed text-destructive" role="alert" data-testid="rise-fall-feed-error">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{bot.feedError}</span>
          </div>
        ) : null}

        {bot.precisionError ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300" role="status">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{bot.precisionError} Ticks are never generated to fill the gap, so no signal is produced until Deriv delivers verified quotes again.</span>
          </div>
        ) : null}

        {bot.safety.autoPauseReasons.length ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300" role="status" data-testid="rise-fall-auto-pause">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Automatic pause — new purchases are blocked:</div>
              <ul className="mt-1 space-y-0.5">
                {bot.safety.autoPauseReasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </div>
          </div>
        ) : null}
      </section>

      <LiveActivationDialog open={activationOpen} onOpenChange={setActivationOpen} bot={bot} onConfirm={() => bot.setMode('live')} />

      {bot.mode === 'live' ? (
        <section className="sticky top-[76px] z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 backdrop-blur" data-testid="rise-fall-live-banner" role="alert">
          <div className="flex items-center gap-3">
            <Siren size={18} className="text-destructive" />
            <div>
              <div className="text-xs font-extrabold uppercase tracking-[0.1em] text-destructive">Live trading active</div>
              <div className="text-[10px] text-muted-foreground">
                {bot.accountType === 'real' ? 'Real account' : bot.accountType === 'demo' ? 'Demo account' : 'No account'} · Rise/Fall purchases are sent to Deriv after every gate passes.
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={bot.pause} data-testid="button-rise-fall-live-pause"><Pause size={14} />Pause</Button>
            <Button variant="destructive" size="sm" onClick={bot.stop} data-testid="button-rise-fall-live-stop"><CircleStop size={14} />Stop bot</Button>
          </div>
        </section>
      ) : null}
    </>
  );
}

/** Live signal: the features, the direction, its historical evidence and the gate. */
function SignalPanel({ bot }: { bot: RiseFallBotController }) {
  const features = bot.features;
  const decision = bot.decision;
  const evidence = decision?.evidence ?? null;
  const gate = bot.risk;
  return (
    <Panel
      eyebrow="Live signal"
      title="What the engine reads and what it decided"
      icon={<Gauge size={16} />}
      testId="rise-fall-signal"
      aside={
        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold ${bot.feedFresh ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'}`} data-testid="rise-fall-feed-health" aria-live="polite">
          <Activity size={13} />
          {bot.feedFresh ? `Live ticks · ${bot.tickCount} verified` : `Tick feed ${bot.feedStatus}`}
        </span>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Current quote" value={bot.quote === null ? '—' : bot.quote.toFixed(bot.precision ?? 2)} hint={bot.pipSize === null ? 'Pip size unverified' : `1 pip = ${bot.pipSize}`} testId="rise-fall-quote" />
        <StatTile
          label="Momentum"
          value={features ? `${features.momentumPips >= 0 ? '+' : ''}${features.momentumPips.toFixed(2)} pips` : '—'}
          hint={features ? `Net move over ${bot.config.momentumTicks} ticks` : 'Waiting for ticks'}
          tone={features ? (features.momentumPips > 0 ? 'good' : features.momentumPips < 0 ? 'bad' : 'default') : 'default'}
          testId="rise-fall-momentum"
        />
        <StatTile label="Window direction" value={features ? `${formatPercent(features.upRatio, 1)} up · ${formatPercent(features.downRatio, 1)} down` : '—'} hint={features ? `${features.sample} ticks in the window` : undefined} testId="rise-fall-ratios" />
        <StatTile label="Volatility" value={features ? `${features.volatilityPips.toFixed(2)} pips` : '—'} hint={`Mean tick move over ${bot.config.volatilityTicks} ticks · floor ${bot.config.minVolatilityPips.toFixed(2)}`} tone={features && features.volatilityPips < bot.config.minVolatilityPips ? 'warn' : 'default'} />
        <StatTile label="Last move" value={features ? `${features.lastMovePips >= 0 ? '+' : ''}${features.lastMovePips.toFixed(2)} pips` : '—'} hint={features ? `Streak ${features.streakLength} ${features.streakDirection}` : undefined} />
        <StatTile
          label="Signal"
          value={decision?.direction ? RISE_FALL_LABELS[decision.direction] : 'Wait'}
          hint={decision ? RISE_FALL_RULE_LABELS[decision.rule] : 'No decision cycle yet'}
          tone={decision?.direction ? (decision.direction === 'CALL' ? 'good' : 'bad') : 'default'}
          testId="rise-fall-direction"
        />
        <StatTile
          label="Historical hit rate"
          value={evidence?.winRate === null || evidence === null ? '—' : formatPercent(evidence.winRate, 1)}
          hint={evidence ? `${evidence.occurrences} firing(s) at ${evidence.horizonTicks ?? '—'} ticks · baseline ${evidence.baselineWinRate === null ? '—' : formatPercent(evidence.baselineWinRate, 1)}` : 'Replayed once a direction is named'}
          tone={evidence?.sufficient ? (evidence.winRate !== null && evidence.winRate > 0.5 ? 'good' : 'warn') : 'default'}
          testId="rise-fall-evidence"
        />
        <StatTile
          label="Purchase gate"
          value={gate === null ? '—' : gate.allowed ? 'Open' : `${gate.violations.length} block(s)`}
          hint={gate === null ? 'No cycle yet' : gate.allowed ? `Next stake ${formatMoney(gate.stake, bot.accountCurrency)}` : gate.violations[0]}
          tone={gate === null ? 'default' : gate.allowed ? 'good' : 'warn'}
          testId="rise-fall-gate"
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-background/35 p-3">
          <div className="flex items-center gap-2 text-xs font-bold">{directionBadge(decision?.direction ?? null)} Latest cycle · {decision ? formatClock(decision.at) : '—'}</div>
          <div className="mono mt-1 text-[11px] font-semibold" data-testid="rise-fall-action">{decision?.actionLabel ?? 'Waiting for the first cycle'}</div>
          <div className="mt-2"><ReasonList reasons={decision?.reasons ?? ['The bot has not completed a decision cycle yet. Press Start to begin reading live ticks.']} limit={6} tone={decision?.action === 'BLOCKED' ? 'warn' : 'muted'} /></div>
          {decision?.reasonCodes.length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {decision.reasonCodes.slice(0, 10).map((code) => (
                <code key={code} className="mono rounded border border-border bg-background/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">{code}</code>
              ))}
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border border-border bg-background/35 p-3">
          <div className="flex items-center gap-2 text-xs font-bold"><ShieldAlert size={13} className="text-primary" /> What would stop the next purchase</div>
          {gate && !gate.allowed ? <div className="mt-2"><ReasonList reasons={gate.violations} tone="warn" limit={6} /></div> : <p className="mt-2 text-[11px] text-muted-foreground">No limit is blocking an entry right now. The maximum possible loss of the next stake is {formatMoney(gate?.maxPossibleLoss ?? null, bot.accountCurrency)}.</p>}
          {gate?.notes.length ? <div className="mt-2"><ReasonList reasons={gate.notes} limit={4} /></div> : null}
        </div>
      </div>
    </Panel>
  );
}

function PositionRow({ bot, contractId }: { bot: RiseFallBotController; contractId: number }) {
  const [confirming, setConfirming] = useState(false);
  const [selling, setSelling] = useState(false);
  const [sellError, setSellError] = useState('');
  const contract = bot.contracts.find((row) => row.contractId === contractId);
  if (!contract) return null;
  const settled = contract.settledProfit !== null;
  const progress = contract.tickCount !== null && contract.tickCount > 0 && contract.tickPassed !== null
    ? `${contract.tickPassed}/${contract.tickCount} ticks`
    : contract.expiryTime ? `expires ${formatClock(contract.expiryTime * 1_000)}` : '—';
  return (
    <tr data-testid={`rise-fall-position-${contract.contractId}`}>
      <td className="mono border-b border-border px-2 py-1.5">{contract.contractId}</td>
      <td className="border-b border-border px-2 py-1.5">{directionBadge(contract.direction)}</td>
      <td className="mono border-b border-border px-2 py-1.5">{formatMoney(contract.stake, contract.currency || bot.accountCurrency)}</td>
      <td className="mono border-b border-border px-2 py-1.5">{formatMoney(contract.payout, contract.currency || bot.accountCurrency)}</td>
      <td className="mono border-b border-border px-2 py-1.5">{contract.entrySpot ?? '—'}</td>
      <td className="mono border-b border-border px-2 py-1.5">{settled ? (contract.exitSpot ?? '—') : (contract.currentSpot ?? '—')}</td>
      <td className="mono border-b border-border px-2 py-1.5 text-muted-foreground">{progress}</td>
      <td className="border-b border-border px-2 py-1.5">
        {settled
          ? <span className={contract.settledProfit! > 0 ? 'text-emerald-600 dark:text-emerald-400' : contract.settledProfit! < 0 ? 'text-destructive' : 'text-muted-foreground'}>{contract.settledProfit! > 0 ? 'won' : contract.settledProfit! < 0 ? 'lost' : 'push — stake returned'}</span>
          : <span className="text-muted-foreground">open — nothing is realised until Deriv settles</span>}
      </td>
      <td className={`mono border-b border-border px-2 py-1.5 ${contract.profit === null ? 'text-muted-foreground' : contract.profit > 0 ? 'text-emerald-600 dark:text-emerald-400' : contract.profit < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
        {settled ? formatSignedMoney(contract.settledProfit, contract.currency || bot.accountCurrency) : formatSignedMoney(contract.profit, contract.currency || bot.accountCurrency)}
      </td>
      <td className="border-b border-border px-2 py-1.5">
        {settled ? (
          <span className="text-[10px] text-muted-foreground">{contract.settledAt ? formatClock(contract.settledAt) : '—'}</span>
        ) : contract.isValidToSell ? (
          confirming ? (
            <span className="flex flex-wrap gap-1">
              <button
                type="button"
                disabled={selling}
                onClick={async () => {
                  setSelling(true);
                  setSellError('');
                  try {
                    await bot.closeContract(contract.contractId);
                    setConfirming(false);
                  } catch (error) {
                    setSellError(error instanceof Error ? error.message : 'Deriv rejected the sell request.');
                  } finally {
                    setSelling(false);
                  }
                }}
                className="focus-ring rounded border border-destructive/50 bg-destructive/10 px-2 py-1 text-[10px] font-bold text-destructive disabled:opacity-60"
                data-testid={`button-rise-fall-confirm-sell-${contract.contractId}`}
              >
                {selling ? 'Sending…' : 'Confirm sell'}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={selling} className="focus-ring rounded border border-border px-2 py-1 text-[10px] text-muted-foreground disabled:opacity-60">Cancel</button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="focus-ring rounded border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground"
              data-testid={`button-rise-fall-sell-${contract.contractId}`}
            >
              Sell now
            </button>
          )
        ) : (
          <span className="text-[10px] text-muted-foreground">Deriv is not offering a sale</span>
        )}
        {sellError ? <span className="mt-1 block text-[10px] text-destructive">{sellError}</span> : null}
      </td>
    </tr>
  );
}

/** Open live positions this bot bought, monitored until Deriv settles them. */
function PositionsPanel({ bot }: { bot: RiseFallBotController }) {
  const open = bot.contracts.filter((contract) => !contract.isSold);
  const settled = bot.contracts.filter((contract) => contract.isSold);
  const others = bot.accountOpenPositions.filter((position) => !bot.contracts.some((contract) => contract.contractId === position.contractId));
  return (
    <Panel
      eyebrow="Live positions"
      title="Contracts this bot opened, monitored until settlement"
      icon={<Activity size={16} />}
      testId="rise-fall-positions"
      aside={
        <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
          <span className="mono rounded border border-border bg-background/60 px-2 py-1">{open.length} open</span>
          <span className="mono rounded border border-border bg-background/60 px-2 py-1">{settled.length} settled here</span>
          <span className="mono rounded border border-border bg-background/60 px-2 py-1">{bot.accountOpenPositions.length} open on the account</span>
        </div>
      }
    >
      {!bot.contracts.length ? (
        <div className="rounded-lg border border-dashed border-border bg-background/40 px-4 py-8 text-center" data-testid="rise-fall-positions-empty">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            No position has been opened yet. To open a live one: connect a Deriv account, choose <strong className="font-bold text-foreground">Live trading</strong>, press
            {' '}<strong className="font-bold text-foreground">Start bot</strong> and wait for a signal that passes every gate. Analysis mode records signals without buying.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border" role="region" aria-label="Bot positions table">
          <table className="w-full min-w-[900px] border-collapse text-[10px]">
            <thead>
              <tr className="bg-background/60">
                {['Contract id', 'Direction', 'Stake', 'Payout', 'Entry spot', 'Current / exit spot', 'Progress', 'Result', 'P/L', 'Close early'].map((heading) => (
                  <th key={heading} scope="col" className="border-b border-border px-2 py-2 text-left text-[9px] uppercase tracking-wider text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...open, ...settled].map((contract) => <PositionRow key={contract.contractId} bot={bot} contractId={contract.contractId} />)}
            </tbody>
          </table>
        </div>
      )}

      {others.length ? (
        <div className="mt-3 rounded-lg border border-border bg-background/35 p-3">
          <div className="text-xs font-bold">Other open positions on this account</div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            These contracts were not opened by this bot. The Trade history tab lists every position on the account with its live profit.
          </p>
          <ul className="mt-2 space-y-1">
            {others.map((position) => (
              <li key={position.contractId} className="mono flex flex-wrap gap-x-3 text-[10px] text-muted-foreground" data-testid={`rise-fall-other-position-${position.contractId}`}>
                <span>#{position.contractId}</span>
                <span>{position.contractType ?? 'contract'}</span>
                <span>{position.symbol ?? '—'}</span>
                <span>stake {formatMoney(position.buyPrice, position.currency ?? '')}</span>
                <span className={position.profit === null ? '' : position.profit > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>{formatSignedMoney(position.profit, position.currency ?? '')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {bot.purchaseInFlight ? (
        <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground" role="status">A purchase request is with Deriv right now; the bot will not send a second order for the same decision.</div>
      ) : null}
      {bot.unreconciledPurchase ? (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300" role="status">
          A purchase may have reached Deriv without a receipt. The bot is matching it against the account's open positions and will not send another order until it knows what happened.
        </div>
      ) : null}
    </Panel>
  );
}

function AccountPanel({ bot }: { bot: RiseFallBotController }) {
  const account = bot.account;
  const currency = account.currency || bot.accountCurrency;
  const dailyLossUsed = account.dailyPnl < 0 ? Math.abs(account.dailyPnl) : 0;
  return (
    <Panel
      eyebrow="Account and risk"
      title="Authoritative balance and how much room is left"
      icon={<Wallet size={16} />}
      testId="rise-fall-account"
      aside={
        <span className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${bot.accountType === 'real' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-background/60 text-muted-foreground'}`}>
          {bot.accountType === 'real' ? 'Real account' : bot.accountType === 'demo' ? 'Demo account' : 'No account'}
        </span>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Deriv balance" value={formatMoney(account.balance, currency)} hint={account.accountId ? `Account ${account.accountId}` : 'No account authorized'} testId="rise-fall-balance" />
        <StatTile label="Session P/L" value={formatSignedMoney(account.sessionPnl, currency)} hint={account.sessionStartedAt ? `Started ${formatClock(account.sessionStartedAt)}` : 'Session not started'} tone={account.sessionPnl > 0 ? 'good' : account.sessionPnl < 0 ? 'bad' : 'default'} />
        <StatTile label="Realised daily P/L" value={formatSignedMoney(account.dailyPnl, currency)} hint={`Day ${account.dayKey ?? '—'}`} tone={account.dailyPnl > 0 ? 'good' : account.dailyPnl < 0 ? 'bad' : 'default'} />
        <StatTile label="Open exposure" value={formatMoney(account.openExposure, currency)} hint={`${bot.contracts.filter((contract) => !contract.isSold).length} open contract(s)`} />
        <StatTile label="Consecutive losses" value={`${account.consecutiveLosses} / ${bot.config.maxConsecutiveLosses}`} hint={`Longest streak ${account.longestLosingStreak}`} tone={account.consecutiveLosses >= bot.config.maxConsecutiveLosses ? 'bad' : 'default'} testId="rise-fall-loss-streak" />
        <StatTile label="Daily loss limit" value={formatMoney(bot.config.maxDailyLoss, currency)} hint={`Used ${formatMoney(dailyLossUsed, currency)}`} tone={bot.config.maxDailyLoss > 0 && dailyLossUsed >= bot.config.maxDailyLoss ? 'bad' : 'default'} />
        <StatTile label="Daily take profit" value={formatMoney(bot.config.dailyTakeProfit, currency)} hint={account.dailyPnl >= bot.config.dailyTakeProfit && bot.config.dailyTakeProfit > 0 ? 'Reached — trading stops for the day' : `${formatMoney(Math.max(0, bot.config.dailyTakeProfit - Math.max(0, account.dailyPnl)), currency)} to go`} tone={bot.config.dailyTakeProfit > 0 && account.dailyPnl >= bot.config.dailyTakeProfit ? 'good' : 'default'} />
        <StatTile label="Trades this session" value={bot.tradesRemaining === null ? `${account.tradesThisSession}` : `${account.tradesThisSession} / ${bot.config.maxTrades}`} hint={bot.tradesRemaining === null ? 'No session trade limit' : `${bot.tradesRemaining} remaining`} />
        <StatTile label="Max drawdown" value={formatMoney(account.maxDrawdown, currency)} hint="Peak-to-trough of the reported balance" />
        <StatTile label="Session time left" value={bot.sessionMinutesRemaining === null ? '—' : `${bot.sessionMinutesRemaining.toFixed(0)} min`} hint={bot.config.maxSessionMinutes > 0 ? `Limit ${bot.config.maxSessionMinutes} min` : 'No session time limit'} />
        <StatTile label="Settled results" value={`${account.wins}W · ${account.losses}L · ${account.pushes}P`} hint="Only Deriv settlements are counted" tone={account.wins > account.losses ? 'good' : account.losses > account.wins ? 'bad' : 'default'} />
        <StatTile label="Last settlement" value={formatClock(account.lastSettlementAt)} hint={account.lastSettlementAt === null ? 'Nothing has settled yet' : `Cooldown ${bot.config.cooldownMs} ms`} />
      </div>
    </Panel>
  );
}

function PredictionPanel({ bot }: { bot: RiseFallBotController }) {
  const summary = bot.predictionSummary;
  const rows = useMemo(() => bot.predictions.slice(-25).reverse(), [bot.predictions]);
  return (
    <Panel
      eyebrow="Signal calibration"
      title="Signals scored whether or not they were traded"
      icon={<LineChart size={16} />}
      testId="rise-fall-predictions"
      aside={<span className="mono text-[10px] text-muted-foreground">{summary.scored} scored · {summary.pending} pending · {summary.expired} expired</span>}
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Hit rate" value={summary.hitRate === null ? '—' : formatPercent(summary.hitRate, 1)} hint="Decisive outcomes only; pushes are counted separately" tone={summary.hitRate === null ? 'default' : summary.hitRate > 0.5 ? 'good' : 'warn'} testId="rise-fall-hit-rate" />
        <StatTile label="Scored signals" value={summary.scored} hint={`${summary.wins} right · ${summary.losses} wrong · ${summary.pushes} level`} />
        <StatTile label="Pending" value={summary.pending} hint="Waiting for the horizon to elapse on live ticks" />
        <StatTile label="Expired" value={summary.expired} hint="The entry tick left the 2,000-tick buffer before the horizon" />
      </div>
      {!rows.length ? (
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          No signal has been recorded yet. Every named direction is written down with the tick it was read on and scored against the ticks that follow, in both modes.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[620px] border-collapse text-[10px]">
            <thead>
              <tr className="bg-background/60">
                {['Time', 'Direction', 'Rule', 'Entry quote', 'Horizon', 'Exit quote', 'Outcome'].map((heading) => (
                  <th key={heading} scope="col" className="border-b border-border px-2 py-1.5 text-left text-[9px] uppercase tracking-wider text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`rise-fall-prediction-${row.id}`}>
                  <td className="mono border-b border-border px-2 py-1.5">{new Date(row.at).toLocaleTimeString()}</td>
                  <td className="border-b border-border px-2 py-1.5">{directionBadge(row.direction)}</td>
                  <td className="border-b border-border px-2 py-1.5 text-muted-foreground">{RISE_FALL_RULE_LABELS[row.rule]}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{row.entryQuote}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{row.horizonTicks} ticks</td>
                  <td className="mono border-b border-border px-2 py-1.5">{row.exitQuote ?? (row.expired ? 'expired' : 'pending')}</td>
                  <td className={`border-b border-border px-2 py-1.5 ${row.outcome === 'win' ? 'text-emerald-600 dark:text-emerald-400' : row.outcome === 'loss' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {row.outcome === 'win' ? 'signal right' : row.outcome === 'loss' ? 'signal wrong' : row.outcome === 'push' ? 'level — stake would return' : row.expired ? 'not scored' : 'unscored'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 flex items-start gap-2 text-[10px] leading-relaxed text-muted-foreground">
        <BadgeCheck size={13} className="mt-0.5 shrink-0 text-primary" />
        These are in-sample counts over the ticks this browser collected, not a calibrated forecast and not a promise of future performance.
      </p>
    </Panel>
  );
}

function TradeLogPanel({ bot }: { bot: RiseFallBotController }) {
  const rows = useMemo(() => bot.records.slice(-40).reverse(), [bot.records]);
  return (
    <Panel
      eyebrow="Trade log"
      title="Every order attempt, including the refused ones"
      icon={<SlidersHorizontal size={16} />}
      testId="rise-fall-trade-log"
      aside={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadTradeLog(TRADE_LOG_FILENAME, bot.tradeLogCsv)} disabled={!bot.records.length} className="gap-2" data-testid="button-rise-fall-export-csv">
            <Download size={13} />Export CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={bot.clearTradeLog} disabled={!bot.records.length && !bot.predictions.length} className="gap-2" data-testid="button-rise-fall-clear-log">
            <Trash2 size={13} />Clear log
          </Button>
        </div>
      }
    >
      {!rows.length ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Nothing has been logged yet. Purchases, refusals and settlements appear here and can be exported as CSV — the same columns the reference script wrote to
          {' '}<span className="mono">trades_log.csv</span>.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] border-collapse text-[10px]">
            <thead>
              <tr className="bg-background/60">
                {['Time', 'Mode', 'Direction', 'Rule', 'Stake', 'Step', 'Contract', 'Result', 'P/L', 'Balance', 'Note'].map((heading) => (
                  <th key={heading} scope="col" className="border-b border-border px-2 py-1.5 text-left text-[9px] uppercase tracking-wider text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => (
                <tr key={record.id} data-testid={`rise-fall-record-${record.id}`}>
                  <td className="mono border-b border-border px-2 py-1.5">{new Date(record.at).toLocaleTimeString()}</td>
                  <td className="border-b border-border px-2 py-1.5 text-muted-foreground">{record.mode}</td>
                  <td className="border-b border-border px-2 py-1.5">{directionBadge(record.direction)}</td>
                  <td className="border-b border-border px-2 py-1.5 text-muted-foreground">{RISE_FALL_RULE_LABELS[record.rule]}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{formatMoney(record.stake, bot.accountCurrency)}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{record.step}</td>
                  <td className="mono border-b border-border px-2 py-1.5">{record.contractId ?? '—'}</td>
                  <td className="border-b border-border px-2 py-1.5">
                    <span className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold ${record.status === 'won' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : record.status === 'lost' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-background/60 text-muted-foreground'}`}>
                      {record.status}
                    </span>
                  </td>
                  <td className={`mono border-b border-border px-2 py-1.5 ${record.profit === null ? 'text-muted-foreground' : record.profit > 0 ? 'text-emerald-600 dark:text-emerald-400' : record.profit < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {record.profit === null ? '—' : formatSignedMoney(record.profit, bot.accountCurrency)}
                  </td>
                  <td className="mono border-b border-border px-2 py-1.5">{formatMoney(record.balanceAfter, bot.accountCurrency)}</td>
                  <td className="max-w-[320px] border-b border-border px-2 py-1.5 text-muted-foreground">{record.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function DecisionLogPanel({ bot }: { bot: RiseFallBotController }) {
  return (
    <Panel
      eyebrow="Decision log"
      title="Every cycle, including the ones that did not trade"
      icon={<Terminal size={16} />}
      testId="rise-fall-decision-log"
      aside={<span className="mono text-[10px] text-muted-foreground">{bot.cycleLog.length} entr{bot.cycleLog.length === 1 ? 'y' : 'ies'} · {bot.cycleRunning ? 'cycle running' : bot.lastCycleAt ? `last ${formatClock(bot.lastCycleAt)}` : 'idle'}</span>}
    >
      {!bot.cycleLog.length ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">No cycle has been recorded yet. Entries appear here with the reasons the bot traded, waited or was blocked.</p>
      ) : (
        <ul className="space-y-2">
          {bot.cycleLog.slice(0, 12).map((entry) => (
            <li key={entry.id} className="rounded-lg border border-border bg-background/40 p-3" data-testid={`rise-fall-log-${entry.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`mono rounded-full border px-2 py-0.5 text-[9px] font-bold ${entry.action === 'TRADE' ? 'border-primary/40 bg-primary/10 text-primary' : entry.action === 'BLOCKED' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
                  {entry.action}
                </span>
                <span className="mono text-[10px] text-muted-foreground">{formatClock(entry.at)}</span>
                <span className="text-[10px] font-semibold">{entry.mode} mode</span>
                {directionBadge(entry.direction)}
                {entry.executed ? <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">ORDER SENT</span> : null}
                <span className="mono ml-auto text-[9px] text-muted-foreground">{entry.stake === null ? '' : `stake ${formatMoney(entry.stake, bot.accountCurrency)}`}</span>
              </div>
              <div className="mt-1.5 text-[11px] font-semibold">{entry.actionLabel}</div>
              <div className="mt-2"><ReasonList reasons={entry.reasons} limit={4} tone={entry.action === 'BLOCKED' ? 'warn' : 'muted'} /></div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Compact minimized bar: the bot keeps running, the dashboard stays out of the way. */
function MinimizedBar({ bot, onExpand }: { bot: RiseFallBotController; onExpand: () => void }) {
  const running = bot.runState === 'running';
  const paused = bot.runState === 'paused';
  const statusText = running ? 'Running' : paused ? 'Paused' : 'Stopped';
  const summary = bot.tradeSummary;
  const currency = bot.accountCurrency;
  const tone = summary.netProfit > 0 ? 'text-emerald-600 dark:text-emerald-400' : summary.netProfit < 0 ? 'text-destructive' : 'text-foreground';
  return (
    <section className="sticky top-[88px] z-10 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-card-border bg-card/95 p-4 panel-glow backdrop-blur animate-rise-in" data-testid="rise-fall-minimized-bar">
      <div className="flex items-center gap-3">
        <span className="text-primary"><Bot size={18} /></span>
        <div>
          <div className="eyebrow">Premium bot · minimized</div>
          <div className="mt-0.5 text-sm font-bold tracking-tight">Deriv Rise/Fall momentum engine</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={`mono rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${running ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-border bg-background/60 text-muted-foreground'}`} data-testid="rise-fall-minimized-status">
          {statusText}
        </span>
        <span className={`mono rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${bot.mode === 'live' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-background/60 text-muted-foreground'}`}>
          {bot.mode === 'live' ? `Live · ${bot.accountType === 'real' ? 'real' : bot.accountType === 'demo' ? 'demo' : 'no account'}` : 'Analysis only'}
        </span>
        {directionBadge(bot.decision?.direction ?? null)}
        <span className="mono rounded-full border border-border bg-background/60 px-3 py-1 text-[10px] text-muted-foreground">
          {bot.contracts.filter((contract) => !contract.isSold).length} open position(s)
        </span>
      </div>

      <div className="ml-auto text-right" data-testid="rise-fall-minimized-pnl">
        <div className="eyebrow">Total profit / loss</div>
        <div className={`mono text-2xl font-bold tabular-nums leading-tight ${tone}`}>{formatSignedMoney(summary.netProfit, currency)}</div>
        <div className="text-[10px] text-muted-foreground">
          {summary.purchased} order{summary.purchased === 1 ? '' : 's'} · {summary.wins} won · {summary.losses} lost · session {formatSignedMoney(bot.account.sessionPnl, currency)}
        </div>
      </div>

      <Button onClick={onExpand} className="gap-2" data-testid="button-rise-fall-expand">
        <Maximize2 size={14} />Expand bot
      </Button>
    </section>
  );
}

export function RiseFallAiBot() {
  const bot = useRiseFallBot();
  const [minimized, setMinimized] = useState<boolean>(readMinimized);

  useEffect(() => {
    try {
      window.localStorage.setItem(MINIMIZED_KEY, minimized ? 'true' : 'false');
    } catch {
      // Storage is optional; the choice is still held in memory.
    }
  }, [minimized]);

  if (minimized) {
    return (
      <div className="mx-auto w-full max-w-[1500px] space-y-4 animate-rise-in" data-testid="rise-fall-ai-bot">
        <MinimizedBar bot={bot} onExpand={() => setMinimized(false)} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-4 animate-rise-in" data-testid="rise-fall-ai-bot">
      <ControlPanel bot={bot} onMinimize={() => setMinimized(true)} />

      {bot.accountCurrency === '' ? (
        <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="rise-fall-authorization">
          <div className="eyebrow">Deriv authorization</div>
          <h3 className="mt-1 text-sm font-bold">Connect a Deriv account to open live positions</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            The bot reuses this application's existing Deriv connection: your Personal Access Token stays in this browser, and the account selector chooses the demo or
            real account the bot may buy on. Analysis-only mode works without an account.
          </p>
          <div className="mt-3"><DerivConnectionCard /></div>
        </section>
      ) : null}

      <SignalPanel bot={bot} />
      <PositionsPanel bot={bot} />
      <div className="grid gap-4 xl:grid-cols-2">
        <AccountPanel bot={bot} />
        <PredictionPanel bot={bot} />
      </div>
      <TradeLogPanel bot={bot} />
      <DecisionLogPanel bot={bot} />

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="rise-fall-limits">
        <div className="flex items-center gap-2">
          <RefreshCw size={15} className="text-primary" />
          <h3 className="text-sm font-bold">What this bot will and will not do</h3>
        </div>
        <ul className="mt-3 grid gap-2 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-2">
          <li>It only buys on the authorized Deriv account in live mode; there is no simulated execution and no paper balance.</li>
          <li>It never trades on stale or missing ticks — a feed that stops being fresh stops new purchases.</li>
          <li>It never sends a second order for one decision: a purchase is single-flight, and a receipt that never arrives is reconciled against the account first.</li>
          <li>It never treats a running payout on an open contract as realised profit; only Deriv settlements move the ledger.</li>
          <li>It never calls a historical hit rate a forecast — the replay is an in-sample count over the ticks this browser collected.</li>
          <li>It offers a martingale ladder because the reference script had one, and warns that a losing streak grows the stake geometrically.</li>
          <li>It never sends your token, account id or balance to a third-party service; every rule runs in this browser.</li>
          <li>It never promises that a passing gate implies profitability.</li>
        </ul>
      </section>
    </div>
  );
}
