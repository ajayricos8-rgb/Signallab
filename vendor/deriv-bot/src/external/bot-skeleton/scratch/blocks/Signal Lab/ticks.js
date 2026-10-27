import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../utils';
import { getSignalLabMarketOptions } from '@/services/signallab-feed';
import { signalLabColour } from './colour';

const marketField = () => ({
    type: 'field_dropdown',
    name: 'MARKET_LIST',
    options: () => getSignalLabMarketOptions(),
});

window.Blockly.Blocks.signal_lab_ticks = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab tick list of %1'),
            args0: [marketField()],
            output: 'Array',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize(
                'The last 1,000 tick values Signal Lab collected for this market, oldest first.'
            ),
            category: window.Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab tick list'),
            description: localize(
                'This block gives you the ticks Signal Lab collected for a market, so your strategy can analyse markets other than the one it trades.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_ticks = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return [
        `Bot.getSignalLabTicks(${JSON.stringify(symbol)})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};

window.Blockly.Blocks.signal_lab_last_digit = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab last digit of %1'),
            args0: [marketField()],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize('The last digit of the latest tick Signal Lab collected for this market.'),
            category: window.Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab last digit'),
            description: localize('This block gives you the last digit of a Signal Lab tick.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_last_digit = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return [
        `Bot.getSignalLabLastDigit(${JSON.stringify(symbol)})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};

window.Blockly.Blocks.signal_lab_tick_change = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab change of %1 over the last %2 ticks'),
            args0: [
                marketField(),
                {
                    type: 'input_value',
                    name: 'TICKS',
                    check: 'Number',
                },
            ],
            inputsInline: true,
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize(
                'The newest quote minus the quote that many ticks back. Positive means the market rose over that window.'
            ),
            category: window.Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab market change'),
            description: localize(
                'This block measures how far a market moved across a number of ticks using the data Signal Lab collected.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_tick_change = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    const ticks =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'TICKS',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || '1';
    return [
        `Bot.getSignalLabTickChange(${JSON.stringify(symbol)}, ${ticks})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};
