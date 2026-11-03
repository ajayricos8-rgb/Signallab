# DBot Space — rebuilt shell

This folder is the **host-side shell** around the embedded Deriv Bot workspace.
It was torn down and rebuilt from scratch (2026-11-03). The frame
(`vendor/deriv-bot`), the Signal Lab data bridge (`lib/dbot-bridge.ts`),
`lib/bot-store/bots/*.xml`, the AI copilot, the market tools, the Deriv App ID,
the PAT connection and the trading flows are **unchanged**.

| File | Role |
| --- | --- |
| `index.tsx` | Page composition: host view, section tabs, notice, session dialog, store/tools/PRO views, the four AI-copilot hand-offs. Exports `DbotSpace` consumed by `App.tsx`. |
| `header.tsx` | Control-deck hero, live status readout and the account dock (demo/real switch, balance, link status, link/unlink, AI Analysis). |
| `engine.ts` | `useWorkspaceEngine`: iframe lifecycle and boot timeout, the automatic account-link state machine (grant + revision, 3 automatic attempts, 25 s confirm, 18 s backoff cap), OTP re-mint, the 1 s tick/account bridge and every `postMessage` conversation. |
| `protocol.ts` | Typed, frozen wire protocol: `parseFrameMessage` sanitises what the frame reports, `host*` builders shape what we send, and `tagHostPayload` stamps `source: 'signal-lab'` **last** (bridge frames carry no source and the frame drops untagged messages). |
| `workspace-panel.tsx` | Frame chrome, shared-data counter, full screen, reload and the always-mounted iframe (hiding it in host-only views keeps a running bot alive). |
| `store.tsx` | Bot store UI: search, category filter, cards, details dialog. |
| `bot-store.ts` | The strategy catalog — content preserved byte-for-byte; preset XML imports unchanged. |
| `session-limit-dialog.tsx` | Take-profit / stop-loss brake dialog, portalled to `document.body`. |
| `workspace.css` | `ws-*` design system for the control-deck look; theme-reactive surfaces, no global restyles. |

## Invariants that must not drift

- **No second login and no token in the frame.** The account is linked from the
  connected Signal Lab session via `createBotSocket()` and a single-use `wss`
  URL. The PAT never crosses the iframe boundary.
- **One writer for outbound messages.** Everything goes through
  `post()` → `tagHostPayload()`; untagged bridge frames would silently feed the
  frame zero ticks and no account.
- **The iframe is never unmounted.** `store`, `tools` and `pro-tool` hide it so a
  running strategy survives view changes.
- **A grant belongs to exactly one account.** Switching/disconnecting revokes it;
  three consecutive automatic failures pause retries until the account changes
  or **Link now** is clicked.
- **Host test IDs and startup strings stay stable** — the DBot startup, PRO-tab,
  bot-store and browser smoke tests assert on them.
