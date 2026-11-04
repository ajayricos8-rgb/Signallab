import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { DerivTradingProvider } from '@/components/deriv-trading-provider';
import { SignalBotProvider } from '@/components/signal-bot-provider';
import { MarketFeedProvider } from '@/components/market-feed-provider';
import { DbotSpace } from '@/components/dbot-space';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Moon, Sun } from 'lucide-react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

const queryClient = new QueryClient();

type Theme = 'light' | 'dark';

function readSavedTheme(): Theme {
  try {
    return window.localStorage.getItem('signal-lab-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function Home() {
  const [theme, setTheme] = useState<Theme>(readSavedTheme);
  const [analysisRequest] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      window.localStorage.setItem('signal-lab-theme', theme);
    } catch {
      // Keep the selected theme in memory if browser storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    // Remove stale client-side credentials from older versions of the app.
    try {
      window.localStorage.removeItem('signal-lab-session-token');
      window.localStorage.removeItem('signal-lab-session-user');
      window.localStorage.removeItem('signal-lab-device-id');
    } catch {
      // No authentication state is used by this app.
    }
  }, []);

  return (
    // The workspace is the app: Trade history and Settings live inside its own
    // tab bar (see vendor/deriv-bot src/pages/main), so the shell keeps no
    // navigation of its own — only the theme control it has always offered.
    <div className="h-[100dvh] w-full overflow-hidden bg-background text-foreground" data-testid="workspace-root">
      <DbotSpace analysisRequest={analysisRequest} />
      <button
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        className="focus-ring fixed bottom-4 left-4 z-50 rounded-full border border-border/70 bg-background/80 p-2 text-muted-foreground shadow-lg backdrop-blur transition-colors hover:border-primary/50 hover:text-foreground"
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-pressed={theme === 'dark'}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        data-testid="button-theme-toggle"
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DerivTradingProvider>
          {/* Above the bot because every run waits for the entry the analysis
              planned, and that wait reads live ticks even while the user is on
              another workspace tab. */}
          <MarketFeedProvider>
            <SignalBotProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
                <Router />
              </WouterRouter>
            </SignalBotProvider>
          </MarketFeedProvider>
        </DerivTradingProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
