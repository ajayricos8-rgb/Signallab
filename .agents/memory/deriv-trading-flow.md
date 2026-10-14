---
name: Deriv trading flow (Options API v1)
description: How PAT-based connection, trading, and position tracking work in the trade dock, and what must not change.
---

Signal Lab runs two separate Deriv connections. The public market-data feed (`wss://api.derivws.com/trading/v1/options/ws/public?app_id=…`) is research-only and must stay untouched, including the `VITE_DERIV_APP_ID` value read in `use-deriv-digit-feed.ts` and `rise-fall-tool.tsx`. Trading uses a second, authenticated socket opened only after a user-entered Personal Access Token is verified.

Flow: `GET /trading/v1/options/accounts` (Bearer PAT + `Deriv-App-ID` header) → `POST /trading/v1/options/accounts/{accountId}/otp` (single-use, 120s) → connect the returned demo/real `wss` URL. There is no in-socket `authorize` message on v1.

Socket requests: `balance`, `portfolio` (open positions), `profit_table` (closed positions; the v1 schema reports `sell_price`, so profit is derived), `proposal_open_contract` (live stream), `proposal` → `buy`, and `sell`. Field names follow the v1 schemas, e.g. requests use `underlying_symbol`, not the legacy `symbol`.

**Why:** Deriv's legacy `ws.derivws.com/websockets/v3` API is a different product surface; this app registers a v1 application ID, so mixing the two would break both the frozen public feed and trading.

**How to apply:** keep `VITE_DERIV_APP_ID` read-only and reused as the `Deriv-App-ID` header; add new order types by extending `src/lib/deriv-trading.ts` (pure builders/parsers + tests) rather than sending ad-hoc messages from components.
