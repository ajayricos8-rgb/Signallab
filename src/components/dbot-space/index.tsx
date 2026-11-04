// DBot Space: the Signal Lab home of the official Deriv Bot workspace.
//
// The builder itself is not ours — it is upstream Deriv Bot (`vendor/deriv-bot`,
// cloned from deriv-com/bot) running in an iframe under `/dbot/`. Everything in
// this folder is the shell around it: the frame lifecycle (`frame-host.ts`), the
// message protocol (`protocol.ts`) and the layout below.
//
// The shell is deliberately thin: the workspace owns the whole viewport, and the
// Signal Lab tabs (Trade history, Settings) live *inside* its tab bar, next to
// Tutorials. Selecting one docks the host panel under that tab bar; the PAT
// dialog opens over the workspace when its Log in button is pressed.
import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, KeyRound, RefreshCw, X } from "lucide-react";
import { DbotAiCopilot, type DbotAiBlockInfo } from "@/components/dbot-ai-copilot";
import { DerivConnectionCard } from "@/components/deriv-connection-card";
import { SettingsPanel } from "@/components/settings-panel";
import { TradeHistoryPanel } from "@/components/trade-history-panel";
import { useDerivTrading } from "@/components/deriv-trading-provider";
import type { DbotAiAnalysisSnapshot } from "@/lib/dbot-ai";
import { useDbotFrame } from "./frame-host";
import { sharedTicksLabel } from "./protocol";
import "./workspace.css";

/** Where the Deriv Bot bundle lives, relative to the app base. */
const WORKSPACE_URL = `${import.meta.env.BASE_URL}dbot/index.html`;
/** Fallback dock line until the workspace reports its tab bar geometry. */
const DEFAULT_TABS_BOTTOM = 108;

type DbotSpaceProps = {
  /** Kept for the shared app shell's API; the Space is now the whole shell. */
  onOpenSettings?: () => void;
  /** Bumped by the shell to ask the copilot for a fresh market analysis. */
  analysisRequest?: number;
};

