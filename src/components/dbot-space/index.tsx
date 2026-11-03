// DBot Space — rebuilt from scratch as a control-deck shell.
//
// Composition only: `useWorkspaceEngine` owns the iframe, the automatic account
// link and the data bridge; `WorkspaceHeader` draws the hero and account dock;
// `WorkspacePanel` draws the frame chrome; `StoreView` draws the bot store;
// `SessionLimitDialog` reports a session brake. This file owns the host view,
// the section tabs, the notice and the four hand-offs to the AI copilot.
import { useCallback, useState, type ComponentType } from 'react';
import {
  Activity, Boxes, BrainCircuit, ChartNoAxesCombined, Library, Wrench, X, type LucideProps,
} from 'lucide-react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { formatAmount } from '@/lib/deriv-trading';
import { DbotAiCopilot } from '@/components/dbot-ai-copilot';
import { DbotMarketTools } from '@/components/dbot-market-tools';
import type { DbotAiAnalysisSnapshot } from '@/lib/dbot-ai';
import type { Strategy } from './bot-store';
import { linkSummary, type SpaceView } from './protocol';
import { useWorkspaceEngine } from './engine';
import { StoreView } from './store';
import { WorkspacePanel } from './workspace-panel';
import { WorkspaceHeader } from './header';
import { SessionLimitDialog } from './session-limit-dialog';
import './workspace.css';

const VIEWS: Array<{ id: SpaceView; label: string; icon: ComponentType<LucideProps> }> = [
  { id: 'builder', label: 'Bot builder', icon: Boxes },
  { id: 'chart', label: 'Charts', icon: ChartNoAxesCombined },
  { id: 'store', label: 'Bot store', icon: Library },
  { id: 'tools', label: 'Digits & risk', icon: Activity },
  { id: 'pro-tool', label: 'PRO -tool', icon: Wrench },
];

export function DbotSpace({ onOpenSettings, analysisRequest = 0 }: { onOpenSettings: () => void; analysisRequest?: number }) {
  const trading = useDerivTrading();
  const [view, setView] = useState<SpaceView>('builder');
  const [localAnalysisRequest, setLocalAnalysisRequest] = useState(0);

  const workspace = useWorkspaceEngine({
    view,
    onOpenSettings,
    onFrameTab: setView,
  });
  const {
    ready, link, autoLink, autoPaused, notice, botRunning, shared, blockRegistry, aiRuntimeRegistered, sessionLimit, setSessionLimit,
    aiRunNotice, setNotice, setAiRunNotice, showTab, loadBot, loadAndRunBot, loadAnalysisBot, openQuickStrategy,
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

  const loadAiAnalysis = useCallback((xml: string, name: string, analysis: DbotAiAnalysisSnapshot) => {
    if (!ready || botRunning) {
      setAiRunNotice(botRunning ? 'Stop the current DBot strategy before loading another one.' : 'The DBot workspace is still loading.');
      return;
    }
    setView('builder');
    setAiRunNotice(`${name} is loading into the block workspace. The analysis expires; run a fresh scan if the gate closes.`);
    loadAnalysisBot(xml, name, analysis);
  }, [ready, botRunning, loadAnalysisBot, setAiRunNotice]);

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
    <section className="ws-shell" data-testid="dbot-space">
      {sessionLimit && <SessionLimitDialog limit={sessionLimit} onDismiss={() => setSessionLimit(null)} />}

      <WorkspaceHeader
        trading={trading}
        link={link}
        linkLabel={linkLabel}
        balanceLabel={balanceLabel}
        botRunning={botRunning}
        autoLink={autoLink}
        hasAccount={hasAccount}
        ready={ready}
        shared={shared}
        onOpenAnalysis={() => setLocalAnalysisRequest((value) => value + 1)}
        onNotice={setNotice}
        onConnect={() => void workspace.connectAccount()}
        onDisconnect={workspace.disconnectAccount}
      />

      <nav className="ws-nav" role="tablist" aria-label="DBot Space sections">
        <div className="ws-tabs">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => selectView(id)}
              data-testid={`dbot-view-${id}`}
              className={`ws-tab ${view === id ? 'is-active' : ''}`}
            >
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
      </nav>

      {notice && (
        <div role="status" className="ws-notice" data-testid="dbot-notice">
          <span className="ws-notice-mark"><BrainCircuit size={14} /></span>
          <span className="ws-notice-text">{notice}</span>
          <div className="ws-notice-actions">
            {workspace.workspaceError && (
              <button type="button" onClick={workspace.reload} className="ws-notice-reload" data-testid="dbot-reload-workspace">
                Reload workspace
              </button>
            )}
            <button type="button" onClick={() => setNotice('')} aria-label="Dismiss message" className="ws-notice-close">
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
        frameLoaded={workspace.frameLoaded}
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
      {view === 'pro-tool' && <div data-testid="dbot-pro-tool" />}

      <DbotAiCopilot
        analysisRequest={analysisRequest + localAnalysisRequest}
        ready={ready}
        accountConnected={link.status === 'connected'}
        accountType={link.accountType}
        botRunning={botRunning}
        aiRuntimeRegistered={aiRuntimeRegistered}
        blockRegistry={blockRegistry}
        runNotice={aiRunNotice}
        onClearAnalysis={workspace.clearAnalysis}
        onLoadStrategy={loadAiStrategy}
        onLoadAnalysis={loadAiAnalysis}
        onLoadAndRun={loadAndRunAiStrategy}
      />
    </section>
  );
}
