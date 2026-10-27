import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import {
  ArrowRight, BookOpen, Boxes, ChartNoAxesCombined, CheckCircle2, CircleHelp, Maximize2,
  Library, Link2, LoaderCircle, LockKeyhole, Search, ShieldAlert, Sparkles, Unlink, X,
  type LucideProps,
} from 'lucide-react';
import { useDerivTrading } from '@/components/deriv-trading-provider';

type SpaceView = 'builder' | 'chart' | 'store';
type LinkState = 'idle' | 'connecting' | 'connected';
type Strategy = {
  id: string;
  name: string;
  category: 'Progression' | 'Reverse progression' | 'Sequence';
  short: string;
  detail: string;
  risk: string;
  accent: string;
  icon: ComponentType<LucideProps>;
};

// These map directly to Deriv's quick-strategy forms. Selecting one opens the
// real configuration flow; no strategy is silently generated or run.
const STRATEGIES: Strategy[] = [
  { id: 'MARTINGALE', name: 'Martingale', category: 'Progression', short: 'Increase the stake after a loss and reset it after a win.', detail: 'A loss-recovery progression that multiplies the next stake after a losing trade. Choose the multiplier and limits in the strategy form.', risk: 'Stake can grow rapidly during consecutive losses.', accent: 'blue', icon: Boxes },
  { id: 'D_ALEMBERT', name: "D’Alembert", category: 'Progression', short: 'Adjust your stake in fixed steps after wins and losses.', detail: 'A gradual progression that increases stake by a chosen unit after a loss and decreases it after a win.', risk: 'Consecutive losses can still increase your exposure.', accent: 'violet', icon: ChartNoAxesCombined },
  { id: 'OSCARS_GRIND', name: "Oscar’s Grind", category: 'Progression', short: 'A measured staking sequence that adjusts after wins.', detail: 'A progression that adjusts the stake during a sequence of trades according to the strategy’s profit target.', risk: 'Profit targets do not prevent a series of losses.', accent: 'amber', icon: Sparkles },
  { id: 'REVERSE_MARTINGALE', name: 'Reverse Martingale', category: 'Reverse progression', short: 'Increase the stake after a win rather than a loss.', detail: 'A reverse progression that multiplies the next stake following a win and resets after a loss.', risk: 'A loss can erase gains from a winning sequence.', accent: 'teal', icon: Boxes },
  { id: 'REVERSE_D_ALEMBERT', name: 'Reverse D’Alembert', category: 'Reverse progression', short: 'Step the stake up after a win and down after a loss.', detail: 'The reverse version of D’Alembert, using a configurable unit to adjust the stake after each result.', risk: 'Changing stake does not create a trading edge.', accent: 'rose', icon: ChartNoAxesCombined },
  { id: 'STRATEGY_1_3_2_6', name: '1-3-2-6', category: 'Sequence', short: 'Follow a four-step staking sequence across winning trades.', detail: 'A four-stage progression based on stake multiples of 1, 3, 2, and 6. Review the sequence and exit rules before use.', risk: 'The sequence can end in loss at any stage.', accent: 'indigo', icon: Sparkles },
];

const views: { id: SpaceView; label: string; icon: ComponentType<LucideProps> }[] = [
  { id: 'builder', label: 'Bot builder', icon: Boxes },
  { id: 'chart', label: 'Charts', icon: ChartNoAxesCombined },
  { id: 'store', label: 'Bot store', icon: Library },
];

