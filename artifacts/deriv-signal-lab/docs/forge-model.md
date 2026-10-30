# The forged model (Layer 8)

Layers 1–7 each answer a part of the question. The forge is the layer that
learns how those parts fit together *on this market*, and then uses that one
model for the analysis, the prediction and the entry.

It is not a download, an API key or a hosted service. It is a small network
(`signal-lab-forge-v1`, 31 → 24 → 12 → 2, 1,094 parameters) forged from scratch
inside the app every time **Run Analysis** runs. In each Tools view Forge is the
primary signal model: it consumes the engine, AI, research and neural views plus
their causal calculations, trained separately for the selected contract and
horizon on the market's replayed calls. Its own probability (“Forge view”) and
the final probability after fusion (“published after Forge”) are shown
separately. The Deriv knowledge base is its syllabus, and only forecasts that
were out of sample for their source model are admitted to its row inputs.

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
  share a vote, unvalidated Forge/neural models are inert, the research layer's
  independent unvalidated forecast may only subtract, conviction is capped by
  the verdict, "always one signal", no
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

## 2. The inputs (31, frozen and labelled)

Both families share one width, so the network, the trainer, the gate and the
card are family-agnostic. Position `i` of the vector is always the same feature:

| # | Feature | Where it comes from |
| --- | --- | --- |
| 0 | bias | — |
| 1–2 | teacher edge in log-odds and in points | family-weighted engine/AI teacher |
| 3 | rolling-baseline edge | rolling frequency (digit) / causal no-edge baseline (quote) |
| 4 | analysis-prior edge | prior rebuilt at this origin (digit) / causal drift view (quote) |
| 5 | fair rate, centred | the contract |
| 6–9 | engine disagreement, weighted agreement, vote balance, abstention | the ensemble |
| 10 | sample maturity | rows known by the replay origin |
| 11 | contract horizon | the selected duration |
| 12 | analysis-prior skill | neutral zero in current causal rows; whole-stream skill is never copied into historical rows |
| 13–15 | tick cadence, volatility class, market family | the Deriv atlas |
| 16–20 | entropy, runs z, hot/cold z, parity/momentum, streak/position | the market's causal structure |
| 21–23 | edge × dispersion, edge × agreement, knowledge uncertainty | interactions and teacher sampling error × immaturity |
| 24–25 | AI edge and AI-available mask | an earlier-phase AI model replayed forward; absent values remain masked |
| 26–27 | independent research edge and replay-available mask | calibrated forecast at the exact holdout origin and selected horizon |
| 28–29 | neural edge and holdout-available mask | prediction from that model's untouched, horizon-matched holdout; source offsets are restored before matching |
| 30 | edge relative to sampling noise | measured teacher edge and sample maturity |

The three external probabilities are not filled forward or matched by array
position. Digit replay uses the exact tick origin/epoch and contract horizon;
Rise/Fall uses the exact tick origin and duration. Research replay rows are
requested from the untouched later holdout, using weights fitted on tuning and
calibration performed only on its earlier calibration slice. Neural rows retain
their original tick origins through scaling and sampling; quote labels carry
their actual settlement tick so variable-duration rows that cross a split
boundary are purged. If a source has no eligible forecast at an origin, its
edge is zero with an availability mask of zero.

`digitContextAt` / `quoteContextAt` compute the structural block from ticks at or
before the origin only. Tests rewrite the future and verify that an origin's
forecast is unchanged, that the research and neural replay origins stay
aligned, and that internal research replay rows are omitted from public reports.

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
| validated, agreeing | `confirm` | blends the forged edge in at its earned weight, ≤0.30; this can move the published probability upward |
| validated, materially lower | `trim` | blends toward the forged edge |
| validated, against the call | `veto` | the fused edge is cut to 35 % of its size and the master decision hard-blocks entry |
| unvalidated | `inert` | no probability movement in either direction; the Forge gate is unchanged |

The UI labels the model's probability as **Forge view** and the post-fusion
probability as **published after Forge**. A validated veto is passed through
`forgeVetoed(fusion)` to `buildMasterDecision`; this is a hard `NO_EDGE` with
`entry.action = no-edge`, not a speculative fallback. The Auto runner, manual
Load and Run action, and bot start hook all reject that master-vetoed plan.
No Forge decision bypasses the existing proposal, live-payout or execution
checks.

- **Analysis** — the first card in each Tools summary stack prints the model's
  reading, its drive (0–100, the forged edge in units of its own sampling error,
  capped at 40 when unvalidated), the curriculum, frozen inputs and knowledge
  summary. If the training/holdout gates are not met, a fail-closed Forge card
  remains visible and explains that the upstream estimate was not changed.
- **Prediction** — the card separately reports Forge's own view and the
  probability published after Forge fusion; the latter is the value carried by
  the signal and entry plan.
- **Entry** — the Forge evidence travels into persisted entry provenance and the
  master decision's source pool, with correlation credit of 0.55 because Forge
  is fitted on rows that include its teachers. A veto produces the hard master
  block described above. Actual execution still requires the existing live
  proposal and payout checks; syllabus knowledge is not invented as a live quote.

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

The Base section at the bottom of Settings exposes the forge profile, the full searchable
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
