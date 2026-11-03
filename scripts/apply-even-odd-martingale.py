"""Add the martingale ladder, take profit / stop loss and their journal lines to
the AI Even/Odd Switcher preset.

Run from the repository root:

    python3 scripts/apply-even-odd-martingale.py

What it changes, and nothing else:

  * declares `martingale multiplier`, `martingale steps` and the `ai ladder step`
    counter, with their defaults in Run once at start;
  * renames the two session brakes the preset already enforced — `ai loss limit`
    and `ai profit target` — to `stop loss` and `take profit`. Only the names
    change: every gate that used them keeps the same value and the same test;
  * sizes the cycle stake by `stake x martingale multiplier ^ ai ladder step` in
    Tick analysis, clamped by `ai max stake`. It has to live there: the stake is
    re-priced from the ensemble on every tick, so a stake written in After
    purchase would be overwritten by the next tick's Kelly size before it is
    ever bought;
  * steps the ladder up after a loss, resets it after a win, abandons it at
    `martingale steps`, and prints each of those to the journal;
  * names take profit, stop loss and the ladder limit in the session-brake line.

The models, the side choice, the quotes, the scan, the cadence and every money
gate are left exactly as they were. The script is idempotent — a preset that
already carries the ladder is left alone — and the result is re-parsed before it
is written.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('xmlblocks', os.path.join(HERE, 'xml-blocks.py'))
xb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(xb)

PRESET = os.path.normpath(
    os.path.join(HERE, '..', 'src', 'lib', 'bot-store', 'bots', 'ai-even-switcher.xml')
)

STAKE = ('stake', 'vstake')
MULTIPLIER = ('martingale multiplier', 'vmartingale_multiplier')
STEPS = ('martingale steps', 'vmartingale_steps')
LADDER = ('ai ladder step', 'vai_ladder_step')
MAX_STAKE = ('ai max stake', 'vai_max_stake')
TAKE_PROFIT = ('take profit', 'vtake_profit')
STOP_LOSS = ('stop loss', 'vstop_loss')
PROFIT = ('baseline profit', 'vbaseline_profit')

# The two brakes the preset already enforced, under the names the operator asked
# for: (old name, old id, new name, new id). Only the label and the id change.
RENAMES = [
    ('ai loss limit', 'vai_loss_limit', STOP_LOSS[0], STOP_LOSS[1]),
    ('ai profit target', 'vai_profit_target', TAKE_PROFIT[0], TAKE_PROFIT[1]),
]

HEADER_OLD = """  Risk defaults: base 0.35, max 1.5, max 2% of balance (strict), 30 loss limit,
  50 target, 15 session-loss pause, 4 consecutive losses and 100 contracts.
  No martingale. A failed price, balance or safety gate blocks entry. Limits
  cannot protect against disconnections or other execution/settlement anomalies.
  Controls are editable in Run once at start. Research and limitations:
  docs/even-odd-research.md.
"""

HEADER_NEW = """  Risk defaults: base 0.35, max 1.5, max 2% of balance (strict), 30 stop loss,
  50 take profit, 15 session-loss pause, 4 consecutive losses and 100 contracts.
  Martingale ladder: a losing trade multiplies the next stake by "martingale
  multiplier" for up to "martingale steps" rungs, clamped by "ai max stake"; a win
  resets the ladder and the step limit abandons it. Set the multiplier to 1, or
  the steps to 0, to switch recovery off. "take profit" and "stop loss" stop the
  session. A failed price, balance or safety gate blocks entry. Limits cannot
  protect against disconnections or other execution/settlement anomalies.
  Controls are editable in Run once at start. Research and limitations:
  docs/even-odd-research.md.
