// The AI Digit Intelligence & Autonomous Trading Engine panel.
//
// Presents engine A–N output for the operator: control, live market status,
// AI analysis, digit heatmap, candidate comparison, account/risk, live trade
// monitor and the decision log. It never places an order itself — every
// purchase goes through the execution engine inside `useDigitBot`.
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Bot,
  CircleStop,
  FlaskConical,
  OctagonAlert,
  Pause,
  Play,
  Power,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Siren,
  SlidersHorizontal,
  Terminal,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DerivConnectionCard, DerivConnectionStatusBadge } from '@/components/deriv-connection-card';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { useDigitBot, type DigitBotController } from '@/hooks/use-digit-bot';
import type { BotMode, ContractFamily } from '@/lib/digit-bot/types';
import { formatMoney, formatSignedMoney } from '@/components/premium-bot/bot-panels';
import { BotAnalysisPanel, BotCandidateTable, BotDigitHeatmap, BotMarketStatus, formatPercent } from '@/components/premium-bot/bot-panels';
import {
  BotAccountRiskPanel,
  BotDecisionLog,
  BotEnginePanel,
  BotPerformancePanel,
  BotTradeMonitor,
} from '@/components/premium-bot/bot-ledger';

const MODE_DETAILS: Array<{ id: BotMode; label: string; blurb: string; icon: typeof Terminal }> = [
  { id: 'analysis', label: 'Analysis only', blurb: 'Reads live ticks, predicts and ranks contracts. Never sends an order.', icon: Terminal },
  { id: 'paper', label: 'Paper trading', blurb: 'Records simulated entries priced from real Deriv proposals and scores them separately.', icon: FlaskConical },
  { id: 'live', label: 'Live trading', blurb: 'Sends real purchases to the authorized Deriv account after every risk and validation check passes.', icon: TrendingUp },
];

const FAMILIES: Array<{ id: ContractFamily; label: string }> = [
  { id: 'even-odd', label: 'Even/Odd' },
  { id: 'over-under', label: 'Over/Under' },
  { id: 'matches', label: 'Matches' },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint ? <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const inputClass = 'h-9 w-full rounded-lg border border-input bg-background px-2 text-xs font-semibold text-foreground outline-none focus:border-primary';

function NumberInput({ value, onChange, step = 1, min = 0, testId }: { value: number; onChange: (value: number) => void; step?: number; min?: number; testId?: string }) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
      className={inputClass}
      data-testid={testId}
    />
  );
}

