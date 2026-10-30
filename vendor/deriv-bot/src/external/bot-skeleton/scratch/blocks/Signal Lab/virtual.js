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

const directionField = () => ({
    type: 'field_dropdown',
    name: 'DIRECTION',
    options: [
        [localize('Rise'), 'rise'],
        [localize('Fall'), 'fall'],
        [localize('Over'), 'over'],
        [localize('Under'), 'under'],
        [localize('Even'), 'even'],
        [localize('Odd'), 'odd'],
        [localize('Match digit'), 'match'],
    ],
});

window.Blockly.Blocks.signal_lab_virtual_buy = {
    init() {
        this.jsonInit({
            message0: localize('Open a virtual %1 on %2 · stake %3 · payout %4 · barrier %5'),
            args0: [
                directionField(),
                marketField(),
                { type: 'input_value', name: 'STAKE', check: 'Number' },
                { type: 'input_value', name: 'PAYOUT', check: 'Number' },
                { type: 'input_value', name: 'BARRIER', check: 'Number' },
            ],
            inputsInline: true,
            previousStatement: null,
            nextStatement: null,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize(
                'Paper trade only: it records a position at the live quote and never sends an order. Settle it with the virtual settle block.'
            ),
            category: window.Blockly.Categories.SignalLab_Virtual,
        });
    },
    meta() {
        return {
            display_name: localize('Virtual trade'),
            description: localize('Opens a paper position at the live quote so a strategy can rehearse a trade without placing an order.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_virtual_buy = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const symbol = block.getFieldValue('MARKET_LIST');
    const direction = block.getFieldValue('DIRECTION');
    const stake = generator.valueToCode(block, 'STAKE', generator.ORDER_ATOMIC) || '1';
    const payout = generator.valueToCode(block, 'PAYOUT', generator.ORDER_ATOMIC) || '1.9';
    const barrier = generator.valueToCode(block, 'BARRIER', generator.ORDER_ATOMIC) || '5';
    // Statement block: return a code string, not a [code, order] tuple.
    return `Bot.signalLabVirtualBuy(${JSON.stringify(symbol)}, ${JSON.stringify(direction)}, ${stake}, ${payout}, ${barrier});\n`;
};

window.Blockly.Blocks.signal_lab_virtual_settle = {
    init() {
        this.jsonInit({
            message0: localize('Settle every open virtual position at the latest tick'),
            previousStatement: null,
            nextStatement: null,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('Resolves each open virtual position against the latest quote or digit and books the win or loss.'),
            category: window.Blockly.Categories.SignalLab_Virtual,
        });
    },
    meta() {
        return {
            display_name: localize('Settle virtual positions'),
            description: localize('Closes every open virtual position at the latest tick and updates the virtual ledger.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_virtual_settle = () =>
    'Bot.signalLabVirtualSettle();\n';

window.Blockly.Blocks.signal_lab_virtual_reset = {
    init() {
        this.jsonInit({
            message0: localize('Reset the virtual ledger'),
            previousStatement: null,
            nextStatement: null,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('Clears every virtual position and restarts the virtual balance at 10,000.'),
            category: window.Blockly.Categories.SignalLab_Virtual,
        });
    },
    meta() {
        return {
            display_name: localize('Reset virtual ledger'),
            description: localize('Clears the virtual ledger and restarts the virtual balance.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_virtual_reset = () =>
    'Bot.signalLabVirtualReset();\n';

window.Blockly.Blocks.signal_lab_virtual_profit = {
    init() {
        this.jsonInit({
            message0: localize('Virtual realised profit'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('The profit or loss the virtual trades have booked so far.'),
            category: window.Blockly.Categories.SignalLab_Virtual,
        });
    },
    meta() {
        return {
            display_name: localize('Virtual profit'),
            description: localize('The realised profit of the virtual trades settled so far.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_virtual_profit = () => [
    'Bot.signalLabVirtualProfit()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_virtual_runs = {
    init() {
        this.jsonInit({
            message0: localize('Virtual trades settled'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('How many virtual positions have been settled.'),
            category: window.Blockly.Categories.SignalLab_Virtual,
        });
    },
    meta() {
        return {
            display_name: localize('Virtual trade count'),
            description: localize('How many virtual trades have been settled.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_virtual_runs = () => [
    'Bot.signalLabVirtualRuns()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_virtual_wins = {
    init() {
        this.jsonInit({
            message0: localize('Virtual trades won'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('How many settled virtual trades won.'),
            category: window.Blockly.Categories.SignalLab_Virtual,
        });
    },
    meta() {
        return {
            display_name: localize('Virtual wins'),
            description: localize('How many virtual trades have won.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_virtual_wins = () => [
    'Bot.signalLabVirtualWins()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_virtual_open = {
    init() {
        this.jsonInit({
            message0: localize('Virtual positions still open'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('How many virtual positions have been opened but not settled yet.'),
            category: window.Blockly.Categories.SignalLab_Virtual,
        });
    },
    meta() {
        return {
            display_name: localize('Virtual open positions'),
            description: localize('How many virtual positions are open and waiting to be settled.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_virtual_open = () => [
    'Bot.signalLabVirtualOpen()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_virtual_balance = {
    init() {
        this.jsonInit({
            message0: localize('Virtual balance'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('The virtual starting balance plus every settled virtual profit and loss.'),
            category: window.Blockly.Categories.SignalLab_Virtual,
        });
    },
    meta() {
        return {
            display_name: localize('Virtual balance'),
            description: localize('The virtual balance: the starting balance plus the settled virtual P/L.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_virtual_balance = () => [
    'Bot.signalLabVirtualBalance()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
