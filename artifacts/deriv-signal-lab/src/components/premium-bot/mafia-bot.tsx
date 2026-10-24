// The Mafia bot premium panel.
//
// Two 4-tick Rise/Fall legs bought together on a Step index: the primary leg
// trades the direction the uniformity analysis measured, the cover leg trades
// the other way. Both settle on the same tick, so one leg wins unless the
// window ends exactly where it started.
//
// This panel shows the arithmetic rather than a promise. The quoted payout of a
// four-tick Rise/Fall contract is read from Deriv, never assumed: a pair only
// profits on a win when the paying leg's payout exceeds both stakes, and a level
// window costs both. The break-even hit rate the current hedge ratio needs is
// printed next to the evidence the bot actually has. Nothing here is a forecast.
import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CircleStop,
  Download,
  FlaskConical,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Siren,
  Skull,
  Terminal,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DerivConnectionCard, DerivConnectionStatusBadge } from '@/components/deriv-connection-card';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { useMafiaBot, type MafiaBotController } from '@/hooks/use-mafia-bot';
import { Panel, ReasonList, StatTile, formatClock, formatMoney, formatPercent, formatSignedMoney } from '@/components/premium-bot/bot-panels';
import { ConfigGroup, Field, NumberInput, SelectInput, ToggleField } from '@/components/premium-bot/bot-form';
import { MAFIA_LOG_FILENAME, isPairOpen } from '@/lib/mafia-bot/ledger';
import {
  MAFIA_DURATION_TICKS,
  MAFIA_DIRECTION_LABELS,
  type MafiaBotConfig,
  type MafiaLeg,
  type MafiaLegSide,
  type MafiaMode,
  type MafiaPair,
} from '@/lib/mafia-bot/types';

const MODE_DETAILS: Array<{ id: MafiaMode; label: string; blurb: string; icon: typeof Terminal }> = [
  { id: 'analysis', label: 'Analysis only', blurb: 'Runs the uniformity gate and the four-tick replay, prices both legs with real Deriv quotes, and records what it would have bought. No order is sent.', icon: FlaskConical },
  { id: 'live', label: 'Live pairs', blurb: 'Buys both four-tick legs together on the authorized account the moment the uniformity gate passes and every risk limit allows it. Turn on the expected-value gate to make the pair arithmetic a requirement too.', icon: Activity },
];

const STATUS_TONE: Record<string, string> = {
  open: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  settled: 'border-border bg-background/60 text-muted-foreground',
  partial: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  rejected: 'border-border bg-background/60 text-muted-foreground',
  unreconciled: 'border-destructive/40 bg-destructive/10 text-destructive',
};

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  settled: 'Settled',
  partial: 'One leg only',
  rejected: 'Not bought',
  unreconciled: 'Reconciling',
};

const LEG_LABEL: Record<MafiaLegSide, string> = {
  primary: 'Primary leg',
  cover: 'Cover leg',
};

