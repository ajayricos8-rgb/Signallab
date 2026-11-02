# Step Index four-tick Markov hedge

Research notes for the store preset **Step Index Markov Hedge AI** and for the
`x_price_markov` / `x_price_markov_part` / `x_price_markov_report` blocks it is
built from.

The short version: a four-tick Rise/Fall on a fixed-step index is a **losing
shape unless the tape has structure**, because 37.5 % of windows return to the
entry and a strict Rise/Fall loses the stake on every one of them. The bot does
not pretend otherwise. It prices that tie, measures whether the current
*state* is better than the unconditioned shape, and trades only the states
where it is.

---

## 1. The shape

A Step Index moves exactly one quote increment per tick, in a random direction.
Over a four-tick contract the net displacement is the sum of four ±1 steps, so
it has the parity of 4 and can only be −4, −2, 0, 2 or 4. Enumerating the 16
paths:

| Net | Paths | Share |
| --- | --- | --- |
| +2 or +4 (Rise wins) | 5 | 31.25 % |
| −2 or −4 (Fall wins) | 5 | 31.25 % |
| 0 (tie) | 6 | 37.50 % |

Deriv's strict Rise/Fall (`CALL` / `PUT`) pays only on *strictly* above or
below, so the tie is a loss on **both** sides. Empirically that is:

```
P(win | rise)  = 0.3125        P(loss | rise)  = 0.6875
break-even     = 1 / (1 + 0.95) = 0.5128
EV per 1 staked = 0.3125 × 1.95 − 1 = −0.39
```

That is a −39 % expected loss per contract, unconditioned. No staking plan
changes the sign of a negative expectation; martingale only decides how fast
the account gets there. This is why the preset ships with a small ladder
(1.8 ×, two rungs), a hard max stake, a balance-percent cap and a stop loss,
and why every ladder reset is announced in the journal.

Two ways out of the tie tax exist, and only one is inside this bot:

1. **Trade the states where the tie is rarer.** A trending or anti-persistent
   stretch changes the displacement distribution; on a strongly persistent tape
   the four-tick tie falls from 37.5 % to ~22 % and a side reaches ~54 %.
   That is what the chain below measures.
2. **Win on equal.** Deriv sells "Rise Equals" / "Fall Equals" as the
   `callputequal` trade type (`CALLE` / `PUTE`): a tie *wins*. The unconditioned
   win probability becomes 11/16 = 68.75 % at a correspondingly lower payout.
   The price-path ensemble in this repository prices `CALL`/`PUT` only, so the
   preset does not offer it — but an operator trading four ticks manually
   should know the contract exists.

## 2. Why a Markov chain

A tick stream is not i.i.d. The next step's distribution depends on the recent
steps (a stretched tape reverts, a trending one continues). A chain conditions
on that; a frequency table averages it away.

The engine (`utils/markov-chain.mjs`) fits an **order-k chain on the tick
directions** (up / flat / down), `k = 3` by default, on the last `memory = 400`
transitions:

```
state_t  = (sign_{t−k}, …, sign_{t−1})
P(s | state) = (count(state, s) + w · base(s)) / (count(state) + w)
```

with `w = 3` and `base` the chain's own one-step marginal. The Dirichlet pull
is what stops a state seen twice from quoting a 90 % probability.

The forecast is **not** "the one-step probability raised to the fourth power".
The module carries a distribution over `(state, net displacement)` forward one
tick at a time:

```
layer_0 = { (state_now, 0) : 1 }
layer_{j+1}[(state[1:]+s, d+s)] += layer_j[(state, d)] · P(s | state)
```

After `horizon` ticks the last layer *is* the settlement distribution of the
contract: `P(net > 0)`, `P(net = 0)`, `P(net < 0)`. Every state transition is
exact and the tie is carried, not approximated. The same projection with the
unconditional rows gives the baseline the conditioned read is compared with.

Sanity checks pinned by `tests/markov-chain.test.mjs`:

* a fair walk reproduces the enumerated 31.25 / 31.25 / 37.5 % (and 50 % tie at
  two ticks, 31.25 % at six, ~0 % at any odd horizon — a ±1 walk cannot tie
  after an odd number of steps);
* a persistent stream produces `persistence > 0.2`, `χ²` significance and a
  tie rate under 0.34;
* an anti-persistent stream produces `persistence < −0.4` and a *higher* tie
  rate;
* the module is a pure function of the tick list: no state, no look-ahead.

## 3. The gates the bot actually uses

