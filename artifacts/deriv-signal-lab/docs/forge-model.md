# The forged model (Layer 8)

Layers 1–7 each answer a part of the question. The forge is the layer that
learns how those parts fit together *on this market*, and then uses that one
model for the analysis, the prediction and the entry.

It is not a download, an API key or a hosted service. It is a small network
(`signal-lab-forge-v1`, 24 → 24 → 12 → 2, ≈0.9k parameters) forged from scratch
inside the app every time **Run Analysis** runs, on the market's own replayed
calls, with the Deriv knowledge base as its syllabus and the audited layers as
its teachers.

```
src/lib/forge/
  knowledge.ts   the Deriv syllabus + market atlas (the teaching material)
  features.ts    the causal vector: engines + AI + calculations + market + structure
  train.ts       distillation, residual correction, purged chronological training, gate
  forge.ts       one candidate forged, fused into the published call, evidence for the score
src/components/signal/forge-model-card.tsx   what it was taught, how it scored, what it did
tests/forge-model.test.mjs                   knowledge, causality, honesty, safety
```

## 1. The knowledge base (`knowledge.ts`)

The brief asks for the model to be fed with Deriv knowledge. That knowledge is
an explicit, versioned, auditable registry rather than a pile of constants.
Every entry states one fact and declares how the model may use it:

