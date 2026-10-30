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

window.Blockly.Blocks.signal_lab_hedge_legs = {
    init() {
        this.jsonInit({
            message0: localize('Open hedge legs on %1'),
            args0: [marketField()],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('How many contracts Signal Lab currently has open on this market.'),
            category: window.Blockly.Categories.SignalLab_Hedge,
        });
    },
    meta() {
        return {
            display_name: localize('Hedge open legs'),
            description: localize('Counts the open contracts on one market. A hedge is balanced when this is even.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_hedge_legs = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return [
        `Bot.signalLabHedgeLegs(${JSON.stringify(symbol)})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};

window.Blockly.Blocks.signal_lab_hedge_pairs = {
    init() {
        this.jsonInit({
            message0: localize('Hedge pairs on %1'),
            args0: [marketField()],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('Half the open legs on this market: the number of complete hedge pairs.'),
            category: window.Blockly.Categories.SignalLab_Hedge,
        });
    },
    meta() {
        return {
            display_name: localize('Hedge pairs'),
            description: localize('How many complete hedge pairs are open on one market.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_hedge_pairs = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return [
        `Bot.signalLabHedgePairs(${JSON.stringify(symbol)})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};

window.Blockly.Blocks.signal_lab_hedge_balanced = {
    init() {
        this.jsonInit({
            message0: localize('Hedge on %1 is balanced'),
            args0: [marketField()],
            output: 'Boolean',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('True when every open contract on this market is paired into a hedge.'),
            category: window.Blockly.Categories.SignalLab_Hedge,
        });
    },
    meta() {
        return {
            display_name: localize('Hedge balanced'),
            description: localize('Whether the open contracts on one market form complete hedge pairs.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_hedge_balanced = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return [
        `Bot.signalLabHedgeBalanced(${JSON.stringify(symbol)})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};

window.Blockly.Blocks.signal_lab_hedge_count = {
    init() {
        this.jsonInit({
            message0: localize('Open positions across every market'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('How many contracts Signal Lab has open on the account, on every market.'),
            category: window.Blockly.Categories.SignalLab_Hedge,
        });
    },
    meta() {
        return {
            display_name: localize('Hedge open count'),
            description: localize('The total number of open contracts on the connected account.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_hedge_count = () => [
    'Bot.signalLabHedgeCount()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.signal_lab_hedge_profit = {
    init() {
        this.jsonInit({
            message0: localize('Unrealised profit of the open hedge'),
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: signalLabColour().colour,
            colourSecondary: signalLabColour().colourSecondary,
            colourTertiary: signalLabColour().colourTertiary,
            tooltip: localize('The live profit of every open contract Signal Lab reports, hedged or not.'),
            category: window.Blockly.Categories.SignalLab_Hedge,
        });
    },
    meta() {
        return {
            display_name: localize('Hedge open profit'),
            description: localize('The unrealised profit of the open positions on the connected account.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_hedge_profit = () => [
    'Bot.signalLabHedgeProfit()',
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
