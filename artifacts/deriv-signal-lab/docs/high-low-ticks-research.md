# High/Low Ticks on Deriv — the complete research file

Everything this repository knows about the `TICKHIGH` / `TICKLOW` contract family, the
mathematics that governs it, the strategies people actually run on it, and what a machine can
and cannot honestly claim to know about it. It is the reference behind the **High/Low Tick AI
Sniper v6 (APEX core)** in the Bot store and the `x_price_*` blocks in the Vision Lab toolbox:
sixteen experts scored walk-forward under a regime-gated meta-learner, a deep online neural
brain, a tie-aware structural prior measured from the market itself, the live ten-outcome
payout ladder as the value test, an execution clock that turns five ticks into seconds, DNA v2
auto-reverse-engineering with self-derived tuning, per-outcome calibration of the graded
record, a self-audit that grades every published decision, and a market scout that can move the
bot when the market it is standing on stops being readable.

Numbers marked **[measured]** come from the simulation and enumeration scripts described in
[§12](#12-reproducing-the-numbers); numbers marked **[contract]** come from Deriv's published
contract description and API; everything else is arithmetic you can redo by hand.


> **Important verification and safety notes (29 October 2026).** Deriv's published
> [contract description][c1] says the selected tick must be the highest or lowest, but does
> **not** specify how equal extrema settle. The simulations and bot use the conservative
> assumption that a shared extreme on the selected side loses; this is **not verified as
> Deriv's settlement rule**. Confirm it with Deriv and demo contract settlement records before
> relying on the probabilities. A tie for the high does not imply a tie for the low.
>
> The engine's scores, confidence, EV floor and latency adjustment are **heuristics**, not
> statistically validated confidence intervals or guarantees of profit. In particular, replay
> weights now wait for outcomes to settle, but the replay also uses structural quantities
> estimated from the full supplied history; it is not a fully point-in-time backtest. Obtain
> independent, chronological out-of-sample tests with actual quotes and execution records.
> The synthetic experiments below are illustrative, not proof of predictive edge.
> Contract availability, limits and payout depend on the account and current proposal.

---

## 1. The contract

| Property | Value | Source |
| --- | --- | --- |
| Contract types | `TICKHIGH` (High Tick), `TICKLOW` (Low Tick) | [contract][c1] |
| Question | "Which of the **next five ticks** is the **highest** (or **lowest**)?" | [contract][c1] |
| Prediction parameter | `selected_tick` — an integer **1…5** (position inside the window) | [api][c2] |
| Duration | **Always 5 ticks.** Not configurable, not seconds, not minutes | [contract][c1] |
| Duration unit in the API | `t` (ticks) | [api][c2] |
| Markets | **Synthetic indices only** | [contract][c3] |
| Barrier | None. The prediction is a tick index, never a price barrier | [api][c2] |
| Early close | Deriv's own FAQ says a High/Low Tick contract **cannot** be closed before expiry. The engine still exposes unwinding through `sell` where the API reports the contract as sellable, and treats that path as unverified | [contract][c1] |
| Win condition | The selected tick is highest (or lowest) of the five; treatment of equal extremes is **not specified in the cited description** | [contract][c1] |
| Pay-out | Quoted per `(contract_type, selected_tick)` by `proposal`; never a published constant | [api][c2] |
| Minimum stake | 0.35 USD on synthetics | [stake][c4] |

Two things follow immediately and shape everything below:

1. **There are ten outcomes, not two.** Five positions × two sides. The ten are mutually
   exclusive *across a side* (one tick holds the strict high) but the high and the low of the same
   window can be — and usually are — different ticks, and one tick can hold both only if all five prices are equal.
2. **The question is about an order statistic, not a direction.** Rise/Fall asks where the price
   ends; High/Low Ticks asks *where the extreme sits*. Directional intuition (RSI, momentum,
   candles) transfers only weakly: it moves mass toward the end of the window when the tape is
   trending, and that is all.

### 1.1 What the five ticks are

The window is the five consecutive quotes that follow the contract being processed. The entry
spot is the first tick *after* processing, so the window the models replay must be
"the five ticks after the last quote you can see", which is exactly how
`priceDecision(values, 'tick', 5, …)` builds its rows: window `i+1 … i+5` for a decision made on
quote `i`.

Execution reality: between your decision tick and Deriv processing the purchase, one or two ticks
can print (a `proposal → buy` round trip on a 2-second market usually fits inside one tick, on a
1-second market it usually does not). The window the model scored is therefore occasionally *not*
the window that settles. This is the single biggest practical source of "the model was right and
the contract lost". The sniper prices it explicitly as an **entry slip** penalty on the estimated
edge (§9.4) instead of pretending it does not exist.

---

## 2. How the ticks are generated (and why that matters)

Deriv generates its synthetic indices with a **cryptographically secure pseudo-random number
generator** audited by independent third parties, calibrated to a fixed annualised volatility per
index, and broadcast identically to every client [rng][c5]. Volatility 100 moves with 100 %
annualised volatility, Volatility 10 with 10 %, and the 1-second family prints a tick every
second while the classic family prints one every two seconds [tick][c6].

For a volatility index the per-tick standard deviation is

```
σ_tick = price × vol × √(Δt / year)
```

At `price = 1000`, 100 % volatility, two-second ticks:
`σ_tick = 1000 × 1.0 × √(2 / 31 536 000) ≈ 0.25`, i.e. **25 price increments** of the 0.01 quote
grid. That ratio — σ per tick measured in quote-grid units — is the single most important
market parameter for this contract, for reasons explained in §4.

Consequences:

* **Do not assume predictable increments.** A CSPRNG description alone does not establish
  that every index is a martingale or that every market has identical dynamics. Apparent patterns
  need independent out-of-sample evidence; past performance is not proof of future predictability.
* **The only structure that survives is arithmetic.** It is not a property of the *increments*
  but of the *order statistics* of the window (the U-shape of §3) and of the *grid* (ties, §4).
  That structure is real, knowable, and — crucially — **also known to the pricing engine**.
* The game is therefore not "predict the market". It is **"find the position where Deriv's quoted
  pay-out is worse than the probability of that position holding the extreme"**, and decline the
  rest. That is a pricing-arbitrage problem, and it is why the sniper's final gate is
  expected-value against a live pay-out table rather than "a signal".

---

## 3. The mathematics of "which tick is the extreme"

### 3.1 The continuous random walk — the discrete arcsine law

For a symmetric random walk of `n` steps, the position of the running maximum follows the
discrete arcsine distribution (Chung–Feller):

```
P(argmax = k) = C(2k−2, k−1) · C(2n−2k, n−k) / 2^(2n−2)
```

For `n = 5` the weights are `70, 40, 36, 40, 70` over `256`:

| Position | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| P(high at k) | **27.34 %** | 15.63 % | 14.06 % | 15.63 % | **27.34 %** |
| Fair pay-out multiple `(1−p)/p` | 2.66× | 5.40× | 6.11× | 5.40× | 2.66× |

Three facts worth internalising:

* **The ends are twice as likely as the middle.** Tick 1 and tick 5 each carry more probability
  than ticks 2–4 combined at the edges. Any strategy that treats the five positions as
  interchangeable (a uniform 20 % each) is wrong by a factor of ~1.4 on the ends and ~0.7 on the
  middle.
* **The distribution is the same for the low.** Reflection symmetry: the running minimum behaves
  exactly like the running maximum of the negated walk.
* **It is nearly flat in the middle and steep at the ends.** That asymmetry is what makes a
  static "always pick tick 1" rule *better than random* in win rate and *worse than random* in
  expected value, because the pay-out is priced for it (§5).

### 3.2 The grid walk — ties change everything

Real ticks live on a quote grid, so exact ties for the extreme happen. For a pure ±1-step walk
(Step Index, `stpRNG` family, which moves exactly ±0.1 per tick), enumerating all 32 five-step
paths gives **[measured]**:

| Position | 1 | 2 | 3 | 4 | 5 | tie for extreme |
| --- | --- | --- | --- | --- | --- | --- |
| P(strict high at k) | 18.75 % | 12.50 % | **6.25 %** | 12.50 % | 18.75 % | **31.25 %** |
| Conditional on a strict extreme | 27.27 % | 18.18 % | **9.09 %** | 18.18 % | 27.27 % | — |
| Fair multiple `(1−p)/p` (unconditional) | 4.33× | 7.00× | **15.00×** | 7.00× | 4.33× | — |

Under the strict-extreme assumption, a tie for the high makes all high positions lose; a tie
for the low makes all low positions lose. They need not occur together. In the idealised ±1
walk, 31.25 % of windows have a shared high, and separately 31.25 % have a shared low.
The strict middle high occurs 6.25 % of the time, 3.2 times less often than a 20 % uniform guess. Compare that with the continuous arcsine's 14.06 % for the middle — the grid makes
the middle position dramatically *less* likely, not more.

### 3.3 The granularity law — one parameter explains the whole table

What decides whether you are in the world of §3.1 or §3.2 is

```
r = σ per tick  /  quote grid size          (how many grid steps a typical tick moves)
```

Simulating windows with Gaussian increments rounded to a unit grid, 120 000 windows each
**[measured]**:

| r (grid steps per σ) | tie rate | strict high at 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.5 | **70.5 %** | 9.83 % | 3.51 % | 3.02 % | 3.49 % | 9.68 % |
| 1 | 48.8 % | 16.05 % | 6.59 % | 5.80 % | 6.50 % | 16.27 % |
| 2 | 28.7 % | 21.20 % | 10.04 % | 8.90 % | 10.03 % | 21.12 % |
| 3 | 20.4 % | 23.01 % | 11.65 % | 10.33 % | 11.53 % | 23.09 % |
| 5 | 12.5 % | 24.90 % | 13.11 % | 11.62 % | 13.08 % | 24.82 % |
| 10 | 6.5 % | 25.93 % | 14.39 % | 12.87 % | 14.36 % | 25.97 % |
| 25 | **2.7 %** | 26.84 % | 15.05 % | 13.64 % | 15.00 % | 26.80 % |
| ∞ (arcsine) | 0 % | 27.34 % | 15.63 % | 14.06 % | 15.63 % | 27.34 % |

Read this table twice, because it is the core of this document:

* A **Volatility 100** index at `r ≈ 25` is effectively the continuous case: ties are ~2.7 %, ends
  ~27 %, middle ~13.6 %.
* A **Volatility 10** index has a smaller per-tick σ — but its quote grid is finer (3 decimals at
  a higher price), so in practice it also lands in the `r ≫ 5` regime. Measure it, do not assume
  it: the DNA block reports the measured grid ratio for the market you are on.
* An idealised ±1-step walk at `r = 1` has a shared high in 31.25 % of windows (and a
  shared low in another 31.25 %); the middle strict high is 6.25 %. The two tie events differ.
* **A tie is not a probability of zero for the position — it is missing mass.** Any model that
  normalises five positions to 100 % and forgets the tie mass overstates its win probability by a
  factor of `1/(1 − tieRate)`, which on a Step Index is **45 %**. On a 2 % payout margin that
  difference is the whole game. This is the single most common arithmetic error in community
  "high/low tick sniper" bots, and the one this repository's engine v5 fixes explicitly.

### 3.4 Drift tilts the distribution

Synthetic indices have no drift, but real-quote markets, and any local trend inside a window,
do. Simulating with a positive drift per tick (σ = 8 grid steps) **[measured]**:

| drift (grid steps/tick) | high at 1 | 2 | 3 | 4 | 5 | low at 1 | … | 5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 25.5 % | 13.9 % | 12.6 % | 14.1 % | 25.7 % | 25.9 % | … | 25.5 % |
| 0.6 | 21.9 % | 12.8 % | 12.6 % | 14.7 % | **30.1 %** | **29.8 %** | … | 21.8 % |
| 2.0 | **14.4 %** | 10.5 % | 11.6 % | 16.1 % | **39.9 %** | **39.7 %** | … | 14.3 % |

In words: **a rising tape pushes the high later and the low earlier**. That is the only "market
reading" that legitimately transfers to this contract, and the engine's `regime` expert encodes it
as a tilt rather than as a directional bet.

### 3.5 The tie-rate discount is the honest correction

Because a tie loses, the win probability of "high at position k" is

```
P(win) = P(strict high at k) = (1 − P(tie)) · P(argmax = k | a strict extreme exists)
```

The engine therefore carries three numbers per decision: the **conditional position
distribution** (what the mixture models), the **tie forecast** for the next window, and their
product — the win probability used for every gate, stake and journal line.

---

## 4. The pay-out side: break-even, fair odds, and the house edge

A digital option that pays `m` per unit staked profits `m·s` on a win and loses `s` on a loss.
Break-even:

```
p·m − (1 − p) = 0   ⇒   p* = 1 / (1 + m)      and the fair multiple   m* = (1 − p) / p
```

So:

* **A fair multiple is what the probability deserves.** If the true probability of "high at tick
  3" on a Volatility 100 index is 13.64 %, the fair pay-out multiple is 6.33×. A quote of 6.0× is
  a 5 % house margin; a quote of 6.6× is a genuine (and vanishingly rare) overlay.
* **Deriv's margin is small per contract and merciless in aggregate.** The house prices each
  `(side, selected_tick)` separately, so the margin lands on every position independently: at a
  5 % margin, a single optimal position is −3.8 % EV per contract **[measured]**, and a
  full-coverage hedge is −4.1 %.
* **Position 1 and position 5 are cheap precisely because they are likely.** A quote of 2.6× for
  a 27 % event looks unappealing next to a 6× quote for a 14 % event, and both are equally bad.
  "Prefer the big payout" is a losing heuristic.

### 4.1 What "the tie is a loss" costs the price

On a tie-heavy market the fair multiple for position 3 explodes (15× on a pure step walk) while
position 1/5 sits at 4.3×. If an operator sweeps pay-outs across positions on a Step Index they
will see this shape; if they instead see a *flat* pay-out ladder across positions, the market is
mispricing something badly — and that is an overlay the EV scan will find. That is not a
hypothesis we assert here: it is a measurement, which is why the sniper reads the live table
for all ten outcomes instead of one number.

---

## 5. The strategy catalogue — every approach, and what it is actually worth

Numbers assume a fair random walk and a 5 % house margin unless stated. "Edge" means expected
value per unit staked.

### 5.1 Single-position snipe (what the shipped bot does)

Pick the `(side, position)` with the highest expected value given the live quote, stake Kelly,
decline when the best EV is negative.

* **Structure exploited:** pricing that lags the model's conditional read; mispriced ladders.
* **EV:** −3 to −5 % per contract in the honest case (you are paying the house margin).
  Positive only when the model's estimate beats the *quoted* odds, which happens when
  (a) the market's measured tie rate/piste structure differs from the pricing model's,
  (b) a genuine conditional read exists, or (c) quotes lag a volatility change.
* **Verdict:** the only version of this trade with a coherent thesis. Everything else below is
  a variance-reshaping exercise, not an edge.

### 5.2 Fixed-position "always tick 1" / "always tick 5"

* Win rate ≈ 27 % on a fine grid, 18.75 % on a step index.
* **EV:** exactly the house margin, negative. It *feels* better than random because the window
  wins more often than 1-in-5; the pay-out is priced for exactly that.
* **Verdict:** a paying hobby. It is, however, a useful **anchor**: any model that cannot beat
  "always tick 1 at its quoted odds" on walk-forward Brier score has not earned a vote. The
  engine scores every expert against exactly this.

### 5.3 Full-side coverage — buy all five positions

Cost `5s`; exactly one leg wins unless the window ties; at fair odds the expected return is
`5s` ⇒ **EV = 0 before margin, −(margin × 5s) after** **[measured]**.

* It is the cleanest demonstration that this contract family is a **pricing** game: covering
  every outcome is a risk-free zero before the house edge and a certain loss after it.
* Useful as an **insurance/reference** calculation, never as a strategy.

### 5.4 Both-sides coverage — ten legs

Same arithmetic with ten legs and ten quotes; EV = −(margin × 10s), and the variance is
essentially zero. Any bot that advertises "risk-free high/low tick coverage" is selling this
loss.

### 5.5 High + Low pair on the same window (the "hedge")

Buy one High Tick and one Low Tick for the same five ticks. On a fair walk **[measured,
ARC-5]**:

* both legs win ≈ 5 % of windows (a monotone window),
* exactly one leg wins ≈ 30 %,
* neither wins **≈ 65 %** (ties and mixed middles).

With equal stakes and fair pricing, EV ≈ 0 minus two margins. The pair *spreads* outcomes; it
does not create value. Its real use is **operational**: when a position must be opened on every
cycle (a cadence requirement), the pair converts "one bet, 27 % chance" into "mostly a small
loss, occasionally a large win" — a different distribution with the same negative expectation.
The repository's hedging bot prices exactly this and the Step pair analysis lives in
`src/lib/hedging-bot/economics.ts`.

### 5.6 Two-position barbell (ticks 1 and 5)

Stake split between the two likeliest positions. Capture is `2 × 27.3 % ≈ 55 %` of windows on a
fine grid (fewer on a grid walk because of ties), the pay-out per leg is the smallest of the
ladder, and EV is again the margin. Its virtue is not EV but **hit rate**: a 50 %+ win rate with
~2.6× quotes gives smoother equity than a 14 % position at 6×, and it survives long enough to
measure whether an edge exists. The sniper's `certainty` gate prefers exactly this region.

### 5.7 Ladder / weighted coverage

Stake proportional to the model's probability across several positions. This is the *correct*
way to express uncertainty on this contract, because the ten outcomes are mutually exclusive
per side: a probability-weighted portfolio's EV is the probability-weighted average of the leg
EVs, so it cannot beat buying the single best leg — it only reduces variance and increases the
number of contracts you pay margin on. **Useful; not an edge.**

### 5.8 Trend / candle-filtered position choice

The community recipe (two- and five-minute candles, moving-average cross, then "high tick" with
martingale) reduces to: *when the tape is trending up, the high tends to print late and the low
early* (§3.4). The signal is real, the size is small — a full trend tilt moves the modal position
from 25.5 % to 39.9 % only at a drift of two grid steps per tick, which volatility indices do not
sustain inside five ticks. Against a 5 % margin the effect is usually not enough. It is
implemented in the engine as the `regime` expert and is allowed to earn weight only if the
walk-forward score says it did.

### 5.9 Mean-reversion / stretched-tape choice

The mirror: after a stretched move away from the short mean, the extreme is more likely to sit
early in the next window (the move already happened). Also encoded in `regime`; also usually
small.

### 5.10 Digit / last-digit filters

Filter entries by the last digit of the entry quote (e.g. only enter when the entry digit is in a
"hot" set). On a CSPRNG tick feed the last digit is independent of the window's order statistics;
the filter is a sample-size reducer. **Verdict: noise.** It is included here because it is the
most common "AI" claim in the community.

### 5.11 Frequency / hot-position bots

"Tick 3 was the high 4 times in the last 20 windows, so buy tick 3." On a fair walk the standard
error of a 20-window rate near 14 % is ~7 points, so four hits is entirely consistent with the
null. The engine measures this properly (`frequency`, `recent`, `transition`, with Brier scoring
and shrinkage by effective sample size) and it decays when it is noise — which is most of the
time.

### 5.12 Markov / overlap bots

Key the next window on the previous window's extreme position. Windows overlap (consecutive
windows share four ticks), so the *outcomes* are correlated even though the *increments* are
not: a window with a high at position 5 leaves a high that the next window must beat. This is a
legitimate state, and it is implemented as the `position` expert. The measured skill is small and
market-dependent; on a fair CSPRNG feed the multiplicative-weights step shrinks it to a minority
vote.

