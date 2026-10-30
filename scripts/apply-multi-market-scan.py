"""Wire the AI multi-market scan and the one-a-minute cadence into the Vision preset.

Run from the repository root:

    python3 scripts/apply-multi-market-scan.py

Four of the five shipped bots are generated: `scripts/presets/gen_presets.py`
writes the Rise/Fall, Step hedge and High/Low Tick presets and
`scripts/presets/gen_even_switcher.py` writes the Even/Odd switcher, and both
now emit the scan layer themselves. Regenerating them is the supported way to
change them, so this script deliberately touches only the one hand-authored
preset left: `ai-vision-over-under.xml`.

The layer it adds is the same in all five bots:

  * five knobs in Run once at start — `ai scan every`, `ai scan floor`,
    `ai scan margin`, `ai scan dwell`, `ai cadence`;
  * an `x_market_scan` at the top of Tick analysis that reads *every* market
    Signal Lab streams with this bot's own model, all at the same moment, then
    `x_scan_switch_best` stands the bot on the most suitable one. The single
    market the preset used to walk is gone: two pickers writing `switchSymbol`
    would fight over it;
  * an entry-cadence branch — `x_trade_due(ai cadence)` ORed into the entry
    gate — so a minute without a purchase lets the *quality* gates stand aside
    while every money gate keeps its configured value.

Nothing else changes: the models, the stake, the side choice and the brakes are
exactly as they were. The script is idempotent — a preset that already carries
the scan is left alone — and the result is re-parsed before it is written.
"""

import importlib.util
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('xmlblocks', os.path.join(HERE, 'xml-blocks.py'))
xb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(xb)

VISION = os.path.normpath(
    os.path.join(
        HERE, '..', 'artifacts', 'deriv-signal-lab', 'src', 'lib', 'bot-store', 'bots', 'ai-vision-over-under.xml'
    )
)

# Knobs the preset does not have yet: (name, variable id, shipped value).
NEW_KNOBS = [
    ('ai scan every', 'vai_scan_every', '8'),
    ('ai scan margin', 'vai_scan_margin', '3'),
    ('ai cadence', 'vai_cadence', '60'),
]
# The market the scan chose, read back by the journal.
MARKET_VAR = ('ai market', 'vai_market')
# The Vision preset already ships two scout knobs. They are the same two numbers
# the scan needs, so they are renamed and re-valued rather than duplicated: a
# second `ai scan floor` with a different variable id is exactly the split the
# preset validator exists to catch.
REPURPOSED = [
    ('aiVar13', 'ai market dwell', 'ai scan floor', 'is13', '15', '25'),
    ('aiVar14', 'ai market floor', 'ai scan dwell', 'is14', '20', '25'),
]
SCOUT_DOC = '''  The market block is set to "the most suitable market". Change its dropdown to
  "the next market in turn" to walk the ten markets, or "any market at random".
'''
SCAN_DOC = '''  Every eight seconds an AI scan reads every market Signal Lab shares with this
  same brain - all at the same moment - scores the cross-section on one scale
  and stands the bot on the most suitable market. It moves only when that
  market clears the score floor, beats the market the bot is on by the margin,
  and the dwell has passed; a switch costs a cold tick stream. The scan never
  places an order: the Purchase block still buys, on the market the scan chose.
  After a whole minute without a purchase the quality gates stand aside so the
  bot still trades at least once a minute. The money gates never do.
'''
DOC_LINES = """    ai market dwell     15     seconds to stay on a market before moving on
    ai market floor     20     with the "most suitable" mode, the score below
                               which the bot leaves a market
"""
NEW_DOC_LINES = """    ai scan every       8      seconds between AI scans of every shared market
    ai scan floor       25     the score a market must reach before the bot moves
    ai scan margin      3      how much better than the current market it must read
    ai scan dwell       25     seconds on a market before it may move again
    ai cadence          60     after this many seconds without a purchase the
                               quality gates stand aside (the money gates never do)
"""


def read(path):
    with open(path, 'r', encoding='utf-8') as handle:
        return handle.read()


def write(path, xml):
    xb.check(xml, path)
    ids = re.findall(r'<block type="[^"]+" id="([^"]+)"', xml)
    duplicates = {value for value in ids if ids.count(value) > 1}
    if duplicates:
        raise SystemExit(f'duplicate block ids in {path}: {sorted(duplicates)}')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(xml)
    print(f'  wrote {os.path.basename(path)} ({len(xml)} bytes)')


def set_num_in_block(xml, block_id, value):
    """Set the first `<field name="NUM">` inside a block, by block id."""
    start = xml.index(f'id="{block_id}"')
    end = xb.block_range(xml, xml.rindex('<block', 0, start))[1]
    block = xml[start:end]
    updated, count = re.subn(r'(<field name="NUM">)[^<]*(</field>)', lambda m: m.group(1) + str(value) + m.group(2), block, count=1)
    if count != 1:
        raise SystemExit(f'could not set the number in {block_id}')
    return xml[:start] + updated + xml[end:]


