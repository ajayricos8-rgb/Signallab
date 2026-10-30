/**
 * Vision Lab — the AI multi-market scan blocks.
 *
 * Deriv sells one contract on one symbol, so a bot can only ever *trade* one
 * market at a time. What it can do is read all of them: Signal Lab streams
 * thirteen volatility indices into this frame, the decision models are pure
 * functions of a tick array, and one pass of the ensemble prices every market
 * in about the time a tick takes to print. `x_market_scan` runs that pass,
 * `x_scan_switch_best` stands the bot on the winner, and the read-back blocks
 * let a strategy (or the journal) see the ranking.
 *
 * None of these blocks place an order. The scan ranks markets; the Purchase
 * block still buys, on the market the scan chose, with the strategy's own
 * stake and its own gates.
 */

import { localize } from '@deriv-com/translations';
import { defineStatementBlock, defineValueBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().analysis;
const category = window.Blockly.Categories.Vision_Analysis;

const FAMILY = () =>
    dropdown('FAMILY', [
        [localize('Even / Odd'), 'even-odd'],
        [localize('Over / Under'), 'over-under'],
        [localize('High / Low Tick'), 'high-low-tick'],
        [localize('Rise / Fall'), 'rise-fall'],
    ]);

const symbolInput = () => ({ type: 'input_value', name: 'SYMBOL', check: 'String', default: '""' });

defineStatementBlock({
    type: 'x_market_scan',
    command: true,
    message: localize(
        'AI scan every market · %1 · horizon %2 ticks · payout %3× · slip %4 · at most every %5 s · max tie %6'
    ),
    args: [FAMILY(), numberInput('HORIZON', '5'), numberInput('PAYOUT', '1.95'), numberInput('SLIP', '1'), numberInput('EVERY', '8'), numberInput('MAX_TIE', '0.35')],
    inputsInline: false,
    colour,
    category,
    tooltip: localize(
        'Runs this bot’s own model over every market Signal Lab shares — one read per market, all at the same moment — and ranks them with one comparable score. The models are the same ones the strategy trades on, so the ranking and the trade agree. It never opens an order. The pass is rate limited by the interval: between scans the last ranking is reused, so it is safe to call on every tick.'
    ),
    display_name: localize('AI scan every market'),
    description: localize(
        'The multi-market read. Put it at the top of Tick analysis: the bot then knows how all thirteen volatility indices look before it decides where to stand, instead of walking them one at a time. Signals only — the Purchase block still trades.'
    ),
    call: (input, field) =>
        `Bot.marketScan(${field.FAMILY}, ${input.HORIZON}, ${input.PAYOUT}, ${input.SLIP}, ${input.EVERY}, ${input.MAX_TIE})`,
});

defineValueBlock({
    type: 'x_scan_switch_best',
    message: localize(
        'trade the most suitable market from the last AI scan · score floor %1 · margin %2 · dwell %3 s'
    ),
    args: [numberInput('FLOOR', '25'), numberInput('MARGIN', '3'), numberInput('DWELL', '25')],
    output: 'String',
    colour,
    category,
    inputsInline: false,
    tooltip: localize(
        'Moves the running bot onto the market the last scan rated highest — but only when that market clears the score floor, beats the market the bot is on by the margin, and the dwell time has passed. A switch trades a warm tick stream for a cold one, so a jump without a margin is just noise. Returns the market the bot now trades.'
    ),
    display_name: localize('Trade the most suitable market'),
    description: localize(
        'Reads the last AI scan and stands the bot on its winner. Assign it to a variable to record where the session is, then run the decision exactly as before — the models, the stake and every gate are unchanged.'
    ),
    call: input => `Bot.scanSwitchBest(${input.FLOOR}, ${input.MARGIN}, ${input.DWELL})`,
});

defineStatementBlock({
    type: 'x_scan_stand_best',
    command: true,
    message: localize(
        'stand on the most suitable market from the last AI scan · score floor %1 · margin %2 · dwell %3 s'
    ),
    args: [numberInput('FLOOR', '25'), numberInput('MARGIN', '3'), numberInput('DWELL', '25')],
    inputsInline: false,
    colour,
    category,
    tooltip: localize(
        'The statement form of "trade the most suitable market": moves the running bot onto the winner of the last scan under the same floor, margin and dwell rules. Use it when the strategy does not need the market\u2019s name back; use the value block when it does.'
    ),
    display_name: localize('Stand on the most suitable market'),
    description: localize(
        'Same move as the value block, without asking for the symbol back. Place it right after the scan, before the decision, so the model reads the market that will actually settle.'
    ),
    call: input => `Bot.scanSwitchBest(${input.FLOOR}, ${input.MARGIN}, ${input.DWELL})`,
});

defineValueBlock({
    type: 'x_scan_best',
    message: localize('best market from the last AI scan'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The market symbol the last scan rated highest (e.g. 1HZ100V). Before a scan runs it reports the market the bot is on.'),
    display_name: localize('Scan best market'),
    description: localize('Which market won the last AI scan. Print it in the journal to see the bot’s live opinion of the cross-section.'),
    call: () => 'Bot.scanBest()',
});

defineValueBlock({
    type: 'x_scan_score',
    message: localize('AI scan score 0-100 of %1'),
    args: [symbolInput()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The score the last scan gave a market, on the same 0–100 scale as the scout: measured expected value, certainty, DNA readability, sample and walk-forward skill. Leave the input empty to score the market the bot is trading.'),
    display_name: localize('Scan score'),
    description: localize('One market’s place in the cross-section. Use it as a gate: a market that reads below the floor is not worth standing on, whatever its last contract did.'),
    call: input => `Bot.scanScore(${input.SYMBOL})`,
});

defineValueBlock({
    type: 'x_scan_rank',
    message: localize('AI scan rank of %1'),
    args: [symbolInput()],
    output: 'Number',
    colour,
    category,
    tooltip: localize('1 for the market the last scan rated best, 2 for the next, and so on. 0 means the market was not in the scan (no readable tick stream).'),
    display_name: localize('Scan rank'),
    description: localize('Where a market came in the last scan. A rank of 1 on the market the bot is trading means the bot is already on the most suitable market.'),
    call: input => `Bot.scanRank(${input.SYMBOL})`,
});

defineValueBlock({
    type: 'x_scan_count',
    message: localize('markets read by the last AI scan'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many markets the last scan could actually read. Below two, the cross-section is thin and the ranking is only the market the bot is on.'),
    display_name: localize('Scan market count'),
    description: localize('The width of the cross-section. Print it with the scan summary when the bot looks stuck on one market.'),
    call: () => 'Bot.scanCount()',
});

defineValueBlock({
    type: 'x_scan_summary',
    message: localize('AI scan summary'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('One journal line: how many markets were read, the top four scores, the market the bot stands on, and why the last switch did or did not happen.'),
    display_name: localize('AI scan summary'),
    description: localize('The whole multi-market read in one line. Print it at start-up and on a slow cadence — it is the difference between "the bot is idle" and "the bot is on the best of thirteen markets".'),
    call: () => 'Bot.scanSummary()',
});

defineValueBlock({
    type: 'x_trade_due',
    message: localize('no entry in the last %1 s (at least one a minute)'),
    args: [numberInput('SECONDS', '60')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('1 when the engine has not recorded a purchase for this many seconds, else 0. It reads the engine’s own run counter, so a contract bought by any block resets it. Use it to relax the gates that are about quality — a DNA floor, a confidence bar — when a whole interval has passed without a trade. It must never relax a money gate: the stake, the loss limit, the profit target and the drawdown stay exactly as configured.'),
    display_name: localize('Entry cadence due'),
    description: localize('The "at least one trade a minute" switch. OR it into the purchase conditions next to the soft quality gates, and leave every money gate in the AND branch where it is.'),
    call: input => `Bot.tradeDue(${input.SECONDS})`,
});

defineValueBlock({
    type: 'x_seconds_since_trade',
    message: localize('seconds since the last purchase'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Seconds since the engine last recorded a purchase. Every number is measured from the run’s own counter, never assumed.'),
    display_name: localize('Seconds since last purchase'),
    description: localize('How long the bot has gone without trading. Pair it with the cadence block when tuning how patient the session should be.'),
    call: () => 'Bot.secondsSinceTrade()',
});
