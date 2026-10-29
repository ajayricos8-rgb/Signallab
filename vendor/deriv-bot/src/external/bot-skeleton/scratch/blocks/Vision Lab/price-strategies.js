import { localize } from '@deriv-com/translations';
import { defineValueBlock, defineStatementBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().analysis;
const category = window.Blockly.Categories.Vision_Analysis;
defineValueBlock({
    type: 'x_price_decision', message: localize('Price-path ensemble %1 ticks %2 horizon %3 minimum probability %4'),
    args: [dropdown('MODE', [[localize('High/Low Tick'), 'tick'], [localize('Rise/Fall'), 'rise'], [localize('Step hedge (4 ticks)'), 'step-hedge']]),
        { type: 'input_value', name: 'LIST', check: 'Array', default: '[]' }, numberInput('HORIZON', '4'), numberInput('THRESHOLD', '0.56')],
    output: 'Array', colour, category,
    tooltip: localize('Empirical price windows, a two-change Markov state, an online logistic learner and indicators. Historical estimates do not guarantee an edge.'),
    display_name: localize('Price-path ensemble'), description: localize('Trains a small logistic learner on completed windows and returns one coherent decision; requires 256 ticks and at least 20 matching states.'),
    call: (input, field) => `Bot.priceDecision(${input.LIST}, ${field.MODE}, ${input.HORIZON}, ${input.THRESHOLD})`,
});
defineValueBlock({
    type: 'x_price_decision_part', message: localize('Decision %1 from %2'),
    args: [dropdown('PART', [[localize('ready'), 'ready'], [localize('side'), 'side'], [localize('prediction tick'), 'tick'], [localize('probability'), 'probability']]),
        { type: 'input_value', name: 'PLAN', check: 'Array', default: '[]' }],
    output: 'Number', colour, category,
    tooltip: localize('Read one component of a price-path decision.'), display_name: localize('Price decision component'),
    description: localize('Ready is 1 or 0, side is 1 for high/rise and -1 for low/fall, tick is 1–5.'),
    call: (input, field) => `Bot.priceDecisionPart(${input.PLAN}, ${field.PART})`,
});
defineValueBlock({
    type: 'x_session_profit', message: localize('session profit'), args: [], output: 'Number', colour, category,
    tooltip: localize('Realised profit reported by this trade engine, including both hedge legs.'), display_name: localize('Session profit'),
    description: localize('Use a start-of-run baseline to measure this bot session.'), call: () => 'Bot.priceSessionProfit()',
});
defineValueBlock({
    type: 'x_price_risk', message: localize('Risk OK: stake per leg %1 legs %2 starting profit %3 loss limit %4 profit target %5 max balance %6 percent'),
    args: [numberInput('STAKE', '0.35'), numberInput('LEGS', '1'), numberInput('BASELINE', '0'), numberInput('LOSS', '10'), numberInput('TARGET', '10'), numberInput('PERCENT', '5')],
    output: 'Boolean', colour, category, inputsInline: false,
    tooltip: localize('Rejects new entries if limits, balance cap, or remaining loss budget would be exceeded. Limits cannot prevent gaps, slippage, or open-position losses.'),
    display_name: localize('Price strategy risk gate'), description: localize('Checks total exposure of all legs against the balance and remaining loss budget.'),
    call: input => `Bot.priceRisk(${input.STAKE}, ${input.LEGS}, ${input.BASELINE}, ${input.LOSS}, ${input.TARGET}, ${input.PERCENT})`,
});

defineStatementBlock({
    type: 'x_tick_decision_purchase', message: localize('Purchase chosen High/Low Tick side %1 prediction tick %2'),
    args: [numberInput('SIDE', '0'), numberInput('TICK', '0')], command: true, colour, category,
    tooltip: localize('Buys the chosen High/Low Tick contract with its selected tick. Invalid selections are rejected.'),
    display_name: localize('Purchase High/Low Tick decision'), description: localize('Sends the current decision tick directly with the buy.'),
    call: input => `Bot.purchaseTickDecision(${input.SIDE}, ${input.TICK})`,
});