### 5.13 Kernel / analog replay

"Find windows that looked like this one (RSI, slope, stretch, volatility expansion) and count how
they resolved." Legitimate, non-parametric, and the engine's `analog` expert. Its failure modes
are the usual ones — overlap, regime drift, too few neighbours — which is why it is shrunk toward
the frequency table by its kernel weight sum.

### 5.14 Online neural net / logistic ensemble

A softmax regression over state features, trained walk-forward on completed windows only. The
engine's `neural` expert. It never sees the future, and it is scored like every other expert, so
a decorative net loses its vote.

### 5.15 Martingale and other progressions

Multiply the stake after a loss to recover. On this contract the recovery target is a 27 %-at-best
event, so the expected number of consecutive losses before a win is 1/p ≈ 3.7 and the 99th
percentile run is ~15. At 2× per step, 15 losses is a 32 767× stake. **Verdict: it converts a
small negative expectation into a near-certain ruin.** The sniper does not implement it and
refuses to carry ladder state between cycles; every stake is recomputed from the next measurement
(`adaptiveStake`, tenth Kelly, drawdown-braked).

### 5.16 "Buy the extreme of the extreme" — conditional tie hunting

Because ties remove mass, the *strict* probability of the middle position rises when the market's
volatility expands (fewer ties). A model that forecasts the **next window's tie probability** from
recent tick size can therefore gain on positions whose quote was set from an unconditional tie
rate. The engine implements this as `tieForecast` (EWMA of recent window ties, shrunk to the
long-run rate, divided by the volatility expansion ratio) and it is the newest, most defensible
piece of conditional structure in v5. On a market whose tick size is large relative to σ, it can
be worth several points; on a fine grid it is ~1 point.

