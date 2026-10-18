import type { EngineDefinition, EngineDomain, EngineRole } from './types.ts';

/** Research sources describe the underlying mathematics, not a promise of trading edge. */
export const ENGINE_SOURCES: Record<string, { citation: number; title: string; url: string }> = {
  eda: { citation: 1, title: 'NIST: descriptive statistics and exploratory analysis', url: 'https://www.itl.nist.gov/div898/handbook/dtoc.htm' },
  runs: { citation: 5, title: 'NIST: runs test, assumptions and sample requirements', url: 'https://www.itl.nist.gov/div898/handbook/eda/section3/eda35d.htm' },
  chi: { citation: 4, title: 'NIST: chi-square goodness of fit', url: 'https://www.itl.nist.gov/div898/handbook/eda/section3/eda35f.htm' },
  acf: { citation: 14, title: 'NIST: autocorrelation and randomness', url: 'https://www.itl.nist.gov/div898/handbook/eda/section3/autocopl.htm' },
  wilson: { citation: 1, title: 'NIST: Wilson intervals for proportions', url: 'https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm' },
  ta: { citation: 1, title: 'TA-Lib: momentum indicator definitions and periods', url: 'https://ta-lib.github.io/ta-lib-python/func_groups/momentum_indicators.html' },
  stats: { citation: 1, title: 'SciPy: moments, entropy and density estimation', url: 'https://docs.scipy.org/doc/scipy/reference/stats.html' },
  series: { citation: 3, title: 'Statsmodels: stationarity and KPSS/ADF', url: 'https://www.statsmodels.org/stable/examples/notebooks/generated/stationarity_detrending_adf_kpss.html' },
  calibration: { citation: 1, title: 'Scikit-learn: probability calibration and Brier score', url: 'https://scikit-learn.org/stable/modules/calibration.html' },
  validation: { citation: 7, title: 'Scikit-learn: chronological time-series splits', url: 'https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html' },
  leakage: { citation: 5, title: 'Scikit-learn: avoiding data leakage', url: 'https://scikit-learn.org/stable/common_pitfalls.html' },
  correlation: { citation: 1, title: 'Scikit-learn: correlated features and importance', url: 'https://scikit-learn.org/stable/auto_examples/inspection/plot_permutation_importance_multicollinear.html' },
  sharpe: { citation: 1, title: 'William F. Sharpe: The Sharpe Ratio (1994)', url: 'https://web.stanford.edu/~wfsharpe/art/sr/sr.htm' },
  classification: { citation: 2, title: 'Scikit-learn: precision and recall definitions', url: 'https://scikit-learn.org/stable/auto_examples/model_selection/plot_precision_recall.html' },
  deriv: { citation: 6, title: 'Deriv SmartTrader: exact contract settlement rules', url: 'https://smarttrader.deriv.me/en/trading' },
};

