/**
 * Shortcuts — whole ideas in one block.
 *
 * Everything here is a composite of the other groups (or of the engine), kept as
 * a single block because it is the thing people actually reach for first: a
 * one-line entry decision, a speed-aware pause, a stake that already knows about
 * the edge.
 */

import { localize } from '@deriv-com/translations';
import { defineStatementBlock, defineValueBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().shortcut;
const category = window.Blockly.Categories.Vision_Shortcut;

const num = (name, fallback) => numberInput(name, fallback);

/* ---------------- speed ---------------- */

defineValueBlock({
    type: 'x_speed',
    message: localize('bot speed'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize("'slow', 'normal' or 'fast' — whatever the Fast/Slow control beside Run is set to."),
    display_name: localize('Bot speed'),
    description: localize('Read the workspace speed from inside a strategy and change your own behaviour with it: more confirming ticks when slow, fewer when fast.'),
    call: () => 'Bot.xSpeed()',
});

defineValueBlock({
    type: 'x_speed_index',
    message: localize('bot speed (0 slow · 1 normal · 2 fast)'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The same setting as a number, so you can compare it directly.'),
    display_name: localize('Bot speed index'),
    description: localize('0 for slow, 1 for normal, 2 for fast. Arithmetic with the speed is easier with the number than with the word.'),
    call: () => 'Bot.xSpeedIndex()',
});

defineValueBlock({
    type: 'x_speed_factor',
    message: localize('pause multiplier for this speed'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How much the active speed stretches (slow) or shrinks (fast) every pause.'),
    display_name: localize('Pause multiplier'),
    description: localize('1.9 on slow, 1 on normal, 0.42 on fast. Multiply your own waits by it to keep them in step with the control.'),
    call: () => 'Bot.xSpeedFactor()',
});

defineStatementBlock({
    type: 'x_smart_sleep',
    command: true,
    message: localize('pause %1 s (speed aware)'),
    args: [num('SECONDS', '1')],
    colour,
    category,
    tooltip: localize('Waits this long, then rescales it by the Fast/Slow setting.'),
    display_name: localize('Speed-aware pause'),
    description: localize('The same block runs twice as long on Slow and less than half as long on Fast, so one strategy can be tuned from the toolbar without editing blocks.'),
    call: input => `Bot.xSmartSleep(${input.SECONDS})`,
});

defineStatementBlock({
    type: 'x_wait_ticks',
    command: true,
    message: localize('wait for %1 ticks (speed aware)'),
    args: [num('COUNT', '1')],
    colour,
    category,
    tooltip: localize('Waits for this many fresh ticks before continuing.'),
    display_name: localize('Wait for ticks'),
    description: localize('The pause you actually want in a trading bot: it waits for new information rather than for the clock. The count is scaled by the Fast/Slow setting.'),
    call: input => `Bot.xWaitTicks(${input.COUNT})`,
});

/* ---------------- AI one-liners ---------------- */

defineValueBlock({
    type: 'x_ai_should_buy',
    message: localize('AI entry signal (min edge %1 %)'),
    args: [num('MIN_EDGE', '1.5')],
    output: 'Boolean',
    colour,
    category,
    tooltip: localize('One block that runs the whole AI read and answers whether to take the trade.'),
    display_name: localize('AI entry signal'),
    description: localize('The shortcut version of the AI Core blocks: it reads the market, prices every barrier against the live payouts and answers with a single Yes or No. Pass a stricter minimum edge to trade less often.'),
    call: input => `Bot.xAiShouldBuy(${input.MIN_EDGE})`,
});

defineValueBlock({
    type: 'x_ai_stake',
    message: localize('AI stake from %1 at risk %2'),
    args: [num('BASE', '1'), num('RISK', '0.6')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The base stake scaled by the edge and the confidence behind this specific trade.'),
    display_name: localize('AI stake'),
    description: localize('A quarter of the base stake when the AI is not trading, and up to the full base stake once the edge reaches the target. Risk 0 is cautious, risk 1 takes the full size.'),
    call: input => `Bot.xAiStake(${input.BASE}, ${input.RISK})`,
});

defineValueBlock({
    type: 'x_ai_signal',
    message: localize('AI signal line'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('TRADE or WAIT, followed by the whole plan and the reason.'),
    display_name: localize('AI signal line'),
    description: localize('Everything the AI knows about this tick in one printable line — ideal for Notify or for a log you can read back later.'),
    call: () => 'Bot.xAiSignal()',
});

defineStatementBlock({
    type: 'x_ai_trade',
    command: true,
    message: localize('AI Over/Under: stake %1 duration %2 ticks min edge %3 % risk %4'),
    args: [num('STAKE', '1'), num('DURATION', '5'), num('MIN_EDGE', '1.5'), num('RISK', '0.6')],
    inputsInline: false,
    colour,
    category,
    tooltip: localize('The complete Over/Under decision in one block: it reads the market, sets the prediction, and stores the barrier and stake for the blocks around it.'),
    display_name: localize('AI Over/Under decision'),
    description: localize('Pair it with the Over and Under purchase blocks: afterwards, read the AI barrier as the Prediction of your trade options and the AI stake as the stake, then let the AI direction choose which side to buy.'),
    call: input => `Bot.visionAnalyse(${input.DURATION}, ${input.MIN_EDGE}, 1.5, 55, 0.7, ${input.RISK})`,
});

defineValueBlock({
    type: 'x_payout_needed',
    message: localize('payout needed for %1 % chance to break even'),
    args: [num('PROBABILITY', '50')],
    output: 'Number',
    colour,
    category,
    tooltip: localize('The payout multiple at which this win chance is exactly fair.'),
    display_name: localize('Break-even payout'),
    description: localize('Compare it with the payout the AI is being offered: the whole edge is the gap between the two.'),
    call: input => `Bot.qRound(1 / (${input.PROBABILITY} / 100), 4)`,
});

defineValueBlock({
    type: 'x_digits_over',
    message: localize('winning digits for %1 %2'),
    args: [
        dropdown('DIRECTION', [
            [localize('over'), 'over'],
            [localize('under'), 'under'],
        ]),
        num('BARRIER', '5'),
    ],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How many of the ten digits win this contract — and therefore what the fair odds are.'),
    display_name: localize('Winning digits'),
    description: localize('Over 7 wins on two digits out of ten, so it needs a payout near 5× just to break even.'),
    call: (input, field) => `(${field.DIRECTION === '"under"' ? `${input.BARRIER}` : `9 - (${input.BARRIER})`})`,
});
