import { localize } from '@deriv-com/translations';
import { defineValueBlock, defineStatementBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().analysis;
const category = window.Blockly.Categories.Vision_Analysis;
defineValueBlock({
    type: 'x_price_decision', message: localize('Price-path AI ensemble %1 ticks %2 horizon %3 probability floor %4 max tie rate %5 min model agreement %6 min edge over break-even %7 payout %8 min confidence %9'),
    args: [dropdown('MODE', [[localize('High/Low Tick'), 'tick'], [localize('Rise/Fall'), 'rise'], [localize('Step hedge (odd ticks)'), 'step-hedge']]),
        { type: 'input_value', name: 'LIST', check: 'Array', default: '[]' }, numberInput('HORIZON', '5'), numberInput('THRESHOLD', '0'),
        numberInput('MAX_TIE', '0.2'), numberInput('MIN_AGREEMENT', '0'), numberInput('MIN_EDGE', '0'), numberInput('PAYOUT', '0.95'),
        numberInput('MIN_CONFIDENCE', '0')],
    output: 'Array', colour, category, inputsInline: false,
    tooltip: localize('Eight experts (anchor, frequency, Markov transition, recent, kernel analog, drift, serial dependence and an online softmax net) mixed by their measured Brier loss. The entry needs a positive edge over the break-even implied by the live payout (1/(1+payout)), not an unreachable absolute probability. A tie rate above the limit blocks the entry: on a fixed-step market an even horizon ties far too often to trade. The confidence floor, when set, is applied inside the engine so the decisions it grades are the decisions the bot would have taken. Historical estimates do not guarantee an edge.'),
    display_name: localize('Price-path AI ensemble'), description: localize('Scores every expert walk-forward, blends them by measured skill, shrinks the result by its sample size and returns one decision with its tie rate, edge over break-even, expected value, confidence and agreement. The horizon is the contract duration; the payout is read from the live proposal and this value is only the fallback.'),
    call: (input, field) => `Bot.priceDecision(${input.LIST}, ${field.MODE}, ${input.HORIZON}, ${input.THRESHOLD}, ${input.MAX_TIE}, ${input.MIN_AGREEMENT}, ${input.MIN_EDGE}, ${input.PAYOUT}, ${input.MIN_CONFIDENCE})`,
});
defineValueBlock({
    type: 'x_price_decision_part', message: localize('Decision %1 from %2'),
    args: [dropdown('PART', [[localize('ready'), 'ready'], [localize('side'), 'side'], [localize('prediction tick'), 'tick'], [localize('probability'), 'probability'],
            [localize('tie rate'), 'tie'], [localize('edge'), 'edge'], [localize('confidence 0-100'), 'confidence'], [localize('model agreement 0-1'), 'agreement'],
            [localize('sample size'), 'samples'], [localize('horizon ticks'), 'horizon'], [localize('separation'), 'separation'], [localize('standard error'), 'stderr']]),
        { type: 'input_value', name: 'PLAN', check: 'Array', default: '[]' }],
    output: 'Number', colour, category,
    tooltip: localize('Read one component of a price-path decision.'), display_name: localize('Price decision component'),
    description: localize('Ready is 1 or 0, side is 1 for high/rise and -1 for low/fall, tick is 1–5. Probability, tie rate, edge and agreement explain the decision; samples and horizon show the evidence behind it.'),
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

defineValueBlock({
    type: 'x_price_reason', message: localize('AI decision summary'), args: [], output: 'String', colour, category,
    tooltip: localize('One line for the journal: the contract when the AI is ready, or exactly why it is waiting (warming up, thin state, tie risk, below threshold, thin evidence, model disagreement).'),
    display_name: localize('AI decision summary'), description: localize('Prints the last decision, or the gate that held it back. Put it in Notify on skip ticks so an idle bot explains itself.'),
    call: () => 'Bot.priceReason()',
});
defineValueBlock({
    type: 'x_price_model_weights', message: localize('AI model weights'), args: [], output: 'String', colour, category,
    tooltip: localize('Which experts currently carry the decision, by measured skill on this market.'),
    display_name: localize('AI model weights'), description: localize('Mixture weights of the seven price experts, strongest first — the model that is actually reading this market.'),
    call: () => 'Bot.priceModelWeights()',
});
defineValueBlock({
    type: 'x_price_stake', message: localize('AI stake: probability %1 payout %2 base %3 kelly fraction %4 balance percent %5 max stake %6'),
    args: [numberInput('PROBABILITY', '0.56'), numberInput('PAYOUT', '0.95'), numberInput('BASE', '0.35'), numberInput('FRACTION', '0.1'), numberInput('PERCENT', '5'), numberInput('MAX_STAKE', '2.8')],
    output: 'Number', colour, category, inputsInline: false,
    tooltip: localize('Tenth-Kelly stake from the measured probability and payout, capped by the balance percent and the max stake, floored at Deriv\'s 0.35 minimum and reduced while the session is losing. Falls back to the base stake when the edge is not positive, and a loss never raises the next stake.'),
    display_name: localize('AI stake'), description: localize('Sizes up a real edge and down a weak one, from the decision probability and the payout you are actually paid. Fraction is the share of full Kelly (0.1 = tenth Kelly); 0.35 is the smallest stake Deriv accepts.'),
    call: input => `Bot.priceStake(${input.PROBABILITY}, ${input.PAYOUT}, ${input.BASE}, ${input.FRACTION}, ${input.PERCENT}, ${input.MAX_STAKE})`,
});
defineValueBlock({
    type: 'x_price_trades', message: localize('session contracts bought'), args: [], output: 'Number', colour, category,
    tooltip: localize('Contracts this run has bought, read from the trade engine.'),
    display_name: localize('Session contracts'), description: localize('The engine\'s own run counter — the number of purchases this run, hedge legs included.'),
    call: () => 'Bot.priceTrades()',
});

defineValueBlock({
    type: 'x_price_calibration', message: localize('AI scorecard'), args: [], output: 'String', colour, category,
    tooltip: localize('The realised hit rate of every decision this bot published, against the break-even the payout requires. The only measured figure in these strategies: a bot whose hit rate sits below break-even is not trading an edge, whatever its model says.'),
    display_name: localize('AI scorecard'), description: localize('Measured, not modelled: how often the published decisions actually won, over how many graded entries, and the gap to break-even. Print it every few entries so the journal holds the bot to its own record.'),
    call: () => 'Bot.priceScorecard()',
});
defineValueBlock({
    type: 'x_price_layout', message: localize('Decision layout'), args: [], output: 'String', colour, category,
    tooltip: localize('The trade shape the models are pricing: market, duration, stake, payout and the horizon the ensemble replays. Put it in the journal when a bot will not trade, to prove it is reading the contract you think it is.'),
    display_name: localize('Decision layout'), description: localize('One line describing the contract the decision refers to.'),
    call: () => 'Bot.priceLayout()',
});
