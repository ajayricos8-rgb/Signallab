import { localize } from '@deriv-com/translations';
import { defineValueBlock, dropdown, numberInput } from './factory';
import { visionColours } from './colour';

const colour = visionColours().analysis;
const category = window.Blockly.Categories.Vision_Analysis;
defineValueBlock({
    type: 'x_parity_decision', message: localize('Even/Odd AI ensemble ticks %1 horizon %2 probability floor %3 entry %4 min edge over break-even %5 payout %6 min confidence %7 min model agreement %8 min expected value %9 entry slip ticks %10'),
    args: [{ type: 'input_value', name: 'LIST', check: 'Array', default: '[]' }, numberInput('HORIZON', '5'), numberInput('THRESHOLD', '0'),
        dropdown('REQUIRE', [[localize('only with a measured edge'), 'edge'], [localize('on the best read available'), 'always']]),
        numberInput('MIN_EDGE', '0'), numberInput('PAYOUT', '1.95'), numberInput('MIN_CONFIDENCE', '0'),
        numberInput('MIN_AGREEMENT', '0'), numberInput('MIN_EV', '0'), numberInput('SLIP', '1')],
    output: 'Array', colour, category, inputsInline: false,
    tooltip: localize('Sixteen experts (the eight vision digit models plus eight parity-native readers: long-run and recent even share, first- and second-order parity Markov, the digit transition row, run continuation, alternation projection and an online parity net) mixed by their measured walk-forward Brier skill. The entry needs a positive edge over the break-even implied by the live DIGITEVEN/DIGITODD quotes. Parity cannot tie, so there is no tie gate. A frozen quote feed is refused outright. "On the best read available" buys the better-EV side on every readable cycle and lets the stake carry the caution — Kelly sizes a thin read down to the exchange minimum — which is what a strategy that must keep a cadence needs. Historical estimates do not guarantee an edge.'),
    display_name: localize('Even/Odd AI ensemble'), description: localize('Scores every expert walk-forward, blends them by measured skill, shrinks the result by its sample size, calibrates it against the rule\'s own graded record per side, and returns one decision with its side, edge over break-even, expected value, confidence and agreement. The horizon is the contract duration; the payout is read from the live proposal table and this value is only the fallback.'),
    call: (input, field) => `Bot.parityDecision(${input.LIST}, ${input.HORIZON}, ${input.THRESHOLD}, ${field.REQUIRE}, ${input.MIN_EDGE}, ${input.PAYOUT}, ${input.MIN_CONFIDENCE}, ${input.MIN_AGREEMENT}, ${input.MIN_EV}, ${input.SLIP})`,
});
defineValueBlock({
    type: 'x_parity_decision_part', message: localize('Decision %1 from %2'),
    args: [dropdown('PART', [[localize('ready'), 'ready'], [localize('side (1 even, -1 odd)'), 'side'], [localize('probability'), 'probability'],
            [localize('even probability'), 'even-prob'], [localize('edge'), 'edge'], [localize('confidence 0-100'), 'confidence'],
            [localize('model agreement 0-1'), 'agreement'], [localize('sample size'), 'samples'], [localize('horizon ticks'), 'horizon'],
            [localize('EV separation of the sides'), 'separation'], [localize('standard error'), 'stderr'],
            [localize('own record 0-1'), 'record'], [localize('calibration factor'), 'evidence'],
            [localize('quote of the chosen side'), 'quote'], [localize('fair quote'), 'fair-quote'],
            [localize('EV margin over the other side'), 'ev-margin'], [localize('market DNA score'), 'dna-score'],
            [localize('walk-forward skill'), 'skill'], [localize('stand down (0/1)'), 'stand-down'],
            [localize('certainty 0-100'), 'certainty'], [localize('EV floor the gate uses'), 'ev-lower'],
            [localize('lean in sigma'), 't-stat'], [localize('break-even'), 'break-even'], [localize('both quotes fresh (0/1)'), 'payout-live']]),
        { type: 'input_value', name: 'PLAN', check: 'Array', default: '[]' }],
    output: 'Number', colour, category,
    tooltip: localize('Read one component of an Even/Odd decision.'), display_name: localize('Parity decision component'),
    description: localize('Ready is 1 or 0, side is 1 for Even and -1 for Odd. Probability, edge and agreement explain the decision; samples and horizon show the evidence behind it.'),
    call: (input, field) => `Bot.parityDecisionPart(${input.PLAN}, ${field.PART})`,
});
defineValueBlock({
    type: 'x_parity_reason', message: localize('Parity AI decision summary'), args: [], output: 'String', colour, category,
    tooltip: localize('One line for the journal: the side, probability, quote, EV, sigma, confidence and record when the AI is ready, or exactly why it is waiting (warming up, thin evidence, model disagreement, no value).'),
    display_name: localize('Parity AI decision summary'), description: localize('Prints the last decision, or the gate that held it back. Put it in Notify on skip ticks so an idle bot explains itself.'),
    call: () => 'Bot.parityReason()',
});
defineValueBlock({
    type: 'x_parity_risk', message: localize('Risk OK: stake per leg %1 legs %2 starting profit %3 loss limit %4 profit target %5 max balance %6 percent'),
    args: [numberInput('STAKE', '0.35'), numberInput('LEGS', '1'), numberInput('BASELINE', '0'), numberInput('LOSS', '10'), numberInput('TARGET', '10'), numberInput('PERCENT', '5')],
    output: 'Boolean', colour, category, inputsInline: false,
    tooltip: localize('Rejects new entries if limits, balance cap, or remaining loss budget would be exceeded. Limits cannot prevent gaps, slippage, or open-position losses.'),
    display_name: localize('Parity strategy risk gate'), description: localize('Checks total exposure of all legs against the balance and remaining loss budget.'),
    call: input => `Bot.parityRisk(${input.STAKE}, ${input.LEGS}, ${input.BASELINE}, ${input.LOSS}, ${input.TARGET}, ${input.PERCENT})`,
});
defineValueBlock({
    type: 'x_parity_stake', message: localize('Parity AI stake: probability %1 payout %2 base %3 kelly fraction %4 balance percent %5 max stake %6'),
    args: [numberInput('PROBABILITY', '0.52'), numberInput('PAYOUT', '1.95'), numberInput('BASE', '0.35'), numberInput('FRACTION', '0.1'), numberInput('PERCENT', '5'), numberInput('MAX_STAKE', '2.8')],
    output: 'Number', colour, category, inputsInline: false,
    tooltip: localize('Tenth-Kelly stake from the measured probability and payout, capped by the balance percent and the max stake, floored at Deriv\'s 0.35 minimum and reduced while the session is losing. Falls back to the base stake when the edge is not positive, and a loss never raises the next stake.'),
    display_name: localize('Parity AI stake'), description: localize('Sizes up a real edge and down a weak one, from the decision probability and the payout you are actually paid. Fraction is the share of full Kelly (0.1 = tenth Kelly); 0.35 is the smallest stake Deriv accepts.'),
    call: input => `Bot.parityStake(${input.PROBABILITY}, ${input.PAYOUT}, ${input.BASE}, ${input.FRACTION}, ${input.PERCENT}, ${input.MAX_STAKE})`,
});
defineValueBlock({
    type: 'x_parity_contracts', message: localize('parity session contracts bought'), args: [], output: 'Number', colour, category,
    tooltip: localize('Contracts this run has bought, read from the trade engine.'),
    display_name: localize('Parity session contracts'), description: localize('The engine\'s own run counter — the number of purchases this run.'),
    call: () => 'Bot.parityContracts()',
});

