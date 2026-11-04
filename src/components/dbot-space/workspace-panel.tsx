// Frame chrome of the rebuilt workspace: a compact toolbar, the always-mounted
// iframe and the access rail underneath it.
//
// The iframe is mounted for the whole life of the Space (the store, tools and
// PRO views simply hide it), because unmounting it would stop a running bot.
import type { RefObject } from 'react';
import { Boxes, CircleHelp, LoaderCircle, Maximize2, RefreshCw, Signal } from 'lucide-react';
import { sharedTicksLabel, type LinkSnapshot, type SharedData, type SpaceView } from './protocol';

type WorkspacePanelProps = {
  view: SpaceView;
  frameRef: RefObject<HTMLIFrameElement | null>;
  frameRevision: number;
  frameLoaded: boolean;
  ready: boolean;
  workspaceError: string;
  shared: SharedData;
  link: LinkSnapshot;
  /** Pre-formatted active-account balance, or an em dash. */
  balanceLabel: string;
  openPositions: number;
  onFrameLoad: () => void;
  onReload: () => void;
  onNotice: (message: string) => void;
};

export function WorkspacePanel({
  view,
  frameRef,
  frameRevision,
  frameLoaded,
  ready,
  workspaceError,
  shared,
  link,
  balanceLabel,
  openPositions,
  onFrameLoad,
  onReload,
  onNotice,
}: WorkspacePanelProps) {
  const hidden = view === 'store' || view === 'tools' || view === 'pro-tool';
  const status = ready ? 'Workspace ready' : workspaceError ? 'Workspace needs reload' : 'Connecting workspace';
  const dot = ready ? 'bg-emerald-400' : workspaceError ? 'bg-rose-400' : 'bg-amber-400';

  function goFullscreen() {
    const frame = frameRef.current;
    if (!frame?.requestFullscreen) {
      onNotice('Full screen is not available in this browser.');
      return;
    }
    void frame.requestFullscreen().catch(() => onNotice('Full screen could not be opened in this browser.'));
  }

  return (
    <div className={hidden ? 'hidden' : 'ws-panel-wrap'}>
      <div className="ws-frame-card">
        <div className="ws-frame-bar">
          <div className="ws-frame-title">
            <span className="ws-frame-icon"><Boxes size={14} /></span>
            <strong>Deriv Bot workspace</strong>
            <span className="ws-frame-crumb">/ {view === 'chart' ? 'Charts' : 'Builder'}</span>
          </div>
          <div className="ws-frame-actions">
            <span className="ws-frame-metric" data-testid="dbot-shared-data" title="Ticks Signal Lab has collected and shares with the workspace">
              <Signal size={12} className={shared.ticks ? 'text-primary' : ''} />
              {sharedTicksLabel(shared)}
            </span>
            <span className="ws-frame-status" data-testid="dbot-workspace-status">
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
              {status}
            </span>
            {workspaceError && (
              <button
                type="button"
                onClick={onReload}
                className="ws-frame-link"
                data-testid="dbot-reload-workspace-header"
              >
                <RefreshCw size={11} /> Reload
              </button>
            )}
            <button
              type="button"
              onClick={goFullscreen}
              className="ws-frame-link"
              title="Expand this workspace without reloading it"
              data-testid="dbot-fullscreen"
            >
              <Maximize2 size={12} /> <span className="hidden sm:inline">Full screen</span>
            </button>
          </div>
        </div>

        <div className="ws-frame-stage">
          {/*
            `?v=` is the reload counter, not a cache key we read: every reload
            gets a URL the browser and any leftover service worker have never
            answered before, so a stale cached workspace document can never
            shadow the current bundle. A plain repeat of the same URL was what
            made an unlucky browser loop on the old copy forever.
          */}
          <iframe
            key={frameRevision}
            ref={frameRef}
            src={`${import.meta.env.BASE_URL}dbot/index.html?v=${frameRevision}#bot_builder`}
            title="Deriv Bot workspace"
            allow="fullscreen"
            allowFullScreen
            className="ws-frame"
            style={{ height: 'min(850px, calc(100dvh - 160px))', minHeight: 480 }}
            data-testid="dbot-frame"
            onLoad={onFrameLoad}
          />
          {!ready && (
            <div
              className={`ws-frame-overlay ${workspaceError ? '' : 'pointer-events-none'}`}
              role={workspaceError ? 'alert' : 'status'}
              aria-live="polite"
              data-testid="dbot-initializing"
            >
              {workspaceError ? (
                <>
                  <p className="ws-overlay-title">{workspaceError}</p>
                  <button type="button" onClick={onReload} className="ws-overlay-button">
                    Reload workspace
                  </button>
                </>
              ) : (
                <>
                  <LoaderCircle size={26} className="animate-spin text-indigo-500" />
                  <p className="ws-overlay-title">{frameLoaded ? 'Initializing DBot workspace…' : 'Starting DBot workspace…'}</p>
                  <p className="ws-overlay-note">Loading the bot builder and connecting it to Signal Lab.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="ws-rail">
        <p className="ws-rail-help">
          <CircleHelp className="mt-0.5 shrink-0" size={13} />
          Drag blocks from the menu, connect them to your strategy, and use the builder&rsquo;s import and save
          controls for XML files. The <strong>Signal Lab</strong> block group reads the ticks, balance and
          positions this app already collected. A running bot needs this browser tab to remain open.
        </p>
        <div className="ws-access" data-testid="dbot-access-summary">
          <span className={`h-1.5 w-1.5 rounded-full ${link.status === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          {link.status === 'connected' ? (
            <>
              <span className="font-semibold text-foreground">{link.accountId}</span>
              <span aria-hidden>·</span>
              <span>{balanceLabel} balance</span>
              <span aria-hidden>·</span>
              <span>{openPositions} open {openPositions === 1 ? 'position' : 'positions'}</span>
              <span aria-hidden>·</span>
              <span>{shared.markets} markets shared</span>
              <span aria-hidden>·</span>
              <span>trading enabled</span>
            </>
          ) : (
            <span>Account, ticks and trading link automatically once Signal Lab is connected</span>
          )}
        </div>
      </div>
    </div>
  );
}
