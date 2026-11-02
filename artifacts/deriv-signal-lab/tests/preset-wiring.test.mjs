/**
 * Wiring guard for the shipped store presets.
 *
 * A preset is XML that names blocks by string. Nothing about a typo, a retired
 * block or a `Bot.*` call that was never implemented fails until the strategy is
 * loaded in a browser — and by then it fails as "the bot does nothing", which is
 * the most expensive kind of bug to find. This test closes that gap statically:
 *
 *   1. every `<block type="…">` a shipped preset uses must exist in the vendored
 *      block library;
 *   2. every dropdown value the preset writes into a `field` must be one the
 *      block actually offers (Blockly silently drops the rest);
 *   3. every `Bot.*` call those blocks generate must exist in the runtime
 *      interfaces, because the interpreter routes `Bot.x` straight through.
 *
 * It reads the source, not a running workspace, so it is fast enough to run on
 * every change.
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

/** Every block type in a preset. */
const blockTypes = xml => new Set([...xml.matchAll(/<block type="([^"]+)"/g)].map(match => match[1]).filter(Boolean));

/** Is this block type declared somewhere in the vendored library? */
const blockExists = type => new RegExp(`type:\\s*'${type}'|Blocks\\.${type}\\s*=`).test(blockSource);

/** The source of one block definition, sliced up to the next definition. */
function blockSlice(type) {
  const patterns = [`type: '${type}'`, `Blocks.${type} =`];
  for (const pattern of patterns) {
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
 * The dropdown options a block offers for one field, read from its
 * `dropdown('NAME', [[label, value], …])` declaration. Only literals are
 * supported — every shipped dropdown is literal, and a non-literal one is
 * skipped rather than guessed at.
 */
function dropdownOptions(definition, field) {
  const at = definition.indexOf(`'${field}'`);
  if (at < 0) return null;
  const slice = definition.slice(at, at + 3000);
  const values = [
    ...slice.matchAll(/:\s*'([^']+)'\s*\]/g),
    ...slice.matchAll(/,\s*'([^']+)'\s*\]/g),
  ].map(match => match[1]);
  return values.length ? new Set(values) : null;
}

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

test('every shipped preset uses blocks the library defines', () => {
  for (const [name, xml] of Object.entries(BOT_XML)) {
    const missing = [...blockTypes(xml)].filter(type => !blockExists(type));
    assert.deepEqual(missing, [], `${name}: unknown block types`);
  }
});

test('every field value a preset writes is a value the block offers', () => {
  for (const [name, xml] of Object.entries(BOT_XML)) {
    for (const match of xml.matchAll(/<block type="([^"]+)"([^>]*)>([\s\S]*?)<\/block>/g)) {
      const [, type, , body] = match;
      const definition = blockSlice(type);
      if (!definition) continue;
      for (const field of body.matchAll(/<field name="([^"]+)">([^<]*)<\/field>/g)) {
        const [, fieldName, value] = field;
        // Only dropdowns matter; number and text fields are free-form.
        if (!['PART', 'MODE', 'REQUIRE', 'CHECK_RESULT'].includes(fieldName)) continue;
        const options = dropdownOptions(definition, fieldName);
        if (!options) continue;
        assert.ok(
          options.has(value),
          `${name}: ${type}.${fieldName} = "${value}" is not one of ${[...options].join(', ')}`
        );
      }
    }
  }
});

test('the Markov blocks the hedge gates on are wired end to end', () => {
  const hedge = BOT_XML['step-markov-hedge.xml'];
  // Block definitions exist…
  for (const type of ['x_price_markov', 'x_price_markov_part', 'x_price_markov_report']) {
    assert.match(blockSource, new RegExp(`type:\\s*'${type}'`), `${type} is defined`);
  }
  // …the preset uses them…
  assert.match(hedge, /<block type="x_price_markov"/);
  assert.match(hedge, /<block type="x_price_markov_part"/);
  assert.match(hedge, /<block type="x_price_markov_report"/);
  // …and the runtime answers every call the blocks generate.
  for (const method of ['priceMarkov', 'priceMarkovPart', 'priceMarkovReport']) {
    assert.ok(runtimeMethods.has(method), `Bot.${method} is exposed by the runtime`);
  }
});

test('every Bot.* call in the block library has a runtime method', () => {
  const missing = [...botMethods].filter(method => !runtimeMethods.has(method));
  assert.deepEqual(missing, [], 'blocks calling a runtime method that does not exist fail at run time, silently');
});
