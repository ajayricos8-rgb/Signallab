// Wire protocol between the DBot Space shell (this app) and the embedded
// workspace (vendor/deriv-bot) running in a same-origin iframe.
//
// Every message carries a `source` tag so neither side can mistake an unrelated
// postMessage for its own, and the shell parses instead of trusting: the frame
// is a separate application, so what it sends is untrusted input with a fixed
// shape. Parsing lives here, away from React, so the shapes are unit-tested
// without a browser (tests/dbot-space-protocol.test.mjs).

/** Tag on every message the shell posts into the frame. */
export const HOST_SOURCE = 'signal-lab';
/** Tag on every message the frame posts back to the shell. */
export const FRAME_SOURCE = 'signal-lab-dbot';

/** Blocks the workspace may report for the AI copilot; more is not useful. */
export const BLOCK_REGISTRY_LIMIT = 800;

const NAME_LIMIT = 120;
const CATEGORY_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;
const MESSAGE_LIMIT = 400;
const ACCOUNT_LIMIT = 64;

/** The two real tabs inside the vendored app. */
export type WorkspaceTab = 'builder' | 'chart';
/** Sections of the Space shell; the last two are rendered by the host. */
export type SpaceView = WorkspaceTab | 'store';
export type AccountKind = 'demo' | 'real' | 'unknown';
export type LinkStatus = 'idle' | 'connecting' | 'connected';

export type WorkspaceBlockInfo = {
  type: string;
  name: string;
  category: string;
  description: string;
};

/** Markets and ticks Signal Lab has collected and shares with the frame. */
export type SharedData = { markets: number; ticks: number };

export type LinkSnapshot = {
  status: LinkStatus;
  accountId: string;
  accountType: AccountKind;
};

/** Everything the frame can say to the shell. */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'workspace-error'; message: string }
  | { type: 'block-registry'; blocks: WorkspaceBlockInfo[]; aiRuntimeRegistered: boolean }
  | { type: 'bot-status'; running: boolean }
  | { type: 'bot-run-started'; message: string }
  | { type: 'bot-loaded'; name: string; runAfterLoad: boolean }
  | { type: 'feed-subscribe' }
  | { type: 'quick-strategy-open' }
  | { type: 'active-tab'; tab: number }
  | { type: 'account-connected'; accountId: string; grantId: number }
  | { type: 'account-disconnected'; grantId: number; connectionLost: boolean }
  | { type: 'account-error'; grantId: number; message: string }
  | { type: 'request-otp'; requestId: number; accountId: string }
  | { type: 'error'; message: string };

