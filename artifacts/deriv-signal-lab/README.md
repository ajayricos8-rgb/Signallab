# Signal Lab — signal research and visual bots

Open **DBot Space → Signal Copilot → AI Analysis** and choose Rise/Fall, Over/Under, Even/Odd or Matches. Each scan uses the same background worker pipeline as the former panels: the predictor ensemble, quantitative synthesis, validated analysis library, neural model and Forge are computed for each market. Validated forecasts contribute to the signal; descriptive measurements are context, not automatically a prediction. The selected market and its scan snapshot are used to build the XML bot. Review stake, stop loss, take profit and trade cap; **Load blocks for editing** loads the blocks without starting a bot, and **Load and Run** starts it after the account and freshness checks. Load and Run immediately replaces the current canvas and starts the strategy without a confirmation; save any work first. Load-only still asks before replacing existing blocks. The snapshot expires, so run a fresh analysis if its gate closes.

The former Tools trade dock and its separate signal-bot auto-run and direct trade ticket are not used by this workflow. The new DBot strategy is an editable block bot, not the old signal-bot runner. Linking an account or analysing a market does not itself place an order. Running a bot can lose money; test with a demo account and review the limits first. Open and closed positions appear on the Trade history tab.

## Run locally

Prerequisites: Node.js 24 (or Node.js 22.6+ for the TypeScript-strip test runner), pnpm, and the repository dependencies.

From the repository root:

```sh
pnpm install
pnpm dev
```

The development script starts the workspace services and binds Vite to `0.0.0.0`. Copy `artifacts/deriv-signal-lab/.env.example` to `.env.local` in that app directory and configure `VITE_DERIV_APP_ID` if using your own Deriv application ID; when unset, the market-data hook falls back to app ID `1089`. The app ID is not an account token: it travels as `app_id` on the public market-data socket and as the `Deriv-App-ID` header on the authenticated REST calls that a PAT enables. The value is read-only at runtime.

Deriv REST calls are made from the browser first. If a browser blocks that cross-origin read, the same request is retried through this workspace's API service (`/api/deriv/*`), which relays only Deriv Options API paths and forwards the caller's `Authorization` and `Deriv-App-ID` headers without logging them.

## DBot Space

The **DBot Space** tab embeds a modified, MIT-licensed copy of Deriv's
[trading-bot-template](https://github.com/deriv-com/trading-bot-template)
(`vendor/deriv-bot`, including its license). It provides the Blockly builder,
charts, XML import/export, journal and six configurable Quick Strategy templates.
The store opens a template for review; **Load** replaces the current workspace
but does not run it. Save an existing bot before loading a replacement.

DBot uses the account connected in Signal Lab automatically: opening the space
links the selected account, and switching or reconnecting in Settings moves the
link with it. There is no second login and no *Link account* step — the only
manual action is **Unlink**, which pauses automatic linking until you press
**Link now**. Signal Lab supplies a separate short-lived WebSocket URL, not a
PAT in the bridge message. The embedded application is **same-origin**, so it
can access the same browser storage as Signal Lab; this is not a PAT security
sandbox. A running strategy can place trades and lose money — linking alone
cannot trade, because the workspace still needs **Run**. Start on demo, review
every block and limit, and keep the tab open. Account changes, iframe reloads,
and lost connections revoke the link, stop local execution and re-link
automatically; an already-open contract can still settle at Deriv.

### Signal Lab data in the workspace

The same-origin channel also carries data, so the workspace does not pay for a
second set of sockets:

- **Ticks** — Signal Lab's shared feed for every volatility index (2,000 ticks
  of history plus live updates) is posted into the frame, one message per
  second carrying only the new ticks. The workspace keeps the last 1,000 per
  market.
- **Account** — balance, currency, open positions and realised profit for the
  linked account, refreshed when it changes.
- **Blocks** — a **Signal Lab** toolbox group (`signal_lab_*` blocks) reads that
  data: last tick, tick list, last digit, market change over N ticks, balance,
  open positions, realised profit, account ID and connection state. Code is
  generated as `Bot.getSignalLab*`, wired in `SignalLabInterface`. The bridge is
  read-only; orders still go through DBot's own authenticated socket for the
  same account, so a bot trades exactly as Signal Lab does.

The wire shapes and the cursor rules live in `src/lib/dbot-bridge.ts` (host)
and `vendor/deriv-bot/src/services/signallab-feed.ts` (frame); both are covered
by `tests/dbot-bridge.test.mjs` and `tests/dbot-bridge-frame.test.mjs`.

`pnpm dev` and the app build compile the vendored engine into the ignored
`artifacts/deriv-signal-lab/public/dbot/` directory. Set `BASE_PATH` consistently
for both builds when deploying below a URL prefix. `DBOT_APP_ID` (or
`VITE_DERIV_APP_ID`) sets the public Deriv app ID, defaulting to `1089`.
Optional standalone OAuth/Google Drive configuration is documented by the
vendored template. DBot Space itself uses the Signal Lab account controls.