"""


# --------------------------------------------------------------------------
# The block shapes Blockly writes, built rather than hand-typed


def notify(ids, kind, message):
    return (
        f'<block type="notify" id="{ids()}">'
        f'<field name="NOTIFICATION_TYPE">{kind}</field>'
        f'<field name="NOTIFICATION_SOUND">silent</field>'
        f'<value name="MESSAGE"><block type="text" id="{ids()}">'
        f'<field name="TEXT">{message}</field></block></value></block>'
    )


def if_block(ids, condition, do, otherwise=None, next_xml=''):
    mutation = '<mutation else="1"></mutation>' if otherwise else ''
    tail = f'<statement name="ELSE">{otherwise}</statement>' if otherwise else ''
    following = f'<next>{next_xml}</next>' if next_xml else ''
    return (
        f'<block type="controls_if" id="{ids()}">{mutation}'
        f'<value name="IF0">{condition}</value>'
        f'<statement name="DO0">{do}</statement>{tail}{following}</block>'
    )


def chain(*snippets):
    """Link block snippets through `<next>`; the last element is used verbatim."""
    out = snippets[-1]
    for block in reversed(snippets[:-1]):
        out = f'{block[:-len("</block>")]}<next>{out}</next></block>'
    return out


def arithmetic(ids, op, a, b):
    return (
        f'<block type="math_arithmetic" id="{ids()}"><field name="OP">{op}</field>'
        f'<value name="A">{a}</value><value name="B">{b}</value></block>'
    )


def take(ids, variable):
    return xb.get(ids, variable[0], variable[1])


def put(ids, variable, value, next_xml=''):
    return xb.set_var(ids, variable[0], variable[1], value, next_xml=next_xml)


def laddered_stake(ids):
    """stake x martingale multiplier ^ ai ladder step"""
    return arithmetic(
        ids, 'MULTIPLY',
        take(ids, STAKE),
        arithmetic(
            ids, 'POWER',
            take(ids, MULTIPLIER),
            take(ids, LADDER),
        ),
    )


# --------------------------------------------------------------------------
# The statements that are added


def stake_ladder(ids):
    """Apply the ladder where the ensemble prices the stake, capped by max stake."""
    return if_block(
        ids,
        xb.compare(ids, 'GT', take(ids, LADDER), xb.num(ids, '0')),
        if_block(
            ids,
            xb.compare(ids, 'GT', laddered_stake(ids), take(ids, MAX_STAKE)),
            put(ids, STAKE, take(ids, MAX_STAKE)),
            put(ids, STAKE, laddered_stake(ids)),
        ),
    )


def win_reset(ids):
    """A win clears the ladder, and says so when a ladder was running."""
    return chain(
        if_block(
            ids,
            xb.compare(ids, 'GT', take(ids, LADDER), xb.num(ids, '0')),
            notify(
                ids, 'success',
                'Trade won — the martingale ladder was reset to the base stake.',
            ),
        ),
        put(ids, LADDER, xb.num(ids, '0')),
        '__NEXT__',
    )


def loss_step(ids):
    """A loss climbs one rung, or abandons the ladder at the step limit."""
    abandon = chain(
        put(ids, LADDER, xb.num(ids, '0')),
        notify(
            ids, 'warn',
            'Trade lost — the martingale ladder reached its step limit and was '
            'abandoned. The next entry is priced from the base stake again.',
        ),
    )
    stepped = notify(
        ids, 'info',
        'Trade lost — the martingale ladder stepped up: the next stake is the '
        'cycle stake times the martingale multiplier, capped by the max stake '
        'ceiling and still checked by the balance percentage and stop loss.',
    )
    return chain(
        put(
            ids, LADDER,
            arithmetic(ids, 'ADD', take(ids, LADDER), xb.num(ids, '1')),
        ),
        if_block(
            ids,
            xb.compare(ids, 'GTE', take(ids, LADDER), take(ids, STEPS)),
            abandon,
            stepped,
        ),
    )


def session_brake(ids, generic):
    """Take profit / stop loss / every other limit, each with its own journal line."""
    take_profit = notify(
        ids, 'success',
        'Take profit reached — the session finished at or above the configured '
        'take profit, so new entries are stopped. Open contracts still settle; '
        'restart the bot to begin a new session.',
    )
    stop_loss = notify(
        ids, 'error',
        'Stop loss reached — the session finished at or below the configured '
        'stop loss, so new entries are stopped to protect the balance. Open '
        'contracts still settle; review the journal before restarting.',
    )
    return if_block(
        ids,
        xb.compare(ids, 'GTE', take(ids, PROFIT), take(ids, TAKE_PROFIT)),
        take_profit,
        if_block(
            ids,
            xb.compare(
                ids, 'LTE', take(ids, PROFIT),
                arithmetic(ids, 'MULTIPLY', xb.num(ids, '-1'), take(ids, STOP_LOSS)),
            ),
            stop_loss,
            generic,
        ),
    )


# --------------------------------------------------------------------------


def apply(xml):
    if 'vmartingale_multiplier' in xml:
        return xml, False

    ids = xb.Ids('mg')

    # 1. The brakes keep their defaults; only the names become the ones the
    #    operator asked for. Every use of the variable is renamed with it.
    for old_name, old_id, new_name, new_id in RENAMES:
        xml = xml.replace(f'id="{old_id}">{old_name}<', f'id="{new_id}">{new_name}<')
        assert old_name not in xml, f'{old_name} survived the rename'

    # 2. Declare the ladder's variables, and its knobs in Run once at start.
    for name, vid in (MULTIPLIER, STEPS, LADDER):
        xml = xb.add_variable(xml, name, vid)
        # `add_variable` appends with its own indent; match the list above it.
        xml = xml.replace(
            f'\n      <variable type="" id="{vid}">',
            f'\n    <variable type="" id="{vid}">',
        )

    knobs = put(
        ids, MULTIPLIER, xb.num(ids, '2'),
        next_xml=put(
            ids, STEPS, xb.num(ids, '3'),
            next_xml=put(ids, LADDER, xb.num(ids, '0'), next_xml='__NEXT__'),
        ),
    )
    xml = xb.prepend_statement(xml, 'INITIALIZATION', knobs)

    # 3. The startup journal line.
    xml = xb.append_statement(xml, 'INITIALIZATION', notify(
        ids, 'info',
        'Martingale ladder armed — a losing trade multiplies the next stake by '
        'the martingale multiplier for up to the configured martingale steps, '
        'capped by the max stake ceiling; a win resets it. Every laddered stake '
        'still passes the balance percentage, loss streak and session limits, '
        'and take profit and stop loss stop the session.',
    ))

    # 4. The stake itself: the ladder is applied where the ensemble prices it.
    xml = xb.append_statement(xml, 'TICKANALYSIS_STACK', stake_ladder(ids))

    # 5. After purchase: reset on a win, climb on a loss, journal both.
    after_start, after_end = xb.block_range(xml, xb.find_block(xml, 'after_purchase'))
    after = xml[after_start:after_end]

    win_start, win_end = xb.block_range(
        after, after.index('<block type="variables_set" id="b0274">')
    )
    after = (
        after[:win_start]
        + win_reset(ids).replace('__NEXT__', after[win_start:win_end])
        + after[win_end:]
    )

    loss_start, loss_end = xb.block_range(
        after, after.index('<block type="variables_set" id="b0279">')
    )
    close = loss_end - len('</block>')
    after = after[:close] + f'<next>{loss_step(ids)}</next>' + after[close:]

    # 6. The session brake names take profit, stop loss, or the other limits.
    brake_start = after.index('<block type="notify" id="b0358">')
    brake_end = xb.block_range(after, brake_start)[1]
    after = (
        after[:brake_start]
        + session_brake(ids, after[brake_start:brake_end])
        + after[brake_end:]
    )

    xml = xml[:after_start] + after + xml[after_end:]

    # 7. The header tells the truth about the defaults.
    assert HEADER_OLD in xml
    xml = xml.replace(HEADER_OLD, HEADER_NEW)

    xb.check(xml, PRESET)
    return xml, True


def main():
    with open(PRESET, encoding='utf-8') as handle:
        xml = handle.read()
    updated, changed = apply(xml)
    if not changed:
        print('ai-even-switcher.xml already carries the martingale ladder; left alone.')
        return
    with open(PRESET, 'w', encoding='utf-8') as handle:
        handle.write(updated)
    print(f'updated {os.path.relpath(PRESET)}')


if __name__ == '__main__':
    main()