### 5.17 Latency / slip exploitation, and the opposite

The only remaining edge class is **quote staleness**: if the pay-out table is refreshed on a
5-minute cadence while volatility moves, an EV scan against a stale table will systematically
"find" edges that do not exist. The sniper mitigates it by (a) refreshing the tick table on a
short cadence, (b) marking a quote stale and widening its edge requirement, and (c) pricing an
entry-slip penalty (§9.4). This is the closest thing to a real exploitable inefficiency a retail
bot can reach, and it is small.

### 5.18 Summary table

| Strategy | EV before margin | EV after 5 % margin | Verdict |
| --- | --- | --- | --- |
| 5.1 EV snipe | model-dependent | model-dependent | **the only coherent thesis** |
| 5.2 fixed position | 0 | −5 % | anchor / benchmark |
| 5.3 all five positions | 0 | −5 % of 5 stakes | never |
| 5.4 both sides (10) | 0 | −5 % of 10 stakes | never |
| 5.5 high+low pair | 0 | −2 margins | operational only |
| 5.6 barbell 1+5 | 0 | negative | hit-rate smoothing |
| 5.7 probability ladder | 0 | negative (more legs) | variance control |
| 5.8 trend filter | small | usually swallowed | one expert among ten |
| 5.9 reversion filter | small | usually swallowed | one expert among ten |
| 5.10 digit filter | 0 | 0 (just fewer bets) | noise |
| 5.11 hot position | 0 | noise | decays in the mixture |
| 5.15 martingale | negative | ruin | refused by design |
| 5.16 tie forecast | 0 to +small | occasionally positive | new in v5 |
| 5.17 stale quotes | 0 | occasionally positive | priced and guarded |

