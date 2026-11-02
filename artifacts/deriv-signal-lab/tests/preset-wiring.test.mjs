/**
 * Wiring guard for the shipped store presets.
 *
 * A preset is XML that names blocks by string. Nothing about a typo, a retired
 * block, a label with the wrong number of placeholders or a `Bot.*` call that
 * was never implemented fails until the strategy is loaded in a browser — and
 * by then it fails as "XML file contains unsupported elements", which is the
 * most expensive kind of bug to find. This test closes that gap statically:
 *
 *   1. every `<block type="…">` a shipped preset uses must exist in the vendored
 *      block library;
 *   2. every factory block's label must reference all of its args — Blockly
 *      throws `Message does not reference all N arg(s)` while loading, and the
 *      DBot loader reports any load throw as invalid XML;
 *   3. every `<value>` / `<statement>` / `<field>` a preset writes into an
 *      `x_*` block must be an input or field that block declares, otherwise
 *      Blockly drops the connection and the strategy silently trades a default;
 *   4. every dropdown value written into a preset must be one the block offers;
 *   5. every `Bot.*` call those blocks generate must exist in the runtime
 *      interfaces, because the interpreter routes `Bot.x` straight through.
 *
 * It reads the source, not a running workspace, so it is fast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const BOTS = new URL('../src/lib/bot-store/bots/', import.meta.url);
const BLOCKS = new URL('../../../vendor/deriv-bot/src/external/bot-skeleton/scratch/blocks/', import.meta.url);
const INTERFACES = new URL('../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/Interface/', import.meta.url);

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) out.push(...(await jsFiles(child)));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(child);
  }
  return out;
}

const blockSource = (await Promise.all((await jsFiles(BLOCKS)).map(file => readFile(file, 'utf8')))).join('\n');
const interfaceSource = (
  await Promise.all((await jsFiles(INTERFACES)).map(file => readFile(file, 'utf8')))
).join('\n');

const BOT_FILES = (await readdir(BOTS)).filter(name => name.endsWith('.xml'));
const BOT_XML = Object.fromEntries(
  await Promise.all(BOT_FILES.map(async name => [name, await readFile(new URL(name, BOTS), 'utf8')]))
);

/* ------------------------------------------------------------------ *
 * Reading the XML
 * ------------------------------------------------------------------ */

/**
 * Every `<block>` in a preset with the inputs and fields that belong to *it*.
 *
 * A regex that pairs `<block …>` with the next `</block>` gets nesting wrong:
 * the first close belongs to the innermost child, so a child's `<value>` is
 * attributed to its parent. This walks the tags with a stack instead.
 */
function parseBlocks(xml) {
  const blocks = [];
  const stack = [];
  const tagPattern = /<(\/?)(block|shadow|value|statement|field|mutation|next)\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(xml))) {
    const [, closing, tag, attributes, selfClosing] = match;
    if (tag === 'block' || tag === 'shadow') {
      if (closing) {
        stack.pop();
      } else {
        const type = /type="([^"]+)"/.exec(attributes)?.[1] ?? '';
        const node = { type, inputs: [], fields: [], tag: stack.length ? stack[stack.length - 1].tag : null, name: stack.length ? stack[stack.length - 1].name : null };
        blocks.push(node);
        if (!selfClosing) stack.push({ tag, block: node });
      }
      continue;
    }
    if (tag === 'value' || tag === 'statement') {
      if (!closing && stack.length) {
        const parent = stack[stack.length - 1];
        const name = /name="([^"]+)"/.exec(attributes)?.[1] ?? '';
        if (parent.block) parent.block.inputs.push(name);
        if (!selfClosing) stack.push({ tag, name, block: parent.block });
      } else if (closing) {
        stack.pop();
      }
      continue;
    }
    if (tag === 'field') {
      if (!closing && stack.length) {
        const parent = stack[stack.length - 1];
        const name = /name="([^"]+)"/.exec(attributes)?.[1] ?? '';
        const value = /^([^<]*)/.exec(xml.slice(tagPattern.lastIndex))?.[1] ?? '';
        if (parent.block) parent.block.fields.push({ name, value });
      }
      continue;
    }
    // mutation / next: nothing to record, but they must not unbalance the stack.
  }
  return blocks;
}

/* ------------------------------------------------------------------ *
 * Reading the block library
 * ------------------------------------------------------------------ */

