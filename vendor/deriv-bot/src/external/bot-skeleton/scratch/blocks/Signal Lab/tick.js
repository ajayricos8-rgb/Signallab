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

window.Blockly.Blocks.signal_lab_last_tick = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab last tick of %1'),
            args0: [marketField()],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize(
                'The latest quote Signal Lab collected for this market. Signal Lab loads 2,000 ticks per market when it opens.'
            ),
            category: window.Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab last tick'),
            description: localize('This block gives you the last tick Signal Lab collected for any market it follows.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_last_tick = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return [
        `Bot.getSignalLabLastTick(${JSON.stringify(symbol)})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};
