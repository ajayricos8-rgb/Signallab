# Deriv Even/Odd: mechanics, strategies and limitations

Research reviewed 30 October 2026. This is a practical survey of major strategy
families, not an assertion that all possible strategies have been exhausted or
that any has a proven edge. Trading digital options can lose the entire stake.

## Contract mechanics

Even/Odd is a Digits digital option. A normal completed contract wins if the
last digit of the final tick matches the chosen parity: Even = **0, 2, 4, 6,
8**; Odd = **1, 3, 5, 7, 9**. There is no parity tie, but a contract can be
refunded or otherwise handled exceptionally; don't count every non-win as a
normal loss without checking its actual status. Deriv's SmartTrader help says
Even/Odd contracts are refunded at purchase price if they do not end within
five minutes [1, 2].

A Deriv synthetic-indices guide says Even/Odd duration cannot exceed 10 ticks
[3]; verify the current permitted duration, minimum stake, currency, market,
regional availability and terms using `contracts_for` and the actual proposal.
Do not assume every market or account supports Digits. A tick is a price
update, not necessarily one second. The bot's candidate list is a fixed subset
of synthetic symbols, **not** a live catalogue of every eligible Deriv market.

For a stake-based contract, `ask_price` is the price paid and `payout` is the
gross amount returned on a win, including the stake. The potential net profit
is payout minus purchase price; a losing normal contract loses the purchase
price [4]. Quotes can change between analysis and purchase. Treat buy errors,
refunds, disconnects and timeouts separately. The exact entry and expiry
should be read from the purchased contract; a forecast made before execution
cannot assume an exact fill tick.

The last digit must use the quote's **market precision**: if `pip_size` is 3,
1.230 has last digit 0, not 3. Numeric JSON values can discard trailing
zeroes; Deriv's tick example explicitly uses `pip_size` for formatting [5].
The bot now requires the runtime market precision for its parity decisions;
standalone historical calculations without supplied metadata may still infer it.

## Payout mathematics

Let `m = payout / ask_price` be the gross payout multiple and `p` the true
win probability. Ignoring refunds and other execution effects, expected
return per unit staked is `p*m - 1`; break-even is `1/m`. For example, at
1.95×, break-even is 51.28%; at 50% the expected return is -2.5% per
stake. Actual multiples vary and Even and Odd must be checked independently.
Equal numbers of winning digits do not prove equal probabilities in every
market. Conversely, a model's estimated 52% is not proof the true probability
is 52%.

For independent fair binary outcomes, the standard error of a sample share is
approximately `sqrt(0.25/n)`: 5 percentage points at n=100, 1.58 points at
n=1,000. Dependence, multiple comparisons and overlapping windows can make
uncertainty larger. Selecting the best of many markets, models and thresholds
on the same sample increases false discoveries. A one-sigma modelled EV floor
is a heuristic, **not** a validated confidence interval or evidence of edge.

## Strategy families

| Family | Idea | What can go wrong |
|---|---|---|
| Fixed Even or Odd | Keep one side and a fixed stake. | A baseline, not an advantage; payout margin remains. |
| Frequency / hot parity | Choose the more common parity in a window. | Short samples fluctuate; selection and look-ahead bias. |
| Cold parity / mean reversion | Choose the side absent or less common recently. | A long run does not make the opposite side due. |
| Streak following / alternation | Follow a run or bet on a switch. | Runs occur by chance; regime changes and execution delay. |
| Transition / Markov | Estimate conditional parity or digit transitions. | Many parameters, few independent observations; weak out-of-sample results. |
| Multi-window / regimes | Combine short and long histories, detect changes. | Window tuning and repeated testing overfit. |
| Price indicators / momentum | Use RSI, trends or volatility to choose parity. | Directional movement does not establish a last-digit edge. |
| Ensemble / online learning | Mix multiple estimators, weight past forecast skill. | Correlated models, data leakage, stale features and false confidence. |
| Market / duration rotation | Compare models across symbols or horizons. | Multiple-testing bias, cold streams, unavailable contracts and different payouts. |
| Value / selective entry | Enter only if estimated probability beats the quoted break-even. | A modelled edge may be noise; selection does not prove profitability. |
| Flat / fractional Kelly sizing | Keep stake fixed or scale with estimated edge. | Kelly is very sensitive to errors; floors and caps change the result. |
| Martingale / D'Alembert / Fibonacci | Increase stake after losses to try to recover. | Streaks, balance and stake limits cause large drawdowns; no edge is created. |
| Reverse martingale / Paroli | Increase after wins. | Changes distribution of outcomes, not expected edge. |
| Session target / stop / loss streak | Halt or reduce activity under chosen conditions. | Limits exposure but cannot turn negative expectation positive or guarantee execution. |
| Buy both sides / hedge | Buy Even and Odd on the same expiry. | At common payouts below 2×, equal stakes lose money overall even with identical settlement; different entry/expiry ticks add risk. |

