import { localize } from '@deriv-com/translations';
import { config } from '../../../../constants/config';
import ApiHelpers from '../../../../services/api/api-helpers';
import { getContractTypeOptions } from '../../../shared';
import { excludeOptionFromContextMenu, modifyContextMenu, runIrreversibleEvents } from '../../../utils';

/**
 * The Purchase block, doubled: it buys the main contract AND the opposite
 * contract in the same pass, so both sides of a hedge are open at the same
 * time. Both legs stake the Trade options amount — there is no separate
 * second-leg stake on this block.
 *
 * The block is two purchase rows, like Deriv's own Higher/Lower purchase
 * conditions:
 *
 *   Purchase 1: [Higher] Barrier: [Offset +] [0.39]
 *   Purchase 2: [Lower]  Barrier: [Offset +] [0.39]
 *
 * Each row carries its own barrier configuration, grown automatically from
 * the workspace trade type: a Prediction per row on Over/Under and
 * Matches/Differs, a Barrier offset per row on Higher/Lower and Touch/No
 * Touch, High/Low barriers per row on In/Out. The Trade options
 * barrier/prediction is NOT consulted for hedge buys — Purchase 1 and
 * Purchase 2 are the only place a hedge leg's barrier is set, so the two
 * can never conflict.
 */

/** Which per-leg settings each trade type takes (TRADETYPE_LIST values). */
const LEG_SETTINGS_BY_TRADETYPE = {
    overunder: { prediction: true, barriers: 0 },
    matchesdiffers: { prediction: true, barriers: 0 },
    highlowticks: { prediction: true, barriers: 0 },
    higherlower: { prediction: false, barriers: 1 },
    touchnotouch: { prediction: false, barriers: 1 },
    endsinout: { prediction: false, barriers: 2 },
    staysinout: { prediction: false, barriers: 2 },
};

const legSettingsFor = tradeType => LEG_SETTINGS_BY_TRADETYPE[tradeType] || { prediction: false, barriers: 0 };
const shapeSignature = ({ prediction, barriers }) => (prediction ? 'prediction' : `barriers${barriers}`);

