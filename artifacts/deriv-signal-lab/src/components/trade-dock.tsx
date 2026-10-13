import { useId, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Settings2, ShieldAlert } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DIGIT_TARGETS,
  TRADE_FAMILIES,
  draftBarriers,
  isValidDraftStake,
  type TradeContractType,
  type TradeFamily,
} from '@/lib/trade-draft';

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
  const [contractType, setContractType] = useState<TradeContractType>(
    TRADE_FAMILIES[family].contracts[0].value,
  );
  const [barrier, setBarrier] = useState(0);
  const [targetDigit, setTargetDigit] = useState(0);
  const [stake, setStake] = useState('1.00');
  const [stakeTouched, setStakeTouched] = useState(false);
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

  function handleContractChange(value: TradeContractType) {
    setContractType(value);
    const validBarriers = draftBarriers(value);
    if (validBarriers.length && !validBarriers.includes(barrier))
      setBarrier(validBarriers[0]);
  }

  function handleTradeClick(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStakeTouched(true);
    // There is deliberately no buy/proposal request here. The button explains
    // that this is a draft, even when some fields have not been filled in yet.
    setDialogOpen(true);
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
            <span className="ml-auto rounded-full border border-sky-200/20 bg-sky-200/5 px-2 py-0.5 text-[10px] font-semibold text-sky-100">
              Draft only
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
              Stake · draft
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
            {stakeTouched && !stakeValid ? (
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
            No account is connected; Trade does not place an order.
          </p>
        </div>
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-testid="trade-unavailable-dialog">
          <DialogHeader>
            <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-rose-500/10 text-rose-500">
              <ShieldAlert size={20} />
            </div>
            <DialogTitle>Trading is not connected</DialogTitle>
            <DialogDescription className="pt-2 leading-relaxed">
              This workspace uses public market data only. There is no
              authorized account, live proposal quote, or order-execution
              connection.{' '}
              <strong className="text-foreground">
                No trade has been placed.
              </strong>
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-secondary/40 p-4 text-xs">
            <dt className="text-muted-foreground">Market</dt>
            <dd className="text-right font-semibold">
              {marketCode
                ? `${marketName ?? marketCode} · ${marketCode}`
                : 'Not selected'}
            </dd>
            <dt className="text-muted-foreground">Contract</dt>
            <dd className="text-right font-semibold">{contractLabel}</dd>
            <dt className="text-muted-foreground">Expiry</dt>
            <dd className="text-right font-semibold">
              {selectedExpiry}
              {expiryVerified ? '' : ' · draft only'}
            </dd>
            <dt className="text-muted-foreground">Stake</dt>
            <dd className="text-right font-semibold">
              {stakeValid ? stake : 'Enter a valid amount'}{' '}
              <span className="font-normal text-muted-foreground">
                · account currency unavailable
              </span>
            </dd>
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">
            These settings are a draft, not an order or a trade recommendation.
            An authorized account, verified contract terms and an explicit
            confirmation flow are needed before live trading can be enabled.
          </p>
          <DialogClose asChild>
            <button
              type="button"
              className="focus-ring h-10 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground hover:bg-primary/90"
            >
              Got it
            </button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </>,
    document.body,
  );
}
