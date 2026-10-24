---
name: Signal engine (Tools tabs)
description: How Run Analysis produces an always-on, cross-market signal with progress, confidence and engine agreement — and the calibration rules that keep "STRONG" meaningful.
---

User requirement (all four Tools tabs — Rise/Fall, Over/Under, Even/Odd, Matches): pressing **Run Analysis** must immediately start analysing across markets, show progress as a percentage, and finish with a signal plus its confidence score and how many engines agreed. Never return a blocked / WAIT-only result; the only non-signal outcome is "no market data arrived" (network failure).

Flow: `components/market-feed-provider.tsx` (one public socket above the whole workspace: `active_symbols` → per volatility index `ticks_history` 2,000 + subscribe and `contracts_for`; buffered flushes ~1 s) → `hooks/use-signal-scan.ts` (waits for data, maps progress to %, ranks, remembers the last run per tool) → `lib/signal-engine/scan-runner.ts` (Web Worker pool running `scan.worker.ts`, main-thread fallback) → `digit-signal.ts` (12-engine `fitDigitEnsemble`, shared by all digit families) or `rise-fall-signal.ts` (14 engines incl. a logistic meta-model, 25 durations) → `confidence.ts` → `entry.ts` (the entry point/entry time every signal ships with, shown by `components/signal/entry-plan-card.tsx`).

## Four layers (kept separate on purpose)

1. **Analysis** — `lib/signal-engine/market-state.ts`, pure and worker-safe. `analyzeDigitState` runs 9 engines (uniformity χ², Markov transition independence, conditional entropy, parity runs, Ljung–Box periodicity, Bonferroni-corrected hot/cold drift, recurring context patterns, structural break, gap hazard). `analyzeQuoteState` runs 11 (return-drift t-test and OLS trend, ADX, efficiency ratio 100/300, Hurst exponent, variance-ratio z, Ljung–Box, runs test, AR(1) half-life, ATR volatility regime, CUSUM break, tick cadence). Only material effects that pass a Bonferroni-corrected test contribute to `predictability`; descriptive measures (efficiency, ADX, volatility) may shape the regime and direction but never the significance claim. Synthetic check: iid digits and random walks report `predictability ≈ 0`, `prior: null`; a 0.06/tick drift reports `trending-up`/`trending-down`.
2. **Prediction** — the existing 12-engine digit ensemble and 14-engine / 25-duration Rise/Fall panel. Their weights and strict research gates are unchanged.
3. **Confirmation** — `confirmation.ts`. `confirmDigitContract` / `confirmRiseFall` fit isotonic and Platt calibration on the older half of the holdout and score on the newer half; a small logistic stack is accepted only when it beats its base on unseen rows; the analysis prior can move the probability by at most 2 points. Calibration only counts as confirmation when the underlying model's independent Brier skill is positive and the held-out backtest clears the best-of-pool bar (selection penalty on its z). Unconfirmed probabilities are shrunk 65% of the way back to fair, so a recalibrated overconfident model cannot manufacture an edge. Statuses: `confirmed | adjusted | cautious | contradicted`; `decisive` needs a remaining edge and confirmed evidence.
4. **Entry** — `entry.ts`. Quote plans choose the depth and window on the older 60% of replayed signals (a grid of shallow-to-deep percentiles), then require the *newer 40%* to independently show the same win-rate gain, reach and sample. Plans carry `EntryValidation` (phase `out-of-sample`/`in-sample`, gain, reach, rate), a `tolerance` no-chase band measured from the replay's overshoots, and a `fill` mode. `evaluateEntry` returns `missed` when the quote gaps past the level by more than the tolerance. Digit context plans already select on the older 60% and validate on the newer 40%; they now report the same `validation` block.

Entry layer (`lib/signal-engine/entry.ts`, pure and worker-safe): every signal carries an `EntryPlan` — mode (`immediate` | `pullback` | `breakout` | `context`), the entry point (a quote level, or the digit context for the digit families), the entry time (window in ticks, median ticks and median wall-clock wait), the reach rate, the measured win-rate change and its out-of-sample validation. Quote plans replay the holdout signals, choose the level/window on the older 60% and score the whole policy on the newer 40% — "wait for the level, else buy when the window closes" against "buy every signal at once" — so a level only earns `measured: true` when waiting beat not waiting on both slices. Digit plans select the tick context on the older 60% of ticks and only keep it when the lift holds on the newer 40% with its own z-test; `tests/signal-entry.test.mjs` re-checks the calibration on noise streams.

**The research library is part of the analysis (layer 4).** `fuseResearch` (`lib/engine-lab/fusion.ts`) blends each candidate's validated research ensemble into the probability and `researchTerm` into the evidence score; unvalidated research can only lower either. See `engine-lab-fusion.md`.

