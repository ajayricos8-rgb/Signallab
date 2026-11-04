// Runtime engine of the rebuilt DBot Space shell.
//
// The frame is a separate application. This hook is the only place that talks
// to it: it boots the iframe, keeps the automatic account-link state machine,
// re-mints single-use sockets when the frame asks, and streams Signal Lab's own
// ticks/account into the frame once a second. It renders nothing — the page,
// header, frame chrome and store are independent components.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { useMarketFeed } from '@/components/market-feed-provider';
import {
  bridgeStats, buildAccountMessage, buildBridgeSnapshot, buildBridgeUpdate, sameAccountState,
  type BridgeAccountMessage, type BridgeCursor, type BridgeSourceMarket,
} from '@/lib/dbot-bridge';
import {
  hostClearAnalysis, hostConnectAccount, hostDisconnectAccount, hostHello, hostLoadBot, hostNavigate,
  hostOtpResponse, hostQuickStrategy, parseFrameMessage, tagHostPayload, viewForWorkspaceTab,
  type LinkSnapshot, type LinkStatus, type SharedData, type SpaceView, type WorkspaceBlockInfo, type WorkspaceTab,
} from './protocol';

/** Consecutive automatic attempts before the shell stops and asks for a click. */
export const MAX_AUTO_ATTEMPTS = 3;
/** How long a link may sit in `connecting` before it is treated as failed. */
const CONFIRM_TIMEOUT_MS = 25_000;
/** One frame per second keeps the workspace's ticks live without flooding it. */
const FEED_INTERVAL_MS = 1_000;
/** A frame that never says hello is a broken bundle, not a slow one. */
const BOOT_TIMEOUT_MS = 30_000;
/**
 * A document that never even announces itself is not "slow": the browser ran
 * something else, or a cached copy of the workspace replaced it. Waiting the
 * full boot timeout for that just extends the cycle, so it gets a much shorter
 * leash before the shell reloads the frame with a fresh URL.
 */
const DOCUMENT_TIMEOUT_MS = 12_000;
/** How often the shell re-asks the frame for `ready` while it boots. */
const HELLO_RETRY_MS = 2_000;
const RETRY_BASE_MS = 6_000;
const RETRY_CAP_MS = 18_000;

const IDLE_LINK: LinkSnapshot = { status: 'idle', accountId: '', accountType: 'unknown' };

export type SessionLimit = { reason: 'take-profit' | 'stop-loss'; profit: number; currency: string };

/** Mutable values read by message handlers and timers, outside React renders. */
type Runtime = {
  ready: boolean;
  /** Mirrors the rendered link status for handlers that run before a render. */
  linkStatus: LinkStatus;
  grant: string | null;
  grantRevision: number;
  autoFailures: number;
  cursor: BridgeCursor;
  accountSent: BridgeAccountMessage | null;
  subscribed: boolean;
  pendingLoad: { xml: string; name: string } | null;
  pendingStrategy: string | null;
};

export type WorkspaceEngine = {
  /** Attach to the iframe. */
  frameRef: RefObject<HTMLIFrameElement | null>;
  /** Bumped by `reload`; also the iframe's React key. */
  frameRevision: number;
  frameLoaded: boolean;
  ready: boolean;
  workspaceError: string;
  botRunning: boolean;
  sessionLimit: SessionLimit | null;
  setSessionLimit: (value: SessionLimit | null) => void;
  blockRegistry: WorkspaceBlockInfo[];
  aiRuntimeRegistered: boolean;
  shared: SharedData;
  notice: string;
  aiRunNotice: string;
  link: LinkSnapshot;
  autoLink: boolean;
  autoPaused: boolean;
  setNotice: (message: string) => void;
  setAiRunNotice: (message: string) => void;
  /** Send the frame its hello; also used as the iframe `onLoad`. */
  handleFrameLoad: () => void;
  /** Tear the frame down and boot a fresh one on the default template. */
  reload: () => void;
  /** Sync the frame's internal tab with a host view. */
  showTab: (view: SpaceView) => void;
  /** Load a bot XML; queues until the frame is ready. */
  loadBot: (xml: string, name: string) => boolean;
  /** Load a bot and start it with an exact analysis snapshot. */
  loadAndRunBot: (xml: string, name: string, analysis: unknown) => boolean;
  loadAnalysisBot: (xml: string, name: string, analysis: unknown) => boolean;
  /** Open Deriv's own Quick strategy wizard. */
  openQuickStrategy: (strategy: string) => void;
  clearAnalysis: () => void;
  connectAccount: () => Promise<void>;
  disconnectAccount: () => void;
};

