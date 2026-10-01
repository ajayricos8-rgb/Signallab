import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAnalyzeTicks, type AnalysisInput } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Activity,
  BarChart3,
  Bell,
  Check,
  CircleHelp,
  Clock3,
  Gauge,
  GitCompareArrows,
  LayoutDashboard,
  LineChart,
  ListFilter,
  Menu,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
  Moon,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Home() {
  const indices = [
    { id: 'vol10', name: 'Volatility 10 Index', symbol: 'R_10', code: 'V10', quote: '8,742.16', delta: '+0.38%' },
    { id: 'vol25', name: 'Volatility 25 Index', symbol: 'R_25', code: 'V25', quote: '4,218.93', delta: '-0.16%' },
    { id: 'vol50', name: 'Volatility 50 Index', symbol: 'R_50', code: 'V50', quote: '12,085.40', delta: '+0.72%' },
    { id: 'vol75', name: 'Volatility 75 Index', symbol: 'R_75', code: 'V75', quote: '6,903.27', delta: '+0.11%' },
    { id: 'vol100', name: 'Volatility 100 Index', symbol: 'R_100', code: 'V100', quote: '3,119.84', delta: '-0.44%' },
    { id: 'vol10-1s', name: 'Volatility 10 (1s)', symbol: '1HZ10V', code: '1HZ10V', quote: '2,064.81', delta: '+0.21%' },
    { id: 'vol15-1s', name: 'Volatility 15 (1s)', symbol: '1HZ15V', code: '1HZ15V', quote: '2,384.22', delta: '-0.08%' },
    { id: 'vol25-1s', name: 'Volatility 25 (1s)', symbol: '1HZ25V', code: '1HZ25V', quote: '2,906.44', delta: '-0.32%' },
    { id: 'vol30-1s', name: 'Volatility 30 (1s)', symbol: '1HZ30V', code: '1HZ30V', quote: '3,117.70', delta: '+0.26%' },
    { id: 'vol50-1s', name: 'Volatility 50 (1s)', symbol: '1HZ50V', code: '1HZ50V', quote: '5,817.32', delta: '+0.57%' },
    { id: 'vol75-1s', name: 'Volatility 75 (1s)', symbol: '1HZ75V', code: '1HZ75V', quote: '7,184.90', delta: '+0.16%' },
    { id: 'vol90-1s', name: 'Volatility 90 (1s)', symbol: '1HZ90V', code: '1HZ90V', quote: '8,436.51', delta: '-0.12%' },
    { id: 'vol100-1s', name: 'Volatility 100 (1s)', symbol: '1HZ100V', code: '1HZ100V', quote: '9,562.08', delta: '-0.48%' },
    { id: 'boom50', name: 'Boom 50 Index', symbol: 'BOOM50', code: 'BOOM50', quote: '1,184.62', delta: '+0.36%' },
    { id: 'boom1000', name: 'Boom 1000 Index', symbol: 'BOOM1000', code: 'BOOM1000', quote: '6,432.09', delta: '+0.28%' },
    { id: 'boom150', name: 'Boom 150 Index', symbol: 'BOOM150N', code: 'BOOM150N', quote: '972.55', delta: '-0.17%' },
    { id: 'boom300', name: 'Boom 300 Index', symbol: 'BOOM300N', code: 'BOOM300N', quote: '1,453.67', delta: '+0.83%' },
    { id: 'boom500', name: 'Boom 500 Index', symbol: 'BOOM500', code: 'BOOM500', quote: '2,718.42', delta: '+0.42%' },
    { id: 'boom600', name: 'Boom 600 Index', symbol: 'BOOM600', code: 'BOOM600', quote: '3,108.55', delta: '-0.15%' },
    { id: 'boom900', name: 'Boom 900 Index', symbol: 'BOOM900', code: 'BOOM900', quote: '4,826.17', delta: '+0.64%' },
    { id: 'crash50', name: 'Crash 50 Index', symbol: 'CRASH50', code: 'CRASH50', quote: '1,402.18', delta: '-0.23%' },
    { id: 'crash1000', name: 'Crash 1000 Index', symbol: 'CRASH1000', code: 'CRASH1000', quote: '7,116.53', delta: '-0.18%' },
    { id: 'crash150', name: 'Crash 150 Index', symbol: 'CRASH150N', code: 'CRASH150N', quote: '1,108.74', delta: '+0.14%' },
    { id: 'crash300', name: 'Crash 300 Index', symbol: 'CRASH300N', code: 'CRASH300N', quote: '1,908.24', delta: '-0.58%' },
    { id: 'crash500', name: 'Crash 500 Index', symbol: 'CRASH500', code: 'CRASH500', quote: '2,364.71', delta: '-0.29%' },
    { id: 'crash600', name: 'Crash 600 Index', symbol: 'CRASH600', code: 'CRASH600', quote: '3,765.88', delta: '+0.12%' },
    { id: 'crash900', name: 'Crash 900 Index', symbol: 'CRASH900', code: 'CRASH900', quote: '5,204.36', delta: '-0.41%' },
    { id: 'jump10', name: 'Jump 10 Index', symbol: 'JD10', code: 'JD10', quote: '1,628.46', delta: '+0.37%' },
    { id: 'jump25', name: 'Jump 25 Index', symbol: 'JD25', code: 'JD25', quote: '2,913.70', delta: '-0.22%' },
    { id: 'jump50', name: 'Jump 50 Index', symbol: 'JD50', code: 'JD50', quote: '4,507.18', delta: '+0.54%' },
    { id: 'jump75', name: 'Jump 75 Index', symbol: 'JD75', code: 'JD75', quote: '5,736.91', delta: '+0.13%' },
    { id: 'jump100', name: 'Jump 100 Index', symbol: 'JD100', code: 'JD100', quote: '8,194.27', delta: '-0.36%' },
    { id: 'range100', name: 'Range Break 100', symbol: 'RB100', code: 'RB100', quote: '1,182.39', delta: '+0.18%' },
    { id: 'range200', name: 'Range Break 200', symbol: 'RB200', code: 'RB200', quote: '2,466.04', delta: '-0.11%' },
    { id: 'step100', name: 'Step Index 100', symbol: 'stpRNG', code: 'STEP100', quote: '842.63', delta: '+0.09%' },
    { id: 'step200', name: 'Step Index 200', symbol: 'stpRNG2', code: 'STEP200', quote: '1,416.82', delta: '-0.04%' },
    { id: 'step300', name: 'Step Index 300', symbol: 'stpRNG3', code: 'STEP300', quote: '2,186.47', delta: '+0.19%' },
    { id: 'step400', name: 'Step Index 400', symbol: 'stpRNG4', code: 'STEP400', quote: '2,804.33', delta: '+0.06%' },
    { id: 'step500', name: 'Step Index 500', symbol: 'stpRNG5', code: 'STEP500', quote: '3,715.09', delta: '-0.13%' },
    { id: 'bull', name: 'Bull Market Index', symbol: 'RDBULL', code: 'RDBULL', quote: '1,903.46', delta: '+0.45%' },
    { id: 'bear', name: 'Bear Market Index', symbol: 'RDBEAR', code: 'RDBEAR', quote: '1,721.28', delta: '-0.39%' },
  ];
  const families = [
    { id: 'matches', label: 'Matches', hint: 'Exact digit' },
    { id: 'even-odd', label: 'Even / Odd', hint: 'Parity' },
    { id: 'over-under', label: 'Over / Under', hint: 'Barrier' },
    { id: 'rise-fall', label: 'Rise / Fall', hint: 'Direction' },
  ];
  const [selectedIndex, setSelectedIndex] = useState('vol10');
  const [family, setFamily] = useState('over-under');
  const [generatedFor, setGeneratedFor] = useState<{ symbol: string; family: string } | null>(null);
  const [streaming, setStreaming] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(8_742.16);
  const [ticks, setTicks] = useState([8_738.12, 8_739.44, 8_738.98, 8_741.02, 8_740.67, 8_742.16]);
  const [lastUpdated, setLastUpdated] = useState('08:42:16');
  const [toast, setToast] = useState('');
  const [liveStatus, setLiveStatus] = useState<'connecting' | 'connected' | 'error' | 'offline'>('connecting');
  const [liveError, setLiveError] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const savedTheme = window.localStorage.getItem('signal-lab-theme');
    return savedTheme === 'light' ? 'light' : 'dark';
  });
  const { mutate: runAnalysis, data: analysis, isPending: analysisPending, error: analysisError } = useAnalyzeTicks();
  const socketRef = useRef<WebSocket | null>(null);
  const selected = indices.find((item) => item.id === selectedIndex) ?? indices[0];
  const hasCurrentAnalysis = Boolean(
    analysis
      && generatedFor?.symbol === selected.symbol
      && generatedFor.family === family
      && !analysisPending,
  );
  const appIdConfigured = Boolean(import.meta.env.VITE_DERIV_APP_ID);
  const isLive = liveStatus === 'connected' && appIdConfigured;
  const connectionLabel = liveStatus === 'connected'
    ? 'Live Deriv feed'
    : liveStatus === 'connecting'
      ? 'Connecting to Deriv'
      : liveStatus === 'error'
        ? 'Deriv feed unavailable'
        : 'Feed offline';

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem('signal-lab-theme', theme);
  }, [theme]);

  useEffect(() => {
    const appId = import.meta.env.VITE_DERIV_APP_ID;
    const wsUrl = appId
      ? `wss://api.derivws.com/trading/v1/options/ws/public?app_id=${encodeURIComponent(appId)}`
      : 'wss://api.derivws.com/trading/v1/options/ws/public';
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;
    setLiveStatus('connecting');

    socket.onopen = () => {
      setLiveStatus('connected');
      setLiveError('');
      socket.send(JSON.stringify({ active_symbols: 'brief', req_id: 1 }));
      socket.send(JSON.stringify({ ticks: selected.symbol, subscribe: 1, req_id: 2 }));
    };
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data) as {
        msg_type?: string;
        tick?: { quote?: number; symbol?: string; epoch?: number };
        error?: { message?: string };
      };
      if (data.error) {
        setLiveStatus('error');
        setLiveError(data.error.message ?? 'Deriv returned an unknown error');
        return;
      }
      if (data.msg_type === 'tick' && data.tick?.quote && data.tick.symbol === selected.symbol) {
        const next = Number(data.tick.quote);
        setTick(next);
        setTicks((items) => [...items.slice(-11), next]);
        setLastUpdated(data.tick.epoch ? new Date(data.tick.epoch * 1000).toLocaleTimeString([], { hour12: false }) : new Date().toLocaleTimeString([], { hour12: false }));
      }
    };
    socket.onerror = () => {
      setLiveStatus('error');
      setLiveError('Unable to reach Deriv public market data');
    };
    socket.onclose = () => setLiveStatus('offline');
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [selected.symbol]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ forget_all: 'ticks', req_id: 3 }));
    if (streaming) socket.send(JSON.stringify({ ticks: selected.symbol, subscribe: 1, req_id: 4 }));
  }, [selected.symbol, streaming]);

  useEffect(() => {
    if (!streaming || liveStatus === 'connected') return;
    const timer = window.setInterval(() => {
      setTick((current) => {
        const next = current + (Math.random() - 0.46) * 2.3;
        setTicks((items) => [...items.slice(-11), next]);
        setLastUpdated(new Date().toLocaleTimeString([], { hour12: false }));
        return next;
      });
    }, 2400);
    return () => window.clearInterval(timer);
  }, [liveStatus, selectedIndex, streaming]);

  useEffect(() => {
    const timer = window.setTimeout(() => setToast(''), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const triggerRefresh = () => {
    setRefreshing(true);
    window.setTimeout(() => {
      setRefreshing(false);
      setLastUpdated(new Date().toLocaleTimeString([], { hour12: false }));
      setToast(isLive ? 'Live Deriv tick stream refreshed' : 'Tick buffer refreshed');
    }, 650);
  };

  const chartPoints = useMemo(() => {
    const source = [...ticks, tick];
    const min = Math.min(...source) - 1.3;
    const max = Math.max(...source) + 1.3;
    return source.map((value, index) => {
      const x = 12 + (index / (source.length - 1)) * 76;
      const y = 14 + ((max - value) / (max - min)) * 68;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }, [tick, ticks]);

  const waitingSignal = {
    label: analysisPending ? 'ANALYZING' : 'READY',
    direction: analysisPending ? 'Running selected engines' : 'Waiting for signal generation',
    confidence: 0,
    tone: 'blue',
    detail: analysisPending
      ? 'The signal will appear when the analysis completes.'
      : 'Press Generate signal to analyze the current tick window.',
  };
  const signal = hasCurrentAnalysis && analysis ? analysis.signal : waitingSignal;

  const fallbackFactors = [
    { name: 'Digit distribution', value: 0, note: 'Waiting', color: 'muted' },
    { name: 'Transition signal', value: 0, note: 'Waiting', color: 'muted' },
    { name: 'Momentum pressure', value: 0, note: 'Waiting', color: 'muted' },
    { name: 'Volatility regime', value: 0, note: 'Waiting', color: 'muted' },
  ];
  const analysisFactors = hasCurrentAnalysis && analysis ? analysis.factors : fallbackFactors;
  const fallbackComparison = [
    { label: 'Matches', value: '—', sub: 'Generate a signal', score: 0, accent: 'blue' },
    { label: 'Even / Odd', value: '—', sub: 'Generate a signal', score: 0, accent: 'blue' },
    { label: 'Over / Under', value: '—', sub: 'Generate a signal', score: 0, accent: 'blue' },
    { label: 'Rise / Fall', value: '—', sub: 'Generate a signal', score: 0, accent: 'blue' },
  ];
  const comparison = hasCurrentAnalysis && analysis
    ? analysis.predictions.map((prediction) => ({
      label: prediction.family === 'matches' ? 'Matches' : prediction.family === 'even-odd' ? 'Even / Odd' : prediction.family === 'over-under' ? 'Over / Under' : 'Rise / Fall',
      value: `${Math.round(prediction.probability * 100)}%`,
      sub: prediction.label,
      score: prediction.confidence,
      accent: prediction.tone,
    }))
    : fallbackComparison;
  const factorTone = (value: number) => value >= 65 ? 'mint' : value >= 45 ? 'amber' : 'muted';
  const history = [
    { time: '08:40:32', contract: 'Over / Under', call: 'OVER 5', result: 'Over 5', confidence: '76%', status: 'Aligned' },
    { time: '08:38:08', contract: 'Rise / Fall', call: 'RISE', result: 'Rise', confidence: '71%', status: 'Aligned' },
    { time: '08:35:44', contract: 'Even / Odd', call: 'EVEN', result: 'Odd', confidence: '68%', status: 'Missed' },
    { time: '08:33:19', contract: 'Matches', call: 'MATCH 7', result: '7', confidence: '62%', status: 'Aligned' },
  ];

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <div className="flex min-h-[100dvh]">
        <aside className={`${mobileNav ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-40 flex w-[254px] flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-300 md:static md:translate-x-0`}>
          <div className="flex h-[76px] items-center justify-between border-b border-sidebar-border px-5">
            <div className="flex items-center gap-3">
              <div className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_22px_hsl(158_77%_53%_/_0.18)]">
                <Activity size={18} strokeWidth={2.5} />
                <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-accent" />
              </div>
              <div>
                <div className="text-[15px] font-extrabold tracking-[-0.03em]">SIGNAL LAB</div>
                <div className="mono mt-0.5 text-[9px] font-medium tracking-[0.18em] text-primary">DERIV / ANALYSIS</div>
              </div>
            </div>
            <button onClick={() => setMobileNav(false)} className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent md:hidden" aria-label="Close navigation" data-testid="button-close-navigation"><X size={18} /></button>
          </div>
          <nav className="flex-1 px-3 py-5">
            <div className="eyebrow px-3 pb-2">Workspace</div>
            <button className="focus-ring mb-1 flex w-full items-center gap-3 rounded-lg bg-sidebar-accent px-3 py-2.5 text-left text-sm font-semibold text-foreground" data-testid="button-dashboard-nav"><LayoutDashboard size={16} className="text-primary" /> Dashboard <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" /></button>
            <button className="focus-ring mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" onClick={() => setToast('Signal history is already visible below')} data-testid="button-history-nav"><Clock3 size={16} /> Signal history</button>
            <button className="focus-ring mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" onClick={() => setToast('Comparison view is already visible below')} data-testid="button-compare-nav"><GitCompareArrows size={16} /> Compare families</button>
            <div className="eyebrow px-3 pb-2 pt-7">Tools</div>
            <button className="focus-ring mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" onClick={() => setToast('Filters are ready in the contract controls')} data-testid="button-filters-nav"><ListFilter size={16} /> Signal filters</button>
            <button className="focus-ring mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" onClick={() => setToast('Preferences saved locally for this session')} data-testid="button-settings-nav"><Settings2 size={16} /> Workspace settings</button>
          </nav>
          <div className="border-t border-sidebar-border p-4">
             <div className={`rounded-lg border p-3 ${isLive ? 'border-primary/20 bg-primary/5' : 'border-accent/20 bg-accent/5'}`}>
               <div className={`flex items-center gap-2 text-[11px] font-semibold ${isLive ? 'text-primary' : 'text-accent'}`}><ShieldCheck size={14} /> {isLive ? 'LIVE MARKET DATA' : 'CONNECTION STATUS'}</div>
               <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{isLive ? 'Public Deriv ticks are connected. No trades are placed.' : liveError || 'Connecting to the public Deriv tick stream.'}</p>
               <button onClick={() => setToast(isLive ? 'Public tick feed connected with the configured Deriv App ID' : 'Deriv public feed is reconnecting')} className="mt-3 text-[11px] font-semibold text-accent hover:underline" data-testid="button-live-connection">Connection details →</button>
            </div>
            <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground"><span>Engine status</span><span className="flex items-center gap-1.5 text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-line" /> Healthy</span></div>
          </div>
        </aside>

        {mobileNav && <button className="fixed inset-0 z-30 bg-background/75 md:hidden" onClick={() => setMobileNav(false)} aria-label="Close menu overlay" data-testid="button-menu-overlay" />}
        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur-md sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <button onClick={() => setMobileNav(true)} className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground md:hidden" aria-label="Open navigation" data-testid="button-open-navigation"><Menu size={18} /></button>
              <div>
                <div className="eyebrow">Decision cockpit <span className="mx-1 text-border">/</span> Overview</div>
                <h1 className="mt-1 text-base font-bold tracking-[-0.025em] sm:text-lg">Market analysis workspace</h1>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex"><span className={`h-1.5 w-1.5 rounded-full ${isLive && streaming ? 'bg-primary animate-pulse-line' : liveStatus === 'error' ? 'bg-destructive' : 'bg-muted-foreground'}`} /> {streaming ? connectionLabel : 'Stream paused'}</div>
              <button onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} className="focus-ring rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={theme === 'dark'} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} data-testid="button-theme-toggle">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
              <button onClick={() => setToast('No unread alerts')} className="focus-ring rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground" aria-label="View alerts" data-testid="button-alerts"><Bell size={16} /></button>
              <button onClick={() => setToast('Workspace settings are saved locally')} className="hidden focus-ring rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground sm:block" aria-label="Open settings" data-testid="button-settings"><SlidersHorizontal size={16} /></button>
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-xs font-bold text-primary">SL</div>
            </div>
          </header>

          <div className="terminal-grid min-h-[calc(100dvh-76px)] px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
            <div className="mx-auto max-w-[1500px]">
              <section className="animate-rise-in flex flex-col justify-between gap-5 md:flex-row md:items-end">
                <div>
                  <div className="flex items-center gap-2"><span className="eyebrow">Active instrument</span><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-[0.12em] ${isLive ? 'border-primary/25 bg-primary/10 text-primary' : 'border-accent/25 bg-accent/10 text-accent'}`}>{isLive ? 'LIVE DERIV' : 'FALLBACK DATA'}</span></div>
                  <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
                    <h2 className="text-3xl font-extrabold tracking-[-0.055em] sm:text-4xl">{selected.name}</h2>
                    <span className="mono mb-1 text-xs text-muted-foreground">{selected.code} · tick stream</span>
                  </div>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">Read the shape of the next contract without hiding the evidence behind the signal.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setStreaming((current) => !current)} className={`focus-ring flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${streaming ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}`} data-testid="button-toggle-stream">{streaming ? <Pause size={14} /> : <Play size={14} />} {streaming ? 'Pause stream' : 'Resume stream'}</button>
                  <button onClick={triggerRefresh} className="focus-ring flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground" data-testid="button-refresh"><RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh</button>
                </div>
              </section>

              <section className="animate-rise-in delay-1 mt-6 rounded-xl border border-card-border bg-card/90 p-3 panel-glow sm:p-4">
                <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
                  <div>
                    <label htmlFor="index-select" className="mb-2 flex items-center justify-between"><span className="eyebrow">Choose index</span><span className="mono text-[10px] text-muted-foreground">{indices.length} continuous indices available</span></label>
                    <select
                      id="index-select"
                      value={selectedIndex}
                      onChange={(event) => {
                        const item = indices.find((option) => option.id === event.target.value);
                        if (!item) return;
                        const nextQuote = Number(item.quote.replaceAll(',', ''));
                        setSelectedIndex(item.id);
                        setTick(nextQuote);
                        setTicks([nextQuote - 3.12, nextQuote - 1.84, nextQuote - 2.3, nextQuote - 1.14, nextQuote - 1.49, nextQuote]);
                        setGeneratedFor(null);
                      }}
                      className="focus-ring h-11 w-full rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground outline-none transition-colors hover:border-primary/50 focus:border-primary sm:max-w-xl"
                      data-testid="select-index"
                    >
                      {indices.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code} · {item.delta}</option>)}
                    </select>
                  </div>
                  <div className="flex min-w-[180px] items-end gap-3 border-t border-border pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
                    <div><div className="eyebrow">Current quote</div><div className="mono mt-1 text-2xl font-medium tracking-[-0.04em] text-foreground" data-testid="text-current-quote">{tick.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div>
                     <div className={`mb-1 flex items-center gap-1 text-xs font-semibold ${selected.delta.startsWith('+') ? 'text-primary' : 'text-destructive'}`}>{selected.delta.startsWith('+') ? <TrendingUp size={14} /> : <TrendingDown size={14} />} {selected.delta}</div>
                  </div>
                </div>
              </section>

              <section className="animate-rise-in delay-2 mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.75fr)]">
                <div className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
                   <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                     <div><div className="eyebrow">Contract family</div><div className="mt-1 text-sm font-bold">What should the next tick do?</div></div>
                      <div className="flex items-center gap-3"><div className={`mono text-[10px] ${analysisPending ? 'text-accent' : analysisError ? 'text-destructive' : 'text-primary'}`}>{analysisPending ? 'ENGINE RUNNING' : analysisError ? 'ANALYSIS FAILED' : hasCurrentAnalysis && analysis ? `${analysis.engines.length} ENGINES READY` : 'READY TO GENERATE'}</div><div className="mono text-[10px] text-muted-foreground">TICK UPDATE {lastUpdated}</div></div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {families.map((item) => <button key={item.id} onClick={() => { setFamily(item.id); setGeneratedFor(null); }} className={`focus-ring rounded-lg border px-3 py-3 text-left transition-all hover:-translate-y-0.5 ${family === item.id ? 'border-primary/60 bg-primary/10' : 'border-border bg-background/35 hover:border-primary/30'}`} data-testid={`button-family-${item.id}`}><div className={`text-xs font-bold ${family === item.id ? 'text-primary' : 'text-foreground'}`}>{item.label}</div><div className="mt-1 text-[10px] text-muted-foreground">{item.hint}</div></button>)}
                  </div>
                  <div className="mt-3 rounded-lg border border-border bg-background/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground" data-testid="text-analysis-selection-hint">
                    {family === 'over-under'
                      ? `The analysis will choose the strongest barrier from 1–8${hasCurrentAnalysis && analysis ? ` · selected ${analysis.predictions.find((prediction) => prediction.family === 'over-under')?.label}` : ''}.`
                      : family === 'matches'
                        ? `The analysis will select the most likely matching digit${hasCurrentAnalysis && analysis ? ` · selected ${analysis.predictions.find((prediction) => prediction.family === 'matches')?.label.replace('MATCH ', '')}` : ''}.`
                        : 'Generate a signal to analyze the selected family against the current tick window.'}
                  </div>
                  <button
                    onClick={() => {
                      const input: AnalysisInput = {
                        symbol: selected.symbol,
                        ticks: [...ticks.slice(-119), tick],
                        family: family as AnalysisInput['family'],
                      };
                      setGeneratedFor(null);
                      runAnalysis({
                        data: input,
                      }, {
                        onSuccess: () => {
                          setGeneratedFor({ symbol: selected.symbol, family });
                          setLastUpdated(new Date().toLocaleTimeString([], { hour12: false }));
                        },
                      });
                    }}
                    disabled={analysisPending}
                    className="focus-ring mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-65"
                    data-testid="button-generate-signal"
                  >
                    <Sparkles size={16} className={analysisPending ? 'animate-pulse' : ''} />
                    {analysisPending ? 'Analyzing tick window…' : 'Generate signal'}
                  </button>
                  {analysisError && <p className="mt-2 text-xs text-destructive" role="alert">Analysis failed. Check the tick window and try again.</p>}
                    <div className="mt-5 flex items-center justify-between border-t border-border pt-4"><span className="eyebrow">Live tick stream</span><span className="mono text-[10px] text-muted-foreground">{hasCurrentAnalysis && analysis ? analysis.sampleSize : [...ticks, tick].length} observations · 2.4s cadence</span></div>
                  <div className="mt-2 flex flex-wrap gap-2">{[...ticks].reverse().slice(0, 8).map((value, index) => <div key={`${value}-${index}`} className={`mono rounded-md border px-2.5 py-1.5 text-[11px] ${index === 0 ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-background/45 text-muted-foreground'}`} data-testid={`text-tick-${index}`}>{value.toFixed(2)}</div>)}</div>
                </div>

                <div className="relative overflow-hidden rounded-xl border border-primary/30 bg-[linear-gradient(145deg,hsl(164_24%_12%),hsl(164_24%_9%))] p-5 panel-glow">
                  <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
                  <div className="relative flex items-start justify-between"><div><div className="eyebrow text-primary/75">Primary signal</div><div className="mt-2 flex items-center gap-3"><span className={`text-3xl font-extrabold tracking-[-0.06em] ${signal.tone === 'mint' ? 'text-primary' : 'text-accent'}`} data-testid="text-primary-signal">{signal.label}</span><Zap size={19} className={signal.tone === 'mint' ? 'text-primary' : 'text-accent'} /></div><div className="mt-1 text-xs text-muted-foreground">{signal.direction}</div></div><div className="text-right"><div className="eyebrow">Confidence</div><div className="mono mt-1 text-2xl font-medium text-foreground" data-testid="text-signal-confidence">{signal.confidence}%</div></div></div>
                  <div className="mt-6 h-2 overflow-hidden rounded-full bg-background"><div className={`h-full rounded-full transition-all duration-500 ${signal.tone === 'mint' ? 'bg-primary' : 'bg-accent'}`} style={{ width: `${signal.confidence}%` }} /></div>
                  <div className="mt-4 flex items-start gap-2 border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground"><Sparkles size={14} className="mt-0.5 shrink-0 text-accent" /> {signal.detail}</div>
                   <button onClick={() => setToast('Signal marked for review')} disabled={!hasCurrentAnalysis} className="focus-ring mt-5 flex w-full items-center justify-center gap-2 rounded-lg border border-primary/35 bg-primary/10 py-2.5 text-xs font-bold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-45" data-testid="button-review-signal"><Check size={14} /> Mark signal for review</button>
                </div>
              </section>

              <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.75fr)]">
                <div className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
                  <div className="flex items-start justify-between"><div><div className="eyebrow">Price action</div><h3 className="mt-1 text-sm font-bold">Synthetic tick chart</h3></div><div className="flex items-center gap-3 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><span className="h-1.5 w-4 rounded-full bg-primary" /> Tick path</span><span className="mono">1m view</span></div></div>
                  <div className="mt-4 h-[225px] rounded-lg border border-border bg-background/45 p-2 sm:h-[260px]"><svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" role="img" aria-label="Synthetic tick price chart" data-testid="chart-tick-price"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="hsl(158 77% 53% / .22)" /><stop offset="100%" stopColor="hsl(158 77% 53% / 0)" /></linearGradient></defs>{[20, 40, 60, 80].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="hsl(160 17% 21% / .65)" strokeWidth=".25" />)}<polyline points={`12,100 ${chartPoints} 88,100`} fill="url(#area)" stroke="none" /><polyline points={chartPoints} fill="none" stroke="hsl(158 77% 53%)" strokeWidth=".8" vectorEffect="non-scaling-stroke" /><circle cx={chartPoints.split(' ').at(-1)?.split(',')[0]} cy={chartPoints.split(' ').at(-1)?.split(',')[1]} r="1.5" fill="hsl(40 95% 62%)" /></svg></div>
                  <div className="mt-3 flex justify-between mono text-[9px] text-muted-foreground"><span>08:41:00</span><span>08:41:30</span><span>08:42:00</span><span>08:42:30</span></div>
                </div>

                <div className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
                  <div className="flex items-start justify-between"><div><div className="eyebrow">Signal anatomy</div><h3 className="mt-1 text-sm font-bold">What formed the call</h3></div><button onClick={() => setToast('Factor weights are based on the local simulation model')} className="text-muted-foreground hover:text-foreground" aria-label="Explain signal factors" data-testid="button-explain-factors"><CircleHelp size={16} /></button></div>
                   <div className="mt-5 space-y-4">{analysisFactors.map((factor) => <div key={factor.name}><div className="mb-1.5 flex justify-between gap-2 text-xs"><span className="text-muted-foreground">{factor.name}</span><span className={factorTone(factor.value) === 'mint' ? 'text-primary' : factorTone(factor.value) === 'amber' ? 'text-accent' : 'text-muted-foreground'}>{factor.note} <span className="mono ml-1 text-[10px]">{factor.value}</span></span></div><div className="h-1.5 rounded-full bg-background"><div className={`h-full rounded-full ${factorTone(factor.value) === 'mint' ? 'bg-primary' : factorTone(factor.value) === 'amber' ? 'bg-accent' : 'bg-muted-foreground/50'}`} style={{ width: `${factor.value}%` }} /></div></div>)}</div>
                    <div className="mt-6 rounded-lg border border-border bg-background/35 p-3 text-[11px] leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">Method note.</span> {hasCurrentAnalysis && analysis ? analysis.methodNote : 'Generate a signal to run the backend analysis on the current tick window. Probabilities are estimates, not a probability of profit.'}</div>
                </div>
              </section>

              <section className="mt-5 rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><div className="eyebrow">Cross-family read</div><h3 className="mt-1 text-sm font-bold">Compare all contract families</h3></div><button onClick={() => setToast('Comparison uses the same active tick window')} className="flex items-center gap-2 self-start text-[11px] font-semibold text-primary hover:underline" data-testid="button-comparison-info"><BarChart3 size={14} /> How scores are formed</button></div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{comparison.map((item) => <button key={item.label} onClick={() => { setFamily(item.label === 'Matches' ? 'matches' : item.label === 'Even / Odd' ? 'even-odd' : item.label === 'Over / Under' ? 'over-under' : 'rise-fall'); setGeneratedFor(null); }} className="group rounded-lg border border-border bg-background/35 p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40" data-testid={`button-comparison-${item.label.toLowerCase().replaceAll(' ', '-')}`}><div className="flex items-center justify-between"><span className="text-xs font-semibold">{item.label}</span><span className={`mono text-xs font-medium ${item.accent === 'mint' ? 'text-primary' : item.accent === 'amber' ? 'text-accent' : 'text-[hsl(var(--chart-4))]'}`}>{item.value}</span></div><div className="mt-2 h-1.5 rounded-full bg-muted"><div className={`h-full rounded-full ${item.accent === 'mint' ? 'bg-primary' : item.accent === 'amber' ? 'bg-accent' : 'bg-[hsl(var(--chart-4))]'}`} style={{ width: `${item.score}%` }} /></div><div className="mt-2 text-[10px] text-muted-foreground">{item.sub}</div></button>)}</div>
              </section>

              <section className="mt-5 grid gap-5 pb-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.75fr)]">
                <div className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
                  <div className="flex items-start justify-between"><div><div className="eyebrow">Recent calls</div><h3 className="mt-1 text-sm font-bold">Signal history</h3></div><button onClick={() => setToast('History is limited to this simulated session')} className="text-[11px] font-semibold text-primary hover:underline" data-testid="button-view-history">View all</button></div>
                  <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[620px] text-left"><thead><tr className="border-b border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><th className="pb-2 font-semibold">Time</th><th className="pb-2 font-semibold">Family</th><th className="pb-2 font-semibold">Call</th><th className="pb-2 font-semibold">Result</th><th className="pb-2 font-semibold">Confidence</th><th className="pb-2 text-right font-semibold">Status</th></tr></thead><tbody>{history.map((row) => <tr key={row.time} className="border-b border-border/60 text-xs last:border-0"><td className="py-3 mono text-muted-foreground">{row.time}</td><td className="py-3 text-muted-foreground">{row.contract}</td><td className="py-3 font-semibold text-foreground">{row.call}</td><td className="py-3 text-muted-foreground">{row.result}</td><td className="py-3 mono">{row.confidence}</td><td className="py-3 text-right"><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${row.status === 'Aligned' ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'}`}>{row.status}</span></td></tr>)}</tbody></table></div>
                </div>
                <div className="rounded-xl border border-accent/25 bg-accent/5 p-4 panel-glow sm:p-5"><div className="flex items-center gap-2 text-accent"><ShieldCheck size={16} /><div className="eyebrow text-accent">Educational use only</div></div><h3 className="mt-3 text-sm font-bold">A clear read, not a promise.</h3><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{isLive ? 'Live Deriv ticks are connected for market context. Signals remain informational and do not place trades.' : 'Signal Lab is using local representative data while the public Deriv feed reconnects.'}</p><button onClick={() => setToast(isLive ? 'Live public market data is connected; PAT is only needed for account actions' : liveError || 'Waiting for Deriv market data')} className="focus-ring mt-5 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/10 py-2.5 text-xs font-bold text-accent transition-colors hover:bg-accent/20" data-testid="button-connect-live"><Activity size={14} /> {isLive ? 'Connection details' : 'Check live connection'}</button><div className="mt-4 flex items-center gap-2 border-t border-accent/15 pt-3 text-[10px] text-muted-foreground"><Gauge size={13} /> {isLive ? 'Public tick stream: connected' : 'Public tick stream: connecting'}</div></div>
              </section>
            </div>
          </div>
        </main>
      </div>
      {toast && <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-primary/35 bg-card px-4 py-3 text-xs font-semibold text-foreground shadow-lg animate-rise-in" role="status" data-testid="status-toast"><Check size={14} className="text-primary" /> {toast}</div>}
    </div>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
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