**Layer 5: quant engines + AI synthesis (2026-10-19).** `lib/signal-engine/ai-synthesis.ts` runs the independent quant suite (`lib/quant/over-under|even-odd|matches|rise-fall`) on the same validated stream and synthesises one rule-based verdict (`lib/quant/ai-insights.ts`) plus a cross-window stability check (100/250/500/1000/2000-tick windows must agree on the bias/regime direction). Every scan result carries `aiSynthesis` and every tool shows it via `AiSynthesisCard` in `components/signal/signal-ui.tsx`. It is explanatory only: it never mutates calibrated probabilities, confidence or strength — accuracy stays with layers 1–4.

**Workers are an optimisation, never a dependency (2026-10-19).** `scan-runner.ts` handshakes every worker (`{handshake:true}` → `{type:'pong'}` in `scan-protocol.ts` / `scan.worker.ts`) because a worker *script* that 404s, comes back with the wrong MIME, is blocked by CSP/proxy rules or dies mid-job fires `Worker.onerror` with an **empty message** — the old code turned that into per-job failures and the "The analysis worker crashed." banner with no signal. Now: a faulty worker is retired, its job is retried once in a replacement worker, and a job that loses two workers (or a pool with no live worker left) is analysed inline on the main thread (`pumpInline`). `tests/scan-runner.test.mjs` covers never-loads, crash-once and silent workers; the full suite is 284 tests.

