import { localize } from '@deriv-com/translations';
import { getContractTypeOptions } from '../../../shared';
import { excludeOptionFromContextMenu, modifyContextMenu } from '../../../utils';

/**
 * The Purchase block, doubled: it buys the main contract AND the opposite
 * contract in the same pass, so both sides of a hedge are open at the same
 * time. The first contract uses the stake from Trade options; the second
 * uses its own stake input (0 = same stake as the first). After purchase
 * runs only once both legs have settled.
 */
window.Blockly.Blocks.hedge_purchase = {
    init() {
        this.jsonInit(this.definition());

        // Ensure one of this type per statement-stack (same rule as Purchase)
        this.setNextStatement(false);
    },
    definition() {
        return {
            message0: localize('Purchase hedge %1 + %2 · 2nd leg stake %3'),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'PURCHASE_LIST',
                    options: [['', '']],
                },
                {
                    type: 'field_dropdown',
                    name: 'HEDGE_LIST',
                    options: [['', '']],
                },
                {
                    type: 'input_value',
                    name: 'SECOND_STAKE',
                    check: 'Number',
                },
            ],
            inputsInline: true,
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize(
                'Purchases two opposite contracts at the same time — a hedge. The first contract buys at the Trade options stake; the second at the stake given here (0 = same as the first). Both positions are open together and After purchase runs when both have settled.'
            ),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase hedge (both sides)'),
            description: localize(
                'Use this block to open both sides of a pair at once (Rise + Fall, Over + Under, Even + Odd, Matches + Differs). Pick the main contract first, then its opposite; give the second leg its own stake or leave 0 to match the main stake. This block can only be used within the Purchase conditions block.'
            ),
            key_words: localize('hedge, both sides, buy both, cover'),
        };
    },
    onchange(event) {
        if (!this.workspace || window.Blockly.derivWorkspace.isFlyoutVisible || this.workspace.isDragging()) {
            return;
        }

        if (event.type === window.Blockly.Events.BLOCK_CREATE && event.ids.includes(this.id)) {
            this.populatePurchaseList(event);
        } else if (event.type === window.Blockly.Events.BLOCK_CHANGE) {
            if (event.name === 'TYPE_LIST' || event.name === 'TRADETYPE_LIST') {
                this.populatePurchaseList(event);
            }
        } else if (event.type === window.Blockly.Events.BLOCK_DRAG && !event.isStart && event.blockId === this.id) {
            const purchase_type_list = this.getField('PURCHASE_LIST');
            const purchase_options = purchase_type_list.menuGenerator_; // eslint-disable-line

            if (purchase_options[0][0] === '') {
                this.populatePurchaseList(event);
            }
        }
    },
    populatePurchaseList(event) {
        const trade_definition_block = this.workspace.getTradeDefinitionBlock();

        if (trade_definition_block) {
            const trade_type_block = trade_definition_block.getChildByType('trade_definition_tradetype');
            const trade_type = trade_type_block.getFieldValue('TRADETYPE_LIST');
            const contract_type_block = trade_definition_block.getChildByType('trade_definition_contracttype');
            const contract_type = contract_type_block.getFieldValue('TYPE_LIST');
            const contract_type_options = getContractTypeOptions(contract_type, trade_type);

            ['PURCHASE_LIST', 'HEDGE_LIST'].forEach(field_name => {
                const field = this.getField(field_name);
                field.updateOptions(contract_type_options, {
                    default_value: field.getValue(),
                    event_group: event.group,
                    should_pretend_empty: true,
                });
            });

            // A hedge needs two DIFFERENT sides: when both dropdowns would
            // show the same contract (a freshly dropped block), point the
            // second one at the opposite so the block is right by default.
            const main_value = this.getFieldValue('PURCHASE_LIST');
            const hedge_value = this.getFieldValue('HEDGE_LIST');
            if (main_value && main_value === hedge_value) {
                const opposite = contract_type_options.find(([, value]) => value && value !== main_value);
                if (opposite) this.setFieldValue(opposite[1], 'HEDGE_LIST');
            }
        }
    },
    customContextMenu(menu) {
        const menu_items = [localize('Enable Block'), localize('Disable Block')];
        excludeOptionFromContextMenu(menu, menu_items);
        modifyContextMenu(menu);
    },
    restricted_parents: ['before_purchase'],
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.hedge_purchase = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const purchaseList = block.getFieldValue('PURCHASE_LIST');
    const hedgeList = block.getFieldValue('HEDGE_LIST');
    const secondStake = generator.valueToCode(block, 'SECOND_STAKE', generator.ORDER_ATOMIC) || '0';

    return `Bot.purchaseHedge('${purchaseList}', '${hedgeList}', ${secondStake});\n`;
};