window.Blockly.Blocks.hedge_purchase = {
    init() {
        this.jsonInit(this.definition());

        // The two purchase rows (contract dropdown + this leg's barrier
        // configuration) are built per trade type by updateLegInputs.
        this.legShape_ = null;
        this.rowInputNames_ = [];
        this.defaultBarrierTargets_ = {};
        this.updateLegInputs({ prediction: false, barriers: 0 });

        // Ensure one of this type per statement-stack (same rule as Purchase)
        this.setNextStatement(false);
    },
    definition() {
        return {
            message0: localize('Purchase hedge'),
            args0: [],
            inputsInline: false,
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize(
                'Purchases two opposite contracts at the same time — a hedge. Purchase 1 and Purchase 2 each carry their own prediction/barrier offset on the row; the Trade options barrier is not used for these buys. Both legs stake the Trade options amount. After purchase runs when both legs have settled.'
            ),
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: localize('Purchase hedge (both sides)'),
            description: localize(
                'Use this block to open both sides of a pair at once (Rise + Fall, Over + Under, Higher + Lower, Touch + No Touch, Ends Between + Ends Outside). Purchase 1 is the main contract, Purchase 2 its opposite, and each row carries its own prediction or barrier offset — set them here; the Trade options barrier does not apply to hedge buys. This block can only be used within the Purchase conditions block.'
            ),
            key_words: localize('hedge, both sides, buy both, cover'),
        };
    },
    onchange(event) {
        if (!this.workspace) {
            return;
        }

        // A strategy load must sync the rows to the workspace trade type
        // even when the toolbox flyout is open. Stale rows — Prediction
        // rows surviving on a Higher/Lower workspace, say — would
        // otherwise generate leg options for the wrong contract family
        // (a digit prediction sent as a price barrier: "Invalid
        // barrier"). Loads fire one BLOCK_CREATE batch for the whole
        // workspace, so the trade definition is already in place here.
        const is_load_event = /^dbot-load/.test(event.group || '');
        if (is_load_event && event.type === window.Blockly.Events.BLOCK_CREATE && event.ids.includes(this.id)) {
            this.populatePurchaseList(event);
            return;
        }

        if (window.Blockly.derivWorkspace.isFlyoutVisible || this.workspace.isDragging()) {
            return;
        }

        if (event.type === window.Blockly.Events.BLOCK_CREATE && event.ids.includes(this.id)) {
            this.populatePurchaseList(event);
        } else if (event.type === window.Blockly.Events.BLOCK_CHANGE) {
            if (
                event.name === 'TYPE_LIST' ||
                event.name === 'TRADETYPE_LIST' ||
                event.name === 'SYMBOL_LIST' ||
                event.name === 'DURATIONTYPE_LIST' ||
                /^(HEDGE_)?(SECOND)?BARRIEROFFSETTYPE_LIST$/.test(event.name || '')
            ) {
                this.populatePurchaseList(event);
            }
        } else if (event.type === window.Blockly.Events.BLOCK_DRAG && !event.isStart && event.blockId === this.id) {
            const purchase_type_list = this.getField('PURCHASE_LIST');
            const purchase_options = purchase_type_list && purchase_type_list.menuGenerator_; // eslint-disable-line

            if (!purchase_options || purchase_options[0][0] === '') {
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

            // Rows first: a trade-type change rebuilds them (new dropdown
            // fields), so options must be applied to the rebuilt fields.
            this.updateLegInputs(legSettingsFor(trade_type));

            ['PURCHASE_LIST', 'HEDGE_LIST'].forEach(field_name => {
                const field = this.getField(field_name);
                if (!field) return;
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

            this.applyDefaultBarriers(trade_definition_block, trade_type);
        }
    },
    /**
     * Default each row's barrier offset to the value Deriv itself
     * suggests for this market/trade type (the same contracts_for lookup
     * Trade options uses), instead of a hard-coded 1 — a made-up offset
     * can sit inside the minimum distance from spot for the duration and
     * be rejected. Only the built-in shadow default is ever written; a
     * value the user typed, or a real block they attached, is left alone.
     */
    applyDefaultBarriers(trade_definition_block, trade_type) {
        const settings = legSettingsFor(trade_type);
        if (!settings.barriers) return;

        const { contracts_for } = ApiHelpers?.instance ?? {};
        if (!contracts_for) return;

        const market_block = trade_definition_block.getChildByType('trade_definition_market');
        const options_block =
            trade_definition_block.getChildByType('trade_definition_tradeoptions') ||
            trade_definition_block.getChildByType('trade_definition_tradeoptions_payout');
        const symbol = market_block?.getFieldValue('SYMBOL_LIST');
        if (!symbol) return;
        const duration_unit = options_block?.getFieldValue('DURATIONTYPE_LIST') || 't';
        // Each leg can have a different sign. Query separately; getBarriers
        // mutates its argument and a single query would use leg 1's signs
        // for both legs. Ignore stale async replies after a market change.
        const generation = (this.barrierLookupGeneration_ || 0) + 1;
        this.barrierLookupGeneration_ = generation;
        ['', 'HEDGE_'].forEach(prefix => {
            const barrier_types = [
                this.getFieldValue(`${prefix}BARRIEROFFSETTYPE_LIST`) || '+',
                this.getFieldValue(`${prefix}SECONDBARRIEROFFSETTYPE_LIST`) || '-',
            ];
            contracts_for
                .getBarriers(symbol, trade_type, duration_unit, barrier_types)
                .then(barriers => {
                    if (!barriers?.values?.length || !this.workspace || this.barrierLookupGeneration_ !== generation) return;
                    runIrreversibleEvents(() => {
                        ['BARRIEROFFSET', 'SECONDBARRIEROFFSET'].forEach((base_name, index) => {
                            if (index >= settings.barriers) return;
                            const name = `${prefix}${base_name}`;
                            const value = barriers.values[index];
                            if (value === undefined || value === '' || value === false) return;
                            const target = this.getInput(name)?.connection?.targetBlock();
                            const tracked = this.defaultBarrierTargets_?.[name];
                            // Only change the shadow created by this block, and
                            // only while it still holds our last default. Loaded
                            // XML and user edits are never overwritten.
                            if (!target?.isShadow() || !tracked || target !== tracked.block || target.getFieldValue('NUM') !== tracked.value) return;
                            target.setFieldValue(String(value), 'NUM');
                            tracked.value = target.getFieldValue('NUM');
                        });
                    });
                })
                .catch(() => {
                    // Contract metadata may be unavailable offline. Keep the
                    // visible value; Deriv still validates it at purchase.
                });
        });
    },
    /**
     * Build the two purchase rows for the current trade-type shape. Rows
     * are only rebuilt when the shape actually changes (a trade-type
     * switch), so blocks the user attached are never disturbed by routine
     * dropdown refreshes. Dropdown values survive a rebuild.
     */
    updateLegInputs(settings) {
        const signature = shapeSignature(settings);
        if (signature === this.legShape_) return false;

        runIrreversibleEvents(() => {
            const field_names = [
                'PURCHASE_LIST',
                'HEDGE_LIST',
                'BARRIEROFFSETTYPE_LIST',
                'SECONDBARRIEROFFSETTYPE_LIST',
                'HEDGE_BARRIEROFFSETTYPE_LIST',
                'HEDGE_SECONDBARRIEROFFSETTYPE_LIST',
            ];
            const preserved = {};
            field_names.forEach(name => {
                if (this.getField(name)) preserved[name] = this.getFieldValue(name);
            });

            (this.rowInputNames_ || []).forEach(name => {
                if (this.getInput(name)) this.removeInput(name, true);
            });
            this.rowInputNames_ = [];
            this.defaultBarrierTargets_ = {};

            ['', 'HEDGE_'].forEach(prefix => this.buildLegRow(prefix, settings));

            field_names.forEach(name => {
                if (preserved[name] && this.getField(name)) this.setFieldValue(preserved[name], name);
            });

            this.legShape_ = signature;
        });
        return true;
    },
    buildLegRow(prefix, { prediction, barriers }) {
        const is_hedge = prefix === 'HEDGE_';
        const list_field = is_hedge ? 'HEDGE_LIST' : 'PURCHASE_LIST';
        const row_label = is_hedge ? localize('Purchase 2:') : localize('Purchase 1:');
        const new_contract_dropdown = () => new window.Blockly.FieldDropdown([['', '']]);

        if (prediction) {
            const name = `${prefix}PREDICTION`;
            const input = this.appendValueInput(name)
                .setCheck('Number')
                .appendField(row_label)
                .appendField(new_contract_dropdown(), list_field)
                .appendField(localize('Prediction (tick 1–5 / digit 0–9):'));
            this.rowInputNames_.push(name);
            this.addNumberShadow(input, '5');
        } else if (barriers > 0) {
            ['BARRIEROFFSET', 'SECONDBARRIEROFFSET'].forEach((base_name, index) => {
                if (index >= barriers) return;
                const name = `${prefix}${base_name}`;
                const input = this.appendValueInput(name).setCheck('Number');
                if (index === 0) {
                    input
                        .appendField(row_label)
                        .appendField(new_contract_dropdown(), list_field)
                        .appendField(barriers === 1 ? localize('Barrier:') : localize('High barrier:'));
                } else {
                    input.appendField(localize('Low barrier:'));
                }
                input.appendField(new window.Blockly.FieldDropdown(config().BARRIER_TYPES), `${name}TYPE_LIST`);
                // Mirror Trade options: the high barrier offsets up from
                // spot, the low barrier down.
                if (index === 1) this.setFieldValue('-', `${name}TYPE_LIST`);
                this.rowInputNames_.push(name);
                this.addNumberShadow(input, '1');
                const shadow = input.connection.targetBlock();
                if (shadow) this.defaultBarrierTargets_[name] = { block: shadow, value: shadow.getFieldValue('NUM') };
            });
        } else {
            const name = `${prefix}CONTRACT_ROW`;
            this.appendDummyInput(name).appendField(row_label).appendField(new_contract_dropdown(), list_field);
            this.rowInputNames_.push(name);
        }
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