export function DbotSpace({ analysisRequest = 0 }: DbotSpaceProps = {}) {
  const trading = useDerivTrading();
  const frame = useDbotFrame();
  const [runNotice, setRunNotice] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);

  const account = trading.activeAccount;
  const accountConnected = trading.status === "connected" && Boolean(account);
  const accountType = account
    ? account.accountType === "real"
      ? "real"
      : account.accountType === "demo"
        ? "demo"
        : "unknown"
    : "unknown";

  // The workspace's Log in button: the shell owns the session, so it answers
  // with the PAT dialog instead of letting the frame start an OAuth journey.
  useEffect(() => {
    if (frame.loginRequest > 0) setLoginOpen(true);
  }, [frame.loginRequest]);

  // A connected session has nothing left to do in the dialog.
  useEffect(() => {
    if (accountConnected) setLoginOpen(false);
  }, [accountConnected]);

  /** Copilot → workspace: load a strategy's blocks (never runs them). */
  const loadStrategy = useCallback(
    (xml: string, name: string) => {
      setRunNotice(`${name} is loading into the DBot workspace…`);
      frame.loadBot(xml, name);
    },
    [frame],
  );

  /** Copilot → workspace: load with the analysis gate the scan produced. */
  const loadAnalysis = useCallback(
    (xml: string, name: string, _analysis: DbotAiAnalysisSnapshot) => {
      if (frame.botRunning) {
        setRunNotice("Stop the running DBot strategy before loading another one.");
        return;
      }
      setRunNotice(`${name} is loading into the block workspace…`);
      frame.loadBot(xml, name);
    },
    [frame],
  );

  /** Copilot → workspace: load and start trading. */
  const loadAndRun = useCallback(
    (xml: string, name: string, _analysis: DbotAiAnalysisSnapshot) => {
      if (!accountConnected) {
        setRunNotice("Connect a Signal Lab account before running a strategy in DBot.");
        setLoginOpen(true);
        return;
      }
      if (frame.botRunning) {
        setRunNotice("Stop the running DBot strategy before loading another one.");
        return;
      }
      setRunNotice(`${name} is loading and starting…`);
      frame.loadAndRun(xml, name);
    },
    [frame, accountConnected],
  );

  const hostView = frame.ready ? frame.hostView : null;

  return (
    <section className="ws-shell" data-testid="dbot-space">
      <div className="ws-frame-wrap">
        {/*
          The workspace stays mounted for the whole visit: unmounting a running
          bot would kill it. `frameRevision` only changes on an explicit reload.
        */}
        <iframe
          key={frame.frameRevision}
          ref={frame.frameRef}
          src={`${WORKSPACE_URL}?v=${frame.frameRevision}`}
          title="Deriv Bot workspace"
          className="ws-frame"
          data-testid="dbot-workspace-frame"
          allow="clipboard-read; clipboard-write; fullscreen"
        />

        {/* A Signal Lab tab is selected inside the workspace tab bar. */}
        {hostView && (
          <section
            className="ws-host-panel"
            style={{ top: frame.tabsBottom || DEFAULT_TABS_BOTTOM }}
            data-testid={`dbot-host-panel-${hostView}`}
            aria-label={hostView === "history" ? "Trade history" : "Settings"}
          >
            <div className="ws-host-panel__bar">
              <span className="ws-host-panel__title">
                <BrainCircuit size={14} />
                Signal Lab · {hostView === "history" ? "Trade history" : "Settings"}
              </span>
              <span className="ws-host-panel__meta">{sharedTicksLabel(frame.shared)}</span>
              <button
                type="button"
                className="ws-host-panel__back"
                onClick={() => frame.showTab("builder")}
                data-testid="dbot-host-panel-back"
              >
                <X size={13} /> Back to workspace
              </button>
            </div>
            <div className="ws-host-panel__body">
              {hostView === "history" ? <TradeHistoryPanel /> : <SettingsPanel />}
            </div>
          </section>
        )}

        {!frame.ready && (
          <div className="ws-frame-overlay" data-testid="dbot-workspace-overlay">
            {frame.error ? (
              <div className="ws-frame-card">
                <h3>The DBot workspace could not start</h3>
                <p>{frame.error}</p>
                <button type="button" className="ws-frame-button" onClick={frame.reload}>
                  <RefreshCw size={14} /> Reload workspace
                </button>
              </div>
            ) : (
              <div className="ws-frame-card">
                <span className="ws-frame-spinner" aria-hidden />
                <h3>Connecting the workspace</h3>
                <p>Loading the Deriv Bot builder…</p>
              </div>
            )}
          </div>
        )}

        {frame.notice && (
          <div className="ws-toast" role="status" data-testid="dbot-notice">
            <span className="ws-toast__mark"><BrainCircuit size={13} /></span>
            <span className="ws-toast__text">{frame.notice}</span>
            <button
              type="button"
              className="ws-toast__close"
              aria-label="Dismiss message"
              onClick={() => frame.setNotice("")}
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* The shell's PAT dialog, opened from the workspace's own Log in button. */}
        {loginOpen && !accountConnected && (
          <div
            className="ws-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Connect your Deriv account"
            data-testid="dbot-login-dialog"
          >
            <button
              type="button"
              className="ws-modal__backdrop"
              aria-label="Close connection dialog"
              onClick={() => setLoginOpen(false)}
            />
            <div className="ws-modal__card">
              <div className="ws-modal__head">
                <span className="ws-modal__icon"><KeyRound size={15} /></span>
                <div>
                  <h3>Connect your Deriv account</h3>
                  <p>Paste a Personal Access Token with the trade scope.</p>
                </div>
                <button
                  type="button"
                  className="ws-modal__close"
                  aria-label="Close connection dialog"
                  onClick={() => setLoginOpen(false)}
                  data-testid="dbot-login-close"
                >
                  <X size={15} />
                </button>
              </div>
              <DerivConnectionCard />
              <p className="ws-modal__note">
                Signal Lab signs in once. The workspace adopts the same account — you are not asked to log in
                again inside DBot.
              </p>
            </div>
          </div>
        )}

        <DbotAiCopilot
          analysisRequest={analysisRequest}
          ready={frame.ready}
          accountConnected={accountConnected}
          accountType={accountType}
          botRunning={frame.botRunning}
          aiRuntimeRegistered={frame.aiRuntimeRegistered}
          blockRegistry={frame.blockRegistry as DbotAiBlockInfo[]}
          runNotice={runNotice}
          onClearAnalysis={() => setRunNotice("")}
          onLoadStrategy={loadStrategy}
          onLoadAnalysis={loadAnalysis}
          onLoadAndRun={loadAndRun}
        />
      </div>
    </section>
  );
}
