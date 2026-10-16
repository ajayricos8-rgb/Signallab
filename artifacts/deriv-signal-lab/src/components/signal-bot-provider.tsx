// Shared signal bot state.
//
// The bot is started from the mini bottom trade menu of whichever tool
// produced the signal, but it lives above the workspace tabs so switching tool
// or tab never kills a run in progress: the account keeps the contracts it
// already bought, and this provider keeps the run log until it is reset. The
// bot page itself is still rendered by the trade menu, so it always sits
// directly above the ticket it belongs to.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { useSignalBot, type SignalBotPlan } from '@/hooks/use-signal-bot';
import type { SignalBotConfig } from '@/lib/signal-bot/types.ts';

type SignalBotContextValue = {
  bot: ReturnType<typeof useSignalBot>;
  open: boolean;
  expanded: boolean;
  currency: string;
  /** Opens the bot page and starts trading `plan` with the dock's settings. */
  loadAndRun: (plan: SignalBotPlan, config: SignalBotConfig) => void;
  show: () => void;
  hide: () => void;
  setExpanded: (expanded: boolean) => void;
};

const SignalBotContext = createContext<SignalBotContextValue | null>(null);

export function SignalBotProvider({ children }: { children: ReactNode }) {
  const trading = useDerivTrading();
  const bot = useSignalBot();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadAndRun = useCallback(
    (plan: SignalBotPlan, config: SignalBotConfig) => {
      setOpen(true);
      bot.start(plan, config);
    },
    [bot],
  );

  const value = useMemo<SignalBotContextValue>(
    () => ({
      bot,
      open,
      expanded,
      currency: trading.currency || trading.activeAccount?.currency || '',
      loadAndRun,
      show: () => setOpen(true),
      hide: () => setOpen(false),
      setExpanded,
    }),
    [bot, expanded, loadAndRun, open, trading.activeAccount, trading.currency],
  );

  return <SignalBotContext.Provider value={value}>{children}</SignalBotContext.Provider>;
}

export function useSignalBotContext(): SignalBotContextValue {
  const value = useContext(SignalBotContext);
  if (!value) throw new Error('useSignalBotContext must be used inside SignalBotProvider.');
  return value;
}
