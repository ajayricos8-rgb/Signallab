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

## Price presets: why they opened nothing on Step indices, and what was measured

Diagnosis, in the order the gates bite:

1. **The model horizon was read from a different block than the contract.** `resolvePriceContext`
   used to demand `duration === horizon` (4), while the presets wrote the duration in Trade options.
   Any edit to Trade options parked the bot before purchase with no purchase and no error. The
   contract now wins: `resolvePriceContext` returns the traded duration as the horizon, and the
   models replay the shape that actually settles.
2. **An even horizon on a fixed ±0.1 step market ties.** A four-tick window on `stpRNG` ties 36.4 %
   of the time, which caps the achievable probability near 32 % — below every gate. Five ticks is
   odd, so a walk that starts and ends on a step grid can never tie (0 %). Every preset trades five
   ticks, and `MAX_TIE` (0.2) refuses a market that ties more.
3. **A good decision still has to survive the money gate.** `priceRiskAllowed` needs
   `stake × legs ≤ bank·percent/100`, `≤ maxLoss + sessionProfit` and a finite balance. With the
   shipped tenth-Kelly `adaptiveStake` (fraction 0.1) a 10 000 demo balance sizes ~42 USD at p = 0.534,
   which the 10 USD loss limit then rejects on *every* cycle: zero trades, no error. A strategy stake
   must never be sized above the operator's own loss budget — cap it with `max stake`, and gate the
   budget before the entry, not after.

Simulated with the real modules (module-level, no browser needed): on a 55/45 leaning step stream the
preset wiring (flat 0.35 stake, ladder cap 2.8, loss 10, target 10, percent 5, confidence ≥ 60,
agreement ≥ 0.60) reaches a purchase after ~55 ticks and keeps trading; on a fair 50/50 stream it
reads ready ~12× less often. `tests/price-strategies.test.mjs` pins both directions, so a future
"fix for no trades" cannot quietly start trading noise instead.

**How to apply:** when a preset appears dead, print `x_price_reason` on skips first (it names the gate:
warming up, thin state, tie risk, below threshold, thin evidence, model disagreement), then check the
risk gate inputs — a stake above the loss budget and an unreadable balance both fail closed, by design.

Staking in the price presets is no longer a ladder. Every cycle `x_price_stake` recomputes the stake from
the decision's own probability and the configured payout (tenth-Kelly), floored at Deriv's 0.35 minimum,
capped by "max stake" and the balance percent, and de-risked by the session drawdown. A loss never raises
the next stake, so there is no martingale state to leak between cycles. `priceRiskAllowed` also floors the
balance budget at the exchange minimum per leg: a 5 % policy on a 5 USD balance is 0.25, which would
otherwise reject every entry forever and read as a dead bot.

## High/Low Tick v5: the four things that had to be right before any of it mattered

1. **Ties are missing mass, not a rounding error.** Five ticks on a ±1 grid walk ties 10/32 =
   31.25 % of windows, and a shared extreme loses on both sides. Each side is therefore normalised
   over its own five positions and multiplied by `1 − tieForecast`; the prior is the arcsine law
   blended with the enumerated grid walk ([6,4,2,4,6]/22) at the market's *measured* tie rate, so a
   Step index is never priced with a Volatility 100 prior. v4's per-side 100 % normalisation
   overstated a Step-index win probability by 1/(1−0.3125) ≈ 45 %.
2. **The volatility-expansion feature was wrong by a constant.** It divided a ten-tick absolute-move
   sum by four while dividing the forty-tick sum by forty, so a market with perfectly constant
   volatility reported `expansion = 2.5` (and it is printed in the DNA line as 2.50). That fed the
   regime expert and **divided the tie forecast**, i.e. it made ties look 1.5× rarer than they are —
   about five probability points of optimism on the exact contract being traded. If
   `marketDna().expansion` is not ≈1.00 on a stable market, the feature is broken again.
3. **An EV is a max over ten noisy estimates.** With a fair ladder the argmax EV looks like +5 to
   +20 % purely from noise; the bot would trade a fair market believing it had an edge. The gate
   compares `evLower = EV − evZ·(1+m)·√(p(1−p)/n)` with `ai min ev` (evZ defaults to 1 on ticks, 0
   restores the naive gate). Effect on a fair ±1 walk, pooled over three seeds: 615 entries with
   the naive gate → 64 with the deflated one at 0.95× fair quotes, and 695 at 1.2× fair.
4. **Grade the contract, not the direction.** `gradePriceForecasts` used to score every decision by
   `change > 0`, which is Rise/Fall semantics. A High/Low Tick decision is a (side, tick) bet that
   loses on a shared extreme, so the ledger now stores `mode`, `tick` and the predicted win
   probability, grades the strict extreme (a tie is a loss, not a skipped sample), and reports
   `mean` so the calibration ratio is `realised / predicted` — reliability — rather than
   `realised / break-even`, which flatters an over-confident model that is still above the bar.

## Five ticks is not a duration

`labelFidelity(interval, latency)` in `price-strategies.mjs` turns the tick rate into the real
contract length (10 s on R_100, 5 s on a 1HZ index), an expected slip in ticks (latency ÷ interval),
a label-fidelity ceiling (1 − lag/2), and a `stakeable` fraction (one buy covers 1/5 of the cycle,
so a High/Low Tick bot always has five positions overlapping). Past 0.75 ticks of slip the engine
returns `execution — … the five-tick window would start late` and trades nothing: a misaligned
window is a different contract, not a worse one. `VisionInterface` measures the interval from
`measuredTickRate` (falling back to the symbol class) and the latency from the tick service's own
round trip.

## Two writer files, one source of truth

`scripts/presets/gen_presets.py` writes all three presets. `scripts/generate-price-bots.py` is now a
thin alias that imports it and writes identical bytes — it used to be a second, hand-built writer
that stayed v4 for months and would have overwritten the shipped v5 bot with a weaker one. Do not
add a third writer; extend the spec and regenerate.

**Watch out for:** `src/components/dbot-space.tsx` had two stray duplicated string literals inside
the STRATEGIES object (an `AI_VISION_OVER_UNDER` risk note and an `AI_EVEN_SWITCHER` one), which is
a syntax error — the whole Bot store page failed to parse. There is no bundler in the sandbox, so
the quick check is to extract `const STRATEGIES: Strategy[] = [ … ];` and `eval` it with the icon
identifiers replaced by `null`.
