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

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- The four Tools tabs share one public Deriv market-data socket (`artifacts/deriv-signal-lab/src/components/market-feed-provider.tsx`) mounted above the tabs, so history survives tab switches and Run Analysis can scan every volatility index at once.
- Run Analysis fans markets out to a Web Worker pool (`src/lib/signal-engine/scan-runner.ts`); the 12-engine digit ensemble and the 14-engine Rise/Fall panel run per market, and results are ranked by a calibrated confidence score (`src/lib/signal-engine/confidence.ts`).
- The strict research gates in `src/lib/over-under/ensemble.ts` are kept and surface as a "Verified edge" flag instead of blocking signals.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

- Every Run Analysis, on every tool, must start immediately across markets, show progress as a percentage and end with a signal, its confidence score and how many engines agreed — never an "Analysis blocked" / WAIT-only result.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
