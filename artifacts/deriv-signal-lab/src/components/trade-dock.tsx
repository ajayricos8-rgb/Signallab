import { useId, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Settings2, ShieldCheck, WifiOff } from 'lucide-react';
import { DerivConnectionStatusBadge } from '@/components/deriv-connection-card';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { TradeConfirmationDialog } from '@/components/trade-confirmation-dialog';
import {
  DIGIT_TARGETS,
  TRADE_FAMILIES,
  draftBarriers,
  isValidDraftStake,
  type TradeContractType,
  type TradeFamily,
} from '@/lib/trade-draft';
import { barrierFor, type DerivTradeRequest } from '@/lib/deriv-trading';

type MarketChoice = { code: string; name: string };

type TradeDockProps = {
  family: TradeFamily;
  marketCode: string | null;
  marketName: string | null;
  // Rise/Fall has a manual draft market; digit panels use their existing market picker.
  marketChoices?: readonly MarketChoice[];
  onMarketChange?: (code: string) => void;
  expiry: number | null;
  expiryOptions: number[];
  onExpiryChange: (ticks: number | null) => void;
  expiryVerified: boolean;
};

const fieldClass =
  'flex min-w-0 flex-col gap-1 text-[10px] font-bold uppercase tracking-[0.04em] text-slate-300 lg:flex-1';
const controlClass =
  'h-9 w-full min-w-0 rounded-lg border border-[#385677] bg-[#162f50] px-2 text-xs font-semibold normal-case tracking-normal text-white outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-300/35 disabled:cursor-not-allowed disabled:opacity-60';

