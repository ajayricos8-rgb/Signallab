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
- `artifacts/deriv-signal-lab/src/lib/signal-bot/auto.ts` — the Auto rule that decides whether a freshly generated signal should start Load and Run by itself.
- `artifacts/deriv-signal-lab/src/lib/engine-lab/fusion.ts` — layer 4: how the 300-engine research ensemble is folded into the traded probability and evidence score.
- `artifacts/deriv-signal-lab/src/components/signal-bot-provider.tsx` — shared bot state, mounted above the workspace tabs so a run survives tab switches.
- `artifacts/deriv-signal-lab/src/lib/neural/` — layer 7: the embedded, free neural model (network, causal features, chronological training + validation, fusion).
- `artifacts/deriv-signal-lab/src/components/signal/neural-model-card.tsx` — the model card, live forecast and measured skill shown on every tool.

## Architecture decisions

- The four Tools tabs share one public Deriv market-data socket (`artifacts/deriv-signal-lab/src/components/market-feed-provider.tsx`) mounted above the tabs, so history survives tab switches and Run Analysis can scan every volatility index at once.
- Run Analysis fans markets out to a Web Worker pool (`src/lib/signal-engine/scan-runner.ts`). Every analysis is layered: **analysis engines** (`market-state.ts`) measure structure/regime, **prediction engines** (the 12-engine digit ensemble / 15-engine Rise/Fall panel) produce probabilities, a **confirmation layer** (`confirmation.ts`) calibrates them out of sample and checks the analysis prior, a **precision layer** (`precision.ts`) shrinks every published edge by how much of it survived out of sample and charges the winner's curse of having been ranked, the **entry layer** (`entry.ts`) measures the entry level/window on an older slice and validates it on a newer one, and a **quant + AI synthesis layer** (`ai-synthesis.ts`) folds the independent quant measurement suite (distribution, parity runs, recurrence/FFT, Hurst/RSI/MACD regime) into one verdict with a cross-window stability check. Results are ranked by a calibrated confidence score (`confidence.ts`).
- Layer 7 is a network trained in the app on the market's own feed, not a hosted or pretrained model: a digit net (`signal-net-digit-v1`, 113→24→12→10) for Over/Under, Even/Odd and Matches and a quote net (`signal-net-quote-v1`, 20→24→12→2) for Rise/Fall. Rows are causal and chronological, split 60/20/20 with a purge gap, and the holdout is scored once against the same fair odds the contract pays on. Its forecast is blended into the published probability (≤25% of the edge) only after a positive Brier skill with a paired z ≥ 2 on ≥60 unseen rows; otherwise the weight is exactly 0 and the number is bit-identical. It is also its own row in the master decision's source pool and a small (<5%) term in the confidence score when validated.
- Workers are an optimisation, never a dependency: each worker answers a handshake after its script loads, jobs whose worker dies (script 404, wrong MIME, CSP/proxy blocks, thread crash, silence) are retried once in a replacement worker and then analysed inline on the main thread, so Run Analysis ends in ranked signals on every hosting environment instead of a crash banner.
- The strict research gates in `src/lib/over-under/ensemble.ts` are kept and surface as a "Verified edge" flag instead of blocking signals.
- Each tool shows the analysis-engine panel (`AnalysisEnginePanel`), the confirmation report (`ConfirmationPanel`) and the measured error bar (`PrecisionPanel`) next to the signal card, so every probability can be traced to the engines, the calibration, the replay and the research fusion that produced it.
- The precision layer is what keeps the published number honest. On a fair stream it collapses a 16-contract scan to exactly 0.0 points of edge (it used to report ~0.1); on a real edge it keeps 92% of the true magnitude rather than 77%, and it halves the error on the hard case of a small edge hidden in noise.

## Accuracy pass — level reversion, honest calibration, equilibrium entry (2026-10-23)

- **New analysis engine `level-reversion`** (`market-state.ts`): an AR(1) /
  Ornstein–Uhlenbeck fit on the quote levels themselves (`quote[t] = a + phi·quote[t−1]`),
  with a real unit-root t-test (bar −3.5, beyond Dickey–Fuller 1%), an implied
  half-life, the equilibrium, and the current displacement in stationary σ. The
  rest of the stack reads *returns*, which cannot see a market that is pulled
  back to a level while its returns look uncorrelated; this engine can.
  `levelReversionProbabilityUp(model, h)` converts the fit into a directional
  probability at any exit horizon, and a random walk (phi ≈ 1) publishes nothing.
- **The prior is graded by the recipe that ships.** `quotePriorProbability()` is
  now the single prior recipe: engine direction blend plus the level pull at the
  contract's horizon. `backtestQuotePrior()` replays that exact function, so the
  Brier skill shown in the UI describes the number on screen. Rise/Fall re-prices
  the prior at each duration's own horizon and passes it to confirmation
  (`statePriorProbability`), instead of reusing a five-tick reference number.
- **15-engine prediction panel.** `level-reversion` is a member of
  `RISE_FALL_ENGINES`, so it feeds the weighted vote, the AI meta-model's feature
  vector and the per-engine validation accuracy. Its reliability floor is set by
  its own unit-root test rather than by thirty noisy replay rows, and every
  engine's measured accuracy is now shrunk toward 50% by its sample size before
  it is turned into a weight.
- **Precision layer fix.** With fewer than three candidates τ² is unidentifiable,
  and the layer used to collapse every edge to zero — a real edge measured on a
  single duration was published as a coin flip. A small pool now falls back to a
  specified prior (sd 5 pts) **only when the analysis layer independently
  validated an edge on that market**, so flat streams still publish exactly fair
  while a genuinely measured edge survives, shrunk by its own standard error.