def knob_chain(ids):
    blocks = ''
    for name, vid, value in reversed(NEW_KNOBS):
        blocks = xb.set_var(ids, name, vid, xb.num(ids, value), blocks)
    return blocks


def scan_block(ids):
    return (
        f'<block type="x_market_scan" id="{ids()}"><field name="FAMILY">over-under</field>'
        f'<value name="HORIZON">{xb.get(ids, "ai duration", "aiVar02")}</value>'
        f'<value name="PAYOUT">{xb.num(ids, "1.95")}</value>'
        f'<value name="SLIP">{xb.num(ids, "1")}</value>'
        f'<value name="EVERY">{xb.get(ids, "ai scan every", "vai_scan_every")}</value>'
        f'<value name="MAX_TIE">{xb.num(ids, "0.2")}</value>'
    )


def scan_switch(ids):
    return (
        f'<block type="x_scan_switch_best" id="{ids()}">'
        f'<value name="FLOOR">{xb.get(ids, "ai scan floor", "aiVar13")}</value>'
        f'<value name="MARGIN">{xb.get(ids, "ai scan margin", "vai_scan_margin")}</value>'
        f'<value name="DWELL">{xb.get(ids, "ai scan dwell", "aiVar14")}</value>'
        '</block>'
    )


def scan_head(ids):
    """`scan every market`, then `ai market = stand on the most suitable`."""
    assign = xb.set_var(ids, MARKET_VAR[0], MARKET_VAR[1], scan_switch(ids), '__NEXT__')
    return scan_block(ids) + f'<next>{assign}</next></block>'


def cadence_gate(ids):
    """`no entry for a whole minute` AND the money gates this bot owns.

    The quality gates — the AI verdict, the confidence and agreement floors,
    the entry pace — are what the cadence stands aside, because they are what
    parks a bot on a quiet market. The loss limit, the profit target, the
    drawdown brake and the losing-streak cool-off are what it never touches.
    """
    def limit(block, name, var, vid):
        return (
            f'<block type="{block}" id="{ids()}"><value name="{name}">'
            f'{xb.get(ids, var, vid)}</value></block>'
        )

    due = xb.compare(
        ids,
        'EQ',
        f'<block type="x_trade_due" id="{ids()}"><value name="SECONDS">'
        f'{xb.get(ids, "ai cadence", "vai_cadence")}</value></block>',
        xb.num(ids, 1),
    )
    gates = [
        due,
        limit('r_drawdown_ok', 'LIMIT', 'ai max drawdown', 'aiVar17'),
        xb.compare(ids, 'LT', f'<block type="r_loss_streak" id="{ids()}"></block>',
                   xb.get(ids, 'ai loss streak stop', 'aiVar18')),
        limit('r_loss_guard', 'LIMIT', 'ai loss limit', 'aiVar08'),
        limit('r_profit_guard', 'TARGET', 'ai profit target', 'aiVar09'),
    ]
    chain = gates[-1]
    for condition in reversed(gates[:-1]):
        chain = xb.logic(ids, 'AND', condition, chain)
    return chain


def main():
    xml = read(VISION)
    if 'id="vai_scan_every"' in xml:
        print('  already wired')
        return 0

    ids = xb.Ids('vs')
    print('  ai-vision-over-under.xml')
    xml = xml.replace(DOC_LINES, NEW_DOC_LINES, 1)
    if SCOUT_DOC in xml:
        xml = xml.replace(SCOUT_DOC, SCAN_DOC, 1)
    for vid, old_name, new_name, block_id, old_value, new_value in REPURPOSED:
        xml = xml.replace(f'<variable type="" id="{vid}">{old_name}</variable>',
                          f'<variable type="" id="{vid}">{new_name}</variable>', 1)
        xml = xml.replace(f'<field name="VAR" id="{vid}">{old_name}</field>',
                          f'<field name="VAR" id="{vid}">{new_name}</field>', 1)
        xml = set_num_in_block(xml, block_id, new_value)

    for name, vid, _ in NEW_KNOBS:
        xml = xb.add_variable(xml, name, vid)
    xml = xb.add_variable(xml, *MARKET_VAR)
    xml = xb.append_statement(xml, 'INITIALIZATION', knob_chain(ids))

    # One switching path: the one-market scout is replaced by the scan.
    xml = xb.drop_first_block(xml, 'TICKANALYSIS_STACK')
    xml = xb.prepend_statement(xml, 'TICKANALYSIS_STACK', scan_head(ids))

    # The entry gate gains the cadence as its second arm. The Vision preset's
    # first IF is the entry gate itself, so it is wrapped directly.
    xml = xb.wrap_gate_or(xml, 'BEFOREPURCHASE_STACK', cadence_gate(ids), nested=False)

    write(VISION, xml)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
