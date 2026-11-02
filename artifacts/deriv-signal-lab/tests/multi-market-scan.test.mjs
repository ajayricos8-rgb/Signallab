// Structural checks on the AI multi-market scan, for every bot that ships it.
//
// The requirement is one sentence: a bot with the scan reads *all* markets at
// the same moment and trades the most suitable one, without changing its
// trading logic, and never goes a minute without a trade. Those claims are
// wiring, so they are pinned here against every store preset that carries the
// scan — a regenerated preset cannot quietly ship without it.
//
// The Step Index Markov hedge is the one deliberate exception and is pinned by
// its own test at the bottom: it is a Step-index-only strategy (its decision
// mode refuses any other family), so a scan that could move it to R_100 would
// only park it. It spends the dwell and switch budget on cadence instead.
//
// What the scan must *not* do is as important: it may pick where the bot
// stands, it may not size a stake, choose a side or relax a money gate. The
// last test in this file checks the second switching path is gone, because two
// blocks writing `switchSymbol` is how a bot ends up fighting itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const BOTS = new URL('../src/lib/bot-store/bots/', import.meta.url);

const BOT_XMLS = [
    'ai-even-switcher.xml',
    'ai-vision-over-under.xml',
    'high-low-tick-sniper.xml',
    'rise-fall-ensemble.xml',
];

/**
 * The family each bot's scan must run. The scan uses the bot's *own* model, so
 * the ranking and the trade agree: an Even/Odd ensemble scores the digit
 * markets, the Vision brain scores Over/Under, the price ensemble scores the
 * directional families.
 */
const FAMILY = {
    'ai-even-switcher.xml': 'even-odd',
    'ai-vision-over-under.xml': 'over-under',
    'high-low-tick-sniper.xml': 'high-low-tick',
    'rise-fall-ensemble.xml': 'rise-fall',
};

/** The model block each bot decides with — the scan has to run before it. */
const DECISION = {
    'ai-even-switcher.xml': 'x_parity_decision',
    'ai-vision-over-under.xml': 'vision_analyse',
    'high-low-tick-sniper.xml': 'x_price_decision',
    'rise-fall-ensemble.xml': 'x_price_decision',
};

const read = name => readFile(new URL(name, BOTS), 'utf8');
const section = (xml, open, closes) => {
    const start = xml.indexOf(`<block type="${open}"`);
    if (start < 0) return '';
    const next = closes
        .map(type => xml.indexOf(`<block type="${type}"`, start + 1))
        .filter(index => index > 0)
        .sort((a, b) => a - b)[0];
    return xml.slice(start, next ?? xml.length);
};

const XML = Object.fromEntries(await Promise.all(BOT_XMLS.map(async name => [name, await read(name)])));

test('every bot scans every market with its own model', () => {
    for (const name of BOT_XMLS) {
        const xml = XML[name];
        assert.equal((xml.match(/type="x_market_scan"/g) ?? []).length, 1, `${name}: one scan per cycle`);
        assert.match(xml, new RegExp(`<field name="FAMILY">${FAMILY[name]}</field>`), `${name}: the scan runs the ${FAMILY[name]} model`);
        assert.equal((xml.match(/type="x_scan_switch_best"/g) ?? []).length, 1, `${name}: one switch, from the scan`);
        assert.match(xml, /type="variables_set"[^>]*>\s*<field name="VAR"[^>]*>ai market</, `${name}: the chosen market is recorded`);
    }
});

test('the scan runs at the top of the cycle, before the decision is taken', () => {
    for (const name of BOT_XMLS) {
        const xml = XML[name];
        const tick = section(xml, 'tick_analysis', ['before_purchase', 'after_purchase', 'during_purchase']);
        assert.ok(tick, `${name}: has a tick section`);
        const scanAt = tick.indexOf('x_market_scan');
        const switchAt = tick.indexOf('x_scan_switch_best');
        const decisionAt = tick.indexOf(DECISION[name]);
        assert.ok(scanAt > 0, `${name}: the scan is in the tick section`);
        assert.ok(switchAt > scanAt, `${name}: the winner is taken after the ranking`);
        assert.ok(decisionAt > switchAt, `${name}: the decision reads the market the scan chose`);
        // The scan is the first statement of the cycle, not something bolted on
        // after the gate that can skip the tick.
        const stack = tick.slice(tick.indexOf('TICKANALYSIS_STACK'));
        const firstBlock = stack.match(/<block type="([^"]+)"/)?.at(1);
        assert.equal(firstBlock, 'x_market_scan', `${name}: the scan is the cycle's first statement`);
    }
});