function RiskSettings({ bot }: { bot: DigitBotController }) {
  const config = bot.riskConfig;
  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Stake model" hint="Fixed stake is the default; percentage mode is capped by the balance.">
        <select
          value={config.stakeMode}
          onChange={(event) => bot.updateRiskConfig({ stakeMode: event.target.value as 'fixed' | 'percent' })}
          className={inputClass}
          data-testid="bot-stake-mode"
        >
          <option value="fixed">Fixed stake</option>
          <option value="percent">Percentage of balance</option>
        </select>
      </Field>
      <Field label="Fixed stake"><NumberInput value={config.fixedStake} step={0.01} onChange={(value) => bot.updateRiskConfig({ fixedStake: value })} testId="bot-fixed-stake" /></Field>
      <Field label="Percent of balance"><NumberInput value={config.percentOfBalance} step={0.1} onChange={(value) => bot.updateRiskConfig({ percentOfBalance: value })} testId="bot-percent-stake" /></Field>
      <Field label="Stake as % of balance cap"><NumberInput value={config.maxStakeShareOfBalance} step={0.1} onChange={(value) => bot.updateRiskConfig({ maxStakeShareOfBalance: value })} testId="bot-stake-cap" /></Field>
      <Field label="Minimum stake"><NumberInput value={config.minStake} step={0.01} onChange={(value) => bot.updateRiskConfig({ minStake: value })} testId="bot-min-stake" /></Field>
      <Field label="Maximum stake"><NumberInput value={config.maxStake} step={0.01} onChange={(value) => bot.updateRiskConfig({ maxStake: value })} testId="bot-max-stake" /></Field>
      <Field label="Maximum daily loss"><NumberInput value={config.maxDailyLoss} step={0.5} onChange={(value) => bot.updateRiskConfig({ maxDailyLoss: value })} testId="bot-max-daily-loss" /></Field>
      <Field label="Maximum session loss"><NumberInput value={config.maxSessionLoss} step={0.5} onChange={(value) => bot.updateRiskConfig({ maxSessionLoss: value })} testId="bot-max-session-loss" /></Field>
      <Field label="Maximum consecutive losses"><NumberInput value={config.maxConsecutiveLosses} onChange={(value) => bot.updateRiskConfig({ maxConsecutiveLosses: value })} testId="bot-max-consecutive-losses" /></Field>
      <Field label="Maximum daily trades"><NumberInput value={config.maxDailyTrades} onChange={(value) => bot.updateRiskConfig({ maxDailyTrades: value })} testId="bot-max-daily-trades" /></Field>
      <Field label="Maximum entries per session"><NumberInput value={config.maxEntriesPerSession} onChange={(value) => bot.updateRiskConfig({ maxEntriesPerSession: value })} testId="bot-max-session-entries" /></Field>
      <Field label="Maximum trades per symbol"><NumberInput value={config.maxTradesPerSymbol} onChange={(value) => bot.updateRiskConfig({ maxTradesPerSymbol: value })} testId="bot-max-symbol-trades" /></Field>
      <Field label="Maximum open contracts"><NumberInput value={config.maxOpenContracts} onChange={(value) => bot.updateRiskConfig({ maxOpenContracts: value })} testId="bot-max-open-contracts" /></Field>
      <Field label="Minimum ticks between entries"><NumberInput value={config.minTicksBetweenEntries} onChange={(value) => bot.updateRiskConfig({ minTicksBetweenEntries: value })} testId="bot-min-ticks" /></Field>
      <Field label="Cooldown after a contract (ms)"><NumberInput value={config.cooldownAfterContractMs} step={500} onChange={(value) => bot.updateRiskConfig({ cooldownAfterContractMs: value })} testId="bot-cooldown" /></Field>
      <Field label="Maximum session (minutes)"><NumberInput value={config.maxSessionMinutes} onChange={(value) => bot.updateRiskConfig({ maxSessionMinutes: value })} testId="bot-session-minutes" /></Field>
      <Field label="Minimum probability edge (pp)" hint="Required margin of the conservative probability over break-even.">
        <NumberInput value={+(config.minProbabilityEdge * 100).toFixed(2)} step={0.1} onChange={(value) => bot.updateRiskConfig({ minProbabilityEdge: value / 100 })} testId="bot-min-edge" />
      </Field>
      <Field label="Minimum effective sample" hint="Serial-dependence adjusted digits required before a model may trade.">
        <NumberInput value={config.minEffectiveSample} step={50} onChange={(value) => bot.updateRiskConfig({ minEffectiveSample: value })} testId="bot-min-sample" />
      </Field>
      <Field label="Decision cycle (ms)"><NumberInput value={config.decisionIntervalMs} step={500} min={500} onChange={(value) => bot.updateRiskConfig({ decisionIntervalMs: value })} testId="bot-cycle-interval" /></Field>
      <Field label="Tick expiry for proposals" hint="Only expiries Deriv reports for this symbol are used.">
        <select
          value={config.durationTicks}
          onChange={(event) => bot.updateRiskConfig({ durationTicks: Number(event.target.value) })}
          className={inputClass}
          data-testid="bot-duration"
        >
          {bot.supportedTickExpiries.length ? bot.supportedTickExpiries.map((ticks) => (
            <option key={ticks} value={ticks}>{ticks} {ticks === 1 ? 'tick' : 'ticks'}</option>
          )) : <option value={config.durationTicks}>{config.durationTicks} tick(s) · waiting for Deriv metadata</option>}
        </select>
      </Field>
    </div>
  );
}

