# Signal Lab — Deriv digit tools

This workspace contains the Rise/Fall tool and the Over/Under, Even/Odd, and Matches research panels. A compact dark-blue trade configuration dock is shown above the workspace navigation on each tool, and its Trade button places real Deriv Options contracts after you confirm a live quote.

Trading is opt-in. Connect a Deriv account with a Personal Access Token (PAT) in the Settings tab (or straight from the trade ticket). The PAT is exchanged for the accounts it can trade, a single-use OTP WebSocket URL is minted per account, and that authenticated socket streams balance, portfolio, profit table and contract updates. Open and closed positions appear on the Trade history tab.

The research panels themselves remain public-market-data analysis: they do not auto-trade, and a signal is never turned into an order automatically.

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

## Digit-panel behavior and limits

- The dock header has an **Auto on/off** switch for Load and Run. Turn it on before pressing Run Analysis and the bot starts on the signal the moment it is generated (the dock opens, the run begins, no second click); turn it off and Load and Run is manual again. Auto is a one-signal handoff: it never trades the analysis already on screen when it is switched on, it starts at most once per signal id, it never replaces a run that is still trading, and it skips (with a reason under the bot settings) a signal without an engine entry, a disconnected account, an unusable stake or a snapshot too old for the bot. The switch is stored per browser and defaults to off.
- The trade dock offers contract direction, a stake, a duration and (where applicable) barrier or target digit. Duration has its own unit dropdown — ticks, seconds or minutes. Tick durations must fall inside the ranges Deriv reported for that contract and market; seconds/minutes are validated against Deriv-reported time-based ranges when contract metadata is available, otherwise Deriv confirms them in the live proposal (the dock never calls an unverified duration "supported"). The research analysis stays tick-based: choosing seconds/minutes in the dock changes only the manual trade, never the analysis expiry. A Minimize/Expand toggle in the dock header collapses the whole ticket to a slim summary bar (contract and duration stay visible); the choice is remembered in `localStorage`. Its digit-panel market reflects the analysis panel's market; the trade tick expiry starts from the panel's Deriv-supported tick durations but is a separate manual choice from the research expiry, and the contract direction remains manual unless you press **Use analysis** to copy a qualified Over/Under direction, barrier (1–8) and tick horizon into the draft. This button is available only for a fresh qualified snapshot on the same market with a supported expiry. It never opens a quote or places an order; choosing it resets the draft to ticks rather than silently converting a tick forecast into seconds/minutes. Rise/Fall's market and 1–10 tick expiry are separate from its automatic research scan. Pressing Trade validates the ticket, requests a Deriv `proposal` for exactly those terms (`underlying_symbol`, `amount`, `basis: stake`, chosen `duration_unit`, digit barrier), shows the live cost/payout, and only sends `buy` with the quoted proposal ID after you confirm.
- Choose a market from Deriv active-symbol metadata and explicitly choose a tick expiry reported by Deriv for the research analysis. Research expiry is not inferred by the analysis.
- Over/Under research barriers are strictly limited to 1–8, intersected with Deriv-reported metadata (manual dock barriers keep the full contract-valid domain). When Deriv reports `DIGITMATCH` support, Matches ranks the full valid final-digit domain from 0 through 9, including zero; zero is even for parity contracts.
- The Over/Under panel fits twelve local models across eight engine families on the latest 2,000 verified digits: first-order 10 × 10 Markov transitions, higher-order (2–5) n-grams, a two-state categorical HMM, rolling 100/1,000-tick frequencies with chi-square and per-digit Z-scores, Shannon entropy with an LZ78 compressibility estimate (not exact Kolmogorov complexity), run-length/geometric streak diagnostics, digit SMA/EMA/MACD regression, exact-subsequence and bounded regex-style template matching, bounded ARIMA(p,d,1) selection with a GARCH(1,1) variance fit, a small locally trained LSTM, and depth-two gradient-boosted digit classifiers. Fitting runs in a Web Worker so the trade UI stays responsive. Models train on the first 60% of the sample, are weighted by Brier skill on the next 20% (family-balanced, sparse or harmful models get no vote), and the combined forecast must beat a rolling-frequency baseline on the final held-out 20% before any barrier can qualify. Candidates are ranked by baseline-relative lift — never by raw hit rate — and need at least three agreeing engine families. A market-structure safety gate compares up to 500 fitted ticks against up to 200 recent held-out ticks using Jensen–Shannon divergence: both marginal digit balance and supported transition rows are checked. A large shift (fixed heuristic limits of 0.12 marginal / 0.25 transition bits) blocks all barriers; these are not significance tests or proof of stationarity. Scans run on demand against a frozen snapshot; stale data invalidates the signal. Over/Under signals also expire after 60 seconds of market advancement or max(20, horizon) newer ticks, requiring a fresh scan. The engine panel labels expired snapshots as diagnostic only. On an independent random stream the expected result is `WAIT`.
- Final-digit extraction requires matching power-of-ten `pip_size` metadata from active symbols, history, and live ticks. A precision mismatch or missing history precision blocks analysis.
- Research requires at least 500 validated digits, a fresh live tick, an available digit contract, and at least 100 context-conditioned historical outcomes. Smaller or unavailable data is shown as a blocker rather than filled with simulated values.
- Displayed hit frequencies describe in-sample historical outcomes. The nominal Wilson interval is not a calibrated forecast interval; overlapping tick horizons do not satisfy its simple independent-outcome assumption.
- The separate price-context panel reports tick-indexed EMA(9/21/50), RSI(14), MACD(12/26/9), ROC(14), 50-tick log-return volatility and a confirmed 3-tick swing summary. It is not used to rank digit outcomes. Formal multi-horizon Dow analysis, candle-based ATR/ADX and OHLC studies are not implemented.
- Every panel remains `WAIT` until its own data gates pass. Live proposal quotes and order placement exist only in the trade dock, and only for a connected account; payout/EV gating, probability calibration, persistent signals, external/pretrained ML services (the LSTM and boosting models are small local implementations, not XGBoost/LightGBM downloads) and automatic execution are not implemented. Engine probabilities are research estimates, not calibrated win probabilities or a promise of profit.

