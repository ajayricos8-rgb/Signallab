// DBot Space — the shell around Signal Lab's embedded bot workspace.
//
// The page is deliberately thin: `useDbotWorkspace` owns the iframe, the
// account link and the data bridge, `WorkspacePanel` draws the frame chrome, and
// `StoreView` draws the bot store. This file is the layout, the account cluster
// and the hand-offs to the AI copilot.
import { useCallback, useState, type ComponentType } from 'react';
import {
  Activity, Boxes, ChartNoAxesCombined, Library, Link2, LoaderCircle, LockKeyhole, Unlink, Wallet, X,
  type LucideProps,
} from 'lucide-react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { formatAmount } from '@/lib/deriv-trading';
import { DbotAiCopilot } from '@/components/dbot-ai-copilot';
import { DbotMarketTools } from '@/components/dbot-market-tools';
import type { DbotAiAnalysisSnapshot } from '@/lib/dbot-ai';
import type { Strategy } from './bot-store';
import { linkSummary, type SpaceView } from './protocol';
import { useDbotWorkspace } from './use-dbot-workspace';
import { StoreView } from './store-view';
import { WorkspacePanel } from './workspace-panel';

const VIEWS: Array<{ id: SpaceView; label: string; icon: ComponentType<LucideProps> }> = [
  { id: 'builder', label: 'Bot builder', icon: Boxes },
  { id: 'chart', label: 'Charts', icon: ChartNoAxesCombined },
  { id: 'store', label: 'Bot store', icon: Library },
  { id: 'tools', label: 'Digits & risk', icon: Activity },
];

