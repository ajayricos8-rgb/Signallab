#!/usr/bin/env python3
"""Generate the three editable price-strategy DBot presets from stock blocks.

Run from `artifacts/deriv-signal-lab`:

    python3 scripts/generate-price-bots.py

The presets are ordinary DBot strategies — importable, editable, inspectable —
not opaque binaries. Every decision they make comes from blocks that are also
in the Vision Lab → Price strategies toolbox:

  x_price_decision        the seven-expert price ensemble (the brain)
  x_price_decision_part   reads the decision: ready, side, probability, tie
                          rate, edge, confidence, agreement, samples, horizon
  x_price_reason          the journal line: the contract, or why it waited
  x_price_risk            the stake/legs/limits gate
  x_ai_stake              quarter-Kelly sizing that follows the edge

Design rules these files follow (they are what makes them safe to ship):

  * The contract horizon is ODD (5 ticks) on every preset. Step Index moves in
    fixed ±0.1 steps, so an even horizon ties ~36% of the time — and a tie is a
    loss. A 4-tick Rise/Fall there can never win more than ~32%, which is why
    the previous 4-tick presets could not open a single position no matter how
    long they ran. Five ticks removes the tie entirely, and it is also the
    shortest tick contract Deriv sells for High/Low Tick.
  * The models replay the *contract* duration, so editing Trade options can no
    longer freeze the strategy behind a horizon mismatch.
  * The bot explains itself. When it skips it says why (warming up, thin state,
    tie risk, below threshold, thin evidence, disagreement) on a sampled
    schedule instead of flooding the journal every tick.
  * Staking follows the measured edge. Every cycle the stake is recomputed by
    `x_price_stake` (tenth-Kelly on the decision's own probability and the
    configured payout), floored at Deriv's 0.35 minimum, capped by
    "max stake" and by the operator's balance percent, and reduced while the
    session is losing. There is no martingale: a loss never raises the stake,
    and the loss limit is the session brake.
"""
import copy
import math
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1] / 'src/lib/bot-store/bots'
NS = 'http://www.w3.org/1999/xhtml'
ET.register_namespace('', NS)
q = lambda n: '{%s}%s' % (NS, n)
base = ET.parse(ROOT / 'ai-even-switcher.xml').getroot()
seq = 0


def node(tag, **attrs):
    return ET.Element(q(tag), attrs)


def block(kind):
    global seq
    seq += 1
    return node('block', type=kind, id='price%04d' % seq)


def field(b, name, value, **attrs):
    e = ET.SubElement(b, q('field'), {'name': name, **attrs})
    e.text = str(value)
    return b


def val(b, name, child):
    e = ET.SubElement(b, q('value'), {'name': name})
    e.append(child)
    return b


def statement(b, name, child):
    e = ET.SubElement(b, q('statement'), {'name': name})
    e.append(child)
    return b


def num(value):
    return field(block('math_number'), 'NUM', value)


def text(value):
    return field(block('text'), 'TEXT', value)


def get(name):
    return field(block('variables_get'), 'VAR', name, id='v' + name.replace(' ', '_'))


def setvar(name, value):
    return val(field(block('variables_set'), 'VAR', name, id='v' + name.replace(' ', '_')), 'VALUE', value)


def chain(*blocks):
    for a, b in zip(blocks, blocks[1:]):
        ET.SubElement(a, q('next')).append(b)
    return blocks[0]


def compare(op, left, right):
    return val(val(field(block('logic_compare'), 'OP', op), 'A', left), 'B', right)


def logic(op, left, right):
    return val(val(field(block('logic_operation'), 'OP', op), 'A', left), 'B', right)


def arith(op, left, right):
    return val(val(field(block('math_arithmetic'), 'OP', op), 'A', left), 'B', right)


def modulo(left, right):
    return val(val(block('math_modulo'), 'DIVIDEND', left), 'DIVISOR', right)


def ifblock(cond, yes, no=None):
    b = block('controls_if')
    if no is not None:
        ET.SubElement(b, q('mutation'), {'else': '1'})
    val(b, 'IF0', cond)
    statement(b, 'DO0', yes)
    if no is not None:
        statement(b, 'ELSE', no)
    return b


def notify(kind, message_block):
    b = block('notify')
    field(b, 'NOTIFICATION_TYPE', kind)
    field(b, 'NOTIFICATION_SOUND', 'silent')
    val(b, 'MESSAGE', message_block)
    return b