## Embedded neural model (free, local, no API key)

Every analysis now trains a small neural network inside the app, on the market's own feed, and shows it on the tool page as **Layer 7 · free embedded neural model**:

- `signal-net-digit-v1` (113 → 24 → 12 → 10, ≈3.2k parameters) predicts the next digit and feeds Over/Under, Even/Odd and Matches; every contract reuses the same distribution by summing the classes it wins on.
- `signal-net-quote-v1` (20 → 24 → 12 → 2, ≈0.8k parameters) predicts the direction of the move a Rise/Fall horizon settles on.
- Training is deterministic (seeded PRNG, no `Math.random`, no download) and runs in the existing analysis Web Workers. Rows are causal, split 60/20/20 chronologically with a purge gap; the scaler, weights and softmax temperature never see the holdout slice.
- The forecast is folded into the published probability as a weighted second opinion over the same fair odds the contract pays (≤25% of the edge) **only** when it beat chance out of sample: positive Brier skill, positive log-loss skill and a paired z ≥ 2 on ≥60 unseen rows. With zero weight the published number is bit-identical, so a fair market leaves the model silent — which is the honest and usual outcome on synthetic indices.
- The model is also a row in the master decision's source table and, when validated, a small (<5%) term in the confidence score. Its card reports architecture, parameter count, seed, epochs, temperature, row counts, hit rate vs chance and the probability points it moved.
- Free means: no API key, no account, no per-call cost, no tick leaving the device. See `docs/neural-model.md`.

## Forged model (Layer 8 · engines + AI + calculations in one trained model)

The forge is the layer that turns the whole stack into **one** model instead of another report next to it:

