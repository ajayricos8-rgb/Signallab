import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BadgeCheck, CheckCircle2, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DerivConnectionCard } from '@/components/deriv-connection-card';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { formatAmount, formatEpochDateTime, type DerivBuyReceipt, type DerivQuote, type DerivTradeRequest } from '@/lib/deriv-trading';
import { formatTradeDuration } from '@/lib/trade-duration';

type Phase = 'review' | 'quoting' | 'quoted' | 'buying' | 'bought';

type TradeConfirmationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fully resolved draft (contract type, market, stake, duration, barrier). */
  request: DerivTradeRequest | null;
  /** Human-readable contract line, e.g. "Over 5 · 5 ticks". */
  contractLabel: string;
  onBought?: (receipt: DerivBuyReceipt) => void;
};

export function TradeConfirmationDialog({
  open,
  onOpenChange,
  request,
  contractLabel,
  onBought,
}: TradeConfirmationDialogProps) {
  const trading = useDerivTrading();
  const [phase, setPhase] = useState<Phase>('review');
  const [quote, setQuote] = useState<DerivQuote | null>(null);
  const [receipt, setReceipt] = useState<DerivBuyReceipt | null>(null);
  const [failure, setFailure] = useState('');
  const generationRef = useRef(0);

  const connected = trading.status === 'connected';
  const onRealAccount = trading.activeAccount?.accountType === 'real';

  const requestQuote = useCallback(async () => {
    if (!request || !connected) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setFailure('');
    setReceipt(null);
    setPhase('quoting');
    try {
      const nextQuote = await trading.requestQuote(request);
      if (generation !== generationRef.current) return;
      setQuote(nextQuote);
      setPhase('quoted');
    } catch (error) {
      if (generation !== generationRef.current) return;
      setQuote(null);
      setPhase('review');
      setFailure(error instanceof Error ? error.message : 'Deriv did not return a price for this contract.');
    }
  }, [connected, request, trading]);

  // A fresh quote is requested each time the ticket opens: proposal IDs are
  // short-lived and the ask price must be re-verified before any purchase.
  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      setPhase('review');
      setQuote(null);
      setReceipt(null);
      setFailure('');
      return;
    }
    if (!request || !connected) return;
    void requestQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connected, request?.contractType, request?.symbol, request?.stake, request?.duration, request?.durationUnit, request?.barrier]);

  async function handleBuy() {
    if (!request || !quote) return;
    setPhase('buying');
    setFailure('');
    try {
      const buyReceipt = await trading.confirmBuy(quote, request);
      setReceipt(buyReceipt);
      setPhase('bought');
      onBought?.(buyReceipt);
    } catch (error) {
      setPhase('quoted');
      setFailure(error instanceof Error ? error.message : 'Deriv rejected the purchase.');
    }
  }

  const potentialProfit = useMemo(() => {
    if (!quote || quote.payout === null) return null;
    return quote.payout - quote.askPrice;
  }, [quote]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-lg" data-testid="trade-ticket-dialog">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2">
            <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${onRealAccount ? 'bg-rose-500/10 text-rose-500' : 'bg-primary/10 text-primary'}`}>
              {onRealAccount ? <AlertTriangle size={20} /> : <ShieldAlert size={20} />}
            </span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] ${onRealAccount ? 'border-rose-500/40 bg-rose-500/10 text-rose-500' : 'border-primary/30 bg-primary/10 text-primary'}`}>
              {onRealAccount ? 'Real account' : 'Demo account'}
            </span>
          </div>
          <DialogTitle>
            {phase === 'bought' ? 'Contract purchased' : 'Confirm this contract'}
          </DialogTitle>
          <DialogDescription className="pt-1 leading-relaxed">
            {connected
              ? 'Deriv is asked for a live price for exactly this contract, then the purchase is sent for your confirmation. Nothing is bought automatically.'
              : 'Connect your Deriv account with a Personal Access Token to request a live price and place this trade.'}
          </DialogDescription>
        </DialogHeader>

        {!connected ? (
          <div className="space-y-3">
            <DerivConnectionCard compact />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Your contract settings stay exactly as entered. Once the token is verified, press Trade again.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-secondary/40 p-4 text-xs">
              <dt className="text-muted-foreground">Account</dt>
              <dd className="mono text-right font-semibold">
                {trading.activeAccount?.accountId} · {trading.activeAccount?.accountType === 'real' ? 'real' : 'demo'}
              </dd>
              <dt className="text-muted-foreground">Market</dt>
              <dd className="text-right font-semibold">{request?.symbol ?? '—'}</dd>
              <dt className="text-muted-foreground">Contract</dt>
              <dd className="text-right font-semibold">{contractLabel}</dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="text-right font-semibold">
                {request ? formatTradeDuration(request.duration, request.durationUnit) : '—'}
              </dd>
              <dt className="text-muted-foreground">Stake</dt>
              <dd className="mono text-right font-semibold" data-testid="trade-ticket-stake">
                {formatAmount(request?.stake ?? null, request?.currency ?? '')}
              </dd>
              <dt className="text-muted-foreground">Live cost</dt>
              <dd className="mono text-right font-semibold" data-testid="trade-ticket-cost">
                {phase === 'quoting' ? 'Requesting…' : formatAmount(quote?.askPrice ?? null, request?.currency ?? '')}
              </dd>
              <dt className="text-muted-foreground">Payout</dt>
              <dd className="mono text-right font-semibold" data-testid="trade-ticket-payout">
                {phase === 'quoting' ? '—' : formatAmount(quote?.payout ?? null, request?.currency ?? '')}
              </dd>
              <dt className="text-muted-foreground">Potential profit</dt>
              <dd className={`mono text-right font-semibold ${potentialProfit !== null && potentialProfit > 0 ? 'text-emerald-500' : ''}`}>
                {phase === 'quoting' ? '—' : formatAmount(potentialProfit, request?.currency ?? '')}
              </dd>
              <dt className="text-muted-foreground">Account balance</dt>
              <dd className="mono text-right font-semibold">
                {formatAmount(trading.balance, trading.currency || (trading.activeAccount?.currency ?? ''))}
              </dd>
            </dl>

            {failure && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive" role="alert" data-testid="trade-ticket-error">
                {failure}
              </div>
            )}

            {phase === 'bought' && receipt ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4" data-testid="trade-ticket-receipt">
                  <div className="flex items-center gap-2 text-sm font-bold text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 size={16} />
                    Contract {receipt.contractId} is open
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <dt className="eyebrow">Buy price</dt>
                      <dd className="mono mt-1 font-semibold">{formatAmount(receipt.buyPrice, request?.currency ?? '')}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">Payout</dt>
                      <dd className="mono mt-1 font-semibold">{formatAmount(receipt.payout, request?.currency ?? '')}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">Balance after</dt>
                      <dd className="mono mt-1 font-semibold">{formatAmount(receipt.balanceAfter, trading.currency)}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">Purchased</dt>
                      <dd className="mt-1 font-semibold">{formatEpochDateTime(receipt.purchaseTime)}</dd>
                    </div>
                  </dl>
                  {receipt.longcode && <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{receipt.longcode}</p>}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  The position is tracked live in the <strong className="text-foreground">Trade history</strong> tab, where
                  open contracts show their running profit and closed contracts move to history when Deriv settles them.
                </p>
                <DialogClose asChild>
                  <button
                    type="button"
                    className="focus-ring h-10 w-full rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground hover:bg-primary/90"
                    data-testid="button-trade-receipt-close"
                  >
                    Done
                  </button>
                </DialogClose>
              </div>
            ) : (
              <>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {onRealAccount
                    ? 'This is a real-money account: the stake is deducted from your Deriv balance when the contract is bought.'
                    : 'This is a demo account: virtual funds only, no real money is involved.'}{' '}
                  Deriv's ask price can move between the quote and the purchase; the order is only sent with the price shown
                  above as its maximum.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleBuy()}
                    disabled={!quote || phase === 'buying' || phase === 'quoting'}
                    className={`focus-ring inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-extrabold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${onRealAccount ? 'bg-[#db334b] hover:bg-[#f0445a]' : 'bg-primary hover:bg-primary/90'}`}
                    data-testid="button-confirm-buy"
                  >
                    {phase === 'buying' ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />}
                    {phase === 'buying'
                      ? 'Sending purchase'
                      : quote
                        ? `Buy for ${formatAmount(quote.askPrice, request?.currency ?? '')}`
                        : 'Waiting for price'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void requestQuote()}
                    disabled={phase === 'buying' || phase === 'quoting'}
                    className="focus-ring inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-xs font-bold transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-60"
                    data-testid="button-requote"
                  >
                    {phase === 'quoting' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    New price
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