export type LinkInput = {
  link: LinkSnapshot;
  /** Signal Lab holds a connected account. */
  hasAccount: boolean;
  autoLink: boolean;
  autoPaused: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function blocks(value: unknown): WorkspaceBlockInfo[] {
  if (!Array.isArray(value)) return [];
  const output: WorkspaceBlockInfo[] = [];
  for (const entry of value.slice(0, BLOCK_REGISTRY_LIMIT)) {
    const block = record(entry);
    if (!block) continue;
    const type = text(block.type, NAME_LIMIT);
    const name = text(block.name, NAME_LIMIT);
    const category = text(block.category, CATEGORY_LIMIT);
    if (!type || !name || !category) continue;
    output.push({ type, name, category, description: text(block.description, DESCRIPTION_LIMIT) });
  }
  return output;
}

/**
 * Validate and normalise one message from the frame. Returns null for anything
 * that is not ours, is malformed, or carries a field the shell cannot use —
 * callers can therefore ignore the result without any further checks.
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  const raw = record(data);
  if (!raw || raw.source !== FRAME_SOURCE || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'ready':
      return { type: 'ready' };
    case 'feed-subscribe':
      return { type: 'feed-subscribe' };
    case 'quick-strategy-open':
      return { type: 'quick-strategy-open' };
    case 'workspace-error':
      return {
        type: 'workspace-error',
        message: text(raw.message, MESSAGE_LIMIT) || 'DBot could not finish loading.',
      };
    case 'block-registry':
      return {
        type: 'block-registry',
        blocks: blocks(raw.blocks),
        aiRuntimeRegistered: raw.aiRuntimeRegistered === true,
      };
    case 'bot-status':
      return { type: 'bot-status', running: raw.running === true };
    case 'bot-run-started':
      return {
        type: 'bot-run-started',
        message: text(raw.message, MESSAGE_LIMIT) || 'DBot started the loaded strategy.',
      };
    case 'bot-loaded':
      return {
        type: 'bot-loaded',
        name: text(raw.name, NAME_LIMIT) || 'The bot',
        runAfterLoad: raw.runAfterLoad === true,
      };
    case 'active-tab': {
      const tab = number(raw.tab);
      return tab === null ? null : { type: 'active-tab', tab };
    }
    case 'account-connected': {
      const grantId = number(raw.grantId);
      const accountId = text(raw.accountId, ACCOUNT_LIMIT);
      return grantId === null || !accountId ? null : { type: 'account-connected', accountId, grantId };
    }
    case 'account-disconnected': {
      const grantId = number(raw.grantId);
      return grantId === null
        ? null
        : { type: 'account-disconnected', grantId, connectionLost: raw.reason === 'connection-lost' };
    }
    case 'account-error': {
      const grantId = number(raw.grantId);
      return grantId === null
        ? null
        : {
          type: 'account-error',
          grantId,
          message: text(raw.message, MESSAGE_LIMIT) || 'DBot could not connect the account.',
        };
    }
    case 'request-otp': {
      const requestId = number(raw.requestId);
      const accountId = text(raw.accountId, ACCOUNT_LIMIT);
      return requestId === null || !accountId ? null : { type: 'request-otp', requestId, accountId };
    }
    case 'error':
      return { type: 'error', message: text(raw.message, MESSAGE_LIMIT) || 'DBot could not complete that action.' };
    default:
      return null;
  }
}

/** Control messages the shell can post into the frame. */
export type HelloMessage = { source: typeof HOST_SOURCE; type: 'hello' };
export type NavigateMessage = { source: typeof HOST_SOURCE; type: 'navigate'; tab: WorkspaceTab };
export type ClearAnalysisMessage = { source: typeof HOST_SOURCE; type: 'clear-analysis' };
export type LoadBotMessage = {
  source: typeof HOST_SOURCE;
  type: 'load-bot';
  xml: string;
  name: string;
  runAfterLoad?: boolean;
  analysisSnapshot?: unknown;
};
export type QuickStrategyMessage = { source: typeof HOST_SOURCE; type: 'quick-strategy'; strategy: string };
export type ConnectAccountMessage = {
  source: typeof HOST_SOURCE;
  type: 'connect-account';
  grantId: number;
  accountId: string;
  url: string;
  accountType: 'demo' | 'real' | null;
};
export type DisconnectAccountMessage = { source: typeof HOST_SOURCE; type: 'disconnect-account'; grantId: number };
export type OtpResponseMessage = {
  source: typeof HOST_SOURCE;
  type: 'otp-response';
  requestId: number;
  accountId: string;
  url?: string;
  error?: string;
};

export type HostMessage =
  | HelloMessage
  | NavigateMessage
  | ClearAnalysisMessage
  | LoadBotMessage
  | QuickStrategyMessage
  | ConnectAccountMessage
  | DisconnectAccountMessage
  | OtpResponseMessage;

/**
 * Stamp any payload as ours before it crosses the iframe boundary.
 *
 * The control messages below already carry their tag, but the data bridge
 * (`lib/dbot-bridge.ts`) is deliberately wire-only — its feed and account
 * frames have no `source` field — and the frame ignores anything that is not
 * tagged `signal-lab`. Tagging here, last, means a payload cannot be posted
 * untagged, and a payload cannot spoof a different source either.
 */
export function tagHostPayload<T extends object>(payload: T): T & { source: typeof HOST_SOURCE } {
  return { ...payload, source: HOST_SOURCE };
}

export function hostHello(): HelloMessage {
  return { source: HOST_SOURCE, type: 'hello' };
}

export function hostNavigate(tab: WorkspaceTab): NavigateMessage {
  return { source: HOST_SOURCE, type: 'navigate', tab };
}

export function hostClearAnalysis(): ClearAnalysisMessage {
  return { source: HOST_SOURCE, type: 'clear-analysis' };
}

export function hostLoadBot(input: {
  xml: string;
  name: string;
  runAfterLoad?: boolean;
  analysisSnapshot?: unknown;
}): LoadBotMessage {
  const message: LoadBotMessage = { source: HOST_SOURCE, type: 'load-bot', xml: input.xml, name: input.name };
  if (input.runAfterLoad) message.runAfterLoad = true;
  if (input.analysisSnapshot !== undefined) message.analysisSnapshot = input.analysisSnapshot;
  return message;
}

export function hostQuickStrategy(strategy: string): QuickStrategyMessage {
  return { source: HOST_SOURCE, type: 'quick-strategy', strategy };
}

export function hostConnectAccount(input: {
  grantId: number;
  accountId: string;
  url: string;
  accountType: 'demo' | 'real' | null;
}): ConnectAccountMessage {
  return { source: HOST_SOURCE, type: 'connect-account', ...input };
}

export function hostDisconnectAccount(grantId: number): DisconnectAccountMessage {
  return { source: HOST_SOURCE, type: 'disconnect-account', grantId };
}

export function hostOtpResponse(input: {
  requestId: number;
  accountId: string;
  url?: string;
  error?: string;
}): OtpResponseMessage {
  const message: OtpResponseMessage = {
    source: HOST_SOURCE,
    type: 'otp-response',
    requestId: input.requestId,
    accountId: input.accountId,
  };
  if (input.url) message.url = input.url;
  if (input.error) message.error = input.error;
  return message;
}

/** The account pill's label. Account state wins over every retry state. */
export function linkSummary({ link, hasAccount, autoLink, autoPaused }: LinkInput): string {
  if (link.status === 'connected') {
    return `Auto-linked · ${link.accountId}${link.accountType === 'real' ? ' (real)' : ''}`;
  }
  if (link.status === 'connecting') return `Linking ${link.accountId || 'account'}…`;
  if (!hasAccount) return 'Connect an account in Settings';
  if (autoPaused) return 'Automatic link failed';
  if (!autoLink) return 'Linking paused';
  return 'Waiting to link';
}

/** The shared-data line under the frame header. */
export function sharedTicksLabel(shared: SharedData): string {
  if (!shared.ticks) return 'Waiting for Signal Lab ticks';
  return `${shared.markets} markets · ${shared.ticks.toLocaleString()} ticks shared`;
}

/** The frame's internal tab number for a host view. */
export function workspaceTabIndex(tab: WorkspaceTab): number {
  return tab === 'chart' ? 2 : 1;
}

/** The host view a frame tab number maps to, if any. */
export function viewForWorkspaceTab(tab: number): WorkspaceTab | null {
  if (tab === 1) return 'builder';
  if (tab === 2) return 'chart';
  return null;
}
