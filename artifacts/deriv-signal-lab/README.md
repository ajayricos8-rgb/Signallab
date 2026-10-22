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

## Validate

```sh
pnpm --filter @workspace/deriv-signal-lab typecheck
pnpm --filter @workspace/deriv-signal-lab test:digit-analysis
pnpm --filter @workspace/deriv-signal-lab test:neural
PORT=18781 BASE_PATH=/ pnpm --filter @workspace/deriv-signal-lab build
```

The build config requires both `PORT` and `BASE_PATH`, including for production builds.

## Digit-panel behavior and limits

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

## Premium bots

The **Premium bots** tab hosts the autonomous engines. One bot is mounted at a time (the choice is remembered per browser), each with its own decision cycle and its own configuration stored in `localStorage`. No bot has a simulated execution mode: an order is either a real Deriv purchase on the authorized demo or real account, or it is not sent at all.

- **Digit AI engine** (`src/components/premium-bot/digit-ai-bot.tsx`, engine modules in `src/lib/digit-bot/`, controller `src/hooks/use-digit-bot.ts`) — Even/Odd, Over/Under and Matches candidates ranked by walk-forward-validated models against live Deriv proposals. It never martingales.
- **Rise/Fall AI** (`src/components/premium-bot/rise-fall-ai-bot.tsx`, engine modules in `src/lib/rise-fall-bot/`, controller `src/hooks/use-rise-fall-bot.ts`) — a port of the reference "Deriv Rise/Fall AI Bot" script. Live ticks feed a feature window (up/down ratios, momentum, mean tick move, last move, streak), two rules name a direction (strong momentum, then continuation of the last move), the risk manager sizes and gates the order, and Deriv settles the CALL or PUT contract.
- **High/Low hedge** (`src/components/premium-bot/hedging-bot.tsx`, engine modules in `src/lib/hedging-bot/`, controller `src/hooks/use-hedging-bot.ts`) — buys a High Tick and a Low Tick on the same market at the same moment. The bot chooses the tick position each leg predicts from the verified history. See *High/Low hedge specifics* below.

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