export function DbotSpace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const trading = useDerivTrading();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const tradingRef = useRef(trading);
  tradingRef.current = trading;
  const [view, setView] = useState<SpaceView>('builder');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [linkState, setLinkState] = useState<LinkState>('idle');
  const [linkAccount, setLinkAccount] = useState('');
  const grantRef = useRef<string | null>(null);
  const grantRevisionRef = useRef(0);
  const pendingStrategy = useRef<string | null>(null);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [details, setDetails] = useState<Strategy | null>(null);

  const send = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ source: 'signal-lab', ...message }, window.location.origin);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.source !== 'signal-lab-dbot') return;
      if (data.type === 'ready') {
        readyRef.current = true;
        setReady(true);
        if (viewRef.current !== 'store') send({ type: 'navigate', tab: viewRef.current });
        if (pendingStrategy.current) {
          send({ type: 'quick-strategy', strategy: pendingStrategy.current });
          pendingStrategy.current = null;
        }
      } else if (data.type === 'quick-strategy-open') {
        // The embedded wizard's footer is fixed to the iframe, not to the host
        // viewport. Bring it above the host's fixed navigation on small screens.
        window.requestAnimationFrame(() => {
          const bottom = frameRef.current?.getBoundingClientRect().bottom;
          if (bottom && bottom > window.innerHeight - 90) window.scrollBy({ top: bottom - window.innerHeight + 90, behavior: 'smooth' });
        });
      } else if (data.type === 'active-tab' && viewRef.current !== 'store') {
        if (data.tab === 1) setView('builder');
        else if (data.tab === 2) setView('chart');
      } else if (data.type === 'account-connected' && data.accountId === grantRef.current && data.grantId === grantRevisionRef.current) {
        setLinkState('connected');
        setLinkAccount(String(data.accountId));
        setNotice('DBot is connected. Review your blocks and limits before running.');
      } else if (data.type === 'account-disconnected' && data.grantId === grantRevisionRef.current) {
        grantRef.current = null;
        grantRevisionRef.current += 1;
        setLinkState('idle');
        setLinkAccount('');
        if (data.reason === 'connection-lost') setNotice('The DBot connection closed, so the strategy was stopped. Open contracts may still settle. Link the account again to continue.');
      } else if (data.type === 'account-error' && data.grantId === grantRevisionRef.current) {
        grantRef.current = null;
        grantRevisionRef.current += 1;
        setLinkState('idle');
        setLinkAccount('');
        setNotice(typeof data.message === 'string' ? data.message : 'DBot could not connect the account.');
      } else if (data.type === 'error') {
        setNotice(typeof data.message === 'string' ? data.message : 'DBot could not complete that action.');
      } else if (data.type === 'request-otp' && typeof data.requestId === 'number') {
        const accountId = data.accountId;
        const requestId = data.requestId;
        const session = tradingRef.current;
        if (!grantRef.current || accountId !== grantRef.current || session.activeAccount?.accountId !== grantRef.current || session.status !== 'connected') {
          send({ type: 'otp-response', requestId, accountId, error: 'The selected Signal Lab account is no longer connected.' });
          return;
        }
        const revision = grantRevisionRef.current;
        void session.createBotSocket().then((socket) => {
          if (grantRevisionRef.current !== revision || grantRef.current !== accountId || tradingRef.current.activeAccount?.accountId !== accountId || tradingRef.current.status !== 'connected') {
            send({ type: 'otp-response', requestId, accountId, error: 'The account changed while reconnecting.' });
            return;
          }
          send({ type: 'otp-response', requestId, accountId, url: socket.url });
        }).catch((error: unknown) => send({ type: 'otp-response', requestId, accountId, error: error instanceof Error ? error.message : 'Could not reconnect DBot.' }));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [send]);

  // A grant belongs to one exact account. Switching or disconnecting in Settings
  // revokes it and stops the bot rather than quietly trading a different account.
  useEffect(() => {
    if (!grantRef.current) return;
    if (trading.activeAccount?.accountId !== grantRef.current || trading.status !== 'connected') {
      send({ type: 'disconnect-account', grantId: grantRevisionRef.current });
      grantRef.current = null;
      grantRevisionRef.current += 1;
      setLinkState('idle');
      setLinkAccount('');
      setNotice('DBot was disconnected because the Signal Lab account changed or disconnected. Open contracts may still settle.');
    }
  }, [trading.activeAccount?.accountId, trading.status, send]);

  useEffect(() => {
    if (linkState !== 'connecting') return;
    const timer = window.setTimeout(() => {
      send({ type: 'disconnect-account', grantId: grantRevisionRef.current });
      grantRef.current = null;
      grantRevisionRef.current += 1;
      setLinkState('idle');
      setNotice('DBot did not confirm the account connection. Check the connection and try again.');
    }, 25_000);
    return () => window.clearTimeout(timer);
  }, [linkState, send]);

  function selectView(next: SpaceView) {
    setView(next);
    setNotice('');
    if (next !== 'store' && readyRef.current) send({ type: 'navigate', tab: next });
  }

  async function connectAccount() {
    if (linkState !== 'idle') return;
    if (!ready) { setNotice('Wait for the bot workspace to finish connecting before linking an account.'); return; }
    if (trading.status !== 'connected' || !trading.activeAccount) { onOpenSettings(); return; }
    const account = trading.activeAccount;
    const accountLabel = account.accountType === 'real' ? 'REAL' : account.accountType === 'demo' ? 'demo' : 'selected';
    if (!window.confirm(`Allow DBot to use your ${accountLabel} account ${account.accountId}?\n\nA running strategy can place trades and lose money. Nothing will run until you press Run in the builder. Use a demo account first.\n\nThe embedded workspace shares this site's browser storage. Signal Lab sends it a short-lived socket URL instead of your PAT.`)) return;
    grantRef.current = account.accountId;
    const revision = ++grantRevisionRef.current;
    setLinkState('connecting');
    setNotice('Connecting DBot to the selected account…');
    try {
      const socket = await trading.createBotSocket();
      if (grantRevisionRef.current !== revision || grantRef.current !== socket.accountId || tradingRef.current.activeAccount?.accountId !== socket.accountId || tradingRef.current.status !== 'connected') return;
      send({ type: 'connect-account', grantId: revision, ...socket });
    } catch (error) {
      if (grantRevisionRef.current !== revision) return;
      grantRef.current = null;
      grantRevisionRef.current += 1;
      setLinkState('idle');
      setNotice(error instanceof Error ? error.message : 'Could not connect DBot to this account.');
    }
  }

  function disconnectAccount() {
    if (!window.confirm('Disconnect DBot and stop its strategy? Open contracts may continue to settle on Deriv.')) return;
    send({ type: 'disconnect-account', grantId: grantRevisionRef.current });
    grantRef.current = null;
    grantRevisionRef.current += 1;
    setLinkState('idle');
    setLinkAccount('');
    setNotice('DBot disconnected. Open contracts may still settle.');
  }

  function useStrategy(strategy: Strategy) {
    if (!window.confirm(`Open ${strategy.name} in Quick strategy? Review the market, stake, and loss limits before creating or running it.`)) return;
    setDetails(null);
    setView('builder');
    if (readyRef.current) send({ type: 'quick-strategy', strategy: strategy.id });
    else { pendingStrategy.current = strategy.id; setNotice('The strategy form will open as soon as the workspace connects.'); }
  }

  const matching = STRATEGIES.filter((item) =>
    (category === 'All' || item.category === category)
    && `${item.name} ${item.short} ${item.category}`.toLowerCase().includes(search.toLowerCase().trim()),
  );

  return (
    <section className="dbot-space mx-auto w-full max-w-[1700px]" data-testid="dbot-space">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.16em] text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Build, test, automate
          </div>
          <h2 className="text-2xl font-extrabold tracking-[-.045em] sm:text-3xl">DBot Space</h2>
          <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">Build a strategy with visual blocks, explore live charts, or start with a bot from the store.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[10px] font-semibold text-muted-foreground" data-testid="dbot-account-status">
            <span className={`h-1.5 w-1.5 rounded-full ${linkState === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {linkState === 'connected' ? `Connected · ${linkAccount}` : linkState === 'connecting' ? 'Connecting account' : 'Account not linked'}
          </span>
          {linkState === 'connected' ? (
            <button type="button" onClick={disconnectAccount} className="dbot-outline-button" data-testid="dbot-disconnect-account"><Unlink size={14} /> Disconnect</button>
          ) : (
            <button type="button" onClick={() => void connectAccount()} disabled={linkState === 'connecting'} className="dbot-outline-button" data-testid="dbot-connect-account">
              {linkState === 'connecting' ? <LoaderCircle className="animate-spin" size={14} /> : <Link2 size={14} />}
              {trading.status === 'connected' ? 'Link account' : 'Connect account'}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
        <div className="flex gap-1" role="tablist" aria-label="DBot Space sections">
          {views.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => selectView(id)} data-testid={`dbot-view-${id}`}
              className={`focus-ring -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-3 text-xs font-bold transition-colors sm:px-4 sm:text-sm ${view === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
        <div className="hidden items-center gap-1.5 pb-2 text-[10px] font-medium text-muted-foreground sm:flex"><LockKeyhole size={12} /> Keep this browser tab open while running</div>
      </div>

      {notice && <div role="status" className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs leading-5 text-foreground" data-testid="dbot-notice"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss message" className="text-muted-foreground"><X size={14} /></button></div>}

      {/* Keep the frame mounted while viewing the store; unloading it would stop a running bot. */}
      <div className={view === 'store' ? 'hidden' : 'mt-4'}>
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 sm:px-4">
            <div className="flex items-center gap-2 text-[11px] font-bold"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary"><Boxes size={13} /></span> Deriv Bot workspace <span className="hidden font-normal text-muted-foreground sm:inline">/ {view === 'chart' ? 'Charts' : 'Builder'}</span></div>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground" data-testid="dbot-workspace-status"><span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-400' : 'bg-amber-400'}`} />{ready ? 'Workspace ready' : 'Connecting workspace'}</span>
              <button type="button" onClick={() => {
                const frame = frameRef.current;
                if (!frame?.requestFullscreen) { setNotice('Full screen is not available in this browser.'); return; }
                void frame.requestFullscreen().catch(() => setNotice('Full screen could not be opened in this browser.'));
              }} className="inline-flex items-center gap-1 text-[10px] font-bold text-primary hover:underline" title="Expand this workspace without reloading it" data-testid="dbot-fullscreen"><Maximize2 size={12} /> <span className="hidden sm:inline">Full screen</span></button>
            </div>
          </div>
          <iframe ref={frameRef} src={`${import.meta.env.BASE_URL}dbot/index.html#bot_builder`} title="Deriv Bot workspace" allow="fullscreen" allowFullScreen className="block w-full bg-white" style={{ height: 'min(850px, calc(100dvh - 160px))', minHeight: 480 }} data-testid="dbot-frame" onLoad={() => {
            readyRef.current = false;
            setReady(false);
            if (grantRef.current) {
              grantRef.current = null;
              grantRevisionRef.current += 1;
              setLinkState('idle');
              setLinkAccount('');
              setNotice('The workspace reloaded and the account link ended. A running strategy has stopped; open contracts may still settle.');
            }
            send({ type: 'hello' });
          }} />
        </div>
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-muted-foreground"><CircleHelp className="mt-0.5 shrink-0" size={13} /> Drag blocks from the menu, connect them to your strategy, and use the builder’s import and save controls for XML files. A running bot needs this browser tab to remain open.</p>
      </div>

      {view === 'store' && (
        <div className="py-5" data-testid="dbot-store">
          <div className="dbot-store-intro flex flex-wrap items-center justify-between gap-5 rounded-xl border border-primary/20 p-5 sm:p-6">
            <div><span className="dbot-kicker"><Sparkles size={12} /> STRATEGY LIBRARY</span><h3 className="mt-2 text-xl font-extrabold tracking-[-.035em]">A head start for your next bot.</h3><p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">Explore Deriv’s quick strategies, set your own parameters, and open the generated blocks in the builder.</p></div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card/75 px-3 py-2 text-xs font-semibold"><Library size={15} className="text-primary" /><span>{STRATEGIES.length} strategies</span></div>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-sm font-extrabold">Explore strategies</h3><p className="mt-1 text-[11px] text-muted-foreground">Free templates · customisable before use</p></div>
            <div className="flex flex-wrap gap-2">
              <label className="relative"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search strategies" aria-label="Search strategies" data-testid="dbot-store-search" className="h-9 w-48 rounded-lg border border-border bg-card pl-9 pr-3 text-xs outline-none focus:border-primary" /></label>
              <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter strategies" className="h-9 rounded-lg border border-border bg-card px-3 text-xs font-semibold outline-none focus:border-primary" data-testid="dbot-store-filter"><option>All</option><option>Progression</option><option>Reverse progression</option><option>Sequence</option></select>
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {matching.map((strategy) => {
              const Icon = strategy.icon;
              return <article key={strategy.id} className="dbot-strategy-card flex min-h-[210px] flex-col rounded-xl border border-border bg-card p-4" data-testid={`dbot-strategy-${strategy.id}`}>
                <div className="flex items-start justify-between gap-3"><span className={`dbot-strategy-icon dbot-icon-${strategy.accent}`}><Icon size={19} /></span><span className="rounded-full border border-border px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground">{strategy.category}</span></div>
                <h4 className="mt-4 text-sm font-extrabold tracking-tight">{strategy.name}</h4>
                <p className="mt-1.5 flex-1 text-xs leading-5 text-muted-foreground">{strategy.short}</p>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3"><button type="button" onClick={() => setDetails(strategy)} className="text-[11px] font-semibold text-muted-foreground hover:text-foreground">Learn more</button><button type="button" onClick={() => useStrategy(strategy)} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-primary hover:underline" data-testid={`dbot-use-${strategy.id}`}>Use strategy <ArrowRight size={13} /></button></div>
              </article>;
            })}
          </div>
          {!matching.length && <div className="mt-4 rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No strategies match that search. Try another term or filter.</div>}
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[.06] p-4 text-xs leading-5 text-muted-foreground"><ShieldAlert size={17} className="mt-0.5 shrink-0 text-amber-500" /><p><strong className="text-foreground">Trade responsibly.</strong> These are staking templates, not predictions or guarantees. Every strategy can lose money; review the generated blocks and test on a demo account first.</p></div>
        </div>
      )}

      {details && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" role="presentation" onMouseDown={() => setDetails(null)}><div role="dialog" aria-modal="true" aria-labelledby="dbot-details-title" className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-3"><div><div className="dbot-kicker"><BookOpen size={12} /> STRATEGY DETAILS</div><h3 id="dbot-details-title" className="mt-2 text-xl font-extrabold">{details.name}</h3></div><button type="button" onClick={() => setDetails(null)} aria-label="Close strategy details" className="rounded-md p-1 text-muted-foreground hover:bg-secondary"><X size={18} /></button></div><p className="mt-4 text-sm leading-6 text-muted-foreground">{details.detail}</p><p className="mt-4 rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-600 dark:text-amber-300"><strong>Risk note:</strong> {details.risk}</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDetails(null)} className="dbot-outline-button">Close</button><button type="button" onClick={() => useStrategy(details)} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"><CheckCircle2 size={14} /> Use strategy</button></div></div></div>}
    </section>
  );
}
