// The AI Even/Odd Switcher carries the operator-owned martingale ladder, the
// take profit / stop loss knobs and the journal lines that explain both. These
// tests read the shipped preset the way Blockly does — as a block document, not
// as a string — so a hand edit that would load as a broken workspace fails here
// first, and a ladder that was quietly dropped from the wrong statement fails
// too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const preset = await readFile(
  new URL('../../../src/lib/bot-store/bots/ai-even-switcher.xml', import.meta.url),
  'utf8',
);

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/** A tiny, strict XML reader: elements, attributes and text, nothing else. */
function parse(source) {
  const document = source.replace(/<!--[\s\S]*?-->/g, '');
  const root = { name: '#document', attrs: {}, children: [], text: '', parent: null };
  const stack = [root];
  let cursor = 0;
  let match;
  TAG.lastIndex = 0;
  while ((match = TAG.exec(document))) {
    const [, closing, name, rawAttributes, selfClosing] = match;
    const parent = stack[stack.length - 1];
    parent.text += document.slice(cursor, match.index);
    cursor = TAG.lastIndex;
    if (closing) {
      const element = stack.pop();
      if (!element || element.name !== name) {
        throw new Error(`unbalanced </${name}> at ${match.index}`);
      }
      continue;
    }
    const attrs = {};
    for (const attribute of rawAttributes.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      attrs[attribute[1]] = attribute[2];
    }
    const element = { name, attrs, children: [], text: '', parent };
    parent.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) throw new Error(`unbalanced document: ${stack.map(e => e.name)}`);
  return root;
}

/** Depth-first walk over every element. */
function* walk(node) {
  for (const child of node.children) {
    yield child;
    yield* walk(child);
  }
}

/**
 * The walk without `<next>`. Blockly hangs the rest of the statement chain off
 * a block's `<next>`, so a plain walk makes every block an ancestor of
 * everything that follows it; this one sees only what the block itself owns.
 */
function* inside(node) {
  for (const child of node.children) {
    if (child.name === 'next') continue;
    yield child;
    yield* inside(child);
  }
}

const elements = [...walk(parse(preset))];
const blocks = elements.filter((element) => element.name === 'block');
const block = (type) => blocks.filter((element) => element.attrs.type === type);
const statements = (element) => element.children.filter((child) => child.name === 'statement');
const statement = (element, name) => statements(element).find((child) => child.attrs.name === name);
const text = (element) => [element.text, ...element.children.map(text)].join('\n');
const presetText = elements.map(text).join('\n');

/** The chain hanging off `<next>`, in statement order. */
function chain(element) {
  const out = [];
  let current = element;
  while (current) {
    out.push(current);
    const next = current.children.find((child) => child.name === 'next');
    current = next?.children.find((child) => child.name === 'block') ?? null;
  }
  return out;
}

test('the preset declares the ladder, its counter and the two session brakes', () => {
  const declared = new Map(
    elements
      .filter((element) => element.name === 'variable')
      .map((element) => [element.attrs.id, text(element).trim()]),
  );
  assert.equal(declared.get('vmartingale_multiplier'), 'martingale multiplier');
  assert.equal(declared.get('vmartingale_steps'), 'martingale steps');
  assert.equal(declared.get('vai_ladder_step'), 'ai ladder step');
  assert.equal(declared.get('vtake_profit'), 'take profit');
  assert.equal(declared.get('vstop_loss'), 'stop loss');
  // The brakes the preset already enforced were renamed, not duplicated: one
  // knob each, and nothing left pointing at the old names.
  assert.ok(!declared.has('vai_loss_limit'));
  assert.ok(!declared.has('vai_profit_target'));
  assert.doesNotMatch(presetText, /ai loss limit|ai profit target/);
});

test('Run once at start ships the ladder defaults behind the money gates', () => {
  const initialization = statement(block('trade_definition')[0], 'INITIALIZATION');
  const order = new Map();
  for (const node of walk(initialization)) {
    if (node.name !== 'block' || node.attrs.type !== 'variables_set') continue;
    const variable = node.children.find((child) => child.name === 'field' && child.attrs.name === 'VAR');
    const value = node.children
      .filter((child) => child.name === 'value')
      .flatMap((child) => child.children)
      .find((child) => child.name === 'block');
    order.set(variable.attrs.id, text(value).trim());
  }
  assert.equal(order.get('vmartingale_multiplier'), '2');
  assert.equal(order.get('vmartingale_steps'), '3');
  assert.equal(order.get('vai_ladder_step'), '0');
  assert.equal(order.get('vstop_loss'), '30');
  assert.equal(order.get('vtake_profit'), '50');
  assert.equal(order.get('vstake'), 'base stake');
});

