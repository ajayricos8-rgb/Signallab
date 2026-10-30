/**
 * All Markets — the blocks that let a bot choose where to stand.
 *
 * Deriv's workspace fixes one market per strategy: the symbol is read once,
 * when the bot starts, and every contract is bought on it. These blocks let a
 * running bot move between the volatility indices instead, and let it score
 * each one so the choice is not a coin flip.
 *
 * Switching mid-session is the part that needs care. The tick stream has to be
 * torn down with the market it was opened for, the new market's history has to
 * be in hand before the next decision, and the payout table for that market has
 * to be warm — otherwise the bot spends its first seconds on a new market
 * trading prices it measured somewhere else. All of that happens inside
 * `Bot.visionAutoMarket`, which is why these blocks are four lines of XML.
 */

import { localize } from '@deriv-com/translations';
import { defineStatementBlock, defineValueBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().ai;
const category = window.Blockly.Categories.Vision_AI;

/** Every volatility index Deriv offers digit contracts on. */
const MARKETS = [
    [localize('Volatility 10 (1s)'), '1HZ10V'],
    [localize('Volatility 25 (1s)'), '1HZ25V'],
    [localize('Volatility 50 (1s)'), '1HZ50V'],
    [localize('Volatility 75 (1s)'), '1HZ75V'],
    [localize('Volatility 100 (1s)'), '1HZ100V'],
    [localize('Volatility 10'), 'R_10'],
    [localize('Volatility 25'), 'R_25'],
    [localize('Volatility 50'), 'R_50'],
    [localize('Volatility 75'), 'R_75'],
    [localize('Volatility 100'), 'R_100'],
];

/** How the bot decides where to go next. */
const MODES = [
    [localize('the most suitable market'), 'suitable'],
    [localize('any market at random'), 'random'],
    [localize('the next market in turn'), 'next'],
    [localize('the best market it has seen'), 'best'],
];

/* ------------------------------------------------------------------ *
 * Choosing a market
 * ------------------------------------------------------------------ */

defineStatementBlock({
    type: 'vision_auto_market',
    command: true,
    message: localize('let the bot choose its market · %1 · score floor %2 · stay at least %3 s'),
    args: [dropdown('MODE', MODES), numberInput('FLOOR', '0'), numberInput('DWELL', '2')],
    inputsInline: false,
    colour,
    category,
    tooltip: localize(
        'Every market the bot visits is scored on the strength of its lean, the confidence behind it and how much data supports it. Stay while the score holds up; move on when it does not — or jump on a timer instead.'
    ),
    display_name: localize('Let the bot choose its market'),
    description: localize(
        'Put this at the top of your tick block, before the AI read. "Most suitable" stays on a market while it scores at or above the floor and moves to the best market seen so far when it drops below; "best" always goes to the highest scorer; "random" and "next" move on a timer. The dwell time is a rate limit, not a target: the bot will never change market more often than that, however bad the market looks, because every switch costs a tick stream and a payout table.'
    ),
    call: (input, field) => `Bot.visionAutoMarket(${field.MODE}, ${input.FLOOR}, ${input.DWELL})`,
});

defineStatementBlock({
    type: 'vision_switch_market',
    command: true,
    message: localize('switch the bot to %1'),
    args: [dropdown('MARKET', MARKETS)],
    colour,
    category,
    tooltip: localize('Moves the running bot onto this market right now: new tick stream, new history, new payout table.'),
    display_name: localize('Switch market'),
    description: localize(
        'Use it when your own logic decides where the bot should be — after a loss, on a time of day, or on a signal from another block. Everything the bot knows about the old market is remembered, so switching back later does not start from scratch.'
    ),
    call: (input, field) => `Bot.visionSwitchMarket(${field.MARKET})`,
});

defineValueBlock({
    type: 'vision_pick_market',
    message: localize('the market the bot would pick · %1'),
    args: [dropdown('MODE', MODES)],
    output: 'String',
    colour,
    category,
    tooltip: localize('The symbol the bot would move to for this mode, without moving anywhere.'),
    display_name: localize('Market the bot would pick'),
    description: localize('Read the choice before you commit to it — useful for logging, or for switching only when your own conditions agree.'),
    call: (input, field) => `Bot.visionPickMarket(${field.MODE})`,
});

/* ------------------------------------------------------------------ *
 * Reading where the bot is
 * ------------------------------------------------------------------ */

defineValueBlock({
    type: 'vision_market',
    message: localize('current market'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The symbol the bot is trading right now, for example R_100.'),
    display_name: localize('Current market'),
    description: localize('Changes while the bot runs once market switching is on. Log it with the AI plan summary to see which market each trade came from.'),
    call: () => 'Bot.visionMarket()',
});

defineValueBlock({
    type: 'vision_market_score',
    message: localize('market score'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('0-100: how worth trading this market looks right now.'),
    display_name: localize('Market score'),
    description: localize(
        'A blend of how far past the noise the strongest lean sits, how confident the ensemble is, how many models agree and how much data is behind it. Use it as your own floor: switch market when the score drops below a number you choose.'
    ),
    call: () => 'Bot.visionMarketScore()',
});

defineValueBlock({
    type: 'vision_market_ready',
    message: localize('this market has enough history'),
    args: [],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True once the bot has enough ticks on the current market to read it properly.'),
    display_name: localize('Market has enough history'),
    description: localize('Right after a switch the bot is still filling its history window. Gate your entries on this if you would rather skip the first decision on a new market than take it on a thin sample.'),
    call: () => 'Bot.visionMarketReady()',
});

defineValueBlock({
    type: 'vision_market_seconds',
    message: localize('seconds on this market'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How long the bot has been on the current market.'),
    display_name: localize('Seconds on this market'),
    description: localize('Write your own dwell rules with it: move on after thirty seconds, or stay as long as the score holds.'),
    call: () => 'Bot.visionMarketSeconds()',
});

defineValueBlock({
    type: 'vision_market_list',
    message: localize('all markets'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('Every volatility index the bot may trade, comma separated.'),
    display_name: localize('All markets'),
    description: localize('The ten synthetic indices that carry digit contracts: five one-second markets and five two-second ones.'),
    call: () => 'Bot.visionMarketList()',
});

defineValueBlock({
    type: 'vision_market_count',
    message: localize('number of markets'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many markets the bot can move between.'),
    display_name: localize('Number of markets'),
    description: localize('Ten: the one-second and two-second volatility indices.'),
    call: () => 'Bot.visionMarketCount()',
});