**An entry can only come out of an analysis.** Both analyzers require a `signal` context (engines agreeing/total, the analysis's probability for the traded outcome, the raw AI probability) and copy it into `EntryPlan.evidence`, so every plan names the run that produced it. Two rules follow, and both are load-bearing:
- A wait is only ever planned for something the replay measured: `isEntryPlan` requires `measured === (trigger !== 'immediate')`, so "wait for this, but nobody measured it" is not a plan the bot accepts. A level that is reached often but adds no win rate is explained in the `immediate` plan's text, never traded.
- A signal the analysis itself rates below the contract's no-edge rate is never timed (`analysisRejection`), because timing cannot rescue a trade with no edge.
Nothing else may build an `EntryPlan`: the dock refuses to enable Load and Run without `isEntryPlan(analysis.entry)` (telling the user to run the analysis again) and `hooks/use-signal-bot.ts` re-checks before the first purchase.

**Why:** the old tools only analysed one selected market and hid every result behind strict research gates, so users saw "Analysis blocked" on practically every RNG stream.

**How to apply:**
- Keep `runOverUnderEnsemble` and its strict gates unchanged; `report.selected` now powers the "Verified edge" flag and existing tests depend on it.
- Confidence is evidence strength, not win probability. It shrinks model edges by out-of-sample skill, gates engine agreement on a material edge, discounts positive backtest z-scores by the size of the candidate pool (contracts or durations × markets), and weights backtests by sample size. It was calibrated by simulation so 13-market scans of pure noise essentially never show STRONG while structured streams score 85+. If you change weights or thresholds, re-run a null simulation (random digits / random walks) before shipping.
- Engine weights are per contract (digits: exp(30 × binary Brier skill) on the tuning window) or per duration (Rise/Fall: exp(8 × (accuracy − 0.5)) on a validation slice); Rise/Fall backtests are per direction.
- `statistical-models.ts` / `ml-models.ts` were rewritten allocation-free for speed; outputs are bit-identical to the original math. Preserve that when editing.
- `tests/signal-engine.test.mjs`, `tests/signal-entry.test.mjs` and `tests/scan-runner.test.mjs` cover the layer; noise tests use a deterministic sfc32 generator.
- Entry timing is calibrated the same way as confidence: on random-walk and random-digit streams the gates (`ENTRY_LIMITS.minEdgePts` / `minReach` / `minSample` / `minValidationSample`, `CONTEXT_*` for digits) essentially never offer a trigger, because a signal with no timing edge must say "enter at the next tick" rather than invent a level. If you change those thresholds, re-run a null simulation (random walks / random digits) before shipping, exactly as with the confidence weights.
- The analysis state is computed once per market (not per duration/contract) and exposed as `state` / `analysisEngineCount`; each prediction carries only its own `deep.confirmation`. Do not duplicate the state per horizon or per contract — it bloats worker messages.
- Confidence must keep the confirmation term optional: `confidenceScore({ confirmation })` adds at most a few points, and every existing caller without it stays bit-identical.
- The bot now refuses an analysis older than 15 minutes and does not act on a feed tick older than 5 s (`ENTRY_STALE_AFTER_MS` / `MAX_ANALYSIS_AGE_MS` in `hooks/use-signal-bot.ts`). A gapped entry resolves as `missed` and follows the Entry setting (market or skip), never chases the level.
- UI: `components/signal/signal-ui.tsx` exports `AnalysisEnginePanel` and `ConfirmationPanel`; both are rendered on the Rise/Fall and all digit tools. `components/signal/entry-plan-card.tsx` prints the validation phase and the no-chase band.
- Tests: `tests/signal-engine.test.mjs` (23) covers the analysis null/structured cases, confirmation bounds and precise entry; `tests/signal-entry.test.mjs` (25) covers the walk-forward entry; the full suite is 284 tests and must stay green.

---

## Layer 4: precision — the measured error bar (2026-10-19)

A fifth layer sits between confirmation (layer 3) and entry. New files:
`lib/signal-engine/precision.ts`, `recalibration.ts`, `stacking.ts`. Both
`digit-signal.ts` and `rise-fall-signal.ts` now build every candidate as a
**draft** first, fit one pool-wide shrinkage across the whole candidate set,
then publish and re-rank.

**What it does:**

1. `heterogeneity(candidates)` — DerSimonian–Laird Q test on the pool's edges
   with a Wilson–Hilferty 90th percentile bar. `Q > df` means one candidate is
   genuinely different from the rest, not just the luckiest.
2. `shrinkEdges` — empirical-Bayes shrinkage `τ²/(τ²+SE²)` using a **trimmed**
   random-effects τ² (the middle 60% of candidates fit τ²; one real edge does
   not inflate τ² for everyone). A candidate is a **standout** only when
   `z ≥ standoutThreshold(count) = max(2.5, Φ⁻¹(1−(1−0.95^(1/count))/2))`,
   a Šidák-corrected bar that grows with the pool.
3. Winner's curse — the winner is charged `min(0.35·|edge|, 0.6·√(2 ln m)·SE)`
   **only if it is not a standout**, then re-ranked, so a candidate whose whole
   lead was selection luck loses the top slot.
4. `confidence.ts` gains `+0.08 · tanh((|edge| − SE)/(1.5·SE))` (SE floor
   0.002) via `PrecisionEvidence {edge, standardError, intervalHalfWidth}`.
5. `recalibration.ts` improves the calibration machinery Purge-aware
   walk-forward CV folds (gap = the longest forecast horizon), a pooled
   noise-subtracted `miscalibration` in probability units (raw reliability is
   inflated by each bin's own sampling noise — enough to make a perfectly
   calibrated model look 7 points off), and a Murphy(1973) decomposition that
   closes to machine precision via
   `withinBinResidual = Var(f|bin) − 2·Cov(f,y|bin)`.

**Measured effect** (24 seeded digit runs × 2,000 ticks; 16 Rise/Fall runs;
`tests/signal-accuracy.test.mjs` is the regression lock):

| Ground truth | Before | After |
|---|---|---|
| Digit, fair stream | 0.0012 MAE | **0.0000** MAE |
| Digit, large real edge | 0.0186 MAE | 0.0187 MAE |
| Digit, small real edge | 0.0320 MAE | **0.0161** MAE |
| Digit, share of true edge captured | 77% | **92%** |
| Rise/Fall, random walk | 0.0027 MAE | **0.0000** MAE |
| Rise/Fall, drift (0.06/tick) | 0.0484 MAE | 0.0494 MAE |

**Hard-won rules — do not undo these:**

- **Never compound two shrinkages on the same number.** Three layers each
  rescaling the edge (Platt `ak` × 0.75, `aiTrust` pre-shrink, 0.35 unconfirmed
  shrink) multiplied to 0.20 and threw away 80% of every real edge. Shrinkage
  must be *measured*, not *applied*: the only surviving mechanism is the one
  empirical-Bayes factor, and it is reported as `precision.shrinkFactor`.
- **Degenerate models must collapse, not survive.** A 12-engine pool trained on
  a locked base rate (e.g. `MATCHES 1`) produces a near-constant forecast, so
  every bin has the same probability and Platt/isotonic fits are unidentifiable.
  Guard: if `sharpness` is tiny relative to the forecast spread, return the
  identity calibrator. Without it the old code invented 12-point swings on a
  model that had said the same thing 400 times.
- **Calibrate with CV, but select the strength with the one-SE rule.** A plain
  CV minimum is a badly biased selector for ridge strength; pick the smallest
  λ within one standard error of the best.
- **`residualMiscalibration` must be noise-subtracted *and* pooled.** Per-bin
  `max(0, gap − noise)` leaves ~half the noise as a positive floor. It is also
  only charged to a model that has *not* proven itself out of sample
  (`validationZ < 2`); a model that beat the no-edge rate on held-out rows has
  already disproven the miscalibration it is being charged.
- **The reliability report must always be returned**, even when no calibrator
  could be fitted (few evaluation rows). Too few rows to fit a calibrator is
  never too few rows to measure one.
- **`edgeShrinkage`'s floor of 0.3 is what disciplines an anti-skilled model.**
  At 0.95 a Rise/Fall run with `validationZ = −3.37` still published 0.7331.
  Raising the floor costs ~0.018 MAE on drifting Rise/Fall; do not raise it.
- Do not patch `reliabilityReport` incrementally — two in-place edits corrupted
  it. Regenerate the whole function.

**UI:** `components/signal/signal-ui.tsx` exports `PrecisionPanel` (renders the
95% interval against the fair-odds marker, edge kept, sample, std error, pool
size, edge z, calibration error and the winner's-curse charge). Both tools show
it after `ConfirmationPanel`, and both signal cards carry a `95% range` metric.

**Tests:** `tests/signal-calibration.test.mjs` (18) covers the recalibration
machinery; `tests/signal-accuracy.test.mjs` (7) is the end-to-end ground-truth
audit whose thresholds are the measured numbers above with a small margin. Full
suite: **309 tests**.