function downloadCsv(filename: string, contents: string): void {
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

function directionBadge(direction: 'CALL' | 'PUT', size: 'sm' | 'xs' = 'sm') {
  const Icon = direction === 'CALL' ? ArrowUpRight : ArrowDownRight;
  const tone = direction === 'CALL'
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    : 'border-destructive/40 bg-destructive/10 text-destructive';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-extrabold uppercase tracking-[0.06em] ${tone} ${size === 'sm' ? 'text-[10px]' : 'text-[9px]'}`}>
      <Icon size={11} />
      {MAFIA_DIRECTION_LABELS[direction]}
    </span>
  );
}

type Tone = 'default' | 'good' | 'warn' | 'bad';

function pnlTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined) return 'default';
  return value > 0 ? 'good' : value < 0 ? 'bad' : 'default';
}

type NumericConfigKey = { [K in keyof MafiaBotConfig]: MafiaBotConfig[K] extends number ? K : never }[keyof MafiaBotConfig];
type BooleanConfigKey = { [K in keyof MafiaBotConfig]: MafiaBotConfig[K] extends boolean ? K : never }[keyof MafiaBotConfig];

/** Full operator configuration: money management first, because it decides the break-even. */
function BotConfiguration({ bot }: { bot: MafiaBotController }) {
  const config = bot.config;
  const currency = bot.accountCurrency;
  const num = (key: NumericConfigKey) => (value: number) => bot.updateConfig({ [key]: value } as Partial<MafiaBotConfig>);
  const flag = (key: BooleanConfigKey) => (value: boolean) => bot.updateConfig({ [key]: value } as Partial<MafiaBotConfig>);
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4" data-testid="mafia-config">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Stored in this browser only — never a token, account id or socket URL. Every value is clamped to a range the engine can act on.
        </p>
        <Button variant="ghost" size="sm" onClick={bot.resetConfig} className="gap-2" data-testid="button-mafia-reset-config">
          <RefreshCw size={13} />Reset to defaults
        </Button>
      </div>

      <ConfigGroup title="Market" description="Step indices only. The bot moves the feed to a Step index and refuses every other market.">
        <Field label="Market" hint={bot.marketName || 'No active symbol metadata'}>
          <SelectInput
            value={bot.symbol}
            onChange={bot.selectSymbol}
            disabled={!bot.stepMarkets.length}
            testId="mafia-symbol"
            options={bot.stepMarkets.length
              ? bot.stepMarkets.map((market) => ({ value: market.symbol, label: `${market.name} · ${market.symbol}` }))
              : [{ value: '', label: 'Deriv has not listed a Step index…' }]}
          />
        </Field>
        <Field label="Duration" hint="Fixed by the bot; not configurable.">
          <div className="mono rounded-md border border-border bg-background/40 px-2 py-1.5 text-[11px]">{MAFIA_DURATION_TICKS} ticks</div>
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Money management" description="The primary leg stakes the analysed direction; the cover leg is a percentage of it. The pair's break-even moves with this ratio.">
        <Field label="Stake mode" hint="How each pair's primary stake is chosen.">
          <SelectInput
            value={config.stakeMode}
            onChange={(value) => bot.updateConfig({ stakeMode: value as MafiaBotConfig['stakeMode'] })}
            testId="mafia-stake-mode"
            options={[
              { value: 'flat', label: 'Flat stake' },
              { value: 'martingale', label: 'Martingale after losing pairs' },
              { value: 'fixed-fraction', label: 'Fixed fraction of balance' },
            ]}
          />
        </Field>
        <Field label={`Primary stake (${currency || 'account currency'})`} hint={`Minimum ${config.minStake.toFixed(2)}`}>
          <NumberInput value={config.primaryStake} onChange={num('primaryStake')} step={0.1} min={config.minStake} testId="mafia-primary-stake" />
        </Field>
        <Field label="Cover leg (% of primary)" hint="100% is an equal pair: it cannot profit at Deriv's payouts.">
          <NumberInput value={config.hedgeRatioPercent} onChange={num('hedgeRatioPercent')} step={5} min={10} max={100} testId="mafia-hedge-ratio" />
        </Field>
        <Field label="Max stake per leg" hint="Hard ceiling before the balance share applies.">
          <NumberInput value={config.maxStake} onChange={num('maxStake')} step={1} min={0.35} testId="mafia-max-stake" />
        </Field>
        <Field label="Balance share per pair (%)" hint="Both legs together.">
          <NumberInput value={config.maxStakeShareOfBalance} onChange={num('maxStakeShareOfBalance')} step={0.5} min={0.5} max={50} testId="mafia-share" />
        </Field>
        <Field label="Martingale factor" hint={`Multiplies after each losing pair, capped at ${config.maxMartingaleSteps} steps.`}>
          <NumberInput value={config.martingaleFactor} onChange={num('martingaleFactor')} step={0.1} min={1} max={4} disabled={config.stakeMode !== 'martingale'} testId="mafia-martingale-factor" />
        </Field>
        <Field label="Martingale step cap" hint="0 disables the ladder.">
          <NumberInput value={config.maxMartingaleSteps} onChange={num('maxMartingaleSteps')} step={1} min={0} max={10} disabled={config.stakeMode !== 'martingale'} testId="mafia-martingale-steps" />
        </Field>
        <Field label="Fixed fraction (%)" hint="Share of the live balance used as the primary stake.">
          <NumberInput value={config.fixedFractionPercent} onChange={num('fixedFractionPercent')} step={0.1} min={0.1} max={25} disabled={config.stakeMode !== 'fixed-fraction'} testId="mafia-fraction" />
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Uniformity gate" description="The tape must be one-directional by count and by persistence before either leg is priced." columns={3}>
        <Field label="Analysis window (ticks)" hint="Signs of the most recent moves.">
          <NumberInput value={config.uniformityWindow} onChange={num('uniformityWindow')} step={5} min={20} max={300} testId="mafia-window" />
        </Field>
        <Field label="Minimum uniformity" hint="0–1 combined score.">
          <NumberInput value={config.minUniformity} onChange={num('minUniformity')} step={0.05} min={0} max={1} testId="mafia-min-uniformity" />
        </Field>
        <Field label="Minimum z" hint="Directional and persistence z must both clear it.">
          <NumberInput value={config.minUniformityZ} onChange={num('minUniformityZ')} step={0.25} min={0} max={6} testId="mafia-min-z" />
        </Field>
        <Field label="Ticks before first pair" hint="Warm-up before any entry is considered.">
          <NumberInput value={config.minTicksBeforeTrade} onChange={num('minTicksBeforeTrade')} step={25} min={20} max={2000} testId="mafia-warmup" />
        </Field>
        <Field label="Replay ticks" hint="History used for the four-tick replay.">
          <NumberInput value={config.replayTicks} onChange={num('replayTicks')} step={100} min={100} max={1500} testId="mafia-replay" />
        </Field>
        <Field label="Gate-fired windows needed" hint="Below this the gated replay is not trusted.">
          <NumberInput value={config.minDirectionSamples} onChange={num('minDirectionSamples')} step={10} min={10} max={1000} testId="mafia-min-samples" />
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Evidence gate" description="Off by default: the bot fires the moment uniformity appears. On: the measured four-tick hit rate, haircut for its sample size, must also clear the break-even your hedge ratio needs.">
        <ToggleField
          label="Require positive expected value"
          hint="Off (default): fire on uniformity and show what the pair costs. On: refuse a pair whose expected value per unit staked is below the floor."
          checked={config.requirePositiveExpectedValue}
          onChange={flag('requirePositiveExpectedValue')}
          testId="mafia-ev-gate"
        />
        <Field label="Minimum EV per unit staked" hint="0 means break even.">
          <NumberInput value={config.minExpectedValue} onChange={num('minExpectedValue')} step={0.01} min={-1} max={1} testId="mafia-min-ev" />
        </Field>
        <Field label="Evidence haircut (σ)" hint="Standard errors subtracted from the replay's win rate.">
          <NumberInput value={config.evidenceZ} onChange={num('evidenceZ')} step={0.25} min={0} max={2.58} testId="mafia-evidence-z" />
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Risk limits" description="Counted in pairs. The most a pair can lose is both stakes.">
        <Field label="Open pairs at once" hint="A pair is both legs.">
          <NumberInput value={config.maxOpenPairs} onChange={num('maxOpenPairs')} step={1} min={1} max={5} testId="mafia-max-open" />
        </Field>
        <Field label="Pairs per session" hint="0 means no limit.">
          <NumberInput value={config.maxPairsPerSession} onChange={num('maxPairsPerSession')} step={1} min={0} max={1000} testId="mafia-max-pairs" />
        </Field>
        <Field label="Losing pairs in a row" hint="Stops the session after this many.">
          <NumberInput value={config.maxConsecutiveLosingPairs} onChange={num('maxConsecutiveLosingPairs')} step={1} min={1} max={50} testId="mafia-losing-streak" />
        </Field>
        <Field label={`Daily loss limit (${currency || 'account'})`} hint="Stops the session once reached.">
          <NumberInput value={config.maxDailyLoss} onChange={num('maxDailyLoss')} step={1} min={0} max={100000} testId="mafia-daily-loss" />
        </Field>
        <Field label={`Daily take profit (${currency || 'account'})`} hint="0 means no target.">
          <NumberInput value={config.dailyTakeProfit} onChange={num('dailyTakeProfit')} step={1} min={0} max={100000} testId="mafia-take-profit" />
        </Field>
        <Field label="Session length (minutes)" hint="0 means no time limit.">
          <NumberInput value={config.maxSessionMinutes} onChange={num('maxSessionMinutes')} step={5} min={0} max={1440} testId="mafia-session-minutes" />
        </Field>
        <Field label="Cooldown after a pair (ms)" hint="No new pair until this passes.">
          <NumberInput value={config.cooldownMs} onChange={num('cooldownMs')} step={250} min={0} max={600000} testId="mafia-cooldown" />
        </Field>
        <Field label="Decision interval (ms)" hint="How often the gate is evaluated.">
          <NumberInput value={config.decisionIntervalMs} onChange={num('decisionIntervalMs')} step={250} min={500} max={60000} testId="mafia-interval" />
        </Field>
        <Field label="Max tick age (ms)" hint="A quote older than this is refused.">
          <NumberInput value={config.maxTickAgeMs} onChange={num('maxTickAgeMs')} step={1000} min={2000} max={120000} testId="mafia-tick-age" />
        </Field>
      </ConfigGroup>
    </div>
  );
}

function ActivationDialog({ open, onOpenChange, onConfirm, bot }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  bot: MafiaBotController;
}) {
  const trading = useDerivTrading();
  const currency = bot.accountCurrency;
  const primary = bot.sizing?.primaryStake ?? bot.config.primaryStake;
  const cover = bot.sizing?.coverStake ?? (bot.config.primaryStake * bot.config.hedgeRatioPercent) / 100;
  const worstCase = primary + cover;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Siren size={16} className="text-destructive" /> Activate live Mafia pairs</DialogTitle>
          <DialogDescription>
            Live mode buys two opposite four-tick Rise/Fall contracts on the authorized Deriv account, at the same moment, once every gate passes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[11px] leading-relaxed">
          <div className={`rounded-lg border px-3 py-2 ${trading.activeAccount?.accountType === 'real' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-background/40 text-muted-foreground'}`}>
            <div className="font-semibold">
              {trading.activeAccount === null
                ? 'No Deriv account is authorized yet. Connect one below before the bot can buy.'
                : `${trading.activeAccount.accountType === 'real' ? 'Real' : 'Demo'} account ${trading.activeAccount.accountId} · balance ${formatMoney(trading.balance, currency)}`}
            </div>
            <div className="mt-1">Every confirmed pair settles against that account's balance.</div>
          </div>
          <ul className="space-y-1 text-muted-foreground">
            <li>Market {bot.symbol || '—'} · {MAFIA_DURATION_TICKS}-tick Rise/Fall on a Step index.</li>
            <li>Each pair: primary {formatMoney(primary, currency)} and cover {formatMoney(cover, currency)}. The most a pair can lose is {formatMoney(worstCase, currency)}.</li>
            <li>Both legs enter together. One wins unless the window ends exactly where it started — then both lose.</li>
            <li className="text-amber-600 dark:text-amber-400">
              Both legs enter together, so exactly one wins unless the window ends level — and a level window loses both stakes.
              Deriv quotes both payouts live; the bot prints the two win branches, the level loss and the break-even hit rate beside the evidence it actually has.
            </li>
            <li>Daily loss limit {formatMoney(bot.config.maxDailyLoss, currency)} · take profit {formatMoney(bot.config.dailyTakeProfit, currency)} · losing-pair stop {bot.config.maxConsecutiveLosingPairs}.</li>
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-live-mafia">Keep analysis mode</Button>
          <Button
            variant={trading.activeAccount?.accountType === 'real' ? 'destructive' : 'default'}
            disabled={trading.activeAccount === null}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            data-testid="button-confirm-live-mafia"
          >
            Activate live pairs
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ControlPanel({ bot }: { bot: MafiaBotController }) {
  const [showConfig, setShowConfig] = useState(false);
  const [activationOpen, setActivationOpen] = useState(false);
  const running = bot.runState === 'running';
  const paused = bot.runState === 'paused';
  const stopped = bot.runState === 'idle' || bot.runState === 'stopped';
  const currency = bot.accountCurrency;
  const summary = bot.summary;
  const session = bot.sessionSummary;

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="mafia-control-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-primary"><Skull size={18} /></span>
          <div>
            <div className="eyebrow">Premium bot · step indices · 4 ticks</div>
            <h2 className="mt-1 text-lg font-bold tracking-tight">Mafia bot — two-sided Rise/Fall pairs</h2>
            <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
              Waits for a Step index whose ticks are directionally uniform, measures how often that direction survived four ticks, then buys a Rise and a Fall
              contract of {MAFIA_DURATION_TICKS} ticks at the same moment. One leg pays unless the window ends level. The pair is only bought when the measured
              probability clears the break-even its own sizing creates.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <DerivConnectionStatusBadge />
          <span className={`mono rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${running ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-border bg-background/60 text-muted-foreground'}`} data-testid="mafia-status">
            {running ? 'Running' : paused ? 'Paused' : 'Stopped'}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {stopped || paused ? (
          <Button onClick={paused ? bot.resume : bot.start} className="gap-2" data-testid="button-mafia-start">
            <Play size={14} fill="currentColor" />{paused ? 'Resume bot' : 'Start bot'}
          </Button>
        ) : (
          <Button variant="secondary" onClick={bot.pause} className="gap-2" data-testid="button-mafia-pause"><Pause size={14} />Pause bot</Button>
        )}
        <Button variant="outline" onClick={bot.stop} disabled={stopped} className="gap-2" data-testid="button-mafia-stop"><CircleStop size={14} />Stop bot</Button>
        <Button variant="outline" onClick={bot.runCycleNow} disabled={!running} className="gap-2" data-testid="button-mafia-cycle">
          <Gauge size={14} />Run cycle now
        </Button>
        <Button variant="ghost" onClick={() => setShowConfig((value) => !value)} className="gap-2" data-testid="button-mafia-config">
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
              data-testid={`mafia-mode-${id}`}
            >
              <span className="flex items-center gap-2 text-xs font-bold"><Icon size={14} className={active ? 'text-primary' : 'text-muted-foreground'} />{label}</span>
              <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{blurb}</span>
              {active ? <span className="mono mt-2 block text-[9px] font-bold uppercase tracking-[0.08em] text-primary">Active mode</span> : null}
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="mafia-stats">
        <StatTile
          label="Total P/L (realised)"
          value={formatSignedMoney(summary.realisedProfit, currency)}
          tone={pnlTone(summary.realisedProfit)}
          hint={`${summary.settled} settled · ${summary.open} open · ${formatMoney(summary.openStake, currency)} at risk`}
          testId="mafia-total-pnl"
        />
        <StatTile
          label="Session P/L"
          value={formatSignedMoney(session.realisedProfit, currency)}
          tone={pnlTone(session.realisedProfit)}
          hint={`${session.wins}W / ${session.losses}L · ${session.settled} settled this session`}
          testId="mafia-session-pnl"
        />
        <StatTile label="Balance" value={formatMoney(bot.balance, currency)} hint={bot.connected ? (bot.accountType === 'real' ? 'Real account' : 'Demo account') : 'No account connected'} testId="mafia-balance" />
        <StatTile
          label="Open pairs"
          value={`${summary.open}`}
          hint={bot.purchaseInFlight ? 'purchase in progress' : bot.unreconciledPurchase ? 'reconciling a purchase' : `${session.pairs} this session · limit ${bot.config.maxOpenPairs}`}
          testId="mafia-open"
        />
      </div>

      {bot.sessionStopReason ? (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400" data-testid="mafia-session-stop">
          <ShieldAlert size={12} className="mr-1 inline" />{bot.sessionStopReason} No new pair will open until the bot is restarted.
        </div>
      ) : null}

      {showConfig ? <BotConfiguration bot={bot} /> : null}

      <ActivationDialog
        open={activationOpen}
        onOpenChange={setActivationOpen}
        onConfirm={() => bot.setMode('live')}
        bot={bot}
      />
    </section>
  );
}

/** Uniformity, the replay and the pair arithmetic — the numbers the gate acted on. */
function SignalPanel({ bot }: { bot: MafiaBotController }) {
  const analysis = bot.analysis;
  const uniformity = analysis.uniformity;
  const replay = analysis.replay;
  const gated = bot.gated;
  const economics = bot.economics;
  const pricing = bot.pricing;
  const decision = bot.decision;
  const currency = bot.accountCurrency;
  const scoreTone: Tone = uniformity.score >= bot.config.minUniformity ? 'good' : 'default';

  return (
    <Panel
      eyebrow="Live signal"
      title="Uniformity, the four-tick replay, and the pair price"
      icon={<Activity size={16} />}
      testId="mafia-signal"
      aside={
        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold ${bot.feedFresh ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'}`} data-testid="mafia-feed-health" aria-live="polite">
          <span className={`inline-block h-2 w-2 rounded-full ${bot.feedFresh ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          {bot.feedFresh ? `Live · ${bot.tickCount} ticks` : `Feed ${bot.feedStatus}`}
        </span>
      }
    >
      {bot.feedError || bot.precisionError ? (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">{bot.feedError || bot.precisionError}</div>
      ) : null}
      {!bot.symbolAllowed ? (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
          {bot.symbol || 'This market'} is not a Step index. The Mafia bot moves the feed to a Step index and will not trade anything else.
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="mafia-uniformity">
        <StatTile
          label="Uniform direction"
          value={uniformity.direction ? MAFIA_DIRECTION_LABELS[uniformity.direction] : 'None'}
          tone={uniformity.direction ? 'good' : 'default'}
          hint={uniformity.available ? `${uniformity.regime} tape · ${uniformity.sampleSize} ticks` : 'not enough ticks'}
          testId="mafia-direction"
        />
        <StatTile label="Uniformity score" value={formatPercent(uniformity.score, 1)} tone={scoreTone} hint={`floor ${bot.config.minUniformity.toFixed(2)}`} testId="mafia-score" />
        <StatTile label="Directional z" value={uniformity.directionalZ.toFixed(2)} hint={`needs ±${bot.config.minUniformityZ.toFixed(2)}`} testId="mafia-directional-z" />
        <StatTile label="Persistence z" value={uniformity.persistenceZ.toFixed(2)} hint={`needs ≥ ${bot.config.minUniformityZ.toFixed(2)}`} testId="mafia-persistence-z" />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3" data-testid="mafia-tick-mix">
        <StatTile label="Up ticks" value={formatPercent(uniformity.upShare, 1)} hint={`${uniformity.upTicks} of ${uniformity.upTicks + uniformity.downTicks + uniformity.flatTicks} moves`} />
        <StatTile label="Down ticks" value={formatPercent(uniformity.downShare, 1)} hint={`${uniformity.downTicks} moves`} />
        <StatTile label="Flat ticks" value={formatPercent(uniformity.flatShare, 1)} hint={`${uniformity.flatTicks} moves · flat windows lose both legs`} />
      </div>

      <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px]" data-testid="mafia-replay">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="eyebrow">Four-tick replay</span>
          <span className="mono text-[10px] text-muted-foreground">{replay.samples} printed windows</span>
        </div>
        <div className="mono mt-2 grid gap-1 sm:grid-cols-2">
          <span>rise → {formatPercent(replay.riseProbability, 1)}</span>
          <span>fall → {formatPercent(replay.fallProbability, 1)}</span>
          <span>level → {formatPercent(replay.flatProbability, 1)}</span>
          <span>gate-fired windows → {gated.samples} ({formatPercent(gated.winRate, 1)} went the gated way)</span>
        </div>
        <div className="mt-2 space-y-1 text-[10px] leading-relaxed text-muted-foreground">
          {replay.reasons.slice(0, 2).map((reason) => <p key={reason}>{reason}</p>)}
          {gated.reasons.slice(0, 1).map((reason) => <p key={reason}>{reason}</p>)}
        </div>
      </div>

      {pricing ? (
        <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px]" data-testid="mafia-pair-pricing">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="eyebrow">Both legs, priced by Deriv</span>
            <span className="mono text-[10px] text-muted-foreground">{formatClock(pricing.at)}</span>
          </div>
          <div className="mono mt-2 grid gap-1 sm:grid-cols-2">
            <span>primary {directionBadge(pricing.primary.direction, 'xs')} ask {formatMoney(pricing.primary.ask, currency)} · payout {formatMoney(pricing.primary.payout, currency)}</span>
            <span>cover {directionBadge(pricing.cover.direction, 'xs')} ask {formatMoney(pricing.cover.ask, currency)} · payout {formatMoney(pricing.cover.payout, currency)}</span>
          </div>
          {pricing.notes.length ? <div className="mt-2"><ReasonList reasons={pricing.notes} limit={3} tone="warn" /></div> : null}
        </div>
      ) : null}

      {economics ? (
        <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px]" data-testid="mafia-economics">
          <div className="eyebrow">Pair arithmetic</div>
          <div className="mono mt-2 grid gap-1 sm:grid-cols-2">
            <span>pair cost {formatMoney(economics.totalCost, currency)}</span>
            <span>primary wins → {formatSignedMoney(economics.primaryWinProfit, currency)}</span>
            <span>cover wins → {formatSignedMoney(economics.coverWinProfit, currency)}</span>
            <span>level window → {formatSignedMoney(economics.flatLoss, currency)}</span>
            <span>break-even hit rate → {formatPercent(economics.breakEvenProbability, 1)}</span>
            <span>evidence after haircut → {formatPercent(bot.evidence, 1)}</span>
            <span>expected value → {formatSignedMoney(economics.expectedValue, currency)}</span>
            <span>per unit staked → {economics.expectedValuePerStake === null ? '—' : economics.expectedValuePerStake.toFixed(4)}</span>
          </div>
          <div className="mt-2"><ReasonList reasons={economics.reasons} limit={3} /></div>
        </div>
      ) : null}

      {decision ? (
        <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2" data-testid="mafia-decision">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="eyebrow">Decision</span>
            <span className={`mono rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${decision.action === 'TRADE' ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : decision.action === 'BLOCKED' ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'}`}>
              {decision.actionLabel}
            </span>
          </div>
          {decision.direction ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
              {directionBadge(decision.direction)}
              <span className="mono text-muted-foreground">
                primary {formatMoney(decision.primaryStake, currency)} · cover {formatMoney(decision.coverStake, currency)}
              </span>
            </div>
          ) : null}
          <div className="mt-2"><ReasonList reasons={decision.reasons} limit={6} /></div>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground" data-testid="mafia-firing-rule">
            Firing rule: {bot.config.requirePositiveExpectedValue ? 'uniformity + positive expected value' : 'uniformity only — expected-value gate off'} ·
            {' '}{MAFIA_DURATION_TICKS}-tick legs · both directions bought in the same cycle.
          </p>
          {decision.reasonCodes.length ? (
            <p className="mono mt-2 text-[9px] uppercase tracking-[0.06em] text-muted-foreground">{decision.reasonCodes.join(' · ')}</p>
          ) : null}
        </div>
      ) : null}

      {bot.cycleError ? (
        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          <AlertTriangle size={12} className="mr-1 inline" />{bot.cycleError}
        </div>
      ) : null}
    </Panel>
  );
}

function LegRow({ leg, pairId, bot }: { leg: MafiaLeg; pairId: string; bot: MafiaBotController }) {
  const settled = leg.profit !== null;
  const bought = leg.contractId !== null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-background/30 px-2.5 py-1.5 text-[11px]">
      <div className="flex items-center gap-2">
        {directionBadge(leg.direction, 'xs')}
        <span className="mono text-muted-foreground">{LEG_LABEL[leg.side]} · stake {formatMoney(leg.stake, bot.accountCurrency)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="mono">
          {settled ? formatSignedMoney(leg.profit, bot.accountCurrency) : bought ? `#${leg.contractId} open` : leg.status === 'pending' ? 'awaiting reply' : 'not bought'}
        </span>
        {bought && !settled ? (
          <Button size="sm" variant="outline" onClick={() => void bot.closeLeg(pairId, leg.side)} data-testid={`button-mafia-close-${leg.side}`}>Sell</Button>
        ) : null}
      </div>
    </div>
  );
}

function PositionsPanel({ bot }: { bot: MafiaBotController }) {
  const open = bot.pairs.filter(isPairOpen);
  return (
    <Panel
      eyebrow="Positions"
      title="Open pairs on the account"
      icon={<Activity size={16} />}
      testId="mafia-positions"
      aside={<span className="mono text-[10px] text-muted-foreground">{open.length} pair(s)</span>}
    >
      {bot.unreconciledPurchase ? (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          A purchase reply did not arrive. The bot is matching it against the account; no new pair opens until that resolves.
        </div>
      ) : null}
      {open.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No open pairs. A pair appears here once Deriv confirms both legs.</p>
      ) : (
        <div className="space-y-2">
          {open.map((row) => (
            <div key={row.id} className="space-y-2 rounded-lg border border-border bg-background/40 p-3" data-testid="mafia-pair-row">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="mono">{row.symbol} · {formatClock(row.at)} · {MAFIA_DURATION_TICKS} ticks</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] ${STATUS_TONE[row.status] ?? ''}`}>{STATUS_LABEL[row.status] ?? row.status}</span>
              </div>
              <LegRow leg={row.primary} pairId={row.id} bot={bot} />
              <LegRow leg={row.cover} pairId={row.id} bot={bot} />
              {row.note ? <p className="text-[10px] leading-relaxed text-muted-foreground">{row.note}</p> : null}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** The total profit/loss breakdown the operator asked for, per leg and per pair. */
function ProfitPanel({ bot }: { bot: MafiaBotController }) {
  const summary = bot.summary;
  const session = bot.sessionSummary;
  const currency = bot.accountCurrency;
  return (
    <Panel
      eyebrow="Profit and loss"
      title="Total, per leg, and per pair"
      icon={<Gauge size={16} />}
      testId="mafia-profit"
      aside={<span className="mono text-[10px] text-muted-foreground">{summary.pairs} pair(s) recorded</span>}
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Total realised P/L"
          value={formatSignedMoney(summary.realisedProfit, currency)}
          tone={pnlTone(summary.realisedProfit)}
          hint={`${summary.settled} settled pairs`}
          testId="mafia-pl-total"
        />
        <StatTile
          label="Primary leg P/L"
          value={formatSignedMoney(summary.primaryLegProfit, currency)}
          tone={pnlTone(summary.primaryLegProfit)}
          hint={`${summary.primaryWins} primary wins · the analysed direction`}
          testId="mafia-pl-primary"
        />
        <StatTile
          label="Cover leg P/L"
          value={formatSignedMoney(summary.coverLegProfit, currency)}
          tone={pnlTone(summary.coverLegProfit)}
          hint={`${summary.coverWins} cover wins`}
          testId="mafia-pl-cover"
        />
        <StatTile
          label="Level windows"
          value={`${summary.flatWindows}`}
          tone={summary.flatWindows > 0 ? 'warn' : 'default'}
          hint="Both legs lost on these"
          testId="mafia-pl-flat"
        />
        <StatTile label="Wins / losses" value={`${summary.wins} / ${summary.losses}`} hint={summary.pushes ? `${summary.pushes} push` : 'pair results'} testId="mafia-pl-record" />
        <StatTile label="Average pair" value={formatSignedMoney(summary.averagePairNet, currency)} tone={pnlTone(summary.averagePairNet)} hint={`best ${formatSignedMoney(summary.bestPair, currency)} · worst ${formatSignedMoney(summary.worstPair, currency)}`} testId="mafia-pl-average" />
        <StatTile label="Return on stake" value={formatPercent(summary.returnOnStake === null ? null : summary.returnOnStake * 100, 1)} tone={pnlTone(summary.returnOnStake)} hint={`on ${formatMoney(summary.grossStakeSettled, currency)} settled stake`} testId="mafia-pl-ros" />
        <StatTile label="Losing streak" value={`${summary.currentLosingStreak}`} tone={summary.currentLosingStreak > 0 ? 'warn' : 'default'} hint={`longest ${summary.longestLosingStreak} · stop at ${bot.config.maxConsecutiveLosingPairs}`} testId="mafia-pl-streak" />
      </div>

      <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px]" data-testid="mafia-session-summary">
        <div className="eyebrow">This session</div>
        <div className="mono mt-1 grid gap-1 sm:grid-cols-2">
          <span>pairs bought → {session.pairs}</span>
          <span>settled → {session.settled}</span>
          <span>net → {formatSignedMoney(session.realisedProfit, currency)}</span>
          <span>open stake → {formatMoney(session.openStake, currency)}</span>
        </div>
        {bot.sessionMinutesRemaining !== null ? (
          <p className="mt-1 text-[10px] text-muted-foreground">{bot.sessionMinutesRemaining} minute(s) left in the configured session.</p>
        ) : null}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Realised P/L counts only money Deriv has reported. Open legs are shown as stake at risk, never as profit. Whether a winning pair nets a profit depends on
        the payout Deriv quoted against both stakes — the arithmetic panel shows the two branches for the current pair instead of assuming a payout.
      </p>
    </Panel>
  );
}

/** Whether the gate's own picks are landing where it says they will. */
function PredictionPanel({ bot }: { bot: MafiaBotController }) {
  const summary = bot.predictionSummary;
  return (
    <Panel eyebrow="Rule record" title="How the gate's picks have landed" icon={<FlaskConical size={16} />} testId="mafia-predictions">
      <div className="grid gap-2 sm:grid-cols-2">
        <StatTile
          label="Gated direction hit rate"
          value={formatPercent(summary.hitRate, 1)}
          hint={`${summary.wins} of ${summary.resolved} scored entries`}
          testId="mafia-prediction-hit"
        />
        <StatTile
          label="Level windows"
          value={formatPercent(summary.flatRate, 1)}
          hint={`${summary.flats} entries ended flat — both legs would have lost`}
          testId="mafia-prediction-flat"
        />
        <StatTile label="Entries scored" value={`${summary.resolved}`} hint={`${summary.pending} pending`} />
        <StatTile label="Break-even to beat" value={formatPercent(bot.breakEven, 1)} hint="from the live quotes and the current hedge ratio" testId="mafia-prediction-break-even" />
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Every uniformity pass is recorded whether or not a pair was bought, so this describes the rule rather than the trades the money rules happened to allow.
        A hit rate below the break-even means the gate is not paying for the hedge at this ratio — not that the next pair is due.
      </p>
    </Panel>
  );
}

function TradeLogPanel({ bot }: { bot: MafiaBotController }) {
  const rows = [...bot.pairs].reverse().slice(0, 25);
  return (
    <Panel
      eyebrow="Pair log"
      title="Every pair this browser recorded"
      icon={<Terminal size={16} />}
      testId="mafia-trade-log"
      aside={
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCsv(MAFIA_LOG_FILENAME, bot.pairsCsv)} disabled={!bot.pairs.length} className="gap-2" data-testid="button-mafia-download">
            <Download size={13} />CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={bot.clearTradeLog} disabled={!bot.pairs.length && !bot.predictions.length} className="gap-2" data-testid="button-mafia-clear">
            <Trash2 size={13} />Clear
          </Button>
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No pairs recorded yet. Analysis-mode entries are scored in the rule record panel.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[11px]">
            <thead className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-semibold">Time</th>
                <th className="py-1.5 pr-3 font-semibold">Direction</th>
                <th className="py-1.5 pr-3 font-semibold">Status</th>
                <th className="py-1.5 pr-3 font-semibold">Stakes</th>
                <th className="py-1.5 pr-3 font-semibold">Hit rate</th>
                <th className="py-1.5 pr-3 font-semibold">EV</th>
                <th className="py-1.5 pr-3 font-semibold">Net</th>
              </tr>
            </thead>
            <tbody className="mono">
              {rows.map((row: MafiaPair) => (
                <tr key={row.id} className="border-t border-border/60" data-testid="mafia-log-row">
                  <td className="py-1.5 pr-3">{formatClock(row.at)}</td>
                  <td className="py-1.5 pr-3">{row.direction ? MAFIA_DIRECTION_LABELS[row.direction] : '—'}</td>
                  <td className="py-1.5 pr-3">{STATUS_LABEL[row.status] ?? row.status}</td>
                  <td className="py-1.5 pr-3">{formatMoney(row.primary.stake, bot.accountCurrency)} + {formatMoney(row.cover.stake, bot.accountCurrency)}</td>
                  <td className="py-1.5 pr-3">{formatPercent(row.probability, 1)}</td>
                  <td className="py-1.5 pr-3">{row.expectedValue === null ? '—' : formatSignedMoney(row.expectedValue, bot.accountCurrency)}</td>
                  <td className={`py-1.5 pr-3 ${row.netProfit === null ? '' : row.netProfit > 0 ? 'text-emerald-600 dark:text-emerald-400' : row.netProfit < 0 ? 'text-destructive' : ''}`}>
                    {row.netProfit === null ? '—' : formatSignedMoney(row.netProfit, bot.accountCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Showing the latest 25 of {bot.pairs.length}. Each leg is settled by Deriv on its own; a pair is complete only when both have reported.
      </p>
    </Panel>
  );
}

function DecisionLogPanel({ bot }: { bot: MafiaBotController }) {
  return (
    <Panel eyebrow="Decision log" title="Each cycle, in order" icon={<Terminal size={16} />} testId="mafia-decision-log">
      {bot.cycleLog.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No decision cycle has run yet.</p>
      ) : (
        <ol className="space-y-2 text-[11px]">
          {bot.cycleLog.slice(0, 20).map((row) => (
            <li key={row.id} className="rounded-lg border border-border/70 bg-background/30 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="mono text-muted-foreground">{formatClock(row.at)} · {row.symbol}</span>
                <span className="mono font-semibold">{row.actionLabel}</span>
              </div>
              {row.reasons.length ? <div className="mt-1"><ReasonList reasons={row.reasons} limit={3} /></div> : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** The arithmetic, stated once, plainly. No edge is claimed that the payouts do not support. */
function HonestyPanel({ bot }: { bot: MafiaBotController }) {
  const primary = bot.sizing?.primaryStake ?? bot.config.primaryStake;
  const cover = bot.sizing?.coverStake ?? (bot.config.primaryStake * bot.config.hedgeRatioPercent) / 100;
  const currency = bot.accountCurrency;

  /**
   * The three figures that decide whether a pair can pay, all from the live
   * quote rather than a constant: the payout multiple, the equal-stake result,
   * and the level-window share above which an equal pair stops breaking even.
   */
  const arithmetic = useMemo(() => {
    const ask = bot.pricing?.primary.ask ?? null;
    const payout = bot.pricing?.primary.payout ?? null;
    const multiple = ask !== null && ask > 0 && payout !== null ? payout / ask : null;
    const equalStake = multiple === null ? null : Math.round((multiple * primary - primary * 2) * 100) / 100;
    // Equal stakes: EV > 0 ⇔ (1 − f)·(m − 2)·s > f·2s ⇔ f < (m − 2) / m.
    const levelCeiling = multiple === null || multiple <= 2 ? null : (multiple - 2) / multiple;
    const levelSeen = bot.analysis.replay.flatProbability;
    return { multiple, equalStake, levelCeiling, levelSeen };
  }, [bot.pricing?.primary.ask, bot.pricing?.primary.payout, bot.analysis.replay.flatProbability, primary]);

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="mafia-limits">
      <div className="flex items-center gap-2">
        <ShieldAlert size={15} className="text-primary" />
        <h3 className="text-sm font-bold">What this bot will and will not do</h3>
      </div>
      <ul className="mt-3 grid gap-2 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-2">
        <li>It trades <strong className="text-foreground">Step indices only</strong>, in {MAFIA_DURATION_TICKS}-tick Rise/Fall. Any other market is refused, including the 1-second indices.</li>
        <li>Both legs are bought in the same request round on the same tick. If the entry ticks differ, the pair is flagged in its note rather than passed off as hedged.</li>
        <li>It measures direction two ways — tick-sign uniformity and a four-tick replay — and keeps the level windows in the sample, because those are the windows where both legs lose.</li>
        <li>
          Paying well or not is decided by the quote, not by the bot. Deriv is quoting {arithmetic.multiple === null ? '—' : `${arithmetic.multiple.toFixed(2)}×`} per leg right now,
          so an equal-stake pair of {formatMoney(primary, currency)} + {formatMoney(primary, currency)} would return {formatMoney(arithmetic.equalStake, currency)} on a winning pair
          and lose {formatMoney(primary * 2, currency)} on a level one.
        </li>
        <li>
          A level window loses both legs, so an equal pair only breaks even while level windows stay below
          {' '}{arithmetic.levelCeiling === null ? '— (the quote is under 2×, so no share works)' : formatPercent(arithmetic.levelCeiling * 100, 1)}.
          The replay currently measures {formatPercent(arithmetic.levelSeen === null ? null : arithmetic.levelSeen * 100, 1)}.
        </li>
        <li>The current pair is {formatMoney(primary, currency)} primary + {formatMoney(cover, currency)} cover, which needs a {formatPercent(bot.breakEven, 1)} hit rate to break even at these quotes.</li>
        <li>The bot fires as soon as the uniformity gate passes, then reports what the pair costs. That is a signal, not an edge.</li>
        <li>Only Deriv settlements move the ledger. A running profit is never counted as earned, and no payout is estimated.</li>
        <li>Every rule runs in this browser. Your token, account id and balance are never sent to a third party.</li>
      </ul>
    </section>
  );
}

export function MafiaBot() {
  const bot = useMafiaBot();

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-4 animate-rise-in" data-testid="mafia-bot">
      <ControlPanel bot={bot} />

      {bot.accountCurrency === '' ? (
        <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="mafia-authorization">
          <div className="eyebrow">Deriv authorization</div>
          <h3 className="mt-1 text-sm font-bold">Connect a Deriv account to buy live pairs</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            The bot reuses this application's existing Deriv connection. Analysis mode works without an account, but live quotes need the authorized session.
          </p>
          <div className="mt-3"><DerivConnectionCard /></div>
        </section>
      ) : null}

      <SignalPanel bot={bot} />
      <PositionsPanel bot={bot} />
      <ProfitPanel bot={bot} />
      <div className="grid gap-4 xl:grid-cols-2">
        <PredictionPanel bot={bot} />
        <TradeLogPanel bot={bot} />
      </div>
      <DecisionLogPanel bot={bot} />
      <HonestyPanel bot={bot} />
    </div>
  );
}
