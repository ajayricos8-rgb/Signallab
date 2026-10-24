// The High/Low Tick hedging premium bot panel.
//
// Every pair is two purchases taken at the same moment on the same market: a
// High Tick (TICKHIGH) and a Low Tick (TICKLOW) on the same 5-tick window. The
// bot chooses which tick position each leg predicts from the verified history,
// and nothing here is a forecast. Figures come from the engine modules and from
// Deriv; the only estimate shown is the expected value the gate itself applied.
import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CircleStop,
  Download,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  Scale,
  Settings2,
  ShieldAlert,
  Siren,
  Terminal,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DerivConnectionCard, DerivConnectionStatusBadge } from '@/components/deriv-connection-card';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { useHedgingBot, type HedgingBotController, type LegPricing, type PairPricing } from '@/hooks/use-hedging-bot';
import { Panel, ReasonList, StatTile, formatClock, formatMoney, formatPercent, formatSignedMoney } from '@/components/premium-bot/bot-panels';
import { ConfigGroup, Field, NumberInput, SelectInput, ToggleField } from '@/components/premium-bot/bot-form';
import { HEDGE_LOG_FILENAME, isPairOpen } from '@/lib/hedging-bot/ledger';
import type { LegChoice } from '@/lib/hedging-bot/selection';
import {
  HEDGE_SIDE_LABELS,
  HEDGE_WINDOW_TICKS,
  type HedgePair,
  type HedgeLeg,
  type HedgeSide,
  type HedgingBotConfig,
  type HedgingBotMode,
} from '@/lib/hedging-bot/types';

