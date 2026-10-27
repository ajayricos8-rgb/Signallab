import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../utils';
import { signalLabColour } from './colour';

const families = [
    [localize('Rise/Fall'), 'rise-fall'],
    [localize('Over/Under'), 'over-under'],
    [localize('Even/Odd'), 'even-odd'],
    [localize('Matches'), 'matches'],
];

/**
 * A read-only gate for a single, measured Signal Lab analysis. It does not
 * create an order: the regular DBot Purchase block still owns execution. The
 * gate only stays true while the exact analysis snapshot, market and entry
 * window that produced the strategy remain valid.
 */
window.Blockly.Blocks.signal_lab_analysis_gate = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        const colour = signalLabColour();
        return {
            message0: localize('Signal Lab %1 analysis entry is valid for %2'),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'FAMILY',
                    options: families,
                },
                {
                    type: 'field_input',
                    name: 'SYMBOL',
                    text: 'R_100',
                },
            ],
            message1: localize('contract %1 barrier %2 target digit %3'),
            args1: [
                {
                    type: 'field_input',
                    name: 'CONTRACT_TYPE',
                    text: 'CALL',
                },
                {
                    type: 'field_number',
                    name: 'BARRIER',
                    value: 0,
                    min: 0,
                    max: 8,
                    precision: 1,
                },
                {
                    type: 'field_number',
                    name: 'TARGET_DIGIT',
                    value: 0,
                    min: 0,
                    max: 9,
                    precision: 1,
                },
            ],
            message2: localize('analysis key %1'),
            args2: [
                {
                    type: 'field_input',
                    name: 'ANALYSIS_ID',
                    text: '',
                },
            ],
            output: 'Boolean',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: colour.colour,
            colourSecondary: colour.colourSecondary,
            colourTertiary: colour.colourTertiary,
            tooltip: localize(
                'True only while the exact analyzed market and entry window are still fresh. Generated AI strategies combine it with their session profit and trade-count limits before the normal Purchase block can run.'
            ),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Signal Lab AI analysis gate'),
            description: localize(
                'Checks that the exact Signal Lab market analysis used to build this strategy is still fresh and its measured entry trigger is ready. It is an entry condition, not an order block.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_analysis_gate = block => {
    const family = block.getFieldValue('FAMILY') || 'rise-fall';
    const symbol = block.getFieldValue('SYMBOL') || 'R_100';
    const contractType = block.getFieldValue('CONTRACT_TYPE') || '';
    const barrier = Number(block.getFieldValue('BARRIER') || 0);
    const targetDigit = Number(block.getFieldValue('TARGET_DIGIT') || 0);
    const analysisId = block.getFieldValue('ANALYSIS_ID') || '';
    return [
        `Bot.getSignalLabAnalysisGate(${JSON.stringify(family)}, ${JSON.stringify(symbol)}, ${JSON.stringify(analysisId)}, ${JSON.stringify(contractType)}, ${barrier}, ${targetDigit})`,
        window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
    ];
};
