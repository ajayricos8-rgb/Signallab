# Even/Odd on Deriv — the complete research dossier

*Why this document exists: the AI Even Switcher in the bot store trades one
contract family — DIGITEVEN / DIGITODD — and everything it does has to trace
back to a verifiable fact about those contracts. This dossier collects the
official mechanics, the mathematics, every strategy family worth naming, and
the mapping from research to the v2 bot's engine. Figures that come from
Deriv's own publications are cited; figures computed here show their working.*

## 1. The contract

Even/Odd is a **Digits** digital option. It predicts whether the **last digit
of the last tick** of a contract is even or odd. Even wins on 0, 2, 4, 6, 8;
Odd wins on 1, 3, 5, 7, 9 [4](https://community.deriv.com/t/options-to-trade-in-deriv-digital-options-2nd-part/41248).
There is no third outcome: every digit is even or odd, so **Even/Odd cannot
tie**. That single fact shapes the whole strategy space — unlike Rise/Fall
(where exit == entry loses both sides) or Matches (nine ways to lose), every
Even/Odd contract ends in exactly one winner.

The settled facts:

- **Decision variable.** The final digit of the quote — the digit in the last
  decimal place the market is quoted to. Deriv's own charting emphasises
  exactly this digit whenever a digit contract is selected
  [2](https://github.com/deriv-com/deriv-smartcharts/pull/293).
- **Duration.** Tick contracts only, **1 to 10 ticks**
  [4](https://www.intraquotes.com/learn/binary-options/deriv-over-under-strategy).
  Deriv's official guide states the duration of digit trades cannot exceed 10
  ticks [2](https://www.slideshare.net/slideshow/an-introduction-to-synthetic-indices-trading-derivcom/252337517).
- **Entry spot.** As with the other digit contracts, the contract's ticks
  start with the first tick **after** the servers process the purchase — a
  5-tick buy settles on ticks t+1 … t+5. The purchase itself takes time to
  process, so by the time Deriv acts the next tick may already have printed
  and the entry slides one tick late. The v1 bot and the vision engine both
  forecast **duration + 1 ticks out** for exactly this reason; the v2 engine
  names it honestly — `entry slip`, default 1 — while the grading ledger
  always scores against the true contract length.
- **Markets.** Digits trade on **14 synthetic pairs: the 10 Volatility
  indices and 4 Jump indices**, 24×7
  [2](https://www.intraquotes.com/learn/binary-options/deriv-odd-even-strategy).
  Crash/Boom, Step and the 1s-volatility cousins outside the list do not
  offer the family. Concretely the universe is R_10/25/50/75/100,
  1HZ10/25/50/75/100V, and JD10/25/50/100 (JD75 is absent from every digit
  listing found, so the scout does not walk it). No forex, no real-world
  market offers Even/Odd.
- **Payout.** Both sides pay the **same multiple**, about **1.9–1.96×** the
  stake (a published ticket shows 96.10% return on both Even and Odd
  [2](https://www.intraquotes.com/learn/binary-options/deriv-odd-even-strategy)).
  The v2 engine never trusts a typed number: it reads the live DIGITEVEN /
  DIGITODD proposals per market and falls back to 1.95× only before the
  first quotes arrive.
- **Settlement.** Automatic at expiry; profit or loss hits the balance with
  no closing trade
  [4](https://static.deriv.com/marketing/how-trade-syntheticindices-fa.pdf).
  The bot never relies on an early close.
- **Minimum stake.** 0.35 in account currency, as everywhere on Deriv.

The API surface (for reference — the bot buys through DBot purchase blocks,
but the payout table is read through proposals): `proposal` with
`contract_type` DIGITEVEN or DIGITODD, `duration` + `duration_unit: 't'`,
`amount`, `basis: 'stake'`, `currency`, `symbol`. Even/Odd takes **no
barrier and no prediction** — there is nothing to predict except the side
[1](https://deriv-com.github.io/deriv-api/). Availability per symbol comes
from `contracts_for`.

## 2. The mathematics (with the working shown)

### 2.1 Fair value and the margin

On a stream where each digit lands ~10% of the time, P(even) = P(odd) = 0.5
exactly. At a payout multiple m the break-even win rate is **p\* = 1/m**:

| multiple | break-even | margin over fair |
|----------|-----------|------------------|
| 1.90×    | 52.63%    | 2.63 pt          |
| 1.95×    | 51.28%    | 1.28 pt          |
| 1.961×   | 50.99%    | 0.99 pt          |

So the bot must be right **~51–52.6%** of the time just to stand still.
Any strategy note that does not clear this bar with measured numbers is a
story, not an edge. The engine's EV gate compares `p·m − 1` per side
against the **live** multiple, never a brochure figure.

### 2.2 What it takes to *measure* a payable lean

The standard error of a parity share on n ticks is √(0.25/n):

| ticks | 1σ noise | can it resolve a 1-pt edge? |
|-------|---------|------------------------------|
| 60 (cold stream) | 6.45 pt | no — noise is 6× the margin |
| 1,000 (DTrader panel) | 1.58 pt | no — noise still exceeds the margin |
| 2,500 | 1.00 pt | borderline (1σ) |
| ~9,600 | 0.51 pt | yes, at 2σ |

The honest reading of DTrader's own last-1000-ticks panel: a parity share
of 51.5% on that panel is **one sigma of noise**, and the margin needs
51%+. The panel cannot resolve a payable edge — it can only suggest where
to look. This is why the v2 engine shrinks every estimate toward 50% by
its effective sample size, publishes the t-statistic of every lean, and
lets the stake — not the story — carry the uncertainty.

### 2.3 Streaks are normal, "due" is a fallacy

On a fair coin, P(k straight losses) = 2^(−k): four in a row is 1/16, six
is 1/64 per window — and across 300 trades a six-streak is expected
**several times over**, not once
[1](https://blog.binarybot.live/strategies). The expected longest even-run
in a 1,000-tick panel is ~log2(1000) ≈ **10**. Ten evens in a row on that
panel is the *median* outcome, not a signal, and the next tick is still
50/50: synthetic ticks are independent draws, and a digit absent for 40
ticks is still a 10% draw
[2](https://blog.binarybot.live/best-deriv-bots-digit-analyzers).

The generator behind the ticks is a single central CSPRNG, audited
independently, blind to accounts — the full findings are in
§13 of `high-low-ticks-research.md` and are not repeated here. Nothing in
this dossier claims the stream is predictable in principle; the engine
measures conditional structure (transitions, runs, regimes) that exists in
*any* finite stream and prices it against the margin honestly.

### 2.4 Why consecutive digits are *not* independent draws

Independence of the RNG does not imply independence of consecutive last
digits. Quotes move a fraction of a pip most ticks on most markets, so the
last digit **repeats** far more often than 10%: the digit stream has
positive autocorrelation at lag 1, decaying with horizon. That is the only
structural fact the parity engine leans on, and it is measured per market
(transition matrix, repeat rate, parity autocorrelation), never assumed.
At a 1-tick horizon the conditioning is strongest; by 10 ticks it has
mostly washed out — which is why §5.8 treats tick-size selection as a
first-class decision.

## 3. The last digit, mechanically

- **Pip sizes differ by market** (R_100: 2 decimals, R_50: 4, Jump: 2, some
  1s markets: up to 5 — third-party measurement
  [1](https://github.com/RhysZona/deriv-signal-scanner)). The engine infers
  the pip size from the tick stream itself (`inferPipSize`), so a market
  that re-quotes never silently corrupts the digit extraction. A trailing
  zero is a digit 0, not a missing digit — digit extraction preserves it.
- **The tick statistics panel** on DTrader shows the last 1,000 ticks'
  digit percentages
  [2](https://www.intraquotes.com/learn/binary-options/deriv-odd-even-strategy).
  It is the source of every "digit bias" strategy in §5.1 and of the
  sample-size trap in §2.2.
- **Jump markets** add scheduled volatility jumps to the base cadence. A
  jump prints a far digit and breaks every run in progress — the engine's
  regime reader watches for exactly this (volatility expansion ⇒ stop
  extrapolating runs).

## 4. Entry timing and the contract clock

A 5-tick Even/Odd on R_100 (2 s ticks) lives ~10 s plus the fill; on a 1 s
index ~5 s; a 1-tick contract on a 1 s index settles about a second after
the fill. The bot re-enters on the cycle after each settlement, so the
cadence is roughly **one position per contract length**: ~5–6/minute at
5 ticks on R_100, up to dozens per minute at 1 tick on a 1 s market. The
entry tick is the tick *after* the purchase (§1), so every forecast the
engine makes is aimed at duration + 1 ticks out, and the journal prints
the horizon it scored so a duration mismatch is visible, not silent.

## 5. The strategy families, broken down

Every Even/Odd strategy ever sold or shared is one of these eleven, or a
stack of them. Each gets the same treatment: the thesis, the math, the
verdict.

### S1 — Digit-frequency bias tracking ("play the panel")

*Thesis:* read the last-1,000-ticks percentages; trade the parity whose
digits are "hot" (even/odd) or, in the Matches/Differs version, Differs on
the coldest digit at 5–7 ticks
[5](https://www.intraquotes.com/learn/synthetic-trading/deriv-matches-differs-strategy).
*Math:* §2.2 — the panel's 1σ noise (1.58 pt) exceeds the margin, so a hot
parity on the panel is evidence of nothing by itself. *Verdict:* a
ranking tool, not an entry signal. The v2 engine keeps it as the
`frequency` / `share` experts with honest shrinkage — a 1,000-tick lean
keeps most of its weight, a 60-tick lean keeps almost none.

### S2 — Parity proportion tracking (even share over windows)

*Thesis:* maintain the even share over rolling windows (50/100/500) and
trade the majority. *Math:* identical to S1 with smaller n and fresher
data — faster to react, noisier per read. *Verdict:* useful as a *recent*
expert against the long-run anchor; dangerous alone because window choice
is a free parameter that backtests overfit. The engine runs both horizons
and lets walk-forward skill weight them.

### S3 — Markov transition tracking

*Thesis:* condition on the current digit — P(even at expiry | digit now) —
from the 10-bin transition rows, projected to the horizon by matrix power.
This was the v1 bot's core (five `m_transition` blocks summed into one
score). *Math:* the only family that exploits §2.4's real structure. Its
weakness is row thinness: a 1,000-tick history spreads ~100 samples per
row, and per-row SE ≈ 5 pt — the v1 bot's 65/35 blend with even share and
n/(n+64) shrinkage was the patch. *Verdict:* the strongest classical
family, and the v2 engine keeps it three ways (10-bin digit row, 2×2
parity row, order-2 parity rows), each projected to the true horizon and
each shrunk by its own row count.

### S4 — Streak continuation vs reversion (runs and alternation)

*Thesis (continuation):* runs persist — buy the parity that's printing.
*Thesis (reversion):* runs break — buy the opposite after k in a row.
*Math:* on a fair stream both theses have expectancy −margin; on a sticky
digit stream (§2.4) continuation has a small positive expectancy at lag 1
and reversion has it nowhere. The runs test (Wald–Wolfowitz) and the
alternation ratio tell the two regimes apart: fewer runs than expected ⇒
sticky ⇒ lean continuation; more runs ⇒ alternating ⇒ lean reversion.
*Verdict:* never a fixed rule — a *measured* one. The engine's `streak`
and `alternation` experts implement exactly this, and the DNA prints the
runs z-score so the journal shows which regime the bot thinks it's in.

### S5 — Martingale and recovery ladders

*Thesis:* size up after losses (×2 classically, ×1.5–2.5 in "soft"
ladders, capped at 4–6 steps) so one win recovers the run. *Math:* on a
50/50 contract a ×2 ladder from 0.35 risks 0.35+0.70+1.40+2.80+5.60 =
**10.85 to win ~0.34**; the 5-loss run that wipes it arrives with
probability 1/32 per window — about **nine times** across 300 trades.
Capped ladders convert many small wins into occasional large losses with
the *same* negative expectancy and much fatter tails; uncapped ladders
add ruin. Third-party teardowns agree: martingale "works until the losing
streak arrives, and it always arrives"
[5](https://blog.nextrader.live/deriv-bot-guide). *Verdict:* the v2 bot
ships flat-by-Kelly with **no ladder** — a loss lowers the next stake.
The capped-ladder code the v1 bot carried is gone: a recovery ladder on a
near-fair parity stream only makes the drawdown steeper.

### S6 — Anti-martingale and Kelly sizing

*Thesis:* size with the edge — full Kelly f\* = (p·m − 1)/(m − 1), or a
fraction of it. *Math:* at p = 0.52, m = 1.95, full Kelly risks ~1.6% of
bankroll; the engine bets **tenth-Kelly**, floored at the 0.35 exchange
minimum, capped by max-stake and balance-percent, and divided down while
the session is losing. Thin reads therefore trade the minimum; only a
measured lean moves the stake. *Verdict:* the only sizing family the bot
ships. A loss can never raise the next stake — pinned by test.

### S7 — Multi-market switching (the scan)

*Thesis:* fourteen digit markets (§1) never all look the same; stand on
the most readable one. *Math:* switching trades a warm 1,000-tick history
for a cold stream — every switch pays the §2.2 sample-size tax until the
new market's history deepens, and needs its own payout table warmed.
*Verdict:* roam, but slowly. The v2 scout scores every digit market on
measured EV, certainty, readability, sample and skill, moves only under a
score floor, and never more often than the dwell time (90 s default).
Score smoothing (60/40) stops single-tick flicker from causing a switch.

### S8 — Tick-size selection (1 vs 5–7 vs 10)

*Thesis:* short contracts exploit lag-1 stickiness (§2.4); longer ones
smooth noise. *Math:* dependence decays with horizon, so the 1-tick
forecast has the strongest conditioning and the fastest churn; 5–7 ticks
is the folk default because it balances conditioning against per-decision
noise
[5](https://www.intraquotes.com/learn/synthetic-trading/deriv-matches-differs-strategy);
10 ticks is nearly memoryless. *Verdict:* the engine scores whatever
duration the trade options carry (1–10) and forecasts duration + 1. The
preset ships **5 ticks** — the calm cadence (~5/minute on R_100) — with
1 tick documented as the high-churn alternative. Duration and forecast
horizon are pinned equal by test: a bot scoring 5 ticks and buying 1 is
the classic silent mismatch.

### S9 — Indicator overlay (RSI/EMA "trend alignment")

*Thesis:* trade Even in RSI-confirmed uptrends, Odd in downtrends, on the
claim that momentum biases digit parity
[3](https://profitmaxtrader.com/post/deriv-even-odd-strategy-using-indicators).
*Math:* no mechanism is offered, and none is visible: trend moves the
*level*, parity lives in the last *digit*, and a drift of several pips
per horizon wraps the digit distribution back toward uniform (the
engine's Fourier mapping in `digitDistributionFromPrice` shows the
collapse term explicitly). Any backtested correlation is drift-sign ×
digit-phase coincidence. *Verdict:* not implemented. RSI/drift/volatility
enter the engine only as *features* (regime, analog distance, neural
inputs), never as side signals.

### S10 — Parity switching (measure every cycle, buy the favoured side)

*Thesis:* the v1 bot's primary mode bought **Even only** and touched Odd
solely in loss-recovery — half the contract family, gated by red ink.
The professional posture is symmetric: score both sides every cycle and
buy whichever the measurement favours. *Math:* switching does not change
per-trade expectancy — it doubles the bot's opportunity surface and
removes the structural Even bias that made the v1 record unreadable (an
all-Even record cannot tell a parity lean from a lucky hour). *Verdict:*
this is the v2 bot's identity. Side = argmax EV over {even, odd} every
readable cycle; the journal prints both sides' p/EV so every switch is
auditable. Selectivity is a knob (REQUIRE=edge + min EV), not an
amputation.

### S11 — Session controls (stops, targets, brakes)

*Thesis:* no entry family survives without exits — loss limit, profit
target, drawdown floor, losing-streak stop. *Math:* stops do not change
expectancy; they bound the left tail and force the review the journal
exists for. The v1 post-mortem matters here: its guards once read a
memory the bot never fed, so the documented stops could never fire —
pinned by test, never again. *Verdict:* all four brakes read the trade
engine's own session profit (which moves on every settlement), gate both
entries and trade-again, and announce in the journal.

## 6. What the v2 engine implements (research → code)

| § | finding | engine feature |
|---|---------|----------------|
| 1 | no ties, 14 markets, live multiple | side ∈ {even, odd}; 14-market scout; live DIGITEVEN/DIGITODD table |
| 2.1 | break-even 1/m | per-side EV vs live quote; selective mode gates on it |
| 2.2 | SE √(0.25/n) | shrinkage by effective sample; t-stat on every lean |
| 2.3 | streaks normal, "due" is fallacy | runs z + alternation in DNA; no reversion rules |
| 2.4 | lag-1 stickiness, decays | Markov/digit-row experts projected to duration + 1 |
| 3 | pip sizes differ | pip inference from the stream; trailing zeros kept |
| 5.1–5.4 | bias/share/Markov/runs | 8 digit-layer + 8 parity-native experts, skill-mixed |
| 5.5 | ladders fatten tails | no ladder; Kelly floor; loss never raises stake |
| 5.6 | tenth-Kelly | `adaptiveStake` reuse, floored/capped/de-risked |
| 5.7 | roam slowly | score floor + 90 s dwell + smoothed scores |
| 5.8 | horizon matters | forecast = duration + 1; pinned equal by test |
| 5.10 | switch sides, not modes | argmax-EV side every cycle; both sides journaled |
| 5.11 | brakes must read live P&L | engine session profit; four brakes; announced |
| 9 | stuck feeds fake edges | frozen veto pre-decision; refusal ungraded; scout scores 0 |

## 7. The expert league (sixteen experts, two layers)

The digit layer is inherited from the proven vision engine
(`forecastDigits`): uniform, long-run frequency, recent frequency, the
Markov row, analog replay, the analytical price→digit mapping, the online
softmax net and the regime-switching forecast — each a full ten-digit
distribution, summed to P(even). The parity layer adds eight experts that
see structure invisible to digit histograms:

- `share` — long-run even share with Wilson-aware shrinkage.
- `recent-share` — the last ~120 ticks' even share (the fast reactor).
- `markov-1` — the 2×2 parity transition row, matrix-powered to the
  horizon.
- `markov-2` — order-2 parity rows (EE/EO/OE/OO contexts), powered out.
- `digit-row` — the 10-bin digit row conditioned on the current digit
  (the v1 measurement), powered to the horizon.
- `streak` — run-continuation rate: how often the current run's parity
  printed again at this run length, historically.
- `alternation` — the parity-ACF projector: 0.5 + ρ^h·(x_t − 0.5).
- `parity-net` — a small online perceptron on parity features, trained
  walk-forward on settled windows only.
- `parity-net` — a small online perceptron on parity features (current
  parity, run length, recent-share deviation, digit position, parity ACF,
  volatility ratio), trained walk-forward on settled windows only.

Every expert is scored walk-forward with Brier loss against the 0.5
anchor over the settled past; skill = (0.25 − brier)/0.25; the blend is
skill-weighted with a floor so no expert fully dies. The league table in
the journal shows who is currently earning their weight — on a market no
expert can read, the anchor carries the blend and the bot says so.

Wait — that counts sixteen. Fifteen was the draft; the shipped engine
carries **sixteen**: the eight digit-layer experts plus eight
parity-native ones. The league never expected to be a round number.

## 8. Self-reverse-engineering: the parity DNA

Before the ensemble speaks, the engine fingerprints the stream. The DNA
report measures: pip size, digit χ² (9 df) and parity χ² (1 df) against
uniform, even share with a Wilson interval, alternation ratio, runs
z-score, parity-Markov dependence χ², longest run vs its expectation,
digit entropy, digit repeat rate, sample warmth (ticks in hand vs ticks
needed) — and rolls readability, dependence and warmth into a 0–100
**readability score** with a one-line verdict. The reverse-engineering
block prints the deep diagnosis (regime: sticky / alternating / drifty /
fair; memory: parity-ACF half-life; jumps: expansion flags) plus the
auto-tuning the bot derived: which expert family the market rewards,
whether the horizon should shorten, and whether the record says stand
down. Descriptive, never predictive — the DNA explains the market; it
does not promise it.

## 9. Calibration, stand-down and honest accounting

Four empirical layers sit on the model numbers:

0. **Frozen-feed veto.** A stuck quote feed repeats one price, every
   expert agrees, and the edge looks enormous (measured once at a phantom
   +40% EV, t 7.75σ) — while the contract settles on future ticks the
   dead tape knows nothing about. The engine refuses before a single
   expert speaks, the refusal is never filed for grading, and the scout
   scores the dead tape 0 so the bot walks away from it.
1. **Own-record calibration.** Every published decision is filed with its
   quote and graded against the settling tick (per side: even-lane and
   odd-lane). After 20 graded decisions the estimate is pulled toward
   50% by the reliability ratio (realised / predicted), floored so a
   losing record shrinks the bot instead of parking it.
2. **Stand-down.** After 40 graded decisions, a Wilson lower bound still
   under break-even sets stand-down: the bot stops buying until the
   record recovers. The journal says so explicitly.
3. **The journal as accountability.** Every skip names its gate; every
   entry prints side, p, quote, fair, EV, t-stat, confidence and the
   record; every 5th settlement prints the two-sided forecast and live
   quotes; every 10th prints the scorecard; every 25th prints the league,
   DNA, AI core and reverse engineering. A bot that will not show its
   numbers is not intelligent — it is merely busy.

## 10. The honest summary

Even/Odd pays ~1.95× on a ~50/50 stream: the margin is ~1.3 points and a
payable lean must be *measured*, not hoped. The v2 bot measures sixteen
ways, shrinks by sample size, calibrates against its own settled record,
sizes by tenth-Kelly, roams fourteen markets slowly, switches sides on
evidence, and journals everything. In cadence mode (the shipped default)
it trades the best-read side nearly every cycle at mostly-minimum stake:
on a fair market that pays the margin visibly rather than hiding from it.
In selective mode (REQUIRE=edge + min EV) it waits for a lean that beats
the quote — which, on a fairly-priced stream, is most of the time spent
waiting. Both postures are one dropdown apart, and the journal tells you
which one you picked. Start on demo, keep the base stake at the minimum,
and set the loss limit to what the session may cost.

## 11. References

- Deriv community, *Options to trade in Deriv: Digital options (2nd
  part)* — Even/Odd definition
  [4](https://community.deriv.com/t/options-to-trade-in-deriv-digital-options-2nd-part/41248)
- Deriv (Vince Stanzione), *How to Trade Synthetic Indices* — digit
  durations ≤ 10 ticks, auto-settlement
  [2](https://www.slideshare.net/slideshow/an-introduction-to-synthetic-indices-trading-derivcom/252337517)
  [4](https://static.deriv.com/marketing/how-trade-syntheticindices-fa.pdf)
- Deriv API docs — proposal parameters (no barrier for Even/Odd)
  [1](https://deriv-com.github.io/deriv-api/)
- deriv-smartcharts PR #293 — last-digit emphasis for digit contracts
  [2](https://github.com/deriv-com/deriv-smartcharts/pull/293)
- intraquotes — 14 digit markets, 1–10 tick sizes, 96.10% both-side
  payout, last-1000-ticks panel, 5–7 tick folk default
  [2](https://www.intraquotes.com/learn/binary-options/deriv-odd-even-strategy)
  [4](https://www.intraquotes.com/learn/binary-options/deriv-over-under-strategy)
  [5](https://www.intraquotes.com/learn/synthetic-trading/deriv-matches-differs-strategy)
- binarybot.live — contract odds table, streak expectations, tick
  independence
  [1](https://blog.binarybot.live/strategies)
  [2](https://blog.binarybot.live/best-deriv-bots-digit-analyzers)
- nextrader.live — martingale teardown, break-even table
  [5](https://blog.nextrader.live/deriv-bot-guide)
- profitmaxtrader — RSI/EMA trend-alignment method (surveyed, not adopted)
  [3](https://profitmaxtrader.com/post/deriv-even-odd-strategy-using-indicators)
- RhysZona/deriv-signal-scanner — Jump symbols JD10–JD100, per-market
  pip sizes
  [1](https://github.com/RhysZona/deriv-signal-scanner)
- sirvimbi/Deriv-Engine PR #26 — digit settlement auditing, trailing zeros
  [4](https://github.com/sirvimbi/Deriv-Engine/pull/26)
- Prior dossier: `docs/high-low-ticks-research.md` §13 — synthetic RNG
  audit findings (reused, not re-proven)