export function DbotSpace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const trading = useDerivTrading();
  const [view, setView] = useState<SpaceView>('builder');

  const workspace = useDbotWorkspace({
    view,
    onOpenSettings,
    onFrameTab: setView,
  });
  const {
    ready, link, autoLink, autoPaused, notice, botRunning, shared, blockRegistry, aiRuntimeRegistered,
    aiRunNotice, setNotice, setAiRunNotice, showTab, loadBot, loadAndRunBot, openQuickStrategy,
  } = workspace;

  const hasAccount = trading.status === 'connected' && Boolean(trading.activeAccount);
  const balanceLabel = trading.activeAccount
    ? formatAmount(trading.balance, trading.currency || trading.activeAccount.currency)
    : '—';
  const linkLabel = linkSummary({ link, hasAccount, autoLink, autoPaused });

  function selectView(next: SpaceView) {
    setView(next);
    setNotice('');
    showTab(next);
  }

  /** Store hand-off: an AI bot loads its blocks, a quick strategy opens its form. */
  const useStrategy = useCallback((strategy: Strategy) => {
    const xml = strategy.xml;
    const confirmed = window.confirm(
      xml
        ? `Load ${strategy.name} into the bot builder? It replaces the blocks currently on the canvas, and its settings live in the "Run once at start" block.`
        : `Open ${strategy.name} in Quick strategy? Review the market, stake, and loss limits before creating or running it.`,
    );
    if (!confirmed) return;
    setView('builder');
    if (xml) loadBot(xml, strategy.name);
    else openQuickStrategy(strategy.id);
  }, [loadBot, openQuickStrategy]);

  const loadAiStrategy = useCallback((xml: string, name: string) => {
    if (!ready) {
      setNotice('The DBot workspace is still loading. Try loading the AI strategy again in a moment.');
      return;
    }
    setView('builder');
    setAiRunNotice(`${name} is loading into the DBot workspace…`);
    loadBot(xml, name);
  }, [ready, loadBot, setNotice, setAiRunNotice]);

  const loadAndRunAiStrategy = useCallback((xml: string, name: string, analysis: DbotAiAnalysisSnapshot) => {
    if (!ready) {
      setAiRunNotice('The DBot workspace is still loading. Run Analysis again once it is ready.');
      return;
    }
    if (link.status !== 'connected' || !hasAccount) {
      setAiRunNotice('Connect the Signal Lab account to DBot before loading and running this strategy.');
      return;
    }
    if (botRunning) {
      setAiRunNotice('Stop the current DBot strategy before loading another one.');
      return;
    }
    setView('builder');
    setAiRunNotice(`${name} is loading with its exact analysis snapshot…`);
    loadAndRunBot(xml, name, analysis);
  }, [ready, link.status, hasAccount, botRunning, loadAndRunBot, setAiRunNotice]);

  return (
    <section className="dbot-space mx-auto w-full max-w-[1700px]" data-testid="dbot-space">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.16em] text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Build, test, automate
          </div>
          <h2 className="text-2xl font-extrabold tracking-[-.045em] sm:text-3xl">DBot Space</h2>
          <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">
            Build a strategy with visual blocks, explore live charts, or start with a bot from the store. DBot uses
            the Signal Lab account automatically and shares the ticks, balance and positions collected there.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Account cluster: the live balance with a Real/Demo switch. It drives
              the same Signal Lab account selection the connection card uses, so
              DBot re-links to whichever account is active. */}
          <div className="inline-flex items-center gap-2.5 rounded-full border border-border bg-card py-1 pl-1 pr-3" data-testid="dbot-balance-toggle">
            <div className="flex rounded-full bg-muted p-0.5" role="group" aria-label="Account type">
              {(['demo', 'real'] as const).map((kind) => {
                const account = trading.accounts.find((entry) => entry.accountType === kind);
                const active = (trading.activeAccount?.accountType ?? link.accountType) === kind && Boolean(trading.activeAccount);
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={active}
                    data-testid={`dbot-toggle-${kind}`}
                    title={account
                      ? `Trade on the ${kind} account (${account.accountId})`
                      : `No ${kind} account connected yet — add one in Settings`}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                      active
                        ? (kind === 'real' ? 'bg-emerald-500 text-white' : 'bg-sky-500 text-white')
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => {
                      if (active) return;
                      if (botRunning) {
                        setNotice('Stop the running bot before switching between demo and real accounts.');
                        return;
                      }
                      if (!account) {
                        setNotice(`No ${kind} account is connected. Connect a Deriv account with a ${kind} account in Settings, then use this toggle.`);
                        return;
                      }
                      void trading.selectAccount(account.accountId);
                      setNotice(kind === 'real'
                        ? `Switched to your REAL account ${account.accountId}. Bots will trade real money — double-check stake and limits before running.`
                        : `Switched to your demo account ${account.accountId}. Bots trade virtual funds here.`);
                    }}
                  >
                    {kind}
                  </button>
                );
              })}
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-foreground" data-testid="dbot-balance" title="Balance of the active account">
              <Wallet size={13} className="text-primary" />
              {balanceLabel}
            </span>
          </div>

          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[10px] font-semibold text-muted-foreground" data-testid="dbot-account-status">
            <span className={`h-1.5 w-1.5 rounded-full ${
              link.status === 'connected' ? 'bg-emerald-400' : link.status === 'connecting' ? 'bg-sky-400' : 'bg-amber-400'
            }`} />
            {linkLabel}
          </span>

          {link.status === 'connected' ? (
            <button type="button" onClick={workspace.disconnectAccount} className="dbot-outline-button" data-testid="dbot-disconnect-account">
              <Unlink size={14} /> Unlink
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void workspace.connectAccount()}
              disabled={link.status === 'connecting'}
              className="dbot-outline-button"
              data-testid="dbot-connect-account"
            >
              {link.status === 'connecting' ? <LoaderCircle className="animate-spin" size={14} /> : <Link2 size={14} />}
              {link.status === 'connecting'
                ? 'Linking…'
                : hasAccount ? (autoLink ? 'Link now' : 'Link account') : 'Connect account'}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="DBot Space sections">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => selectView(id)}
              data-testid={`dbot-view-${id}`}
              className={`focus-ring -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-3 text-xs font-bold transition-colors sm:px-4 sm:text-sm ${
                view === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
        <div className="hidden items-center gap-1.5 pb-2 text-[10px] font-medium text-muted-foreground sm:flex">
          <LockKeyhole size={12} /> Keep this browser tab open while running
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs leading-5 text-foreground"
          data-testid="dbot-notice"
        >
          <span>{notice}</span>
          <div className="flex shrink-0 items-center gap-3">
            {workspace.workspaceError && (
              <button type="button" onClick={workspace.reload} className="font-bold text-primary hover:underline" data-testid="dbot-reload-workspace">
                Reload workspace
              </button>
            )}
            <button type="button" onClick={() => setNotice('')} aria-label="Dismiss message" className="text-muted-foreground">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Mounted for the whole Space: hiding it in other views keeps a running bot alive. */}
      <WorkspacePanel
        view={view}
        frameRef={workspace.frameRef}
        frameRevision={workspace.frameRevision}
        ready={ready}
        workspaceError={workspace.workspaceError}
        shared={shared}
        link={link}
        balanceLabel={balanceLabel}
        openPositions={trading.openPositions.length}
        onFrameLoad={workspace.handleFrameLoad}
        onReload={workspace.reload}
        onNotice={setNotice}
      />

      {view === 'tools' && <DbotMarketTools />}
      {view === 'store' && <StoreView onUse={useStrategy} />}

      <DbotAiCopilot
        ready={ready}
        accountConnected={link.status === 'connected'}
        accountType={link.accountType}
        botRunning={botRunning}
        aiRuntimeRegistered={aiRuntimeRegistered}
        blockRegistry={blockRegistry}
        runNotice={aiRunNotice}
        onClearAnalysis={workspace.clearAnalysis}
        onLoadStrategy={loadAiStrategy}
        onLoadAndRun={loadAndRunAiStrategy}
      />
    </section>
  );
}
