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

- `artifacts/deriv-signal-lab/src/components/trade-dock.tsx` — the mini bottom trade menu on every Tools tab: manual ticket, bot configuration (martingale, stop loss, take profit by winning runs or realised profit, runs) and the **Load and Run** button.
- `artifacts/deriv-signal-lab/src/components/signal-bot-window.tsx` — the mini/expandable bot page that shows each taken trade, Stop and Reset.
- `artifacts/deriv-signal-lab/src/hooks/use-signal-bot.ts` + `src/lib/signal-bot/` — the run loop and its pure rules (runs per signal, martingale ladder, stop decisions).
- `artifacts/deriv-signal-lab/src/lib/engine-lab/fusion.ts` — layer 4: how the 300-engine research ensemble is folded into the traded probability and evidence score.
- `artifacts/deriv-signal-lab/src/components/signal-bot-provider.tsx` — shared bot state, mounted above the workspace tabs so a run survives tab switches.

## Architecture decisions

- The four Tools tabs share one public Deriv market-data socket (`artifacts/deriv-signal-lab/src/components/market-feed-provider.tsx`) mounted above the tabs, so history survives tab switches and Run Analysis can scan every volatility index at once.
- Run Analysis fans markets out to a Web Worker pool (`src/lib/signal-engine/scan-runner.ts`). Every analysis is layered: **analysis engines** (`market-state.ts`) measure structure/regime, **prediction engines** (the 12-engine digit ensemble / 14-engine Rise/Fall panel) produce probabilities, a **confirmation layer** (`confirmation.ts`) calibrates them out of sample and checks the analysis prior, a **precision layer** (`precision.ts`) shrinks every published edge by how much of it survived out of sample and charges the winner's curse of having been ranked, the **entry layer** (`entry.ts`) measures the entry level/window on an older slice and validates it on a newer one, and a **quant + AI synthesis layer** (`ai-synthesis.ts`) folds the independent quant measurement suite (distribution, parity runs, recurrence/FFT, Hurst/RSI/MACD regime) into one verdict with a cross-window stability check. Results are ranked by a calibrated confidence score (`confidence.ts`).
- Workers are an optimisation, never a dependency: each worker answers a handshake after its script loads, jobs whose worker dies (script 404, wrong MIME, CSP/proxy blocks, thread crash, silence) are retried once in a replacement worker and then analysed inline on the main thread, so Run Analysis ends in ranked signals on every hosting environment instead of a crash banner.
- The strict research gates in `src/lib/over-under/ensemble.ts` are kept and surface as a "Verified edge" flag instead of blocking signals.
- Each tool shows the analysis-engine panel (`AnalysisEnginePanel`), the confirmation report (`ConfirmationPanel`) and the measured error bar (`PrecisionPanel`) next to the signal card, so every probability can be traced to the engines, the calibration, the replay and the research fusion that produced it.
- The precision layer is what keeps the published number honest. On a fair stream it collapses a 16-contract scan to exactly 0.0 points of edge (it used to report ~0.1); on a real edge it keeps 92% of the true magnitude rather than 77%, and it halves the error on the hard case of a small edge hidden in noise.

## Product

- Run Analysis on any tool ends in a signal; the mini bottom trade menu can trade it by hand (Trade) or automatically (Load and Run), using the stake and martingale configured on that menu.
- Load and Run is a real button, not a status label: it is enabled whenever a finished analysis produced an entry plan, a valid stake is typed and no run is in progress. The research library's evidence gates and the quoted payout only ever add advisory text to the run.
- The 300-engine research library is part of the overall analysis, not a separate report. Its validated forecast is folded into every candidate's probability, the evidence score and the entry evidence (`src/lib/engine-lab/fusion.ts`); the inspector shows the weight and the probability points it contributed.

## User preferences

- Every Run Analysis, on every tool, must start immediately across markets, show progress as a percentage and end with a signal, its confidence score and how many engines agreed — never an "Analysis blocked" / WAIT-only result.
- The signal bot reads stake, martingale and the exit limits from the mini bottom trade menu (stop loss, take profit by winning runs, take profit by realised profit) and the tick duration plus run count from the analysis; both take profit targets are optional (0 = off), either one ends the run as **Completed**, it trades one contract at a time, stops immediately on request and only offers Reset once it is idle.
- The bot trades every signal it is loaded with. No research gate, evidence status or quoted payout may turn Load and Run into an observation-only state: they are shown as advice on the run (and in the bot page) instead.

## Gotchas

- The signal bot lives in a provider above the workspace tabs, so leaving a tool (or the Tools tab) does **not** stop a run — the bot page is only hidden until a trade menu is mounted again. Stop is the only thing that halts purchases.
- The bot page is rendered inside the trade menu's bottom stack, not separately, so it always sits directly above the ticket it belongs to; keep its fixed bottom offset in sync with the dock if the navigation height changes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

## 300-engine research library (2026-10-18)

- `src/lib/engine-lab/` adds an explicit, data-aware registry for all 300 requested entries. These are measurements, predictors, policies and performance metrics, not 300 independent votes. #166 and #228 are transparent aliases.
- Both signal analyzers run a separate causal research forecast audit for every candidate/duration. Tuning, calibration and final test rows are chronological, purged and non-overlapping. A validated contradiction can only reduce the original edge; unvalidated/supportive research cannot boost it.
- The shared `components/signal/engine-lab-panel.tsx` inspector is on every tool, searchable by ID/name/group/status, with formulas, sources, model weights, real readings and JSON export. One full audit is attached to the selected market result, not copied to every horizon.
- Run Analysis still always returns a ranked candidate, and **automatic execution is no longer gated on it**: the research gates and the quoted payout are advisory only (`researchAdvisory` in `src/lib/engine-lab/execution.ts`), so a finished signal is always tradeable by Load and Run. Quote economics are still measured per proposal and recorded on the run row instead of vetoing `confirmBuy`. Manual trading is not automatically enabled or disabled by this research report.
- Layer 4 (`src/lib/engine-lab/fusion.ts`) folds the research ensemble into the traded estimate: a validated ensemble earns up to 35% of the edge and can move it either way, an unvalidated one gets at most 15% and only downwards. The same rule feeds `researchTerm` in `confidence.ts` (≤6% of the raw score, optional so callers without it stay bit-identical).
- #265–270 use only active-account loaded closed positions matching market, family and currency; otherwise unavailable. No fabricated payout/Sharpe/drawdown values.
- Research, formulas and limitations: `artifacts/deriv-signal-lab/docs/engine-library.md` and generated `docs/engine-catalog.md`. Run `test:engine-lab`, the existing full `test:digit-analysis`, typecheck and build when changing this layer.
