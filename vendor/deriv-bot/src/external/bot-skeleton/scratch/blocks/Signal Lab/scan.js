import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../utils';
import { getSignalLabMarketOptions } from '@/services/signallab-feed';
import { signalLabColour } from './colour';

// A market dropdown shared by every Signal Lab block. The options are the
// markets Signal Lab has actually collected ticks for, with the volatility
// indices as a static fallback before the first snapshot arrives.
const marketField = () => ({
    type: 'field_dropdown',
    name: 'MARKET_LIST',
    options: () => getSignalLabMarketOptions(),
});

const familyField = () => ({
    type: 'field_dropdown',
    name: 'FAMILY',
    options: [
        [localize('Rise / Fall'), 'rise-fall'],
        [localize('Over / Under'), 'over-under'],
        [localize('Even / Odd'), 'even-odd'],
        [localize('Matches'), 'matches'],
    ],
});

const scanBlock = (block, args) => ({
    message0: localize('Scan every Signal Lab market for %1 over the last %2 ticks, floor %3'),
    args0: [
        familyField(),
        { type: 'input_value', name: 'DURATION', check: 'Number' },
        { type: 'input_value', name: 'MIN_SCORE', check: 'Number' },
    ],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: block.colour,
    colourSecondary: block.colourSecondary,
    colourTertiary: block.colourTertiary,
    tooltip: localize(
        'Scores every market Signal Lab shared and remembers the strongest one. Runs on the tick cache, so it never opens a socket and never places an order.'
    ),
    category: window.Blockly.Categories.SignalLab_Scan,
    ...args,
});

window.Blockly.Blocks.signal_lab_switch_market = {
    init() {
        this.jsonInit({
            message0: localize('Switch market to %1'),
            args0: [marketField()],
            // Unchecked connections on purpose: a checked ('signal_lab_block')
            // connector cannot stack with ordinary statement blocks, so the
            // block could never be placed inside Purchase conditions at all
            // and silently never ran.
            previousStatement: null,
            nextStatement: null,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('Move the running bot to another market, e.g. the market an all-markets scan picked.'),
            category: window.Blockly.Categories.SignalLab_Scan,
        });
    },
    meta() {
        return {
            display_name: localize('Switch market'),
            description: localize('Moves the running bot to another market and resubscribes its tick stream, so a scan can trade the market it picked.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

// Statement generators return a plain code string, like every Deriv
// statement block. Returning a [code, order] tuple is the value-block shape;
// several generators in this group used it, which could corrupt or abort code
// generation for the whole workspace — the bot then "ran" without ever
// reaching a Purchase block.
window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_switch_market = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return `Bot.signalLabSwitchMarket(${JSON.stringify(symbol)});\n`;
};

window.Blockly.Blocks.signal_lab_switch_to_best = {
    init() {
        this.jsonInit({
            message0: localize('Switch to the best market from the last scan'),
            previousStatement: null,
            nextStatement: null,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('Move the running bot to the market the last all-markets scan scored strongest, so the next Purchase trades that market. Does nothing until a scan has run.'),
            category: window.Blockly.Categories.SignalLab_Scan,
        });
    },
    meta() {
        return {
            display_name: localize('Switch to scan best market'),
            description: localize('Moves the running bot to the strongest market from the last all-markets scan and resubscribes its tick stream.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_switch_to_best = () =>
    'Bot.signalLabSwitchToBest();\n';

window.Blockly.Blocks.signal_lab_scan_markets = {
    init() {
        this.jsonInit(scanBlock(signalLabColour(), {}));
    },
    meta() {
        return {
            display_name: localize('Scan all markets'),
            description: localize(
                'Scores every market Signal Lab is streaming with the same one-line statistic and keeps the market with the strongest measured lean. Read the winner and its score with the scan blocks below.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_scan_markets = block => {
    const family = block.getFieldValue('FAMILY');
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const duration = generator.valueToCode(block, 'DURATION', generator.ORDER_ATOMIC) || '20';
    const minScore = generator.valueToCode(block, 'MIN_SCORE', generator.ORDER_ATOMIC) || '0.05';
    return `Bot.signalLabScanMarkets(${JSON.stringify(family)}, ${duration}, ${minScore});\n`;
};

window.Blockly.Blocks.signal_lab_scan_best = {
    init() {
        this.jsonInit({
            message0: localize('Best market from the last scan'),
            output: 'String',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('The market symbol with the strongest measured lean in the last all-markets scan.'),
            category: window.Blockly.Categories.SignalLab_Scan,
        });
    },
    meta() {
        return {
            display_name: localize('Scan best market'),
            description: localize('The market the last all-markets scan scored highest, e.g. R_100.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_scan_best = () => [
    'Bot.signalLabScanBest()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_scan_score = {
    init() {
        this.jsonInit({
            message0: localize('Scan score of %1'),
            args0: [marketField()],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('The signed lean the last scan measured for this market, from -1 to 1.'),
            category: window.Blockly.Categories.SignalLab_Scan,
        });
    },
    meta() {
        return {
            display_name: localize('Scan market score'),
            description: localize('The signed lean the last all-markets scan measured for one market.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_scan_score = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return [
        `Bot.signalLabScanScore(${JSON.stringify(symbol)})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};

window.Blockly.Blocks.signal_lab_scan_rank = {
    init() {
        this.jsonInit({
            message0: localize('Scan rank of %1 (1 is the best)'),
            args0: [marketField()],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('Where this market finished in the last scan: 1 is the strongest lean, 0 means it was not scanned.'),
            category: window.Blockly.Categories.SignalLab_Scan,
        });
    },
    meta() {
        return {
            display_name: localize('Scan market rank'),
            description: localize('The position of one market in the last all-markets scan.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_scan_rank = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return [
        `Bot.signalLabScanRank(${JSON.stringify(symbol)})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};

window.Blockly.Blocks.signal_lab_scan_count = {
    init() {
        this.jsonInit({
            message0: localize('Markets scored by the last scan'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('How many markets the last all-markets scan had enough ticks to score.'),
            category: window.Blockly.Categories.SignalLab_Scan,
        });
    },
    meta() {
        return {
            display_name: localize('Scan market count'),
            description: localize('How many markets the last all-markets scan scored.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_scan_count = () => [
    'Bot.signalLabScanCount()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_scan_tradeable = {
    init() {
        this.jsonInit({
            message0: localize('Best scan market cleared its floor'),
            output: 'Boolean',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('True when the strongest market in the last scan is at least as strong as the floor you set.'),
            category: window.Blockly.Categories.SignalLab_Scan,
        });
    },
    meta() {
        return {
            display_name: localize('Scan tradeable'),
            description: localize('Whether the best market from the last all-markets scan cleared the score floor.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_scan_tradeable = () => [
    'Bot.signalLabScanTradeable()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
