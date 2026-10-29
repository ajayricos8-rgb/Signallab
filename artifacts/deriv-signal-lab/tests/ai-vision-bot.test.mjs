// Structural checks on the shipped AI Vision bot.
//
// The bot is a strategy file, so the things that stop it trading are wiring
// mistakes, not maths: a missing AI read in the tick block, an entry gate that
// can never be true, trade options built from a prediction that the purchase
// conditions never refresh. These assertions pin that wiring down without a
// browser, so a future edit cannot quietly ship a bot that analyses everything
// and opens nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const XML_PATH = new URL('../src/lib/bot-store/bots/ai-vision-over-under.xml', import.meta.url);
const XML = await readFile(XML_PATH, 'utf8');

/** Every <block type="..."> in the file, with the field/value names under it. */
function blocks(xml) {
    const found = [];
    const blockPattern = /<block type="([^"]+)"([^>]*)>([\s\S]*?)<\/block>/g;
    // Flat scan is enough: block tags never nest on the same line in this file
    // beyond what the regex needs, and we only read the immediate attributes.
    for (const match of xml.matchAll(/<block type="([^"]+)"/g)) {
        found.push({ type: match[1], index: match.index });
    }
    const types = found.map(block => block.type);
    const has = type => types.includes(type);
    /** The slice of XML that belongs to one root block. */
    const section = (rootType, nextTypes) => {
        const start = xml.indexOf(`<block type="${rootType}"`);
        if (start < 0) return '';
        const following = nextTypes
            .map(type => xml.indexOf(`<block type="${type}"`, start + 1))
            .filter(index => index > 0)
            .sort((a, b) => a - b)[0];
        return xml.slice(start, following ?? xml.length);
    };
    return { types, has, section, blockPattern };
}

const { types, has, section } = blocks(XML);

test('the bot is a complete DBot program', () => {
    ['trade_definition', 'trade_definition_market', 'trade_definition_tradetype', 'trade_definition_tradeoptions',
        'tick_analysis', 'before_purchase', 'after_purchase'].forEach(type => {
        assert.ok(has(type), `missing mandatory block ${type}`);
    });
    assert.ok(types.includes('purchase'), 'there is a purchase block to fire');
    assert.ok(types.includes('trade_again'), 'the bot restarts its cycle after a settlement');
});

test('every tick reads the market before anything else', () => {
    const tick = section('tick_analysis', ['before_purchase', 'after_purchase', 'during_purchase']);
    assert.match(tick, /vision_analyse/, 'the AI read runs on every tick');
    assert.match(tick, /vision_auto_market/, 'the market choice runs before the read');
    const readAt = tick.indexOf('vision_analyse');
    const marketAt = tick.indexOf('vision_auto_market');
    assert.ok(marketAt < readAt, 'the market is chosen before it is read');
});

test('the trade options are built from the AI decision, never a fixed digit', () => {
    const options = XML.slice(XML.indexOf('trade_definition_tradeoptions'));
    assert.match(options, /<value name="PREDICTION">[\s\S]*?vision_barrier/, 'the prediction is the AI barrier');
    assert.match(options, /vision_stake/, 'the stake comes from the AI sizing');
    assert.match(options, /<field name="DURATIONTYPE_LIST">t</, 'contracts settle in ticks');
});

test('the entry gate can actually open: AI verdict, pace and risk guards', () => {
    const before = section('before_purchase', ['after_purchase', 'during_purchase']);
    assert.match(before, /vision_go/, 'the AI verdict gates the entry');
    assert.match(before, /vision_entry_ready/, 'the pace control gates the entry');
    assert.match(before, /r_loss_guard/, 'the loss limit still applies');
    assert.match(before, /r_profit_guard/, 'the profit target still applies');
    assert.match(before, /vision_mark_entry/, 'the pace control is told when a position opened');
    const markAt = before.indexOf('vision_mark_entry');
    const buyAt = before.indexOf('<field name="PURCHASE_LIST">DIGITOVER');
    assert.ok(markAt > 0 && markAt < buyAt, 'a position is marked before it is bought');
    // A stale guard that can never be true would silently disable every entry.
    assert.doesNotMatch(before, /r_cooldown/, 'the pace control replaced the old cooldown guard');
});

test('the shipped tuning is evidence-gated and skips weak or negative-edge setups', () => {
    for (const [variable, name, value] of [
        ['aiVar03', 'ai min edge', '0.5'],
        ['aiVar04', 'ai min lean', '1.5'],
        ['aiVar05', 'ai min confidence', '55'],
        ['aiVar06', 'ai agreement', '0.7'],
    ]) {
        assert.ok(XML.includes(`id="${variable}">${name}</field>`), `${name} variable is declared`);
        const input = variable.replace('aiVar', 'in');
        assert.ok(XML.includes(`id="${input}"><field name="NUM">${value}</field>`), `${name} default is ${value}`);
    }
    assert.match(XML, /ai multiplier<\/field>[\s\S]*?id="in16"><field name="NUM">1<\/field>/, 'flat staking is the default');
    assert.match(XML, /weak signals are skipped/);
    assert.ok(XML.includes('id="in07"><field name="NUM">0.2</field>'), 'fractional risk is conservative by default');
});

test('the market block cannot strand the bot on a market it cannot read', () => {
    // The dwell has to be long enough to read a market after switching to it.
    const dwell = XML.match(/id="aiVar13">ai market dwell<\/field><value name="VALUE"><shadow type="math_number" id="in13"><field name="NUM">(\d+)/);
    assert.ok(dwell, 'the dwell variable is set in the start block');
    assert.ok(Number(dwell[1]) >= 5, `a ${dwell[1]}s dwell re-subscribes faster than a market can be read`);
    assert.match(XML, /<field name="MODE">suitable<\/field>/, 'it stays where it scores well');
});

test('learning happens on every settled contract', () => {
    const after = section('after_purchase', ['during_purchase', 'tick_analysis']);
    assert.match(after, /vision_learn/, 'the settled digit is fed back into the brain');
    const learnAt = after.indexOf('vision_learn');
    const waitAt = after.indexOf('vision_wait_entry');
    const againAt = after.indexOf('trade_again');
    assert.ok(learnAt < waitAt && waitAt < againAt, 'it learns, waits for the pace, then restarts');
});
