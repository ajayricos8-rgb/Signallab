/**
 * A tiny declarative factory for the Vision Lab blocks.
 *
 * Every block in the group is the same shape: a JSON definition, a `meta()`
 * entry so the toolbox search can find it, the shared context menu, and a
 * generator that emits exactly one `Bot.*` call. Declaring them from a spec
 * keeps ~90 blocks consistent and keeps the generated code ES5-safe (the
 * interpreter never sees anything but a function call).
 */

import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../utils';

const generator = () => window.Blockly.JavaScript.javascriptGenerator;

const isValueInput = arg => arg.type === 'input_value';

/** Field values are always emitted as JSON literals, inputs as raw code. */
function readField(block, arg) {
    const value = block.getFieldValue(arg.name);
    if (value === null || value === undefined) return 'null';
    return JSON.stringify(String(value));
}

function readInput(block, arg) {
    const code = generator().valueToCode(block, arg.name, generator().ORDER_ATOMIC);
    if (code === '' || code === null || code === undefined) return arg.default ?? '0';
    return code;
}

function buildArgs(block, spec) {
    const inputs = {};
    const fields = {};
    (spec.args || []).forEach(arg => {
        if (isValueInput(arg)) inputs[arg.name] = readInput(block, arg);
        else if (arg.type !== 'input_dummy' && arg.type !== 'field_label') fields[arg.name] = readField(block, arg);
    });
    return { inputs, fields };
}

/** JSON args for `jsonInit`: strip the factory-only keys. */
function jsonArgs(spec) {
    return (spec.args || []).map(arg => {
        if (isValueInput(arg)) {
            return { type: 'input_value', name: arg.name, check: arg.check || 'Number' };
        }
        return arg;
    });
}

function definition(spec) {
    const colour = spec.colour;
    return {
        message0: spec.message,
        args0: jsonArgs(spec),
        inputsInline: spec.inputsInline !== false,
        colour: colour.colour,
        colourSecondary: colour.colourSecondary,
        colourTertiary: colour.colourTertiary,
        tooltip: spec.tooltip,
        category: spec.category,
        ...(spec.output ? { output: spec.output, outputShape: window.Blockly.OUTPUT_SHAPE_ROUND } : {}),
        ...(spec.statement
            ? {
                  previousStatement: null,
                  nextStatement: null,
                  message1: '%1',
                  args1: [{ type: 'input_statement', name: spec.statement, check: spec.statementCheck || null }],
              }
            : {}),
        ...(spec.command ? { previousStatement: null, nextStatement: null } : {}),
    };
}

function register(spec) {
    const block = {
        init() {
            this.jsonInit(this.definition());
        },
        definition() {
            return definition(spec);
        },
        meta() {
            return {
                display_name: spec.display_name,
                description: spec.description,
            };
        },
        customContextMenu(menu) {
            modifyContextMenu(menu);
        },
    };
    window.Blockly.Blocks[spec.type] = block;

    generator().forBlock[spec.type] = block => {
        const { inputs, fields } = buildArgs(block, spec);
        const expression = spec.call(inputs, fields, block);
        if (spec.statement || spec.command) return `${expression};\n`;
        return [expression, generator().ORDER_ATOMIC];
    };
    return block;
}

/** A block that returns a value (Number, String, Boolean or Array). */
export const defineValueBlock = spec => register({ ...spec, statement: null });

/** A block that runs inside a stack. */
export const defineStatementBlock = spec => register({ ...spec, output: null });

/** Shorthand for the `field_dropdown` entries used all over the group. */
export const dropdown = (name, options, extra = {}) => ({
    type: 'field_dropdown',
    name,
    options,
    ...extra,
});

/** Shorthand for a numeric input with a default and an optional shadow type. */
export const numberInput = (name, fallback = '0', check = 'Number') => ({
    type: 'input_value',
    name,
    check,
    default: fallback,
});

export { localize };