test('the stake is multiplied by the ladder where the ensemble prices it', () => {
  const tickAnalysis = block('tick_analysis');
  assert.equal(tickAnalysis.length, 1);
  const priced = chain(
    statement(tickAnalysis[0], 'TICKANALYSIS_STACK').children.find(
      (child) => child.name === 'block',
    ),
  ).find((node) => node.children.some(
    (child) => child.name === 'field' && child.attrs.name === 'VAR' && child.attrs.id === 'vstake',
  ) && node.children.some((child) => child.name === 'value'
    && child.children.some((inner) => inner.attrs?.type === 'x_parity_stake')));
  assert.ok(priced, 'the tick analysis still sizes the stake with x_parity_stake');

  const ladder = chain(priced).slice(1);
  const laddered = text(ladder[0]);
  // It has to run after the Kelly size, in the tick, because the next tick
  // re-prices the stake and would overwrite anything written after purchase.
  assert.match(laddered, /ai ladder step/);
  assert.match(laddered, /martingale multiplier/);
  const arithmetic = ladder
    .flatMap((node) => [...walk(node)])
    .filter((node) => node.attrs?.type === 'math_arithmetic')
    .map((node) => node.children.find((child) => child.name === 'field' && child.attrs.name === 'OP')?.text);
  assert.ok(arithmetic.filter((op) => op === 'POWER').length >= 2, 'multiplier ^ step');
  assert.ok(arithmetic.includes('MULTIPLY'), 'stake x multiplier ^ step');
  assert.match(laddered, /ai max stake/, 'the rung is clamped by the max stake ceiling');
});

test('a win clears the ladder, a loss climbs it, and the journal says both', () => {
  const after = block('after_purchase')[0];
  const stack = statement(after, 'AFTERPURCHASE_STACK');
  const result = chain(stack.children.find((child) => child.name === 'block')).find(
    (node) => node.attrs?.type === 'controls_if' && statements(node).some((child) => child.attrs.name === 'ELSE'),
  );
  const won = chain(statement(result, 'DO0').children.find((child) => child.name === 'block'));
  const lost = chain(
    statement(result, 'ELSE').children
      .flatMap((child) => chain(child))
      .find((node) => node.attrs?.type === 'controls_if'),
  );

  const wonText = won.map(text).join('\n');
  assert.match(wonText, /ai ladder step/);
  assert.match(wonText, /reset to the base stake/);

  const lostText = lost.map(text).join('\n');
  assert.match(lostText, /ai ladder step/);
  assert.match(lostText, /martingale steps/);
  assert.match(lostText, /stepped up/);
  assert.match(lostText, /step limit/);
});

test('take profit and stop loss each print their own brake line', () => {
  const after = block('after_purchase')[0];
  const stack = chain(statement(after, 'AFTERPURCHASE_STACK').children.find(
    (child) => child.name === 'block',
  ));
  const gate = stack.find(
    (node) => node.attrs?.type === 'controls_if'
      && [...inside(node)].some((element) => element.attrs?.type === 'trade_again'),
  );
  assert.ok(gate, 'the session brake still decides whether to trade again');

  const otherwise = text(statement(gate, 'ELSE'));
  assert.match(otherwise, /take profit/, 'the take profit limit is named');
  assert.match(otherwise, /Take profit reached/, 'the take profit line is printed');
  assert.match(otherwise, /stop loss/, 'the stop loss limit is named');
  assert.match(otherwise, /Stop loss reached/, 'the stop loss line is printed');
  assert.match(otherwise, /Session brake/, 'the other limits keep their line');
});

test('the ensemble, the scan, the purchases and the cadence are untouched', () => {
  for (const type of [
    'x_parity_decision',
    'x_parity_decision_part',
    'x_parity_dna',
    'x_parity_payouts',
    'x_parity_brain',
    'x_parity_reverse',
    'x_parity_reason',
    'x_parity_forecast',
    'x_parity_audit',
    'x_parity_league',
    'x_parity_risk',
    'x_parity_stake',
    'x_market_scan',
    'x_scan_switch_best',
    'x_trade_due',
    'x_session_profit',
    'purchase',
    'trade_again',
    'tick_analysis',
    'before_purchase',
    'after_purchase',
  ]) {
    assert.ok(block(type).length > 0, `${type} is still in the preset`);
  }
  // Every money gate still receives the renamed brakes, so the rename cannot
  // have left a gate reading a variable nobody sets.
  const riskGate = text(block('x_parity_risk')[0]);
  assert.match(riskGate, /stop loss/);
  assert.match(riskGate, /take profit/);
  assert.match(riskGate, /ai stake percent/);
});

test('the document is one Blockly can load: unique ids, one chain, matched else', () => {
  const ids = blocks.map((element) => element.attrs.id);
  assert.equal(new Set(ids).size, ids.length, 'block ids are unique');

  const declared = new Set(
    elements.filter((element) => element.name === 'variable').map((element) => element.attrs.id),
  );
  for (const element of elements) {
    if (element.name !== 'field' || element.attrs.name !== 'VAR') continue;
    assert.ok(declared.has(element.attrs.id), `${element.attrs.id} is declared`);
  }

  for (const element of statementsRoot(elements)) {
    const heads = element.children.filter((child) => child.name === 'block');
    assert.equal(heads.length, 1, `statement ${element.attrs.name} holds one chain head`);
  }

  for (const element of blocks) {
    const nexts = element.children.filter((child) => child.name === 'next');
    assert.ok(nexts.length <= 1, `block ${element.attrs.id} has at most one next`);
    if (element.attrs.type !== 'controls_if') continue;
    const hasElse = statements(element).some((child) => child.attrs.name === 'ELSE');
    const mutation = element.children.find((child) => child.name === 'mutation');
    if (hasElse) {
      assert.equal(mutation?.attrs.else, '1', `controls_if ${element.attrs.id} declares its else`);
    } else {
      assert.equal(mutation, undefined, `controls_if ${element.attrs.id} has no stray else`);
    }
  }
});

function statementsRoot(elements) {
  return elements.filter((element) => element.name === 'statement');
}
