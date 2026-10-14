import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, ChevronDown, ChevronUp, Settings2, ShieldCheck, WifiOff } from 'lucide-react';
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
import {
  TRADE_DURATION_UNITS,
  draftDurationIssue,
  formatTradeDuration,
  type DurationSupport,
  type TradeDurationUnit,
} from '@/lib/trade-duration';

type MarketChoice = { code: string; name: string };

type TradeDockProps = {
  family: TradeFamily;
  marketCode: string | null;
  marketName: string | null;
  // Rise/Fall has a manual draft market; digit panels use their existing market picker.
  marketChoices?: readonly MarketChoice[];
  onMarketChange?: (code: string) => void;
  /** Research / tick expiry in ticks. Time-based trade durations are kept separate. */
  expiry: number | null;
  expiryOptions: number[];
  onExpiryChange: (ticks: number | null) => void;
  expiryVerified: boolean;
  /** Deriv-reported contract support for the selected market, when available. */
  contracts?: readonly DurationSupport[];
};

const fieldClass =
  'flex min-w-0 flex-col gap-1 text-[10px] font-bold uppercase tracking-[0.04em] text-slate-300 lg:flex-1';
const controlClass =
  'h-9 w-full min-w-0 rounded-lg border border-[#385677] bg-[#162f50] px-2 text-xs font-semibold normal-case tracking-normal text-white outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-300/35 disabled:cursor-not-allowed disabled:opacity-60';

const COLLAPSED_KEY = 'signal-lab-trade-dock-collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

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
  contracts,
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
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [durationUnit, setDurationUnit] = useState<TradeDurationUnit>('t');
  const [timeDurationText, setTimeDurationText] = useState('');
  const titleId = useId();
  const noteId = useId();
  const bodyId = useId();
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

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // Keep the toggle state in memory when storage is unavailable.
    }
  }, [collapsed]);

  const timeDuration = /^\d+$/.test(timeDurationText.trim())
    ? Number(timeDurationText.trim())
    : null;
  const tickDurationValid = expiry !== null && expiryOptions.includes(expiry);
  const durationIssue =
    durationUnit === 't'
      ? tickDurationValid
        ? draftDurationIssue(expiry, 't', contractType, contracts, expiryVerified)
        : ''
      : draftDurationIssue(timeDuration, durationUnit, contractType, contracts, expiryVerified);
  const tradeDuration = durationUnit === 't' ? (tickDurationValid ? expiry : null) : timeDuration;
  const selectedDurationLabel =
    tradeDuration !== null && !durationIssue
      ? formatTradeDuration(tradeDuration, durationUnit)
      : 'Not selected';
  const connected = trading.status === 'connected';
  const currency = trading.currency || trading.activeAccount?.currency || '';
  const stakeValue = stakeValid ? Number(stake.trim()) : null;

  const tradeRequest = useMemo<DerivTradeRequest | null>(() => {
    if (!marketCode || stakeValue === null || tradeDuration === null || durationIssue) return null;
    return {
      contractType,
      symbol: marketCode,
      currency,
      stake: stakeValue,
      duration: tradeDuration,
      durationUnit,
      barrier: barrierFor(
        contractType,
        family === 'over-under' ? barrier : family === 'matches' ? targetDigit : null,
      ),
    };
  }, [
    barrier,
    contractType,
    currency,
    durationIssue,
    durationUnit,
    family,
    marketCode,
    stakeValue,
    targetDigit,
    tradeDuration,
  ]);

  function handleContractChange(value: TradeContractType) {
    setContractType(value);
    setTicketIssue('');
    setDialogOpen(false);
    const validBarriers = draftBarriers(value);
    if (validBarriers.length && !validBarriers.includes(barrier))
      setBarrier(validBarriers[0]);
  }

  function handleUnitChange(unit: TradeDurationUnit) {
    setDurationUnit(unit);
    setTicketIssue('');
    setDialogOpen(false);
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
    if (durationUnit === 't' && !tickDurationValid) {
      setTicketIssue('Choose a tick expiry reported by Deriv for this contract.');
      return;
    }
    if (durationIssue) {
      setTicketIssue(durationIssue);
      return;
    }
    if (tradeDuration === null) {
      setTicketIssue('Enter a positive whole-number duration.');
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
        data-collapsed={collapsed ? 'true' : 'false'}
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
            {collapsed && (
              <span className="hidden truncate text-[11px] font-medium text-slate-300 sm:inline">
                {contractLabel} · {selectedDurationLabel}
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <DerivConnectionStatusBadge compact variant="dock" />
              <button
                type="button"
                onClick={() => setCollapsed((value) => !value)}
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#385677] bg-[#162f50] px-2.5 text-[11px] font-bold text-slate-100 transition-colors hover:border-sky-300/60"
                data-testid="trade-dock-toggle"
                title={collapsed ? 'Expand trade setup' : 'Minimize trade setup'}
              >
                {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                <span className="hidden sm:inline">{collapsed ? 'Expand' : 'Minimize'}</span>
                <span className="sm:hidden">{collapsed ? 'Show' : 'Hide'}</span>
              </button>
            </span>
          </div>

          {!collapsed && (
            <div id={bodyId} data-testid="trade-dock-body">
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
                  Duration unit
                  <select
                    value={durationUnit}
                    onChange={(event) => handleUnitChange(event.target.value as TradeDurationUnit)}
                    className={controlClass}
                    data-testid="trade-duration-unit-select"
                    aria-label="Trade duration unit"
                  >
                    {TRADE_DURATION_UNITS.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {durationUnit === 't' ? (
                  <label className={fieldClass}>
                    Duration · ticks
                    <select
                      value={tickDurationValid ? expiry : ''}
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
                ) : (
                  <label className={fieldClass}>
                    Duration · {durationUnit === 's' ? 'seconds' : 'minutes'}
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder={durationUnit === 's' ? 'e.g. 60' : 'e.g. 5'}
                      value={timeDurationText}
                      onChange={(event) => {
                        setTimeDurationText(event.target.value);
                        setTicketIssue('');
                      }}
                      aria-invalid={Boolean(durationIssue)}
                      className={controlClass}
                      data-testid="trade-duration-input"
                    />
                  </label>
                )}
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
                ) : durationIssue ? (
                  <span className="font-bold text-rose-300" role="alert">
                    {durationIssue}{' '}
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
                {durationUnit !== 't' && (
                  <>Trade duration is {selectedDurationLabel}; the research analysis above remains tick-based and is unchanged. </>
                )}
                {durationUnit !== 't' && !contracts && (
                  <>Deriv confirms time-based availability in the live proposal. </>
                )}
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
          )}
        </div>
      </section>

      <TradeConfirmationDialog
        open={dialogOpen}
        onOpenChange={closeDialog}
        request={tradeRequest}
        contractLabel={`${contractLabel} · ${selectedDurationLabel}`}
      />
    </>,
    document.body,
  );
}