/* ------------------------------------------------------------------ *
 * The self-reverse-engineering layer: parity DNA, the live Even/Odd
 * quotes, the expert league, the self-audit, the AI core, the deep
 * diagnosis, the two-sided forecast and the market scout.
 *
 * These blocks are deliberately read-only views of the same runtime that
 * produced the decision. Nothing here can size a trade or move a market:
 * they exist so a strategy can gate on a *measured* number (a readability
 * score, a walk-forward skill, an expected value) and so the journal can
 * hold the bot to its own record.
 * ------------------------------------------------------------------ */

defineValueBlock({
    type: 'x_parity_dna',
    message: localize('parity market DNA'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize(
        'The digit stream\u2019s structural fingerprint, measured from the ticks: even share, runs z-score, parity-Markov dependence, alternation, entropy, repeat rate and a 0\u2013100 readability score. This is how the bot knows whether it is standing on a sticky, alternating or fair tape.'
    ),
    display_name: localize('Parity market DNA'),
    description: localize('One journal line describing the market\u2019s structure. Print it at start-up and on a slow cadence: it is the difference between "the model is idle" and "this market has nothing to read".'),
    call: () => 'Bot.parityDna()',
});

defineValueBlock({
    type: 'x_parity_dna_part',
    message: localize('parity DNA %1'),
    args: [
        dropdown('PART', [
            [localize('readability 0-100'), 'score'],
            [localize('even share 0-1'), 'even-share'],
            [localize('alternation 0-1'), 'alternation'],
            [localize('runs z'), 'runs-z'],
            [localize('parity-Markov chi-square'), 'markov-chi'],
            [localize('digit chi-square'), 'digit-chi'],
            [localize('digit entropy'), 'entropy'],
            [localize('repeat rate 0-1'), 'repeat'],
            [localize('longest run'), 'longest-run'],
            [localize('sample warmth 0-1'), 'warmth'],
            [localize('phase (0 cold, 1 fair, 2 sticky, 3 alternating, 4 mixed, 5 frozen)'), 'phase'],
            [localize('regime (0 unknown, 1 fair, 2 sticky, 3 alternating, 4 drifty, 5 frozen)'), 'regime'],
            [localize('drift z'), 'drift'],
            [localize('ticks measured'), 'ticks'],
        ]),
    ],
    output: 'Number',
    colour,
    category,
    tooltip: localize('Read one measured field of the parity DNA report. Use the readability score as a gate: a market that cannot be measured should be traded smaller or not at all.'),
    display_name: localize('Parity DNA field'),
    description: localize('Every value is measured from the collected ticks, never assumed.'),
    call: (input, field) => `Bot.parityDnaPart(${field.PART})`,
});

defineValueBlock({
    type: 'x_parity_payouts',
    message: localize('Even/Odd live quotes'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('What DIGITEVEN and DIGITODD actually pay on this market right now, and whether the numbers came from Deriv or the modelled fallback. This is the table the EV scan decides on.'),
    display_name: localize('Even/Odd quotes'),
    description: localize('What each side actually pays, next to what it should pay. A quote below its fair multiple is a loss in the long run however often it wins.'),
    call: () => 'Bot.parityPayouts()',
});

defineValueBlock({
    type: 'x_parity_league',
    message: localize('parity expert league'),
    args: [],
    colour,
    category,
    output: 'String',
    tooltip: localize('Each expert\u2019s measured Brier skill against the 50/50 anchor, best first. An expert that cannot beat the fair coin loses its vote automatically.'),
    display_name: localize('Parity expert league'),
    description: localize('Which model is actually reading this market, and by how much it beats the fair coin. Print it every few dozen decisions.'),
    call: () => 'Bot.parityLeague()',
});

defineValueBlock({
    type: 'x_parity_audit',
    message: localize('parity self-audit'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The bot holding itself to its own numbers: walk-forward skill, certainty, the calibration it applied, the graded record against the break-even it was paid, and whether the record warrants standing down.'),
    display_name: localize('Parity self-audit'),
    description: localize('Measured, not modelled. A bot whose graded record sits below break-even is not trading an edge, whatever its probability says.'),
    call: () => 'Bot.parityAudit()',
});

defineValueBlock({
    type: 'x_parity_brain',
    message: localize('parity AI core'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The internal brain, as one journal line: the online nets\u2019 walk-forward training state, the regime call, and the three experts carrying the live decision. Everything here is measured on settled windows, never asserted.'),
    display_name: localize('Parity AI core'),
    description: localize('What the brain has learned and who is carrying the decision. Print it on a slow cadence: it is the difference between \u201cthe model is idle\u201d and \u201cthe model is learning\u201d.'),
    call: () => 'Bot.parityBrain()',
});

defineValueBlock({
    type: 'x_parity_reverse',
    message: localize('parity reverse engineering'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The digit stream\u2019s deep diagnosis: phase, regime, memory, entropy, repetition and drift, plus the auto-tuning the bot derived from them. Descriptive, not predictive.'),
    display_name: localize('Parity reverse engineering'),
    description: localize('How the bot reverse-engineered the market it stands on, and the caution it set for itself. Print it at start-up and on a slow cadence.'),
    call: () => 'Bot.parityReverse()',
});

defineValueBlock({
    type: 'x_parity_forecast',
    message: localize('parity outcome forecast'),
    args: [],
    output: 'String',
    colour,
    category,
    tooltip: localize('The full two-sided read: Even and Odd with their win probabilities, expected values and live quotes. The whole scan the side choice is made on, in one line.'),
    display_name: localize('Parity outcome forecast'),
    description: localize('What the scan sees on both sides. Print it with the live quotes to watch the bot think.'),
    call: () => 'Bot.parityForecast()',
});

defineValueBlock({
    type: 'x_parity_market_score',
    message: localize('parity scout score 0-100'),
    args: [],
    output: 'Number',
    colour,
    category,
    tooltip: localize('How worth trading the market the bot is standing on is: measured expected value, the engine\u2019s certainty, the DNA readability and the sample behind the decision.'),
    display_name: localize('Parity scout score'),
    description: localize('A ranking, not a forecast. Use it with the parity scout to move the bot to a market it can read.'),
    call: () => 'Bot.parityMarketScore()',
});

defineValueBlock({
    type: 'x_parity_auto_market',
    message: localize('parity scout · %1 · score floor %2 · stay at least %3 s'),
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
    tooltip: localize('Even/Odd is quoted on fourteen synthetics, and the markets do not pay the same. The bot scores the market it is on and moves when the score falls under the floor, never more often than the dwell time. A switch trades a warm tick stream for a cold one, so the dwell is deliberately long.'),
    display_name: localize('Choose the Even/Odd market'),
    description: localize('Optional scout: keep the bot on the market where its measured expected value, certainty and readability are strongest.'),
    call: (input, field) => `Bot.parityAutoMarket(${field.MODE}, ${input.FLOOR}, ${input.DWELL})`,
});
