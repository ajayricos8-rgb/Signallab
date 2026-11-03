// Control-deck header of the rebuilt DBot Space shell: the hero, the live
// status readout and the account dock. It only reads the Signal Lab trading
// session (never the PAT) and hands account-switch/link actions back to the
// engine; no protocol messages are sent from here.
import { BrainCircuit, Link2, LoaderCircle, LockKeyhole, Unlink, Wallet } from 'lucide-react';
import type { DerivTradingSession } from '@/hooks/use-deriv-trading-session';
import type { LinkSnapshot, SharedData } from './protocol';

export type WorkspaceHeaderProps = {
  trading: DerivTradingSession;
  link: LinkSnapshot;
  linkLabel: string;
  balanceLabel: string;
  botRunning: boolean;
  autoLink: boolean;
  hasAccount: boolean;
  ready: boolean;
  shared: SharedData;
  onOpenAnalysis: () => void;
  onNotice: (message: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

export function WorkspaceHeader({
  trading, link, linkLabel, balanceLabel, botRunning, autoLink, hasAccount, ready, shared,
  onOpenAnalysis, onNotice, onConnect, onDisconnect,
}: WorkspaceHeaderProps) {
  const engineLabel = ready ? 'Workspace ready' : 'Connecting workspace';

  return (
    <div className="ws-header">
      <section className="ws-hero">
        <div className="ws-hero-grid" aria-hidden="true" />
        <div className="ws-hero-copy">
          <span className="ws-eyebrow"><i /> AUTOMATION WORKSPACE</span>
          <h2>DBot Space</h2>
          <p>
            Build a strategy with visual blocks, explore live charts, or start with a bot from the store.
            DBot uses the Signal Lab account automatically and shares the ticks, balance and positions
            collected there.
          </p>
        </div>
        <div className="ws-readout" aria-label="Workspace status">
          <div className="ws-readout-row">
            <span className="ws-readout-key">ENGINE</span>
            <span className="ws-readout-value"><i className={ready ? 'is-live' : 'is-waiting'} />{engineLabel}</span>
          </div>
          <div className="ws-readout-row">
            <span className="ws-readout-key">ACCOUNT</span>
            <span className="ws-readout-value">{link.status === 'connected' ? link.accountId : 'Not linked'}</span>
          </div>
          <div className="ws-readout-row">
            <span className="ws-readout-key">DATA FEED</span>
            <span className="ws-readout-value">
              {shared.ticks ? `${shared.markets} markets · ${shared.ticks.toLocaleString()} ticks` : 'Waiting for ticks'}
            </span>
          </div>
        </div>
      </section>

      <div className="ws-dock">
        <div className="ws-dock-group">
          {/* The demo/real switch drives the same Signal Lab account selection the
              connection card uses, so DBot re-links to whichever account is active. */}
          <div className="ws-account" data-testid="dbot-balance-toggle">
            <div className="ws-segment" role="group" aria-label="Account type">
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
                    className={`ws-segment-button ${active ? `is-active is-${kind}` : ''}`}
                    onClick={() => {
                      if (active) return;
                      if (botRunning) {
                        onNotice('Stop the running bot before switching between demo and real accounts.');
                        return;
                      }
                      if (!account) {
                        onNotice(`No ${kind} account is connected. Connect a Deriv account with a ${kind} account in Settings, then use this toggle.`);
                        return;
                      }
                      void trading.selectAccount(account.accountId);
                      onNotice(kind === 'real'
                        ? `Switched to your REAL account ${account.accountId}. Bots will trade real money — double-check stake and limits before running.`
                        : `Switched to your demo account ${account.accountId}. Bots trade virtual funds here.`);
                    }}
                  >
                    {kind}
                  </button>
                );
              })}
            </div>
            <span className="ws-balance" data-testid="dbot-balance" title="Balance of the active account">
              <Wallet size={13} />{balanceLabel}
            </span>
          </div>

          <span className="ws-pill" data-testid="dbot-account-status">
            <i className={`ws-dot ${link.status === 'connected' ? 'is-live' : link.status === 'connecting' ? 'is-pending' : 'is-waiting'}`} />
            {linkLabel}
          </span>
        </div>

        <div className="ws-dock-group">
          {link.status === 'connected' ? (
            <button type="button" onClick={onDisconnect} className="ws-button" data-testid="dbot-disconnect-account">
              <Unlink size={14} /> Unlink
            </button>
          ) : (
            <button
              type="button"
              onClick={onConnect}
              disabled={link.status === 'connecting'}
              className="ws-button"
              data-testid="dbot-connect-account"
            >
              {link.status === 'connecting' ? <LoaderCircle className="animate-spin" size={14} /> : <Link2 size={14} />}
              {link.status === 'connecting'
                ? 'Linking…'
                : hasAccount ? (autoLink ? 'Link now' : 'Link account') : 'Connect account'}
            </button>
          )}
          <button type="button" onClick={onOpenAnalysis} className="ws-button ws-button-accent" data-testid="dbot-open-analysis">
            <BrainCircuit size={14} /> Open AI Analysis
          </button>
          <span className="ws-dock-hint"><LockKeyhole size={12} /> Keep this browser tab open while running</span>
        </div>
      </div>
    </div>
  );
}