**The honest summary.** High/Low Ticks is a fairly-priced digital option on an audited CSPRNG
walk. The expected value of any fixed rule is negative by the house margin; the only route to a
positive record is to beat the *quoted* odds on enough decisions that the margin is covered, and
then to size the bets so that a losing stretch does not end the session. Everything else — and
that includes most of the internet's "High/Low Tick sniper" bots — is a variance machine with a
subscription fee.

---

## 6. What "reading the market with high confidence" can mean, precisely

Confidence is only meaningful if it is measured. The engine separates four quantities that the
community routinely conflates:

| Quantity | Definition | Where it comes from |
| --- | --- | --- |
| **Probability** | the estimated chance the chosen `(side, position)` wins, tie-aware | the mixture of experts |
| **Confidence** | how much of that estimate is supported (agreement, sample, separation, skill) | scored walk-forward |
| **Certainty / edge** | probability minus the break-even implied by the **quoted** pay-out | the live payout table |
| **Record** | how often the decisions this rule actually published won | graded settlements |

A decision is only tradeable when all four line up. The journal prints all four, and a bot that
cannot clear them says which gate held it — an idle bot that cannot explain itself is
indistinguishable from a broken one.

### 6.1 Why a high probability is not a high confidence

On a fine grid the modal position sits at 27 % — a *loss* 73 % of the time. "High confidence" on
this contract means "the price is wrong by more than the noise in my estimate", not "I will
win". The engine's confidence therefore includes the **standard error of the estimate** and the
walk-forward **skill** of the experts carrying it, not just their agreement.

### 6.2 The self-grading loop

Every published decision is filed with the tick it was made on and graded when the window
settles. Two things are then true:

* The rule's realised hit rate is an *empirical* number that can be compared with the break-even
  its quotes required. If it is below, the estimate is running hot and the engine pulls the whole
  probability vector back toward the structural anchor by the ratio (it calibrates rather than
  parks, because a bot that stops publishing also stops grading and could never recover).
* The experts' Brier scores are recomputed walk-forward on the same stream, so an expert that
  was useful last hour and useless now loses its vote automatically.

On a fair market this loop converges to "no edge, stake at the exchange minimum, mostly wait" —
which is the correct behaviour, and the honest one.

---

## 7. Risk, sizing and the arithmetic of survival

* **Kelly for a digital**: `f* = (p(1+m) − 1)/m`. At `p = 0.30`, `m = 2.6` (a tick-1 quote),
  `f* = (0.30×3.6 − 1)/2.6 = 0.031` — 3 % of bankroll for a *genuinely* 30 % event. Tenth-Kelly
  (0.3 %) is the shipped default because the estimate is not genuinely known.
* **A negative edge sizes to zero**, and the engine passes the exchange minimum (0.35) instead so
  the strategy's risk gate — not the arithmetic — decides whether to trade. A stake of 0 is
  indistinguishable from a broken bot in the journal.
* **Drawdown braking**: the stake is divided by `(1 + drawdown)`, so a losing session de-risks.
  There is no state in which a loss raises the next stake.
* **Session brakes**: loss limit, profit target, balance percentage cap, maximum stake, losing
  streak cool-off. All are checked *before* the entry; none can cap the loss of a contract that
  is already open.
* **Variance is not small.** A 27 %-probability contract loses three times in four. A strategy
  that trades 200 contracts at a 30 % hit rate will see losing runs of 8–12 routinely. Any stake
  size that survives those runs is, by Kelly, small.

---

## 8. Execution checklist for this contract

1. `duration_unit = 't'`, `duration = 5`, contract types `TICKHIGH` **and** `TICKLOW`.
2. Send `selected_tick` on the `proposal` **and** on the `buy` — the buy's `selected_tick` is what
   settles; the proposal's only prices it.
3. Read the pay-out **per `(side, tick)`**. A single "payout" number is the tick-1 quote and will
   misprice every other position.
4. Never propose with `duration = 4`. Deriv will refuse it, and a bot that silently falls back to
   a 4-tick model is trading a shape that cannot settle.
5. `selected_tick` must be an integer 1–5; anything else is rejected (see
   `hedge-options.mjs`, which throws).
6. One contract at a time per window: a second purchase while the first is open lands in the
   *next* window with a different entry spot.
7. Keep the tick stream warm: 300–1000 quotes. Under ~256 completed windows the models refuse
   with `warming up`, by design.

---

## 9. The engine (v5) — how the sniper implements all of this

`vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-strategies.mjs`

### 9.1 Inputs

| Input | Meaning |
| --- | --- |
| `values` | the tick list, oldest first |
| `mode` | `'tick'` (this document), `'rise'`, `'step-hedge'` |
| `horizon` | contract duration in ticks (5 for this family) |
| `threshold` | absolute probability floor (off by default) |
| `options.payout` | fallback payout multiple before the first quote |
| `options.payouts` | **v5** — the live pay-out multiple for each of the ten outcomes, `[H1…H5, L1…L5]` or `{high:[…], low:[…]}` |
| `options.minEv` | **v5** — minimum expected value per unit staked for the chosen outcome |
| `options.maxTie`, `minAgreement`, `minEdge`, `minConfidence`, `requireEdge` | the existing gates |
| `options.evidence` | the rule's own graded record (`hits`, `samples`) |
| `options.interval` | **v5** — seconds per tick on this symbol, measured by the runtime |
| `options.latency` | **v5** — look-to-fill time in seconds, measured from the tick service |

### 9.2 Ten experts, scored walk-forward

