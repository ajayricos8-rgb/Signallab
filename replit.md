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
- `artifacts/deriv-signal-lab/src/lib/signal-engine/market-state.ts` — layer 1: the ten measured digit forecast angles (`frequency`, `recent`, `transition`, `pattern`, `momentum`, `drift`, `reversal`, `repeat`, `spike`, `gap`), their out-of-sample weights and the shipped `digitPriorWithWeights()` recipe.
- `artifacts/deriv-signal-lab/scripts/digit-accuracy-benchmark.mjs` — ground-truth audit of the digit options: per-angle skill, the shipped recipe replayed at every out-of-sample origin, and a fair-stream neutrality check. `scripts/accuracy-benchmark.mjs` is the Rise/Fall equivalent.
- `artifacts/deriv-signal-lab/src/lib/engine-lab/fusion.ts` — layer 4: how the 300-engine research ensemble is folded into the traded probability and evidence score.
- `artifacts/deriv-signal-lab/src/components/signal-bot-provider.tsx` — shared bot state, mounted above the workspace tabs so a run survives tab switches.
- `artifacts/deriv-signal-lab/src/lib/neural/` — layer 7: the embedded, free neural model (network, causal features, chronological training + validation, fusion).
- `artifacts/deriv-signal-lab/src/components/signal/neural-model-card.tsx` — the model card, live forecast and measured skill shown on every tool.
- `artifacts/deriv-signal-lab/src/lib/forge/` — layer 8: the forged model (Deriv knowledge base + market atlas, fused causal features, distillation/residual training, gate and fusion).
- `artifacts/deriv-signal-lab/src/components/signal/forge-model-card.tsx` — the forged model's card: its reading, drive, gate, curriculum, frozen inputs and knowledge summary.

## Architecture decisions

- The four Tools tabs share one public Deriv market-data socket (`artifacts/deriv-signal-lab/src/components/market-feed-provider.tsx`) mounted above the tabs, so history survives tab switches and Run Analysis can scan every volatility index at once.
- Run Analysis fans markets out to a Web Worker pool (`src/lib/signal-engine/scan-runner.ts`). Every analysis is layered: **analysis engines** (`market-state.ts`) measure structure/regime, **prediction engines** (the 17-engine digit ensemble / 15-engine Rise/Fall panel) produce probabilities, a **confirmation layer** (`confirmation.ts`) calibrates them out of sample and checks the analysis prior, a **precision layer** (`precision.ts`) shrinks every published edge by how much of it survived out of sample and charges the winner's curse of having been ranked, the **entry layer** (`entry.ts`) measures the entry level/window on an older slice and validates it on a newer one, and a **quant + AI synthesis layer** (`ai-synthesis.ts`) folds the independent quant measurement suite (distribution, parity runs, recurrence/FFT, Hurst/RSI/MACD regime) into one verdict with a cross-window stability check. On top of all of it the **forge** (`src/lib/forge/`) fits ONE model from those layers' own replayed state — engines, AI, calculations, market knowledge and structure in a single 24-input network, distilled from the audited teachers and trained against the Deriv knowledge base — and that model is then used for the analysis, the prediction and the entry (it can confirm, trim or veto a call). Results are ranked by the master verdict, then a calibrated confidence score (`confidence.ts`), under a pool of up to eight workers.
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

## Accuracy pass — 17 engines, more workers, and a bot that aims (2026-10-23)