- `src/lib/forge/knowledge.ts` is the Deriv syllabus the model is trained against: 72 unique lessons (61 digit / 58 Rise/Fall) across contract semantics, payout economics, feed rules, statistical protocol, structural diagnostics, risk, execution and instrument knowledge, each tagged as a `feature`, `prior`, `teacher`, `veto` or `gate` — plus a market atlas for the volatility classes, their 1HZ variants, Crash/Boom, Step and Jump indices.
- The **Base** workspace tab (“The Base” in navigation) is the Forge observatory: it exposes the model profile, searchable knowledge/market atlas, shared live feed, and a cautious prequential next-digit audit against uniform odds. The audit is research-only and cannot recover Deriv’s internal RNG state or guarantee future digits.
- Each training row is the entire analysis at one replayed origin: the family-weighted engine ensemble (edge, spread, agreement, balance, abstention), the rolling baseline, the analysis prior, the fair rate, the horizon, the market's cadence/volatility class/family and its own causal structure (digit entropy, runs, hot/cold, parity, streak; variance ratio, trend z, volatility ratio, momentum, range position) — 24 frozen, labelled inputs.
- `signal-lab-forge-v1` (24 → 24 → 12 → 2, ≈0.9k parameters) is trained inside the run on that candidate's own replay rows, chronologically split 50/20/30 with a purge gap. Labels are distilled 35% from the audited teachers, and the network learns a **residual correction** on the teacher's log-odds that is shrunk on validation, capped at 0.6 log-odds and switched off entirely when it does not generalise — so the model degrades to its teachers, never to noise.
- The gate is the strictest in the app: ≥60 unseen rows, positive Brier and log-loss skill, and a paired z above a bar raised for the number of candidates compared. Below it the layer is **completely inert** and the published number is bit-identical.
- A validated forge can **confirm**, **trim** or **veto** the call (≤30% of the edge for a confirm, the edge cut to 35% for a veto). A veto reaches the entry: the master decision treats the call as contradicted, so it cannot be certified decisive. It never places an order.
- See `docs/forge-model.md`, `tests/forge-model.test.mjs` (`pnpm --filter @workspace/deriv-signal-lab test:forge`) and the **Layer 8 · forged model** card on every tool.

## Premium bots

The **Premium bots** tab hosts the autonomous engines. One bot is mounted at a time (the choice is remembered per browser), each with its own decision cycle and its own configuration stored in `localStorage`. No bot has a simulated execution mode: an order is either a real Deriv purchase on the authorized demo or real account, or it is not sent at all.

**Entry timing — a new tick is the trigger.** Every bot is tick-driven: the moment a tick is verified by the shared feed, the bot re-evaluates its rule and, if the rule and the risk gate agree, sends the order in that cycle. The interval in the configuration is a **watchdog** for a quiet feed, not the entry cadence it used to be. Three details make that true:

- The old scheduler polled on `decisionIntervalMs` and then dropped any cycle that arrived within 80% of it, so a signal that appeared just after a poll waited up to 2 s. The poll is now a floor of 200 ms that exists only to stop the same tick being evaluated twice (`src/hooks/use-bot-cycle-trigger.ts`, `shouldStartBotCycle`).
- Start and *Run cycle now* force a cycle instead of waiting for the next tick; the first cycle after Start is evaluated with the running state Start just committed, so it is no longer thrown away.
- A tick that arrives while a cycle is still pricing re-runs a cycle as soon as that one finishes, so an opportunity is never lost to a slow proposal round trip.

The risk and market gates are unchanged: a stale feed, a missing account, a paused bot, a purchase still in flight, an unreconciled order and the configured loss/trade limits all still block an entry, and each block is named in the decision log.

A configuration saved by an older build is rebuilt from the current defaults once (`src/lib/bot-config-version.ts`), so these pacing changes reach a browser that still holds the previous values; from then on every edit is kept.