const MODE_DETAILS: Array<{ id: HedgingBotMode; label: string; blurb: string; icon: typeof Terminal }> = [
  { id: 'analysis', label: 'Analysis only', blurb: 'Chooses the two tick positions, records each entry, and scores it against the ticks that followed. Live payouts are quoted, but no order is sent.', icon: Terminal },
  { id: 'live', label: 'Live hedging', blurb: 'Buys a High Tick and a Low Tick together on the authorized Deriv account once the expected-value and risk gates pass.', icon: TrendingUp },
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
  partial: 'Partial',
  rejected: 'Not bought',
  unreconciled: 'Reconciling',
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

function sideBadge(side: HedgeSide) {
  const Icon = side === 'HIGH' ? ArrowUpRight : ArrowDownRight;
  const tone = side === 'HIGH'
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    : 'border-destructive/40 bg-destructive/10 text-destructive';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.06em] ${tone}`}>
      <Icon size={11} />
      {HEDGE_SIDE_LABELS[side]}
    </span>
  );
}

type Tone = 'default' | 'good' | 'warn' | 'bad';

function pnlTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined) return 'default';
  return value > 0 ? 'good' : value < 0 ? 'bad' : 'default';
}

type NumericConfigKey = {
  [K in keyof HedgingBotConfig]: HedgingBotConfig[K] extends number ? K : never;
}[keyof HedgingBotConfig];
type BooleanConfigKey = {
  [K in keyof HedgingBotConfig]: HedgingBotConfig[K] extends boolean ? K : never;
}[keyof HedgingBotConfig];

/** Full operator configuration. Collapsed by default while the bot runs. */
function BotConfiguration({ bot }: { bot: HedgingBotController }) {
  const config = bot.config;
  const currency = bot.accountCurrency;
  const pipLabel = bot.pipSize === null ? 'pip size unverified for this symbol' : `1 pip = ${bot.pipSize} on ${bot.symbol || 'this symbol'}`;
  const num = (key: NumericConfigKey) => (value: number) => bot.updateConfig({ [key]: value } as Partial<HedgingBotConfig>);
  const flag = (key: BooleanConfigKey) => (value: boolean) => bot.updateConfig({ [key]: value } as Partial<HedgingBotConfig>);
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4" data-testid="hedging-config">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Settings are stored in this browser only. They never include a token, an account id or a socket URL. {pipLabel}.
        </p>
        <Button variant="ghost" size="sm" onClick={bot.resetConfig} className="gap-2" data-testid="button-hedging-reset-config">
          <RefreshCw size={13} />Reset to defaults
        </Button>
      </div>

      <ConfigGroup title="Market and stake" description="Each pair is two legs of the same stake. The balance share caps both legs together.">
        <Field label="Market" hint={bot.marketName || 'No active symbol metadata'}>
          <SelectInput
            value={bot.symbol}
            onChange={bot.selectSymbol}
            disabled={!bot.symbols.length}
            testId="hedging-symbol"
            options={bot.symbols.length
              ? bot.symbols.map((symbol) => ({ value: symbol.symbol, label: `${symbol.name} · ${symbol.symbol}` }))
              : [{ value: '', label: 'Loading Deriv active symbols…' }]}
          />
        </Field>
        <Field label={`Stake per leg (${currency || 'account currency'})`} hint={`Minimum ${config.minStakePerLeg.toFixed(2)}`}>
          <NumberInput value={config.stakePerLeg} onChange={num('stakePerLeg')} step={0.1} min={config.minStakePerLeg} testId="hedging-stake" />
        </Field>
        <Field label="Max stake per leg" hint="Upper bound before the balance share applies.">
          <NumberInput value={config.maxStakePerLeg} onChange={num('maxStakePerLeg')} step={1} min={0.35} testId="hedging-max-stake" />
        </Field>
        <Field label="Balance share per pair (%)" hint="Both legs together, so each leg gets half.">
          <NumberInput value={config.maxStakeShareOfBalance} onChange={num('maxStakeShareOfBalance')} step={0.5} min={0.5} max={50} testId="hedging-share" />
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Tick selection" description="The replay scores each tick position over the most recent verified ticks.">
        <ToggleField
          label="Choose tick positions automatically"
          hint="Off: use the two manual positions below."
          checked={config.autoSelectTicks}
          onChange={flag('autoSelectTicks')}
          testId="hedging-auto-select"
        />
        <Field label="High Tick position (manual)" hint={`1 to ${HEDGE_WINDOW_TICKS}`}>
          <NumberInput value={config.manualHighTick} onChange={num('manualHighTick')} step={1} min={1} max={HEDGE_WINDOW_TICKS} testId="hedging-manual-high" />
        </Field>
        <Field label="Low Tick position (manual)" hint={`1 to ${HEDGE_WINDOW_TICKS}`}>
          <NumberInput value={config.manualLowTick} onChange={num('manualLowTick')} step={1} min={1} max={HEDGE_WINDOW_TICKS} testId="hedging-manual-low" />
        </Field>
        <Field label="Ticks replayed" hint="Most recent verified ticks used for the replay.">
          <NumberInput value={config.selectionTicks} onChange={num('selectionTicks')} step={50} min={20} max={2000} testId="hedging-selection-ticks" />
        </Field>
        <Field label="Windows before auto choice" hint="Below this, automatic selection is withheld.">
          <NumberInput value={config.minSelectionWindows} onChange={num('minSelectionWindows')} step={10} min={1} max={2000} testId="hedging-min-windows" />
        </Field>
        <Field label="Minimum edge (z)" hint="Standard errors above the 20% baseline.">
          <NumberInput value={config.minTickEdgeZ} onChange={num('minTickEdgeZ')} step={0.5} min={0} max={10} testId="hedging-min-z" />
        </Field>
        <Field label="Ticks before first pair" hint="Verified ticks collected before trading.">
          <NumberInput value={config.minTicksBeforeTrade} onChange={num('minTicksBeforeTrade')} step={10} min={0} max={2000} testId="hedging-warmup" />
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Expected-value gate" description="A pair is bought only if its live payouts make the expected value of the pair at least the minimum.">
        <ToggleField
          label="Require positive expected value"
          hint="When off, the pair is bought without an EV requirement."
          checked={config.requirePositiveExpectedValue}
          onChange={flag('requirePositiveExpectedValue')}
          testId="hedging-ev-gate"
        />
        <Field label="Minimum EV per unit staked" hint="0 means break even.">
          <NumberInput value={config.minExpectedValue} onChange={num('minExpectedValue')} step={0.01} min={-1} max={1} testId="hedging-min-ev" />
        </Field>
      </ConfigGroup>

      <ConfigGroup title="Limits" description="Limits are counted in pairs; the most a pair can lose is both stakes.">
        <Field label="Open pairs at once" hint="A hedge is one pair; keep this at 1 unless you want several.">
          <NumberInput value={config.maxOpenPairs} onChange={num('maxOpenPairs')} step={1} min={1} max={10} testId="hedging-max-open" />
        </Field>
        <Field label="Pairs per session" hint="0 means no limit.">
          <NumberInput value={config.maxPairsPerSession} onChange={num('maxPairsPerSession')} step={1} min={0} max={1000} testId="hedging-max-pairs" />
        </Field>
        <Field label="Losing pairs in a row" hint="Stops the bot after this many.">
          <NumberInput value={config.maxConsecutiveLosingPairs} onChange={num('maxConsecutiveLosingPairs')} step={1} min={1} max={50} testId="hedging-losing-streak" />
        </Field>
        <Field label={`Daily loss limit (${currency || 'account'})`} hint="Stops the bot once reached.">
          <NumberInput value={config.maxDailyLoss} onChange={num('maxDailyLoss')} step={1} min={0} max={100000} testId="hedging-daily-loss" />
        </Field>
        <Field label={`Daily take profit (${currency || 'account'})`} hint="0 means no target.">
          <NumberInput value={config.dailyTakeProfit} onChange={num('dailyTakeProfit')} step={1} min={0} max={100000} testId="hedging-take-profit" />
        </Field>
        <Field label="Session length (minutes)" hint="0 means no time limit.">
          <NumberInput value={config.maxSessionMinutes} onChange={num('maxSessionMinutes')} step={5} min={0} max={1440} testId="hedging-session-minutes" />
        </Field>
        <Field label="Cooldown after a settlement (ms)" hint="No new pair until this passes.">
          <NumberInput value={config.cooldownMs} onChange={num('cooldownMs')} step={500} min={0} max={600000} testId="hedging-cooldown" />
        </Field>
        <Field label="Watchdog interval (ms)" hint="Every new tick is evaluated immediately; this interval only re-checks a quiet feed.">
          <NumberInput value={config.decisionIntervalMs} onChange={num('decisionIntervalMs')} step={250} min={500} max={60000} testId="hedging-interval" />
        </Field>
        <Field label="Max tick age (ms)" hint="A quote older than this is refused.">
          <NumberInput value={config.maxTickAgeMs} onChange={num('maxTickAgeMs')} step={1000} min={1000} max={120000} testId="hedging-tick-age" />
        </Field>
      </ConfigGroup>
    </div>
  );
}

function ActivationDialog({ open, onOpenChange, onConfirm, bot }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  bot: HedgingBotController;
}) {
  const trading = useDerivTrading();
  const currency = bot.accountCurrency;
  const worstCase = bot.stakePerLeg === null ? null : bot.stakePerLeg * 2;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Siren size={16} className="text-destructive" /> Activate live hedging</DialogTitle>
          <DialogDescription>
            Live mode buys a High Tick and a Low Tick together on the authorized Deriv account. Review these settings before continuing.
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
            <li>Market {bot.symbol || '—'} · {HEDGE_WINDOW_TICKS}-tick window for both legs.</li>
            <li>Each pair: a High Tick and a Low Tick of {formatMoney(bot.stakePerLeg, currency)} each. The most a pair can lose is {formatMoney(worstCase, currency)}.</li>
            <li>Pairs are bought only when the expected value of both legs together is at least {bot.config.minExpectedValue.toFixed(2)} per unit staked.</li>
            <li>Daily loss limit {formatMoney(bot.config.maxDailyLoss, currency)} · daily take profit {formatMoney(bot.config.dailyTakeProfit, currency)} · losing-pair stop {bot.config.maxConsecutiveLosingPairs}.</li>
            <li className="text-amber-600 dark:text-amber-400">Both legs lose together in most windows. A hedge reduces the swing, not the expected loss: each leg carries the house edge.</li>
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-live-hedging">Keep analysis mode</Button>
          <Button
            variant={trading.activeAccount?.accountType === 'real' ? 'destructive' : 'default'}
            disabled={trading.activeAccount === null}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            data-testid="button-confirm-live-hedging"
          >
            Activate live hedging
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ControlPanel({ bot }: { bot: HedgingBotController }) {
  const [showConfig, setShowConfig] = useState(false);
  const [activationOpen, setActivationOpen] = useState(false);
  const running = bot.runState === 'running';
  const paused = bot.runState === 'paused';
  const stopped = bot.runState === 'idle' || bot.runState === 'stopped';
  const statusText = running ? 'Running' : paused ? 'Paused' : 'Stopped';
  const currency = bot.accountCurrency;
  const summary = bot.summary;

  return (
    <>
      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="hedging-control-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-primary"><Scale size={18} /></span>
            <div>
              <div className="eyebrow">Premium bot · high / low tick</div>
              <h2 className="mt-1 text-lg font-bold tracking-tight">Hedged High Tick / Low Tick engine</h2>
              <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
                The bot chooses which tick position each leg predicts from the verified history. In live mode it buys a High Tick and a Low Tick on the same market at the same moment,
                so one leg wins whenever the 5-tick window has a clear top or bottom. Deriv settles both legs; nothing is estimated for profit.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DerivConnectionStatusBadge />
            <span className={`mono rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${running ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-border bg-background/60 text-muted-foreground'}`} data-testid="hedging-status">
              {statusText}
            </span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {stopped || paused ? (
            <Button onClick={paused ? bot.resume : bot.start} className="gap-2" data-testid="button-hedging-start">
              <Play size={14} fill="currentColor" />{paused ? 'Resume bot' : 'Start bot'}
            </Button>
          ) : (
            <Button variant="secondary" onClick={bot.pause} className="gap-2" data-testid="button-hedging-pause"><Pause size={14} />Pause bot</Button>
          )}
          <Button variant="outline" onClick={bot.stop} disabled={stopped && !running} className="gap-2" data-testid="button-hedging-stop"><CircleStop size={14} />Stop bot</Button>
          <Button variant="outline" onClick={bot.runCycleNow} disabled={!running} className="gap-2" data-testid="button-hedging-cycle">
            <Gauge size={14} />Run cycle now
          </Button>
          <Button variant="ghost" onClick={() => setShowConfig((value) => !value)} className="gap-2" data-testid="button-hedging-config">
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
                data-testid={`hedging-mode-${id}`}
              >
                <span className="flex items-center gap-2 text-xs font-bold"><Icon size={14} className={active ? 'text-primary' : 'text-muted-foreground'} />{label}</span>
                <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{blurb}</span>
                {active ? <span className="mono mt-2 block text-[9px] font-bold uppercase tracking-[0.08em] text-primary">Active mode</span> : null}
              </button>
            );
          })}
        </div>

        <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="hedging-stats">
          <StatTile label="Pair P/L" value={formatSignedMoney(summary.netProfit, currency)} tone={pnlTone(summary.netProfit)} hint={`${summary.settled} settled · ${summary.partial} partial`} testId="hedging-pnl" />
          <StatTile label="Balance" value={formatMoney(bot.balance, currency)} hint={bot.connected ? (bot.accountType === 'real' ? 'Real account' : 'Demo account') : 'No account connected'} testId="hedging-balance" />
          <StatTile label="Daily P/L" value={formatSignedMoney(bot.account.dailyPnl, currency)} tone={pnlTone(bot.account.dailyPnl)} hint={`loss limit ${formatMoney(bot.config.maxDailyLoss, currency)}`} testId="hedging-daily" />
          <StatTile label="Open pairs" value={`${summary.open}`} hint={bot.purchaseInFlight ? 'purchase in progress' : bot.unreconciledPurchase ? 'reconciling a purchase' : `limit ${bot.config.maxOpenPairs}`} testId="hedging-open" />
        </div>

        {showConfig ? <BotConfiguration bot={bot} /> : null}

        <ActivationDialog
          open={activationOpen}
          onOpenChange={setActivationOpen}
          onConfirm={() => bot.setMode('live')}
          bot={bot}
        />
      </section>
    </>
  );
}

