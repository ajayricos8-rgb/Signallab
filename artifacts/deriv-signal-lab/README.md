# Signal Lab — Deriv digit tools

This workspace contains the Rise/Fall tool and the Over/Under, Even/Odd, and Matches research panels. The digit panels use Deriv market-data WebSockets and do not authorize accounts, request or place trades, or auto-trade.

## Run locally

Prerequisites: Node.js 24 (or Node.js 22.6+ for the TypeScript-strip test runner), pnpm, and the repository dependencies.

From the repository root:

```sh
pnpm install
pnpm dev
```

The development script starts the workspace services and binds Vite to `0.0.0.0`. Copy `artifacts/deriv-signal-lab/.env.example` to `.env.local` in that app directory and optionally set `VITE_DERIV_APP_ID` to override the Deriv App ID; when unset, the app uses its registered App ID `34mtC7NMdqSHTg3tn2WIu`. Market data streams from Deriv's public Options API channel (`wss://api.derivws.com/trading/v1/options/ws/public`), which needs no account token or OTP. The App ID is not an account token, and no account token is used by these panels.

## Validate

```sh
pnpm --filter @workspace/deriv-signal-lab typecheck
pnpm --filter @workspace/deriv-signal-lab test:digit-analysis
pnpm --filter @workspace/deriv-signal-lab build
```

The build config requires both `PORT` and `BASE_PATH`, including for production builds.

## Digit-panel behavior and limits

- Choose a market from Deriv active-symbol metadata and explicitly choose a tick expiry reported by Deriv. Expiry is not inferred by the analysis.
- Over/Under barriers are ranked automatically from Deriv-reported metadata. When Deriv reports `DIGITMATCH` support, Matches ranks the full valid final-digit domain from 0 through 9, including zero; zero is even for parity contracts.
- Final-digit extraction requires matching power-of-ten `pip_size` metadata from active symbols, history, and live ticks. A precision mismatch or missing history precision blocks analysis.
- Research requires at least 500 validated digits, a fresh live tick, an available digit contract, and at least 100 context-conditioned historical outcomes. Smaller or unavailable data is shown as a blocker rather than filled with simulated values.
- Displayed hit frequencies describe in-sample historical outcomes. The nominal Wilson interval is not a calibrated forecast interval; overlapping tick horizons do not satisfy its simple independent-outcome assumption.
- The separate price-context panel reports tick-indexed EMA(9/21/50), RSI(14), MACD(12/26/9), ROC(14), 50-tick log-return volatility and a confirmed 3-tick swing summary. It is not used to rank digit outcomes. Formal multi-horizon Dow analysis, candle-based ATR/ADX and OHLC studies are not implemented.
- Every panel remains `WAIT`. Account-currency proposal quotes, payout/EV gating, calibration, walk-forward backtesting, signal persistence, machine learning and execution are not implemented.
