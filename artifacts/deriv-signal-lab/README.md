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
PORT=18781 BASE_PATH=/ pnpm --filter @workspace/deriv-signal-lab build
```

The build config requires both `PORT` and `BASE_PATH`, including for production builds.

## Digit-panel behavior and limits

- The trade dock offers contract direction, a stake, tick expiry and (where applicable) barrier or target digit. Its digit-panel expiry and market reflect the analysis panel's selections; the contract direction remains a manual choice, not the research ranking. Rise/Fall's market and 1–10 tick expiry are separate from its automatic research scan. Pressing Trade validates the ticket, requests a Deriv `proposal` for exactly those terms (`underlying_symbol`, `amount`, `basis: stake`, `duration_unit: t`, digit barrier), shows the live cost/payout, and only sends `buy` with the quoted proposal ID after you confirm.
- Choose a market from Deriv active-symbol metadata and explicitly choose a tick expiry reported by Deriv. Expiry is not inferred by the analysis.
- Over/Under barriers are ranked automatically from Deriv-reported metadata. When Deriv reports `DIGITMATCH` support, Matches ranks the full valid final-digit domain from 0 through 9, including zero; zero is even for parity contracts.
- Final-digit extraction requires matching power-of-ten `pip_size` metadata from active symbols, history, and live ticks. A precision mismatch or missing history precision blocks analysis.
- Research requires at least 500 validated digits, a fresh live tick, an available digit contract, and at least 100 context-conditioned historical outcomes. Smaller or unavailable data is shown as a blocker rather than filled with simulated values.
- Displayed hit frequencies describe in-sample historical outcomes. The nominal Wilson interval is not a calibrated forecast interval; overlapping tick horizons do not satisfy its simple independent-outcome assumption.
- The separate price-context panel reports tick-indexed EMA(9/21/50), RSI(14), MACD(12/26/9), ROC(14), 50-tick log-return volatility and a confirmed 3-tick swing summary. It is not used to rank digit outcomes. Formal multi-horizon Dow analysis, candle-based ATR/ADX and OHLC studies are not implemented.
- Every panel remains `WAIT` until its own data gates pass. Live proposal quotes and order placement exist only in the trade dock, and only for a connected account; payout/EV gating, calibration, walk-forward backtesting, signal persistence, machine learning and automatic execution are not implemented.

## Derived trading protocol (used by the dock and history tab)

- `GET /trading/v1/options/accounts` — accounts the PAT can trade (`account_id`, `balance`, `currency`, `account_type`).
- `POST /trading/v1/options/accounts/{accountId}/otp` — single-use WebSocket URL, valid 120 seconds.
- Authenticated socket requests: `balance`, `portfolio` (open positions), `profit_table` (closed positions; the v1 schema reports `sell_price`, so profit is `sell_price - buy_price` when Deriv omits it), `proposal_open_contract` (live contract stream), `proposal`, `buy`, `sell`.
- Field naming follows the v1 schemas: requests use `underlying_symbol` (not the legacy `symbol`), and responses such as portfolio/profit-table rows use it too.