export type { SharedData } from './protocol';

export function useWorkspaceEngine({
  view,
  onOpenSettings,
  onFrameTab,
}: {
  /** The host view; a freshly ready frame is told which tab to show. */
  view: SpaceView;
  onOpenSettings: () => void;
  /** The user clicked a tab inside the frame. */
  onFrameTab: (tab: WorkspaceTab) => void;
}): WorkspaceEngine {
  const trading = useDerivTrading();
  const feed = useMarketFeed();

  const frameRef = useRef<HTMLIFrameElement>(null);
  const tradingRef = useRef(trading);
  tradingRef.current = trading;
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const viewRef = useRef(view);
  viewRef.current = view;
  const onFrameTabRef = useRef(onFrameTab);
  onFrameTabRef.current = onFrameTab;
  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;

  const [frameRevision, setFrameRevision] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [botRunning, setBotRunning] = useState(false);
  const [sessionLimit, setSessionLimit] = useState<SessionLimit | null>(null);
  const [blockRegistry, setBlockRegistry] = useState<WorkspaceBlockInfo[]>([]);
  const [aiRuntimeRegistered, setAiRuntimeRegistered] = useState(false);
  const [shared, setShared] = useState<SharedData>({ markets: 0, ticks: 0 });
  const [notice, setNotice] = useState('');
  const [aiRunNotice, setAiRunNotice] = useState('');
  const [link, setLink] = useState<LinkSnapshot>(IDLE_LINK);
  const [autoLink, setAutoLink] = useState(true);
  const [autoPaused, setAutoPaused] = useState(false);

  /** One automatic reload per boot before the host reports a dead frame. */
  const autoReloaded = useRef(false);
  /** The frame's document ran: `alive` arrived. Distinguishes slow from broken. */
  const frameAlive = useRef(false);
  /** When the current frame document started loading, for the boot watchdog. */
  const frameBootedAt = useRef(0);

  const runtime = useRef<Runtime>({
    ready: false,
    linkStatus: 'idle',
    grant: null,
    grantRevision: 0,
    autoFailures: 0,
    cursor: {},
    accountSent: null,
    subscribed: false,
    pendingLoad: null,
    pendingStrategy: null,
  });

  /** State and runtime move together, so no caller sees a half-updated link. */
  const setLinkState = useCallback((next: LinkSnapshot) => {
    runtime.current.linkStatus = next.status;
    setLink(next);
  }, []);

  /** Every message leaves through here, so every message is tagged as ours. */
  const post = useCallback((message: object) => {
    frameRef.current?.contentWindow?.postMessage(tagHostPayload(message), window.location.origin);
  }, []);

  const buildSource = useCallback((): BridgeSourceMarket[] => (
    feedRef.current.getSnapshot().map((market) => ({
      symbol: market.symbol,
      name: market.name,
      pipSize: market.pipSize,
      ticks: market.ticks,
    }))
  ), []);

  /** The account snapshot the workspace may see; null before the grant exists. */
  const currentAccountMessage = useCallback((): BridgeAccountMessage | null => {
    const session = tradingRef.current;
    const account = session.activeAccount;
    if (!account || session.status !== 'connected' || runtime.current.grant !== account.accountId) return null;
    return buildAccountMessage({
      accountId: account.accountId,
      accountType: account.accountType === 'real' ? 'real' : account.accountType === 'demo' ? 'demo' : 'unknown',
      balance: session.balance ?? account.balance,
      currency: session.currency || account.currency,
      openPositions: session.openPositions,
      closedPositions: session.closedPositions,
    });
  }, []);

  const sendAccount = useCallback(() => {
    const account = currentAccountMessage();
    if (!account || sameAccountState(runtime.current.accountSent, account)) return;
    runtime.current.accountSent = account;
    post(account);
  }, [currentAccountMessage, post]);

  /** Tell the workspace to forget the account when the link ends. */
  const clearSharedAccount = useCallback(() => {
    if (!runtime.current.accountSent) return;
    runtime.current.accountSent = null;
    post({ type: 'signal-lab-account', accountId: '' });
  }, [post]);

  /** Count one automatic failure; after MAX_AUTO_ATTEMPTS stop retrying. */
  const failAutoLink = useCallback(() => {
    runtime.current.autoFailures += 1;
    if (runtime.current.autoFailures >= MAX_AUTO_ATTEMPTS) setAutoPaused(true);
  }, []);

  const sendSnapshot = useCallback(() => {
    const source = buildSource();
    const snapshot = buildBridgeSnapshot(source);
    runtime.current.cursor = snapshot.cursor;
    if (snapshot.message) post(snapshot.message);
    sendAccount();
    const stats = bridgeStats(source);
    setShared({ markets: stats.markets, ticks: stats.ticks });
  }, [buildSource, post, sendAccount]);

  /** Drop a local grant without expecting the frame to answer. */
  const forgetGrant = useCallback(() => {
    runtime.current.grant = null;
    runtime.current.grantRevision += 1;
  }, []);

  /** Claim the account, mint a single-use socket and hand it to the frame. */
  const linkAccount = useCallback(async (automatic: boolean) => {
    if (!runtime.current.ready) return;
    const session = tradingRef.current;
    const account = session.activeAccount;
    if (session.status !== 'connected' || !account || runtime.current.grant) return;
    runtime.current.grant = account.accountId;
    const revision = ++runtime.current.grantRevision;
    setLinkState({
      status: 'connecting',
      accountId: account.accountId,
      accountType: account.accountType === 'real' ? 'real' : 'demo',
    });
    setNotice(automatic
      ? `Linking ${account.accountId} from Signal Lab automatically…`
      : `Connecting DBot to ${account.accountId}…`);
    try {
      const socket = await session.createBotSocket();
      // The account may have changed while the OTP was in flight; a grant is
      // only ever valid for the exact account it was minted for.
      if (
        runtime.current.grantRevision !== revision
        || runtime.current.grant !== socket.accountId
        || tradingRef.current.activeAccount?.accountId !== socket.accountId
        || tradingRef.current.status !== 'connected'
      ) return;
      post(hostConnectAccount({
        grantId: revision,
        accountId: socket.accountId,
        url: socket.url,
        accountType: socket.accountType,
      }));
    } catch (error) {
      if (runtime.current.grantRevision !== revision) return;
      forgetGrant();
      failAutoLink();
      setLinkState(IDLE_LINK);
      setNotice(error instanceof Error ? error.message : 'Could not connect DBot to this account.');
    }
  }, [failAutoLink, forgetGrant, post, setLinkState]);

  // ---- Messages from the frame -------------------------------------------
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Same origin and the exact frame: anything else is not our workspace.
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;

      switch (message.type) {
        case 'workspace-error': {
          // A frame that failed after saying `ready` is still broken: drop the
          // ready flag so the panel overlay and its Reload button cover it,
          // and let the hello retry start the boot timeout again.
          runtime.current.ready = false;
          setReady(false);
          setWorkspaceError(message.message);
          setNotice(`DBot could not finish loading: ${message.message} Reload the workspace to try again.`);
          return;
        }
        case 'block-registry': {
          setBlockRegistry(message.blocks);
          setAiRuntimeRegistered(message.aiRuntimeRegistered);
          return;
        }
        case 'session-limit-hit': {
          setSessionLimit({ reason: message.reason, profit: message.profit, currency: message.currency });
          return;
        }
        case 'bot-status': {
          setBotRunning(message.running);
          return;
        }
        case 'bot-run-started': {
          setBotRunning(true);
          setAiRunNotice(message.message);
          return;
        }
        case 'alive': {
          // The bundle reached the browser. The builder still has to paint, and
          // `ready` remains the only signal that it did.
          frameAlive.current = true;
          return;
        }
        case 'ready': {
          runtime.current.ready = true;
          autoReloaded.current = false;
          setReady(true);
          setWorkspaceError('');
          setNotice((current) => (current.startsWith('DBot ') ? '' : current));
          if (viewRef.current === 'builder' || viewRef.current === 'chart') post(hostNavigate(viewRef.current));
          const pendingLoad = runtime.current.pendingLoad;
          if (pendingLoad) {
            runtime.current.pendingLoad = null;
            post(hostLoadBot(pendingLoad));
          }
          const pendingStrategy = runtime.current.pendingStrategy;
          if (pendingStrategy) {
            runtime.current.pendingStrategy = null;
            post(hostQuickStrategy(pendingStrategy));
          }
          // The frame asks for its own copy of Signal Lab's data on boot; answer
          // here too, in case that request raced the load event.
          if (runtime.current.subscribed) sendSnapshot();
          return;
        }
        case 'feed-subscribe': {
          // Keep the 15-market history snapshot off Blockly's critical startup
          // path: deliver the first full snapshot once the workspace is ready.
          runtime.current.subscribed = true;
          if (runtime.current.ready) sendSnapshot();
          return;
        }
        case 'quick-strategy-open': {
          // The wizard's footer is fixed to the iframe, not to the host
          // viewport. Bring it above the host's fixed navigation on small
          // screens.
          window.requestAnimationFrame(() => {
            const bottom = frameRef.current?.getBoundingClientRect().bottom;
            if (bottom && bottom > window.innerHeight - 90) {
              window.scrollBy({ top: bottom - window.innerHeight + 90, behavior: 'smooth' });
            }
          });
          return;
        }
        case 'active-tab': {
          if (viewRef.current !== 'builder' && viewRef.current !== 'chart') return;
          const tab = viewForWorkspaceTab(message.tab);
          if (tab) onFrameTabRef.current(tab);
          return;
        }
        case 'account-connected': {
          if (message.accountId !== runtime.current.grant || message.grantId !== runtime.current.grantRevision) return;
          runtime.current.autoFailures = 0;
          setAutoPaused(false);
          setLinkState({
            status: 'connected',
            accountId: message.accountId,
            accountType: tradingRef.current.activeAccount?.accountType === 'real' ? 'real' : 'demo',
          });
          setNotice('DBot is using the Signal Lab account. Its ticks, balance and open positions are shared with the workspace.');
          sendSnapshot();
          return;
        }
        case 'account-disconnected': {
          if (message.grantId !== runtime.current.grantRevision) return;
          forgetGrant();
          clearSharedAccount();
          setLinkState(IDLE_LINK);
          if (message.connectionLost) {
            failAutoLink();
            setNotice('The DBot connection closed, so the strategy was stopped. Open contracts may still settle. Reconnecting to the Signal Lab account…');
          }
          return;
        }
        case 'account-error': {
          if (message.grantId !== runtime.current.grantRevision) return;
          forgetGrant();
          clearSharedAccount();
          failAutoLink();
          setLinkState(IDLE_LINK);
          setNotice(message.message);
          return;
        }
        case 'bot-loaded': {
          const copy = message.runAfterLoad
            ? `${message.name} loaded; DBot is starting the guarded strategy…`
            : `${message.name} is on the canvas. Review the market, stake and limits before you run it.`;
          setNotice(copy);
          setAiRunNotice(copy);
          return;
        }
        case 'request-otp': {
          const session = tradingRef.current;
          const valid = runtime.current.grant === message.accountId
            && session.activeAccount?.accountId === message.accountId
            && session.status === 'connected';
          if (!valid) {
            post(hostOtpResponse({
              requestId: message.requestId,
              accountId: message.accountId,
              error: 'The selected Signal Lab account is no longer connected.',
            }));
            return;
          }
          const revision = runtime.current.grantRevision;
          void session.createBotSocket().then((socket) => {
            if (
              runtime.current.grantRevision !== revision
              || runtime.current.grant !== message.accountId
              || tradingRef.current.activeAccount?.accountId !== message.accountId
              || tradingRef.current.status !== 'connected'
            ) {
              post(hostOtpResponse({
                requestId: message.requestId,
                accountId: message.accountId,
                error: 'The account changed while reconnecting.',
              }));
              return;
            }
            post(hostOtpResponse({ requestId: message.requestId, accountId: message.accountId, url: socket.url }));
          }).catch((error: unknown) => {
            post(hostOtpResponse({
              requestId: message.requestId,
              accountId: message.accountId,
              error: error instanceof Error ? error.message : 'Could not reconnect DBot.',
            }));
          });
          return;
        }
        case 'error': {
          setNotice(message.message);
          setAiRunNotice(message.message);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [clearSharedAccount, failAutoLink, forgetGrant, post, sendSnapshot, setLinkState]);

  // The frame answers `hello` with `ready` once its builder has painted. A
  // single hello can be missed (lazy chunks, a cached frame that mounts before
  // the listener, a slow first paint), so keep asking until it answers instead
  // of turning a late frame into "DBot did not become ready".
  useEffect(() => {
    if (!frameLoaded || ready) return;
    const ask = () => post(hostHello());
    const timer = window.setInterval(ask, HELLO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [frameLoaded, ready, post]);

  // A grant belongs to one exact account. Switching or disconnecting in
  // Settings revokes it and stops the bot rather than quietly trading another.
  useEffect(() => {
    if (!runtime.current.grant) return;
    if (trading.activeAccount?.accountId !== runtime.current.grant || trading.status !== 'connected') {
      post(hostDisconnectAccount(runtime.current.grantRevision));
      clearSharedAccount();
      forgetGrant();
      runtime.current.autoFailures = 0;
      setAutoPaused(false);
      setLinkState(IDLE_LINK);
      setNotice('DBot was disconnected because the Signal Lab account changed or disconnected. Open contracts may still settle.');
    }
  }, [trading.activeAccount?.accountId, trading.status, post, clearSharedAccount, forgetGrant, setLinkState]);

  // Automatic linking: the workspace uses whichever account Signal Lab has,
  // with no button and no second login. Only a failure streak pauses it.
  useEffect(() => {
    if (!autoLink || !ready || link.status !== 'idle') return;
    if (trading.status !== 'connected' || !trading.activeAccount) return;
    if (runtime.current.grant || runtime.current.autoFailures >= MAX_AUTO_ATTEMPTS) return;
    const delay = runtime.current.autoFailures === 0
      ? 0
      : Math.min(RETRY_BASE_MS * runtime.current.autoFailures, RETRY_CAP_MS);
    const timer = window.setTimeout(() => { void linkAccount(true); }, delay);
    return () => window.clearTimeout(timer);
  }, [autoLink, ready, link.status, trading.status, trading.activeAccount?.accountId, linkAccount]);

  // A different account gets a fresh set of automatic attempts.
  useEffect(() => {
    runtime.current.autoFailures = 0;
    setAutoPaused(false);
  }, [trading.activeAccount?.accountId]);

  // A link that is never confirmed is a failed link, not a pending one.
  useEffect(() => {
    if (link.status !== 'connecting') return;
    const timer = window.setTimeout(() => {
      post(hostDisconnectAccount(runtime.current.grantRevision));
      clearSharedAccount();
      forgetGrant();
      failAutoLink();
      setLinkState(IDLE_LINK);
      setNotice('DBot did not confirm the account connection. Check the connection and try again.');
    }, CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [link.status, post, clearSharedAccount, forgetGrant, failAutoLink, setLinkState]);

  // Stream the ticks Signal Lab already holds, one frame a second carrying only
  // ticks the frame has not seen, plus the account snapshot when it changes.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      const source = buildSource();
      const update = buildBridgeUpdate(source, runtime.current.cursor);
      runtime.current.cursor = update.cursor;
      if (update.message) post(update.message);
      sendAccount();
      const stats = bridgeStats(source);
      setShared((previous) => (
        previous.markets === stats.markets && previous.ticks === stats.ticks
          ? previous
          : { markets: stats.markets, ticks: stats.ticks }
      ));
    }, FEED_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ready, buildSource, post, sendAccount]);

  const handleFrameLoad = useCallback(() => {
    setFrameLoaded(true);
    // A reported boot failure is only cleared by an explicit `reload()`. A
    // late `load` event must not wipe the error card and start the cycle again.
    frameAlive.current = false;
    frameBootedAt.current = Date.now();
    runtime.current.ready = false;
    runtime.current.subscribed = false;
    runtime.current.cursor = {};
    runtime.current.accountSent = null;
    setReady(false);
    setBlockRegistry([]);
    setAiRuntimeRegistered(false);
    setBotRunning(false);
    setAiRunNotice('');
    if (runtime.current.grant) {
      forgetGrant();
      setLinkState(IDLE_LINK);
      setNotice('The workspace reloaded and the account link ended. A running strategy has stopped; open contracts may still settle. Reconnecting…');
    }
    post(hostHello());
  }, [forgetGrant, post, setLinkState]);

  /** Boot a brand-new workspace: the frame starts on its default template. */
  const reload = useCallback(() => {
    runtime.current.ready = false;
    setFrameLoaded(false);
    setWorkspaceError('');
    setReady(false);
    setFrameRevision((revision) => revision + 1);
    setNotice('Reloading the DBot workspace…');
  }, []);

  /** A reload the user asked for gets its own automatic attempt back. */
  const retryWorkspace = useCallback(() => {
    autoReloaded.current = false;
    reload();
  }, [reload]);

  // A silent frame gets one clean retry before the host reports a failure: a
  // chunk that failed to fetch (flaky network, a deploy mid-session) is fixed by
  // loading the bundle again, and that is worth one automatic attempt.
  // Every mount of the frame starts a new clock. It is deliberately not tied to
  // the frame's load event: a document that never loads (a 404, a blocked or
  // substituted response) fires no `load` at all, and waiting for one is what
  // left the workspace on "Connecting workspace" with no way out.
  useEffect(() => {
    frameBootedAt.current = Date.now();
    frameAlive.current = false;
  }, [frameRevision]);

  useEffect(() => {
    if (ready || workspaceError) return;
    const timer = window.setInterval(() => {
      // A document that never said `alive` failed to load, not to boot: reload
      // it early (with a fresh URL — see `reload`) instead of sitting on a
      // spinner for the whole boot timeout.
      const silent = !frameAlive.current;
      const elapsed = Date.now() - (frameBootedAt.current || Date.now());
      if (elapsed < (silent ? DOCUMENT_TIMEOUT_MS : BOOT_TIMEOUT_MS)) return;
      if (!autoReloaded.current) {
        autoReloaded.current = true;
        reload();
        setNotice(
          silent
            ? 'The workspace bundle did not load, so it was reloaded with a fresh copy.'
            : 'The DBot workspace did not answer, so it was reloaded once.',
        );
        return;
      }
      setWorkspaceError(
        silent
          ? 'The DBot workspace did not load. A cached copy may be blocking it — reload to fetch a fresh one.'
          : 'DBot did not become ready. The workspace bundle may not have loaded correctly.',
      );
      setNotice('DBot did not become ready. Reload the workspace to try again.');
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [ready, workspaceError, reload]);

  const showTab = useCallback((next: SpaceView) => {
    if ((next === 'builder' || next === 'chart') && runtime.current.ready) post(hostNavigate(next));
  }, [post]);

  const loadBot = useCallback((xml: string, name: string) => {
    if (!runtime.current.ready) {
      runtime.current.pendingLoad = { xml, name };
      setNotice('The bot will load as soon as the workspace connects.');
      return false;
    }
    post(hostLoadBot({ xml, name }));
    return true;
  }, [post]);

  const loadAnalysisBot = useCallback((xml: string, name: string, analysis: unknown) => {
    if (!runtime.current.ready) return false;
    post(hostLoadBot({ xml, name, analysisSnapshot: analysis }));
    return true;
  }, [post]);

  const loadAndRunBot = useCallback((xml: string, name: string, analysis: unknown) => {
    if (!runtime.current.ready) return false;
    setSessionLimit(null);
    post(hostLoadBot({ xml, name, runAfterLoad: true, analysisSnapshot: analysis }));
    return true;
  }, [post]);

  const openQuickStrategy = useCallback((strategy: string) => {
    if (!runtime.current.ready) {
      runtime.current.pendingStrategy = strategy;
      setNotice('The strategy form will open as soon as the workspace connects.');
      return;
    }
    post(hostQuickStrategy(strategy));
  }, [post]);

  const clearAnalysis = useCallback(() => {
    post(hostClearAnalysis());
  }, [post]);

  /** Manual link: resumes automatic linking after a pause. */
  const connectAccount = useCallback(async () => {
    if (runtime.current.linkStatus !== 'idle') return;
    if (!runtime.current.ready) {
      setNotice('Wait for the bot workspace to finish connecting before linking an account.');
      return;
    }
    const session = tradingRef.current;
    if (session.status !== 'connected' || !session.activeAccount) {
      onOpenSettingsRef.current();
      return;
    }
    runtime.current.autoFailures = 0;
    setAutoPaused(false);
    setAutoLink(true);
    await linkAccount(false);
  }, [linkAccount]);

  const disconnectAccount = useCallback(() => {
    if (!window.confirm('Stop the DBot link and pause automatic linking? Open contracts may continue to settle on Deriv.')) return;
    post(hostDisconnectAccount(runtime.current.grantRevision));
    clearSharedAccount();
    forgetGrant();
    setAutoLink(false);
    setLinkState(IDLE_LINK);
    setNotice('DBot unlinked and automatic linking paused. Press Link account to resume.');
  }, [post, clearSharedAccount, forgetGrant, setLinkState]);

  return {
    sessionLimit, setSessionLimit,
    frameRef,
    frameRevision,
    frameLoaded,
    ready,
    workspaceError,
    botRunning,
    blockRegistry,
    aiRuntimeRegistered,
    shared,
    notice,
    aiRunNotice,
    link,
    autoLink,
    autoPaused,
    setNotice,
    setAiRunNotice,
    handleFrameLoad,
    reload: retryWorkspace,
    showTab,
    loadBot,
    loadAndRunBot,
    loadAnalysisBot,
    openQuickStrategy,
    clearAnalysis,
    connectAccount,
    disconnectAccount,
  };
}
