import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../utils';
import { signalLabColour } from './colour';

// Account-side blocks read the same account Signal Lab trades. They are
// read-only: the strategy still buys and sells with the normal DBot blocks on
// its own authenticated socket for that account.
window.Blockly.Blocks.signal_lab_balance = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab balance'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize('The balance Signal Lab reports for the connected account, in its own currency.'),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab balance'),
            description: localize(
                'This block gives you the balance of the account Signal Lab is connected to. DBot trades the same account.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_balance = () => [
    'Bot.getSignalLabBalance()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_open_positions = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab open positions'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize(
                'How many contracts Signal Lab currently has open, including contracts opened by its own bots or by hand.'
            ),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab open positions'),
            description: localize(
                'This block counts the open contracts Signal Lab is holding on the connected account.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_open_positions = () => [
    'Bot.getSignalLabOpenPositions()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_profit = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab realised profit'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize('Profit from the last 50 settled trades as Signal Lab reports them.'),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab realised profit'),
            description: localize(
                'This block gives you the profit Signal Lab has already banked on the connected account.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_profit = () => [
    'Bot.getSignalLabRealisedProfit()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_account = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab account'),
            output: 'String',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize('The account ID Signal Lab is connected to and has shared with DBot.'),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab account'),
            description: localize('This block gives you the connected account ID, e.g. VRTC123456.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_account = () => [
    'Bot.getSignalLabAccountId()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_connected = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab is connected'),
            output: 'Boolean',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize(
                'True when Signal Lab has sent its first market snapshot to this workspace, so the Signal Lab blocks have data to read.'
            ),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab is connected'),
            description: localize(
                'This block is true when Signal Lab has shared its market data with this workspace, so a strategy can wait for it instead of trading blind.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_connected = () => [
    'Bot.isSignalLabConnected()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