The browser smoke test uses mocked Deriv REST/WebSocket responses and blocks
orders; start the dev server first and supply a Chromium executable if needed:

```sh
BROWSER_EXECUTABLE_PATH=/path/to/chromium pnpm --filter @workspace/deriv-signal-lab test:dbot:browser
```

For a quicker check of workspace startup, scan blocks, saved-bot restoration,
and account linking on desktop and mobile, run `test:dbot-startup:browser`
instead. Both browser tests use the same mocked Deriv responses.

## Validate

```sh
pnpm --filter @workspace/deriv-signal-lab typecheck
pnpm --filter @workspace/deriv-signal-lab test:digit-analysis
pnpm --filter @workspace/deriv-signal-lab test:neural
pnpm --filter @workspace/deriv-signal-lab test:forge
PORT=18781 BASE_PATH=/ pnpm --filter @workspace/deriv-signal-lab build
```

The default Vite port is `18781` and the default `BASE_PATH` is `/`.

## Analysis behavior and limits

- AI Analysis scans live market data in background workers for the chosen family and duration. Digit contracts are intersected with Deriv's reported contract metadata; unverified digits and unavailable contracts are not guessed.
- A selected signal can be loaded as blocks for review or loaded and run. The strategy is bound to the selected scan, market and contract through an expiring entry gate. Loading alone does not place an order.
- Analysis estimates are not guarantees. Descriptive measurements do not become votes automatically; predictive contributions are subject to their validation gates. A weak signal is identified before Load and Run; pressing the button starts without a confirmation, including on real accounts.
- The old trade dock's direct ticket and automatic handoff are not part of this workflow; starting a DBot strategy is an explicit user action.

## Embedded neural model (free, local, no API key)

Every analysis now trains a small neural network inside the app, on the market's own feed, as part of its background analysis:

- `signal-net-digit-v1` (113 → 24 → 12 → 10, ≈3.2k parameters) predicts the next digit and feeds Over/Under, Even/Odd and Matches; every contract reuses the same distribution by summing the classes it wins on.
- `signal-net-quote-v1` (20 → 24 → 12 → 2, ≈0.8k parameters) predicts the direction of the move a Rise/Fall horizon settles on.
- Training is deterministic (seeded PRNG, no `Math.random`, no download) and runs in the existing analysis Web Workers. Rows are causal, split 60/20/20 chronologically with a purge gap; the scaler, weights and softmax temperature never see the holdout slice.
- The forecast is folded into the published probability as a weighted second opinion over the same fair odds the contract pays (≤25% of the edge) **only** when it beat chance out of sample: positive Brier skill, positive log-loss skill and a paired z ≥ 2 on ≥60 unseen rows. With zero weight the published number is bit-identical, so a fair market leaves the model silent — which is the honest and usual outcome on synthetic indices.
- The model is also a row in the master decision's source table and, when validated, a small (<5%) term in the confidence score. Its card reports architecture, parameter count, seed, epochs, temperature, row counts, hit rate vs chance and the probability points it moved.
- Free means: no API key, no account, no per-call cost, no tick leaving the device. See `docs/neural-model.md`.

## Forged model (Layer 8 · engines + AI + calculations in one trained model)

The forge is the layer that turns the whole stack into **one** model instead of another report next to it:

- `src/lib/forge/knowledge.ts` is the Deriv syllabus the model is trained against: 72 unique lessons (61 digit / 58 Rise/Fall) across contract semantics, payout economics, feed rules, statistical protocol, structural diagnostics, risk, execution and instrument knowledge, each tagged as a `feature`, `prior`, `teacher`, `veto` or `gate` — plus a market atlas for the volatility classes, their 1HZ variants, Crash/Boom, Step and Jump indices.
- The **Base** section at the bottom of Settings is the Forge observatory: it exposes the model profile, searchable knowledge/market atlas, shared live feed, and a cautious prequential next-digit audit against uniform odds. The audit is research-only and cannot recover Deriv’s internal RNG state or guarantee future digits.
- Each training row is the entire analysis at one replayed origin: the family-weighted engine ensemble (edge, spread, agreement, balance, abstention), the rolling baseline, the analysis prior, the fair rate, the horizon, the market's cadence/volatility class/family and its own causal structure (digit entropy, runs, hot/cold, parity, streak; variance ratio, trend z, volatility ratio, momentum, range position) — 24 frozen, labelled inputs.
- `signal-lab-forge-v1` (24 → 24 → 12 → 2, ≈0.9k parameters) is trained inside the run on that candidate's own replay rows, chronologically split 50/20/30 with a purge gap. Labels are distilled 35% from the audited teachers, and the network learns a **residual correction** on the teacher's log-odds that is shrunk on validation, capped at 0.6 log-odds and switched off entirely when it does not generalise — so the model degrades to its teachers, never to noise.
- The gate is the strictest in the app: ≥60 unseen rows, positive Brier and log-loss skill, and a paired z above a bar raised for the number of candidates compared. Below it the layer is **completely inert** and the published number is bit-identical.
- A validated forge can **confirm**, **trim** or **veto** the call (≤30% of the edge for a confirm, the edge cut to 35% for a veto). A veto reaches the entry: the master decision treats the call as contradicted, so it cannot be certified decisive. It never places an order.
- See `docs/forge-model.md`, `tests/forge-model.test.mjs` (`pnpm --filter @workspace/deriv-signal-lab test:forge`) and the **Layer 8 · forged model** card on every tool.