- **Digit AI engine** (`src/components/premium-bot/digit-ai-bot.tsx`, engine modules in `src/lib/digit-bot/`, controller `src/hooks/use-digit-bot.ts`) — Even/Odd, Over/Under and Matches candidates ranked by walk-forward-validated models against live Deriv proposals. It never martingales.
- **Rise/Fall AI** (`src/components/premium-bot/rise-fall-ai-bot.tsx`, engine modules in `src/lib/rise-fall-bot/`, controller `src/hooks/use-rise-fall-bot.ts`) — a port of the reference "Deriv Rise/Fall AI Bot" script. Live ticks feed a feature window (up/down ratios, momentum, mean tick move, last move, streak), two rules name a direction (strong momentum, then continuation of the last move), the risk manager sizes and gates the order, and Deriv settles the CALL or PUT contract.
- **High/Low hedge** (`src/components/premium-bot/hedging-bot.tsx`, engine modules in `src/lib/hedging-bot/`, controller `src/hooks/use-hedging-bot.ts`) — buys a High Tick and a Low Tick on the same market at the same moment. The bot chooses the tick position each leg predicts from the verified history. See *High/Low hedge specifics* below.
- **Mafia bot** (`src/components/premium-bot/mafia-bot.tsx`, engine modules in `src/lib/mafia-bot/`, controller `src/hooks/use-mafia-bot.ts`) — Step indices only. It scores tick-direction uniformity, replays the four-tick windows that actually printed, and buys a 4-tick Rise and a 4-tick Fall leg together with money management and a full profit/loss breakdown. See *Mafia bot specifics* below.

Rise/Fall bot specifics:

- **Modes.** *Analysis only* reads live ticks, names the direction, writes the signal down and scores it against the ticks that follow; it never sends an order. *Live trading* buys real contracts, and switching to it requires an explicit confirmation dialog that restates the account, stake model and limits.
- **Configuration.** Market, expiry and unit, stake model (fixed / martingale ladder / percentage of balance) with minimum, maximum and balance-share caps, consecutive-loss stop, daily loss limit, daily take profit, session trade and time limits, cooldown, feature-window sizes, momentum and volatility thresholds in verified pips, the adaptive-threshold switch, both ratio thresholds, and the expected-value gate. Every input is clamped by `sanitizeRiseFallConfig`, so a stored or pasted value cannot produce an unbounded stake or a zero window.
- **Thresholds in pips.** The reference script's constants (0.0008 momentum, 0.0003 volatility) only mean something at one price level, so the port expresses both in verified pips of the selected symbol and can additionally scale the momentum edge with measured volatility.
- **Martingale is opt-in.** The stake model defaults to fixed. Enabling the ladder shows the stake it can reach before resetting, and the consecutive-loss limit remains the only thing that stops a run.
- **Expected value.** The rule is replayed over the ticks this browser already collected to count how often the same signal was right at the chosen horizon; that historical rate is then priced against the live Deriv proposal (`proposal` → break-even → EV). A thin sample is reported as *withheld* rather than assumed profitable, and an order whose EV falls below the configured minimum is refused with the reason logged.
- **Live positions.** The bot's own contracts are listed with stake, payout, entry/current/exit spot, tick progress, running and settled P/L, and a two-step *Sell now* that sends Deriv's `sell`. Open positions the bot did not open are listed separately, and the Trade history tab still shows every position on the account. A running payout is never booked as profit: only Deriv settlements move the ledger.
- **Order safety.** Purchases are single-flight; a receipt that never arrives leaves the order *unreconciled*, is matched against the account's portfolio, and blocks further orders until the account says what happened (or 20 seconds pass with no matching open contract).
- **Trade log.** Every attempt — bought, refused or settled — is logged in the browser and exportable as CSV with the same columns the reference script wrote to `trades_log.csv`.
- **Shared connections.** Both bots reuse the frozen public market-data feed and the authenticated trading session; neither opens its own socket, stores a token, or sends account data anywhere.

## High/Low hedge specifics

**The contract.** A High Tick (`TICKHIGH`) wins if the tick you selected (1 to 5) is the strictly highest of the next five ticks. A Low Tick (`TICKLOW`) wins if it is the strictly lowest. Both have a fixed duration of five ticks, are offered on synthetic indices only, and are sent to Deriv's `proposal` with `duration_unit: t` and `selected_tick`. A tie for the extreme is a loss for that leg.

**The pair.** Each pair is one High Tick and one Low Tick of the same stake on the same window. Both proposals are requested together, both must pass validation, the expected-value gate must pass, and then both `buy` requests are sent together. The worst case for a pair is both stakes lost. On a random walk the two legs win together in about 1 window in 20, exactly one leg wins in about 3 windows in 10, and neither wins in about 65 in 100. A winning leg's payout must cover the losing leg's stake, so the pair's expected value is the sum of the two leg expectations.

