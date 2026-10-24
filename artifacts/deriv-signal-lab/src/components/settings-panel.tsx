import { BrainCircuit, Cpu, KeyRound, Lock, Radio, ShieldCheck, Sparkles, Timer } from 'lucide-react';
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

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="settings-neural-model">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BrainCircuit size={16} className="text-primary" />
            <h2 className="text-lg font-bold tracking-tight">Embedded AI model</h2>
          </div>
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-emerald-500">
            Installed · free
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Two instances of <span className="mono">signal-net</span> ship with the app and are trained from scratch on the
          market’s own feed every time Run Analysis runs: a <strong className="text-foreground">digit net</strong> (next digit,
          10 classes) that feeds Over/Under, Even/Odd and Matches, and a <strong className="text-foreground">quote net</strong>{' '}
          (direction of the horizon’s move) that feeds Rise/Fall. There is no API key, account, download or per-call charge:
          the weights are fitted and executed in the browser, inside the analysis Web Workers, and never leave the device.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <div className="eyebrow flex items-center gap-1.5"><Cpu size={11} /> Digit net · signal-net-digit-v1</div>
            <div className="mono mt-1 text-xs font-semibold">113 → 24 → 12 → 10 · ≈3.2k params</div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              ReLU hidden layers, softmax head, Adam with L2, early stopping, temperature calibration. Inputs: recent digits,
              hot/cold z-scores over 100 and 300 ticks, digit gaps, parity share, streaks and entropy.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <div className="eyebrow flex items-center gap-1.5"><Cpu size={11} /> Quote net · signal-net-quote-v1</div>
            <div className="mono mt-1 text-xs font-semibold">20 → 24 → 12 → 2 · ≈0.8k params</div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              The same architecture for direction. Inputs: recent returns, momentum, volatility expansion, price position,
              RSI, streaks and Bollinger position, trained against the same exit ticks each horizon settles on.
            </p>
          </div>
        </div>
        <ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <li>
            <strong className="text-foreground">It is measured, not trusted:</strong> every fit is split chronologically with a
            purge gap, scored once on a holdout slice it never saw, and compared with the same fair odds the contract pays on.
          </li>
          <li>
            <strong className="text-foreground">It only votes when it earns it:</strong> its forecast is blended into the
            published probability (up to 25% of the edge) only after a positive Brier skill with a paired z ≥ 2 on at least 60
            unseen ticks. Otherwise it is shown on the tool page with zero weight and cannot move a signal.
          </li>
          <li>
            <strong className="text-foreground">Where to see it:</strong> the <em>Layer 7 · free embedded neural model</em> card
            on every tool, the <em>Neural</em> row in the master decision’s source table, and the model card with its
            parameters, seed, epochs, temperature and holdout score.
          </li>
          <li>
            <strong className="text-foreground">Licence:</strong> the model code and the weights it generates at runtime are
            MIT-licensed like the rest of the app — nothing pretrained is downloaded, so there is no third-party licence or
            telemetry to accept.
          </li>
        </ul>
        <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
          <Sparkles size={11} className="mr-1 inline" />
          A neural network does not remove risk. On a fair synthetic index it usually scores at chance and correctly stays
          silent; a high confidence score is evidence, never a guarantee.
        </p>
      </section>

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