def part(name):
    return val(field(block('x_price_decision_part'), 'PART', name), 'PLAN', get('decision'))


def stake_block():
    """The AI stake for this cycle: tenth-Kelly on the decision's probability.

    Stake is recomputed before every entry instead of being carried by a ladder,
    so a stronger measured edge is staked harder and a weaker one is staked at
    the floor. `max stake` keeps a large balance from sizing a small account's
    plan out of proportion.
    """
    b = block('x_price_stake')
    for name, child in [
        ('PROBABILITY', part('probability')),
        ('PAYOUT', get('payout')),
        ('BASE', get('base stake')),
        ('FRACTION', get('kelly fraction')),
        ('PERCENT', get('balance percent')),
        ('MAX_STAKE', get('max stake')),
    ]:
        val(b, name, child)
    return b


def risk(legs, stake=None):
    b = block('x_price_risk')
    for name, child in [
        ('STAKE', stake if stake is not None else get('stake')),
        ('LEGS', num(legs)),
        ('BASELINE', get('baseline profit')),
        ('LOSS', get('loss limit')),
        ('TARGET', get('profit target')),
        ('PERCENT', get('balance percent')),
    ]:
        val(b, name, child)
    return b


def decision_block(mode):
    b = field(block('x_price_decision'), 'MODE', mode)
    val(b, 'LIST', block('ticks'))
    val(b, 'HORIZON', get('duration'))
    val(b, 'THRESHOLD', get('threshold'))
    val(b, 'MAX_TIE', get('max tie'))
    val(b, 'MIN_AGREEMENT', get('min agreement'))
    return b