// Explicit operational definitions. Terms such as pressure, exhaustion and
// master synthesis have no universal statistical definition; these formulas
// are this application's transparent implementations, not proprietary AIs.
const definitions = `
Tick Frequency Engine|Tick count divided by elapsed seconds; cadence is not directional evidence.
Digit Frequency Engine|Counts and empirical probabilities for the ten verified final digits.
Rolling Frequency Engine|Outcome frequencies in trailing 50, 200 and 1,000 observations.
Weighted Frequency Engine|Linearly increasing observation weights, normalized by their sum.
Recency-Weighted Frequency Engine|Exponential weights with a 50-observation half-life.
Digit Distribution Engine|Empirical ten-category probability mass function, not a continuous price density.
Digit Transition Engine|Counts of consecutive ordered digit pairs in a 10 × 10 matrix.
Sequential Pattern Engine|Occurrences and next-outcome counts after the latest two-state context.
Repetition Engine|Fraction of adjacent outcomes that repeat the same state.
Alternation Engine|Fraction of adjacent outcomes that change state.
Streak Engine|Length and state of the current contiguous outcome run.
Streak Break Engine|Smoothed observed break rate after historical runs with the current state and length bucket.
Momentum Engine|Difference between short-window and medium-window outcome rates or mean returns.
Mean Reversion Engine|Lag-one correlation of returns or numeric digit labels; negative values are descriptive, not a buy rule.
Exhaustion Engine|Current run length divided by the mean completed run length; no automatic reversal prediction.
Reversal Engine|Observed sign changes in returns or changes in categorical states.
Persistence Engine|Fraction of observations remaining in their preceding state.
Continuation Engine|Smoothed probability of the current state following its current run-length context.
Anomaly Detection Engine|Largest absolute standardized count deviation, or latest return z-score.
Outlier Detection Engine|Tukey 1.5 × IQR outlier fraction on numeric digits or quote returns.
Regime Detection Engine|Classify observed dependence, concentration and distribution shift; a descriptive policy.
Market State Engine|Primary stream state plus independent prediction-validation status.
Volatility Regime Engine|Ratio of short (20) to long (100) return standard deviations; >1.5 expansion, <0.67 compression.
Randomness Detection Engine|Runs and uniformity diagnostics with valid-sample checks; failure to reject is not proof of randomness.
Entropy Engine|Shannon entropy −Σ p log2(p), divided by maximum entropy when normalized.
Pattern Stability Engine|One minus total variation distance between adjacent half-window distributions.
Pattern Persistence Engine|Relative frequency of the latest two-state pattern in old and recent halves.
Signal Stability Engine|One minus the range of short-, medium- and long-window outcome probabilities.
Digit Frequency Matrix|Ten digit frequencies across 50-, 200- and 1,000-tick windows.
Digit Ranking Engine|Descending empirical frequency rank with digit-number tie breaking.
Hot Digit Engine|Most frequent digit in the trailing 200 ticks, with its count.
Cold Digit Engine|Least frequent digit in the trailing 200 ticks; not a claim it is due.
Overdue Digit Engine|Largest observed age since a digit appeared; right-censored when never seen.
Missing Digit Engine|Digits absent from the trailing 50 ticks.
Dominant Digit Engine|Largest full-window probability mass and its lead over second place.
Rare Digit Engine|Digits with fewer than half their uniform expected counts.
Digit Exhaustion Engine|Hot digit short-window frequency minus its preceding-window frequency.
Digit Recurrence Engine|Mean observed inter-arrival interval per digit; excludes censored gaps.
Digit Gap Engine|Ticks since each digit last appeared, or null if not observed.
Digit Interval Engine|Median and coefficient of variation of completed inter-arrival intervals.
Digit Clustering Engine|Fano factor: variance/mean of digit counts in complete 20-tick blocks.
Digit Dispersion Engine|Standard deviation of ten empirical digit frequencies.
Digit Concentration Engine|Herfindahl concentration Σ p²; uniform reference 0.1.
Digit Balance Engine|Total variation distance from uniform digits: 0.5 Σ |p−0.1|.
Digit Rotation Engine|Most frequent modular change (current−previous+10) mod 10.
Digit Cycle Engine|Maximum lag-1…20 same-digit recurrence excess over Σ p²; exploratory, not a validated cycle.
Digit Sequence Engine|Empirical support of the latest three-digit sequence.
Digit Pair Engine|Most common ordered adjacent pair and its frequency.
Digit Triplet Engine|Most common ordered adjacent triplet and its frequency.
Digit Transition Matrix|Row-normalized first-order digit transition matrix, with Dirichlet smoothing.
Digit Markov Engine|First-order smoothed transition distribution raised to the selected tick horizon.
Digit Conditional Probability Engine|Smoothed next-digit distribution conditional on the last two digits.
Match Frequency Engine|Count of the selected target digit; contextual tools use the empirical mode as a labelled reference target.
Match Rate Engine|Selected target hits divided by observed digits.
Match Streak Engine|Current consecutive target matches.
Non-Match Streak Engine|Current consecutive non-matches of the reference target.
Match Gap Engine|Completed intervals between target hits and current censored age.
Match Recency Engine|Target probability with exponential 50-tick half-life weighting.
Match Probability Engine|Beta-smoothed target frequency using a 0.1 prior with strength 20.
Match Transition Engine|Two-state match/non-match transition counts and smoothed current-row probability.
Match Clustering Engine|Variance/mean of target counts across complete 20-tick blocks.
Match Exhaustion Engine|Recent target hit rate minus the preceding equal-sized window rate.
Match Reversal Engine|Observed switch rate between match and non-match states, not a due-digit rule.
Match Anomaly Engine|Target count z-score against its 0.1 no-edge probability.
Dynamic Match Target Engine|Rank targets by multi-window smoothed probability, with later held-out validation required.
Even/Odd Frequency Engine|Counts and frequencies for parity; zero is even.
Even/Odd Ratio Engine|Even count / odd count, undefined when the denominator is zero.
Even/Odd Streak Engine|Current parity and contiguous parity run length.
Even/Odd Alternation Engine|Fraction of adjacent ticks whose parity switches.
Even/Odd Momentum Engine|Recent even probability minus preceding even probability.
Even/Odd Reversal Engine|Smoothed parity switch probability after the current parity.
Even/Odd Exhaustion Engine|Current parity run length relative to the mean completed parity run.
Even/Odd Transition Engine|2 × 2 parity transition counts and smoothed probabilities.
Even/Odd Gap Engine|Ticks since each parity last occurred; missing observations are censored.
Even/Odd Probability Engine|Beta-smoothed even and odd probabilities with symmetric prior strength 20.
Even/Odd Imbalance Engine|Absolute difference between even and odd empirical rates.
Even/Odd Regime Engine|Runs-test classification of parity: clustered, alternating or no detected dependence.
Over/Under Frequency Engine|Counts strictly above, strictly below and equal to the actual barrier.
Over/Under Ratio Engine|Strictly-over count / strictly-under count; equal digits excluded from numerator and denominator.
Over/Under Streak Engine|Current run of over, under or equal states at the actual barrier.
Over/Under Momentum Engine|Recent strict-over rate minus the preceding strict-over rate.
Over/Under Reversal Engine|Observed transitions between strict-over and strict-under; equality remains its own state.
Over/Under Exhaustion Engine|Current barrier-state run length relative to completed runs.
Over/Under Transition Engine|Three-state over/under/equal transition matrix.
Over/Under Gap Engine|Ticks since strict-over and strict-under last occurred.
Over/Under Barrier Engine|Actual selected barrier, with explicit equal-barrier losing mass.
Barrier Probability Engine|Sum of the digit mass on each strict side; P(over)+P(under)+P(equal)=1.
Barrier Distance Engine|Mean absolute digit distance from the barrier; not price support/resistance.
Barrier Pressure Engine|Recent over-minus-under probability mass at the selected barrier.
Barrier Exhaustion Engine|Change in barrier pressure between consecutive 50-tick windows.
Barrier Breach Engine|Fraction of ticks crossing from one strict side to the other.
Dynamic Barrier Engine|Rank allowed 1–8 barriers by smoothed edge over their own uniform baseline, not raw hit rate.
Over/Under Regime Engine|Three-state concentration and distribution shift at the barrier.
Rise/Fall Momentum Engine|Mean recent price increment divided by its standard deviation.
Rise/Fall Frequency Engine|Up, down and unchanged tick counts; ties never count as strict wins.
Rise/Fall Streak Engine|Current up/down/flat run length.
Rise/Fall Alternation Engine|Fraction of adjacent non-flat increments that change sign; flats break adjacency.
Rise/Fall Reversal Engine|Smoothed direction-switch rate conditioned on the last direction.
Rise/Fall Continuation Engine|Smoothed same-direction transition probability.
Rise/Fall Trend Engine|OLS quote slope over the latest 60 observations.
Rise/Fall Acceleration Engine|Recent 10-tick slope minus the preceding 10-tick slope.
Rise/Fall Deceleration Engine|Reduction in absolute 10-tick slope relative to the preceding window.
Rise/Fall Strength Engine|Efficiency ratio: absolute net displacement / sum of absolute increments.
Rise/Fall Probability Engine|Smoothed rise/fall/flat frequencies; final duration-specific estimates are separately replayed.
Rise/Fall Transition Engine|Three-state up/down/flat transition matrix.
Rise/Fall Exhaustion Engine|Current direction run length relative to historical completed runs.
Rise/Fall Regime Engine|Combine slope efficiency and volatility ratio into a descriptive price regime.
Candle Direction Engine|Sign of close−open on the last completed 60-second candle.
Candle Body Engine|Absolute close−open on the last completed candle.
Candle Range Engine|High−low on the last completed candle.
Candle Wick Engine|Upper plus lower wick length; only observed completed candles are used.
Upper Wick Pressure Engine|Upper wick divided by candle range; descriptive rejection proxy.
Lower Wick Pressure Engine|Lower wick divided by candle range; descriptive rejection proxy.
Body-to-Range Ratio Engine|Absolute candle body / range, undefined for a zero-range candle.
Wick-to-Body Ratio Engine|(Upper wick + lower wick) / absolute body, undefined for a doji.
Candle Strength Engine|Signed body / range on the last completed candle.
Candle Momentum Engine|Mean signed bodies of the last three completed candles.
Candle Exhaustion Engine|Latest body / mean preceding five bodies; weakening is descriptive.
Candle Reversal Engine|Opposite candle direction plus body engulfing the preceding real body.
Candle Continuation Engine|Same nonzero direction across the latest three completed candles.
Candle Compression Engine|Latest candle range / mean preceding 20 ranges, below one indicates compression.
Candle Expansion Engine|Latest candle range / mean preceding 20 ranges, above one indicates expansion.
Candle Sequence Engine|Up/down/doji sequence of the latest five completed candles.
Candle Pattern Engine|Explicit doji (<10% body/range), lower-pin or upper-pin (>2× body wick) rules.
Multi-Candle Pattern Engine|Two-body engulfing or three-candle same-direction pattern; no automatic predictive claim.
Candle Breakout Engine|Last close strictly outside the preceding 20-candle high/low channel.
Candle Rejection Engine|Upper-minus-lower wick asymmetry, normalized by range.
Trend Detection Engine|Direction of 20-, 60- and 200-tick OLS slopes when their signs agree.
Trend Strength Engine|60-tick efficiency ratio, bounded 0…1.
Trend Direction Engine|Sign of the 60-tick regression slope.
Trend Persistence Engine|Fraction of 20-tick block slopes aligned with the current 60-tick slope.
Trend Acceleration Engine|Difference between consecutive 20-tick regression slopes.
Trend Exhaustion Engine|Change in absolute 20-tick slope; negative means weakening, not reversal certainty.
Trend Reversal Engine|Opposite signs for consecutive 20-tick slopes.
Multi-Timeframe Trend Engine|Slope signs on completed 1-, 3- and 5-minute candle closes; no synthetic filling of gaps.
Moving Average Trend Engine|Price relative to SMA-20 and EMA-20.
SMA Alignment Engine|Ordering of SMA-10, SMA-20 and SMA-50.
EMA Alignment Engine|Ordering of EMA-9, EMA-21 and EMA-50, SMA-seeded.
MA Slope Engine|EMA-20 change across five ticks divided by five.
MA Distance Engine|(Price−EMA-20) / trailing return standard deviation.
MA Cross Engine|Actual EMA-9/21 cross between the last two observations; zero if none.
RSI Engine|Wilder RSI-14 using smoothed gains and losses; 50 for a flat series.
RSI Momentum Engine|Current RSI-14 minus RSI-14 five ticks ago.
RSI Divergence Engine|Opposite signs of price change and RSI change across 14 ticks; divergence proxy, not pivot-based certainty.
RSI Reversal Engine|RSI crossing back inside 30/70 thresholds from the prior tick.
RSI Regime Engine|RSI <30 oversold, >70 overbought, otherwise neutral; not a trading rule.
MACD Engine|EMA-12 minus EMA-26, with EMA-9 signal and histogram.
MACD Momentum Engine|Change in MACD histogram over five observations.
MACD Divergence Engine|Opposite signs of 14-tick price and MACD changes; a labelled divergence proxy.
Stochastic Engine|Fast %K over 14 completed candle high/low/close values.
Stochastic Momentum Engine|Latest fast %K minus previous fast %K.
CCI Engine|(Typical price−SMA-20 typical price) / (0.015 × mean absolute deviation), completed candles.
ROC Engine|100 × (current quote / quote 20 ticks ago − 1).
Momentum Oscillator Engine|Quote change over 10 ticks.
Williams %R Engine|−100 × (14-candle high−last close) / (high−low).
Volatility Engine|Sample standard deviation of quote increments.
Realized Volatility Engine|Square root of summed squared log returns; not annualized.
Tick Volatility Engine|Absolute latest quote increment.
Rolling Volatility Engine|Sample standard deviations of increments over 20, 50 and 100 ticks.
ATR Engine|Wilder average true range over 14 completed candles, including preceding-close gaps.
Bollinger Band Engine|SMA-20 ± 2 population standard deviations of quote levels.
Bollinger Width Engine|(Upper band−lower band) / absolute middle band.
Volatility Expansion Engine|Positive excess of the 20/100 return-volatility ratio over one.
Volatility Compression Engine|Positive shortfall of the 20/100 return-volatility ratio below one.
Volatility Breakout Engine|Latest absolute return exceeds three preceding-window return standard deviations.
Volatility Regime Engine|Alias of #23. A repeated name does not receive another vote.
Support Engine|Lowest low of the preceding 20 completed candles, excluding the latest candle.
Resistance Engine|Highest high of the preceding 20 completed candles, excluding the latest candle.
Dynamic Support Engine|EMA-20 minus one ATR-14; a price-only support proxy.
Dynamic Resistance Engine|EMA-20 plus one ATR-14; a price-only resistance proxy.
Breakout Engine|Latest completed candle close above prior channel resistance.
Breakdown Engine|Latest completed candle close below prior channel support.
Rejection Engine|Candle pierces prior channel and closes back inside it.
Retest Engine|Previous candle closes outside its older channel; latest candle tests that fixed level and holds it.
False Breakout Engine|Previous candle closes outside its older channel; latest closes back through that fixed level.
Liquidity Sweep Engine|Price-only high/low channel sweep followed by an inside close; cannot infer actual orders or liquidity.
Price Structure Engine|Last two confirmed swing highs and lows, with two observed bars on each side.
Higher High Engine|Latest confirmed swing high exceeds preceding confirmed swing high.
Lower High Engine|Latest confirmed swing high is below preceding confirmed swing high.
Higher Low Engine|Latest confirmed swing low exceeds preceding confirmed swing low.
Lower Low Engine|Latest confirmed swing low is below preceding confirmed swing low.
Market Structure Engine|HH+HL up structure, LH+LL down structure, otherwise mixed.
Descriptive Statistics Engine|Count, mean, median, sample standard deviation, min and max of primary digits or returns.
Mean Engine|Arithmetic mean of primary observations.
Median Engine|50th percentile with linear interpolation.
Mode Engine|Most frequent numeric value with ascending tie break; continuous-return mode is descriptive only.
Standard Deviation Engine|Square root of sample variance, denominator n−1.
Variance Engine|Σ(x−mean)² / (n−1).
Range Engine|Maximum minus minimum.
Percentile Engine|5th, 50th and 95th percentiles by linear interpolation.
Quartile Engine|25th and 75th percentiles and interquartile range.
Z-Score Engine|(Latest value−mean of preceding values) / preceding sample standard deviation.
Skewness Engine|Third population central moment divided by variance^(3/2); biased descriptive moment.
Kurtosis Engine|Fourth population central moment / variance² − 3; excess, biased descriptive moment.
Distribution Engine|Empirical categorical mass for digits, ten-bin histogram for returns.
Probability Density Engine|Digits: probability mass. Returns: Gaussian KDE at the latest return, Scott bandwidth n^(−1/5) × SD.
Confidence Interval Engine|95% Wilson interval for the selected contract event, not a guaranteed next-tick range.
Bayesian Probability Engine|Beta posterior mean (hits + 20×prior) / (n+20), with prior centered at fair clipped to [0.000001, 0.999999].
Conditional Probability Engine|Smoothed selected-event probability conditional on the latest state.
Joint Probability Engine|Empirical joint probability of the latest adjacent state pair.
Historical Probability Engine|Selected-event hit rate over the full observed history; not held-out performance.
Empirical Probability Engine|Selected-event hit rate over the last 200 observations.
Frequency Distribution Engine|Counts in categorical or equal-width return bins.
Autocorrelation Engine|Lag-1…10 autocorrelation of primary observations.
Partial Autocorrelation Engine|Durbin–Levinson recursion on biased sample autocorrelations through lag five.
Cross-Correlation Engine|Lag-one correlation between returns and absolute preceding returns; requires aligned quotes, not spurious cross-market inference.
Serial Dependence Engine|Ljung–Box Q statistic across up to 10 lags, with chi-square reference approximation.
Transition Probability Engine|Row-normalized primary-state transition counts with symmetric smoothing.
Markov Chain Engine|Tick-horizon propagated first-order state probabilities. Quote terminal direction is context, not net contract return; minute horizons require direct-outcome models.
Conditional Transition Engine|Two-state-context smoothed next-state distribution and support count.
Sequence Probability Engine|Empirical frequency of the latest three-state sequence.
Pattern Recurrence Engine|Completed intervals between occurrences of the latest two-state pattern.
Run-Length Analysis Engine|Completed run-length distribution plus the current right-censored run.
Runs Test Engine|Wald–Wolfowitz normal approximation on binary selected-event indicators; both classes need >10 observations. Strict Rise/Fall flats are non-events.
Chi-Square Distribution Engine|Digit uniformity test with expected cell counts ≥5; quote returns are not assumed uniform.
Independence Test Engine|Transition contingency chi-square, reported only with adequate expected cell counts.
Stationarity Engine|Level-stationarity KPSS statistic with Bartlett long-run variance and 5% critical value 0.463; asymptotic diagnostic.
Change-Point Detection Engine|Maximum centered CUSUM / (SD × sqrt(n)); exploratory shift diagnostic, not a fitted HMM.
Multi-Engine Consensus Engine|Legacy weighted agreement and independently replayed research-model agreement, kept distinct.
Weighted Signal Engine|Σ normalized family-balanced model weight × current contract probability.
Adaptive Weighting Engine|Tuning-only exp(12 × Brier skill), capped, then normalized within family budgets.
Dynamic Confidence Engine|Existing calibrated evidence score, reduced only for validated contradiction or stale inputs.
Signal Confluence Engine|Number of distinct model families with a positive current contract edge.
Signal Strength Engine|Edge relative to sqrt(fair × (1−fair)); not win probability.
Signal Quality Engine|Held-out Brier skill versus the contract-specific no-edge baseline.
Signal Reliability Engine|Called-signal held-out Wilson interval and non-overlapping sample; residual serial dependence still limits coverage.
Signal Consistency Engine|Fraction of chronological held-out thirds with positive Brier skill.
Signal Stability Engine|Alias of #28. Shared stability evidence is never counted twice.
Signal Agreement Engine|Weight fraction of research models above the contract-specific baseline.
Contradiction Detection Engine|Research validation passes, but its calibrated contract probability is below fair while the legacy call is above fair.
Conflict Resolution Engine|A validated contradiction shrinks the existing edge by 75%; it never boosts an untested combined forecast.
Confirmation Engine|Existing out-of-sample confirmation verdict with independent research validation alongside it.
Multi-Level Confirmation Engine|Fresh data, sufficient independent replay, confirmed base signal and no validated contradiction.
Final Decision Engine|Always show the ranked candidate; execution remains observation-only unless evidence gates pass.
No-Trade Filter Engine|Block automatic loading for stale data, unconfirmed edge, insufficient independent sample or validated contradiction.
Weak-Signal Filter Engine|Require a material contract edge ≥ max(0.005, 0.01 × fair).
Noise Filter Engine|Unvalidated research forecasts are descriptive only and cannot increase signal confidence.
False-Signal Filter Engine|One-sided paired loss test with candidate-pool/model multiplicity correction.
Signal Timing Engine|Entry mode and waiting window from the existing chronologically validated entry policy.
Entry Timing Engine|Entry reach, validation sample and measured gain; no fabricated waiting advantage.
Short-Window Prediction Engine|Dirichlet-smoothed trailing-50 completed-outcome distribution.
Medium-Window Prediction Engine|Dirichlet-smoothed trailing-200 completed-outcome distribution.
Long-Window Prediction Engine|Dirichlet-smoothed trailing-1,000 completed-outcome distribution.
Next-Tick Prediction Engine|Independent one-tick forecast using the fixed multi-window distribution average; never relabelled as a longer expiry.
Multi-Tick Prediction Engine|Direct terminal-outcome model at the requested horizon, not an at-least-one-hit calculation.
Multi-Window Prediction Engine|Equal average of short, medium and long raw probabilities; the main ensemble applies its family budgets separately.
Ensemble Prediction Engine|Tuning-weighted research forecast followed by a separately fitted calibrator.
Adaptive Prediction Engine|Tuning-only model weights, frozen throughout calibration and final holdout.
Probability Ranking Engine|Rank available contract candidates by normalized edge and evidence, not by easiest raw hit rate.
Direction Ranking Engine|Rank strict rise/fall probabilities from the selected confirmed estimate and its same-sample flat mass; ties lose both directions.
Outcome Ranking Engine|Rank actual supported candidate outcomes by their estimated probabilities, separately from evidence-based trade selection.
Prediction Consensus Engine|Family-balanced current agreement of research models for the chosen event.
Prediction Stability Engine|Dispersion of current research-model probabilities and chronological held-out probabilities.
Prediction Reversal Engine|Compare short-window and long-window edge signs; descriptive disagreement, not an automatic reversal.
Prediction Momentum Engine|Short-window minus medium-window selected-event probability.
Historical Backtest Engine|Chronological replay: each forecast sees only outcomes already settled at its origin.
Rolling Backtest Engine|Latest 30 non-overlapping holdout predictions, without refitting their model weights.
Walk-Forward Analysis Engine|Expanding causal histories; tuning, calibration and holdout origins shown with boundary purging.
Out-of-Sample Testing Engine|Final non-overlapping holdout rows never used for weight selection or calibration.
Win-Rate Engine|Wins / called holdout rows; calls require probability > fair + the fixed material-edge threshold.
Loss-Rate Engine|Losses / called holdout rows, including strict Rise/Fall ties as losses.
Accuracy Engine|Binary selected-event classification accuracy at threshold 0.5, separately from trading hit rate.
Precision Engine|TP/(TP+FP) for selected-event classification at threshold 0.5; undefined with no predicted positives.
Recall Engine|TP/(TP+FN) for selected-event classification at threshold 0.5; undefined with no actual positives.
Expectancy Engine|Mean actual provider-reported settled profit per stake; unavailable without scoped settled history; external costs are not guessed.
Profit Factor Engine|Gross settled profits / absolute gross settled losses; undefined without losses.
Maximum Drawdown Engine|Largest peak-to-trough drop of additive actual settled P&L; no invented payout assumption.
Recovery Factor Engine|Total actual net P&L / maximum actual P&L drawdown; undefined for zero drawdown.
Sharpe Ratio Engine|Mean actual per-trade net return / sample SD; nonannualized, zero benchmark and comparable-trade assumption.
Sortino Ratio Engine|Mean actual per-trade return / sqrt(mean(min(return,0)²)); nonannualized with zero target.
Consecutive Win Engine|Maximum consecutive wins among actually called holdout predictions.
Consecutive Loss Engine|Maximum consecutive losses among actually called holdout predictions.
Streak Distribution Engine|Completed win/loss run lengths among called holdout predictions.
Signal Hit-Rate Engine|Called holdout win rate, explicitly distinguished from all-row accuracy.
Signal Failure-Rate Engine|One minus called holdout hit rate.
Prediction Calibration Engine|Five fixed reliability bins, weighted calibration error and Brier loss on untouched holdout.
Model Performance Engine|Per-model holdout Brier loss; reporting does not select or refit models on the holdout.
Engine Performance Ranking|Models ranked by tuning Brier loss with holdout loss displayed separately.
Ensemble Learning Engine|Family-balanced linear probability pool learned on tuning data only.
Adaptive Ensemble Engine|Report tuning-weight deviation from equal individual-model weights; family budgets remain active and updates require a new complete run.
Bayesian Model Averaging Engine|Equal-prior model posterior ∝ exp(sum tuning log likelihood), calculated in log space; diagnostic alternative, not an extra vote.
Dynamic Model Selection Engine|Lowest tuning Brier-loss model; holdout outcomes cannot choose it.
Regime-Aware Ensemble Engine|Best tuning model in the current causal regime, requiring ≥20 same-regime tuning rows; otherwise abstain.
Confidence Calibration Engine|Existing confidence is an evidence score, not a win probability; report independent probability reliability bins separately.
Probability Calibration Engine|Fit isotonic on calibration rows only, mix 50/50 with raw probabilities; identity if <40 rows or a missing class.
Feature Importance Engine|Fixed-model leave-one-model-out Brier loss difference on holdout; correlated inputs make this noncausal and nonadditive.
Feature Correlation Engine|Tuning-only Pearson correlations between model probability features.
Redundancy Detection Engine|Model pairs with |tuning correlation| ≥0.98; shared family budgets prevent duplicated frequency votes.
Engine Correlation Engine|Same tuning probability correlation matrix, surfaced for ensemble diagnostics rather than extra confidence.
Engine Contribution Engine|Weight × (model probability−fair) in probability points; sums to the raw ensemble edge.
Signal Attribution Engine|Largest signed model contribution; descriptive attribution, not causal feature importance.
Adaptive Threshold Engine|One-sided corrected loss-test threshold scales with candidates × models; material edge threshold stays explicit.
Dynamic Sensitivity Engine|Report selected-event sampling standard error sqrt(fair×(1−fair)/independent n).
Market-Adaptive Engine|Causal regime features condition research probabilities, with validation required before any predictive claim.
Self-Optimization Engine|Select model weights on tuning data only, never tune on reported holdout results.
Self-Validation Engine|At least 30 tuning and 40 non-overlapping test rows, Brier skill >0.005 and corrected paired-loss p<0.05.
Anomaly-Aware Prediction Engine|Describe anomalies, require freshness and replay validation; anomalies alone never raise probabilities.
Regime-Adaptive Prediction Engine|Regime-conditioned direct-horizon probability, scored independently like every research model.
Multi-Model Consensus Engine|Agreement of the legacy calibrated signal and the independently validated research forecast.
Master Signal Synthesis Engine|Combine contract semantics, evidence gates, contradiction handling and entry plan; real payout still required before claiming expectancy.
`.trim().split('\n');

