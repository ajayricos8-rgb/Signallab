---
name: Forged model (layer 8)
description: How the engines, AI layers and calculations become ONE trained model, what it is fed, and the rules that stop it from manufacturing an edge.
---

`src/lib/forge/` is one model, not another report. `forgeCandidate` fits a 24 → 24 → 12 → 2 network
(≈0.9k params) per candidate, inside the run, on that candidate's replayed rows; `applyForge` folds
its probability into the number the tool publishes and decides `inert | confirm | trim | veto`.

- **Knowledge is data.** `knowledge.ts` holds a versioned syllabus (`FORGE_KNOWLEDGE_VERSION`) of
  69 digit / 55 Rise/Fall entries in eight domains, each tagged `feature | prior | teacher | veto |
  gate`, plus `FORGE_MARKET_ATLAS` (volatility classes, 1HZ variants, Crash/Boom, Step, Jump) with a
  parsed fallback for unlisted symbols. Adding knowledge = adding a row; nothing else needs to change.
- **Inputs are the other layers.** The vector carries the family-weighted ensemble edge (teacher), the
  rolling baseline, the analysis prior (rebuilt at each origin for digits; the causal drift view for
  quotes), spread/agreement/balance/abstention, sample maturity, horizon, cadence, volatility class,
  market family and the market's own causal structure. `digitForgeVector` / `quoteForgeVector` are
  causal by construction and the test asserts that rewriting the future cannot change a row.
- **Training is residual + distilled.** Labels are 65 % outcome / 35 % teacher, and the forged log-odds
  are `logit(teacher) + nudge` with the nudge scaled on validation and capped at 0.6 log-odds. If the
  correction does not earn a material validation gain the scale is set to 0, so the model degrades to
  its teachers, never to a random init. Split 50/20/30 with a purge gap of at least the horizon.
- **The gate is selection-aware.** `validated` needs ≥60 holdout rows, positive Brier and log-loss
  skill, and a paired z above `2 + 0.6·(√(2 ln pool) − √(2 ln 2))`, pool = candidates compared
  (capped 32). Without that correction, 200 fits of noise on a 13-market scan validate by construction.
- **Asymmetry.** No model / no validation → bit-identical number (`inert`). Validated → confirm/trim/
  veto at ≤30 % of the edge; a veto cuts the edge to 35 % and is passed to `buildMasterDecision` as
  `contradicted`, which is how the model reaches the ENTRY. Unvalidated but with measured z ≥ 2 and a
  materially lower view → may subtract at ≤15 %, never add.
- **Score.** `forgeEvidence` feeds `confidenceScore`'s `forgeTerm` (0.07 budget, only when validated,
  negative on a validated contradiction). The master decision lists `forge` as a source with a 0.55
  family credit because it is fitted on the same rows it distils.

**Why:** the user asked for the engines, AI and calculations to be forged into one trained model fed
with Deriv knowledge, then used for analysis, prediction and entry. The design keeps that honest: the
"vast knowledge" is a syllabus the model is trained against, and the fusion rules mean an unvalidated
forge can never raise a probability or a confidence score.

**How to apply:**
- Analyzers build rows from their own replay slice (`fit.checked` for digits, non-flat `setC` rows for
  Rise/Fall, oriented to the direction the consensus called) and call `forgeCandidate` with the live
  vector plus `liveTeacherProbability` and `selectionPool`.
- Fuse with `applyForge` **last** (after the neural layer), then re-sync `confirmation.probability`,
  `edgePts`, and for Rise/Fall `winProbability` / `probabilityRise`, because tests assert they agree.
- Adding a feature means bumping `FORGE_FEATURE_COUNT`, adding the labelled entry in `FORGE_FEATURES`,
  filling it in `commonVector`, and re-running `pnpm --filter @workspace/deriv-signal-lab test:forge`.
- The fair-stream lock (`tests/signal-accuracy.test.mjs`) is the tripwire: if the forge ever invents an
  edge on a uniform stream, that test fails with the worst |edge| printed.
