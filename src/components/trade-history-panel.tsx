import { useMemo, useState } from 'react';
import { Activity, Clock3, Loader2, RefreshCw, ShieldAlert, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { DerivConnectionCard, DerivConnectionStatusBadge } from '@/components/deriv-connection-card';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import {
  formatAmount,
  formatEpochDateTime,
  formatEpochTime,
  formatSignedAmount,
  type DerivClosedPosition,
  type DerivOpenPosition,
} from '@/lib/deriv-trading';

const CONTRACT_LABELS: Record<string, string> = {
  CALL: 'Rise',
  PUT: 'Fall',
  DIGITOVER: 'Over',
  DIGITUNDER: 'Under',
  DIGITEVEN: 'Even',
  DIGITODD: 'Odd',
  DIGITMATCH: 'Matches',
  DIGITDIFF: 'Differs',
  MULTUP: 'Multiply up',
  MULTDOWN: 'Multiply down',
};

function contractLabel(contractType: string | null): string {
  if (!contractType) return 'Contract';
  return CONTRACT_LABELS[contractType] ?? contractType;
}

function profitTone(profit: number | null): string {
  if (profit === null || profit === 0) return 'text-muted-foreground';
  return profit > 0 ? 'text-emerald-500' : 'text-rose-500';
}

function statCell(label: string, value: string, tone = '') {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className={`mono mt-0.5 text-xs font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function OpenPositionRow({ position }: { position: DerivOpenPosition }) {
  const trading = useDerivTrading();
  const [confirming, setConfirming] = useState(false);
  const [selling, setSelling] = useState(false);
  const [sellError, setSellError] = useState('');
  const progress =
    position.tickCount !== null && position.tickCount > 0 && position.tickPassed !== null
      ? `${position.tickPassed}/${position.tickCount} ticks`
      : position.expiryTime
        ? `expires ${formatEpochTime(position.expiryTime)}`
        : '—';

  async function handleSell() {
    setSelling(true);
    setSellError('');
    try {
      await trading.sellContract(position.contractId);
      setConfirming(false);
    } catch (error) {
      setSellError(error instanceof Error ? error.message : 'Deriv rejected the sell request.');
    } finally {
      setSelling(false);
    }
  }

  return (
    <li className="px-4 py-3" data-testid={`open-position-${position.contractId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">{contractLabel(position.contractType)}</span>
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-primary">
              Open
            </span>
            <span className="mono text-[11px] text-muted-foreground">#{position.contractId}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {position.symbol ?? 'unknown market'} · {progress}
            {position.longcode ? ` · ${position.longcode}` : ''}
          </div>
        </div>
        <div className="text-right">
          <div className="eyebrow">Running profit</div>
          <div className={`mono text-sm font-bold ${profitTone(position.profit)}`} data-testid={`open-position-profit-${position.contractId}`}>
            {formatSignedAmount(position.profit, position.currency)}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-4">
        {statCell('Stake', formatAmount(position.buyPrice, position.currency))}
        {statCell('Payout', formatAmount(position.payout, position.currency))}
        {statCell('Current spot', position.currentSpot === null ? '—' : String(position.currentSpot))}
        {statCell('Entry spot', position.entrySpot === null ? '—' : String(position.entrySpot))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {position.isValidToSell ? (
          confirming ? (
            <>
              <button
                type="button"
                onClick={() => void handleSell()}
                disabled={selling}
                className="focus-ring inline-flex h-8 items-center gap-2 rounded-lg bg-destructive px-3 text-xs font-bold text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-60"
                data-testid={`button-confirm-sell-${position.contractId}`}
              >
                {selling ? <Loader2 size={13} className="animate-spin" /> : <TrendingDown size={13} />}
                Sell at market
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={selling}
                className="focus-ring inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                Keep position
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="focus-ring inline-flex h-8 items-center gap-2 rounded-lg border border-destructive/40 px-3 text-xs font-bold text-destructive transition-colors hover:bg-destructive/10"
              data-testid={`button-sell-${position.contractId}`}
            >
              Close early
            </button>
          )
        ) : (
          <span className="text-[11px] text-muted-foreground">
            Deriv does not currently report this contract as sellable; it settles at expiry.
          </span>
        )}
      </div>
      {sellError && (
        <p className="mt-2 text-[11px] font-semibold text-destructive" role="alert">
          {sellError}
        </p>
      )}
    </li>
  );
}

function ClosedPositionRow({ position }: { position: DerivClosedPosition }) {
  return (
    <li className="px-4 py-3" data-testid={`closed-position-${position.contractId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">{contractLabel(position.contractType)}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] ${position.profit > 0 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : position.profit < 0 ? 'border-rose-500/30 bg-rose-500/10 text-rose-500' : 'border-border bg-secondary/60 text-muted-foreground'}`}>
              {position.profit > 0 ? 'Won' : position.profit < 0 ? 'Lost' : 'Settled'}
            </span>
            {position.source === 'contract' && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400">
                <Loader2 size={10} className="animate-spin" />
                Settling
              </span>
            )}
            <span className="mono text-[11px] text-muted-foreground">#{position.contractId}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {position.symbol ?? 'unknown market'} · bought {formatEpochDateTime(position.purchaseTime)} · sold{' '}
            {formatEpochDateTime(position.sellTime)}
          </div>
        </div>
        <div className="text-right">
          <div className="eyebrow">Profit / loss</div>
          <div className={`mono text-sm font-bold ${profitTone(position.profit)}`} data-testid={`closed-position-profit-${position.contractId}`}>
            {formatSignedAmount(position.profit, position.currency)}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-4">
        {statCell('Stake', formatAmount(position.buyPrice, position.currency))}
        {statCell('Sold for', formatAmount(position.sellPrice, position.currency))}
        {statCell('Payout', formatAmount(position.payout, position.currency))}
        {statCell('Source', position.source === 'profit-table' ? 'Deriv profit table' : 'Live settlement')}
      </div>
    </li>
  );
}

export function TradeHistoryPanel() {
  const trading = useDerivTrading();
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [refreshing, setRefreshing] = useState(false);

  const totals = useMemo(() => {
    let openStake = 0;
    let openProfit = 0;
    for (const position of trading.openPositions) {
      if (position.buyPrice !== null) openStake += position.buyPrice;
      if (position.profit !== null) openProfit += position.profit;
    }
    let realised = 0;
    for (const position of trading.closedPositions) realised += position.profit;
    return { openStake, openProfit, realised, closed: trading.closedPositions.length };
  }, [trading.closedPositions, trading.openPositions]);

  const connected = trading.status === 'connected';
  // A dropped socket keeps the last known snapshot on screen instead of
  // hiding the account behind the connection form.
  const hasSession = connected || trading.accounts.length > 0;

  async function handleRefresh() {
    setRefreshing(true);
    trading.refresh();
    window.setTimeout(() => setRefreshing(false), 900);
  }

  if (!hasSession) {
    return (
      <div className="mx-auto w-full max-w-[1500px] space-y-4">
        <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
          <div className="eyebrow">Workspace records</div>
          <h2 className="mt-1 text-xl font-bold tracking-tight">Open and closed positions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Positions are read from the Deriv account you authorise. Connect a Personal Access Token to stream open
            contracts and load the account profit table.
          </p>
        </section>
        <DerivConnectionCard />
        {trading.status === 'error' && (
          <p className="text-xs text-muted-foreground">
            The connection failed. Fix the token or network problem above, then reconnect.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-4">
      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="eyebrow">Workspace records · live from Deriv</div>
            <h2 className="mt-1 text-xl font-bold tracking-tight">Open and closed positions</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Open contracts stream from the authorised account; closed contracts come from the account profit table.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DerivConnectionStatusBadge compact />
            <button
              type="button"
              onClick={() => void handleRefresh()}
              className="focus-ring inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-xs font-bold transition-colors hover:border-primary/50 hover:text-primary"
              data-testid="button-refresh-positions"
            >
              {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Account</div>
            <div className="mono mt-1 text-sm font-bold">{trading.activeAccount?.accountId ?? '—'}</div>
            <div className="text-[10px] text-muted-foreground">
              {trading.activeAccount?.accountType === 'real' ? 'Real money' : 'Demo'} · {trading.activeAccount?.currency}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Balance</div>
            <div className="mono mt-1 flex items-center gap-2 text-sm font-bold">
              <Wallet size={14} className="text-primary" />
              {formatAmount(trading.balance, trading.currency || trading.activeAccount?.currency || '')}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Open exposure</div>
            <div className="mono mt-1 flex items-center gap-2 text-sm font-bold">
              <Activity size={14} className="text-primary" />
              {formatAmount(totals.openStake, trading.currency)}
              <span className={`text-xs ${profitTone(totals.openProfit)}`}>{formatSignedAmount(totals.openProfit, trading.currency)}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">{trading.openPositions.length} open contract(s)</div>
          </div>
          <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="eyebrow">Realised result</div>
            <div className={`mono mt-1 flex items-center gap-2 text-sm font-bold ${profitTone(totals.realised)}`}>
              {totals.realised >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              {formatSignedAmount(totals.realised, trading.currency)}
            </div>
            <div className="text-[10px] text-muted-foreground">{totals.closed} settled contract(s) in history</div>
          </div>
        </div>

        {trading.error && (
          <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
            {trading.error}
          </div>
        )}

        {!connected && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300" role="status">
            The trading socket is not connected right now, so the lists below are the last snapshot Deriv sent. Reconnect
            from <strong className="font-bold">Settings</strong> to resume live profit updates and to close positions.
          </div>
        )}

        <div role="group" aria-label="Position views" className="mt-4 flex items-center gap-1 border-b border-border">
          <button
            type="button"
            onClick={() => setTab('open')}
            aria-pressed={tab === 'open'}
            className={`focus-ring -mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${tab === 'open' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            data-testid="positions-tab-open"
          >
            Open ({trading.openPositions.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('closed')}
            aria-pressed={tab === 'closed'}
            className={`focus-ring -mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${tab === 'closed' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            data-testid="positions-tab-closed"
          >
            Closed ({trading.closedPositions.length})
          </button>
        </div>

        {tab === 'open' ? (
          trading.openPositions.length ? (
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border" data-testid="open-positions-list">
              {trading.openPositions.map((position) => (
                <OpenPositionRow key={position.contractId} position={position} />
              ))}
            </ul>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-border bg-background/40 px-4 py-10 text-center text-sm text-muted-foreground" data-testid="open-positions-empty">
              No open contracts on this account. Configure a contract in the trade dock and press Trade to open one.
            </div>
          )
        ) : trading.closedPositions.length ? (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border" data-testid="closed-positions-list">
            {trading.closedPositions.map((position) => (
              <ClosedPositionRow key={position.contractId} position={position} />
            ))}
          </ul>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-border bg-background/40 px-4 py-10 text-center text-sm text-muted-foreground" data-testid="closed-positions-empty">
            No settled contracts were returned by the account profit table yet.
          </div>
        )}

        <p className="mt-3 flex items-start gap-2 text-[10px] leading-relaxed text-muted-foreground">
          <Clock3 size={12} className="mt-0.5 shrink-0" />
          Positions are read-only records of what Deriv reports for this account. Profit updates arrive while a contract
          is open, and a settled contract moves from the open list to history once Deriv confirms the sale.
        </p>
      </section>

      {trading.activeAccount?.accountType === 'real' && (
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />
          This account trades real money: every confirmed order and early close settles against your Deriv balance.
        </p>
      )}
    </div>
  );
}