**Payout.** Deriv quotes the High Tick and Low Tick payout only through a live `proposal`; it is not published as a fixed figure. The bot therefore never assumes a payout. A leg whose payout is missing, or not above its ask, is unpriced, and so is the pair.

**Choosing the tick positions.** The replay walks the most recent verified ticks (default 500). For each entry tick it looks at the five ticks that followed and records which position was the strict extreme; a tie counts for nobody. Each leg names the position that was the extreme most often, provided there are at least `minSelectionWindows` windows (default 200) and the chosen rate is at least `minTickEdgeZ` standard errors above the 20% baseline (default 2). Below either threshold, automatic selection is withheld. Manual positions can be set instead. This describes the collected history; on an independent random walk every position is 20%.

**Expected-value gate.** Each leg is priced as `q·(payout − ask) − (1 − q)·ask`, where `q` is the leg's historical rate at the chosen position. A pair is bought only if the sum is at least `minExpectedValue` per unit staked (default 0), and only when the pair is priced and the sample is sufficient. Otherwise nothing is bought and the refusal is logged with its reason. The gate can be turned off, in which case it is stated in the log.

**Sizing and limits.** `maxStakeShareOfBalance` caps both legs together, so each leg is at most half of that share of the balance. Limits count pairs: open pairs, pairs per session, losing pairs in a row, daily loss, daily take profit and session length. Refused pairs are recorded separately and capped, so they cannot push real trades out of the log.

**Order safety.**
- Purchases are single-flight. A purchase reply that times out leaves the pair *unreconciled*: the bot matches it against the account's open contracts (by type, symbol and start time) and sends no new pair until it has an answer.
- If one leg is refused after the other was bought, the bought leg is sold back rather than left unhedged. If that sale fails, the bot pauses and says so.
- Stopping the bot blocks new pairs only; bought legs keep being monitored until Deriv settles them.

**Analysis mode.** Each decision cycle records its entry in analysis mode too, and scores it once the next five ticks are in. The hit rates for each position are shown beside the 20% baseline. When an account is connected, analysis mode also requests the two proposals so the live payouts and EV are visible. It never sends a `buy`.

**Not verified here.** The contract documentation says High/Low Tick contracts run for their full five ticks. The bot's early-sale path (`sell`) is used for unwinding and for the manual *Sell* button, and it works only when Deriv reports the contract as sellable. Confirm this on a demo account before relying on the unwind path.

**Disclaimer.** The house edge applies to every contract, including each leg of a hedge. A hedge changes the spread of outcomes, not the expected loss. Use a demo account first.

## Mafia bot specifics

**The universe.** Step indices carry a fixed step per tick, which gives a four-tick Rise/Fall window a clean up / down / level structure. The bot allows `stpRNG`, `stpRNG2` … `stpRNG5` and refuses every other market — volatility indices, 1-second indices, forex, commodities — even when Deriv would quote a Rise/Fall contract on them. If the shared feed is on another symbol the bot moves it to a Step index rather than trading what is selected.

**The pair.** Every entry is two 4-tick Rise/Fall contracts on the same market, requested and bought in the same round: the primary leg trades the direction the analysis measured, the cover leg trades the other way at `hedgeRatioPercent` of the primary stake. Both legs settle on the same tick, so exactly one wins — unless the window ends exactly where it started, in which case both lose. The pair has three outcomes and the bot prices all three.

**The firing rule.** The bot buys the pair as soon as the uniformity gate passes — that is the trigger. It does not wait for a second quote round trip: the two legs are priced with live `proposal` requests, decided on, and bought with those same quotes in one cycle. Every failed check is logged, not just the first, so a near miss is visible.

**The arithmetic, stated plainly.** The payout multiple `m` is read from the live quote, never assumed: Deriv has quoted about 3.08× a stake for these four-tick contracts, but it varies by index and volatility, and the page shows whatever is being quoted. A pair costs `(1 + h)·s` and pays `m·s` on whichever leg wins, and `m·h·s` when the cover wins. So a winning leg covers the pair only when `m > (1 + h)/h`; at `m ≈ 3` any cover above 50% does, and the default 90% keeps the legs close to equal, which is the cheapest hedge against a level window. Whether the pair breaks even overall depends on the level-window share `f`: with equal stakes the expected value is `((1 − f)·(m − 2) − 2f)·s`, positive only while `f < (m − 2)/m`. At `m = 3.08` that ceiling is 35.1%, and the replay on a real Step index has measured 35.7% — which is exactly why these numbers are printed next to each other instead of a claim being made.