| Gate | Knob | Meaning |
| --- | --- | --- |
| chain ready | `ai markov min samples` (120) | transitions fitted **and** the current state seen ≥ 1/8 of that |
| tie ceiling | `ai max tie` (0.45) | the projected tie must be under it — the shape has to be playable |
| significance | `ai markov min z` (0.75) | the chosen side's probability over its own unconditional read, in standard errors of the state's sample |
| lift | `ai markov min lift` (0.01) | the same difference as probability, so a thin state with a big z cannot pass |
| expected value | `ai markov min ev` (−1) | `p·(1+payout) − 1`, tie charged; −1 disables, 0 refuses any negative-EV entry |
| agreement | `ai markov agreement` (1) | the ensemble and the chain must name the same side |

The ensemble is still there — it decides *side* and is the second opinion. Two
models fitted by different mathematics (`x_price_decision`'s sixteen-expert
walk-forward mixture and this exact chain) agreeing is the sharpest filter the
bot has.

`ai markov min ev` ships **off** on purpose: on a fair Step index no honest
gate clears 51.3 %, so an EV floor of 0 would turn the preset into a bot that
never trades. An operator who wants only measured-edge entries should set it to
0 and accept long idle stretches — that is the honest trade-off, and the
journal prints the EV of every entry so the cost of trading without it is
visible.

## 4. Cadence

The bot re-reads on the tick after each settlement and has no dwell, cooldown
or market scan. Its ceiling is the contract length: a four-tick contract on a
two-second market is open eight seconds, so the physical maximum is roughly
seven cycles a minute, or fourteen contracts if both hedge legs count. The
gates decide which of those cycles it takes. There is no way to open more
positions a minute than the contract length allows without shortening the
contract.

## 5. The hedge

The main leg is the model's side; the cover is `hedge ratio` (0.3) of it on the
opposite side. Two `hedge_purchase` blocks are emitted, one per direction,
because the block names its contracts in dropdown fields — a single block would
buy `CALL` as the main leg on every cycle whatever the models said.

Both legs lose on a tie, so the cover does not rescue the tie tax; it caps the
swing on the cycles the models are wrong. Two equal legs would lock in a loss
of the spread every cycle, which is why the ratio is partial. The pair is
risk-checked at `stake × (1 + ratio)` before either order is sent.

## 6. The ladder

| Knob | Default | Role |
| --- | --- | --- |
| `base stake` | 0.35 | the stake before any ladder |
| `martingale multiplier` | 1.8 | × after a losing cycle |
| `martingale steps` | 2 | rungs before the ladder is abandoned |
| `max stake` | 2 | hard ceiling the multiplication can never pass |
| `take profit` | 5 | session profit that stops new entries |
| `stop loss` | 5 | session loss that stops new entries |

A win restores the base stake. A loss multiplies, capped at `max stake`; when
the ladder reaches its step limit it is abandoned (base stake restored) and the
reset is written to the journal. The brakes are entry checks, not guaranteed
exits: an open pair can settle through them.

Warning, stated plainly: martingale on a negative-expectation shape converts a
slow bleed into a fast one. The caps exist because of that, not because the
ladder is an edge.

## 7. Journal

* every entry — the ensemble's decision line;
* every tenth held cycle — the chain's own numbers (state, probabilities, tie,
  break-even, edge, EV, z, lift, readability, persistence) plus the reason the
  gate held;
* every fifth settlement — the realised scorecard (hit rate against the
  break-even the payouts required);
* every tenth settlement — the chain again and the self-audit;
* every twenty-fifth — the expert league and the market DNA;
* start-up — the market DNA and the execution clock, so the contract's real
  length in seconds is never implied.

## 8. Tests

```bash
# the chain itself
node --experimental-strip-types --test ./tests/markov-chain.test.mjs

# the engine, the risk gate, the presets and the hedge replay
node --experimental-strip-types --test ./tests/price-strategies.test.mjs

# structural checks on every shipped strategy file
python3 scripts/presets/validate_presets.py src/lib/bot-store/bots/*.xml

# regenerate from the single source of truth, then re-validate
python3 scripts/presets/gen_presets.py \
    src/lib/bot-store/bots/rise-fall-ensemble.xml \
    src/lib/bot-store/bots/step-markov-hedge.xml \
    src/lib/bot-store/bots/high-low-tick-sniper.xml
```

`tests/price-strategies.test.mjs` replays the preset's cycle — ensemble side,
chain gates, ladder — on a fair tape and on a persistent one, and asserts that
structure is traded more than noise, that an unreachable `z` floor stops every
entry, that a tie ceiling under the structural rate refuses the shape, and that
the ladder climbs, resets and never passes `max stake`.
