// DBot Space: the Signal Lab home of the official Deriv Bot workspace.
//
// The builder itself is not ours — it is upstream Deriv Bot (`vendor/deriv-bot`,
// cloned from deriv-com/bot) running in an iframe under `/dbot/`. Everything in
// this folder is the shell around it: the frame lifecycle (`frame-host.ts`), the
// message protocol (`protocol.ts`) and the layout below. The AI signal copilot is
// a separate, self-contained component.
import { useCallback, useState } from "react";
import { BrainCircuit, RefreshCw, X } from "lucide-react";
import { DbotAiCopilot, type DbotAiBlockInfo } from "@/components/dbot-ai-copilot";
import { useDerivTrading } from "@/components/deriv-trading-provider";
import type { DbotAiAnalysisSnapshot } from "@/lib/dbot-ai";
import { useDbotFrame } from "./frame-host";
import { sharedTicksLabel } from "./protocol";
import "./workspace.css";

/** Where the Deriv Bot bundle lives, relative to the app base. */
const WORKSPACE_URL = `${import.meta.env.BASE_URL}dbot/index.html`;

type DbotSpaceProps = {
  /** The shared app shell owns Settings; the Space only links to it. */
  onOpenSettings?: () => void;
  /** Bumped by the shell to ask the copilot for a fresh market analysis. */
  analysisRequest?: number;
};

export function DbotSpace({ onOpenSettings, analysisRequest = 0 }: DbotSpaceProps = {}) {
  const trading = useDerivTrading();
  const frame = useDbotFrame();
  const [runNotice, setRunNotice] = useState("");

  const account = trading.activeAccount;
  const accountConnected = trading.status === "connected" && Boolean(account);
  const accountType = account
    ? account.accountType === "real"
      ? "real"
      : account.accountType === "demo"
        ? "demo"
        : "unknown"
    : "unknown";

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

  const status = frame.error
    ? "Workspace offline"
    : !frame.ready
      ? "Starting the workspace…"
      : frame.botRunning
        ? "Bot running"
        : "Workspace ready";

  return (
    <section className="ws-shell" data-testid="dbot-space">
      <header className="ws-head">
        <div className="ws-head-title">
          <span className="ws-head-mark" aria-hidden>
            <BrainCircuit size={15} />
          </span>
          <div>
            <h2>DBot Space</h2>
            <p>Deriv Bot workspace · {status} · {sharedTicksLabel(frame.shared)}</p>
          </div>
        </div>
        {!accountConnected && onOpenSettings && (
          <button type="button" className="ws-head-reload" onClick={onOpenSettings}>
            Connect an account
          </button>
        )}
        <button
          type="button"
          className="ws-head-reload"
          onClick={frame.reload}
          data-testid="dbot-reload-workspace"
        >
          <RefreshCw size={14} /> Reload workspace
        </button>
      </header>

      {frame.notice && (
        <div className="ws-notice" role="status" data-testid="dbot-notice">
          <span className="ws-notice-mark"><BrainCircuit size={14} /></span>
          <span className="ws-notice-text">{frame.notice}</span>
          <button
            type="button"
            className="ws-notice-close"
            aria-label="Dismiss message"
            onClick={() => frame.setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}

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
      </div>

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
    </section>
  );
}
