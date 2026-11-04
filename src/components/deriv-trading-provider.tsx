import { createContext, useContext, type ReactNode } from 'react';
import { useDerivTradingSession, type DerivTradingSession } from '@/hooks/use-deriv-trading-session';

const DerivTradingContext = createContext<DerivTradingSession | null>(null);

export function DerivTradingProvider({ children }: { children: ReactNode }) {
  const session = useDerivTradingSession();
  return <DerivTradingContext.Provider value={session}>{children}</DerivTradingContext.Provider>;
}

export function useDerivTrading(): DerivTradingSession {
  const session = useContext(DerivTradingContext);
  if (!session) throw new Error('useDerivTrading must be used inside DerivTradingProvider.');
  return session;
}
