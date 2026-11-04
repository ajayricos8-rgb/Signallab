---
name: Research library fusion (layer 4)
description: How the 300-engine research ensemble is folded into the traded signal, and why unvalidated research can only lower it.
---

The 300-entry library is not a side report. `src/lib/engine-lab/fusion.ts` (`fuseResearch`) folds every
candidate's research audit into the probability the tools rank, confirm, plan an entry for and trade,
and `researchTerm` in `src/lib/signal-engine/confidence.ts` folds it into the evidence score.

Rules, in order:

1. Edges are compared over the same no-edge rate: `baseEdge = probability − fair` (post-confirmation),
   `researchEdge = audit.probability − audit.fair`.
2. **Validated** ensemble (`audit.validated`): weight `clamp(0.35 × sampleFactor × skillFactor, 0.05, 0.35)`
   and it may move the estimate either way. `sampleFactor = clamp(holdout/200, 0.25, 1)`,
   `skillFactor = clamp(4 × max(0, holdout Brier skill), 0.1, 1)`.
3. **Unvalidated** ensemble: weight `0` unless its estimate is materially lower
   (`researchEdge < baseEdge − max(0.005, 0.01 × fair)`), then at most `0.15 × sampleFactor` — only downwards.
4. The blend is a convex combination of the two edges, so the result always stays inside the range the two
   estimates already spanned.
5. `researchTerm` mirrors it: agreement sets the sign, tanh(12 × skill) × sample/(sample+60) the size, and
   an unvalidated ensemble is clamped to `min(0, …)`. `confidenceScore` only changes when `research` is
   passed, so older callers stay bit-identical.
6. A missing, non-finite or model-less audit returns the base estimate untouched (fail closed, not fail open).

**Why:** the user asked for the research engines to be used for the overall analysis, not only research.
The asymmetry is what keeps that honest — the audit has its own chronological tuning/calibration/holdout
phases, so only an ensemble that survived its own holdout is allowed to add to a signal. The practical
effect is also a selection-bias correction: the winning candidate in a 13-market scan is the one whose
base estimate is highest by selection, and the independent research estimate pulls it back.

**How to apply:**
- Both analyzers call it the same way: `decideResearch` (master guard, 75% edge cut on a validated
  contradiction) runs first, then `fuseResearch`, then the confirmation object is re-synced
  (`probability`, `edgePts`, and for Rise/Fall `winProbability` / `probabilityRise`) because tests assert
  `confirmation.probability === signal.probability`.
- `EngineLabReport.fusion` mirrors the winning candidate's fusion (`assertFiniteTree` covers the exported
  JSON), and `components/signal/engine-lab-panel.tsx` prints the weight and points contributed.
- Noise never validates, so on the seeded null streams the fusion can only leave an estimate alone or lower
  it — `tests/engine-lab.test.mjs` asserts zero boosts across ten seeds.