- **Entry: equilibrium timing.** `entry.ts` gains `analyzeLevelEntry`, which
  re-measures the model's stretch on the older 60% of replayed signals, confirms
  it on the newer 40%, and then either fires at the next tick (already stretched)
  or waits for the equilibrium level with `rebase: 'absolute'` so the level is
  never dragged along with the live quote. On planted mean-reversion streams the
  replayed win rate rises from ~62% (enter anywhere) to ~72% at one stationary σ,
  and the plan reports ~82% against ~40% out of sample.
- **Measured** (rolling walk-forward, 5-tick contracts, 5 synthetic markets × 4
  seeds × 7 points, published vs realised): mean-reverting θ=0.15 Brier skill
  0.089 → 0.135, direction hit 0.64 → 0.68; random walk and volatility-cluster
  streams stay at skill 0.000 and publish 0.500; trending streams unchanged at
  0.305. `tests/accuracy-level-reversion.test.mjs` holds the line: the fit must
  find the planted pull, match the realised frequency, and never clear its bar
  on a random walk.

## Embedded neural model (2026-10-22)

- `src/lib/neural/network.ts` is a self-contained MLP (ReLU + softmax, Adam, L2, early stopping) with a seeded PRNG — deterministic, dependency-free and worker-safe. `train.ts` owns the chronological 60/20/20 split with purging, the scaler fitted on train only, validation temperature scaling and the one-shot holdout score.
- `src/lib/neural/features.ts` builds causal vectors: 113 digit features (recent digits, gaps, hot/cold z-scores over 100/300, parity share, streaks, entropy) and 20 quote features (returns, momentum, volatility ratio, moving-average position, RSI, streaks, Bollinger position).
- `models.ts` exports `trainDigitNeuralModel`, `trainQuoteNeuralModel`, `fuseNeural` and `neuralEvidence`. Fusion is a convex combination of edges over the same `fair` baseline, capped at `NEURAL_MAX_WEIGHT = 0.25`; with weight 0 the estimate is unchanged, which is how the layer stays inert on a fair market.
- Both analyzers now expose `neural` at market level and `neural` (a `NeuralFusion`) per contract/duration, add a `neural` master source, pass `neuralEvidence` to `confidenceScore`, and note the fit (or the refusal) in `notes`.
- UI: `components/signal/neural-model-card.tsx` on every tool (live distribution, holdout accuracy vs chance, Brier skill, paired z, rows, temperature, fusion contribution, model card) and a Settings section describing the installed models, cost, licence and gating.
- Docs and tests: `docs/neural-model.md`, `tests/neural-model.test.mjs` (`pnpm --filter @workspace/deriv-signal-lab test:neural`). The model is additive: if it cannot be fitted, every existing layer runs unchanged.

## Auto for Load and Run (2026-10-22)

- The trade dock header carries an **Auto on/off** switch (`data-testid="button-bot-auto-<family>"`, persisted in `localStorage` under `signal-lab-signal-bot-auto`, default off). With Auto on, Run Analysis publishing a signal starts the bot immediately; with Auto off, Load and Run is manual again.
- The decision itself is pure and unit-tested (`src/lib/signal-bot/auto.ts → decideAutoRun`). Auto is a one-signal handoff, not a loop:
  - turning Auto on records the signal already on screen as handled, so flipping the switch never trades the analysis the user is looking at — only the next one;
  - each signal id starts the bot at most once (`handoffRunId` ref), so re-renders, dock re-mounts on tab switches and settings changes cannot open a second run;
  - a running bot is never replaced — a signal that arrives mid-run is skipped once with a reason instead of stacking a second run;
  - the same preconditions the button enforces (engine entry present, tradeable plan, connected account, valid stake) apply, and an analysis older than the bot's own staleness rule (15 min, or 3× the measured validity with a 2-minute floor) is skipped rather than handed over to be refused.
- The dock shows one line under the bot settings (`data-testid="bot-auto-note"`) explaining what Auto is doing: armed, started this signal, skipped it and why.

## Product

- Run Analysis on any tool ends in a signal; the mini bottom trade menu can trade it by hand (Trade) or automatically (Load and Run), using the stake and martingale configured on that menu.
- Load and Run is a real button, not a status label: it is enabled whenever a finished analysis produced an entry plan, a valid stake is typed and no run is in progress. The research library's evidence gates and the quoted payout only ever add advisory text to the run.
- The embedded neural model is installed, free and always trained locally; the tool page says plainly whether it validated on this market and how many probability points it moved. A fair market correctly leaves it at zero weight.
- The 300-engine research library is part of the overall analysis, not a separate report. Its validated forecast is folded into every candidate's probability, the evidence score and the entry evidence (`src/lib/engine-lab/fusion.ts`); the inspector shows the weight and the probability points it contributed.

## User preferences

- Every Run Analysis, on every tool, must start immediately across markets, show progress as a percentage and end with a signal, its confidence score and how many engines agreed — never an "Analysis blocked" / WAIT-only result.
- The signal bot reads stake, martingale and the exit limits from the mini bottom trade menu (stop loss, take profit by winning runs, take profit by realised profit) and the tick duration plus run count from the analysis; both take profit targets are optional (0 = off), either one ends the run as **Completed**, it trades one contract at a time, stops immediately on request and only offers Reset once it is idle.
- Auto is a convenience, never a default: it starts off, persists per browser, arms for the NEXT signal, never re-trades one it already handled, and never replaces a bot that is still running.
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