/** The source of one block definition, sliced up to the next definition. */
function blockSlice(type) {
  for (const pattern of [`type: '${type}'`, `Blocks.${type} =`]) {
    const at = blockSource.indexOf(pattern);
    if (at < 0) continue;
    const rest = blockSource.slice(at + pattern.length);
    const next = Math.min(
      ...[`defineValueBlock({`, `defineStatementBlock({`, `window.Blockly.Blocks.`]
        .map(marker => rest.indexOf(marker))
        .filter(index => index >= 0)
    );
    return rest.slice(0, Number.isFinite(next) ? next : 6000);
  }
  return '';
}

/**
 * Every block the factory declares, with its label, its args and the input and
 * field names it creates.
 */
function factoryDefinitions(source) {
  const specs = new Map();
  // Small local helpers like `const FAMILY = () => dropdown('FAMILY', …)` are
  // how a few blocks declare a dropdown. Resolve them by name.
  const helpers = new Map();
  for (const helper of source.matchAll(/const\s+(\w+)\s*=\s*\(\)\s*=>/g)) {
    const body = source.slice(helper.index, helper.index + 320);
    const name = /dropdown\(\s*'([^']+)'/.exec(body)?.[1] ?? /name:\s*'([^']+)'/.exec(body)?.[1];
    if (name) helpers.set(helper[1], name);
  }
  for (const opener of source.matchAll(/define(?:Value|Statement)Block\(\{/g)) {
    const start = source.indexOf('{', opener.index);
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const spec = source.slice(start, end + 1);
    const type = /type:\s*'([^']+)'/.exec(spec);
    if (!type) continue;
    const message = /message:\s*localize\(\s*'((?:[^'\\]|\\.)*)'/.exec(spec);
    const args = [];
    const argsAt = spec.indexOf('args:');
    if (argsAt >= 0) {
      const open = spec.indexOf('[', argsAt);
      let level = 0;
      let current = '';
      for (let cursor = open; cursor < spec.length; cursor++) {
        const char = spec[cursor];
        if (char === '[' || char === '(' || char === '{') {
          level++;
          if (level === 1) continue;
        } else if (char === ']' || char === ')' || char === '}') {
          level--;
          if (level === 0) break;
        } else if (char === ',' && level === 1) {
          args.push(current);
          current = '';
          continue;
        }
        current += char;
      }
      if (current.trim()) args.push(current);
    }
    // Args are declared either as raw `{ type, name: 'X' }` objects or through
    // the `dropdown('X', …)` / `numberInput('X', …)` helpers, whose first
    // string argument is the name.
    const names = args
      .map(
        entry =>
          /name:\s*'([^']+)'/.exec(entry)?.[1] ??
          /(?:dropdown|numberInput)\(\s*'([^']+)'/.exec(entry)?.[1] ??
          helpers.get(/^\s*(\w+)\(\)\s*$/.exec(entry)?.[1])
      )
      .filter(Boolean);
    specs.set(type[1], { message: message ? message[1] : '', args, names: new Set(names) });
  }
  return specs;
}

const FACTORY = factoryDefinitions(blockSource);

/* ------------------------------------------------------------------ *
 * Reading the runtime
 * ------------------------------------------------------------------ */

/** The `Bot.*` methods the block library calls. */
const botMethods = new Set([...blockSource.matchAll(/Bot\.([A-Za-z0-9_]+)\(/g)].map(match => match[1]));

/**
 * The methods the runtime exposes. A method is counted when any interface
 * declares it as a property, which is how every one of them is registered —
 * the interpreter routes `Bot.x` straight through by name.
 */
const runtimeMethods = new Set(
  [...interfaceSource.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:/g)].map(match => match[1])
);

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

const blockExists = type => new RegExp(`type:\\s*'${type}'|Blocks\\.${type}\\s*=`).test(blockSource);

test('every shipped preset uses blocks the library defines', () => {
  for (const [name, xml] of Object.entries(BOT_XML)) {
    const missing = [...new Set(parseBlocks(xml).map(block => block.type))].filter(type => type && !blockExists(type));
    assert.deepEqual(missing, [], `${name}: unknown block types`);
  }
});

