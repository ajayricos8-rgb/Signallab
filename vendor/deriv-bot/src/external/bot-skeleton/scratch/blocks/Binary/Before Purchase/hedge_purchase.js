import { localize } from '@deriv-com/translations';
import { config } from '../../../../constants/config';
import { getContractTypeOptions } from '../../../shared';
import { excludeOptionFromContextMenu, modifyContextMenu, runIrreversibleEvents } from '../../../utils';

/**
 * The Purchase block, doubled: it buys the main contract AND the opposite
 * contract in the same pass, so both sides of a hedge are open at the same
 * time. Both legs stake the Trade options amount — there is no separate
 * second-leg stake on this block.
 *
 * For contract families that take a prediction or barrier offsets (Over/
 * Under, Matches/Differs, Higher/Lower, Touch/No Touch, Ends/Stays
 * Between–Outside), the block automatically grows one set of
 * prediction/barrier inputs PER LEG, mirroring Trade options, so each side
 * of the hedge can carry its own prediction or barriers. An input left
 * unconnected falls back to the Trade options value.
 */

/** Which per-leg settings each trade type takes (TRADETYPE_LIST values). */
const LEG_SETTINGS_BY_TRADETYPE = {
    overunder: { prediction: true, barriers: 0 },
    matchesdiffers: { prediction: true, barriers: 0 },
    higherlower: { prediction: false, barriers: 1 },
    touchnotouch: { prediction: false, barriers: 1 },
    endsinout: { prediction: false, barriers: 2 },
    staysinout: { prediction: false, barriers: 2 },
};

const legSettingsFor = tradeType => LEG_SETTINGS_BY_TRADETYPE[tradeType] || { prediction: false, barriers: 0 };