| Use | Meaning |
| --- | --- |
| `feature` | becomes an input the network conditions on (cadence, volatility class, market family, structure) |
| `prior` | sets the anchor and the shrinkage target (the contract's fair rate) |
| `teacher` | names an audited layer the training labels are distilled from |
| `veto` | a rule that can only remove conviction (equality loses both sides, a flat expiry loses both directions, an edge inside its own error bar is not a signal, a payout below break-even is not profit) |
| `gate` | a sample, timing or protocol condition the model must meet before it may speak (purge, minimum holdout, measured validity window, staleness) |

Coverage today (v`2026.10.27`, 61 entries for the digit family, 58 for
Rise/Fall; 72 unique lessons) spans eight domains:

- **contract** — Matches, Even/Odd, Over/Under and Rise/Fall semantics, the
  exit-tick rule, the strict (not allow-equals) contract, the digit simplex.
- **payout** — payout includes the stake, break-even is `ask / payout`,
  expected value `p × payout − ask`, the half-point margin the bot requires,
  missing proposals block execution, stake is not a signal, martingale is not a
  model.
- **feed** — verified digit precision, chronological unique ticks, tick cadence
  as the tick→wall-clock conversion, staleness, 1HZ cadence, sample maturity,
  never impute a missing digit.
- **statistics** — chronological splits, purging, overlap correction, Brier and
  log-loss skill against the *fair* rate, the paired-z bar, calibration,
  multiple comparisons, selection bias, Wilson intervals, minimum expected
  counts, "failing to reject is not proof of randomness", distillation, no
  leakage.
- **structure** — uniformity, transition independence, conditional entropy,
  parity runs, censored gap ages, Hurst/variance-ratio regimes,
  autocorrelation, volatility regime, level reversion, structural breaks, the
  flat rate.
- **risk** — an edge inside its error bar is not a signal, correlated sources
  share a vote, unvalidated models are inert, unvalidated evidence may only
  subtract, conviction is capped by the verdict, "always one signal", no
  autonomous orders.
- **execution** — measured validity windows, digit entries as a tick context,
  quote entries as replayed excursions, no chasing a missed entry, the window
  cap, re-basing rules, snapshot replacement.
- **market** — synthetic indices are generated and continuous, the index number
  is the volatility class, 1HZ ticks once per second, Crash/Boom are jump
  processes, Step indices are discrete, Jump indices mix a base move with rare
  jumps, digits start from a fair prior, markets are analysed independently and
  then ranked, the symbol names the family, there are no fundamentals to read.

`FORGE_MARKET_ATLAS` adds instrument knowledge for the volatility classes
(`R_10 … R_250`), their 1HZ variants, Crash/Boom, Step and Jump indices —
volatility class, expected cadence, which contract families they suit and a
one-line caveat. An unlisted symbol is parsed instead of guessed, and the
profile says so.

The prior half of the syllabus is applied mechanically: every forecast is
anchored on the contract's **fair rate**, and the teacher's probability is
shrunk toward that anchor by `0.05 × 60 / (60 + rows)` points before it is used
as a distillation target.

## 2. The inputs (24, frozen and labelled)

Both families share one width, so the network, the trainer, the gate and the
card are family-agnostic. Position `i` of the vector is always the same feature:

| # | Feature | Where it comes from |
| --- | --- | --- |
| 0 | bias | — |
| 1–2 | teacher edge in log-odds and in points | the family-weighted engine ensemble (digit) / the AI meta-model (quote) |
| 3 | rolling-baseline edge | rolling frequency (digit) / the no-edge rate (quote) |
| 4 | analysis-prior edge | the analysis prior rebuilt at that origin (digit) / the causal drift view (quote) |
| 5 | fair rate, centred | the contract |
| 6–9 | engine disagreement, weighted agreement, vote balance, abstention | the ensemble |
| 10 | sample maturity | rows behind the reading |
| 11 | contract horizon | the duration |
| 12 | analysis-prior skill | the analysis layer's own holdout |
| 13–15 | tick cadence, volatility class, market family | the Deriv atlas |
| 16–20 | entropy, runs z, hot/cold z, parity/momentum, streak/position | the market's own causal structure |
| 21 | edge × dispersion | interaction |
| 22 | edge × agreement | interaction |
| 23 | knowledge uncertainty | teacher sampling error × immaturity |

`digitContextAt` / `quoteContextAt` compute the structural block from ticks at or
before the origin only, which is asserted directly in
`tests/forge-model.test.mjs` (rewriting the future does not change a row).

## 3. Training (`train.ts`)

1. **Rows.** One row per replayed call: the vector, the realised outcome, and
   the audited teacher's probability for the same call at the same origin. Digit
   rows come from the same `fit.checked` replay the confirmation layer uses;
   Rise/Fall rows are the non-flat holdout replay rows, oriented toward the
   direction the consensus rule actually called.
2. **Split.** Chronological 50 / 20 / 30 with a purge gap of at least the
   contract's horizon. The holdout is the largest slice because it is the only
   one whose size buys power at the gate.
3. **Distillation.** Each label is a soft target: 65 % the realised outcome,
   35 % the teacher's probability (after the knowledge shrinkage toward fair).
   With a few hundred binary outcomes per contract, that is a variance
   reduction, not new information.
4. **Residual link.** The forged log-odds are `logit(teacher) + nudge`, where
   `nudge` is the network's own output scaled by a factor fitted on the
   validation slice and capped at 0.6 log-odds (≈14 points at even odds). If
   the correction does not earn a material validation gain it is switched off
   entirely, and the forge publishes the audited teacher unchanged — the model
   degrades to its teachers, never to a random initialisation.
5. **Fit.** Adam on soft targets, L2 weight decay, gradient clipping, early
   stopping on validation.
6. **Calibration.** One scalar temperature fitted on the validation slice only.
7. **Gate.** The holdout is scored once: accuracy against the no-edge rate,
   Brier skill, log-loss skill and a paired z. `validated` requires ≥60 unseen
   rows, positive Brier skill, positive log-loss skill, and a paired z above
   `2 + 0.6·(√(2·ln pool) − √(2·ln 2))`, where `pool` is the number of
   candidates compared in the scan (capped at 32). That is the same
   multiple-comparison correction the analysis engines apply: fitting once per
   contract in a 13-market scan is a search, and 200 fits of noise otherwise
   produce a handful of "validated" models by construction.

Everything is deterministic from `(rows, seed)`.

## 4. Fusion and the three jobs (`forge.ts`)

`applyForge` folds the forged probability into the published one and decides
what the model did:

| Situation | Decision | Effect on the published number |
| --- | --- | --- |
| no model / no weight | `inert` | bit-identical |
| validated, agreeing | `confirm` | blends the forged edge in at its earned weight, ≤0.30 |
| validated, materially lower | `trim` | blends toward the forged edge |
| validated, against the call | `veto` | cuts the edge to 35 % of its size |
| unvalidated | `inert` | nothing at all — the forge never subtracts without clearing its own gate |

A veto is what reaches the **entry**: both analyzers pass `contradicted:
… || forgeVetoed(fusion)` into `buildMasterDecision`, so a call the forged model
measured against itself cannot be certified decisive, and its entry action falls
back to `no-edge` or `speculative`.

- **Analysis** — the card prints the model's reading, its drive (0–100, the
  forged edge in units of its own sampling error, capped at 40 when
  unvalidated), the curriculum it ran, its frozen inputs and the knowledge
  summary.
