# The embedded neural model (Layer 7)

Signal Lab ships with a neural network that is trained **inside the app**, on the
market's own feed, every time **Run Analysis** runs. It is free in the only sense
that matters here: no API key, no account, no download, no per-call bill, and no
tick ever leaves the browser. It is not a hosted "AI" service and it is not a
pretrained model fetched from a model hub.

Two instances of the same architecture family run:

| Model | Task | Shape | Parameters | Feeds |
| --- | --- | --- | --- | --- |
| `signal-net-digit-v1` | Next digit (10 classes) | 113 → 24 → 12 → 10 | ≈ 3.2k | Over/Under, Even/Odd, Matches |
| `signal-net-quote-v1` | Direction of the horizon's move (2 classes) | 20 → 24 → 12 → 2 | ≈ 0.8k | Rise/Fall |

The code lives in `src/lib/neural/`:

- `network.ts` — the network itself: dense ReLU layers, a softmax head, softmax
  cross-entropy, L2 weight decay, mini-batch Adam with gradient clipping and
  early stopping. Seeded PRNG only: no `Math.random`, no wall clock, so a run is
  reproducible from its seed.
- `features.ts` — causal feature builders. Every vector is computed from ticks at
  or before the tick it predicts.
- `train.ts` — the chronological split, purging, temperature calibration,
  out-of-sample scoring and the weight rule.
- `models.ts` — the two model definitions, their live forecasts, the fusion into
  the published probability, and the evidence handed to the confidence score.

## Why train locally instead of downloading a model

A general-purpose pretrained model knows nothing about this feed, and the only
"pretrained" signal models on offer for synthetic indices are unverifiable. A
model fitted here can be validated honestly on a slice of the same market it is
used on, and its provenance is fully auditable: the card on the tool page lists
the architecture, parameter count, seed, epochs, temperature and holdout score.
The weights are generated at runtime, so there is no third-party licence or
telemetry involved; the code is MIT-licensed like the rest of the app.

## Features (all causal)

**Digit net (113 inputs).** One-hot of the last 8 digits (80); gap since each
digit last appeared, capped at 50 ticks (10); hot/cold z-scores over the last 100
digits (10) and 300 digits (10); parity share over the last 50, signed around a
fair half (1); signed parity streak length (1); normalised digit entropy over the
last 100 (1).

**Quote net (20 inputs).** The last five returns scaled by local volatility (5);
their signs (5); price position against the 10/25/60-tick moving averages (3);
short/long volatility ratio (1); share of up moves in the last 20 (1); signed
run of consecutive moves (1); RSI(14) centred on 50 (1); mean recent return in
standard errors (1); Bollinger position (1).

## Training and validation protocol

1. Rows are built in time order. Digit rows use `features(i) → digit(i+1)`;
   quote rows use `features(i) → sign(price(exit(i)) − price(i))`, where
   `exit(i)` is the same tick the horizon's contract settles on.
2. The rows are split **60 / 20 / 20** chronologically with a purge gap
   (12 rows for digits, at least the horizon for quotes), so overlapping feature
   windows and future labels cannot leak across a boundary.
3. The scaler is fitted on the training slice only and applied to every other
   slice. Weights are fitted on the training slice; early stopping and the
   softmax temperature are fitted on the validation slice.
4. The holdout slice is scored **once**, against the same no-edge baseline the
   contracts are priced on: a uniform 10% distribution for digits, a coin flip
   for direction. Reported: accuracy, Brier skill, log-loss skill and a paired
   z-score of the per-row Brier improvement.
5. `validated` is true only when the Brier skill is positive, the log-loss skill
   is positive, and the paired z is at least **2** on at least **60** unseen
   rows.

## How it participates

- **Probability.** `fuseNeural` blends the model's probability for the traded
  outcome into the published one as a weighted second opinion over the same fair
  baseline: `fair + (1 − w)·(published − fair) + w·(model − fair)`, with `w`
  capped at **0.25**. With `w = 0` the published number is bit-identical, so an
  unvalidated or unavailable model is provably inert. `w` grows with measured
  skill, the holdout sample and the log-loss improvement.
- **Master decision.** The model appears as its own row (`Neural`) in the
  decision's source table, weighted by skill like every other source, so it is
  part of the pool rather than a report next to it.
- **Confidence score.** A validated model contributes at most a few points
  (`0.05 × neuralTerm`); an unvalidated one contributes exactly zero.
- **Notes and UI.** The `Layer 7 · free embedded neural model` card on every tool
  shows the live distribution (digit bars or the rise/fall split), the measured
  hit rate against chance, Brier skill, paired z, row counts, temperature and the
  full model card, plus what the model did to *this* signal: its own view, the
  fair probability, its weight and the probability points it moved.

## Performance and failure behaviour

- The digit net trains on at most 2,600 ticks of history with at most 640
  training rows, 224 validation rows and 448 holdout rows; the quote net trains
  per horizon on the same caps. Both fit in a few hundred milliseconds and run
  inside the existing analysis Web Workers.
- If the stream is too short (fewer than 200 supervised rows after the feature
  warm-up) the layer simply returns nothing: every other layer behaves exactly
  as before, and the tool page shows no neural card.
- Nothing about a run depends on the network's presence, so a worker crash or a
  disabled layer cannot turn Run Analysis into an error.

## What it does not do

It does not turn a fair synthetic index into a predictable one. On a fair stream
the network typically measures at chance, fails its gate and stays silent — that
is the intended result, and it is stated plainly on the card. A high confidence
score is evidence, never a guarantee, and no model in this app places an order
on its own.

## Tests

```sh
pnpm --filter @workspace/deriv-signal-lab test:neural
```

`tests/neural-model.test.mjs` pins the properties the layer is allowed to claim:
determinism, causality (no feature sees the tick it predicts), silence at chance
on a fair stream, validation and weight on a structured stream, the fusion
bounds, the confidence term's gating, the quote net on a cyclical market versus
a random walk, and that the digit tools publish the layer without changing the
"always a signal" rule.
