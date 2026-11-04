// Host control channel: the embedded DBot workspace ↔ the Signal Lab shell.
//
// The shell (src/components/dbot-space) owns the iframe. It posts `hello` when
// the frame loads and keeps re-posting it until it hears `ready`, so a slow
// first paint can never turn into "DBot did not become ready" — the handshake
// is retried instead of being a single shot.
//
// This module is installed from `main.tsx` *before* React renders, which means
// the workspace answers the shell even while the bot builder is still booting.
// `ready` still means "the builder is on screen": it is only announced from
// `markWorkspaceMounted()`, and a `hello` that arrives earlier is simply not
// answered — the shell asks again.
import { clearChunkRecoveryGuard } from './chunk-recovery';
import { connectSignalLabBridge } from './signallab-feed';

/**
 * The account link pulls in DBot's whole API layer, so it is loaded on demand:
 * boot must never wait on it, and the handshake module stays testable on its own.
 */
const loadAccountModule = () => import('./signallab-account');

/** Tag on every message the shell posts into the frame. */
const HOST_SOURCE = 'signal-lab';
/** Tag on every message this frame posts back to the shell. */
const FRAME_SOURCE = 'signal-lab-dbot';

type HostMessage = {
  source?: unknown;
  type?: unknown;
  [key: string]: unknown;
};

let installed = false;
let mounted = false;

/**
 * How long the shell may wait for `ready` before this frame reports the stall
 * itself. The workspace boot has its own deadlines (a Deriv socket, the remote
 * config check and the first paint each time out after a few seconds), so a
 * frame that is still silent here is not booting any more — it is stuck, and
 * saying so turns the shell's spinner into a Reload button.
 */
const BOOT_WATCHDOG_MS = 25_000;

/** The bundle the browser actually loaded, for the shell's diagnostics. */
function loadedBuild(): string {
  try {
    const script = Array.from(document.querySelectorAll('script[src]'))
      .map((element) => (element as HTMLScriptElement).getAttribute('src') || '')
      .find((src) => /\/static\/js\/index\.[\w-]+\.js/.test(src));
    return script || 'unknown';
  } catch {
    return 'unknown';
  }
}

function post(message: Record<string, unknown>) {
  if (typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage({ source: FRAME_SOURCE, ...message }, window.location.origin);
}

/** The builder is on screen: the shell may drop its loading overlay. */
export function markWorkspaceMounted() {
  const first_paint = !mounted;
  mounted = true;
  // The workspace booted: a later chunk failure deserves a fresh retry.
  clearChunkRecoveryGuard();
  post({ type: 'ready' });
  // Ask for Signal Lab's ticks at the same moment the blocks become usable.
  if (first_paint) post({ type: 'feed-subscribe' });
}

/** True once the builder has painted at least once. */
export function isWorkspaceMounted() {
  return mounted;
}

/** Surface a hard boot failure to the shell instead of a silent blank frame. */
export function reportWorkspaceError(message: string) {
  post({ type: 'workspace-error', message: String(message || 'DBot stopped with an error.').slice(0, 400) });
}

function switchTab(tab: unknown) {
  if (tab !== 'builder' && tab !== 'chart') return;
  // DBot owns its tab state; the shell asks through a DOM event so this module
  // stays free of store imports, and the workspace keeps working standalone.
  window.dispatchEvent(new CustomEvent('signal-lab:navigate', { detail: tab }));
}

function handleAccountConnect(message: HostMessage) {
  const grant_id = message.grantId;
  const account_id = message.accountId;
  const url = message.url;
  if (typeof grant_id !== 'number' || typeof account_id !== 'string' || !account_id) return;
  if (typeof url !== 'string' || !url.startsWith('wss://')) {
    post({
      type: 'account-error',
      grantId: grant_id,
      message: 'Signal Lab did not send a usable account socket for the workspace.',
    });
    return;
  }
  const account_type = message.accountType === 'real' || message.accountType === 'demo' ? message.accountType : null;
  void loadAccountModule()
    .then((account) => account.connectSignalLabAccount({
      grantId: grant_id,
      accountId: account_id,
      url,
      accountType: account_type,
    }))
    .catch(() => post({
      type: 'account-error',
      grantId: grant_id,
      message: 'The workspace could not load the account link. Reload the workspace to try again.',
    }));
}

function handleHostMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  const message = event.data as HostMessage | null;
  if (!message || typeof message !== 'object' || message.source !== HOST_SOURCE) return;
  switch (message.type) {
    case 'hello':
      // A shell that reloaded/remounted asks again; answer only when there is a
      // builder to show, otherwise it will retry `hello` in a moment.
      if (mounted) post({ type: 'ready' });
      post({ type: 'feed-subscribe' });
      return;
    case 'navigate':
      switchTab(message.tab);
      return;
    case 'connect-account':
      handleAccountConnect(message);
      return;
    case 'disconnect-account':
      void loadAccountModule()
        .then((account) => account.disconnectSignalLabAccount())
        .catch(() => undefined);
      return;
    default:
      // `load-bot`, `quick-strategy` and `clear-analysis` have no handler here
      // yet; ignoring them keeps the workspace usable instead of throwing.
      return;
  }
}

/**
 * Idempotent install. Safe to call from the shell's own boot and from React,
 * and a no-op when the app runs standalone (not inside the shell).
 */
export function installSignalLabHost() {
  if (installed || typeof window === 'undefined' || window.parent === window) return;
  installed = true;
  window.addEventListener('message', handleHostMessage);
  // Announce the document before React exists: the shell can then tell "the
  // workspace is still booting" apart from "the document never ran DBot at
  // all" (a stale cached copy, or a host shell served in place of the frame).
  post({ type: 'alive', build: loadedBuild() });
  window.setTimeout(() => {
    if (!mounted) {
      post({
        type: 'workspace-error',
        message: 'The workspace did not finish starting. Reload it to try again.',
      });
    }
  }, BOOT_WATCHDOG_MS);
  // Ticks are the workspace's only data source: subscribe before the builder
  // mounts so Signal Lab blocks have a cache to read on their first run.
  connectSignalLabBridge();
}
