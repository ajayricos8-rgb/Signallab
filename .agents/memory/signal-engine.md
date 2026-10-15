---
name: Signal engine (Tools tabs)
description: How Run Analysis produces an always-on, cross-market signal with progress, confidence and engine agreement — and the calibration rules that keep "STRONG" meaningful.
---

User requirement (all four Tools tabs — Rise/Fall, Over/Under, Even/Odd, Matches): pressing **Run Analysis** must immediately start analysing across markets, show progress as a percentage, and finish with a signal plus its confidence score and how many engines agreed. Never return a blocked / WAIT-only result; the only non-signal outcome is "no market data arrived" (network failure).

Flow: `components/market-feed-provider.tsx` (one public socket above the four tabs: `active_symbols` → per volatility index `ticks_history` 2,000 + subscribe and `contracts_for`; buffered flushes ~1 s) → `hooks/use-signal-scan.ts` (waits for data, maps progress to %, ranks, remembers the last run per tool) → `lib/signal-engine/scan-runner.ts` (Web Worker pool running `scan.worker.ts`, main-thread fallback) → `digit-signal.ts` (12-engine `fitDigitEnsemble`, shared by all digit families) or `rise-fall-signal.ts` (14 engines incl. a logistic meta-model, 25 durations) → `confidence.ts`.

**Why:** the old tools only analysed one selected market and hid every result behind strict research gates, so users saw "Analysis blocked" on practically every RNG stream.

**How to apply:**
- Keep `runOverUnderEnsemble` and its strict gates unchanged; `report.selected` now powers the "Verified edge" flag and existing tests depend on it.
- Confidence is evidence strength, not win probability. It shrinks model edges by out-of-sample skill, gates engine agreement on a material edge, discounts positive backtest z-scores by the size of the candidate pool (contracts or durations × markets), and weights backtests by sample size. It was calibrated by simulation so 13-market scans of pure noise essentially never show STRONG while structured streams score 85+. If you change weights or thresholds, re-run a null simulation (random digits / random walks) before shipping.
- Engine weights are per contract (digits: exp(30 × binary Brier skill) on the tuning window) or per duration (Rise/Fall: exp(8 × (accuracy − 0.5)) on a validation slice); Rise/Fall backtests are per direction.
- `statistical-models.ts` / `ml-models.ts` were rewritten allocation-free for speed; outputs are bit-identical to the original math. Preserve that when editing.
- `tests/signal-engine.test.mjs` and `tests/scan-runner.test.mjs` cover the layer; noise tests use a deterministic sfc32 generator.
