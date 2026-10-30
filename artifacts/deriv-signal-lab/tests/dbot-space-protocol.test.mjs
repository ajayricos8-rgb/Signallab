// The shell and the vendored workspace are two applications talking over
// postMessage. These tests pin the wire contract the shell relies on: it only
// acts on messages the frame tagged for it, it sanitises what the frame reports,
// and every message it posts is tagged and carries no credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_REGISTRY_LIMIT,
  FRAME_SOURCE,
  HOST_SOURCE,
  hostClearAnalysis,
  hostConnectAccount,
  hostDisconnectAccount,
  hostHello,
  hostLoadBot,
  hostNavigate,
  hostOtpResponse,
  hostQuickStrategy,
  linkSummary,
  parseFrameMessage,
  sharedTicksLabel,
  tagHostPayload,
  viewForWorkspaceTab,
  workspaceTabIndex,
} from '../src/components/dbot-space/protocol.ts';

const frame = (type, extra = {}) => ({ source: FRAME_SOURCE, type, ...extra });
const idle = { status: 'idle', accountId: '', accountType: 'unknown' };

test('only messages the frame tagged for the shell are parsed', () => {
  assert.equal(parseFrameMessage(null), null);
  assert.equal(parseFrameMessage('ready'), null);
  assert.equal(parseFrameMessage([]), null);
  assert.equal(parseFrameMessage({ source: 'somewhere-else', type: 'ready' }), null);
  assert.equal(parseFrameMessage({ source: FRAME_SOURCE }), null);
  assert.equal(parseFrameMessage(frame('not-a-real-message')), null);
  assert.deepEqual(parseFrameMessage(frame('ready')), { type: 'ready' });
});

test('a block registry is sanitised, deduplicated by validity and capped', () => {
  const entries = Array.from({ length: BLOCK_REGISTRY_LIMIT + 200 }, (_, index) => ({
    type: `block_${index}`,
    name: 'x'.repeat(400),
    category: 'Signal Lab',
    description: 'y'.repeat(900),
  }));
  entries.splice(3, 0, null, 'nonsense', { type: '', name: 'no type' }, { type: 'ok', name: 'no category' });
  const parsed = parseFrameMessage(frame('block-registry', { blocks: entries, aiRuntimeRegistered: true }));
  assert.equal(parsed.type, 'block-registry');
  assert.equal(parsed.aiRuntimeRegistered, true);
  // Entry count is capped first, then the four malformed entries are dropped.
  assert.equal(parsed.blocks.length, BLOCK_REGISTRY_LIMIT - 4, 'the registry must stay bounded and valid');
  assert.ok(parsed.blocks.length <= BLOCK_REGISTRY_LIMIT);
  assert.equal(parsed.blocks[0].name.length, 120, 'names are trimmed to their cap');
  assert.equal(parsed.blocks[0].description.length, 300, 'descriptions are trimmed to their cap');
  assert.ok(parsed.blocks.every((block) => block.type && block.name && block.category));
  const clean = Array.from({ length: BLOCK_REGISTRY_LIMIT + 50 }, (_, index) => ({ type: `b${index}`, name: 'n', category: 'c' }));
  assert.equal(parseFrameMessage(frame('block-registry', { blocks: clean })).blocks.length, BLOCK_REGISTRY_LIMIT);
  // A frame that omits or lies about the AI runtime is reported as false.
  assert.equal(parseFrameMessage(frame('block-registry', { blocks: [] })).aiRuntimeRegistered, false);
  assert.deepEqual(parseFrameMessage(frame('block-registry')), {
    type: 'block-registry', blocks: [], aiRuntimeRegistered: false,
  });
});

test('account messages without a usable grant are dropped', () => {
  assert.equal(parseFrameMessage(frame('account-connected', { accountId: 'VRTC1' })), null);
  assert.equal(parseFrameMessage(frame('account-connected', { grantId: 2 })), null);
  assert.deepEqual(
    parseFrameMessage(frame('account-connected', { accountId: 'VRTC1', grantId: 2 })),
    { type: 'account-connected', accountId: 'VRTC1', grantId: 2 },
  );
  assert.deepEqual(
    parseFrameMessage(frame('account-disconnected', { grantId: 2, reason: 'connection-lost' })),
    { type: 'account-disconnected', grantId: 2, connectionLost: true },
  );
  assert.deepEqual(
    parseFrameMessage(frame('account-disconnected', { grantId: 2 })),
    { type: 'account-disconnected', grantId: 2, connectionLost: false },
  );
  assert.equal(parseFrameMessage(frame('account-error', { grantId: 2 })).message.length > 0, true);
  assert.equal(parseFrameMessage(frame('account-error', {})), null);
});

test('an OTP request needs both a request id and the exact account', () => {
  assert.equal(parseFrameMessage(frame('request-otp', { requestId: 7 })), null);
  assert.equal(parseFrameMessage(frame('request-otp', { accountId: 'VRTC1' })), null);
  assert.deepEqual(
    parseFrameMessage(frame('request-otp', { requestId: 7, accountId: 'VRTC1' })),
    { type: 'request-otp', requestId: 7, accountId: 'VRTC1' },
  );
});

