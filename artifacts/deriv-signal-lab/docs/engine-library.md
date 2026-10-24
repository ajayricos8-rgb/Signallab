# Signal Lab: the 300-engine research library

Research and implementation review: **18 October 2026**.

## What was added

All 300 requested names have stable IDs, explicit operational definitions, source references and runtime readings. The same library is integrated into **Rise/Fall, Over/Under, Even/Odd and Matches**, through the existing scan workers and main-thread fallback.

This is **not 300 independent prediction models**. The list mixes descriptive measurements, related features, predictions, validation, accounting and execution policies. Two exact repeated names are explicit aliases: **#166 → #23** (Volatility Regime) and **#228 → #28** (Signal Stability). Related entries also share model-family budgets instead of adding votes.

The existing 12 digit / 14 Rise/Fall predictors, strict research gates, cross-market progress and ranked signals remain. The new library adds a **10-model digit / 12-model quote forecast audit**, a searchable inspector, exportable JSON, actual-settlement performance metrics and execution advice. The audit is no longer only a side report: its validated forecast is **folded into the probability, confidence and entry every tool trades** (see “Layer 4”). Unvalidated research estimates still **cannot raise the main signal's probability or confidence**.

Terms such as “barrier pressure,” “exhaustion,” “liquidity sweep,” “market-adaptive” and “master synthesis” are not standardized statistical algorithms. Their formulas here are explicitly **application-defined measurements or policies**. They are not claims that an externally validated proprietary engine exists under each name. The complete numbered definitions are in [engine-catalog.md](engine-catalog.md), generated from the same registry as the UI.

## Research basis and design decisions

