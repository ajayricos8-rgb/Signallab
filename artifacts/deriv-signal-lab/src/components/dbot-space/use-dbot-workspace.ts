// The DBot Space engine: iframe lifecycle, the automatic account link and the
// Signal Lab → workspace data bridge.
//
// The frame is a separate application (vendor/deriv-bot). This hook owns every
// conversation with it: it posts typed control messages, parses what comes back,
// and keeps the link state machine in one place. Nothing here renders, so the
// host page can stay a layout.
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
  type LinkSnapshot, type SharedData, type SpaceView, type WorkspaceBlockInfo, type WorkspaceTab,
} from './protocol';

/** Consecutive automatic attempts before the shell stops and asks for a click. */
export const MAX_AUTO_ATTEMPTS = 3;
/** How long a link may sit in `connecting` before it is treated as failed. */
const CONNECT_TIMEOUT_MS = 25_000;
/** One bridge frame per second: enough to keep the workspace's ticks live. */
const FEED_INTERVAL_MS = 1_000;
/** A frame that never says hello is a broken bundle, not a slow one. */
const BOOT_TIMEOUT_MS = 30_000;
const RETRY_BASE_MS = 6_000;
const RETRY_CAP_MS = 18_000;

const IDLE_LINK: LinkSnapshot = { status: 'idle', accountId: '', accountType: 'unknown' };

export type { SharedData } from './protocol';

export type DbotWorkspace = {
  /** Attach to the iframe. */
  frameRef: RefObject<HTMLIFrameElement | null>;
  /** Bumped by `reload`; also the iframe's React key. */
  frameRevision: number;
  frameLoaded: boolean;
  ready: boolean;
  workspaceError: string;
  botRunning: boolean;
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
  /** Open Deriv's own Quick strategy wizard. */
  openQuickStrategy: (strategy: string) => void;
  clearAnalysis: () => void;
  connectAccount: () => Promise<void>;
  disconnectAccount: () => void;
};