Deriv says synthetic indices are generated using a cryptographically secure
random number generator and cautions that, apart from its Range Break index,
noticeable historical patterns may be coincidental [6]. This does not prove
that every last-digit sequence has identical independent outcomes, nor that a
particular model has exploitable predictability. Claims of guaranteed profit,
precise accuracy, or a side being "due" are not supported.

## What the bot actually does

The **AI Even/Odd Switcher** uses an internal ensemble of 16 statistical
models, including small online-trained neural models, and compares estimated
EV of Even and Odd. It switches sides based on the current estimate, not simply
on a previous loss. This is software using statistical models, not an external
AI service, and it does not rewrite its own code. Its market fingerprint and
model league are descriptive diagnostics. The replay separates origins by at
least the forecast horizon so a training target is not in the future at the
next origin; model selection and overlapping historical features still require
independent evaluation.

The shipped preset uses 5 ticks, a one-tick forecast-slip assumption and an
estimated one-sigma EV floor of 0.5%. Both independently priced proposals
must be present and less than five minutes old; a fallback or old quote alone
cannot authorize an entry. This is not a live execution quote guarantee, nor
is there a guarantee that the purchase uses the earlier proposal. The engine
records hypothetical forecasts at their forecast horizon; they are **not**
necessarily bought contracts or actual settlement results. The inferred
latency can be wrong. Stale feeds, gaps and rolling history may affect scoring.

The preset uses a 0.35 base stake, a 1.5 maximum, a strict 2% of balance,
30 session loss limit, 50 profit target, 15 session-loss brake, 4 consecutive
losses and a 100-contract cap, in account currency where applicable. There is
no martingale. Check the minimum and limits for your own account. Limits apply
in the running bot and cannot guarantee a maximum loss during outages or
unexpected execution states. A restrictive model can remain idle indefinitely.

Before real trading, test on demo: preserve chronological train/validation/test
splits, exclude overlapping target horizons, record proposals and actual fills,
entry/exit ticks, refunds, slippage, rejected orders, stake, P&L and drawdown.
Compare against fair 50/50 and simple fixed-side baselines at actual payout;
repeat across independent periods and markets, accounting for all experiments.
Never treat a demo backtest or a brief winning streak as proof of future profit.

## Sources

1. [Deriv Community: digital options, Even/Odd definition](https://community.deriv.com/t/options-to-trade-in-deriv-digital-options-2nd-part/41248).
2. [Deriv SmartTrader: winning conditions and refund note](https://smarttrader.deriv.com/en/trading?currency=USD&market=synthetic_index&underlying=R_100&formname=evenodd&duration_units=t&duration_amount=1&expiry_type=duration&amount=2&amount_type=stake).
3. [Deriv: How to Trade Synthetic Indices](https://static.deriv.com/marketing/how-trade-syntheticindices-fa.pdf).
4. [Deriv: Digital Options](https://deriv.com/trade/options/digital-options).
5. [Deriv API: ticks, `pip_size` and formatting](https://developers.deriv.com/comparison/ticks/).
6. [Deriv: Synthetic indices and indicator limitations](https://trade.deriv.com/markets/derived-indices/synthetic-indices).
7. [Deriv API workflow: active symbols, contracts, proposals and buys](https://developers.deriv.com/docs/workflows/).