- **Randomness and dependence:** NIST's runs-test formulation requires a dichotomous sequence, with more than ten observations in each class for the normal approximation. The library abstains rather than declaring an all-one-class series “random.” A failure to reject a null is not proof of randomness. [5](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35d.htm)
- **Uniformity:** chi-square is a binned-distribution diagnostic requiring sufficient expected counts. Ten-digit uniformity is tested only with at least 50 observations; transition independence removes empty margins and requires every retained expected cell to be at least five. A quote-return histogram is **not** tested against a uniform-digit null. [4](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35f.htm)
- **Serial structure:** autocorrelation can reveal time dependence; it does not itself establish forecast accuracy or profitable contract economics. [14](https://www.itl.nist.gov/div898/handbook/eda/section3/autocopl.htm)
- **Statistical summaries:** the library distinguishes categorical mass, continuous return density, sample variance, biased moment skewness and excess kurtosis. A constant series has undefined standardized moments/density, not an infinite signal. [1](https://docs.scipy.org/doc/scipy/reference/stats.html)
- **Technical indicators:** RSI-14, MACD 12/26/9, ROC, stochastic, CCI and Williams %R use explicit periods and input units. Technical-indicator definitions are measurements, not evidence of profitable predictions on a random market. [1](https://ta-lib.github.io/ta-lib-python/func_groups/momentum_indicators.html)
- **Stationarity:** #217 implements a level-KPSS diagnostic with Bartlett long-run variance and a stated asymptotic critical value; it does **not** claim to implement ADF. Stationarity and unit-root tests have different hypotheses. [3](https://www.statsmodels.org/stable/examples/notebooks/generated/stationarity_detrending_adf_kpss.html)
- **Validation:** time-ordered evaluation must not train on future observations. Tuning, calibration and final holdout are kept chronological; any outcome spanning a boundary is purged. [7](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)
- **Leakage:** the final test set cannot select weights, thresholds, models or calibration settings. Future-label mutation tests enforce this for both quote and digit models. [5](https://scikit-learn.org/stable/common_pitfalls.html)
- **Probability calibration:** the calibrator is fitted on a separate slice. Brier loss measures both calibration and discrimination; reliability bins are also shown instead of calling Brier loss alone “calibration.” [1](https://scikit-learn.org/stable/modules/calibration.html)
- **Uncertainty:** selected-event hit rates are accompanied by Wilson intervals. Historical descriptive intervals can be affected by dependence; the research performance interval uses non-overlapping test outcomes, with remaining limitations disclosed. [1](https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm)
- **Redundancy:** correlated features complicate attribution. The library uses family budgets, reports tuning-only correlations, and labels fixed-model ablation as noncausal, nonadditive sensitivity—not a claim that every correlated feature independently matters. [1](https://scikit-learn.org/stable/auto_examples/inspection/plot_permutation_importance_multicollinear.html)
- **Classification metrics:** precision is TP/(TP+FP), recall is TP/(TP+FN), with undefined denominators left unavailable. They use a stated 0.5 event-classification threshold, distinct from the contract-specific trading-call threshold. [2](https://scikit-learn.org/stable/auto_examples/model_selection/plot_precision_recall.html)
- **Financial risk metrics:** the original Sharpe definition uses differential returns relative to a benchmark. Here the explicitly labelled diagnostic uses per-trade provider-reported net returns, a zero benchmark and **no annualization**. It is not a comparable daily portfolio Sharpe ratio, particularly when durations differ. [1](https://web.stanford.edu/~wfsharpe/art/sr/sr.htm)

## Exact contract semantics

Deriv distinguishes strict final outcomes and offers “allow equals” separately. These tools use the **strict** contracts. [6](https://smarttrader.deriv.me/en/trading)

| Tool | Winning event | No-edge reference | Important limitation |
| --- | --- | --- | --- |
| Matches | Terminal digit equals the selected target | 0.1 under uniform digits | Not “at least one match during the contract.” |
| Even/Odd | Terminal digit has selected parity; zero is even | 0.5 under uniform digits | Price direction does not establish parity bias. |
| Over/Under | Terminal digit strictly exceeds / is below the selected barrier | Over b: (9−b)/10; Under b: b/10 | Equality loses both sides. The research domain remains barriers 1–8. |
| Rise/Fall | Terminal quote strictly above / below origin quote | Half the non-flat outcome mass | A flat expiry loses both directions. A terminal tick-direction state is not the same as the net contract return. |

A 90% raw success rate on an easy contract is not a 90% profitable strategy. Quoted **total payout** includes the stake: break-even is `ask / payout`; estimated net P&L is `p × payout − ask`. The bot now checks the actual live proposal and requires an additional **0.5 probability-point margin**. Missing or non-finite payout data prevents automatic purchase. This is an estimate, not proof of positive true expectancy.

## How each tool uses the library

### Shared for all four tools

1. Normalize valid, chronological, unique observations. Keep verified digit precision; never invent a digit from an arbitrarily formatted number.
2. Measure the applicable statistical, sequence, price and candle features. Other-family diagnostics are labelled **Context only**.
3. Produce direct-horizon forecasts from expanding, already-settled histories.
4. Learn contract-specific, family-balanced model weights on tuning data only.
5. Fit probability calibration on a later slice; score a still-later chronological holdout.
6. Run noise, contradiction, weak-edge, freshness and execution policies.
7. Fold the validated research estimate into the traded probability, the evidence score and the entry evidence for **every** candidate — not only the selected one.
8. Attach one full 300-reading snapshot to the selected candidate. Keep lightweight execution decisions on the other candidates; do not duplicate the full inspector for every barrier/duration.
9. Show a ranked signal that **Load and Run can always trade**. The library never manufactures “300 engines agree” and never disables automatic execution.

### Matches

All ten target candidates are projected from ten-category distributions. Counts, recency, conditional transitions, gap/interval distributions and empirical gap-conditioned forecasts are available. Unknown ages are **censored**, not assumed huge. The gap model estimates subsequent terminal outcomes in historically similar age buckets and shrinks toward a prior; it never applies “the longest-missing digit must come next.”

### Even/Odd

The same normalized digit forecasts are projected into even/odd outcomes, preserving zero as even. Parity frequency, ratios, runs, alternation, imbalance, transitions and regime diagnostics get dedicated readings. Long even/odd streaks are not, by themselves, continuation or reversal evidence.

### Over/Under

Forecasts are projected into the actual strict side of the actual candidate barrier. The display retains **over, under and equal** mass. Dynamic barrier diagnostics compare normalized edge against each barrier's own reference probability; the production ranking retains calibrated evidence, not highest raw win rate. Digit-label distance/pressure is not presented as price support/resistance.

### The digit prior (Over/Under, Even/Odd, Matches)

Behind every digit contract sits `digitPriorComponents()` / `buildDigitPrior()` in
`src/lib/signal-engine/market-state.ts`. It is not one frequency table: it is ten
separate forecast angles, each scored on its own out-of-sample Brier loss against
uniform, each rebuilt at past origins with only the history available then, and
each scored against **the digit the contract settles on** (`origin + horizon`),
not the next tick.

| Angle | Question it answers |
| --- | --- |
| `frequency` | long-run appearance of each digit |
| `recent` | recency-weighted appearance over the last few hundred ticks |
| `transition` | the measured first-order transition row for the current digit, at the contract's horizon |
| `pattern` | higher-order (2–3 tick) context matching the recent suffix |
| `momentum` | the fitted slope of the digit level over the last 60 ticks (conditional on a significant t) |
| `drift` | frequency drift: which digits moved between the last 150 and the previous 900 ticks |
| `reversal` | signed AR(1) mean reversion of the digit level |
| `repeat` | exact repetition of the last digit (one-tick contracts only) |
| `spike` | burst/cluster state after extreme digits |
| `gap` | overdue/gap hazard for each digit |

The pool is linear with a uniform floor of 40% (`PRIOR_UNIFORM_FLOOR`), a per-digit
clip of ±0.12 (`PRIOR_DIGIT_CLIP`), and weights equal to each angle's measured
skill scaled by its support. An angle that cannot beat uniform gets **weight 0**
and cannot influence the published number; on a structureless stream every angle
gets zero and the prior is exactly uniform, so the published probability is
exactly fair. `digitPriorWithWeights()` is the single shipped recipe — the live
prior and the validated backtest both call it, so the reported skill always
describes the number on screen.

How far the pool may commit is earned by that same replay:
`digitPriorLimitsFor(replaySkill)` lowers the uniform floor from 40% toward 8%
and widens the per-digit band from ±12 to at most ±30 points as measured skill
rises (`priorLimits` on the state, so every historical replay uses the same
band). With no measured skill the recipe is the conservative one, bit for bit —
which is why a fair stream still publishes exactly fair.

Downstream, `confirmation.ts` pools that prior with the calibrated ensemble by
measured skill (`state.weight`, reported in the panel), never by a fixed nudge,
and `precision.ts` prices the mixture with a standard error that includes the
prior's own sampling error. The AI meta-model receives `priorEdge` — the prior's
per-contract view over the rolling-frequency baseline rebuilt at that row's own
origin — as an extra feature, gated at three sigma out of sample.

`scripts/digit-accuracy-benchmark.mjs` audits the whole chain on markets whose
structure is known: per-angle skill tables, the shipped recipe replayed at every
out-of-sample origin (published vs realised vs fair), and a fair-stream
neutrality check. Run `node --experimental-strip-types ./scripts/digit-accuracy-benchmark.mjs`
(`H=1` for one-tick contracts, `SEEDS=6` for tighter error bars).

### Rise/Fall

Direct horizon outcomes use `quote[exit] − quote[origin]`, with a separate flat category. For minute horizons the exit is the first observed tick reaching the actual timestamp, not a conversion using average cadence. The audit adds trend, RSI and completed-candle context models alongside frequency, transition, sequence, run and regime models. Verified digits, when provided, are contextual rather than causal quote-direction predictors.

## Forecast and validation mechanics

### Research models

| Model | Family | Input / estimator |
| --- | --- | --- |
| Short / medium / long | Frequency (shared budget) | Last 50 / 200 / 1,000 completed outcomes, prior strength 20 |
| Linear weighted / exponential recency | Frequency (same budget) | Increasing linear weights / 50-outcome half-life |
| Direct state transition / two-state context | Dependence (shared budget) | Completed terminal outcomes conditional on the latest state / pair |
| Run-length | Run-length | Current state plus run-length bucket, capped at 5+ |
| Regime | Regime | Causal local entropy for digits / short-to-long return volatility for quotes |
| Gap hazard (digits only) | Recurrence | Smoothed per-digit terminal event probability conditional on known age bucket; normalized across digits |
| MA/trend context (quotes only) | Trend | Sign of trailing 20- versus 60-quote means |
| RSI context (quotes only) | Momentum | Causal Wilder RSI <30 / 30–70 / >70 |
| Closed candle context (quotes only) | Candle | Direction of the most recently completed 60-second candle |
| PPM variable-order Markov (digits) | Markov | Orders 1–5 with PPM-C escape; each context row is shrunk by 24 pseudo-counts toward the shorter context before its escape share |
| Dirichlet predictive (digits) | Frequency | Posterior mean `(decayed count + α·prior)/(decayed total + α)`; half-life ∈ {60,150,400,1000} and α ∈ {1,4,12} chosen on the training tail |
| Gap hazard (digits) | Recurrence | Measured printing rate at the exit tick, bucketed by how long each digit has been absent, Laplace-smoothed toward 10% |
| Horizon autocorrelation (digits) | Information | Per-digit indicator correlation at exactly the contract's horizon, tested at 2.5/√n before it tilts anything |
| Local-level filter (digits) | Time series | Per-digit exponential state-space filter with a gain fitted on training data, damped toward the marginal over the horizon |

These are transparent empirical research models, **not claims of new LSTMs, boosted trees or 300 neural networks**. They supplement, not rename, the existing application's separate model ensemble.

- Expanding history begins at `max(100, floor(0.30 × n))`.
- Calibration starts at `floor(0.55 × n)`; final holdout starts at `floor(0.75 × n)`.
- Up to approximately 300 replay origins are stratified with deterministic, label-independent jitter. This prevents a fixed stride from sampling only one phase of a digit cycle.
- A forecast can use only outcomes whose exit has already occurred at its origin. Predictor histories continue expanding as outcomes mature, including earlier holdout outcomes; this is an online walk-forward evaluation, not a frozen historical fit. Model weights, calibration policy and thresholds remain frozen after their respective phases. Replay outcome intervals do not overlap. Labels crossing the next split boundary are dropped.
- Forecast smoothing uses prior strength 20: uniform digit mass, or quote-state mass (rise 0.4995, fall 0.4995, flat 0.001). The small positive flat pseudocount avoids an improper zero-parameter Dirichlet prior.
- Digit no-edge reference mass is uniform. Quote no-edge flat mass is estimated **before tuning**, not from final-test labels.
- Reliability is `clamp(exp(12 × tuning Brier skill), 0.2, 4)`, then the existing family-budget normalization is applied. Related frequency estimators share one family budget.
- With ≥40 calibration rows and at least five positive and five negative outcomes, isotonic calibration is fitted on the calibration phase. Output is a fixed 50/50 raw/isotonic blend. Otherwise calibration is identity. The final test does not choose the calibrator.
- Self-validation requires **≥30 tuning rows, ≥40 non-overlapping test rows, Brier skill >0.005, and corrected one-sided paired-loss p <0.05**. Correction multiplies by scanned candidate pool × research-model count. This is a conservative asymptotic check, not proof of independence or a universal false-positive guarantee.
- Bayesian likelihood weighting, regime-specific model selection and ablation are **reported diagnostic alternatives**. They do not get stacked as extra correlated votes.
- Two pools are fitted with the same weights — linear (Σ wᵢpᵢ) and geometric
  (∝ Π pᵢ^wᵢ) — and the one with the lower **tuning** Brier ships, by a 0.75%
  margin. The choice is made before any holdout row is read; the loser is still
  reported in `diagnostics.blend`.
- A family's weight is its best member's measured strength, not the average of
  its members, so adding a weak engine cannot dilute a measured family.
- A validated contrary research estimate reduces the base edge by **75%**, marks confirmation contradicted, and reduces confidence. Entry evidence is generated from that adjusted probability. Supportive/unvalidated research never increases the base estimate.

## Layer 4: the research library folded into the signal

Every candidate (contract or duration) now carries the research ensemble into the
number the tools actually rank, confirm, plan an entry for and trade. `src/lib/engine-lab/fusion.ts`
is pure, worker-safe and deterministic:

1. Both estimates are expressed as an edge over the same no-edge rate:
   `baseEdge = probability − fair` (after confirmation) and `researchEdge = audit.probability − audit.fair`.
2. A validated ensemble earns weight `clamp(0.35 × sampleFactor × skillFactor, 0.05, 0.35)`, where
   `sampleFactor = clamp(holdout / 200, 0.25, 1)` and `skillFactor = clamp(4 × max(0, holdout Brier skill), 0.1, 1)`.
   It may then move the estimate in either direction.
3. An unvalidated ensemble earns weight only when its own estimate is materially lower than the base
   one (`researchEdge < baseEdge − max(0.005, 0.01 × fair)`), capped at `0.15 × sampleFactor`. It can
   therefore only pull the estimate down, never inflate an edge.
4. The blend is a convex combination of the two edges, so the result always lies inside the range the
   two estimates already spanned: research is a second opinion, not a multiplier.
5. The ensemble also contributes to the evidence score (`researchTerm` in `confidence.ts`, ≤6% of the
   raw score) with the same rule — a validated ensemble can add or remove evidence, an unvalidated one
   can only remove it. Callers that pass no research evidence keep a **bit-identical** confidence.
6. A missing, non-finite or model-less audit returns the base estimate unchanged.

On the ten seeded null streams used by the regression suite, no candidate is ever boosted: noise does
not validate, so the fusion can only leave the estimate alone or lower it.

## The AI meta-model reads what the blend cannot

The digit confirmation stack used to be fitted on `[p, logit(p)]` — two monotone
transforms of the same number. That model could only rescale a probability, never
add information, so on a well-calibrated ensemble it lost to the base by
construction and the "AI" source carried no weight. `confirmation.ts` now fits a
regularised logistic meta-model on `[p, logit(p), dispersion, signed support,
baseline edge]`:

- **dispersion** — the weight-weighted spread of the engine probabilities around
  their own consensus. Two committees that publish the same probability are not
  equally trustworthy when one is split.
- **signed support** — the share of engine weight backing the signalled side,
  negative when the committee leans the other way.
- **baseline edge** — rolling-frequency probability minus fair. It is the only
  feature that does not come from the engine pool.

Acceptance is out of sample and strict: the stack must beat the base Brier score
by more than 2% and clear a paired z of 3 (2.5 per contract would make the best
of a 16-contract scan look significant) on the newer chronological half, after
which it is refitted on all rows for the live prediction. The stack's skill is
reported twice — against the calibrated chain (`stackSkill`) and against the
no-edge rate (`stackSkillVsFair`) — because Layer 6 pools every source by its
skill against **fair**. A stack that improves 5% on a chain already 20% better
than fair is not five times weaker than an engine with 5% edge.

If the features are absent, misaligned or non-finite, the stack is not fitted at
all. The AI source is then reported with no view, not given a vote it did not
earn.

## Layer 6: one master decision and one measured validity window

`src/lib/signal-engine/master-decision.ts` is the pass that joins the layers into
a single call. It is pure, deterministic, structured-clone friendly (it runs in
the scan workers) and does not mutate its inputs.

1. **Pool.** Every source with demonstrated out-of-sample skill is weighted by
   `tanh(30 × skill) × n/(n+50) × familyCredit` and pooled in log-odds space.
   Unmeasured sources are still reported but carry zero weight. The AI stack and
   the research library carry partial family credit because they read the same
   tick stream.
2. **Reconcile.** The calibrated chain owns the probability. The pool may pull
   it by at most a quarter of the disagreement and at most 0.15 log-odds, so a
   committee of correlated measurements can never overrule the audited chain.
3. **Decide.** A decisive call requires a material edge, `z ≥ 1.645`, a stable
   decay curve (2 of 3 chronological thirds agreeing), either confirmation or
   at least two weighted sources, and no validated contradiction. Anything with
   a positive but smaller edge is `SPECULATIVE`; the rest is `NO_EDGE`. The best
   candidate is still returned in every case — the master reports the absence of
   an edge, it does not block the analysis.
4. **Measure the window.** For every replayed signal the prediction is held
   fixed and the entry is delayed by 0…maxLag ticks. The hit rate at each delay
   is measured against fair with an overlap-corrected effective sample:
   `observed / (span/stride + lag/span)`, where `span` is the median contract
   span and `stride` the median gap between replay origins. The window is the
   last lag whose edge is at least half the initial edge, positive, and whose
   one-sided 90% Wilson lower bound still clears fair. `NO_EDGE` collapses the
   window to one tick; nothing is allowed to wait on noise.
5. **Cap the entry.** The plan is returned as `{ ...entry, validForTicks }`.
   `effectiveWindowTicks` and `entryWindowMs` honour the stricter of the plan
   window and the measured validity, so the bot can never wait for a trigger the
   analysis no longer vouches for. A one-tick validity expires after one tick
   even though the UI's wall-clock floor keeps the countdown readable.
6. **Report.** Conviction is capped by the verdict: at most 45 on `NO_EDGE` and
   70 on `SPECULATIVE`, so a high evidence score cannot dress up a call the edge
   did not earn. The decision carries the per-source pool, the decay curve, the
   entry instruction and the invalidation conditions used by the master card.

On the biased 2,000-tick fixture (digit 7 at 28%) the master returns
`TRADE_NOW`, conviction 99, edge +25.2 points, z 5.00, five-tick validity. On an
unbiased stream it returns `NO_EDGE`, conviction 45, edge +0.3 points, and a
one-tick window. The Rise/Fall path applies the same layer to its 15 engines and
25 durations, measuring delayed-entry outcomes from the delayed entry price
rather than the original origin, so a trend cannot masquerade as an edge that
survives every delay.

## Level reversion (2026-10-23)

`level-reversion` is the one analysis engine that reads the quote's LEVEL rather
than its returns. It fits `quote[t] = a + phi·quote[t−1]` by OLS over the last
600 ticks and tests `phi = 1` with the usual t-statistic, keeping the fit only
when t ≤ −3.5 (beyond the Dickey–Fuller 1% bar), the half-life is between 2 and
120 ticks, and the fit is stationary. From there it reports the equilibrium
`a/(1−phi)`, the stationary sd `σ/√(1−phi²)` and the displacement in those units,
and `levelReversionProbabilityUp(model, h)` turns it into a probability at any
exit horizon:

  E[Δh] = (x_t − mean)·(phi^h − 1),  sd[Δh] = σ·√((1 − phi^{2h}) / (1 − phi²))

A random walk fits phi ≈ 1, so the expected move vanishes and the probability
collapses to a coin flip: the engine cannot invent an edge. Measured on planted
Ornstein–Uhlenbeck streams it fires on 100% of origins at θ = 0.15 and 0% of
trending ones, and a 65–72% hit rate at one stationary σ of stretch is what the
entry master uses to decide whether to fire now or wait for a better price.

## Candles, units and unavailable states

- Candles are timestamp-aligned **60-second observed OHLC**, not fabricated “tick candles.” The open last bucket and an initial partial bucket are excluded. Missing buckets are not forward-filled. Intra-bucket missing ticks remain a data limitation.
- Multi-timeframe trend uses completed **1-, 3- and 5-minute** closes and requires at least three bars at each resolution. Long windows abstain when history is too short.
- Tick-based EMA/RSI/MACD/ROC and candle-based ATR/stochastic/CCI/Williams %R have their units disclosed. Dynamic support/resistance is an explicitly labelled tick-EMA/minute-ATR hybrid proxy.
- Price-only liquidity sweeps and divergence are labelled proxies; the app has **no order-book or volume evidence** for those claims.
- `Measured` means a statistic or policy was evaluated, **not** that it predicted a winner.
- `Context only` means it can explain the market but is not direct evidence for this contract family.
- `Needs more data` includes insufficient support and mathematically undefined denominators.
- `Unavailable` means required input is missing (e.g. quotes, verified digits or settled P&L).
- `Shared / alias` identifies the repeated source metric; no extra vote is created.

## Performance and execution

Research win/loss rates, streaks and calibration are based on **called, non-overlapping holdout forecasts**. Binary accuracy/precision/recall use all held-out rows at threshold 0.5; these can look good for rare events even when there is no tradeable edge.

Engines #265–270 use only the account active at scan time's **loaded closed positions**, scoped to the selected market, contract family and currency. Duplicate contracts and invalid stake/time rows are excluded. They describe provider-reported realized P&L; external charges, absent history, equity funding, unrealized exposure, the particular selected barrier/horizon and causal strategy attribution are **not inferred**. The snapshot retains its currency and does not silently refresh with another account: rerun analysis after switching accounts. Mixed trade durations make per-trade ratios especially limited. Zero denominator ratios are unavailable, not infinity. If no qualifying account history exists, all six metrics abstain.

These same checks are reported as **advice, not vetoes**. Automatic execution used to fail closed for:

- a missing/older research audit;
- stale source data;
- a base signal without independent decisive confirmation;
- fewer than 30 independent base-signal outcomes;
- an edge smaller than `max(0.005, 0.01 × fair)`;
- independently validated contradictory research;
- missing/unfavourable actual proposal economics.

That behaviour was removed: it left a finished analysis with a **Load and Run** button the user could
not press. The gates now produce one advisory sentence that travels with the run (the mini trade menu
and the bot page both show it), the quoted payout economics are recorded on the run row instead of
blocking the purchase, and the ranked candidate is traded as analysed. The checks never place trades,
change stakes or enable a bot automatically. Manual ticket control remains available. The signal bot
still requires an explicit **Load and Run**, a connected account, valid entry evidence from the
analysis and the existing freshness/risk limits.

## Files and maintenance

- `src/lib/engine-lab/catalog.ts`: all 300 names, formulas, domains, roles and references.
- `src/lib/engine-lab/math.ts`: indicator/statistical primitives, complete candle aggregation and exact exit lookup.
- `src/lib/engine-lab/measurements.ts`: explicit evaluations for #1–218.
- `src/lib/engine-lab/forecast.ts`: causal feature bank, replay, weights, calibration, audit and decisions.
- `src/lib/engine-lab/fusion.ts`: layer 4 — folding the validated research estimate into the traded signal.
- `src/lib/engine-lab/report.ts`: #219–300, aliases, report completeness checks and actual-return accounting.
- `src/lib/engine-lab/execution.ts`: scoped settled positions, advisory research text and quote economics.
- `src/lib/signal-engine/{digit-signal,rise-fall-signal}.ts`: production scan integration.
- `src/components/signal/engine-lab-panel.tsx`: common searchable/paginated inspector and JSON export.
- `tests/engine-lab.test.mjs`: formula fixtures, all-ID coverage, semantics, causality, leakage, null/structured streams and integration tests.

No runtime web research or new analytics service is needed. Calculations remain deterministic, in-memory and worker-safe. No account credentials are included in exported audits. Raw tick history is not exported in the report.

Run from the repository root:

```sh
pnpm --filter @workspace/deriv-signal-lab run test:digit-analysis
pnpm --filter @workspace/deriv-signal-lab run test:engine-lab
pnpm run typecheck
PORT=18781 BASE_PATH=/ pnpm --filter @workspace/deriv-signal-lab run build
pnpm --filter @workspace/deriv-signal-lab run docs:engines
pnpm --filter @workspace/deriv-signal-lab run docs:engines:check
```

The full test suite includes the existing signal, entry, bot, fusion and contract tests. Browser verification should use a mocked **public market-data socket**, not a connected real trading account: run every tool, check worker progress/results, inspect/export all 300 entries, switch markets, exercise filters/pagination, verify that **Load and Run is always enabled after an analysis** and mobile wrapping. No live-money results are claimed by those tests.

### Reproducible browser smoke test

With `pnpm dev` running, install the test browser once in a normal development
environment, then run the checked-in test (only `playwright-core` is a dev dependency):

```sh
pnpm --filter @workspace/deriv-signal-lab exec playwright-core install chromium
pnpm --filter @workspace/deriv-signal-lab run test:engine-lab:browser
```

Alternatively set `BROWSER_EXECUTABLE_PATH` to an existing Chromium binary.
`BROWSER_BASE_URL` selects a different running frontend; optional
`BROWSER_LAUNCH_ARGS` is a JSON argument array for sandbox-specific browser dependencies.
The test intercepts the public market-data WebSocket, exercises real scan workers
on two fixture markets for all four tools, checks all 300 exported readings,
filters, pagination, expandable formulas and a 390px mobile viewport, and asserts
that **no proposal or purchase request** was sent. Set `BROWSER_SCREENSHOT_DIR`
outside Git if screenshots are desired.

## Verification record — 18 October 2026

- **275/275 regression tests passed**, including all 239 existing tests and 36 new research tests.
- All workspace TypeScript checks and production builds passed. Vite still reports non-blocking bundle-size and tooltip source-map warnings.
- The checked-in browser smoke test passed all four tools using two deterministic 2,000-tick public-feed fixtures. It exercised real Web Workers, market switching, 300-reading exports, pagination, filtering, expandable matrices/model tables and 390px mobile layouts. There were **zero browser runtime errors and zero proposal/purchase requests**.
- Ten seeded null streams across all four families produced no validated research edges in the regression fixtures; the deliberately biased fixture passed validation. This limited simulation is not a live false-positive-rate or profitability guarantee.
- A single 2,000-tick, 25-duration Rise/Fall benchmark completed in approximately **0.75 seconds** in this sandbox, with one full 300-reading report. This is a local benchmark, not a device-independent latency guarantee.
- The generated catalog synchronization check and frozen-lockfile dependency check passed.

These checks verify implementation behaviour, not live trading returns. No live
trade was placed, and broker connectivity/settlement execution was not tested
with a funded account. Use demo observation and genuinely unseen data before
considering live-money deployment.
