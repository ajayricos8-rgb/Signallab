/**
 * Vision Lab blocks are tinted by family so a strategy reads at a glance:
 * violet for the AI, cyan for the maths, emerald for market structure, rose for
 * risk, fuchsia for the one-block shortcuts. Colour first — every other file in
 * the group imports it when its blocks are created.
 */
window.Blockly.Colours.VisionAI = {
    colour: '#7c3aed',
    colourSecondary: '#6d28d9',
    colourTertiary: '#4c1d95',
};
window.Blockly.Colours.VisionQuant = {
    colour: '#0e7490',
    colourSecondary: '#0891b2',
    colourTertiary: '#155e75',
};
window.Blockly.Colours.VisionAnalysis = {
    colour: '#047857',
    colourSecondary: '#059669',
    colourTertiary: '#065f46',
};
window.Blockly.Colours.VisionRisk = {
    colour: '#be123c',
    colourSecondary: '#e11d48',
    colourTertiary: '#881337',
};
window.Blockly.Colours.VisionShortcut = {
    colour: '#a21caf',
    colourSecondary: '#c026d3',
    colourTertiary: '#701a75',
};

export const visionColours = () => ({
    ai: window.Blockly.Colours.VisionAI,
    quant: window.Blockly.Colours.VisionQuant,
    analysis: window.Blockly.Colours.VisionAnalysis,
    risk: window.Blockly.Colours.VisionRisk,
    shortcut: window.Blockly.Colours.VisionShortcut,
});
