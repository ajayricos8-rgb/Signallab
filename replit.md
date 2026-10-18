# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm dev` (or `pnpm --filter @workspace/deriv-signal-lab dev`) — starts the API service on port 8080 and the Vite frontend together; set `PORT`/`BASE_PATH` for the preview host.
- `pnpm --filter @workspace/api-server run dev` — run only the API; set `PORT=8080` and `NODE_ENV=development` for the SQLite development store.
- `pnpm run typecheck` — full typecheck across all packages.
- `pnpm run build` — typecheck + build all packages.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec.
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only).
- Required configuration: `DATABASE_URL` for PostgreSQL-backed deployments. Development analysis runs without authentication.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/deriv-signal-lab/src/components/trade-dock.tsx` — the mini bottom trade menu on every Tools tab: manual ticket, bot configuration (martingale, stop loss, runs) and the **Load and Run** button.
- `artifacts/deriv-signal-lab/src/components/signal-bot-window.tsx` — the mini/expandable bot page that shows each taken trade, Stop and Reset.
- `artifacts/deriv-signal-lab/src/hooks/use-signal-bot.ts` + `src/lib/signal-bot/` — the run loop and its pure rules (runs per signal, martingale ladder, stop decisions).
- `artifacts/deriv-signal-lab/src/components/signal-bot-provider.tsx` — shared bot state, mounted above the workspace tabs so a run survives tab switches.

## Architecture decisions

- The four Tools tabs share one public Deriv market-data socket (`artifacts/deriv-signal-lab/src/components/market-feed-provider.tsx`) mounted above the tabs, so history survives tab switches and Run Analysis can scan every volatility index at once.
- Run Analysis fans markets out to a Web Worker pool (`src/lib/signal-engine/scan-runner.ts`). Every analysis is layered: **analysis engines** (`market-state.ts`) measure structure/regime, **prediction engines** (the 12-engine digit ensemble / 14-engine Rise/Fall panel) produce probabilities, a **confirmation layer** (`confirmation.ts`) calibrates them out of sample and checks the analysis prior, and the **entry layer** (`entry.ts`) measures the entry level/window on an older slice and validates it on a newer one. Results are ranked by a calibrated confidence score (`confidence.ts`).
- The strict research gates in `src/lib/over-under/ensemble.ts` are kept and surface as a "Verified edge" flag instead of blocking signals.
- Each tool shows the analysis-engine panel (`AnalysisEnginePanel`) and the confirmation report (`ConfirmationPanel`) next to the signal card, so every probability can be traced to the engines, the calibration and the replay that produced it.

## Product

- Run Analysis on any tool ends in a signal; the mini bottom trade menu can trade it by hand (Trade) or automatically (Load and Run), using the stake and martingale configured on that menu.

## User preferences

- Every Run Analysis, on every tool, must start immediately across markets, show progress as a percentage and end with a signal, its confidence score and how many engines agreed — never an "Analysis blocked" / WAIT-only result.
- The signal bot reads stake and martingale from the mini bottom trade menu and the tick duration plus run count from the analysis; it trades one contract at a time, stops immediately on request and only offers Reset once it is idle.

## Gotchas

- The signal bot lives in a provider above the workspace tabs, so leaving a tool (or the Tools tab) does **not** stop a run — the bot page is only hidden until a trade menu is mounted again. Stop is the only thing that halts purchases.
- The bot page is rendered inside the trade menu's bottom stack, not separately, so it always sits directly above the ticket it belongs to; keep its fixed bottom offset in sync with the dock if the navigation height changes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