`anchor` (tie-aware structural prior, §3), `frequency`, `transition` (Markov on the change pair),
`recent`, `analog` (kernel replay with the v5 features: RSI, slope, stretch, expansion, run
length, previous extreme position), `drift` (abstains on this contract), `serial` (positional
persistence), `neural` (online softmax over the v5 features, ten outputs), `regime`
(expansion → later extremes, reversion → earlier), and **`position`** (v5: Markov on the previous
window's strict extreme).

Each is scored with a per-outcome Brier loss on windows it would have predicted before they
resolved; the mixture weights follow the multiplicative-weights rule (`exp(−η·(brier − best))`),
so an expert that cannot read this market loses its vote on its own. The blend is shrunk toward
the anchor by its effective sample size, and each side is normalised over its own five positions
(the contract is priced per side, not over ten joint outcomes).

### 9.3 Tie forecasting and the win probability

`tieForecast` = EWMA of the last windows' tie indicator, shrunk toward the long-run tie rate by
the sample behind it, divided by the measured volatility expansion (clamped). The reported win
probability is `P(position) × (1 − tieForecast)`; the reported `tie` is the long-run figure the
DNA block uses to characterise the market.

### 9.4 Entry slip

`options.entrySlip` (ticks, default 0) shrinks the estimated edge by the overlap it costs: a
decision that is executed `s` ticks late shares `5 − s` of its window with ticks the model did
not see, so the conditional information decays roughly like `√((5 − s)/5)`. The preset ships
`1` for two-second markets and `1` for one-second markets, and the journal prints the penalty.

### 9.5 EV scan and the gate ladder

For every outcome with a known quote, `EV_i = p_i(1 + m_i) − 1`. The engine picks the highest
EV (falling back to the highest probability when fewer than four quotes are known) and then walks
the gates in order, naming the one that stops it:

1. `warming up` / `thin history` / `thin state` — not enough evidence to answer.
2. `execution` — the fill cannot land inside the first tick of the window (§9.8). A market that is
   too fast for the bot's own latency is refused, not discounted.
3. `tie risk` — the market's tie rate is above `maxTie` (the shape cannot settle reliably).
4. `below floor` — absolute probability floor, when set.
5. `no value` — **new in v5**: the *one-sigma lower bound* of the best EV is under `minEv`, printed
   with the quote, the fair odds and the floor it failed. The point estimate is not the gate: the
   bot buys the best of ten noisy estimates, and the maximum of ten is biased upward by about its
   own standard error, so `evLower = EV − evZ·(1+m)·√(p(1−p)/n)` is what has to clear the bar
   (`evZ` defaults to 1 on this family; 0 restores the naive comparison).
6. `no edge` — probability − break-even < `minEdge`.
7. `agreement` / `confidence` floors.
8. `own record` — optional veto when the graded record is below break-even.
9. The strategy's own money gate (`priceRiskAllowed`), and the session brakes.

### 9.6 Market DNA — the "reverse engineering" layer

`marketDna(values)` reduces the market to a fingerprint: window count, strict-extreme histograms
for both sides, tie rates, the arcsine and grid-walk priors, a chi-square displacement, the
per-position z-scores, the grid ratio `r` of §3.3, drift z, serial ρ, the expansion ratio, a
0–100 readability score and a one-line verdict. The sniper prints it at start-up and on a slow
cadence, gates entries on a minimum readability, and the same numbers drive the anchor's
granularity interpolation. It is *descriptive*, not predictive: it says what kind of market you
are standing on, so a Step Index is never priced with a Volatility 100 prior.

### 9.7 Self-audit

`priceScorecard` (record vs break-even), `priceLeague` (per-expert Brier skill against the
anchor), `priceAudit` (ensemble walk-forward skill, calibration factor, tie forecast vs
realised, quoted positions, label fidelity, and whether the record warrants standing down) —
measured journal lines that hold the bot to its own numbers.

### 9.8 The execution clock — v5

Five ticks is the contract; it is not a duration until the tick rate is known. The engine is
handed `options.interval` and `options.latency` by the runtime (the interval from the session's
own measured tick rate, falling back to the symbol class — 1 s for `1HZ*`, 2 s otherwise — and the
latency from the measured round trip of the tick service plus a small bookkeeping allowance), and
derives everything a bot needs to avoid lying to itself:

```
lag        = latency / interval                 (how many ticks the fill can slip)
fidelity   = clamp(1 − lag/2, 0.35, 1)          (P(settled window = scored window))
contract   = 5 × interval                       (the real duration, in seconds)
stakeable  = clamp((1 − 2·min(lag,1)) / 5, …)   (fraction of a cycle one buy covers)
concurrent = 5                                  (positions in flight at one ticket per window)
```

Three consequences, all of them measurable rather than rhetorical:

1. **A ten-second contract on a two-second market.** One buy covers a fifth of the cycle, so a
   High/Low Tick bot that wants continuous coverage must run *five* positions. Two-way hedging
   that pair gives up the edge it is trying to protect — that is what the hedge preset does on
   Step Index, and it is the wrong tool here.
2. **Label fidelity is a ceiling on learning.** With one tick of slip the labels are 90 % aligned
   at best; a 1-second market with a 1-second fill is 50 %. No model can learn faster than its
   labels are true, which is why the audit prints this next to the hit rate instead of hiding it.
3. **Slip past 0.75 of a tick is a refusal, not a discount.** The engine returns
   `execution — … the five-tick window would start late` and does not trade. `entrySlip`
   (§9.4) additionally shrinks the conditional estimate by `√((5−slip)/5)`, so a strategy that
   deliberately trades late still pays for the information it lost.

### 9.9 The two new report surfaces

* **`evTable` / `ladderRows`.** The whole ten-row ladder as the bot reads it off the screen:
  outcome label, conditional probability, win probability (after the tie discount), the live
  multiple, the fair multiple `(1−p)/p`, the break-even `1/(1+m)`, the EV of buying it, its
  standard error and the one-sigma floor the gate compares with `minEv`. Sorted by EV, it is the
  scan's input; printed as a table, it is the operator's.
* **`dna.tieBandHigh` / `tieBandLow`.** A Wilson interval on each measured tie rate. A market
  measured at 28 % ties with a ±3 % band is *not* "below 30 %" — it is unknown. The shipped
  `maxTie` gate stays deliberately conservative (it refuses on the point estimate, so a noisy
  sample cannot talk the bot into a tie-heavy shape), and the band is exposed for a strategy
  that would rather gate on the optimistic or pessimistic end itself.

### 9.10 The shipped preset, block by block

`src/lib/bot-store/bots/high-low-tick-sniper.xml`, generated by
`scripts/presets/gen_presets.py` (the single source of truth; `scripts/generate-price-bots.py`
is a thin alias that writes the same bytes).

| Where | Blocks | What it does |
| --- | --- | --- |
| Initialisation | `x_price_dna`, `x_price_payout_table`, `x_price_clock` | describes the market, the ladder and the clock before a contract is bought |
| Every tick | `x_price_auto_market` (scout) | moves to a readable market, at most every 15 minutes |
| Every tick | `x_price_decision` (12 inputs) | ten experts, EV floor `ai min ev`, entry slip, tie gate |
| Every tick | `x_price_decision_part` | side, tick, probability, EV, confidence, certainty, stand-down |
| Every tick | `x_price_risk`, `x_price_stake` | exposure gate, tenth-Kelly stake on the calibrated probability |
| Entry | `x_tick_decision_purchase` | sends `TICKHIGH`/`TICKLOW` with `selected_tick` directly |
| Settlement | `x_price_calibration`, `x_price_model_weights`, `x_price_audit`, `x_price_league`, `x_price_dna`, `x_price_clock`, `x_price_payout_table` | the self-audit cadence: 5 / 25 / 10 / 25 / 25 / 25 / 5 settlements |
| Anywhere | `x_price_contract_ev`, `x_price_contract_fair`, `x_price_market_score`, `x_price_dna_part` | read one number from the engine to build your own gate |

### 9.11 What the closed loop actually measures

The engine is pure, so the whole bot can be replayed: at every step it is given the ticks it
would have had, the ladder the market would have quoted, and the graded record of its own
decisions so far. On three pooled seeds of a fair ±1 step walk (2 200 ticks each, a decision every
five ticks, five-tick contract), with the ladder quoted at a multiple of the *fair* price:

| Ladder quoted at | Entries | Realised hit rate | Mean predicted | Mean believed EV |
| --- | --- | --- | --- | --- |
| 0.95 × fair (house over-round) | 64 | 25.0 % | 22.7 % | +15.8 % |
| 1.00 × fair | 168 | 24.4 % | 21.9 % | +17.1 % |
| 1.08 × fair (overpaid) | 427 | 24.4 % | 20.4 % | +20.1 % |
| 1.20 × fair (badly overpaid) | 695 | 17.8 % | 16.1 % | +29.3 % |

These are old exploratory results from a synthetic fixture, not an independently validated
backtest and not measurements of Deriv's prices. The simulation script and quote construction
were not retained in the repository, so the numbers are not currently reproducible. They predate
the delayed-score fix and must not be used as evidence of profitability or predictive skill.
In particular, a higher hit rate on selected trades does not establish a forecastable edge on an
independent walk. Each side and position has different quoted odds; hit rate alone cannot establish
profit. The notional one-sigma floor uses a heuristic effective sample size and does not establish
coverage under correlated, overlapping observations or model misspecification.

---

## 10. Honest limitations

* **Deriv prices this contract with the same mathematics you just read.** The arcsine structure
  is not a secret; a positive EV therefore means "my conditional estimate beats their model",
  which is a weak claim and often false.
* **Overlapping windows inflate every apparent edge.** Each tick belongs to up to five windows.
  Walk-forward scoring and shrinkage by effective sample size mitigate it; nothing eliminates
  it. Treat any replay with fewer than a few hundred windows as a rumour.
* **Execution slip is real** and unmodelled in most community bots.
* **Ties are losses**, and on grid-heavy markets they are a third of all windows.
* **Kelly on an estimated probability is not Kelly.** Fractional sizing is the only honest
  response to a parameter that is itself uncertain.
* **No backtest is a promise.** The only verifiable claim in this document is the arithmetic of
  §3–§4 and the fact that the shipped bot prints its own measured record.

---

## 11. References

- [c1] Deriv, *High/Low ticks* — contract description and FAQ (fixed five-tick duration, no early
  close, synthetics only). <https://www2.deriv.me/trade-types/options/digital-options/high-low-ticks/>
- [c2] Deriv API — `proposal` / `buy` parameters, including `selected_tick` for `TICKHIGH` and
  `TICKLOW`, and `duration_unit: 't'`. <https://deriv-com.github.io/deriv-api/>
- [c3] Deriv legacy docs, *Highest/Lowest Tick* — `TICKHIGH` / `TICKLOW`, five-tick window.
  <https://legacy-docs.deriv.com/docs/highestlowest-tick>
- [c4] Deriv community, *Minimum stake in Options: Synthetic Indices* — 0.35 USD.
  <https://community.deriv.com/t/minimum-stake-in-options-synthetic-indices/33453>
- [c5] Deriv, *Do brokers manipulate synthetic indices?* — audited CSPRNG, central broadcast,
  volatility-calibrated generation. <https://experts.deriv.com/insights/do-brokers-manipulate-synthetic-indices>
- [c6] TradingView, *Volatility 25 Index* — constant 25 % volatility, one tick every two seconds.
  <https://www.tradingview.com/symbols/DERIV-VOLATILITY_25_INDEX/>
- [c7] B. Feller / W. Feller, *An Introduction to Probability Theory and Its Applications*, vol. 1
  — the discrete arcsine law for the position of the maximum (Chung–Feller).

## 12. Reproducing the numbers

The enumerations and simulations in §3 and §5 are short enough to rerun:

```python
# Exact enumeration of the 32 five-tick +-1 paths (tick grid walk)
from itertools import product
counts, ties = [0]*5, 0
for steps in product([1, -1], repeat=5):
    path, price = [], 0
    for s in steps:
        price += s; path.append(price)
    top = max(path)
    where = [i for i, v in enumerate(path) if v == top]
    if len(where) == 1: counts[where[0]] += 1
    else: ties += 1
# -> counts = [6, 4, 2, 4, 6], ties = 10, total = 32
```

```python
# Granularity study: Gaussian increments rounded to a unit grid
import random
random.seed(11)
for r in (1, 2, 5, 25):
    hi, tie, n = [0]*5, 0, 120000
    for _ in range(n):
        price, path = 0.0, []
        for _k in range(5):
            price += random.gauss(0, r); path.append(round(price))
        top = max(path)
        where = [i for i, v in enumerate(path) if v == top]
        if len(where) == 1: hi[where[0]] += 1
        else: tie += 1
    print(r, [round(c/n, 4) for c in hi], round(tie/n, 4))
```

The TypeScript equivalents, including the arcsine prior, the grid-walk prior, the tie-aware
anchor and the EV scan, are pinned by `artifacts/deriv-signal-lab/tests/price-strategies.test.mjs`.

---

## 13. How to verify all of this in the repository

```bash
cd artifacts/deriv-signal-lab

# the engine, the risk gate, the presets and the wiring (38 tests)
node --experimental-strip-types --test ./tests/price-strategies.test.mjs

# structural checks on every shipped strategy file
python3 scripts/presets/validate_presets.py src/lib/bot-store/bots/*.xml

# regenerate the presets from their single source of truth, then re-validate
python3 scripts/presets/gen_presets.py \
    src/lib/bot-store/bots/rise-fall-ensemble.xml \
    src/lib/bot-store/bots/step-rise-fall-hedge.xml \
    src/lib/bot-store/bots/high-low-tick-sniper.xml

# mocked browser run (needs the app served and Playwright installed)
pnpm test:dbot:browser
```

What the tests pin, in one place:

| Claim | Where it is checked |
| --- | --- |
| The five-tick strict-extreme distribution is `[6,4,2,4,6]/32`, ties 10/32 | `gridStrictPrior` test |
| A tie is missing mass, not a rounding error | win-probability test (§9.3) |
| The EV scan buys the mispriced position, not the likeliest one | ladder test (§9.9) |
| The ladder, the clock and the tie bands reach the runtime and the toolbox | wiring test (§9.8–9.10) |
| A record below break-even can stand the bot down | `standDown` test |
| No preset can martingale | preset test (`no multiplier`, `no ladder state`) |
| Every preset ships a five-tick horizon, the EV floor and the slip | preset test |

`price-strategies.mjs` is pure: it takes a tick list, a mode and options and returns a plan. No
I/O, no clock, no global state. Everything that touches the account — proposals, the payout
ladder, latency, the graded record, the market switch — lives in
`Interface/VisionInterface.js`, which is where the runtime's measurements enter and where the
plan is filed for grading.

---

## 14. Fresh verification pass (29 October 2026)

On top of the standing research above, every externally checkable claim was
re-verified against Deriv's current published pages, and the community
strategy landscape was re-surveyed. Findings:

### 14.1 Contract facts, re-confirmed

| Fact | Status | Source |
| --- | --- | --- |
| Five-tick window, fixed, not configurable | confirmed | [trade-types][c8] FAQ: "always based on the next 5 price ticks" |
| No early close on High/Low Ticks | confirmed | [trade-types][c8] FAQ: "cannot close before it expires" |
| Synthetics only | confirmed | [community][c3] note; [trade-types][c8] |
| `selected_tick` 1–5 on `TICKHIGH` / `TICKLOW` | confirmed | [api][c2] `proposal` args; [legacy][c3b] trading flow |
| Quote per `(contract_type, selected_tick)` via `proposal` | confirmed | [api][c2]; [legacy][c3b] flow steps 4–5 |
| Entry spot = first tick after processing | confirmed | [community][c3] |
| Equal-extreme settlement rule | **still unspecified** in the cited description | [trade-types][c8] says only "highest/lowest" |

Nothing in the re-verification moves the engine's conservative assumption: a
shared extreme on the selected side is still treated as a loss until Deriv
documents otherwise, and demo settlement records remain the way to confirm it.

### 14.2 Generation and fairness, re-confirmed

Deriv's current explanation states the synthetic feed is produced by
**cryptographically secure RNG**, calibrated to each index's stated
volatility, **broadcast identically to all clients from one central
algorithm**, and **audited by independent third parties** [rng][c5]. The
consequences drawn in §2 stand: apparent stop-hunts are variance plus trader
behaviour, and no retail model observes anything the pricing engine does not
already know. Any edge claim must therefore survive the question "what does my
model see that Deriv's pricing model does not" — and the only answers this
repository accepts are conditional structure (§3.4, §5.16), quote staleness
(§5.17), and cross-market quote dispersion (§15.8), all measured, none assumed.

### 14.3 The community landscape, surveyed

The strategies actually being sold and shared for this family fall into a
small number of buckets, each already priced in §5:

* **Fixed-position snipers** ("always tick 1/5") — §5.2. Win more often than
  1-in-5, paid exactly for it. Usually bundled with a martingale, which turns
  a −5 % expectation into a ruin distribution (§5.15, §15.10).
* **Coverage "hedges"** (all five, both sides, high+low pairs) — §5.3–§5.5.
  Variance reshaping at a cost of one margin per leg. Anything advertised as
  "risk-free coverage" is §5.4 with a subscription fee.
* **Candle/SMA/RSI trend filters with progressions** — §5.8 plus §5.15. The
  filter contains a real but small tilt; the progression contains the ruin.
* **Digit and "hot position" filters** — §5.10–§5.11. Sample-size reducers
  sold as signal.
* **Quote-driven tick pickers** — the sound idea in the wild: read live Deriv
  quotes, compute per-tick win value, skip below a minimum edge. That is the
  EV scan of §9.5 independently re-discovered, and it is what the shipped
  sniper does with a one-sigma floor instead of the point estimate.
* **Streak protection, cooldowns, recovery stakes** — session engineering.
  Streak stops and cooldowns are honest variance control (the shipped
  cool-off); "payout-sized recovery stakes" are a martingale in formal dress
  and inherit its arithmetic (§15.10).

No surveyed approach contains structure outside §3–§5 that survives the
pricing-model question. The catalogue below therefore treats each family at
full depth instead of chasing novelty.

---

## 15. Strategy breakdowns — the complete field guide

§5 catalogued the families; this section works each one to its arithmetic
conclusion so no intuition is left unpriced. "Fair" below means the walk of §3
at the market's own granularity, and the margin illustration is 5 %.

### 15.1 End-bias sniping (ticks 1 and 5)

The thesis is the arcsine/grid structure itself: the extreme sits at an end
far more often than anywhere else. Exact fair multiples (profit per unit
staked, `(1−p)/p`):

| Position | Continuous (fine grid) | Pure ±1 grid walk |
| --- | --- | --- |
| Tick 1 / 5 | 2.66× | 4.33× |
| Tick 2 / 4 | 5.40× | 7.00× |
| Tick 3 | 6.11× | **15.00×** |

At a 5 % margin the quoted ends sit near 2.5× / 4.1×. The win rate feels good
(27 % / 18.75 %) and the EV is exactly −margin. The only honest use of the
end bias is as the **anchor every expert must beat** — which is what the
engine's Brier league does.

### 15.2 Middle-overlay hunting

The rarest position is where a mispricing pays the most *if* it exists: at
6.25 % unconditional on a step walk, each point of probability is worth
roughly 2.4 points of EV at a 15× quote. But rarity cuts both ways —
estimating a 6 % event to ±1 point needs ~2,000 settled windows, and the
one-sigma EV floor in §9.5 exists precisely because the scan's argmax over ten
noisy estimates would otherwise "find" middle overlays on every fair ladder.
Middle overlays are bought only when the *floor* clears `minEv`, never the
point estimate.

### 15.3 The barbell (ticks 1 + 5), worked

Two legs at ~27 % each (fine grid), ~2.6× quotes, total capture ~55 % of
windows. Per-unit EV is still −margin, but the *distribution* is the point: a
55 % hit rate at ~2.6× has roughly a third the per-cycle variance of a 14 %
position at ~6×, so a session survives long enough to measure whether an edge
exists at all. The engine's `certainty` gate prefers this region for exactly
that reason — not because it pays better, but because it teaches faster.

### 15.4 Ladder weighting and why the single best leg dominates

Stake `wᵢ` on outcome `i` with per-unit EV `eᵢ`: portfolio EV per unit is
`Σwᵢeᵢ/Σwᵢ`, a weighted average that cannot exceed `max(eᵢ)`. Probability
weighting therefore never beats buying the single best leg — it only smooths
variance and pays margin on more contracts. The shipped sniper buys one leg;
ladder weighting remains available as a *variance* tool for operators who need
smoother equity, priced honestly as costing edge, not creating it.

### 15.5 Trend-timing the extreme, sized

From §3.4: a drift of 0.6 grid steps/tick moves the modal high from 25.5 % to
30.1 %; a drift of 2.0 moves it to 39.9 %. Against a 5 % margin the first is
worth about +2 points of EV on the modal leg — real, but only when the drift
is *measured inside the window*, not inferred from a 5-minute candle two
hundred ticks away. The engine's `regime`, `volatility`, `microtrend` and
`hurst` experts encode exactly this tilt, and the walk-forward league decides
per market whether the tilt earned its weight or is decoration.

### 15.6 Volatility-timing the tie (conditional tie hunting)

Tie probability falls as σ-per-tick rises (§3.3: 70.5 % at r=0.5 → 2.7 % at
r=25). A model forecasting the *next window's* tie rate from recent tick size
therefore moves the unconditional win probability of every position — most
visibly the middle, whose strict probability is tie mass subtracted from a
small base. The `tieForecast` (EWMA of recent ties, shrunk to the long run,
divided by expansion) plus the `range` expert's granularity interpolation are
the implementation. Worth several points on coarse tape, ~1 point on fine
tape — the most defensible conditional structure in the engine, and still
usually smaller than the margin.

### 15.7 Quote-staleness sniping

If the ten-quote ladder refreshes slower than volatility moves, an EV scan
against a stale table systematically "finds" edges. The defence is the
offence here: refresh the ladder on a short cadence, mark quotes stale and
widen their edge requirement, and charge entry slip. Any residual overlay the
scan finds after those guards is the closest thing to a tradeable inefficiency
a retail bot can reach — small, fleeting, and correctly sized tenth-Kelly.

### 15.8 Cross-market rotation (the scout's thesis)

High/Low Ticks are quoted on every synthetic index, and the ladders, tie rates
and tick speeds differ. Rotation helps for three boring, real reasons: (1) a
market whose ladder is kinder to the modal position pays more for the same
read; (2) a market whose granularity the engine models better (higher DNA
readability, positive walk-forward skill) wastes less of the estimate; (3) a
market whose tick rate fits the bot's latency preserves label fidelity. The
cost is a cold tick stream (~256 windows before the models publish), which is
why the dwell is fifteen minutes and the floor is low. Rotation is market
*selection*, not prediction — and the scout score (EV, certainty,
readability, sample, skill) is a ranking, never a forecast.

### 15.9 Session engineering (streak stops, cooldowns, targets)

A 27 %-probability contract loses three times in four; runs of 8–12 losses
are routine over 200 contracts. Streak cool-offs, loss limits and profit
targets do not change the per-contract EV — they change the *stopping
distribution*: they cut the left tail (ruin) at the cost of cutting the right
tail (recovery). That is honest risk control and it ships in the sniper. What
session engineering must never do is resize the *next* stake from the *last*
result — that is §15.10.

### 15.10 What never works, and the arithmetic of why

* **Digit filters.** The last digit of the entry quote is independent of the
  window's order statistics on a CSPRNG feed. A filter keeps 1-in-k entries
  and the same per-entry EV: a sample-size reducer with marketing.
* **Martingale / recovery stakes.** The recovery event wins at best 27 % per
  attempt; the 99th-percentile losing run is ~15 contracts, a 32,767× stake at
  2× steps — before Deriv's stake limits or the account balance ends the
  sequence early (which converts "recover with certainty" into "lose the
  ladder with certainty"). Any "payout-sized recovery" inherits this exactly.
* **Full coverage.** Ten legs, ten margins, zero variance, certain loss of the
  over-round. §5.3–§5.4 with the numbers attached.
* **"AI" with no graded record.** A probability without a ledger is a story.
  The sniper's rule — every published decision filed and graded, calibration
  from the record, stand-down when the record fails — is the minimum viable
  honesty for any automated strategy on this family, and most commercial bots
  fail it.

---

## 16. The v6 APEX engine — how the sniper implements all of this

`vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-strategies.mjs`
(`PRICE_MODEL_VERSION = 6`), wired through `VisionInterface.js`, the
`x_price_*` blocks and `scripts/presets/gen_presets.py`.

### 16.1 Sixteen experts, each scored walk-forward

The original ten (§9.2) plus six v6 specialists. Every expert produces a full
probability vector (ten outcomes in tick mode, two in directional mode) and is
scored with delayed Brier losses on settled windows only:

| Expert | Reads | Tick behaviour | Directional behaviour |
| --- | --- | --- | --- |
| `anchor` | market tie rate | tie-aware arcsine/grid prior | tie-removed 50/50 |
| `frequency` | all settled windows | long-run histogram | long-run up/down |
| `transition` | two-change state | Markov row for ↑↑/↑↓/… | same |
| `recent` | last 250 windows | regime-drift histogram | same |
| `analog` | kernel over state | replay of similar moments | same |
| `drift` | drift/vol | abstains (anchor) | N(drift·h, σ√h) |
| `serial` | AR(1) | extreme-position persistence | change persistence |
| `neural` | 8 features | deep net (§16.2) | deep net, 2 outputs |
| `regime` | expansion/stretch | late/early extreme tilt | continuation/reversion |
| `position` | last window | extreme-position Markov | direction Markov |
| `volatility` | expansion × slope | expansion-scaled late/early tilt | expansion-scaled continuation |
| `microtrend` | RSI + slope | continuous pressure lean | z-scored lean |
| `range` | expansion | grid↔continuous prior interpolation | abstains (anchor) |
| `entropy` | shape concentration | persists concentrated shapes | persists concentrated direction |
| `hurst` | R/S exponent | memory tilt (trend/revert) | memory z-score |
| `cycle` | phase autocorr | extreme-phase persistence | sign-phase persistence |

Abstention is always to the frequency table or the anchor — never to zero —
so a useless expert dilutes toward the base rate and then loses its vote.

### 16.2 The deep brain

`neural` is an online 8 → 10 (tanh) → softmax network over the state features
(bias, two change signs, RSI, stretch, expansion, run, history position),
trained with one backpropagation step per settled window (learning rate 0.05,
L2 decay 0.0005). The hidden layer learns feature interactions — "stretched
*and* quiet" — a linear model cannot express; the L2 decay and the Brier
league keep it from memorising noise. `decision.brain` reports its update
count, hidden-layer weight norm, learning rate, the live regime, the three
experts carrying the decision, skill and calibration; `x_price_brain` prints
it in one journal line.

### 16.3 The regime-gated meta-learner

Beside the global Brier ledger the engine keeps one ledger per regime
(expansion / reversion / balanced, from §9.2's `tickRegime`). The live mixture
blends the global weights with the live regime's weights (45 % regime once 25
windows are scored in it), so trend readers are trusted when a trend is on and
range readers when it is not. The walk-forward replay scores the *gated*
blend, so `skill` measures the mixture that actually publishes — the same
honesty rule as v5, extended to the gate.

### 16.4 DNA v2 and auto-tuning

Beside the v1 fingerprint (§9.6), `marketDna` now measures Hurst memory,
high/low extreme entropy, jump (spike) rate, extreme-phase autocorrelation,
tie clustering (Fano factor), range compression and tick sigma — and derives
`autoTune` from them: grid tape widens the EV bound to 1.5σ, mixed tape to
1.25σ; spike tape raises anchor trust; compressed tape earns a patience note.
`x_price_reverse` prints the whole diagnosis. Descriptive, never predictive:
it says what kind of market the bot stands on and what caution that implies.

### 16.5 Per-outcome calibration

The runtime grades every published decision per outcome (ten lanes for
High/Low Tick, two for directional) and the engine reliability-adjusts each
outcome against what *that outcome* claimed — same shrinkage curve as the
global record (§9.5), applied per lane, renormalised per side. A high-tick-3
read that keeps missing is shrunk without punishing the reads that earned
their keep. Inactive below 25 graded samples per lane.

### 16.6 New blocks, knobs and journal cadence

| Surface | Purpose |
| --- | --- |
| `x_price_brain` | AI core line: net updates, weight norm, regime, carriers |
| `x_price_reverse` | reverse-engineering line: DNA v2 + auto-tune |
| `x_price_forecast` | outcome forecast: top positions by EV with p and quotes |
| `ai skill floor` | hard gate on walk-forward skill (ships −1 = off) |

Start-up prints DNA, ladder, clock, brain and reverse engineering; every 25th
settlement prints weights, league, DNA, brain, reverse and clock; every 10th
the audit; every 5th the ladder and the forecast. The preset test pins all of
it, and the no-martingale pins (no multiplier, no ladder state, settled
contracts never resize the stake) still hold.

### 16.7 Scout v2

The market score is now 35 % measured EV, 20 % certainty, 15 % DNA
readability, 15 % sample and 15 % walk-forward skill — the same ranking idea,
with the blend's earned record voting on whether a market is worth standing
on. Dwell and floor unchanged (15 minutes, low): rotation stays rare and
deliberate.

### 16.8 What v6 does not claim

More experts do not create edge on an audited CSPRNG feed — they create
*resolution*: a fair market is recognised as fair faster, from more angles,
with the recognition printed in the journal. The honest summary of §5.18 is
unchanged: expected value comes only from beating the *quoted* odds, the
margin is merciless in aggregate, and the bot's job is to price ten contracts,
buy mispricings, size tenth-Kelly, and say plainly which gate stopped it when
there is nothing worth buying. v6 does that job with sixteen models, a deep
brain, a regime gate, a deeper fingerprint and a per-outcome ledger — and the
same refusal to pretend.

---

## References (added in the October 2026 pass)

- [c8] Deriv, *High/Low ticks* — trade-type page and FAQ (fixed five-tick
  duration, no early close, synthetics). <https://www2.deriv.me/trade-types/options/digital-options/high-low-ticks/>
- [c3b] Deriv legacy docs, *Highest/Lowest Tick* — API trading flow
  (`TICKHIGH`/`TICKLOW`, proposal → buy → monitor).
  <https://legacy-docs.deriv.com/docs/highestlowest-tick>

### 16.9 The cadence rebalance (why the sniper trades every cycle)

The v6 sniper first shipped in the selective posture: entry "only with a
measured edge", `ai min ev` 0.01 against a one-sigma lower bound, agreement
0.5, confidence 50. Measured against live-like ladders (fair multiples at a
5 % margin), that posture published **0 entries in ~800 decision points** on
R_100-like tape and 24 on step-like tape — refused by `no value` on nearly
every tick. A bot that never trades teaches nothing and earns nothing, so the
preset was rebalanced to the cadence the Rise/Fall and hedge presets already
keep: **the best-ranked of ten on every readable cycle** (entry "on the best
read available", EV veto 0, agreement 0), with Kelly sizing thin reads to the
exchange minimum and the journal printing the EV, quote and record behind
every entry. The same measurement publishes on nearly every readable cycle —
about one position per contract length live (five ticks plus re-entry), well
above one per minute on R_100. The DNA floor (35), the tie gate, the
losing-streak cool-off (paced by `ai min confidence` 50), the stand-down and
the session brakes all still apply; only the value vetoes moved from "refuse"
to "rank and size". To restore the selective sniper: entry "only with a
measured edge", `ai min ev` 0.01, `ai min agreement` 0.5.

The rebalance also completed the decision block's design: the "entry %12"
selector the message, toolbox and docs always described never had a backing
dropdown, so the `REQUIRE` field in saved XML never reached the runtime and
every strategy silently ran in edge mode (the zero thresholds of the
directional presets made that vacuous, which is why nobody noticed). The
`REQUIRE` dropdown now exists, defaults to "only with a measured edge", and
the wiring test pins it.