export function TradeDock({
  family,
  marketCode,
  marketName,
  marketChoices,
  onMarketChange,
  expiry,
  expiryOptions,
  onExpiryChange,
  expiryVerified,
}: TradeDockProps) {
  const trading = useDerivTrading();
  const [contractType, setContractType] = useState<TradeContractType>(
    TRADE_FAMILIES[family].contracts[0].value,
  );
  const [barrier, setBarrier] = useState(0);
  const [targetDigit, setTargetDigit] = useState(0);
  const [stake, setStake] = useState('1.00');
  const [stakeTouched, setStakeTouched] = useState(false);
  const [ticketIssue, setTicketIssue] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const titleId = useId();
  const noteId = useId();
  const barriers = draftBarriers(contractType);
  const stakeValid = isValidDraftStake(stake);
  const selectedContract =
    TRADE_FAMILIES[family].contracts.find(({ value }) => value === contractType)
      ?.label ?? '—';
  const contractLabel =
    family === 'over-under'
      ? `${selectedContract} ${barrier}`
      : family === 'matches'
        ? `Matches ${targetDigit}`
        : selectedContract;
  const selectedExpiry =
    expiry !== null && expiryOptions.includes(expiry)
      ? `${expiry} ${expiry === 1 ? 'tick' : 'ticks'}`
      : 'Not selected';
  const connected = trading.status === 'connected';
  const currency = trading.currency || trading.activeAccount?.currency || '';
  const stakeValue = stakeValid ? Number(stake.trim()) : null;

  const tradeRequest = useMemo<DerivTradeRequest | null>(() => {
    if (!marketCode || stakeValue === null || expiry === null || !expiryOptions.includes(expiry)) return null;
    return {
      contractType,
      symbol: marketCode,
      currency,
      stake: stakeValue,
      duration: expiry,
      durationUnit: 't',
      barrier: barrierFor(
        contractType,
        family === 'over-under' ? barrier : family === 'matches' ? targetDigit : null,
      ),
    };
  }, [
    barrier,
    contractType,
    currency,
    expiry,
    expiryOptions,
    family,
    marketCode,
    stakeValue,
    targetDigit,
  ]);

  function handleContractChange(value: TradeContractType) {
    setContractType(value);
    const validBarriers = draftBarriers(value);
    if (validBarriers.length && !validBarriers.includes(barrier))
      setBarrier(validBarriers[0]);
  }

  function handleTradeClick(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStakeTouched(true);
    if (!stakeValid) {
      setTicketIssue('Enter a positive stake with up to 2 decimal places.');
      return;
    }
    if (!marketCode) {
      setTicketIssue('Choose a market before trading.');
      return;
    }
    if (expiry === null || !expiryOptions.includes(expiry)) {
      setTicketIssue('Choose a tick expiry reported by Deriv for this contract.');
      return;
    }
    setTicketIssue('');
    setDialogOpen(true);
  }

  // Proposal IDs are short-lived, so the dialog requests a fresh quote every
  // time it opens instead of reusing the one it held before it closed.
  function closeDialog(open: boolean) {
    setDialogOpen(open);
  }

  return createPortal(
    <>
      <section
        className="trade-dock fixed inset-x-0 z-[25] overflow-y-auto border-t border-[#345576] bg-[#0b2140] text-slate-50 shadow-[0_-16px_40px_rgba(3,12,29,0.32)] md:left-[254px]"
        // Workspace navigation: 48px minimum button + 16px padding + 1px border.
        style={{
          bottom: 'calc(65px + env(safe-area-inset-bottom))',
          maxHeight: 'calc(100dvh - 65px - env(safe-area-inset-bottom))',
        }}
        aria-labelledby={titleId}
        data-testid={`trade-dock-${family}`}
      >
        <div className="mx-auto w-full max-w-[1500px] px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-300/10 text-sky-200">
              <Settings2 size={15} />
            </span>
            <h3
              id={titleId}
              className="text-xs font-bold tracking-tight sm:text-sm"
            >
              <span className="sm:hidden">Trade setup</span>
              <span className="hidden sm:inline">Trading configuration</span>
              <span className="ml-1 font-medium text-slate-300">
                · {TRADE_FAMILIES[family].label}
              </span>
            </h3>
            <span className="ml-auto flex items-center gap-2">
              <DerivConnectionStatusBadge compact variant="dock" />
            </span>
          </div>

          <form
            onSubmit={handleTradeClick}
            className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:flex lg:items-end lg:gap-3"
          >
            {marketChoices && onMarketChange && (
              <label className={`${fieldClass} lg:min-w-[145px] lg:flex-[1.4]`}>
                Market
                <select
                  value={marketCode ?? ''}
                  onChange={(event) => onMarketChange(event.target.value)}
                  className={controlClass}
                  data-testid="trade-market-select"
                >
                  {marketChoices.map(({ code, name }) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={fieldClass}>
              Contract
              <select
                value={contractType}
                onChange={(event) =>
                  handleContractChange(event.target.value as TradeContractType)
                }
                className={controlClass}
                data-testid="trade-contract-select"
              >
                {TRADE_FAMILIES[family].contracts.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {family === 'over-under' && (
              <label className={fieldClass}>
                Barrier
                <select
                  value={barrier}
                  onChange={(event) => setBarrier(Number(event.target.value))}
                  className={controlClass}
                  data-testid="trade-barrier-select"
                >
                  {barriers.map((digit) => (
                    <option key={digit} value={digit}>
                      {digit}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {family === 'matches' && (
              <label className={fieldClass}>
                Target digit
                <select
                  value={targetDigit}
                  onChange={(event) =>
                    setTargetDigit(Number(event.target.value))
                  }
                  className={controlClass}
                  data-testid="trade-target-select"
                >
                  {DIGIT_TARGETS.map((digit) => (
                    <option key={digit} value={digit}>
                      {digit}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={fieldClass}>
              Expiry · ticks
              <select
                value={
                  expiry !== null && expiryOptions.includes(expiry)
                    ? expiry
                    : ''
                }
                onChange={(event) =>
                  onExpiryChange(
                    event.target.value ? Number(event.target.value) : null,
                  )
                }
                disabled={!expiryOptions.length}
                className={controlClass}
                data-testid="trade-expiry-select"
              >
                <option value="">
                  {expiryOptions.length
                    ? 'Choose expiry…'
                    : expiryVerified
                      ? 'No tick expiries'
                      : 'Loading…'}
                </option>
                {expiryOptions.map((ticks) => (
                  <option key={ticks} value={ticks}>
                    {ticks} {ticks === 1 ? 'tick' : 'ticks'}
                  </option>
                ))}
              </select>
            </label>
            <label className={fieldClass}>
              Stake {currency ? `· ${currency}` : ''}
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={stake}
                onChange={(event) => setStake(event.target.value)}
                onBlur={() => setStakeTouched(true)}
                aria-invalid={stakeTouched && !stakeValid}
                className={controlClass}
                data-testid="trade-stake-input"
              />
            </label>
            <button
              type="submit"
              className={`focus-ring flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#db334b] px-4 text-sm font-extrabold text-white shadow-[0_4px_14px_rgba(219,51,75,0.25)] transition-colors hover:bg-[#f0445a] active:bg-[#bd203b] lg:w-[136px] ${family === 'even-odd' ? 'col-span-3 sm:col-span-2' : 'col-span-2 sm:col-span-1'}`}
              aria-describedby={noteId}
              data-testid={`button-trade-${family}`}
            >
              Trade <ArrowRight size={16} />
            </button>
          </form>
          <p
            id={noteId}
            className="mt-2 text-[10px] leading-snug text-slate-300"
          >
            {ticketIssue ? (
              <span className="font-bold text-rose-300" role="alert">
                {ticketIssue}{' '}
              </span>
            ) : stakeTouched && !stakeValid ? (
              <span className="font-bold text-rose-300" role="alert">
                Enter a positive stake with up to 2 decimal places.{' '}
              </span>
            ) : null}
            {marketCode ? (
              <>
                <span className="sm:hidden">Market {marketCode}. </span>
                <span className="hidden sm:inline">
                  Market: {marketName ?? marketCode} ({marketCode}).{' '}
                </span>
              </>
            ) : (
              'No market selected. '
            )}
            {family === 'rise-fall'
              ? 'Independent of the automatic scan. '
              : 'Contract settings are independent of research rankings. '}
            {connected ? (
              <span className="inline-flex items-center gap-1 font-semibold text-emerald-300">
                <ShieldCheck size={12} />
                {trading.activeAccount?.accountType === 'real' ? 'Real account' : 'Demo account'}{' '}
                {trading.activeAccount?.accountId} · Trade requests a live Deriv price and buys only after you confirm it.
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 font-semibold text-amber-200">
                <WifiOff size={12} />
                No account connected — Trade opens the PAT connection so you can place this order.
              </span>
            )}
          </p>
        </div>
      </section>

      <TradeConfirmationDialog
        open={dialogOpen}
        onOpenChange={closeDialog}
        request={tradeRequest}
        contractLabel={`${contractLabel} · ${selectedExpiry}`}
      />
    </>,
    document.body,
  );
}