test('the scan knobs ship, and they are editable', () => {
    // Two authoring styles ship: the generated presets set a knob with a
    // `math_number` block, the hand-authored Vision preset with a shadow.
    const knob = (xml, name, value) =>
        new RegExp(`VAR"[^>]*>${name}</field>\\s*<value name="VALUE">\\s*<(?:block|shadow) type="math_number"[^>]*>\\s*<field name="NUM">${value}</field>`).test(xml);
    for (const name of BOT_XMLS) {
        const xml = XML[name];
        for (const [knobName, value] of [
            ['ai scan every', '8'],
            ['ai scan floor', '25'],
            ['ai scan margin', '3'],
            ['ai scan dwell', '25'],
            ['ai cadence', '60'],
        ]) {
            assert.ok(knob(xml, knobName, value), `${name}: knob ${knobName} ships as ${value}`);
        }
    }
});

test('at least one entry a minute is ORed into the entry gate, and keeps every money gate', () => {
    for (const name of BOT_XMLS) {
        const xml = XML[name];
        const before = section(xml, 'before_purchase', ['after_purchase', 'during_purchase']);
        assert.equal((xml.match(/type="x_trade_due"/g) ?? []).length, 1, `${name}: one cadence clock`);
        const dueAt = before.indexOf('x_trade_due');
        assert.ok(dueAt > 0, `${name}: the cadence reaches the purchase conditions`);
        assert.match(before, />ai cadence</, `${name}: the clock reads its own knob`);
        // The cadence is the second arm of an OR: quality gates on one side,
        // the once-a-minute override on the other.
        assert.match(before, /<field name="OP">OR<\/field>/, `${name}: the cadence is ORed in`);
        const branch = before.slice(dueAt);
        const money = /x_price_risk|x_parity_risk|r_loss_guard|r_profit_guard|r_drawdown_ok|r_loss_streak/;
        assert.match(branch, money, `${name}: the cadence branch keeps the money gates`);
    }
});

test('one switching path: the retired one-market scout is gone everywhere', () => {
    for (const name of BOT_XMLS) {
        const xml = XML[name];
        for (const retired of ['x_price_auto_market', 'x_parity_auto_market', 'vision_auto_market']) {
            assert.ok(!xml.includes(retired), `${name}: ${retired} would fight the scan over the symbol`);
        }
    }
});

test('the scan never trades: every bot still owns its purchase', () => {
    for (const name of BOT_XMLS) {
        const xml = XML[name];
        assert.match(xml, /type="purchase"|type="hedge_purchase"|type="x_tick_decision_purchase"/, `${name}: the strategy still buys`);
        assert.match(xml, /type="trade_again"/, `${name}: the cycle still restarts`);
    }
});

test('the Step Index Markov hedge is pinned to its market and says so', async () => {
    const xml = await readFile(new URL('step-markov-hedge.xml', BOTS), 'utf8');
    // One market, one chain, no scan: a switch would cost the dwell and the
    // switch itself, and `step-hedge` refuses any family but Step index.
    assert.ok(!xml.includes('x_market_scan'), 'no scan: the bot stays on Step index');
    assert.ok(!xml.includes('x_scan_switch_best'), 'no market switching');
    assert.match(xml, /<field name="SYMBOL_LIST">stpRNG<\/field>/);
    assert.match(xml, /<field name="MODE">step-hedge<\/field>/);
    // It still owns its purchase and its cycle, exactly like the others.
    assert.match(xml, /type="hedge_purchase"/);
    assert.match(xml, /type="trade_again"/);
});