## Derived trading protocol (used by the dock and history tab)

- `GET /trading/v1/options/accounts` — accounts the PAT can trade (`account_id`, `balance`, `currency`, `account_type`).
- `POST /trading/v1/options/accounts/{accountId}/otp` — single-use WebSocket URL, valid 120 seconds.
- Authenticated socket requests: `balance`, `portfolio` (open positions), `profit_table` (closed positions; the v1 schema reports `sell_price`, so profit is `sell_price - buy_price` when Deriv omits it), `proposal_open_contract` (live contract stream), `proposal`, `buy`, `sell`.
- Field naming follows the v1 schemas: requests use `underlying_symbol` (not the legacy `symbol`), and responses such as portfolio/profit-table rows use it too.


## 300-engine research library

AI Analysis evaluates a common, auditable research catalog for all four contract families. Read
[the research and implementation guide](docs/engine-library.md) and
[the complete numbered catalog](docs/engine-catalog.md).

The inspector separates measurements, context, unavailable inputs and aliases.
An independent 10-model digit / 12-model quote audit uses chronological, purged
validation and is **folded into the signal itself**: a validated research estimate
moves the traded probability, the evidence score and the entry, while an
unvalidated one can only lower them. The evidence gates and the quoted payout are
reported as advice on the run — they never hide the ranked signal and never turn
**Load and Run** into an observation-only button.

- `pnpm run test:engine-lab` — library formulas, causality, null simulations and integration.
- `pnpm run test:digit-analysis` — complete regression suite, including the library.
- `pnpm run docs:engines` — regenerate the 300-entry reference from the UI registry.

No confidence score or backtest guarantees profitable live results.

### Price-path bot-store strategies

The Bot store includes three editable DBot strategies:

- **High/Low Tick AI Sniper v5** trades `TICKHIGH` / `TICKLOW`: of the next five quotes, which position prints the strict high (or the strict low)? Ten outcomes, priced against the **live ten-outcome payout ladder** — the bot reads the TICKHIGH and TICKLOW quotes for positions 1–5 from Deriv's own proposal stream and buys the position whose *one-sigma lower-bound* expected value, `p(1 + multiple) − 1` minus the standard error of ten comparisons, clears `ai min ev`. Ten experts (tie-aware structural anchor, long-run history, the two-change Markov row, recent regime, kernel replay of similar moments, drift, positional persistence, an online softmax net, a volatility-regime model and a Markov chain on the last settled extreme) are scored walk-forward with a Brier loss so an uninformative one loses its vote, and the blend is shrunk toward the market's **measured** structure: the arcsine law (27.3 / 15.6 / 14.1 / 15.6 / 27.3 %) blended with the enumerated grid walk (18.75 / 12.5 / 6.25 / 12.5 / 18.75 %, tie in 31.25 % of windows) at the tie rate this market actually prints. A **market DNA** report describes that structure, an **execution clock** turns five ticks into seconds and charges the measured look-to-fill slip, and a **self-audit** grades every published decision, calibrates the estimate against that record, and stands the bot down when a Wilson bound on the record still sits under break-even. See [the research file](docs/high-low-ticks-research.md), [Deriv's contract description](https://www2.deriv.me/trade-types/options/digital-options/high-low-ticks/) and [API proposal parameters](https://deriv-com.github.io/deriv-api/).
- **Rise/Fall AI Ensemble** trades CALL or PUT using historical entry-to-expiry paths for its configured tick duration, with the same ten-expert, walk-forward, self-calibrating brain and a fractional-Kelly stake.
- **Step Index Rise/Fall Hedge** gates a pair of CALL and PUT trades on four-tick Step Index history and refuses to enter if the market, trade type, unit or duration no longer matches. The two API buys are not atomic and can be filled at different times or only partially.

The models are scored **walk-forward**: a window's outcome is only folded into the accumulators once its last tick has printed, so the reported skill is out-of-sample by construction. Every preset keeps its stake at or above Deriv's 0.35 minimum, sizes it from the measured edge, caps it by `ai max stake` and the balance percent, and never increases it after a loss. They still refuse to trade far more often than they trade — that is the design, not a fault. Historical, conditional estimates are not calibrated odds, and a positive modelled edge means only that the bot's read beats the pricing model's, which is often false; the bot prints the gate that stopped it, its graded record and its skill so the claim can be checked.

For barrier-based hedges, the engine now requests prices for both exact legs before buying. This avoids opening a leg when the other leg's quote is rejected, but cannot guarantee that both buys will succeed or that a given barrier is offered. On an invalid barrier, check the journal's market, duration, barrier and Deriv's error; adjust those settings rather than relying on an automatic substitution. If only one leg opens or a buy response is ambiguous, inspect the account before restarting.
