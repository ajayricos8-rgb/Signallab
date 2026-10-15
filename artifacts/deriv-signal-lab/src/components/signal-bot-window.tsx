// Mini bot page: the expandable window that opens above the mini bottom trade
// menu when "Load and Run" is pressed. It shows every contract the bot buys as
// the run progresses, stops the bot on demand and resets the page for a fresh
// run once the bot has stopped or finished its runs.
import { AlertTriangle, Bot, CheckCircle2, CircleDashed, Loader2, Maximize2, Minimize2, RotateCcw, Square, X, XCircle } from 'lucide-react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import type { SignalBotController } from '@/hooks/use-signal-bot';
import { describeStopReason } from '@/lib/signal-bot/plan.ts';
import type { SignalBotRun, SignalBotStatus } from '@/lib/signal-bot/types.ts';
import { formatAmount, formatSignedAmount } from '@/lib/deriv-trading';
import type { TradeFamily } from '@/lib/trade-draft';
import { TRADE_FAMILIES } from '@/lib/trade-draft';
import { formatTradeDuration } from '@/lib/trade-duration';

type SignalBotWindowProps = {
  bot: SignalBotController;
  family: TradeFamily;
  currency: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
};

const STATUS_META: Record<SignalBotStatus, { label: string; className: string }> = {
  idle: { label: 'Ready', className: 'border-border bg-secondary/60 text-muted-foreground' },
  running: { label: 'Running', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  stopped: { label: 'Stopped', className: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  completed: { label: 'Completed', className: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  error: { label: 'Stopped · error', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
};

const RUN_META: Record<SignalBotRun['status'], { label: string; className: string; icon: typeof Loader2 }> = {
  open: { label: 'Open', className: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400', icon: Loader2 },
  won: { label: 'Won', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', icon: CheckCircle2 },
  lost: { label: 'Lost', className: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400', icon: XCircle },
  unknown: { label: 'No result', className: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400', icon: CircleDashed },
  failed: { label: 'Refused', className: 'border-destructive/40 bg-destructive/10 text-destructive', icon: AlertTriangle },
};

function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/45 px-2.5 py-1.5">
      <div className="text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
      <div className={`mono mt-0.5 text-xs font-extrabold ${tone}`}>{value}</div>
    </div>
  );
}

function RunRow({ run, currency, liveProfit }: { run: SignalBotRun; currency: string; liveProfit: number | null }) {
  const meta = RUN_META[run.status];
  const Icon = meta.icon;
  const shownProfit = run.profit ?? (run.status === 'open' ? liveProfit : null);
  return (
    <li
      className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border bg-background/40 px-2.5 py-2"
      data-testid={`bot-run-${run.index}`}
      data-run-status={run.status}
    >
      <span className="mono text-[11px] font-bold text-muted-foreground">#{run.index}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.08em] ${meta.className}`}>
            <Icon size={10} className={run.status === 'open' ? 'animate-spin' : ''} />
            {meta.label}
          </span>
          <span className="truncate text-[11px] font-semibold">{run.contractLabel}</span>
          <span className="mono truncate text-[10px] text-muted-foreground">{run.marketCode}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
          <span className="mono">Stake {formatAmount(run.stake, currency)}</span>
          {run.martingaleStep > 0 && <span className="mono">step {run.martingaleStep}</span>}
          {run.payout !== null && <span className="mono">payout {formatAmount(run.payout, currency)}</span>}
          {run.note && <span className="truncate">{run.note}</span>}
        </div>
      </div>
      <span
        className={`mono text-xs font-extrabold ${run.status === 'won' ? 'text-emerald-500' : run.status === 'lost' ? 'text-rose-500' : 'text-muted-foreground'}`}
        data-testid={`bot-run-profit-${run.index}`}
      >
        {run.status === 'failed' ? '—' : formatSignedAmount(shownProfit, currency)}
      </span>
    </li>
  );
}

export function SignalBotWindow({
  bot,
  family,
  currency,
  expanded,
  onExpandedChange,
  onClose,
}: SignalBotWindowProps) {
  const trading = useDerivTrading();
  const { plan, runs, summary, status, stopReason, error, targetRuns, activeContractId } = bot;
  const liveProfit =
    activeContractId === null
      ? null
      : trading.openPositions.find((position) => position.contractId === activeContractId)?.profit ?? null;
  const statusMeta = STATUS_META[status];
  const stopNote = describeStopReason(stopReason);
  const showReset = !bot.running && (runs.length > 0 || Boolean(error));
  const progress = `${summary.started}/${targetRuns || 0}`;

  return (
    <section
      className={`pointer-events-auto flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-[0_-18px_45px_rgba(3,12,29,0.35)] backdrop-blur-md ${expanded ? 'h-[min(38rem,calc(100dvh-15rem))] max-w-[1100px]' : 'h-[20rem] max-w-md'} ml-auto`}
      aria-label="Signal bot"
      data-testid="signal-bot-window"
      data-expanded={expanded ? 'true' : 'false'}
      data-status={status}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-background/40 px-3 py-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${bot.running ? 'bg-emerald-500/15 text-emerald-500' : 'bg-primary/10 text-primary'}`}>
          {bot.running ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[11px] font-bold leading-tight">
            Signal bot <span className="font-medium text-muted-foreground">· {TRADE_FAMILIES[family].label}</span>
          </div>
          <div className="mono text-[10px] text-muted-foreground">Runs {progress}</div>
        </div>
        <span className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.08em] ${statusMeta.className}`} data-testid="bot-status">
          {statusMeta.label}
        </span>
        <button
          type="button"
          onClick={() => onExpandedChange(!expanded)}
          className="focus-ring rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={expanded ? 'Minimize bot page' : 'Expand bot page'}
          aria-pressed={expanded}
          title={expanded ? 'Minimize bot page' : 'Expand bot page'}
          data-testid="bot-window-toggle"
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close bot page"
          title="Close bot page"
          data-testid="bot-window-close"
        >
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
        {trading.activeAccount?.accountType === 'real' && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-2.5 py-2 text-[11px] leading-snug text-rose-600 dark:text-rose-400" role="status" data-testid="bot-real-account-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              Real account {trading.activeAccount.accountId}: the bot buys contracts by itself at the stake set on the
              trade menu. Stop it at any time.
            </span>
          </div>
        )}
        {plan ? (
          <div className="rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-2 text-[11px] leading-relaxed">
            <span className="font-bold">{plan.label}</span> on {plan.marketName} ({plan.symbol}) ·{' '}
            {formatTradeDuration(plan.duration, plan.durationUnit)} · {plan.confidence}% confidence ·{' '}
            {targetRuns} run{targetRuns === 1 ? '' : 's'}
            {plan.recommendedRuns !== targetRuns ? ` (analysis suggested ${plan.recommendedRuns})` : ' from the analysis'}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground">
            Run Analysis, then press Load and Run to trade the signal automatically.
          </div>
        )}

        <div className={`grid gap-1.5 ${expanded ? 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-7' : 'grid-cols-3'}`}>
          <Stat label="Settled" value={`${summary.settled}`} />
          <Stat label="Won" value={`${summary.wins}`} tone="text-emerald-500" />
          <Stat label="Lost" value={`${summary.losses}`} tone="text-rose-500" />
          {expanded && <Stat label="Refused" value={`${summary.failed}`} />}
          {expanded && <Stat label="Staked" value={formatAmount(summary.staked, currency)} />}
          <Stat
            label="Profit"
            value={formatSignedAmount(summary.profit, currency)}
            tone={summary.profit > 0 ? 'text-emerald-500' : summary.profit < 0 ? 'text-rose-500' : ''}
          />
          {expanded && <Stat label="Win rate" value={summary.winRate === null ? '—' : `${(summary.winRate * 100).toFixed(0)}%`} />}
          {!expanded && <Stat label="Streak" value={`${summary.lossStreak}`} />}
        </div>

        {expanded && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>Next martingale step {summary.nextMartingaleStep}</span>
            <span>Losing streak {summary.lossStreak}</span>
            {activeContractId !== null && <span className="mono">Holding contract {activeContractId}</span>}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive" role="alert" data-testid="bot-error">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {runs.length ? (
          <ul className="space-y-1.5" data-testid="bot-run-list">
            {[...runs].reverse().map((run) => (
              <RunRow
                key={`${run.index}-${run.contractId ?? 'failed'}`}
                run={run}
                currency={currency}
                liveProfit={run.contractId === activeContractId ? liveProfit : null}
              />
            ))}
          </ul>
        ) : (
          <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">
            No contracts yet. The bot buys the signal one run at a time and waits for each contract to settle.
          </p>
        )}
      </div>

      <footer className="shrink-0 space-y-1.5 border-t border-border bg-background/40 px-3 py-2">
        {stopNote && (
          <p className="text-[10px] leading-snug text-muted-foreground" data-testid="bot-stop-note">
            {stopNote}
            {stopReason === 'manual' || stopReason === 'stop-loss' ? ' Reset clears this page for a fresh run.' : ''}
          </p>
        )}
        <div className="flex items-center gap-2">
          {bot.running ? (
            <button
              type="button"
              onClick={bot.stop}
              className="focus-ring flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-[#db334b] px-4 text-sm font-extrabold text-white transition-colors hover:bg-[#f0445a] active:bg-[#bd203b]"
              data-testid="bot-stop"
            >
              <Square size={14} fill="currentColor" /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={bot.reset}
              disabled={!showReset}
              className="focus-ring flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-bold text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="bot-reset"
            >
              <RotateCcw size={14} /> Reset
            </button>
          )}
          {showReset && bot.running === false && (
            <span className="text-[10px] text-muted-foreground">Clears the traded positions on this page.</span>
          )}
        </div>
      </footer>
    </section>
  );
}
