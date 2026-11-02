// The frame chrome around the embedded workspace: status, shared-data counter,
// full screen and the reload that boots a fresh canvas.
//
// The iframe is mounted for the whole life of the Space (the store and the
// Market tools simply hide it), because unmounting it would stop a running bot.
import type { RefObject } from 'react';
import { Boxes, CircleHelp, Maximize2, Signal } from 'lucide-react';
import { sharedTicksLabel, type LinkSnapshot, type SharedData, type SpaceView } from './protocol';

type WorkspacePanelProps = {
  view: SpaceView;
  frameRef: RefObject<HTMLIFrameElement | null>;
  frameRevision: number;
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
  const hidden = view === 'store' || view === 'tools';
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
    <div className={hidden ? 'hidden' : 'mt-4'}>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 sm:px-4">
          <div className="flex items-center gap-2 text-[11px] font-bold">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary"><Boxes size={13} /></span>
            Deriv Bot workspace
            <span className="hidden font-normal text-muted-foreground sm:inline">/ {view === 'chart' ? 'Charts' : 'Builder'}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"
              data-testid="dbot-shared-data"
              title="Ticks Signal Lab has collected and shares with the workspace"
            >
              <Signal size={12} className={shared.ticks ? 'text-primary' : ''} />
              {sharedTicksLabel(shared)}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground" data-testid="dbot-workspace-status">
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
              {status}
            </span>
            {workspaceError && (
              <button
                type="button"
                onClick={onReload}
                className="text-[10px] font-bold text-primary hover:underline"
                data-testid="dbot-reload-workspace-header"
              >
                Reload
              </button>
            )}
            <button
              type="button"
              onClick={goFullscreen}
              className="inline-flex items-center gap-1 text-[10px] font-bold text-primary hover:underline"
              title="Expand this workspace without reloading it"
              data-testid="dbot-fullscreen"
            >
              <Maximize2 size={12} /> <span className="hidden sm:inline">Full screen</span>
            </button>
          </div>
        </div>
        <iframe
          key={frameRevision}
          ref={frameRef}
          src={`${import.meta.env.BASE_URL}dbot/index.html#bot_builder`}
          title="Deriv Bot workspace"
          allow="fullscreen"
          allowFullScreen
          className="block w-full bg-white"
          style={{ height: 'min(850px, calc(100dvh - 160px))', minHeight: 480 }}
          data-testid="dbot-frame"
          onLoad={onFrameLoad}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <p className="flex max-w-3xl items-start gap-2 text-[11px] leading-5 text-muted-foreground">
          <CircleHelp className="mt-0.5 shrink-0" size={13} />
          Drag blocks from the menu, connect them to your strategy, and use the builder&rsquo;s import and save
          controls for XML files. The <strong className="font-semibold text-foreground">Signal Lab</strong> block
          group reads the ticks, balance and positions this app already collected. A running bot needs this
          browser tab to remain open.
        </p>
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-[10px] text-muted-foreground"
          data-testid="dbot-access-summary"
        >
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
