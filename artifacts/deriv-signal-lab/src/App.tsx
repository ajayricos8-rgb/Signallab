import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { RiseFallTool } from '@/components/rise-fall-tool';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Activity, Bot, Clock3, Menu, Moon, Sun, Wrench, X } from 'lucide-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

type Theme = 'light' | 'dark';
type WorkspaceTab = 'tools' | 'trade-history' | 'premium-bots';
type ToolsMiniTab = 'rise-fall' | 'over-under' | 'even-odd' | 'matches';

const toolsMiniTabs: { id: ToolsMiniTab; label: string }[] = [
  { id: 'rise-fall', label: 'Rise/Fall' },
  { id: 'over-under', label: 'Over/Under' },
  { id: 'even-odd', label: 'Even/Odd' },
  { id: 'matches', label: 'Matches' },
];

const workspaceTabs = [
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'trade-history', label: 'Signal history', icon: Clock3 },
  { id: 'premium-bots', label: 'Premium bots', icon: Bot },
] as const;

function readSavedTheme(): Theme {
  try {
    return window.localStorage.getItem('signal-lab-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function Home() {
  const [mobileNav, setMobileNav] = useState(false);
  const [activeToolsMiniTab, setActiveToolsMiniTab] = useState<ToolsMiniTab>('rise-fall');
  const [theme, setTheme] = useState<Theme>(readSavedTheme);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('tools');
  const selectedTab = workspaceTabs.find(({ id }) => id === activeTab);
  const tabLabel = selectedTab?.label ?? 'Tools';

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
    <div className="min-h-[100dvh] bg-background text-foreground">
      <div className="flex min-h-[100dvh]">
        <aside className={`${mobileNav ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-40 flex w-[254px] flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-300 md:static md:translate-x-0`}>
          <div className="flex h-[76px] items-center justify-between border-b border-sidebar-border px-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_22px_hsl(158_77%_53%_/_0.18)]">
                <Activity size={18} strokeWidth={2.5} />
              </div>
              <div>
                <div className="text-[15px] font-extrabold tracking-[-0.03em]">SIGNAL LAB</div>
                <div className="mono mt-0.5 text-[9px] font-medium tracking-[0.18em] text-primary">WORKSPACE</div>
              </div>
            </div>
            <button onClick={() => setMobileNav(false)} className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent md:hidden" aria-label="Close navigation" data-testid="button-close-navigation"><X size={18} /></button>
          </div>

          <nav className="flex-1 px-3 py-5" aria-label="Workspace navigation">
            <div className="eyebrow px-3 pb-2">Workspace</div>
            {workspaceTabs.map(({ id, label, icon: Icon }) => {
              const active = activeTab === id;
              const testId = id === 'tools' ? 'button-dashboard-nav' : id === 'trade-history' ? 'button-history-nav' : 'button-premium-bots-nav';
              return (
                <button
                  key={id}
                  onClick={() => { setActiveTab(id); setMobileNav(false); }}
                  className={`focus-ring mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${active ? 'bg-sidebar-accent font-semibold text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'}`}
                  data-testid={testId}
                >
                  <Icon size={16} className={active ? 'text-primary' : ''} />
                  {label}
                  {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
                </button>
              );
            })}
          </nav>
        </aside>

        {mobileNav && <button className="fixed inset-0 z-30 bg-background/75 md:hidden" onClick={() => setMobileNav(false)} aria-label="Close menu overlay" data-testid="button-menu-overlay" />}
        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur-md sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <button onClick={() => setMobileNav(true)} className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground md:hidden" aria-label="Open navigation" data-testid="button-open-navigation"><Menu size={18} /></button>
              <div>
                <div className="eyebrow">Signal Lab <span className="mx-1 text-border">/</span> {tabLabel}</div>
                <h1 className="mt-1 text-base font-bold tracking-[-0.025em] sm:text-lg">Market analysis workspace</h1>
              </div>
            </div>
            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="focus-ring rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={theme === 'dark'} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} data-testid="button-theme-toggle">
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </header>

          <div className="min-h-[calc(100dvh-76px)] px-4 py-5 pb-24 sm:px-6 sm:py-7 lg:px-8">
            {activeTab === 'trade-history' ? (
              <div className="mx-auto w-full max-w-[1500px]">
                <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
                  <div className="eyebrow">Workspace records</div>
                  <h2 className="mt-1 text-xl font-bold tracking-tight">Trade history</h2>
                  <p className="mt-1 text-sm text-muted-foreground">No verified records have been stored. The current Rise/Fall tool does not yet persist signals or run a walk-forward trade backtest.</p>
                  <div className="mt-4 rounded-lg border border-dashed border-border bg-background/40 px-4 py-8 text-center text-sm text-muted-foreground">Signal history will remain empty until real, gated outputs are recorded.</div>
                </section>
              </div>
            ) : activeTab === 'premium-bots' ? (
              <div className="mx-auto w-full max-w-3xl rounded-xl border border-card-border bg-card/90 p-6 panel-glow sm:p-8">
                <div className="eyebrow">Premium tools</div>
                <h2 className="mt-1 text-xl font-bold tracking-tight">Premium bots</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Premium bots will be listed here when they are configured for this workspace.</p>
              </div>
            ) : (
              <ToolsWorkspace activeTab={activeToolsMiniTab} onTabChange={setActiveToolsMiniTab} />
            )}
          </div>
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md" aria-label="Workspace tabs" data-testid="bottom-navigation">
        <div className="mx-auto flex w-full max-w-3xl gap-1 px-2 py-2 sm:px-4">
          {workspaceTabs.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            const compactLabel = id === 'trade-history' ? 'History' : id === 'premium-bots' ? 'Premium' : label;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`focus-ring flex min-h-12 min-w-0 flex-1 flex-row items-center justify-center gap-1 rounded-lg px-1 text-[9px] font-semibold leading-tight transition-colors sm:gap-2 sm:px-3 sm:text-xs ${active ? 'text-primary' : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground'}`}
                aria-pressed={active}
                title={label}
                data-testid={`tab-${id}`}
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors sm:h-8 sm:w-8 ${active ? 'bg-primary/10' : ''}`}><Icon size={16} strokeWidth={active ? 2.4 : 1.8} /></span>
                <span className="truncate sm:hidden">{compactLabel}</span>
                <span className="hidden truncate sm:inline">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function ToolsWorkspace({
  activeTab,
  onTabChange,
}: {
  activeTab: ToolsMiniTab;
  onTabChange: (tab: ToolsMiniTab) => void;
}) {
  return (
    <section className="mx-auto w-full max-w-[1500px]" data-testid="tools-workspace">
      <div role="group" aria-label="Tool categories" className="flex w-full items-center gap-1 overflow-x-auto border-b border-border">
        {toolsMiniTabs.map(({ id, label }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              aria-pressed={active}
              className={`focus-ring -mb-px shrink-0 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}`}
              data-testid={`tools-mini-tab-${id}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="min-h-[45vh]" data-testid={`tools-mini-panel-${activeTab}`}>
        {activeTab === 'rise-fall' ? <RiseFallTool /> : null}
      </div>
    </section>
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
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
