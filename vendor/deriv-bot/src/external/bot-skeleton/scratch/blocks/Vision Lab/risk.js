/**
 * Risk and money — the blocks that decide how much to risk and when to stop.
 *
 * The Vision engine keeps its own session ledger (trades, wins, streaks, running
 * profit, drawdown), so these blocks answer instantly without a strategy having
 * to maintain counters of its own.
 */

import { localize } from '@deriv-com/translations';
import { defineValueBlock, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().risk;
const category = window.Blockly.Categories.Vision_Risk;

const num = (name, fallback) => numberInput(name, fallback);

defineValueBlock({
    type: 'r_kelly',
    message: localize('Kelly stake % for %1 % chance at %2 × payout'),
    args: [num('PROBABILITY', '55'), num('PAYOUT', '1.9')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The mathematically optimal share of the bank for this bet. It is almost always far smaller than people expect.'),
    display_name: localize('Kelly stake'),
    description: localize('Full Kelly assumes you can repeat the bet forever and never feel a loss. Most strategies use a fraction of it — multiply the result by 0.1 to 0.25.'),
    call: input => `Bot.rKelly(${input.PROBABILITY}, ${input.PAYOUT})`,
});

defineValueBlock({
    type: 'r_stake_step',
    message: localize('next stake after a %1 from %2 × %3 capped at %4 reset to %5'),
    args: [
        {
            type: 'field_dropdown',
            name: 'RESULT',
            options: [
                [localize('loss'), 'loss'],
                [localize('win'), 'win'],
            ],
        },
        num('CURRENT', '1'),
        num('MULTIPLIER', '2'),
        num('MAX', '20'),
        num('BASE', '1'),
    ],
    inputsInline: false,
    output: 'Number',
    colour,
    category,
    tooltip: localize('A progression step: multiply after a loss, reset to the base after a win, never above the cap.'),
    display_name: localize('Next stake'),
    description: localize('The whole family of Martingale-style ladders in one block, with a hard ceiling. A progression changes the size of your losses, never your odds — the cap is what keeps it survivable.'),
    call: (input, field) => `Bot.rStakeStep(${input.CURRENT}, ${input.MULTIPLIER}, ${input.MAX}, ${input.BASE}, ${field.RESULT === '"win"' ? 'true' : 'false'})`,
});

defineValueBlock({
    type: 'r_safe_stake',
    message: localize('cap stake %1 at %2 % of the balance'),
    args: [num('STAKE', '1'), num('PERCENT', '2')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Never risk more than this share of the account on one contract.'),
    display_name: localize('Capped stake'),
    description: localize('A guard rail, not a sizing rule: it only ever lowers the stake you asked for.'),
    call: input => `Bot.rSafeStake(${input.STAKE}, ${input.PERCENT})`,
});

defineValueBlock({
    type: 'r_balance',
    message: localize('account balance'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The live balance of the connected account, as a number.'),
    display_name: localize('Account balance (number)'),
    description: localize('Read it before sizing a stake or checking whether the account can still take the trade.'),
    call: () => 'Bot.rBalance()',
});

defineValueBlock({
    type: 'r_profit_guard',
    message: localize('keep trading: profit below %1'),
    args: [num('TARGET', '50')],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True while the session profit is still below your target — false once you have banked it.'),
    display_name: localize('Take-profit guard'),
    description: localize('Put it in the purchase conditions to stop opening new contracts the moment the target is reached. Open contracts still settle.'),
    call: input => `Bot.rProfitGuard(${input.TARGET})`,
});

defineValueBlock({
    type: 'r_loss_guard',
    message: localize('keep trading: loss below %1'),
    args: [num('LIMIT', '50')],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True while the session loss is still inside your limit.'),
    display_name: localize('Stop-loss guard'),
    description: localize('The single most useful block in this group. Wire it into the purchase conditions so a bad run stops costing money.'),
    call: input => `Bot.rLossGuard(${input.LIMIT})`,
});

defineValueBlock({
    type: 'r_drawdown_ok',
    message: localize('drawdown still inside %1'),
    args: [num('LIMIT', '30')],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True while the session has not fallen this far below its own high-water mark.'),
    display_name: localize('Drawdown guard'),
    description: localize('Tighter than a flat stop: it reacts to giving profits back, not just to being down on the day.'),
    call: input => `Bot.rDrawdownOk(${input.LIMIT})`,
});

defineValueBlock({
    type: 'r_loss_streak',
    message: localize('losses in a row'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many contracts in a row have been lost.'),
    display_name: localize('Loss streak'),
    description: localize('Either a signal to pause or a signal that the market changed — never a reason to increase the stake on its own.'),
    call: () => 'Bot.rLossStreak()',
});

defineValueBlock({
    type: 'r_win_streak',
    message: localize('wins in a row'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many contracts in a row have been won.'),
    display_name: localize('Win streak'),
    description: localize('Handy for a “bank it and pause” rule after a run of good luck.'),
    call: () => 'Bot.rWinStreak()',
});

defineValueBlock({
    type: 'r_win_rate',
    message: localize('session win rate %'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Won contracts as a share of all contracts this session.'),
    display_name: localize('Session win rate'),
    description: localize('On high-payout digit trades a 30% win rate can still be profitable — always read it next to the payout, never alone.'),
    call: () => 'Bot.rWinRate()',
});

defineValueBlock({
    type: 'r_trades',
    message: localize('contracts taken this session'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many contracts the bot has opened since it started.'),
    display_name: localize('Contracts taken'),
    description: localize('Use it for run limits, sampling rules, or simply to log progress.'),
    call: () => 'Bot.rTrades()',
});

defineValueBlock({
    type: 'r_cooldown',
    message: localize('%1 seconds have passed since the last contract'),
    args: [num('SECONDS', '2')],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('True once this much time has elapsed since the last contract was opened.'),
    display_name: localize('Cooldown elapsed'),
    description: localize('The cheapest way to stop a bot from churning through contracts on a market that has not moved.'),
    call: input => `Bot.rCooldown(${input.SECONDS})`,
});

defineValueBlock({
    type: 'r_session_seconds',
    message: localize('seconds since the bot started'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How long this run has been going, in seconds.'),
    display_name: localize('Session seconds'),
    description: localize('For time-boxing a session, or for rules that only apply after a warm-up period.'),
    call: () => 'Bot.rSessionSeconds()',
});