test('the frame tab number maps to a host view and back', () => {
  assert.equal(viewForWorkspaceTab(1), 'builder');
  assert.equal(viewForWorkspaceTab(2), 'chart');
  assert.equal(viewForWorkspaceTab(3), null);
  assert.equal(workspaceTabIndex('builder'), 1);
  assert.equal(workspaceTabIndex('chart'), 2);
});

test('host messages are tagged, shaped and free of credentials', () => {
  const messages = [
    hostHello(),
    hostNavigate('chart'),
    hostClearAnalysis(),
    hostLoadBot({ xml: '<xml/>', name: 'AI bot' }),
    hostLoadBot({ xml: '<xml/>', name: 'AI bot', runAfterLoad: true, analysisSnapshot: { symbol: 'R_100' } }),
    hostQuickStrategy('MARTINGALE'),
    hostConnectAccount({ grantId: 3, accountId: 'VRTC1', url: 'wss://example/otp', accountType: 'demo' }),
    hostDisconnectAccount(3),
    hostOtpResponse({ requestId: 1, accountId: 'VRTC1', url: 'wss://example/otp' }),
    hostOtpResponse({ requestId: 1, accountId: 'VRTC1', error: 'gone' }),
  ];
  for (const message of messages) {
    assert.equal(message.source, HOST_SOURCE, 'every message carries the host tag');
    const wire = JSON.stringify(message);
    assert.equal(/token|pat|password|authorization/i.test(wire), false, `no credential in ${message.type}`);
  }
  // `runAfterLoad` and an analysis snapshot are only sent when asked for.
  assert.equal('runAfterLoad' in hostLoadBot({ xml: '<xml/>', name: 'x' }), false);
  assert.equal('analysisSnapshot' in hostLoadBot({ xml: '<xml/>', name: 'x' }), false);
  const editable = hostLoadBot({ xml: '<xml/>', name: 'x', analysisSnapshot: { analysisId: 'a' } });
  assert.deepEqual(editable.analysisSnapshot, { analysisId: 'a' });
  assert.equal('runAfterLoad' in editable, false, 'loading for editing must not start trading');
  // A failed OTP carries the reason, not a URL.
  const failed = hostOtpResponse({ requestId: 1, accountId: 'VRTC1', error: 'gone' });
  assert.equal('url' in failed, false);
  assert.equal(failed.error, 'gone');
  assert.deepEqual(hostOtpResponse({ requestId: 1, accountId: 'VRTC1' }), {
    source: HOST_SOURCE, type: 'otp-response', requestId: 1, accountId: 'VRTC1',
  });
});

test('every outbound payload is tagged, including the bridge frames', () => {
  // lib/dbot-bridge.ts is wire-only: its frames carry no source of their own,
  // and the workspace drops anything that is not tagged `signal-lab`.
  const feed = { type: 'signal-lab-feed', reset: true, sentAt: 1_700_000_000, markets: [] };
  assert.deepEqual(tagHostPayload(feed), { ...feed, source: HOST_SOURCE });
  assert.deepEqual(tagHostPayload({ type: 'signal-lab-account', accountId: '' }), {
    type: 'signal-lab-account', accountId: '', source: HOST_SOURCE,
  });
  // A payload cannot spoof a different source.
  assert.equal(tagHostPayload({ source: 'somewhere-else', type: 'x' }).source, HOST_SOURCE);
  // Control messages already carry the tag; tagging again changes nothing.
  const hello = hostHello();
  assert.deepEqual(tagHostPayload(hello), hello);
});

test('the account pill follows the link state machine', () => {
  const base = { hasAccount: true, autoLink: true, autoPaused: false };
  assert.equal(linkSummary({ ...base, link: { status: 'connected', accountId: 'VRTC1', accountType: 'demo' } }), 'Auto-linked · VRTC1');
  assert.equal(linkSummary({ ...base, link: { status: 'connected', accountId: 'CR1', accountType: 'real' } }), 'Auto-linked · CR1 (real)');
  assert.equal(linkSummary({ ...base, link: { status: 'connecting', accountId: 'VRTC1', accountType: 'demo' } }), 'Linking VRTC1…');
  assert.equal(linkSummary({ ...base, link: { status: 'connecting', accountId: '', accountType: 'unknown' } }), 'Linking account…');
  assert.equal(linkSummary({ ...base, link: idle }), 'Waiting to link');
  assert.equal(linkSummary({ ...base, link: idle, autoPaused: true }), 'Automatic link failed');
  assert.equal(linkSummary({ ...base, link: idle, autoLink: false }), 'Linking paused');
  // No Signal Lab account outranks every retry state.
  assert.equal(linkSummary({ ...base, link: idle, hasAccount: false, autoLink: false, autoPaused: true }), 'Connect an account in Settings');
});

test('the shared-data line reports markets and ticks, or nothing yet', () => {
  assert.equal(sharedTicksLabel({ markets: 0, ticks: 0 }), 'Waiting for Signal Lab ticks');
  assert.equal(sharedTicksLabel({ markets: 3, ticks: 1750 }), '3 markets · 1,750 ticks shared');
});