def produce(filename, kind):
    """kind: 'tick' (High/Low Tick), 'rise' (Rise/Fall), 'hedge' (step pair)."""
    global seq
    seq = 0
    hedged = kind == 'hedge'
    tick_mode = kind == 'tick'
    legs = 2 if hedged else 1

    # Every preset trades an ODD five-tick horizon. See the module docstring.
    var_defaults = {
        'base stake': 0.35,
        'stake': 0.35,
        'loss limit': 10,
        'profit target': 10,
        'balance percent': 5,
        'duration': 5,
        'threshold': 0.30 if tick_mode else 0.56,
        'max tie': 0.20,
        'min agreement': 0.60,
        'min confidence': 55 if tick_mode else 60,
        'payout': 0.95,
        'kelly fraction': 0.10,
        'max stake': 2.8,
        'skip count': 0,
        'decision': 0,
    }

    root = node('xml', collection='false', is_dbot='true')
    variables = ET.SubElement(root, q('variables'))
    for name in list(var_defaults) + ['baseline profit']:
        var = ET.SubElement(variables, q('variable'), {'type': '', 'id': 'v' + name.replace(' ', '_')})
        var.text = name

    # ---- trade definition --------------------------------------------------
    trade = copy.deepcopy(base.find("./%s[@type='trade_definition']" % q('block')))
    for b in trade.iter(q('block')):
        kind_name = b.get('type')
        for f in b.findall(q('field')):
            name = f.get('name')
            if kind_name == 'trade_definition_market':
                if name == 'SUBMARKET_LIST':
                    f.text = 'random_index' if tick_mode else 'step_index'
                if name == 'SYMBOL_LIST':
                    f.text = 'R_100' if tick_mode else 'stpRNG'
            if kind_name == 'trade_definition_tradetype':
                if name == 'TRADETYPECAT_LIST':
                    f.text = 'highlowticks' if tick_mode else 'callput'
                if name == 'TRADETYPE_LIST':
                    f.text = 'highlowticks' if tick_mode else 'callput'
            if kind_name == 'trade_definition_restartonerror' and name == 'RESTARTONERROR':
                f.text = 'FALSE'

    init = trade.find("./%s[@name='INITIALIZATION']" % q('statement'))
    init.clear()
    init.set('name', 'INITIALIZATION')
    sets = [
        setvar(name, get('base stake') if name == 'stake' else num(value))
        for name, value in var_defaults.items()
        if name != 'decision'
    ]
    sets.append(setvar('baseline profit', block('x_session_profit')))
    armed = (
        'Price AI armed — seven experts mixed by measured skill, stake sized from the measured edge. '
        'Entries need probability, confidence, agreement and risk to clear together, and every skip is explained in the journal.'
    )
    sets.append(setvar('skip count', num(0)))
    # One line at start-up so the operator knows the gates are live, and what
    # to read in the journal when the bot looks idle.
    sets.append(notify('info', text(armed)))
    init.append(chain(*sets))

    sub = trade.find("./%s[@name='SUBMARKET']" % q('statement'))
    sub.clear()
    sub.set('name', 'SUBMARKET')
    opts = block('trade_definition_tradeoptions')
    ET.SubElement(
        opts,
        q('mutation'),
        {'has_first_barrier': 'false', 'has_second_barrier': 'false', 'has_prediction': 'true' if tick_mode else 'false'},
    )
    field(opts, 'DURATIONTYPE_LIST', 't')
    field(opts, 'CURRENCY_LIST', 'USD')
    val(opts, 'DURATION', get('duration'))
    val(opts, 'AMOUNT', get('stake'))
    if tick_mode:
        # The purchase block overrides this with the current decision's tick.
        val(opts, 'PREDICTION', num(1))
    field(opts, 'AMOUNT_LIMITS', '')
    sub.append(opts)
    root.append(trade)

    # ---- before purchase ---------------------------------------------------
    before = block('before_purchase')
    before.set('x', '0')
    before.set('y', '760')
    mode = 'tick' if tick_mode else 'step-hedge' if hedged else 'rise'
    calc = chain(
        setvar('decision', decision_block(mode)),
        # Size the stake from the probability the models just measured. A block
        # that is not ready leaves the stake at its floor and buys nothing.
        setvar('stake', stake_block()),
    )

    gate = logic(
        'AND',
        compare('EQ', part('ready'), num(1)),
        logic(
            'AND',
            compare('GTE', part('confidence'), get('min confidence')),
            risk(legs),
        ),
    )

    if hedged:
        buy = field(field(block('hedge_purchase'), 'PURCHASE_LIST', 'CALL'), 'HEDGE_LIST', 'PUT')
    elif tick_mode:
        buy = val(val(block('x_tick_decision_purchase'), 'SIDE', part('side')), 'TICK', part('tick'))
    else:
        rise = field(block('purchase'), 'PURCHASE_LIST', 'CALL')
        fall = field(block('purchase'), 'PURCHASE_LIST', 'PUT')
        buy = ifblock(compare('EQ', part('side'), num(1)), rise, fall)

    # Entry: say what was bought (the reason string carries the measured
    # probability, confidence, agreement and tie rate), then buy.
    entry = chain(setvar('skip count', num(0)), notify('success', block('x_price_reason')), buy)

    # Idle ticks are explained one in twenty, so the journal stays readable (and
    # is not flooded) while a waiting bot still says why it is waiting. The
    # reason differs by gate: the AI's own line when the model is not ready, and
    # a risk message when the model *is* ready but money/stake guards hold it.
    def sampled_notice(kind, message, counter):
        return chain(
            setvar(counter, arith('ADD', get(counter), num(1))),
            ifblock(
                compare('EQ', modulo(get(counter), num(20)), num(1)),
                notify(kind, message),
            ),
        )

    skip = sampled_notice('info', block('x_price_reason'), 'skip count')
    held = sampled_notice(
        'warn',
        text(
            'AI is ready but the entry gate held it — check the stake against the balance percent, '
            'the loss limit, the profit target and that any previous pair has settled.'
        ),
        'skip count',
    )

    branch = ifblock(compare('EQ', part('ready'), num(0)), skip, ifblock(gate, entry, held))
    statement(before, 'BEFOREPURCHASE_STACK', chain(calc, branch))
    root.append(before)

    # ---- after purchase ----------------------------------------------------
    after = block('after_purchase')
    after.set('x', '0')
    after.set('y', '1150')
    # No ladder, by design: the next stake comes from the next measurement, not
    # from the previous loss. The loss limit and the profit target are the only
    # things that end a session.
    again = ifblock(
        logic(
            'AND',
            risk(legs, stake=get('base stake')),
            logic(
                'AND',
                compare('GT', block('x_session_profit'), arith('MULTIPLY', num(-1), get('loss limit'))),
                compare('LT', block('x_session_profit'), get('profit target')),
            ),
        ),
        block('trade_again'),
    )
    statement(after, 'AFTERPURCHASE_STACK', again)
    root.append(after)

    ET.indent(root, space='  ')
    ET.ElementTree(root).write(ROOT / filename, encoding='utf-8', xml_declaration=True)


produce('high-low-tick-sniper.xml', 'tick')
produce('rise-fall-ensemble.xml', 'rise')
produce('step-rise-fall-hedge.xml', 'hedge')
print('generated three price presets')
