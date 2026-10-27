/**
 * Quant maths — thirty-odd measurements over a series, all computed natively.
 *
 * These blocks take a list (the Ticks list block, the Signal Lab tick list, or
 * the output of another Vision block) and return a number or another list. The
 * heavy loops never run inside the interpreter, so a strategy can measure a
 * thousand ticks on every tick.
 */

import { localize } from '@deriv-com/translations';
import { defineValueBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().quant;
const category = window.Blockly.Categories.Vision_Quant;

const list = (name = 'LIST') => ({ type: 'input_value', name, check: 'Array', default: '[]' });
const num = (name, fallback) => numberInput(name, fallback);

const STATS = [
    [localize('mean'), 'mean'],
    [localize('median'), 'median'],
    [localize('sum'), 'sum'],
    [localize('lowest'), 'min'],
    [localize('highest'), 'max'],
    [localize('range'), 'range'],
    [localize('standard deviation'), 'stddev'],
    [localize('variance'), 'variance'],
    [localize('interquartile range'), 'iqr'],
    [localize('median absolute deviation'), 'mad'],
    [localize('root mean square'), 'rms'],
    [localize('skewness'), 'skew'],
    [localize('excess kurtosis'), 'kurtosis'],
    [localize('count'), 'count'],
];

/* ---------------- moving averages ---------------- */

defineValueBlock({
    type: 'q_sma',
    message: localize('simple moving average of %1 over %2'),
    args: [list(), num('PERIOD', '14')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The average of the last N values.'),
    display_name: localize('Simple moving average'),
    description: localize('The classic trend smoother. Price above a rising average is the textbook uptrend, but on a tick stream it lags badly — use the slope or the drift blocks when you need to react fast.'),
    call: input => `Bot.qSma(${input.LIST}, ${input.PERIOD})`,
});

defineValueBlock({
    type: 'q_ema',
    message: localize('exponential moving average of %1 over %2'),
    args: [list(), num('PERIOD', '14')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('A moving average that weights recent ticks more heavily.'),
    display_name: localize('Exponential moving average'),
    description: localize('Reacts faster than the simple average because every tick carries more weight than the one before it.'),
    call: input => `Bot.qEma(${input.LIST}, ${input.PERIOD})`,
});

defineValueBlock({
    type: 'q_wma',
    message: localize('weighted moving average of %1 over %2'),
    args: [list(), num('PERIOD', '14')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('A moving average whose weights rise linearly toward the newest tick.'),
    display_name: localize('Weighted moving average'),
    description: localize('Between the simple and the exponential average: a linear ramp of weights across the window.'),
    call: input => `Bot.qWma(${input.LIST}, ${input.PERIOD})`,
});

/* ---------------- oscillators ---------------- */

defineValueBlock({
    type: 'q_rsi',
    message: localize('RSI of %1 over %2'),
    args: [list(), num('PERIOD', '14')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Wilder’s RSI, 0-100, computed on tick-to-tick changes.'),
    display_name: localize('RSI'),
    description: localize('Above 70 the market has been rising much more than falling, below 30 the reverse. On a near-random synthetic index it spends most of its time near 50.'),
    call: input => `Bot.qRsi(${input.LIST}, ${input.PERIOD})`,
});

defineValueBlock({
    type: 'q_macd',
    message: localize('MACD %1 of %2 fast %3 slow %4 signal %5'),
    args: [dropdown('PART', [[localize('line'), 'line'], [localize('signal'), 'signal']]), list(), num('FAST', '12'), num('SLOW', '26'), num('SIGNAL', '9')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Moving-average convergence/divergence: the fast EMA minus the slow one, or its signal line.'),
    display_name: localize('MACD'),
    description: localize('The line crossing its signal is the classic trigger; the gap between them measures how hard the market is pushing.'),
    call: (input, field) => `Bot.qMacd(${input.LIST}, ${input.FAST}, ${input.SLOW}, ${input.SIGNAL}, ${field.PART === '"signal"' ? 'true' : 'false'})`,
});

defineValueBlock({
    type: 'q_bollinger',
    message: localize('Bollinger %B of %1 period %2 deviations %3'),
    args: [list(), num('PERIOD', '20'), num('DEVIATIONS', '2')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('0 at the lower band, 1 at the upper band; outside that range the market is beyond the bands.'),
    display_name: localize('Bollinger %B'),
    description: localize('A stretched market shows up as a value below 0 or above 1 — the raw material of a mean-reversion rule.'),
    call: input => `Bot.qBollinger(${input.LIST}, ${input.PERIOD}, ${input.DEVIATIONS})`,
});

/* ---------------- dispersion and shape ---------------- */

defineValueBlock({
    type: 'q_stddev',
    message: localize('standard deviation of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How widely the values spread around their mean.'),
    display_name: localize('Standard deviation'),
    description: localize('The basic measure of volatility. Compare a short window with a long one to detect the market speeding up or calming down.'),
    call: input => `Bot.qStdDev(${input.LIST})`,
});

defineValueBlock({
    type: 'q_variance',
    message: localize('variance of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The square of the standard deviation.'),
    display_name: localize('Variance'),
    description: localize('Useful when you are combining risks: variances add, standard deviations do not.'),
    call: input => `Bot.qVariance(${input.LIST})`,
});

defineValueBlock({
    type: 'q_stat',
    message: localize('%1 of %2'),
    args: [dropdown('STAT', STATS), list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('One of fourteen summary statistics of a series.'),
    display_name: localize('Series statistic'),
    description: localize('Everything from the mean to the excess kurtosis in a single block, so you can describe a window of ticks without building a loop.'),
    call: (input, field) => `Bot.qStat(${input.LIST}, ${field.STAT})`,
});

defineValueBlock({
    type: 'q_percentile',
    message: localize('%1 th percentile of %2'),
    args: [num('P', '50'), list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The value below which this share of the series falls.'),
    display_name: localize('Percentile'),
    description: localize('The median is the 50th percentile; the 5th and 95th make a robust range that ignores outliers.'),
    call: input => `Bot.qPercentile(${input.LIST}, ${input.P})`,
});

defineValueBlock({
    type: 'q_zscore',
    message: localize('z-score of %1 in %2'),
    args: [num('VALUE', '0'), list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many standard deviations a value sits from the mean of a series.'),
    display_name: localize('Z-score'),
    description: localize('The AI measures “stretched” exactly this way: a z-score beyond ±2 is unusual for a random walk.'),
    call: input => `Bot.qZscore(${input.LIST}, ${input.VALUE})`,
});

defineValueBlock({
    type: 'q_slope',
    message: localize('regression slope of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Least-squares slope per tick: positive means the window is rising.'),
    display_name: localize('Regression slope'),
    description: localize('A smoother, more stable read on direction than comparing the first and last tick.'),
    call: input => `Bot.qSlope(${input.LIST})`,
});

defineValueBlock({
    type: 'q_correlation',
    message: localize('correlation of %1 with %2'),
    args: [list('A'), list('B')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Pearson correlation, -1 to 1, between two equally long series.'),
    display_name: localize('Correlation'),
    description: localize('Point it at two markets to see whether they are moving together, or at a series and its own past to spot a lagged relationship.'),
    call: input => `Bot.qCorrelation(${input.A}, ${input.B})`,
});

defineValueBlock({
    type: 'q_autocorr',
    message: localize('autocorrelation of %1 at lag %2'),
    args: [list(), num('LAG', '1')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How much a value predicts the next one. Negative means the market snaps back.'),
    display_name: localize('Autocorrelation'),
    description: localize('A negative reading is mean reversion, a positive one is momentum. A synthetic index sits very close to zero, which is why the AI leans on this to label the regime.'),
    call: input => `Bot.qAutocorr(${input.LIST}, ${input.LAG})`,
});

defineValueBlock({
    type: 'q_hurst',
    message: localize('Hurst exponent of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('~0.5 is a random walk, above 0.5 trends, below 0.5 mean reverts.'),
    display_name: localize('Hurst exponent'),
    description: localize('A rescaled-range estimate. It needs a few hundred ticks to mean anything, so feed it the whole tick list rather than a short window.'),
    call: input => `Bot.qHurst(${input.LIST})`,
});

defineValueBlock({
    type: 'q_entropy',
    message: localize('digit entropy of %1 (bits)'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Shannon entropy of the last-digit distribution; 3.32 bits is perfectly even.'),
    display_name: localize('Digit entropy'),
    description: localize('A low reading means the digits are lopsided — the only condition under which a digit contract can carry an edge at all.'),
    call: input => `Bot.qEntropy(${input.LIST})`,
});

/* ---------------- volatility and risk of the series ---------------- */

defineValueBlock({
    type: 'q_atr',
    message: localize('average tick range of %1 over %2'),
    args: [list(), num('PERIOD', '14')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The average size of a tick-to-tick move — the tick-stream version of ATR.'),
    display_name: localize('Average tick range'),
    description: localize('The natural unit for setting barriers and stops on a market that has no candles.'),
    call: input => `Bot.qAtr(${input.LIST}, ${input.PERIOD})`,
});

defineValueBlock({
    type: 'q_volatility',
    message: localize('volatility of %1 over %2'),
    args: [list(), num('PERIOD', '100')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Standard deviation of the tick-to-tick changes over the last N ticks.'),
    display_name: localize('Volatility'),
    description: localize('Short-window volatility over long-window volatility is how the AI decides whether the market is heating up or going quiet.'),
    call: input => `Bot.qVolatility(${input.LIST}, ${input.PERIOD})`,
});

defineValueBlock({
    type: 'q_drawdown',
    message: localize('largest fall in %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The biggest peak-to-trough drop inside the series.'),
    display_name: localize('Maximum drawdown'),
    description: localize('A direct read on how far this market has travelled against a position, in quote points.'),
    call: input => `Bot.qDrawdown(${input.LIST})`,
});

defineValueBlock({
    type: 'q_streak',
    message: localize('rise/fall streak of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many ticks in a row the market has risen (+) or fallen (−).'),
    display_name: localize('Rise/fall streak'),
    description: localize('Gambler’s fallacy bait on a fair market — but a useful filter when it is measured rather than assumed.'),
    call: input => `Bot.qStreak(${input.LIST})`,
});

/* ---------------- series builders ---------------- */

defineValueBlock({
    type: 'q_returns',
    message: localize('tick changes of %1'),
    args: [list()],
    output: 'Array',
    colour,
    category,
    tooltip: localize('The tick-to-tick differences of a series, one shorter than the input.'),
    display_name: localize('Tick changes'),
    description: localize('Feed it into the statistic blocks to measure the market’s movement instead of its level.'),
    call: input => `Bot.qReturns(${input.LIST})`,
});

defineValueBlock({
    type: 'q_last_digits',
    message: localize('last digits of %1'),
    args: [list()],
    output: 'Array',
    colour,
    category,
    tooltip: localize('The final digit of every quote, 0-9, using the market’s decimal places.'),
    display_name: localize('Last digits'),
    description: localize('The series every digit contract settles on. Analyse it directly instead of guessing.'),
    call: input => `Bot.qLastDigits(${input.LIST})`,
});

defineValueBlock({
    type: 'q_digit_counts',
    message: localize('digit counts of %1'),
    args: [list()],
    output: 'Array',
    colour,
    category,
    tooltip: localize('Ten numbers: how many times each digit appeared.'),
    display_name: localize('Digit counts'),
    description: localize('Compare the counts with the List blocks, or feed them into the statistic block to measure how lopsided the digits are.'),
    call: input => `Bot.qDigitCounts(${input.LIST})`,
});

defineValueBlock({
    type: 'q_window',
    message: localize('last %1 of %2'),
    args: [num('COUNT', '100'), list()],
    output: 'Array',
    colour,
    category,
    tooltip: localize('The newest N values of a series, oldest first.'),
    display_name: localize('Window'),
    description: localize('Measure a short window and a long one and compare them: that is how the AI spots a regime change.'),
    call: input => `Bot.qWindow(${input.LIST}, ${input.COUNT})`,
});

defineValueBlock({
    type: 'q_change',
    message: localize('change in %1 over %2 ticks'),
    args: [list(), num('COUNT', '20')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The newest value minus the value that many ticks back.'),
    display_name: localize('Change over N ticks'),
    description: localize('The quickest momentum read available, and the one the AI uses as its drift feature.'),
    call: input => `Bot.qChange(${input.LIST}, ${input.COUNT})`,
});

defineValueBlock({
    type: 'q_change_percent',
    message: localize('% change in %1 over %2 ticks'),
    args: [list(), num('COUNT', '20')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The change over N ticks as a percentage of the starting value.'),
    display_name: localize('Percent change'),
    description: localize('Use it to compare markets that trade on very different price scales.'),
    call: input => `Bot.qChangePercent(${input.LIST}, ${input.COUNT})`,
});

/* ---------------- number helpers ---------------- */

defineValueBlock({
    type: 'q_digit_of',
    message: localize('last digit of %1'),
    args: [num('VALUE', '0')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The final digit of any number, using the traded market’s decimal places.'),
    display_name: localize('Last digit of a number'),
    description: localize('The same rounding rule the exchange uses to settle a digit contract, applied to any number you have.'),
    call: input => `Bot.qDigitOf(${input.VALUE}, -1)`,
});

defineValueBlock({
    type: 'q_round',
    message: localize('round %1 to %2 decimals'),
    args: [num('VALUE', '0'), num('DIGITS', '2')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Rounds to a fixed number of decimals.'),
    display_name: localize('Round'),
    description: localize('Stakes and barriers are rejected when they carry too many decimals — round before you send them.'),
    call: input => `Bot.qRound(${input.VALUE}, ${input.DIGITS})`,
});

defineValueBlock({
    type: 'q_clamp',
    message: localize('clamp %1 between %2 and %3'),
    args: [num('VALUE', '0'), num('LOW', '0'), num('HIGH', '1')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Keeps a value inside a range.'),
    display_name: localize('Clamp'),
    description: localize('The safest way to cap a calculated stake or barrier before it reaches the trade options.'),
    call: input => `Bot.qClamp(${input.VALUE}, ${input.LOW}, ${input.HIGH})`,
});

defineValueBlock({
    type: 'q_map',
    message: localize('map %1 from %2…%3 to %4…%5'),
    args: [num('VALUE', '0'), num('IN_LOW', '0'), num('IN_HIGH', '1'), num('OUT_LOW', '0'), num('OUT_HIGH', '100')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Rescales a value from one range onto another.'),
    display_name: localize('Map range'),
    description: localize('Turn a confidence of 0-1 into a stake multiplier of 0.25-1, for example.'),
    call: input => `Bot.qMap(${input.VALUE}, ${input.IN_LOW}, ${input.IN_HIGH}, ${input.OUT_LOW}, ${input.OUT_HIGH})`,
});

defineValueBlock({
    type: 'q_lerp',
    message: localize('mix %1 and %2 by %3'),
    args: [num('A', '0'), num('B', '1'), num('T', '0.5')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Linear interpolation: 0 gives the first value, 1 the second.'),
    display_name: localize('Mix'),
    description: localize('Blend two numbers by any weight, e.g. a fast and a slow estimate of the same quantity.'),
    call: input => `Bot.qLerp(${input.A}, ${input.B}, ${input.T})`,
});

defineValueBlock({
    type: 'q_seeded',
    message: localize('seeded random from %1'),
    args: [num('SEED', '1')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('A repeatable pseudo-random number between 0 and 1.'),
    display_name: localize('Seeded random'),
    description: localize('Unlike the built-in random block, the same seed always gives the same value — so a strategy that uses it can be replayed exactly.'),
    call: input => `Bot.qSeeded(${input.SEED})`,
});

defineValueBlock({
    type: 'q_pip_size',
    message: localize('decimal places of this market'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many decimals the traded market quotes, and therefore what its last digit means.'),
    display_name: localize('Market decimal places'),
    description: localize('Two on most volatility indices, so the last digit is the hundredth. Every digit calculation depends on it.'),
    call: () => 'Bot.qPipSize()',
});