function LiveActivationDialog({ open, onOpenChange, onConfirm, bot }: { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void; bot: DigitBotController }) {
  const trading = useDerivTrading();
  const currency = bot.accountCurrency;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Siren size={16} className="text-destructive" /> Activate live trading</DialogTitle>
          <DialogDescription>
            Live mode sends real contract purchases to the authorized Deriv account. Review these settings before continuing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[11px] leading-relaxed">
          <div className={`rounded-lg border px-3 py-2 ${trading.activeAccount?.accountType === 'real' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-background/40 text-muted-foreground'}`}>
            <div className="font-semibold">
              {trading.activeAccount === null
                ? 'No Deriv account is authorized yet. Connect an account first.'
                : `${trading.activeAccount.accountId} · ${trading.activeAccount.accountType === 'real' ? 'REAL money account' : 'Demo account'}`}
            </div>
            {trading.activeAccount?.accountType === 'real' ? (
              <div className="mt-1">Purchases on this account settle against your own balance.</div>
            ) : (
              <div className="mt-1">Demo accounts rehearse the full order flow without risking real funds.</div>
            )}
          </div>
          <ul className="space-y-1.5 text-muted-foreground">
            <li>Stake: <span className="mono text-foreground">{bot.riskConfig.stakeMode === 'fixed' ? `${formatMoney(bot.riskConfig.fixedStake, currency)} fixed` : `${bot.riskConfig.percentOfBalance}% of balance (capped at ${bot.riskConfig.maxStakeShareOfBalance}%)`}</span></li>
            <li>Limits: daily loss {formatMoney(bot.riskConfig.maxDailyLoss, currency)}, session loss {formatMoney(bot.riskConfig.maxSessionLoss, currency)}, {bot.riskConfig.maxConsecutiveLosses} consecutive losses, {bot.riskConfig.maxDailyTrades} trades/day, {bot.riskConfig.maxOpenContracts} open contract(s).</li>
            <li>Every purchase still requires a validated model, a positive conservative expected value, a fresh tick stream and a verified Deriv proposal.</li>
            <li>There is no martingale and no stake increase after a loss. The emergency stop blocks new purchases immediately.</li>
            <li>Contracts Deriv has already accepted cannot be cancelled by stopping the bot; they are monitored until settlement.</li>
          </ul>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Stay in {bot.mode === 'live' ? 'live' : 'current'} mode</Button>
          <Button
            variant={trading.activeAccount?.accountType === 'real' ? 'destructive' : 'default'}
            disabled={trading.activeAccount === null}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            data-testid="button-confirm-live-trading"
          >
            Activate live trading
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ControlPanel({ bot }: { bot: DigitBotController }) {
  const [showSettings, setShowSettings] = useState(false);
  const [activationOpen, setActivationOpen] = useState(false);
  const running = bot.runState === 'running';
  const paused = bot.runState === 'paused';
  const stopped = bot.runState === 'idle' || bot.runState === 'stopped';
  const currency = bot.accountCurrency;
  const statusText = bot.safety.emergencyStop
    ? 'Emergency stop engaged'
    : running
      ? 'Running'
      : paused
        ? 'Paused'
        : 'Stopped';

  return (
    <>
      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="bot-control-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-primary"><Bot size={18} /></span>
            <div>
              <div className="eyebrow">Premium bot · engine A–N</div>
              <h2 className="mt-1 text-lg font-bold tracking-tight">Deriv AI digit intelligence &amp; autonomous trading engine</h2>
              <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
                Even/Odd, Over/Under and Matches contracts are evaluated together on every cycle. The bot only buys when a walk-forward-validated model, a live Deriv proposal and every risk limit agree; otherwise it reports NO TRADE and explains why.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DerivConnectionStatusBadge />
            <span className={`mono rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.06em] ${bot.safety.emergencyStop ? 'border-destructive bg-destructive/10 text-destructive' : running ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-border bg-background/60 text-muted-foreground'}`} data-testid="bot-status">
              {statusText}
            </span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {stopped || paused ? (
            <Button onClick={paused ? bot.resume : bot.start} disabled={bot.safety.emergencyStop === false && bot.accountCurrency === ''} className="gap-2" data-testid="button-bot-start">
              <Play size={14} fill="currentColor" />{paused ? 'Resume bot' : 'Start bot'}
            </Button>
          ) : (
            <Button variant="secondary" onClick={bot.pause} className="gap-2" data-testid="button-bot-pause"><Pause size={14} />Pause bot</Button>
          )}
          <Button variant="outline" onClick={bot.stop} disabled={stopped && !running} className="gap-2" data-testid="button-bot-stop"><CircleStop size={14} />Stop bot</Button>
          <Button variant="destructive" onClick={bot.engageEmergencyStop} className="gap-2" data-testid="button-bot-emergency-stop"><OctagonAlert size={14} />Emergency stop</Button>
          {bot.safety.emergencyStop ? (
            <Button variant="outline" onClick={bot.releaseEmergencyStop} className="gap-2" data-testid="button-bot-clear-emergency-stop"><Power size={14} />Clear emergency stop</Button>
          ) : null}
          <Button variant="ghost" onClick={() => setShowSettings((value) => !value)} className="gap-2" data-testid="button-bot-settings">
            <Settings2 size={14} />{showSettings ? 'Hide limits' : 'Limits &amp; stake'}
          </Button>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {MODE_DETAILS.map(({ id, label, blurb, icon: Icon }) => {
            const active = bot.mode === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => (id === 'live' ? setActivationOpen(true) : bot.setMode(id))}
                aria-pressed={active}
                className={`focus-ring rounded-xl border p-3 text-left transition-colors ${active ? 'border-primary/60 bg-primary/5' : 'border-border bg-background/35 hover:border-primary/40'}`}
                data-testid={`bot-mode-${id}`}
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
          <Field label="Contract selection">
            <select
              value={bot.selectionMode}
              onChange={(event) => bot.setSelectionMode(event.target.value as 'auto' | 'manual')}
              className={inputClass}
              data-testid="bot-selection-mode"
            >
              <option value="auto">Automatic — bot picks the family</option>
              <option value="manual">Manual — I choose the family</option>
            </select>
          </Field>
          <Field label="Manual family" hint="Applied when manual selection is active; validation and risk still decide whether it may trade.">
            <select
              value={bot.manualFamily}
              onChange={(event) => bot.setManualFamily(event.target.value as ContractFamily)}
              disabled={bot.selectionMode !== 'manual'}
              className={`${inputClass} disabled:opacity-60`}
              data-testid="bot-manual-family"
            >
              {FAMILIES.map((family) => <option key={family.id} value={family.id}>{family.label}</option>)}
            </select>
          </Field>
          <Field label="Market">
            <select
              value={bot.symbol}
              onChange={(event) => bot.selectSymbol(event.target.value)}
              disabled={!bot.symbols.length}
              className={`${inputClass} disabled:opacity-60`}
              data-testid="bot-symbol-select"
            >
              {!bot.symbols.length ? <option value="">Loading Deriv active symbols…</option> : null}
              {bot.symbols.map((symbol) => (
                <option key={symbol.symbol} value={symbol.symbol}>{symbol.name} · {symbol.symbol}</option>
              ))}
            </select>
          </Field>
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Entry qualification this cycle</div>
            <div className="mono mt-1 text-sm font-semibold">
              {bot.decision ? `${bot.decision.candidates.filter((candidate) => candidate.eligible).length} qualified · ${bot.decision.candidates.length} evaluated` : 'No cycle yet'}
            </div>
            <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
              {bot.contractSupportLoaded ? `${bot.supportedTickExpiries.length} Deriv-reported tick expiry(ies)` : 'Waiting for Deriv contract metadata'}
            </div>
          </div>
        </div>

        {showSettings ? <RiskSettings bot={bot} /> : null}

        {bot.cycleError ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[11px] leading-relaxed text-destructive" role="alert">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{bot.cycleError}</span>
          </div>
        ) : null}

        {bot.safety.autoPauseReasons.length ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300" role="status">
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

      <LiveActivationDialog
        open={activationOpen}
        onOpenChange={setActivationOpen}
        bot={bot}
        onConfirm={() => bot.setMode('live')}
      />

      {bot.mode === 'live' ? (
        <section className="sticky top-[76px] z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 backdrop-blur" data-testid="bot-live-banner" role="alert">
          <div className="flex items-center gap-3">
            <Siren size={18} className="text-destructive" />
            <div>
              <div className="text-xs font-extrabold uppercase tracking-[0.1em] text-destructive">Live trading active</div>
              <div className="text-[10px] text-muted-foreground">
                {bot.accountType === 'real' ? 'Real account' : bot.accountType === 'demo' ? 'Demo account' : 'No account'} · purchases are sent to Deriv after every validation gate passes.
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={bot.pause} data-testid="button-live-pause"><Pause size={14} />Pause</Button>
            <Button variant="destructive" size="sm" onClick={bot.engageEmergencyStop} data-testid="button-live-stop"><OctagonAlert size={14} />STOP BOT</Button>
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * Total profit and loss, always visible at the top of the bot.
 *
 * Live (or demo) money and paper results are shown side by side and then added
 * up with an explicit label, because the specification requires the three
 * datasets to stay distinguishable. Nothing here is estimated: the numbers come
 * from Deriv settlements and from the recorded, settled paper results.
 */
function ProfitLossStrip({ bot }: { bot: DigitBotController }) {
  const currency = bot.accountCurrency;
  const accountLabel = bot.accountType === 'demo'
    ? 'Demo account balance'
    : bot.accountType === 'real'
      ? 'Real account balance'
      : 'No account connected';
  const accountTone = bot.accountType === 'real' ? 'text-amber-600 dark:text-amber-400' : 'text-primary';
  const live = bot.metrics;
  const paper = bot.paperMetrics;
  const combined = live.netProfit + paper.netProfit;
  const settled = live.resolved;
  const tone = (value: number) => (value > 0 ? 'text-emerald-600 dark:text-emerald-400' : value < 0 ? 'text-destructive' : 'text-foreground');

  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-3" data-testid="bot-profit-loss">
      <div className={`rounded-xl border p-3 ${bot.accountType === 'real' ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-background/40'}`}>
        <span className="eyebrow">Total profit / loss · {accountLabel}</span>
        <span className={`mono mt-1 block text-2xl font-bold tabular-nums ${tone(live.netProfit)}`} data-testid="bot-total-pnl">
          {formatSignedMoney(live.netProfit, currency)}
        </span>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          {live.traded} order{live.traded === 1 ? '' : 's'} · {live.wins} won · {live.losses} lost · {settled} settled · staked {formatMoney(live.grossStake, currency)}
          {live.returnOnStake === null ? '' : ` · return on stake ${formatPercent(live.returnOnStake, 2)}`}
        </span>
      </div>
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <span className="eyebrow">Paper profit / loss · simulated</span>
        <span className={`mono mt-1 block text-2xl font-bold tabular-nums ${tone(paper.netProfit)}`} data-testid="bot-paper-pnl">
          {formatSignedMoney(paper.netProfit, currency)}
        </span>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          {paper.traded} simulated entr{paper.traded === 1 ? 'y' : 'ies'} · {paper.wins} won · {paper.losses} lost · priced from real Deriv proposals, never from an order
        </span>
      </div>
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <span className="eyebrow">Combined total · live + paper</span>
        <span className={`mono mt-1 block text-2xl font-bold tabular-nums ${tone(combined)}`} data-testid="bot-combined-pnl">
          {formatSignedMoney(combined, currency)}
        </span>
        <span className={`mt-1 block text-[10px] ${bot.accountType === 'real' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
          {bot.accountType === 'real'
            ? 'This account trades real money. Paper results are simulated and are not real profit.'
            : 'Live and simulated results are kept separate; only the first tile reflects the connected account.'}
        </span>
      </div>
    </div>
  );
}

export function DigitAiBot() {
  const bot = useDigitBot();
  const models = bot.decision?.models ?? [];
  const ensemble = bot.decision?.ensemble ?? null;
  const trailing = useMemo(() => bot.records.slice(-25).reverse(), [bot.records]);

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-4 animate-rise-in" data-testid="digit-ai-bot">
      <ControlPanel bot={bot} />

      {bot.accountCurrency === '' ? (
        <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
          <div className="eyebrow">Deriv authorization</div>
          <h3 className="mt-1 text-sm font-bold">Connect a Deriv account to trade</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            The bot reuses this application's existing Deriv connection: your Personal Access Token stays in this browser, and the account selector below chooses the demo or real account the bot may use. Analysis-only mode works without an account.
          </p>
          <div className="mt-3"><DerivConnectionCard /></div>
        </section>
      ) : null}

      <BotMarketStatus bot={bot} />
      <BotAnalysisPanel bot={bot} models={models} ensemble={ensemble} />
      <BotDigitHeatmap bot={bot} />
      <BotCandidateTable bot={bot} />
      <div className="grid gap-4 xl:grid-cols-2">
        <BotAccountRiskPanel bot={bot} />
        <BotTradeMonitor bot={bot} />
      </div>
      <BotDecisionLog bot={bot} />
      <BotPerformancePanel bot={bot} />
      <BotEnginePanel bot={bot} />

      {trailing.length ? (
        <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={15} className="text-primary" />
            <h3 className="text-sm font-bold">Recent predictions</h3>
            <span className="mono ml-auto text-[10px] text-muted-foreground">{bot.records.length} stored in this browser</span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-[10px]">
              <thead>
                <tr className="bg-background/60">
                  {['Time', 'Mode', 'Contract', 'Predicted', 'Break-even', 'EV', 'Decision', 'Scored digit', 'Result'].map((heading) => (
                    <th key={heading} scope="col" className="border-b border-border px-2 py-1.5 text-left text-[9px] uppercase tracking-wider text-muted-foreground">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trailing.map((record) => (
                  <tr key={record.id} data-testid={`bot-record-${record.id}`}>
                    <td className="mono border-b border-border px-2 py-1.5">{new Date(record.at).toLocaleTimeString()}</td>
                    <td className="border-b border-border px-2 py-1.5 text-muted-foreground">{record.mode}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{record.contractType}{record.barrier === null ? '' : ` ${record.barrier}`}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{formatPercent(record.predictedProbability)}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{formatPercent(record.breakEvenProbability)}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{record.expectedValue === null ? '—' : record.expectedValue.toFixed(4)}</td>
                    <td className="border-b border-border px-2 py-1.5">{record.decision}</td>
                    <td className="mono border-b border-border px-2 py-1.5">{record.outcomeDigit ?? 'pending'}</td>
                    <td className={`border-b border-border px-2 py-1.5 ${record.won === null ? 'text-muted-foreground' : record.won ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
                      {record.won === null ? 'unscored' : record.won ? 'prediction hit' : 'prediction missed'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 flex items-start gap-2 text-[10px] leading-relaxed text-muted-foreground">
            <BadgeCheck size={13} className="mt-0.5 shrink-0 text-primary" />
            Predictions that were never traded are still scored against the digit that really appeared, which is what keeps the calibration and Brier figures honest. Nothing here is a promise of future performance.
          </p>
        </section>
      ) : null}

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="flex items-center gap-2">
          <RefreshCw size={15} className="text-primary" />
          <h3 className="text-sm font-bold">What this bot will not do</h3>
        </div>
        <ul className="mt-3 grid gap-2 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-2">
          <li>It never trades without positive expected value measured against a live Deriv proposal.</li>
          <li>It never increases the stake after a loss, never martingales and never chases recovery.</li>
          <li>It never treats a frequently appearing digit, or an overdue one, as a prediction.</li>
          <li>It never substitutes generated ticks for missing market data; stale feeds stop trading.</li>
          <li>It never treats an open contract's potential payout as realised profit.</li>
          <li>It never sends your token, account id or balance to a third-party AI provider.</li>
          <li>It never reports a paper trade as a real Deriv purchase.</li>
          <li>It never promises that passing tests implies profitability.</li>
        </ul>
      </section>
    </div>
  );
}
