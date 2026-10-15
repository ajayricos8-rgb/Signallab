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

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

Deriv Signal Lab is a market-analysis workspace for Deriv continuous indices. Research tools (Rise/Fall, Over/Under, Even/Odd, Matches) and premium bots fit local models to verified ticks and never invent data.

Signal rules that must not regress:

- A finished scan always publishes a signal — a barrier and OVER/UNDER direction for Over/Under, a direction and duration for Rise/Fall. Strict gate failures appear as caveats and a `research` grade, never as an "analysis blocked" dead end.
- Every signal reports a confidence derived from expected value (`src/lib/ev-confidence.ts`): `0.5 + ROI / 20 %`, computed at a conservative win probability that discounts the edge by its own sampling error. Payouts are either a live Deriv proposal or a clearly labelled zero-margin fair price built from the contract's baseline; none are fabricated.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
