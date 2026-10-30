/**
 * AI Core — the blocks that read the Vision engine's decision.
 *
 * `vision_analyse` computes one decision and caches it for the tick; every
 * other block in this file reads that same decision, so a strategy can never
 * end up with a barrier from one moment and a stake from another.
 */

import { localize } from '@deriv-com/translations';
import { defineStatementBlock, defineValueBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().ai;
const category = window.Blockly.Categories.Vision_AI;

const FEATURES = [
    [localize('stretch (σ from the mean)'), 'displacement'],
    [localize('drift'), 'drift'],
    [localize('volatility ratio'), 'volratio'],
    [localize('digit position'), 'digit'],
    [localize('even/odd lean'), 'parity'],
    [localize('tick volatility'), 'volatility'],
    [localize('digit entropy'), 'entropy'],
    [localize('Hurst'), 'hurst'],
    [localize('autocorrelation'), 'acf'],
    [localize('rise/fall streak'), 'streak'],
    [localize('digit repeat streak'), 'digitstreak'],
    [localize('digit spread'), 'spread'],
    [localize('even share'), 'even'],
    [localize('RSI 14'), 'rsi'],
    [localize('drawdown'), 'drawdown'],
];

const MODELS = [
    [localize('analog replay'), 'analog'],
    [localize('long-run frequency'), 'frequency'],
    [localize('recent frequency'), 'recent'],
    [localize('digit transition'), 'transition'],
    [localize('price momentum'), 'momentum'],
    [localize('neural net'), 'neural'],
    [localize('regime switching'), 'regime'],
    [localize('fair odds'), 'uniform'],
];

/* ------------------------------------------------------------------ *
 * The analysis command
 * ------------------------------------------------------------------ */

defineStatementBlock({
    type: 'vision_analyse',
    command: true,
    message: localize('AI Vision: read the market · horizon %1 ticks · min edge %2 % · min lean %3 σ · min confidence %4 · agreement %5 · risk %6'),
    args: [
        numberInput('HORIZON', '5'),
        numberInput('MIN_EDGE', '-100'),
        numberInput('MIN_LEAN', '0'),
        numberInput('MIN_CONFIDENCE', '0'),
        numberInput('AGREEMENT', '0'),
        numberInput('RISK', '0.6'),
    ],
    inputsInline: false,
    colour,
    category,
    tooltip: localize(
        'Runs the full AI read once per tick: eight models forecast the last digit, the payout table prices every barrier, and the best expected value is cached for the other AI blocks. A minimum edge below -50 switches the expected-value gate off, and a minimum lean of 0 switches the significance gate off too, which is the default: the bot trades the strongest lean it can measure on every tick. Raise the lean to 1.5 or more to insist on a lean bigger than the noise.'
    ),
    display_name: localize('AI Vision: read the market'),
    description: localize(
        'The engine behind the AI blocks. It measures the market, forecasts the distribution of the last digit at expiry, reads the live payout table, then picks the barrier and direction with the strongest measured lean. Call it once at the top of your purchase conditions; every other AI block then reads the same decision. Minimum edge is the strict expected-value gate: leave it negative to trade the best measured lean, raise it to 0 or more to insist on a trade that beats the payout margin. Minimum lean is the significance gate, and it ships at 0 so the bot actually opens positions: it then buys the strongest lean it can measure every tick, however thin, and prints the lean in sigma and the true expected value on every entry so you can see what you are getting. Raise it to 1.5 or more and the bot will start refusing most ticks, which is the honest measure of how much of what it does is signal.'
    ),
    call: input =>
        `Bot.visionAnalyse(${input.HORIZON}, ${input.MIN_EDGE}, ${input.MIN_LEAN}, ${input.MIN_CONFIDENCE}, ${input.AGREEMENT}, ${input.RISK})`,
});

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

defineValueBlock({
    type: 'vision_go',
    message: localize('AI says trade'),
    args: [],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True when the AI has a contract it will buy. With the entry bars off — the shipped default — that is every tick.'),
    display_name: localize('AI says trade'),
    description: localize('The entry switch. With every bar off it is true on every tick: the AI always names the best contract it can price, and a plan that refuses to buy it is a bot that looks dead. Raise the minimum lean (or the minimum edge) and it starts refusing the ticks that do not clear your bars.'),
    call: () => 'Bot.visionGo()',
});

defineValueBlock({
    type: 'vision_entry_ready',
    message: localize('the bot may open a position · at most 1 every %1 s'),
    args: [numberInput('GAP', '2')],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True when the last marked entry is at least this many seconds old. The default of 2 s keeps the bot to roughly one position every two seconds, however fast the market ticks.'),
    display_name: localize('Entry is allowed now'),
    description: localize(
        'The pace control. Put it in your purchase conditions next to the AI switch: the bot reads the market on every tick but only opens a position when this says yes. A gap of 0 removes the limit entirely.'
    ),
    call: input => `Bot.visionEntryReady(${input.GAP})`,
});

defineStatementBlock({
    type: 'vision_mark_entry',
    command: true,
    message: localize('mark a position as opened'),
    args: [],
    colour,
    category,
    tooltip: localize('Tells the pace control that a position was just opened. Place it immediately before the purchase block.'),
    display_name: localize('Mark position opened'),
    description: localize(
        'Without it the pace control never advances and every tick would be refused after the first entry. It records the moment of the purchase, nothing else — it does not buy.'
    ),
    call: () => 'Bot.visionMarkEntry()',
});

defineStatementBlock({
    type: 'vision_wait_entry',
    command: true,
    message: localize('wait for the entry pace · 1 position every %1 s'),
    args: [numberInput('GAP', '2')],
    colour,
    category,
    tooltip: localize('Holds the strategy until the entry pace allows another position, while the tick block keeps reading the market.'),
    display_name: localize('Wait for the entry pace'),
    description: localize(
        'Place it in the after-purchase block, just before Trade again. Waiting here rather than in the purchase conditions means the next cycle starts from a fresh decision: the barrier, stake and direction are priced after the pause, not two seconds before it.'
    ),
    call: input => `Bot.visionWaitForEntry(${input.GAP})`,
});

defineValueBlock({
    type: 'vision_ticks',
    message: localize('ticks on this market'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many ticks of history the AI can see on the market the bot is standing on right now.'),
    display_name: localize('Ticks on this market'),
    description: localize('The AI needs a dozen to start reading. Watch it climb after a market switch to see that the stream is alive.'),
    call: () => 'Bot.visionTicks()',
});

defineValueBlock({
    type: 'vision_ready',
    message: localize('the AI can read this market'),
    args: [],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True once this market has the minimum number of ticks the AI needs.'),
    display_name: localize('Market is readable'),
    description: localize('Gate on it if you would rather wait for a real read after a switch than let the bot buy the neutral contract.'),
    call: () => 'Bot.visionReady()',
});

defineValueBlock({
    type: 'vision_barrier',
    message: localize('AI barrier'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The barrier digit the AI chose (0-9). Falls back to the last barrier it priced, then to the widest Over (0), so trade options are never built from an invalid digit.'),
    display_name: localize('AI barrier'),
    description: localize('Use it as the Prediction of the trade options block so every contract is bought on the barrier the AI just priced. It never returns -1: the API rejects that, which silently swallows the entry.'),
    call: () => 'Bot.visionBarrier()',
});

defineValueBlock({
    type: 'vision_direction',
    message: localize('AI direction'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize("'over' or 'under' — the side of the barrier the AI wants to buy."),
    display_name: localize('AI direction'),
    description: localize("Compare it with the Text blocks to choose between the Over and the Under purchase blocks. It answers 'over' rather than 'wait' when the AI has nothing fresh, so a purchase block always has a side to buy."),
    call: () => 'Bot.visionDirection()',
});

defineValueBlock({
    type: 'vision_contract',
    message: localize('AI contract type'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize("'DIGITOVER', 'DIGITUNDER' or an empty string when the AI is waiting."),
    display_name: localize('AI contract type'),
    description: localize('The exact contract type the AI priced, useful for logging which side of the book the bot is on.'),
    call: () => 'Bot.visionDirection() === "over" ? "DIGITOVER" : Bot.visionDirection() === "under" ? "DIGITUNDER" : ""',
});

defineValueBlock({
    type: 'vision_probability',
    message: localize('AI win chance %'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The AI’s probability of winning the contract it picked, in percent.'),
    display_name: localize('AI win chance'),
    description: localize('Every model’s forecast, blended by how well each model has been doing on this market and shrunk toward the fair odds by how much data backed it.'),
    call: () => 'Bot.visionProbability()',
});

defineValueBlock({
    type: 'vision_fair',
    message: localize('AI fair odds %'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('What the contract would win if every digit were equally likely (winning digits ÷ 10).'),
    display_name: localize('AI fair odds'),
    description: localize('The yardstick: an edge is only real when the AI’s probability sits above this number by more than the payout margin.'),
    call: () => 'Bot.visionFair()',
});

defineValueBlock({
    type: 'vision_edge',
    message: localize('AI edge %'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Expected value per stake in percent: win chance × payout − 1.'),
    display_name: localize('AI edge'),
    description: localize('The number the entry decision is made on. Below your minimum edge the bot waits instead of trading.'),
    call: () => 'Bot.visionEdge()',
});

defineValueBlock({
    type: 'vision_bias',
    message: localize('AI bias over fair (points)'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How far the AI’s probability sits above the fair odds, in percentage points.'),
    display_name: localize('AI bias over fair'),
    description: localize('A sanity read-out: a large payout with a thin bias is a coin flip dressed up as an opportunity.'),
    call: () => 'Bot.visionBias()',
});

defineValueBlock({
    type: 'vision_confidence',
    message: localize('AI confidence'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('0-100: how much the models agree, how much data backed the call, and how skilled the ensemble has been on this market.'),
    display_name: localize('AI confidence'),
    description: localize('Not a probability — a quality score. Low confidence means the models disagree or the sample behind them is thin.'),
    call: () => 'Bot.visionConfidence()',
});

defineValueBlock({
    type: 'vision_agreement',
    message: localize('AI model agreement %'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The share of models that see the bias in the same direction as the chosen contract.'),
    display_name: localize('AI model agreement'),
    description: localize('One model finding an edge is noise; most of them finding the same one is a signal. Raise the agreement floor in the read block to trade less and pickier.'),
    call: () => 'Bot.visionAgreement()',
});

defineValueBlock({
    type: 'vision_payout',
    message: localize('AI payout ×'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The payout multiple of the chosen contract, read live from Deriv (or modelled until the first table arrives).'),
    display_name: localize('AI payout multiple'),
    description: localize('The AI prices every barrier against this number, so it only takes the trades where the payout actually beats the measured probability.'),
    call: () => 'Bot.visionPayout()',
});

defineValueBlock({
    type: 'vision_stake',
    message: localize('AI stake from %1'),
    args: [numberInput('BASE', '1')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Your base stake scaled by the size of the edge and the confidence behind it.'),
    display_name: localize('AI stake'),
    description: localize('Full size once the edge reaches the target, a fraction of it for thin edges, and a quarter stake when the AI is not trading.'),
    call: input => `Bot.visionStake(${input.BASE})`,
});

defineValueBlock({
    type: 'vision_reason',
    message: localize('AI reason'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('Why the AI is trading or waiting, in one line.'),
    display_name: localize('AI reason'),
    description: localize('“edge 0.80% below the 1.5% floor”, “only 40% of models agree” — the honest explanation for a skipped tick.'),
    call: () => 'Bot.visionReason()',
});

defineValueBlock({
    type: 'vision_summary',
    message: localize('AI plan summary'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('One line with the direction, barrier, probability, fair odds, payout, edge and confidence.'),
    display_name: localize('AI plan summary'),
    description: localize('Feed it into Notify or the journal to watch what the AI is thinking on every tick.'),
    call: () => 'Bot.visionSummary()',
});

defineValueBlock({
    type: 'vision_horizon',
    message: localize('AI contract horizon (ticks)'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many ticks ahead the AI is forecasting, taken from your trade options.'),
    display_name: localize('AI contract horizon'),
    description: localize('The engine always forecasts the digit at the moment your contract expires, whatever duration you set in the trade options.'),
    call: () => 'Bot.visionHorizon()',
});

/* ------------------------------------------------------------------ *
 * Looking inside the model
 * ------------------------------------------------------------------ */

defineValueBlock({
    type: 'vision_digit_probability',
    message: localize('AI chance the last digit is %1 %'),
    args: [numberInput('DIGIT', '0')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The blended probability, in percent, that the digit at expiry equals this digit.'),
    display_name: localize('AI digit probability'),
    description: localize('Build your own rules on top of the full ten-digit distribution instead of the contract the AI picked.'),
    call: input => `Bot.visionDigitProbability(${input.DIGIT})`,
});

defineValueBlock({
    type: 'vision_feature',
    message: localize('AI feature %1'),
    args: [dropdown('FEATURE', FEATURES)],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Any single measurement the AI is built on, standardised where that makes them comparable.'),
    display_name: localize('AI feature'),
    description: localize('Read the raw inputs of the model — stretch, drift, volatility ratio, entropy, Hurst and more — and write your own filters with them.'),
    call: (input, field) => `Bot.visionFeature(${field.FEATURE})`,
});

defineValueBlock({
    type: 'vision_model_vote',
    message: localize('AI model %1 win chance %'),
    args: [dropdown('MODEL', MODELS)],
    output: 'Number',
    colour,
    category,
    tooltip: localize('What a single model thinks about the contract the AI chose, in percent.'),
    display_name: localize('AI model vote'),
    description: localize('Compare the models against each other: if the analog replay and the transition table disagree, the setup is fragile.'),
    call: (input, field) => `Bot.visionModelVote(${field.MODEL})`,
});

defineValueBlock({
    type: 'vision_model_weight',
    message: localize('AI model %1 weight %'),
    args: [dropdown('MODEL', MODELS)],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How much of the blend this model currently carries.'),
    display_name: localize('AI model weight'),
    description: localize('Weights move on their own: a model that forecasts well on this market earns a bigger share, one that keeps missing fades away.'),
    call: (input, field) => `Bot.visionModelWeight(${field.MODEL})`,
});

defineValueBlock({
    type: 'vision_record',
    message: localize('AI own hit rate %'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize(
        'The share of the decisions this rule published that went on to win, over the contracts that have settled. Shadow samples never count here.'
    ),
    display_name: localize('AI own hit rate'),
    description: localize(
        'The rule grading itself. Compare it with the break-even of the contracts it buys (100 / payout): above it, the estimates have been earned; below it, the estimate is being pulled back toward the fair anchor.'
    ),
    call: () => 'Bot.visionRecord()',
});

defineValueBlock({
    type: 'vision_record_samples',
    message: localize('AI own record samples'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many settled decisions the own hit rate is measured on. Below 20 the calibration is switched off.'),
    display_name: localize('AI own record samples'),
    description: localize('A hit rate on ten trades is noise. The engine waits for twenty before it lets the record move a single estimate.'),
    call: () => 'Bot.visionRecordSamples()',
});

defineValueBlock({
    type: 'vision_calibration',
    message: localize('AI calibration factor'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How far the record is moving the estimate: 1 neutral, up to 1.25 when earned, down to 0.35 when it is not.'),
    display_name: localize('AI calibration factor'),
    description: localize(
        'The second opinion on the ensemble: the probability is pulled toward the fair anchor by this factor, so a losing record shrinks the edge instead of parking the bot.'
    ),
    call: () => 'Bot.visionCalibration()',
});

defineValueBlock({
    type: 'vision_regime',
    message: localize('AI market regime'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize("'trend', 'reversion', 'chop', 'biased' or 'balanced'."),
    display_name: localize('AI market regime'),
    description: localize('A one-word read of the tape from the Hurst exponent, the autocorrelation and the digit entropy — handy for switching logic between market moods.'),
    call: () => 'Bot.visionRegime()',
});

/* ------------------------------------------------------------------ *
 * Learning and housekeeping
 * ------------------------------------------------------------------ */

defineStatementBlock({
    type: 'vision_learn',
    command: true,
    message: localize('teach the AI with exit digit %1'),
    args: [numberInput('DIGIT', '-1')],
    colour,
    category,
    tooltip: localize('Feeds the settled digit back into the AI. -1 reads it from the contract the bot just closed.'),
    display_name: localize('Teach the AI'),
    description: localize('Every settled contract scores each model with a Brier loss, moves the mixture weights and takes one gradient step on the neural net. The brain is saved per market and survives restarts.'),
    call: input => `Bot.visionLearn(${input.DIGIT})`,
});

defineValueBlock({
    type: 'vision_brain_size',
    message: localize('AI contracts learned'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many settled contracts this market’s brain has learned from.'),
    display_name: localize('AI contracts learned'),
    description: localize('Zero means the AI is running on structure alone; a few hundred means it has adapted its weights to this market’s own behaviour.'),
    call: () => 'Bot.visionBrainSize()',
});

defineValueBlock({
    type: 'vision_brain_stats',
    message: localize('AI memory summary'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('Contracts learned, the hit rate of the trades it learned from and the number of gradient steps.'),
    display_name: localize('AI memory summary'),
    description: localize('A quick check that the bot is actually learning rather than starting from scratch on every run.'),
    call: () => 'Bot.visionBrainStats()',
});

defineStatementBlock({
    type: 'vision_reset_brain',
    command: true,
    message: localize('reset AI memory for this market'),
    args: [],
    colour,
    category,
    tooltip: localize('Throws away everything the AI learned on this market and starts from equal weights.'),
    display_name: localize('Reset AI memory'),
    description: localize('Use it when you change market or after a regime break, so yesterday’s weights do not steer today’s trades.'),
    call: () => 'Bot.visionResetBrain()',
});

defineStatementBlock({
    type: 'vision_refresh_payouts',
    command: true,
    message: localize('refresh the AI payout table'),
    args: [],
    colour,
    category,
    tooltip: localize('Re-reads the payout of every barrier from Deriv now instead of waiting for the automatic refresh.'),
    display_name: localize('Refresh AI payout table'),
    description: localize('The table refreshes itself every few minutes; call this after changing duration, currency or stake so the next plan is priced on fresh numbers.'),
    call: () => 'Bot.visionRefreshPayouts()',
});

defineValueBlock({
    type: 'vision_payout_live',
    message: localize('AI payout table is live'),
    args: [],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True when the payouts came from Deriv rather than the built-in model.'),
    display_name: localize('AI payout table is live'),
    description: localize('False means the API has not answered yet and the AI is pricing on a conservative model of the fair odds — it will simply refuse more trades.'),
    call: () => 'Bot.visionPayoutLive()',
});

defineStatementBlock({
    type: 'vision_notify',
    command: true,
    message: localize('notify AI plan %1'),
    args: [{ type: 'input_value', name: 'MESSAGE', check: null, default: '""' }],
    colour,
    category,
    tooltip: localize('Writes the AI plan to the journal, coloured green when it is trading and blue when it is waiting.'),
    display_name: localize('Notify AI plan'),
    description: localize('Leave the message empty to print the plan itself, or pass your own text to annotate it.'),
    call: input => `Bot.visionNotify(${input.MESSAGE})`,
});

defineStatementBlock({
    type: 'vision_log',
    command: true,
    message: localize('AI log %1'),
    args: [{ type: 'input_value', name: 'MESSAGE', check: null, default: '""' }],
    colour,
    category,
    tooltip: localize('Prints a line to the browser console with a timestamp.'),
    display_name: localize('AI log'),
    description: localize('For deeper debugging than the journal: it does not interrupt the bot and never shows a dialog.'),
    call: input => `Bot.visionLog(${input.MESSAGE})`,
});
