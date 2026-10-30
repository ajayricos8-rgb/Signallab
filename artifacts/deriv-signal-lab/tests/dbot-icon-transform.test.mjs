import test from 'node:test';
import assert from 'node:assert/strict';

const previousWindow = globalThis.window;
globalThis.window = {
  Blockly: {
    icons: { Icon: class Icon {} },
    BlockSvg: { SEP_SPACE_X: 4 },
  },
};

await import(`../../../vendor/deriv-bot/src/external/bot-skeleton/scratch/hooks/icon.js?test=${Date.now()}`);

test('Blockly icon rendering emits a valid SVG translate transform', () => {
  const attributes = {};
  const icon = globalThis.window.Blockly.Icon;
  Object.assign(icon, {
    block_: { RTL: false, isCollapsed: () => false },
    iconGroup_: { setAttribute: (name, value) => { attributes[name] = value; } },
    SIZE: 12,
    collapseHidden: false,
    computeIconLocation() {},
  });

  const nextCursor = icon.renderIcon(3);
  assert.equal(attributes.transform, 'translate(3,9)');
  assert.equal(nextCursor, 19);
});

test.after(() => {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});
