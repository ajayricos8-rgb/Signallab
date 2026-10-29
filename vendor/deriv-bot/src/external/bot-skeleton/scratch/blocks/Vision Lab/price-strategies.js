import { localize } from '@deriv-com/translations';
import { defineValueBlock, defineStatementBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().analysis;
const category = window.Blockly.Categories.Vision_Analysis;
defineValueBlock({
    type: 'x_price_decision', message: localize('Price-path AI ensemble %1 ticks %2 horizon %3 probability floor %4 max tie rate %5 min model agreement %6 min edge over break-even %7 payout %8 min confidence %9 min expected value %10 entry slip ticks %11 entry %12'),
    args: [dropdown('MODE', [[localize('High/Low Tick'), 'tick'], [localize('Rise/Fall'), 'rise'], [localize('Step hedge (odd ticks)'), 'step-hedge']]),
        { type: 'input_value', name: 'LIST', check: 'Array', default: '[]' }, numberInput('HORIZON', '5'), numberInput('THRESHOLD', '0'),
        numberInput('MAX_TIE', '0.2'), numberInput('MIN_AGREEMENT', '0'), numberInput('MIN_EDGE', '0'), numberInput('PAYOUT', '0.95'),
        numberInput('MIN_CONFIDENCE', '0'), numberInput('MIN_EV', '0'), numberInput('SLIP', '0')],
    output: 'Array', colour, category, inputsInline: false,
    tooltip: localize('Sixteen experts (tie-aware structural anchor, frequency, Markov transition, recent, kernel analog, drift, serial dependence, a deep online net, regime, a position Markov chain, volatility, microtrend, range, entropy, Hurst memory and extreme-phase cycle) mixed by their measured Brier loss and gated by the live market regime. The entry needs a positive edge over the break-even implied by the live payout (1/(1+payout)), not an unreachable absolute probability. A tie rate above the limit blocks the entry: on a fixed-step market an even horizon ties far too often to trade. The confidence floor, when set, is applied inside the engine so the decisions it grades are the decisions the bot would have taken. "On the best read available" trades the ensemble's best side on every readable tick and lets the stake carry the caution — Kelly sizes a thin read down to the exchange minimum — which is what a strategy that must keep a cadence needs. Historical estimates do not guarantee an edge.'),
    display_name: localize('Price-path AI ensemble'), description: localize('Scores every expert walk-forward, blends them by measured skill, shrinks the result by its sample size and returns one decision with its tie rate, edge over break-even, expected value, confidence and agreement. The horizon is the contract duration; the payout is read from the live proposal and this value is only the fallback.'),
    call: (input, field) => `Bot.priceDecision(${input.LIST}, ${field.MODE}, ${input.HORIZON}, ${input.THRESHOLD}, ${input.MAX_TIE}, ${input.MIN_AGREEMENT}, ${input.MIN_EDGE}, ${input.PAYOUT}, ${input.MIN_CONFIDENCE}, ${field.REQUIRE}, ${input.MIN_EV}, ${input.SLIP})`,
});
defineValueBlock({
    type: 'x_price_decision_part', message: localize('Decision %1 from %2'),
    args: [dropdown('PART', [[localize('ready'), 'ready'], [localize('side'), 'side'], [localize('prediction tick'), 'tick'], [localize('probability'), 'probability'],
            [localize('tie rate'), 'tie'], [localize('edge'), 'edge'], [localize('confidence 0-100'), 'confidence'], [localize('model agreement 0-1'), 'agreement'],
            [localize('sample size'), 'samples'], [localize('horizon ticks'), 'horizon'], [localize('separation'), 'separation'], [localize('standard error'), 'stderr'],
            [localize('own record 0-1'), 'record'], [localize('calibration factor'), 'evidence'],
            [localize('quote at the chosen tick'), 'quote'], [localize('fair quote'), 'fair-quote'],
            [localize('EV margin over the runner-up'), 'ev-margin'], [localize('tie forecast'), 'tie-forecast'],
            [localize('market DNA score'), 'dna-score'], [localize('walk-forward skill'), 'skill'],
            [localize('stand down (0/1)'), 'stand-down'], [localize('certainty 0-100'), 'certainty'],
            [localize('seconds per tick'), 'interval'], [localize('contract seconds'), 'horizon-seconds'],
            [localize('entry slip in ticks'), 'slip'], [localize('label fidelity 0-1'), 'fidelity'],
            [localize('one buy covers 0-1 of the cycle'), 'stakeable'], [localize('quoted positions 0-10'), 'quoted'],
            [localize('EV floor the gate uses'), 'ev-lower']]),
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

/* ------------------------------------------------------------------ *
 * The v5 layer: market DNA, the EV table, the expert league, the
 * self-audit and the market scout.
 *
 * These blocks are deliberately read-only views of the same runtime that
 * produced the decision. Nothing here can size a trade or move a market:
 * they exist so a strategy can gate on a *measured* number (a readability
 * score, a walk-forward skill, an expected value) and so the journal can
 * hold the bot to its own record.
 * ------------------------------------------------------------------ */

defineValueBlock({
    type: 'x_price_dna',
    message: localize('market DNA'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize(
        'The market\u2019s structural fingerprint, measured from the ticks: tie rate, grid ratio (\u03c3 per tick in quote increments), drift significance, persistence, displacement from the fair prior and a 0\u2013100 readability score. This is how the bot knows whether it is standing on a Volatility index or a Step index.'
    ),
    display_name: localize('Market DNA'),
    description: localize('One journal line describing the market\u2019s structure. Print it at start-up and on a slow cadence: it is the difference between "the model is idle" and "this market has nothing to read".'),
    call: () => 'Bot.priceDna()',
});

defineValueBlock({
    type: 'x_price_dna_part',
    message: localize('market DNA %1'),
    args: [
        dropdown('PART', [
            [localize('readability 0-100'), 'score'],
            [localize('tie rate'), 'tie'],
            [localize('tie rate (high side)'), 'tie-high'],
            [localize('tie rate (low side)'), 'tie-low'],
            [localize('grid ratio \u03c3/step'), 'grid'],
            [localize('drift z'), 'drift'],
            [localize('autocorrelation \u03c1'), 'rho'],
            [localize('chi-square'), 'chi'],
            [localize('windows measured'), 'windows'],
            [localize('volatility expansion'), 'expansion'],
            [localize('ends share'), 'ends'],
            [localize('middle share'), 'middle'],
            [localize('end-to-middle ratio'), 'end-ratio'],
            [localize('tie band width (high)'), 'tie-high-band'],
            [localize('tie band width (low)'), 'tie-low-band'],
            [localize('fair multiple of the ends'), 'fair-end'],
            [localize('fair multiple of the middle'), 'fair-middle'],
            [localize('phase (0 grid, 1 mixed, 2 continuous)'), 'phase'],
        ]),
    ],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Read one measured field of the DNA report. Use the readability score as a gate: a market that cannot be measured should be traded smaller or not at all.'),
    display_name: localize('Market DNA field'),
    description: localize('Every value is measured from the collected ticks, never assumed.'),
    call: (input, field) => `Bot.priceDnaPart(${field.PART})`,
});

defineValueBlock({
    type: 'x_price_payout_table',
    message: localize('High/Low Tick payout ladder'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The ten live quotes (high and low, ticks 1\u20135) with the fair odds each probability deserves and the measured expected value of each position. This is the table the EV scan decides on.'),
    display_name: localize('Payout ladder'),
    description: localize('What every position actually pays, next to what it should pay. A quote below its fair odds is a loss in the long run however often it wins.'),
    call: () => 'Bot.pricePayoutTable()',
});

defineValueBlock({
    type: 'x_price_league',
    message: localize('expert league'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('Each expert\u2019s measured Brier skill against the tie-aware structural anchor, best first. An expert that cannot beat the prior loses its vote automatically.'),
    display_name: localize('Expert league'),
    description: localize('Which model is actually reading this market, and by how much it beats the structural prior. Print it every few dozen decisions.'),
    call: () => 'Bot.priceLeague()',
});

defineValueBlock({
    type: 'x_price_audit',
    message: localize('self-audit'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The bot holding itself to its own numbers: walk-forward skill, certainty, the calibration it applied, the graded record against the break-even it was paid, the tie forecast against the long-run rate, and whether the record warrants standing down.'),
    display_name: localize('Self-audit'),
    description: localize('Measured, not modelled. A bot whose graded record sits below break-even is not trading an edge, whatever its probability says.'),
    call: () => 'Bot.priceAudit()',
});

defineValueBlock({
    type: 'x_price_brain',
    message: localize('AI core'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The internal brain, as one journal line: the deep net\u2019s walk-forward training state, the meta-learner\u2019s regime call, and the three experts carrying the live decision. Everything here is measured on settled windows, never asserted.'),
    display_name: localize('AI core'),
    description: localize('What the brain has learned and who is carrying the decision. Print it on a slow cadence: it is the difference between \u201cthe model is idle\u201d and \u201cthe model is learning\u201d.'),
    call: () => 'Bot.priceBrain()',
});

defineValueBlock({
    type: 'x_price_reverse',
    message: localize('reverse engineering'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The market\u2019s deep diagnosis: phase, Hurst memory, extreme entropy, jump rate, extreme-phase persistence, tie clustering and compression, plus the auto-tuning the bot derived from them. Descriptive, not predictive.'),
    display_name: localize('Reverse engineering'),
    description: localize('How the bot reverse-engineered the market it stands on, and the caution it set for itself. Print it at start-up and on a slow cadence.'),
    call: () => 'Bot.priceReverse()',
});

defineValueBlock({
    type: 'x_price_forecast',
    message: localize('outcome forecast'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The full outcome read: the top High/Low Tick positions by expected value with their win probabilities and live quotes. The whole scan the EV gate decides on, in one line.'),
    display_name: localize('Outcome forecast'),
    description: localize('What the scan sees across all ten outcomes. Print it with the payout ladder to watch the bot think.'),
    call: () => 'Bot.priceForecast()',
});

defineValueBlock({
    type: 'x_price_market_score',
    message: localize('market scout score 0-100'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How worth trading the market the bot is standing on is: measured expected value, the engine\u2019s certainty, the DNA readability and the sample behind the decision.'),
    display_name: localize('Market scout score'),
    description: localize('A ranking, not a forecast. Use it with the market scout to move the bot to a market it can read.'),
    call: () => 'Bot.priceMarketScore()',
});

defineValueBlock({
    type: 'x_price_auto_market',
    message: localize('market scout · %1 · score floor %2 · stay at least %3 s'),
    args: [
        dropdown('MODE', [
            [localize('the most suitable market'), 'suitable'],
            [localize('the next market in turn'), 'next'],
            [localize('any market at random'), 'random'],
            [localize('the best market it has seen'), 'best'],
        ]),
        numberInput('FLOOR', '0'),
        numberInput('DWELL', '90'),
    ],
    inputsInline: false,
    output: 'String',
    colour,
    category,
    tooltip: localize('High/Low Ticks are quoted on every synthetic index, and the markets do not pay the same. The bot scores the market it is on and moves when the score falls under the floor, never more often than the dwell time. A switch trades a warm tick stream for a cold one, so the dwell is deliberately long.'),
    display_name: localize('Choose the High/Low Tick market'),
    description: localize('Optional scout: keep the bot on the market where its measured expected value, certainty and readability are strongest.'),
    call: (input, field) => `Bot.priceAutoMarket(${field.MODE}, ${input.FLOOR}, ${input.DWELL})`,
});

/* ------------------------------------------------------------------
 * The execution clock.
 *
 * Five ticks is not a duration until you know the market's tick rate. On
 * R_100 a tick is two seconds, so the contract lasts ten; on a 1-second
 * index it lasts five. And a fill that lands a fraction of a tick after the
 * quote the model scored is a different window, so the clock also reports how
 * far the order can slip and how many positions are in flight if the bot keeps
 * one ticket at a time. These blocks make that visible instead of implied.
 * ------------------------------------------------------------------ */

defineValueBlock({
    type: 'x_price_clock',
    message: localize('execution clock'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('Seconds per tick, the resulting five-tick contract length, the measured look-to-fill slip in ticks, the fidelity of the labels that slip allows, and how many positions are in flight. A bot cannot trade faster than its own clock.'),
    display_name: localize('Execution clock'),
    description: localize('Measured from this session\u2019s tick service and this market\u2019s own rate. Print it at start-up: five ticks on a two-second market is a ten-second contract, one fifth of the cycle per buy.'),
    call: () => 'Bot.priceClock()',
});

defineValueBlock({
    type: 'x_price_contract_ev',
    message: localize('expected value % of side %1 tick %2'),
    args: [numberInput('SIDE', '1'), numberInput('TICK', '1')],
    output: 'Number',
    colour,
    category,
    inputsInline: true,
    tooltip: localize('Expected value, as a percentage of the stake, of one named High/Low Tick contract at the live quote. Zero when that position has not been quoted.'),
    display_name: localize('Contract expected value'),
    description: localize('p(1 + multiple) \u2212 1 for the position you name, against the multiple Deriv is actually offering. A strategy can use it to refuse a position the bot would otherwise take.'),
    call: input => `Bot.priceContractEv(${input.SIDE}, ${input.TICK})`,
});

defineValueBlock({
    type: 'x_price_contract_fair',
    message: localize('fair multiple of side %1 tick %2'),
    args: [numberInput('SIDE', '1'), numberInput('TICK', '1')],
    output: 'Number',
    colour,
    category,
    inputsInline: true,
    tooltip: localize('The multiple this position deserves given the measured win probability: (1 \u2212 p) / p. Compare it with the live quote to see who has the edge.'),
    display_name: localize('Fair multiple'),
    description: localize('The break-even multiple of a position. A quote below the fair multiple is a losing bet in the long run however often it wins.'),
    call: input => `Bot.priceContractFair(${input.SIDE}, ${input.TICK})`,
});