export function useDbotWorkspace({
  view,
  onOpenSettings,
  onFrameTab,
}: {
  /** The host view; a freshly ready frame is told which tab to show. */
  view: SpaceView;
  onOpenSettings: () => void;
  /** The user clicked a tab inside the frame. */
  onFrameTab: (tab: WorkspaceTab) => void;
}): DbotWorkspace {
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

  const [frameRevision, setFrameRevision] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [botRunning, setBotRunning] = useState(false);
  const [blockRegistry, setBlockRegistry] = useState<WorkspaceBlockInfo[]>([]);
  const [aiRuntimeRegistered, setAiRuntimeRegistered] = useState(false);
  const [shared, setShared] = useState<SharedData>({ markets: 0, ticks: 0 });
  const [notice, setNotice] = useState('');
  const [aiRunNotice, setAiRunNotice] = useState('');
  const [link, setLink] = useState<LinkSnapshot>(IDLE_LINK);
  const [autoLink, setAutoLink] = useState(true);
  const [autoPaused, setAutoPaused] = useState(false);

  // Refs mirror the state the message handlers and timers read. The frame's
  // events arrive outside React's render cycle, so reading state directly there
  // would act on a stale render.
  const readyRef = useRef(false);
  const linkRef = useRef<LinkSnapshot>(IDLE_LINK);
  const grantRef = useRef<string | null>(null);
  const grantRevisionRef = useRef(0);
  const autoFailuresRef = useRef(0);
  const cursorRef = useRef<BridgeCursor>({});
  const accountSentRef = useRef<BridgeAccountMessage | null>(null);
  const subscribedRef = useRef(false);
  const pendingLoadRef = useRef<{ xml: string; name: string } | null>(null);
  const pendingStrategyRef = useRef<string | null>(null);

  /** State and ref move together, so no caller can observe a half-updated link. */
  const setLinkState = useCallback((next: LinkSnapshot) => {
    linkRef.current = next;
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

  /** The account snapshot the workspace is allowed to see, or null. */
  const currentAccountMessage = useCallback((): BridgeAccountMessage | null => {
    const session = tradingRef.current;
    const account = session.activeAccount;
    if (!account || session.status !== 'connected' || grantRef.current !== account.accountId) return null;
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
    if (!account || sameAccountState(accountSentRef.current, account)) return;
    accountSentRef.current = account;
    post(account);
  }, [currentAccountMessage, post]);

  /** Tell the workspace to forget the account when the link ends. */
  const clearSharedAccount = useCallback(() => {
    if (!accountSentRef.current) return;
    accountSentRef.current = null;
    post({ type: 'signal-lab-account', accountId: '' });
  }, [post]);

  /** Count one automatic failure; after MAX_AUTO_ATTEMPTS stop retrying. */
  const failAutoLink = useCallback(() => {
    autoFailuresRef.current += 1;
    if (autoFailuresRef.current >= MAX_AUTO_ATTEMPTS) setAutoPaused(true);
  }, []);

  const sendSnapshot = useCallback(() => {
    const source = buildSource();
    const snapshot = buildBridgeSnapshot(source);
    cursorRef.current = snapshot.cursor;
    if (snapshot.message) post(snapshot.message);
    sendAccount();
    const stats = bridgeStats(source);
    setShared({ markets: stats.markets, ticks: stats.ticks });
  }, [buildSource, post, sendAccount]);

  /** Claim the account, mint a single-use socket and hand it to the frame. */
  const linkAccount = useCallback(async (automatic: boolean) => {
    if (!readyRef.current) return;
    const session = tradingRef.current;
    const account = session.activeAccount;
    if (session.status !== 'connected' || !account || grantRef.current) return;
    grantRef.current = account.accountId;
    const revision = ++grantRevisionRef.current;
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
        grantRevisionRef.current !== revision
        || grantRef.current !== socket.accountId
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
      if (grantRevisionRef.current !== revision) return;
      grantRef.current = null;
      grantRevisionRef.current += 1;
      failAutoLink();
      setLinkState(IDLE_LINK);
      setNotice(error instanceof Error ? error.message : 'Could not connect DBot to this account.');
    }
  }, [failAutoLink, post, setLinkState]);

  /** Drop a local grant without expecting the frame to answer. */
  const forgetGrant = useCallback(() => {
    grantRef.current = null;
    grantRevisionRef.current += 1;
  }, []);

  // ---- Messages from the frame -------------------------------------------
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Same origin and the exact frame: anything else is not our workspace.
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;

      switch (message.type) {
        case 'workspace-error': {
          setWorkspaceError(message.message);
          setNotice(`DBot could not finish loading: ${message.message} Reload the workspace to try again.`);
          return;
        }
        case 'block-registry': {
          setBlockRegistry(message.blocks);
          setAiRuntimeRegistered(message.aiRuntimeRegistered);
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
        case 'ready': {
          readyRef.current = true;
          setReady(true);
          setWorkspaceError('');
          setNotice((current) => (current.startsWith('DBot ') ? '' : current));
          if (viewRef.current === 'builder' || viewRef.current === 'chart') post(hostNavigate(viewRef.current));
          const pendingLoad = pendingLoadRef.current;
          if (pendingLoad) {
            pendingLoadRef.current = null;
            post(hostLoadBot(pendingLoad));
          }
          const pendingStrategy = pendingStrategyRef.current;
          if (pendingStrategy) {
            pendingStrategyRef.current = null;
            post(hostQuickStrategy(pendingStrategy));
          }
          // The frame asks for its own copy of Signal Lab's data on boot; answer
          // here too, in case that request raced the load event.
          if (subscribedRef.current) sendSnapshot();
          return;
        }
        case 'feed-subscribe': {
          // Keep the 15-market history snapshot off Blockly's critical startup
          // path: deliver the first full snapshot once the workspace is ready.
          subscribedRef.current = true;
          if (readyRef.current) sendSnapshot();
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
          if (message.accountId !== grantRef.current || message.grantId !== grantRevisionRef.current) return;
          autoFailuresRef.current = 0;
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
          if (message.grantId !== grantRevisionRef.current) return;
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
          if (message.grantId !== grantRevisionRef.current) return;
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
          const valid = grantRef.current === message.accountId
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
          const revision = grantRevisionRef.current;
          void session.createBotSocket().then((socket) => {
            if (
              grantRevisionRef.current !== revision
              || grantRef.current !== message.accountId
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

  // A frame that never reports ready is broken. Say so instead of leaving the
  // host on "Connecting workspace" forever.
  useEffect(() => {
    if (!frameLoaded || ready || workspaceError) return;
    const timer = window.setTimeout(() => {
      setWorkspaceError('DBot did not become ready. The workspace bundle may not have loaded correctly.');
      setNotice('DBot did not become ready. Reload the workspace to try again.');
    }, BOOT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [frameLoaded, ready, workspaceError]);

  // A grant belongs to one exact account. Switching or disconnecting in
  // Settings revokes it and stops the bot rather than quietly trading another.
  useEffect(() => {
    if (!grantRef.current) return;
    if (trading.activeAccount?.accountId !== grantRef.current || trading.status !== 'connected') {
      post(hostDisconnectAccount(grantRevisionRef.current));
      clearSharedAccount();
      forgetGrant();
      autoFailuresRef.current = 0;
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
    if (grantRef.current || autoFailuresRef.current >= MAX_AUTO_ATTEMPTS) return;
    const delay = autoFailuresRef.current === 0
      ? 0
      : Math.min(RETRY_BASE_MS * autoFailuresRef.current, RETRY_CAP_MS);
    const timer = window.setTimeout(() => { void linkAccount(true); }, delay);
    return () => window.clearTimeout(timer);
  }, [autoLink, ready, link.status, trading.status, trading.activeAccount?.accountId, linkAccount]);

  // A different account gets a fresh set of automatic attempts.
  useEffect(() => {
    autoFailuresRef.current = 0;
    setAutoPaused(false);
  }, [trading.activeAccount?.accountId]);

  // A link that is never confirmed is a failed link, not a pending one.
  useEffect(() => {
    if (link.status !== 'connecting') return;
    const timer = window.setTimeout(() => {
      post(hostDisconnectAccount(grantRevisionRef.current));
      clearSharedAccount();
      forgetGrant();
      failAutoLink();
      setLinkState(IDLE_LINK);
      setNotice('DBot did not confirm the account connection. Check the connection and try again.');
    }, CONNECT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [link.status, post, clearSharedAccount, forgetGrant, failAutoLink, setLinkState]);

  // Stream the ticks Signal Lab already holds, one frame a second carrying only
  // ticks the frame has not seen, plus the account snapshot when it changes.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      const source = buildSource();
      const update = buildBridgeUpdate(source, cursorRef.current);
      cursorRef.current = update.cursor;
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
    setWorkspaceError('');
    readyRef.current = false;
    setReady(false);
    setBlockRegistry([]);
    setAiRuntimeRegistered(false);
    setBotRunning(false);
    setAiRunNotice('');
    subscribedRef.current = false;
    cursorRef.current = {};
    accountSentRef.current = null;
    if (grantRef.current) {
      forgetGrant();
      setLinkState(IDLE_LINK);
      setNotice('The workspace reloaded and the account link ended. A running strategy has stopped; open contracts may still settle. Reconnecting…');
    }
    post(hostHello());
  }, [forgetGrant, post, setLinkState]);

  /** Boot a brand-new workspace: the frame starts on its default template. */
  const reload = useCallback(() => {
    readyRef.current = false;
    setFrameLoaded(false);
    setWorkspaceError('');
    setReady(false);
    setFrameRevision((revision) => revision + 1);
    setNotice('Reloading the DBot workspace…');
  }, []);

  const showTab = useCallback((next: SpaceView) => {
    if ((next === 'builder' || next === 'chart') && readyRef.current) post(hostNavigate(next));
  }, [post]);

  const loadBot = useCallback((xml: string, name: string) => {
    if (!readyRef.current) {
      pendingLoadRef.current = { xml, name };
      setNotice('The bot will load as soon as the workspace connects.');
      return false;
    }
    post(hostLoadBot({ xml, name }));
    return true;
  }, [post]);

  const loadAndRunBot = useCallback((xml: string, name: string, analysis: unknown) => {
    if (!readyRef.current) return false;
    post(hostLoadBot({ xml, name, runAfterLoad: true, analysisSnapshot: analysis }));
    return true;
  }, [post]);

  const openQuickStrategy = useCallback((strategy: string) => {
    if (!readyRef.current) {
      pendingStrategyRef.current = strategy;
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
    if (linkRef.current.status !== 'idle') return;
    if (!readyRef.current) {
      setNotice('Wait for the bot workspace to finish connecting before linking an account.');
      return;
    }
    const session = tradingRef.current;
    if (session.status !== 'connected' || !session.activeAccount) {
      onOpenSettings();
      return;
    }
    autoFailuresRef.current = 0;
    setAutoPaused(false);
    setAutoLink(true);
    await linkAccount(false);
  }, [linkAccount, onOpenSettings]);

  const disconnectAccount = useCallback(() => {
    if (!window.confirm('Stop the DBot link and pause automatic linking? Open contracts may continue to settle on Deriv.')) return;
    post(hostDisconnectAccount(grantRevisionRef.current));
    clearSharedAccount();
    forgetGrant();
    setAutoLink(false);
    setLinkState(IDLE_LINK);
    setNotice('DBot unlinked and automatic linking paused. Press Link account to resume.');
  }, [post, clearSharedAccount, forgetGrant, setLinkState]);

  return {
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
    reload,
    showTab,
    loadBot,
    loadAndRunBot,
    openQuickStrategy,
    clearAnalysis,
    connectAccount,
    disconnectAccount,
  };
}
