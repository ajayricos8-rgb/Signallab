/**
 * Market analysis — the structure of the tape and of the digit stream.
 *
 * These blocks measure rather than predict: how lopsided the digits are, how
 * long the current run is, how far the market is from a round level. They are
 * the pieces the AI is built from, exposed so a strategy can use them directly.
 */

import { localize } from '@deriv-com/translations';
import { defineStatementBlock, defineValueBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().analysis;
const category = window.Blockly.Categories.Vision_Analysis;

const list = (name = 'LIST') => ({ type: 'input_value', name, check: 'Array', default: '[]' });
const num = (name, fallback) => numberInput(name, fallback);

/* ---------------- the digit stream ---------------- */

defineValueBlock({
    type: 'm_digit_frequency',
    message: localize('frequency of digit %1 in %2 %'),
    args: [num('DIGIT', '0'), list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How often this digit appeared in the series, in percent. 10% is perfectly even.'),
    display_name: localize('Digit frequency'),
    description: localize('The oldest digit trick there is — and the one to check first. On a fair synthetic index every digit lands near 10%.'),
    call: input => `Bot.mDigitFrequency(${input.LIST}, ${input.DIGIT})`,
});

defineValueBlock({
    type: 'm_digit_bias',
    message: localize('bias of digit %1 in %2 (points)'),
    args: [num('DIGIT', '0'), list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Frequency minus 10, in percentage points: positive means the digit is over-represented.'),
    display_name: localize('Digit bias'),
    description: localize('The raw edge signal. Compare it with the payout margin before believing it: a bias of a third of a point cannot pay a five percent margin.'),
    call: input => `Bot.mDigitBias(${input.LIST}, ${input.DIGIT})`,
});

defineValueBlock({
    type: 'm_digit_probability',
    message: localize('historical chance of %1 %2 over %3 ticks in %4 %'),
    args: [dropdown('DIRECTION', [[localize('over'), 'over'], [localize('under'), 'under']]), num('BARRIER', '5'), num('HORIZON', '5'), list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Replays the series: how often the digit that many ticks later was over or under this barrier.'),
    display_name: localize('Historical over/under chance'),
    description: localize('The straight empirical answer, with no model behind it. It is the benchmark every AI forecast has to beat.'),
    call: (input, field) => `Bot.mDigitProbability(${input.LIST}, ${field.DIRECTION}, ${input.BARRIER}, ${input.HORIZON})`,
});

defineValueBlock({
    type: 'm_transition',
    message: localize('chance digit %1 becomes %2 after %3 ticks in %4 %'),
    args: [num('FROM', '0'), num('TO', '0'), num('HORIZON', '1'), list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('P(next digit = this | digit now = that), measured from the series.'),
    display_name: localize('Digit transition'),
    description: localize('Digits are not always independent. When they are not, this table is where it shows up first.'),
    call: input => `Bot.mTransition(${input.LIST}, ${input.FROM}, ${input.TO}, ${input.HORIZON})`,
});

defineValueBlock({
    type: 'm_dominant_digit',
    message: localize('most frequent digit in %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The digit that appeared most often.'),
    display_name: localize('Most frequent digit'),
    description: localize('A quick way to describe a window, and the laziest signal there is — check its bias before trading it.'),
    call: input => `Bot.mDominantDigit(${input.LIST})`,
});

defineValueBlock({
    type: 'm_digit_spread',
    message: localize('digit spread of %1 (points)'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The gap between the most and the least frequent digit, in percentage points.'),
    display_name: localize('Digit spread'),
    description: localize('How lopsided the whole table is in one number. Under about two points the distribution is indistinguishable from even.'),
    call: input => `Bot.mDigitSpread(${input.LIST})`,
});

defineValueBlock({
    type: 'm_digit_chi_square',
    message: localize('digit chi-square of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Chi-square statistic of the digits against an even distribution. Above about 16.9 the imbalance is too large to be chance (9 degrees of freedom, 95%)'),
    display_name: localize('Digit chi-square'),
    description: localize('The honest test for “these digits are not even”. A value below 16.9 is exactly what you expect from a fair stream.'),
    call: input => `Bot.mDigitChiSquare(${input.LIST})`,
});

defineValueBlock({
    type: 'm_digit_streak',
    message: localize('digit repeat streak of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many ticks in a row the last digit has repeated.'),
    display_name: localize('Digit repeat streak'),
    description: localize('Matches and Differs traders live on this number. On a fair stream a repeat is a one-in-ten event, so long streaks are rare.'),
    call: input => `Bot.mDigitStreak(${input.LIST})`,
});

defineValueBlock({
    type: 'm_parity_run',
    message: localize('even/odd run of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many even (+) or odd (−) digits in a row.'),
    display_name: localize('Even/odd run'),
    description: localize('The Even/Odd equivalent of a streak. It is a description of what just happened, never a prediction of what comes next.'),
    call: input => `Bot.mParityRun(${input.LIST})`,
});

defineValueBlock({
    type: 'm_over_under_run',
    message: localize('run over (+) or under (−) %1 in %2'),
    args: [num('BARRIER', '5'), list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many ticks in a row the last digit has stayed above or below this barrier.'),
    display_name: localize('Over/under run'),
    description: localize('Read the shape of the digit stream relative to the barrier you are thinking of trading.'),
    call: input => `Bot.mOverUnderRun(${input.LIST}, ${input.BARRIER})`,
});

defineValueBlock({
    type: 'm_even_share',
    message: localize('even digits in %1 %'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The share of last digits that are even. 50% is balanced.'),
    display_name: localize('Even digit share'),
    description: localize('The simplest form of the parity measurement the AI feeds into its state vector.'),
    call: input => `Bot.mEvenShare(${input.LIST})`,
});

/* ---------------- the tape ---------------- */

defineValueBlock({
    type: 'm_hurst',
    message: localize('Hurst exponent of %1'),
    args: [list()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('~0.5 is a random walk, above 0.5 trends, below 0.5 mean reverts.'),
    display_name: localize('Hurst exponent (market)'),
    description: localize('Same estimate as the Quant block, placed here because it is the number that decides which kind of strategy makes sense today.'),
    call: input => `Bot.mHurst(${input.LIST})`,
});

defineValueBlock({
    type: 'm_distance_to_level',
    message: localize('distance from %1 to the nearest %2 level'),
    args: [list(), num('STEP', '1')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How far the last quote sits from the nearest round level of this size, in quote points.'),
    display_name: localize('Distance to a level'),
    description: localize('Round-number levels attract quotes on some markets; this measures exactly how close the market is to one.'),
    call: input => `Bot.mDistanceToLevel(${input.LIST}, ${input.STEP})`,
});

defineStatementBlock({
    type: 'm_measure_speed',
    command: true,
    message: localize('measure the market speed'),
    args: [],
    colour,
    category,
    tooltip: localize('Counts the ticks that arrive over the next couple of seconds and remembers the rate.'),
    display_name: localize('Measure market speed'),
    description: localize('Call it once at the start, then read the ticks-per-minute block anywhere. It costs a short pause, so it belongs outside the purchase loop.'),
    call: () => 'Bot.mMeasureSpeed()',
});

defineValueBlock({
    type: 'm_tick_rate',
    message: localize('market speed (ticks per minute)'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The last measured tick rate. 0 until the measure block has run.'),
    display_name: localize('Market speed'),
    description: localize('One-second indices run at about 60 ticks a minute, the standard ones near 60-120 depending on the market. Use it to size your horizons.'),
    call: () => 'Bot.mTickRate()',
});