window.Blockly.Blocks.hedge_purchase = {
    init() {
        this.jsonInit(this.definition());

        // Ensure one of this type per statement-stack (same rule as Purchase)
        this.setNextStatement(false);
    },
    definition() {
        return {
            message0: localize('Purchase hedge %1 + %2'),
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
            ],
            inputsInline: false,
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize(
                'Purchases two opposite contracts at the same time — a hedge. Both legs use the Trade options stake. On barrier and digit contracts the block grows prediction/barrier inputs for each leg. After purchase runs when both legs have settled.'
            ),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase hedge (both sides)'),
            description: localize(
                'Use this block to open both sides of a pair at once (Rise + Fall, Over + Under, Higher + Lower, Touch + No Touch, Ends Between + Ends Outside). Pick the main contract first, then its opposite; on prediction/barrier contracts each leg gets its own prediction or barrier offset inputs. This block can only be used within the Purchase conditions block.'
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

            this.updateLegInputs(legSettingsFor(trade_type));
        }
    },
    /**
     * Grow/shrink the per-leg prediction and barrier inputs to match the
     * workspace trade type. Both legs always carry the same set.
     */
    updateLegInputs({ prediction, barriers }) {
        runIrreversibleEvents(() => {
            ['', 'HEDGE_'].forEach(prefix => {
                const is_hedge = prefix === 'HEDGE_';

                const prediction_name = `${prefix}PREDICTION`;
                if (prediction && !this.getInput(prediction_name)) {
                    const input = this.appendValueInput(prediction_name)
                        .setCheck('Number')
                        .appendField(is_hedge ? localize('Hedge prediction') : localize('Prediction'));
                    this.addNumberShadow(input, '5');
                } else if (!prediction && this.getInput(prediction_name)) {
                    this.removeInput(prediction_name, true);
                }

                ['BARRIEROFFSET', 'SECONDBARRIEROFFSET'].forEach((base_name, index) => {
                    const name = `${prefix}${base_name}`;
                    const needed = barriers > index;
                    if (needed && !this.getInput(name)) {
                        const single = barriers === 1;
                        const label = is_hedge
                            ? single
                                ? localize('Hedge barrier')
                                : index === 0
                                  ? localize('Hedge high barrier')
                                  : localize('Hedge low barrier')
                            : single
                              ? localize('Barrier')
                              : config().BARRIER_LABELS[index];
                        const input = this.appendValueInput(name)
                            .setCheck('Number')
                            .appendField(label)
                            .appendField(new window.Blockly.FieldDropdown(config().BARRIER_TYPES), `${name}TYPE_LIST`);
                        // Mirror Trade options: the first barrier offsets up
                        // from spot, the second one down.
                        if (index === 1) this.setFieldValue('-', `${name}TYPE_LIST`);
                        this.addNumberShadow(input, '1');
                    } else if (!needed && this.getInput(name)) {
                        this.removeInput(name, true);
                    }
                });
            });
        });
    },
    addNumberShadow(input, value) {
        if (!this.workspace || input.connection.targetBlock()) return;
        const shadow_block = this.workspace.newBlock('math_number_positive');
        shadow_block.setInputsInline(true);
        shadow_block.setShadow(true);
        shadow_block.setFieldValue(value, 'NUM');
        shadow_block.outputConnection.connect(input.connection);
        shadow_block.initSvg();
        shadow_block.renderEfficiently();
    },
    mutationToDom() {
        const container = document.createElement('mutation');
        container.setAttribute('has_prediction', !!this.getInput('PREDICTION'));
        container.setAttribute('has_first_barrier', !!this.getInput('BARRIEROFFSET'));
        container.setAttribute('has_second_barrier', !!this.getInput('SECONDBARRIEROFFSET'));
        return container;
    },
    domToMutation(xmlElement) {
        const has_prediction = xmlElement.getAttribute('has_prediction') === 'true';
        const has_first_barrier = xmlElement.getAttribute('has_first_barrier') === 'true';
        const has_second_barrier = xmlElement.getAttribute('has_second_barrier') === 'true';
        this.updateLegInputs({
            prediction: has_prediction,
            barriers: has_second_barrier ? 2 : has_first_barrier ? 1 : 0,
        });
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

    // Same barrier composition as Trade options: a signed offset string
    // ('+1.5'), or the raw expression for absolute barriers.
    const getBarrierValue = (barrier_offset_type, value) => {
        if (/^\d+(\.\d+)?$/.test(value)) {
            return barrier_offset_type === 'absolute' ? `'${value}'` : `'${barrier_offset_type}${value}'`;
        }
        return barrier_offset_type === 'absolute' ? value : `'${barrier_offset_type}' + ${value}`;
    };

    const legOptions = prefix => {
        const parts = [];
        if (block.getInput(`${prefix}PREDICTION`)) {
            const value = generator.valueToCode(block, `${prefix}PREDICTION`, generator.ORDER_ATOMIC);
            if (value) parts.push(`prediction: ${value}`);
        }
        if (block.getInput(`${prefix}BARRIEROFFSET`)) {
            const value = generator.valueToCode(block, `${prefix}BARRIEROFFSET`, generator.ORDER_ATOMIC);
            if (value) {
                parts.push(
                    `barrierOffset: ${getBarrierValue(block.getFieldValue(`${prefix}BARRIEROFFSETTYPE_LIST`), value)}`
                );
            }
        }
        if (block.getInput(`${prefix}SECONDBARRIEROFFSET`)) {
            const value = generator.valueToCode(block, `${prefix}SECONDBARRIEROFFSET`, generator.ORDER_ATOMIC);
            if (value) {
                parts.push(
                    `secondBarrierOffset: ${getBarrierValue(block.getFieldValue(`${prefix}SECONDBARRIEROFFSETTYPE_LIST`), value)}`
                );
            }
        }
        return `{ ${parts.join(', ')} }`;
    };

    return `Bot.purchaseHedge('${purchaseList}', '${hedgeList}', ${legOptions('')}, ${legOptions('HEDGE_')});\n`;
};
