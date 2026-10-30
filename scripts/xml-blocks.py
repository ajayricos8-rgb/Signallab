"""Small, surgical helpers for editing the shipped Blockly strategy XMLs.

The presets are Blockly documents with long `<next>` chains, so the edits these
helpers perform are structural rather than textual: find a statement's first
block, prepend a block to a chain, append to the end of a chain, wrap an
expression in one more AND/OR. Every result is re-parsed before it is written so
a malformed preset can never reach the store.
"""
import xml.etree.ElementTree as ET


def check(xml, path='<mem>'):
    ET.fromstring(xml.encode('utf-8'))
    return True


def find_block(xml, btype, start=0):
    """Index of the `<block type="btype"` opening tag at or after `start`."""
    needle = f'<block type="{btype}"'
    index = xml.find(needle, start)
    if index < 0:
        raise ValueError(f'block {btype} not found')
    return index


def block_range(xml, start):
    """(start, end) of the <block ...> element that opens at `start`."""
    assert xml.startswith('<block', start), xml[start:start + 40]
    depth = 0
    i = start
    while i < len(xml):
        if xml.startswith('<block', i) and (i + 6 >= len(xml) or xml[i + 6] in ' >\n\t\r'):
            close = xml.find('>', i)
            if close < 0:
                raise ValueError('unterminated block tag')
            if xml[close - 1] == '/':
                if depth == 0:
                    return start, close + 1
                i = close + 1
                continue
            depth += 1
            i = close + 1
            continue
        if xml.startswith('</block>', i):
            depth -= 1
            if depth == 0:
                return start, i + len('</block>')
            i += len('</block>')
            continue
        i += 1
    raise ValueError('unbalanced block')


def statement_range(xml, name):
    open_tag = f'<statement name="{name}">'
    start = xml.find(open_tag)
    if start < 0:
        raise ValueError(f'statement {name} not found')
    inner = start + len(open_tag)
    depth = 1
    i = inner
    while i < len(xml):
        if xml.startswith('<statement', i):
            depth += 1
            i = xml.find('>', i) + 1
            continue
        if xml.startswith('</statement>', i):
            depth -= 1
            if depth == 0:
                return inner, i
            i += len('</statement>')
            continue
        i += 1
    raise ValueError(f'statement {name} unbalanced')


def value_range(xml, name, start, end):
    """(inner_start, inner_end) of `<value name="name">` inside [start, end)."""
    open_tag = f'<value name="{name}">'
    begin = xml.find(open_tag, start, end)
    if begin < 0:
        raise ValueError(f'value {name} not found in block')
    inner = begin + len(open_tag)
    depth = 1
    i = inner
    while i < len(xml):
        if xml.startswith('<value', i):
            depth += 1
            i = xml.find('>', i) + 1
            continue
        if xml.startswith('</value>', i):
            depth -= 1
            if depth == 0:
                return inner, i
            i += len('</value>')
            continue
        i += 1
    raise ValueError('unbalanced value')


def first_block_in_statement(xml, name):
    inner_start, inner_end = statement_range(xml, name)
    start = xml.find('<block', inner_start, inner_end)
    if start < 0:
        raise ValueError(f'statement {name} has no block')
    return block_range(xml, start)


def last_block_end_in_statement(xml, name):
    """Offset of the closing `</block>` of the chain's last block."""
    inner_start, inner_end = statement_range(xml, name)
    close = xml.rfind('</block>', inner_start, inner_end)
    if close < 0:
        raise ValueError(f'statement {name} has no closing block tag')
    return close


def prepend_statement(xml, name, snippet):
    """Put `snippet` (which must contain `__NEXT__`) before the chain's first block."""
    start, end = first_block_in_statement(xml, name)
    old = xml[start:end]
    return xml[:start] + snippet.replace('__NEXT__', old) + xml[end:]


def chain_tail_id(xml, name):
    """Id of the last block of the statement's `<next>` chain.

    The last `</block>` in a statement closes the *outermost* block, not the
    tail of the chain — every nested block closes before its parent. Appending
    before that tag attaches the new block as a second `<next>` of the first
    block, which Blockly silently drops. The chain has to be walked.
    """
    body = xml[xml.index('<xml '):].replace(' xmlns="http://www.w3.org/1999/xhtml"', '', 1)
    root = ET.fromstring(body)
    for statement in root.iter('statement'):
        if statement.get('name') != name:
            continue
        block = statement.find('block')
        if block is None:
            break
        while True:
            nxt = block.find('next')
            child = nxt.find('block') if nxt is not None else None
            if child is None:
                return block.get('id')
            block = child
    raise ValueError(f'statement {name} has no block chain')