function LegCard({ label, choice, pricing }: { label: string; choice: LegChoice; pricing: LegPricing | null }) {
  const pending = choice.tickPosition === null;
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">{label}</span>
        <span className="mono text-[10px] text-muted-foreground">{choice.source === 'manual' ? 'manual' : 'auto'}</span>
      </div>
      <div className="mono mt-1 text-sm font-semibold">{pending ? 'Withheld' : `Tick ${choice.tickPosition} of ${HEDGE_WINDOW_TICKS}`}</div>
      <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        {choice.rate === null ? 'no replay yet' : `${formatPercent(choice.rate, 1)} of ${choice.windows} windows · z ${choice.z === null ? '—' : choice.z.toFixed(2)}`}
      </div>
      {pricing ? (
        <div className="mono mt-2 text-[10px] text-muted-foreground" data-testid={`hedging-pricing-${label === 'High Tick' ? 'high' : 'low'}`}>
          ask {pricing.ask === null ? '—' : pricing.ask.toFixed(2)} · payout {pricing.payout === null ? '—' : pricing.payout.toFixed(2)}
        </div>
      ) : null}
      {choice.note ? <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{choice.note}</div> : null}
    </div>
  );
}

/** What the bot is looking at right now: the two chosen positions, live prices and the gate. */
function SignalPanel({ bot }: { bot: HedgingBotController }) {
  const selection = bot.selection;
  const decision = bot.decision;
  const gate = bot.risk;
  const pricing: PairPricing | null = bot.pricing;
  const currency = bot.accountCurrency;
  const joint = selection?.joint ?? null;

  return (
    <Panel
      eyebrow="Live signal"
      title="Chosen tick positions and the pair price"
      icon={<Activity size={16} />}
      testId="hedging-signal"
      aside={
        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold ${bot.feedFresh ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'}`} data-testid="hedging-feed-health" aria-live="polite">
          <span className={`inline-block h-2 w-2 rounded-full ${bot.feedFresh ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          {bot.feedFresh ? `Live · ${bot.tickCount} ticks` : `Feed ${bot.feedStatus}`}
        </span>
      }
    >
      {bot.feedError || bot.precisionError ? (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          {bot.feedError || bot.precisionError}
        </div>
      ) : null}

      {selection ? (
        <div className="grid gap-3 md:grid-cols-3">
          <LegCard label="High Tick" choice={selection.high} pricing={pricing?.high ?? null} />
          <LegCard label="Low Tick" choice={selection.low} pricing={pricing?.low ?? null} />
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Joint outcome</div>
            {joint ? (
              <ul className="mono mt-1 space-y-0.5 text-[11px]">
                <li>both win · {joint.bothWin}</li>
                <li>only High · {joint.onlyHigh}</li>
                <li>only Low · {joint.onlyLow}</li>
                <li>neither · {joint.neither}</li>
              </ul>
            ) : (
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Shown once both positions are chosen.</p>
            )}
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Over {selection.windows} replayed windows.</p>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">Waiting for verified ticks from the public feed.</p>
      )}

      {pricing ? (
        <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px]" data-testid="hedging-pair-pricing">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="eyebrow">{pricing.source === 'purchase' ? 'Last purchase' : pricing.source === 'refused' ? 'Last refused pair' : 'Live pair preview'}</span>
            <span className="mono text-[10px] text-muted-foreground">{formatClock(pricing.at)}</span>
          </div>
          {pricing.economics ? (
            <div className="mono mt-2 grid gap-1 sm:grid-cols-2">
              <span>total cost {formatMoney(pricing.economics.totalAsk, currency)}</span>
              <span>pair EV {pricing.economics.expectedValue === null ? '—' : formatSignedMoney(pricing.economics.expectedValue, currency)}</span>
              <span>both win {formatSignedMoney(pricing.economics.scenarios.bothWin, currency)}</span>
              <span>one win {formatSignedMoney(pricing.economics.scenarios.onlyHigh, currency)} to {formatSignedMoney(pricing.economics.scenarios.onlyLow, currency)}</span>
              <span>neither {formatSignedMoney(pricing.economics.scenarios.neither, currency)}</span>
              <span>per unit staked {pricing.economics.returnOnStake === null ? '—' : pricing.economics.returnOnStake.toFixed(4)}</span>
            </div>
          ) : null}
          <div className="mt-2"><ReasonList reasons={pricing.notes} limit={4} /></div>
        </div>
      ) : null}

      {decision ? (
        <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2" data-testid="hedging-decision">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="eyebrow">Decision</span>
            <span className={`mono rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${decision.action === 'TRADE' ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : decision.action === 'BLOCKED' ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'}`}>
              {decision.actionLabel}
            </span>
          </div>
          {gate && gate.violations.length ? (
            <div className="mt-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.06em] text-amber-600 dark:text-amber-400"><ShieldAlert size={11} />Gate</div>
              <ReasonList reasons={gate.violations} tone="warn" />
            </div>
          ) : null}
          {gate && gate.notes.length ? (
            <div className="mt-2"><ReasonList reasons={gate.notes} limit={3} /></div>
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

function LegRow({ leg, pairId, bot }: { leg: HedgeLeg; pairId: string; bot: HedgingBotController }) {
  const settled = leg.profit !== null;
  const bought = leg.contractId !== null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-background/30 px-2.5 py-1.5 text-[11px]">
      <div className="flex items-center gap-2">
        {sideBadge(leg.side)}
        <span className="mono text-muted-foreground">tick {leg.tickPosition} · stake {formatMoney(leg.stake, bot.accountCurrency)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="mono">
          {settled ? formatSignedMoney(leg.profit, bot.accountCurrency) : bought ? `#${leg.contractId} open` : leg.status === 'pending' ? 'awaiting reply' : 'not bought'}
        </span>
        {bought && !settled ? (
          <Button size="sm" variant="outline" onClick={() => void bot.closeLeg(pairId, leg.side)} data-testid={`button-hedging-close-${leg.side.toLowerCase()}`}>
            Sell
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Open pairs with each leg, and the pairs waiting for a purchase to be reconciled. */
function PositionsPanel({ bot }: { bot: HedgingBotController }) {
  const open = bot.pairs.filter(isPairOpen);
  return (
    <Panel
      eyebrow="Positions"
      title="Open pairs on the account"
      icon={<Scale size={16} />}
      testId="hedging-positions"
      aside={<span className="mono text-[10px] text-muted-foreground">{open.length} pair(s)</span>}
    >
      {bot.unreconciledPurchase ? (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          A purchase reply did not arrive. The bot is matching it against the account; no new pair opens until that is resolved.
        </div>
      ) : null}
      {open.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No open pairs. A pair appears here as soon as both legs are confirmed by Deriv.</p>
      ) : (
        <div className="space-y-2">
          {open.map((row) => (
            <div key={row.id} className="space-y-2 rounded-lg border border-border bg-background/40 p-3" data-testid="hedging-pair-row">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="mono">{row.symbol} · {formatClock(row.at)}</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] ${STATUS_TONE[row.status] ?? ''}`}>{STATUS_LABEL[row.status] ?? row.status}</span>
              </div>
              <LegRow leg={row.high} pairId={row.id} bot={bot} />
              <LegRow leg={row.low} pairId={row.id} bot={bot} />
              {row.note ? <p className="text-[10px] leading-relaxed text-muted-foreground">{row.note}</p> : null}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Analysis predictions: how often each chosen position was the extreme after the entry. */
function PredictionPanel({ bot }: { bot: HedgingBotController }) {
  const summary = bot.predictionSummary;
  return (
    <Panel
      eyebrow="Analysis record"
      title="How the chosen positions have landed"
      icon={<Gauge size={16} />}
      testId="hedging-predictions"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <StatTile label="High Tick hit rate" value={formatPercent(summary.highHitRate, 1)} hint={`baseline ${formatPercent(0.2, 0)} for a random tick`} testId="hedging-high-hit" />
        <StatTile label="Low Tick hit rate" value={formatPercent(summary.lowHitRate, 1)} hint={`baseline ${formatPercent(0.2, 0)} for a random tick`} testId="hedging-low-hit" />
        <StatTile label="Entries scored" value={`${summary.resolved}`} hint={`${summary.pending} pending · ${summary.expired} expired`} />
        <StatTile label="Both legs won" value={formatPercent(summary.bothHitRate, 1)} hint="Both chosen positions were the extremes" />
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Hit rates describe the ticks this browser collected. They are not a forecast, and a hedge that wins both legs is rare by design.
      </p>
    </Panel>
  );
}

function TradeLogPanel({ bot }: { bot: HedgingBotController }) {
  const rows = [...bot.pairs].reverse().slice(0, 25);
  return (
    <Panel
      eyebrow="Pair log"
      title="Every pair the bot has recorded"
      icon={<Scale size={16} />}
      testId="hedging-trade-log"
      aside={
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadCsv(HEDGE_LOG_FILENAME, bot.pairsCsv)} disabled={!bot.pairs.length} className="gap-2" data-testid="button-hedging-download">
            <Download size={13} />CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={bot.clearTradeLog} disabled={!bot.pairs.length && !bot.predictions.length} className="gap-2" data-testid="button-hedging-clear">
            <Trash2 size={13} />Clear
          </Button>
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No pairs recorded yet. Analysis-mode entries are scored in the Analysis record panel.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[11px]">
            <thead className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-semibold">Time</th>
                <th className="py-1.5 pr-3 font-semibold">Ticks</th>
                <th className="py-1.5 pr-3 font-semibold">Status</th>
                <th className="py-1.5 pr-3 font-semibold">Stake</th>
                <th className="py-1.5 pr-3 font-semibold">EV</th>
                <th className="py-1.5 pr-3 font-semibold">Net</th>
              </tr>
            </thead>
            <tbody className="mono">
              {rows.map((row: HedgePair) => (
                <tr key={row.id} className="border-t border-border/60" data-testid="hedging-log-row">
                  <td className="py-1.5 pr-3">{formatClock(row.at)}</td>
                  <td className="py-1.5 pr-3">{row.high.tickPosition} / {row.low.tickPosition}</td>
                  <td className="py-1.5 pr-3">{STATUS_LABEL[row.status] ?? row.status}</td>
                  <td className="py-1.5 pr-3">{formatMoney(row.high.stake, bot.accountCurrency)} + {formatMoney(row.low.stake, bot.accountCurrency)}</td>
                  <td className="py-1.5 pr-3">{row.expectedValue === null ? '—' : formatSignedMoney(row.expectedValue, bot.accountCurrency)}</td>
                  <td className="py-1.5 pr-3">{row.netProfit === null ? '—' : formatSignedMoney(row.netProfit, bot.accountCurrency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Showing the latest 25 of {bot.pairs.length}. Refused and not-bought pairs are kept separately so they cannot crowd out real trades. Each leg is settled by Deriv on its own.
      </p>
    </Panel>
  );
}

function DecisionLogPanel({ bot }: { bot: HedgingBotController }) {
  return (
    <Panel eyebrow="Decision log" title="Each cycle, in order" icon={<Terminal size={16} />} testId="hedging-decision-log">
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

/** The limits the bot respects, stated plainly on the page. */
function LimitsPanel() {
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="hedging-limits">
      <div className="flex items-center gap-2">
        <ShieldAlert size={15} className="text-primary" />
        <h3 className="text-sm font-bold">What this bot will and will not do</h3>
      </div>
      <ul className="mt-3 grid gap-2 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-2">
        <li>It buys both legs of a pair only in live mode, on the authorized Deriv account. Analysis mode sends no order.</li>
        <li>It only opens a pair when both live proposals are valid, priced, and pass the expected-value gate.</li>
        <li>It never sends a second pair while a purchase is in flight or unreconciled.</li>
        <li>If one leg is refused after the other was bought, it sells the bought leg back rather than leave it unhedged.</li>
        <li>It never treats a running payout as realised profit; only Deriv settlements move the ledger.</li>
        <li>A hedge reduces variance, not expected value: each leg carries the house edge, so a passing gate does not promise profit.</li>
        <li>High/Low Tick contracts are offered on synthetic indices only; the bot waits when Deriv does not list them for the market.</li>
        <li>Every rule runs in this browser. Your token, account id and balance are never sent to a third party.</li>
      </ul>
    </section>
  );
}

export function HedgingBot() {
  const bot = useHedgingBot();

  const stakeNote = useMemo(() => (bot.stakePerLeg === null ? 'The balance cannot fund the minimum stake.' : null), [bot.stakePerLeg]);

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-4 animate-rise-in" data-testid="hedging-bot">
      <ControlPanel bot={bot} />

      {bot.accountCurrency === '' ? (
        <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="hedging-authorization">
          <div className="eyebrow">Deriv authorization</div>
          <h3 className="mt-1 text-sm font-bold">Connect a Deriv account to open live pairs</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            The bot reuses this application's existing Deriv connection. Analysis-only mode works without an account.
          </p>
          <div className="mt-3"><DerivConnectionCard /></div>
        </section>
      ) : null}

      {stakeNote ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">{stakeNote}</div>
      ) : null}

      <SignalPanel bot={bot} />
      <PositionsPanel bot={bot} />
      <div className="grid gap-4 xl:grid-cols-2">
        <PredictionPanel bot={bot} />
        <TradeLogPanel bot={bot} />
      </div>
      <DecisionLogPanel bot={bot} />
      <LimitsPanel />
    </div>
  );
}
