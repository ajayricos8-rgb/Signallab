import { localize } from '@deriv-com/translations';
import { signalLabColour } from './colour';

// Used in After Purchase, immediately before the script ends without Trade again.
window.Blockly.Blocks.signal_lab_session_stop = {
    init() {
        this.jsonInit({
            message0: localize('Session limit %1 reached · profit/loss %2'),
            args0: [
                { type: 'field_dropdown', name: 'REASON', options: [['Take profit', 'take-profit'], ['Stop loss', 'stop-loss']] },
                { type: 'input_value', name: 'PROFIT', check: 'Number' },
            ],
            previousStatement: null,
            nextStatement: null,
            colour: signalLabColour().colour,
            category: window.Blockly.Categories.Miscellaneous,
            tooltip: localize('Report the session result. Do not connect Trade again when the limit has been reached.'),
        });
    },
    meta() {
        return { display_name: 'Session limit notification', description: 'Reports the session result before ending the strategy.' };
    },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_session_stop = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const profit = generator.valueToCode(block, 'PROFIT', generator.ORDER_NONE) || '0';
    return `Bot.signalLabNotifySessionStop(${JSON.stringify(block.getFieldValue('REASON'))}, ${profit});\n`;
};

window.Blockly.Blocks.signal_lab_session_start = {
    init() {
        this.jsonInit({ message0: 'Start a new Signal Lab session', previousStatement: null, nextStatement: null,
            colour: signalLabColour().colour, category: window.Blockly.Categories.Miscellaneous });
    },
    meta() { return { display_name: 'Start session accounting', description: 'Resets the session profit and trade count at the start of this strategy.' }; },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.signal_lab_session_start = () => 'Bot.signalLabStartSession();\n';

for (const [type, label, method] of [
    ['signal_lab_session_profit', 'Session profit/loss', 'signalLabSessionProfit'],
    ['signal_lab_session_runs', 'Session trades', 'signalLabSessionRuns'],
]) {
    window.Blockly.Blocks[type] = {
        init() { this.jsonInit({ message0: label, output: 'Number', colour: signalLabColour().colour, category: window.Blockly.Categories.Miscellaneous }); },
        meta() { return { display_name: label, description: 'The current Signal Lab strategy session only.' }; },
    };
    window.Blockly.JavaScript.javascriptGenerator.forBlock[type] = () => [`Bot.${method}()`, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
}
