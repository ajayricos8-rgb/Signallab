/**
 * Signal Lab blocks are tinted differently from Deriv's own grey blocks so a
 * strategy that reads Signal Lab data is recognisable at a glance.
 */
window.Blockly.Colours.SignalLab = {
    colour: '#0f766e',
    colourSecondary: '#115e59',
    colourTertiary: '#134e4a',
};

export const signalLabColour = () => window.Blockly.Colours.SignalLab;
