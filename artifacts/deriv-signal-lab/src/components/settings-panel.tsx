import { KeyRound, Lock, Radio, ShieldCheck, Timer } from 'lucide-react';
import { DerivConnectionCard } from '@/components/deriv-connection-card';
import { DERIV_APP_ID, USING_TEST_APP_ID } from '@/lib/deriv-app-id';

const FLOW_STEPS = [
  {
    icon: KeyRound,
    title: '1 · Personal Access Token',
    body: 'You create a PAT in the Deriv dashboard with the trade scope and paste it here. The app never asks for your Deriv password.',
  },
  {
    icon: ShieldCheck,
    title: '2 · Accounts resolved',
    body: 'The token is sent to Deriv as Authorization: Bearer plus the Deriv-App-ID header, and the accounts it can trade are listed.',
  },
  {
    icon: Timer,
    title: '3 · Single-use OTP',
    body: 'Each account mints a one-time password (valid 120 seconds, usable once) from POST /trading/v1/options/accounts/{id}/otp.',
  },
  {
    icon: Radio,
    title: '4 · Authenticated socket',
    body: 'That OTP opens this account’s demo or real trading channel for balance, portfolio, profit table, quotes and orders.',
  },
];

export function SettingsPanel() {
  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4">
      <DerivConnectionCard />

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="eyebrow">Connection flow</div>
        <h2 className="mt-1 text-lg font-bold tracking-tight">How a Deriv connection is established</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {FLOW_STEPS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex items-start gap-3 rounded-lg border border-border bg-background/40 p-3">
              <Icon size={16} className="mt-0.5 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-bold">{title}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{body}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
          The research feed keeps its own public market-data connection
          (<span className="mono">wss://api.derivws.com/trading/v1/options/ws/public?app_id={DERIV_APP_ID}</span>). The
          trading socket is separate and account-scoped; nothing about the public feed, its URL or the application ID
          changes when you connect.
        </p>
      </section>

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="flex items-center gap-2">
          <Lock size={16} className="text-primary" />
          <h2 className="text-lg font-bold tracking-tight">Storage, scopes and risk</h2>
        </div>
        <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
          <li>
            <strong className="text-foreground">Storage:</strong> the PAT is kept only in this browser — in
            sessionStorage by default, or localStorage when “Remember on this device” is ticked. Disconnecting removes
            it from both.
          </li>
          <li>
            <strong className="text-foreground">Scope:</strong> the token needs the <span className="mono">trade</span>{' '}
            scope for balances, positions and orders. It is sent to Deriv only — never to
            this app’s own storage or logs.
          </li>
          <li>
            <strong className="text-foreground">Demo first:</strong> Deriv accounts start with a demo account. Connect
            it to rehearse the full order flow before switching the selector to a real account.
          </li>
          <li>
            <strong className="text-foreground">Risk:</strong> contracts bought on a real account settle against your
            own balance. The trade dock always shows the account type and the live cost before a purchase is sent.
          </li>
        </ul>
        {USING_TEST_APP_ID && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            No VITE_DERIV_APP_ID is configured, so the public test application ID 1089 is in use. Registered PAT
            applications normally require their own app ID on the Deriv-App-ID header.
          </p>
        )}
      </section>
    </div>
  );
}
