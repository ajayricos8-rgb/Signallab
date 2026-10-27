---
name: DBot Space (embedded workspace)
description: How the embedded DBot workspace connects to the Signal Lab account automatically and what it may read from Signal Lab.
---

`components/dbot-space.tsx` embeds `vendor/deriv-bot` in a **same-origin** iframe. The account is
never entered twice: when the workspace reports ready and `useDerivTrading()` is connected, an effect
calls `createBotSocket()` and posts `connect-account` with a single-use `wss` URL (never the PAT). The
same account is re-linked automatically after a lost socket, an iframe reload or an account switch;
three consecutive automatic failures stop the retries until the account changes or **Link now** is
pressed. **Unlink** is the only manual action and sets `autoLink=false`, which pauses the effect.
Linking cannot trade on its own — the workspace still needs **Run**.

The data bridge is separate from the account bridge:

- **Ticks.** `lib/dbot-bridge.ts` (`buildBridgeSnapshot` / `buildBridgeUpdate`) turns the shared
  `MarketFeedProvider` snapshot into `[epoch, quote]` tuples, keeping a per-market cursor so the 1 s
  timer only posts ticks the frame has not seen. `reset:true` replaces the frame cache; `false`
  appends. Skips empty markets and posts nothing when no market has a new tick.
- **Account.** `buildAccountMessage` sends balance, currency, open (capped at 20) and settled profit
  when it changes; an empty `accountId` clears the frame. `{type:'signal-lab-bridge', live:false}`
  clears everything.
- **Frame side.** `vendor/deriv-bot/src/services/signallab-feed.ts` accepts only same-origin messages
  from `window.parent`, keeps 1,000 ticks per market, and exposes sync getters plus
  `waitForSignalLabTicks` / `waitForSignalLabAccount`, which reject with a message a bot log can show
  rather than trading on invented data. `connectSignalLabBridge()` runs from `main.tsx`.

Blocks live in `scratch/blocks/Signal Lab/` (registered by `blocks/index.js`, listed in the `signal_lab`
toolbox category in `pages/bot-builder/toolbox/toolbox-items.tsx`). Generators emit `Bot.getSignalLab*`,
implemented by `Interface/SignalLabInterface.js` and wired in `interpreter.js` exactly like the ticks
interface — every function must be async, because `createAsync` expects a promise. The bridge is
read-only; orders go through DBot's own authenticated socket for the same account.

**Why:** the user asked DBot to use the Signal Lab account and data automatically instead of a second
"link account" flow. Keeping the wire format pure and tested in `lib/dbot-bridge.ts` is what stops the
two sides drifting.

**How to apply:** add a bridge field in `dbot-bridge.ts` + `signallab-feed.ts` and cover both with
`tests/dbot-bridge.test.mjs` / `tests/dbot-bridge-frame.test.mjs`; never post an account message before
`grantRef.current` matches the session account, and never let the frame read a token.