- **Five more digit engines** (`src/lib/over-under/extra-models.ts`), each fitted
  on the training partition only and each gated by its own tuning skill exactly
  like the original twelve: `ppm` (variable-order Markov with PPM escape and a
  Dirichlet-shrunk backoff), `dirichlet` (Dirichlet–multinomial posterior mean
  with an exponential half-life learned on training data), `hazard` (a measured
  per-digit gap hazard — how often a digit actually prints at the exit tick given
  its current age, instead of assuming an overdue digit must arrive), `spectral`
  (per-digit autocorrelation at the contract's own horizon, tested against 1/√n)
  and `kalman` (a local-level state-space filter per digit with a fitted gain,
  damped forward to the horizon). Total: **17 engines**, 8 families.
- **Family weight is now its best member, not its average.** Adding a weak engine
  to a measured family must not dilute the family's evidence; the within-family
  split still gives the weak member ~zero weight.
- **The pool itself is chosen out of sample.** Two pools are fitted with the same
  weights — linear (Σ wᵢpᵢ) and geometric (∝ Π pᵢ^wᵢ) — and the one with the
  lower tuning Brier ships, by a 0.75% margin. The choice never sees a holdout
  row, the losers are reported, and the linear pool stays the default.
- **More workers.** `defaultWorkerCount()` now uses every core but one, up to
  eight (it was capped at four), with a floor of two on any multi-core device. A
  single-core device still gets one worker; workers remain an optimisation and
  every job still falls back inline.
- **The bot has an aim** (`SignalBotConfig.objective`). `edge` (default) trades
  the published signal. `hit-rate` trades the most likely contract inside the
  same analysis whose published probability is still at or above its own fair
  rate, so it wins more often without taking a negative-expectation bet. The dock
  shows which contract it picked and why.
- **The prior's commit band is earned too.** `digitPriorLimitsFor()` turns the
  pool's own replay skill into how far it may commit: the uniform floor falls
  from 40% toward 8% and the per-digit band widens from ±12 to at most ±30
  points as measured skill rises. A stream with no measured replay skill keeps
  the exact conservative recipe (bit-identical), which is what keeps a fair
  stream at fair. Measured effect on the shipped recipe: a five-tick bias moves
  from 0.226 published / 0.263 realised (+0.037 over-confident) to 0.242 / 0.263
  (−0.022), and the reversal stream from 0.850 / 0.990 (−0.140) to 0.854 / 0.910
  (−0.056), with the fair stream unchanged at 0.300 / 0.250.
- **Ranking: a certified edge first, then the better evidence.** Among
  candidates the master refused to certify, priority differences are a fraction
  of an edge z; ordering those by the evidence score picks the digit the model
  actually favours instead of the lowest index. Measured on the 32-seed
  selection audit: 8.75 → 9.06 of the available true edge captured (the certified
  structured streams stay at 1.00).
- **Calibration guard** (`calibrationGuard`, wired into `nextRunDecision`). Every
  settled run is a Bernoulli draw from the published probability. After eight
  settled runs, three standard errors below the expected win count stops the run
  with reason `calibration` before the stake is spent proving the edge absent. It
  cannot fire before eight runs, never fires on a winning record, and is inert
  for a restored plan with no published probability.
- **Measured** (`BOT=1 node --experimental-strip-types ./scripts/digit-accuracy-benchmark.mjs`,
  settled on the real exit tick at fair odds, 5 markets × 2 seeds × 5 origins):
  aim `edge` wins 23/50 (46.0% against 46.4% fair); aim `hit-rate` wins 36/50
  (**72.0%** against 79.4% fair). More wins, not more profit: a 90% contract pays
  1.11× and one loss erases nine wins, which is why the aim is a choice and the
  rule refuses any contract priced below fair. Fifty runs is a demonstration,
  not a profitability proof.
- All 17 engines cost ~1.6 s per market on a 2,000-tick window (unchanged), and
  the scan now runs up to eight of those in parallel.

## Accuracy pass — digit options, every angle measured (2026-10-23)

- **The digit prior is now a measured ensemble, not a nudge.** `market-state.ts`
  builds ten independent forecast angles — `frequency`, `recent`, `transition`,
  `pattern`, `momentum`, `drift`, `reversal`, `repeat`, `spike`, `gap` — and
  scores each one out of sample on the tick the contract actually settles on
  (`digitPriorComponents(digits, horizon)`). Weights are the angle's own Brier
  skill versus uniform, shrunk by its sample and capped; an angle that cannot
  beat uniform carries **exactly** zero weight and a uniform floor of 40% keeps
  any single angle from taking the pool over. `digitPriorWithWeights()` is the
  single recipe: `buildDigitPrior()` (live) and the validated backtest replay
  the same function, so the skill shown is the skill of the number on screen.
- **Every conditioned angle now forecasts the exit tick, not the next tick.**
  Transitions, patterns and repeats are keyed at `index + horizon < length`
  (`transitionsAhead`, `contextForecast(digits, order, horizon)`), the repeat
  angle abstains above a one-tick contract, and momentum/reversal scale their
  evidence by the number of steps. This was a real bug: at a five-tick duration
  the whole prior used to answer a one-tick question.
- **The validated prior now reaches the published number.** `confirmation.ts`
  pools it with the calibrated ensemble **by measured skill** (skill split when
  the consensus has skill, otherwise `pairedZ/3` capped at 0.9) instead of the
  old hard ±2-point nudge, and only after the prior cleared its own held-out
  test (skill > 0.004, paired z ≥ 2). The published number is then a weighted
  mixture of two measured sources, so the move is bounded by construction and
  the reported error bar is the mixture's own sampling error.
- **The AI meta-model sees the analysis evidence.** The stacker's feature vector
  gains `priorEdge` — the prior's per-contract view over the rolling-frequency
  baseline, rebuilt at each replay row's own origin with the shipped weights, so
  no look-ahead enters the evidence. It is still gated at z ≥ 3 out of sample;
  when it does not clear that bar it carries zero weight.
- **The precision layer no longer fits τ² it cannot identify.** On a pool of 16
  correlated contracts, Cochran's Q cannot detect heterogeneity, so τ was always
  0 and every edge collapsed. `shrinkEdges(..., { correlated: true })` now uses
  the specified prior **only when an independent edge was measured**.
- **UI.** `AnalysisEnginePanel` gains a *prior composition* block: every angle
  with its support count, out-of-sample skill and the weight it earned (or
  "no weight"), plus the pooled share in the confirmation panel.
- **Measured** (`scripts/digit-accuracy-benchmark.mjs`, shipped recipe replayed
  at every out-of-sample origin, 5-tick contracts, 9 synthetic markets × 2 seeds
  × 300 origins): fair stream publishes **0.300 against a 0.300 fair rate**
  (bias +0.0000, skill 0.000, realised 0.250 → z −1.9, pure sampling noise);
  planted bias publishes 0.226 vs 0.157 fair and realises 0.263 (skill 0.051);
  momentum 0.023; reversal 0.687 (0.850 published vs 0.990 realised — the
  ±0.12 per-digit clip deliberately under-commits on near-deterministic
  streams); parity and repeat streams publish exactly fair. End to end through
  `analyzeDigitMarket` a five-tick bias publishes OVER 3 at **0.610 against
  0.600 fair**, OVER 1 at 0.807 vs 0.800, UNDER 1 at 0.099 vs 0.100.
- **Honest size.** A five-tick bias is worth about a probability point, not ten.
  The edges above are what the structure supports; nothing here claims more.

## Embedded neural model (2026-10-22)

- `src/lib/neural/network.ts` is a self-contained MLP (ReLU + softmax, Adam, L2, early stopping) with a seeded PRNG — deterministic, dependency-free and worker-safe. `train.ts` owns the chronological 60/20/20 split with purging, the scaler fitted on train only, validation temperature scaling and the one-shot holdout score.
- `src/lib/neural/features.ts` builds causal vectors: 113 digit features (recent digits, gaps, hot/cold z-scores over 100/300, parity share, streaks, entropy) and 20 quote features (returns, momentum, volatility ratio, moving-average position, RSI, streaks, Bollinger position).
- `models.ts` exports `trainDigitNeuralModel`, `trainQuoteNeuralModel`, `fuseNeural` and `neuralEvidence`. Fusion is a convex combination of edges over the same `fair` baseline, capped at `NEURAL_MAX_WEIGHT = 0.25`; with weight 0 the estimate is unchanged, which is how the layer stays inert on a fair market.
- Both analyzers now expose `neural` at market level and `neural` (a `NeuralFusion`) per contract/duration, add a `neural` master source, pass `neuralEvidence` to `confidenceScore`, and note the fit (or the refusal) in `notes`.
- UI: `components/signal/neural-model-card.tsx` on every tool (live distribution, holdout accuracy vs chance, Brier skill, paired z, rows, temperature, fusion contribution, model card) and a Settings section describing the installed models, cost, licence and gating.
- Docs and tests: `docs/neural-model.md`, `tests/neural-model.test.mjs` (`pnpm --filter @workspace/deriv-signal-lab test:neural`). The model is additive: if it cannot be fitted, every existing layer runs unchanged.

## Forged model — Layer 8 (2026-10-24)

- `src/lib/forge/knowledge.ts` is the Deriv syllabus: 72 unique lessons (61 digit / 58 Rise/Fall) across contract, payout, feed, statistics, structure, risk, execution and market knowledge, each declaring how the forge may use it (`feature`, `prior`, `teacher`, `veto`, `gate`), plus a market atlas (volatility classes and their 1HZ variants, Crash/Boom, Step, Jump) with an honest parsed fallback for unlisted symbols.
- `src/components/forge-base-workspace.tsx` + `src/lib/forge/randomness-audit.ts` — **The Base** workspace tab, model observatory, searchable curriculum/atlas and causal walk-forward randomness research panel. The research probe is not an order signal and cannot access Deriv’s internal generator state.
- `src/lib/forge/features.ts` builds ONE causal 24-input vector per replayed call from every audited layer at that origin: the family-weighted engine ensemble (edge, spread, agreement, balance, abstention), the rolling baseline, the analysis prior rebuilt at each origin, the fair rate, the horizon, the market's cadence/volatility class/family and its own structure (digit entropy, runs z, hot/cold, parity, streak; variance ratio, trend z, volatility ratio, momentum, position).
- `src/lib/forge/train.ts` trains it inside the run: chronological 50/20/30 split with a purge gap, soft targets distilled 35% from the audited teachers (shrunk toward fair), a residual link on the teacher's log-odds with the correction shrunk on validation and capped at 0.6 log-odds (switched off entirely when it does not generalise), Adam + L2 + early stopping, temperature calibration, one-shot holdout. `validated` needs ≥60 unseen rows, positive Brier and log-loss skill, and a paired z above `2 + 0.6·(√(2 ln pool) − √(2 ln 2))` — the same multiple-comparison correction the analysis engines apply.
- `src/lib/forge/forge.ts` exposes `forgeCandidate` (one fitted model with its card, metrics, live probability and drive) and `applyForge` (the fusion). Fusion is fail-closed: no model or no validation leaves the number bit-identical, a validated model confirms/trims/vetoes at ≤30% of the edge, a veto cuts the edge to 35% and marks the call contradicted (so the master cannot certify the entry), and below the gate the layer is completely inert — in a scan of dozens of candidates the expected maximum of that search is not a measurement.
- Both analyzers forge one model per candidate from their own replay rows, add a `forge` master source (correlation credit 0.55), pass `forgeEvidence` to `confidenceScore` (new `forgeTerm`, 0.07 budget, only when validated), publish `forge` per signal (`ForgeFusion`) and at market level (`ForgedModel`), and note the fit or refusal in `notes`.
- UI: `components/signal/forge-model-card.tsx` on every tool (decision badge, drive, analysis sentence, holdout metrics vs their bar, gate lines, curriculum stages, frozen inputs, knowledge summary, fusion contribution) and a Settings section describing it.
- Docs and tests: `docs/forge-model.md`, `tests/forge-model.test.mjs` (`pnpm --filter @workspace/deriv-signal-lab test:forge`, 17 tests). On fair streams the layer stays inert and the published edge stays exactly zero; the existing accuracy lock (`tests/signal-accuracy.test.mjs`) still passes.

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