def append_statement(xml, name, snippet):
    """Add `snippet` as the last link of the chain (snippet must not end in <next>)."""
    identifier = chain_tail_id(xml, name)
    at = xml.index(f'id="{identifier}"')
    start = xml.rindex('<block', 0, at)
    _, end = block_range(xml, start)
    close = end - len('</block>')
    return xml[:close] + f'<next>{snippet}</next>' + xml[close:]


def replace_block(xml, btype, snippet):
    start = find_block(xml, btype)
    _, end = block_range(xml, start)
    return xml[:start] + snippet + xml[end:]


def wrap_gate_or(xml, statement_name, extra, nested=False, block_id='cadenceOr01'):
    """`IF (gate)` becomes `IF (gate) OR (extra)`.

    `nested=False` wraps the first controls_if's own condition — the shape where
    one IF buys and its ELSE skips. `nested=True` walks into that block's ELSE
    and wraps *its* condition — the shape where the outer IF is the "is the model
    ready?" split and the inner IF is the entry gate.
    """
    inner_start, inner_end = statement_range(xml, statement_name)
    block_start = xml.find('<block', inner_start, inner_end)
    block_end = block_range(xml, block_start)[1]
    target_start, target_end = block_start, block_end
    if nested:
        sub = xml[block_start:block_end]
        else_start, else_end = statement_range(sub, 'ELSE')
        target_start = block_start + sub.find('<block', else_start, else_end)
        target_end = block_range(xml, target_start)[1]
    value_start, value_end = value_range(xml, 'IF0', target_start, target_end)
    old = xml[value_start:value_end]
    wrapped = (
        f'<block type="logic_operation" id="{block_id}"><field name="OP">OR</field>'
        f'<value name="A">{old}</value>'
        f'<value name="B">{extra}</value>'
        '</block>'
    )
    return xml[:value_start] + wrapped + xml[value_end:]


class Ids:
    """Deterministic unique ids: Blockly rejects the document when they collide."""

    def __init__(self, prefix):
        self.prefix = prefix
        self.n = 0

    def __call__(self):
        self.n += 1
        return f'{self.prefix}{self.n:03d}'


def num(ids, value):
    return f'<block type="math_number" id="{ids()}"><field name="NUM">{value}</field></block>'


def get(ids, var, vid):
    return f'<block type="variables_get" id="{ids()}"><field name="VAR" id="{vid}">{var}</field></block>'


def set_var(ids, var, vid, value, next_xml=''):
    nxt = f'<next>{next_xml}</next>' if next_xml else ''
    return (f'<block type="variables_set" id="{ids()}">'
            f'<field name="VAR" id="{vid}">{var}</field>'
            f'<value name="VALUE">{value}</value>{nxt}</block>')


def compare(ids, op, a, b):
    return (f'<block type="logic_compare" id="{ids()}"><field name="OP">{op}</field>'
            f'<value name="A">{a}</value><value name="B">{b}</value></block>')


def logic(ids, op, a, b):
    return (f'<block type="logic_operation" id="{ids()}"><field name="OP">{op}</field>'
            f'<value name="A">{a}</value><value name="B">{b}</value></block>')


def add_variable(xml, name, vid):
    """Declare a new Blockly variable, keeping the document's variable list valid."""
    if f'<variable type="" id="{vid}">' in xml:
        return xml
    marker = '</variables>'
    index = xml.find(marker)
    if index < 0:
        raise ValueError('no <variables> section')
    return xml[:index] + f'    <variable type="" id="{vid}">{name}</variable>\n  ' + xml[index:]


def next_range(xml, start, end):
    """(inner_start, inner_end) of the first `<next>` element inside [start, end)."""
    begin = xml.find('<next>', start, end)
    if begin < 0:
        raise ValueError('no <next> in block')
    inner = begin + len('<next>')
    depth = 1
    i = inner
    while i < len(xml):
        if xml.startswith('<next>', i):
            depth += 1
            i += len('<next>')
            continue
        if xml.startswith('</next>', i):
            depth -= 1
            if depth == 0:
                return inner, i
            i += len('</next>')
            continue
        i += 1
    raise ValueError('unbalanced next')


def drop_first_block(xml, name):
    """Remove the chain's first block, promoting whatever followed it."""
    start, end = first_block_in_statement(xml, name)
    block = xml[start:end]
    promote = ''
    try:
        n_start, n_end = next_range(block, 0, len(block))
        promote = block[n_start:n_end]
    except ValueError:
        promote = ''
    return xml[:start] + promote + xml[end:]