test('every factory block references all of its arguments in its label', () => {
  assert.ok(FACTORY.size > 10, `parsed ${FACTORY.size} factory blocks`);
  for (const [type, spec] of FACTORY) {
    if (!spec.message) continue;
    const placeholders = [...spec.message.matchAll(/%(\d+)/g)].map(match => Number(match[1]));
    const highest = placeholders.length ? Math.max(...placeholders) : 0;
    assert.equal(
      highest,
      spec.args.length,
      `${type}: the label has %1..%${highest} but the block declares ${spec.args.length} args — Blockly throws "Message does not reference all ${spec.args.length} arg(s)" and every preset using the block fails to load`
    );
    // Gaps are just as fatal: %1 and %3 with two args leaves %2 unbound.
    for (let index = 1; index <= spec.args.length; index++) {
      assert.ok(placeholders.includes(index), `${type}: placeholder %${index} is missing from the label`);
    }
  }
});

test('every input and field a preset fills exists on the block that owns it', () => {
  for (const [name, xml] of Object.entries(BOT_XML)) {
    for (const block of parseBlocks(xml)) {
      const spec = FACTORY.get(block.type);
      if (!spec || !spec.names.size) continue;
      for (const input of block.inputs) {
        assert.ok(
          spec.names.has(input),
          `${name}: ${block.type} has no input "${input}" (it declares ${[...spec.names].join(', ')}); Blockly drops the connection`
        );
      }
      for (const field of block.fields) {
        if (field.name === 'VAR') continue;
        assert.ok(
          spec.names.has(field.name),
          `${name}: ${block.type} has no field "${field.name}" (it declares ${[...spec.names].join(', ')})`
        );
      }
    }
  }
});

test('every dropdown value a preset writes is a value the block offers', () => {
  const dropdowns = ['PART', 'MODE', 'REQUIRE', 'CHECK_RESULT', 'FAMILY'];
  for (const [name, xml] of Object.entries(BOT_XML)) {
    for (const block of parseBlocks(xml)) {
      const definition = blockSlice(block.type);
      if (!definition) continue;
      for (const field of block.fields) {
        if (!dropdowns.includes(field.name)) continue;
        const at = definition.indexOf(`'${field.name}'`);
        if (at < 0) continue;
        const slice = definition.slice(at, at + 3000);
        const options = [
          ...slice.matchAll(/:\s*'([^']+)'\s*\]/g),
          ...slice.matchAll(/,\s*'([^']+)'\s*\]/g),
        ].map(match => match[1]);
        if (!options.length) continue;
        assert.ok(
          options.includes(field.value.trim()),
          `${name}: ${block.type}.${field.name} = "${field.value.trim()}" is not one of ${[...new Set(options)].join(', ')}`
        );
      }
    }
  }
});

test('the Markov blocks the hedge gates on are wired end to end', () => {
  const hedge = BOT_XML['step-markov-hedge.xml'];
  for (const type of ['x_price_markov', 'x_price_markov_part', 'x_price_markov_report']) {
    assert.match(blockSource, new RegExp(`type:\\s*'${type}'`), `${type} is defined`);
    assert.ok(FACTORY.has(type), `${type} is a factory block with a readable label`);
  }
  // The bug that made this preset unloadable: the label described six inputs
  // and the block declared seven, and Blockly threw while loading. Pin the
  // exact shape so it cannot come back.
  const markov = FACTORY.get('x_price_markov');
  assert.equal(markov.args.length, 7);
  assert.equal([...markov.message.matchAll(/%(\d+)/g)].length, 7, 'the label names every one of the seven args');
  assert.deepEqual(
    [...markov.names],
    ['ORDER', 'HORIZON', 'MEMORY', 'PAYOUT', 'MIN_SAMPLES', 'MAX_TIE', 'LIST']
  );

  assert.match(hedge, /<block type="x_price_markov"/);
  assert.match(hedge, /<block type="x_price_markov_part"/);
  assert.match(hedge, /<block type="x_price_markov_report"/);
  for (const method of ['priceMarkov', 'priceMarkovPart', 'priceMarkovReport']) {
    assert.ok(runtimeMethods.has(method), `Bot.${method} is exposed by the runtime`);
  }
});

test('every Bot.* call in the block library has a runtime method', () => {
  const missing = [...botMethods].filter(method => !runtimeMethods.has(method));
  assert.deepEqual(missing, [], 'blocks calling a runtime method that does not exist fail at run time, silently');
});