**The expected-value gate is a brake, not the trigger.** It ships **off** so the bot fires on uniformity, and the pair arithmetic, break-even and evidence are displayed either way. Turn it on and a pair is refused unless its expected value per unit staked clears `minExpectedValue`, and the measured four-tick hit rate (haircut by `evidenceZ` standard errors) clears the break-even the chosen ratio needs. A pair whose winning leg cannot cover both stakes is refused whatever the setting.

**Uniformity.** The last `uniformityWindow` ticks are reduced to the signs of tick-to-tick moves. The bot reports the up/down/level split, the binomial z of the directional imbalance, the sign-persistence z (does an up tick follow an up tick, or does the tape alternate), the longest run against the `log2(n)` a fair coin produces, and how cleanly the market steps. A tape passes when the count and the persistence agree on the same direction, the combined score clears `minUniformity` (default 0.20) and both z values clear `minUniformityZ` (default 1.0) — a genuine lean rather than a statistical claim. The two floors are configuration, not constants, and every failure is named in the decision log.

**The replay.** Every historical four-tick window is scored for the direction the gate pointed at. Level windows stay in the sample — they are the windows where both legs lose — and a second replay counts only the windows where the gate itself would have fired, so the probability describes the rule rather than the market's unconditional drift. An in-sample win rate is optimistic, so `evidenceZ` standard errors are subtracted before the break-even comparison (default one sigma). A thin conditional sample falls back to the unconditional rate, labelled as such.

**Money management.** Stake mode (flat / martingale after losing pairs / fixed fraction of balance), primary stake, cover ratio (default 90% of the primary), maximum stake, balance share per pair, martingale factor and step cap, open pairs, pairs per session, losing pairs in a row, daily loss limit, daily take profit, session minutes, cooldown and the watchdog interval. Every input is clamped by `sanitizeMafiaBotConfig`. A cover leg that would fall below Deriv's minimum stake blocks the pair instead of being dropped.

**Execution safety.** Purchases are single-flight; a missing receipt marks the pair *unreconciled* and the bot adopts the legs only when the account reports contracts matching type, symbol, stake to the cent and start time — otherwise it pauses. If one leg is refused, the other is sold back. Quotes are re-requested immediately before buying, and the pair is not bought if the fresh payout no longer clears the break-even.

**Profit and loss.** Realised P/L comes only from Deriv settlements, summed per leg and per pair, with wins/losses/level windows, average pair, best/worst, return on stake, losing streak and a session summary. Open pairs contribute their stake at risk, never an assumed profit. The rule record scores every gate pass — bought or not — against the ticks that followed.

**Disclaimer.** A two-sided pair does not create an edge; it changes the shape of the outcome, and the level-window share is what decides the pair's sign at these payouts. Firing on uniformity alone is a signal, not an edge — the panel says so on every decision, and the expected-value gate is there when you want the arithmetic to be a requirement. Use a demo account first.

## Derived trading protocol (used by the dock and history tab)

- `GET /trading/v1/options/accounts` — accounts the PAT can trade (`account_id`, `balance`, `currency`, `account_type`).
- `POST /trading/v1/options/accounts/{accountId}/otp` — single-use WebSocket URL, valid 120 seconds.
- Authenticated socket requests: `balance`, `portfolio` (open positions), `profit_table` (closed positions; the v1 schema reports `sell_price`, so profit is `sell_price - buy_price` when Deriv omits it), `proposal_open_contract` (live contract stream), `proposal`, `buy`, `sell`.
- Field naming follows the v1 schemas: requests use `underlying_symbol` (not the legacy `symbol`), and responses such as portfolio/profit-table rows use it too.


## 300-engine research library

All four Tools tabs now evaluate a common, auditable research catalog. Read
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