- **Prediction** — one probability for the traded call, fused as above.
- **Entry** — the veto path plus its own row (`forge`) in the master decision's
  source pool, weighted by skill like every other source, with a correlation
  credit of 0.55 because it is fitted on the same rows it distils.

The confidence score gains `forgeTerm` (0.07 of the raw score, about 3 points at
full strength) and only when validated; a validated contradiction is the one
thing that can make the term negative.

## 5. What it does not do

- It does not turn a fair synthetic index into a predictable one. On fair
  streams it scores at chance, fails its gate and stays inert — asserted in the
  tests and visible on the card.
- It does not place orders. It ranks, explains, trims and vetoes; execution
  stays behind the bot switch and the live-proposal check.
- It does not claim "unlimited" knowledge in the marketing sense. The syllabus
  is large, structured, versioned and growing; it is not a guarantee, and the
  model still has to beat the fair rate out of sample before it speaks.
- It does not consume stake history, loss recovery or account state.

## 6. The Base workspace and randomness audit

The new Base workspace tab (labelled “The Base”) exposes the forge profile, the full searchable
syllabus and market atlas, the selected market's shared public feed, and a
separate one-step digit research probe (`src/lib/forge/randomness-audit.ts`).
The probe is not the trading model and never submits an order.

- It uses the latest 800 verified digits to build a smoothed first-order
  transition estimate (Dirichlet prior strength 12, anchored to the observed
  marginal distribution and ultimately uniform odds).
- A chronological prequential replay warms up on 200 ticks, predicts each later
  digit before it is revealed, and compares ten-class Brier/log-loss against a
  uniform 10% baseline. Its paired Brier z uses a Newey–West/HAC standard error
  through lag 10; the historical screen also requires at least 250 scored rows,
  positive Brier and log-loss skill, and a z bar adjusted for the number of
  scanned markets.
- The digit histogram, entropy, chi-square frequency p-value and repeat rate
  are descriptive checks. A marginal-frequency p-value is not a test of every
  possible dependence and a high p-value is not proof of randomness.
- The current top-digit distribution is labelled exploratory unless the
  historical screen passes. Even then, it is not a guarantee about the next
  output or a claim of profitable trading. The public feed provides no RNG seed
  or internal generator state, and repeated manual inspection remains a source
  of selection bias.

## 7. Tests

```sh
pnpm --filter @workspace/deriv-signal-lab test:forge
pnpm --filter @workspace/deriv-signal-lab test:forge-randomness
```

`tests/forge-model.test.mjs` pins the properties the layer is allowed to claim:
the syllabus is complete and deduplicated for both families, the atlas answers
for listed and unlisted symbols, vectors are causal and finite, the split is
chronological with a purge gap, the model learns a real structure and never
validates on noise, it is deterministic, a thin stream is refused, the fusion is
bit-identical with no model and does nothing on an unvalidated one, the weight cap
and the veto cut hold, the confidence term is gated and bounded, and both
analyzers publish the model (market level, per candidate, master source, notes)
without breaking the "always a signal" rule or inventing an edge on a fair
stream.
