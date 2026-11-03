// Wire contract between the rebuilt DBot Space shell and the embedded workspace.
//
// The frame (vendor/deriv-bot) is deliberately untouched by this rebuild, so
// every shape below is a frozen protocol: renaming a field here makes the frame
// stop answering. Two rules keep the boundary safe:
//
//   1. inbound data is untrusted — `parseFrameMessage` validates and clamps it
//      before React ever sees it;
//   2. outbound data is stamped with HOST_SOURCE *last* (`tagHostPayload`),
//      because the pure bridge payloads in lib/dbot-bridge.ts carry no source
//      field at all and the frame drops untagged messages.

/** Tag on every message the shell posts into the frame. */
export const HOST_SOURCE = 'signal-lab';
/** Tag on every message the frame posts back to the shell. */
export const FRAME_SOURCE = 'signal-lab-dbot';

/** Upper bound on blocks the frame may report to the AI copilot. */
export const BLOCK_REGISTRY_LIMIT = 800;

const NAME_LIMIT = 120;
const CATEGORY_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;
const MESSAGE_LIMIT = 400;
const ACCOUNT_LIMIT = 64;

/** The two real tabs inside the vendored app. */
export type WorkspaceTab = 'builder' | 'chart';
/** Sections of the Space shell; host-only views do not navigate the iframe. */
export type SpaceView = WorkspaceTab | 'store' | 'tools' | 'pro-tool';
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

/** Everything the frame is allowed to say to the shell. */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'workspace-error'; message: string }
  | { type: 'block-registry'; blocks: WorkspaceBlockInfo[]; aiRuntimeRegistered: boolean }
  | { type: 'bot-status'; running: boolean }
  | { type: 'session-limit-hit'; reason: 'take-profit' | 'stop-loss'; profit: number; currency: string }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function blockList(value: unknown): WorkspaceBlockInfo[] {
  if (!Array.isArray(value)) return [];
  const output: WorkspaceBlockInfo[] = [];
  for (const entry of value.slice(0, BLOCK_REGISTRY_LIMIT)) {
    const block = asRecord(entry);
    if (!block) continue;
    const type = boundedText(block.type, NAME_LIMIT);
    const name = boundedText(block.name, NAME_LIMIT);
    const category = boundedText(block.category, CATEGORY_LIMIT);
    if (!type || !name || !category) continue;
    output.push({ type, name, category, description: boundedText(block.description, DESCRIPTION_LIMIT) });
  }
  return output;
}

/**
 * Validate and normalise one frame message. Anything foreign, malformed or
 * missing a required field becomes null, so callers can ignore it safely.
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  const raw = asRecord(data);
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
        message: boundedText(raw.message, MESSAGE_LIMIT) || 'DBot could not finish loading.',
      };
    case 'block-registry':
      return {
        type: 'block-registry',
        blocks: blockList(raw.blocks),
        aiRuntimeRegistered: raw.aiRuntimeRegistered === true,
      };
    case 'bot-status':
      return { type: 'bot-status', running: raw.running === true };
    case 'session-limit-hit': {
      const profit = finiteNumber(raw.profit);
      const currency = boundedText(raw.currency, 8).toUpperCase();
      if ((raw.reason !== 'take-profit' && raw.reason !== 'stop-loss') || profit === null || !/^[A-Z]{3,5}$/.test(currency)) return null;
      return { type: 'session-limit-hit', reason: raw.reason, profit, currency };
    }
    case 'bot-run-started':
      return {
        type: 'bot-run-started',
        message: boundedText(raw.message, MESSAGE_LIMIT) || 'DBot started the loaded strategy.',
      };
    case 'bot-loaded':
      return {
        type: 'bot-loaded',
        name: boundedText(raw.name, NAME_LIMIT) || 'The bot',
        runAfterLoad: raw.runAfterLoad === true,
      };
    case 'active-tab': {
      const tab = finiteNumber(raw.tab);
      return tab === null ? null : { type: 'active-tab', tab };
    }
    case 'account-connected': {
      const grantId = finiteNumber(raw.grantId);
      const accountId = boundedText(raw.accountId, ACCOUNT_LIMIT);
      return grantId === null || !accountId ? null : { type: 'account-connected', accountId, grantId };
    }
    case 'account-disconnected': {
      const grantId = finiteNumber(raw.grantId);
      return grantId === null
        ? null
        : { type: 'account-disconnected', grantId, connectionLost: raw.reason === 'connection-lost' };
    }
    case 'account-error': {
      const grantId = finiteNumber(raw.grantId);
      return grantId === null
        ? null
        : {
          type: 'account-error',
          grantId,
          message: boundedText(raw.message, MESSAGE_LIMIT) || 'DBot could not connect the account.',
        };
    }
    case 'request-otp': {
      const requestId = finiteNumber(raw.requestId);
      const accountId = boundedText(raw.accountId, ACCOUNT_LIMIT);
      return requestId === null || !accountId ? null : { type: 'request-otp', requestId, accountId };
    }
    case 'error':
      return { type: 'error', message: boundedText(raw.message, MESSAGE_LIMIT) || 'DBot could not complete that action.' };
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
 * Stamp any payload as ours *after* it is built. The control builders below
 * already carry their tag, but the data bridge is wire-only; tagging here means
 * a payload can neither be posted untagged nor spoof a different source.
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