export const ENGINE_CATEGORIES = [
  { name: 'Core Analysis', first: 1, last: 28 },
  { name: 'Digit Analysis', first: 29, last: 52 },
  { name: 'Matches', first: 53, last: 65 },
  { name: 'Even/Odd', first: 66, last: 77 },
  { name: 'Over/Under', first: 78, last: 93 },
  { name: 'Rise/Fall', first: 94, last: 107 },
  { name: 'Candles', first: 108, last: 127 },
  { name: 'Trend', first: 128, last: 141 },
  { name: 'Momentum & Oscillators', first: 142, last: 155 },
  { name: 'Volatility', first: 156, last: 166 },
  { name: 'Price Action', first: 167, last: 182 },
  { name: 'Statistics', first: 183, last: 203 },
  { name: 'Dependence & Sequences', first: 204, last: 218 },
  { name: 'Signal Synthesis', first: 219, last: 240 },
  { name: 'Prediction', first: 241, last: 255 },
  { name: 'Backtesting & Performance', first: 256, last: 278 },
  { name: 'Advanced Synthesis', first: 279, last: 300 },
] as const;

function domain(id: number): EngineDomain {
  if ([2, 6, 7, 215].includes(id) || (id >= 29 && id <= 52)) return 'digits';
  if (id >= 53 && id <= 65) return 'matches';
  if (id >= 66 && id <= 77) return 'even-odd';
  if (id >= 78 && id <= 93) return 'over-under';
  if (id === 23 || id === 206 || (id >= 94 && id <= 182)) return 'quotes';
  if (id >= 265 && id <= 270) return 'settled-trades';
  return 'all';
}
function role(id: number): EngineRole {
  if (id >= 235 && id <= 238) return 'filter';
  if (id >= 241 && id <= 255) return 'prediction';
  if (id >= 256 && id <= 259 || id === 296) return 'validation';
  if (id >= 260 && id <= 278) return 'performance';
  if (id >= 219) return 'synthesis';
  return 'measurement';
}
function sources(id: number): string[] {
  if (id === 214 || id === 24 || id === 77) return ['runs'];
  if (id === 215 || id === 216) return ['chi'];
  if (id === 197 || id === 226) return ['wilson'];
  if (id === 217) return ['series'];
  if (id >= 204 && id <= 218) return ['acf', 'series'];
  if (id >= 94 && id <= 182) return ['ta', 'eda'];
  if (id >= 53 && id <= 93) return ['deriv', 'eda'];
  if (id >= 265 && id <= 270) return ['sharpe', 'eda'];
  if (id >= 262 && id <= 264) return ['classification'];
  if (id >= 256 && id <= 300) return ['validation', 'calibration', 'correlation'];
  if (id >= 219) return ['calibration', 'leakage'];
  return ['eda', 'stats'];
}

export const ENGINE_CATALOG: readonly EngineDefinition[] = definitions.map((line, index) => {
  const id = index + 1;
  const separator = line.indexOf('|');
  const name = line.slice(0, separator);
  const method = line.slice(separator + 1);
  return {
    id, name, method, category: ENGINE_CATEGORIES.find((category) => id >= category.first && id <= category.last)!.name,
    domain: domain(id), role: role(id), sources: sources(id),
    ...(id === 166 ? { aliasOf: 23 } : id === 228 ? { aliasOf: 28 } : {}),
  };
});
if (ENGINE_CATALOG.length !== 300 || ENGINE_CATALOG.some((engine) => !engine.name || !engine.method)) {
  throw new Error('Engine catalog must contain the 300 explicitly defined entries.');
}
