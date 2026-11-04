// The only module that talks to the embedded Deriv Bot workspace.
//
// The workspace is a separate application in an iframe: official Deriv Bot
// (`vendor/deriv-bot`, deriv-com/bot) with a small host-channel patch on top.
// This hook owns the iframe lifecycle, the boot handshake, the bounded restart
// policy, the Signal Lab tick/account bridge and the automatic account link.
// It renders nothing, so the page can be composed around it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { useMarketFeed } from '@/components/market-feed-provider';
import {
  bridgeStats, buildAccountMessage, buildBridgeSnapshot, buildBridgeUpdate, sameAccountState,
  type BridgeAccountMessage, type BridgeCursor, type BridgeSourceMarket,
} from '@/lib/dbot-bridge';
import {
  hostConnectAccount, hostDisconnectAccount, hostHello, hostLoadBot, hostNavigate,
  parseFrameMessage, type HostView, type SharedData, type WorkspaceBlockInfo,
  type WorkspaceTab,
} from './protocol';

/** How often the shell re-asks a booting frame for `ready`. */
const HELLO_RETRY_MS = 2_000;
/** A document that never announces itself is broken, not slow. */
const DOCUMENT_TIMEOUT_MS = 12_000;
/** A document that announced itself but never painted. */
const BOOT_TIMEOUT_MS = 30_000;
/** Automatic restarts, and the run length that earns them back. */
const MAX_AUTO_RELOADS = 2;
const STABLE_RUN_MS = 60_000;
/** Frame documents allowed before the shell calls it a restart loop. */
const MAX_FRAME_BOOTS = 3;
/** One frame per second keeps the workspace's ticks live. */
const FEED_INTERVAL_MS = 1_000;

export function useDbotFrame() {
  const trading = useDerivTrading();
  const feed = useMarketFeed();
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const [frameRevision, setFrameRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [botRunning, setBotRunning] = useState(false);
  const [blockRegistry, setBlockRegistry] = useState<WorkspaceBlockInfo[]>([]);
  const [shared, setShared] = useState<SharedData>({ markets: 0, ticks: 0 });
  /** Which Signal Lab panel the workspace's tab bar is showing. */
  const [hostView, setHostView] = useState<HostView>(null);
  /** Bottom edge of the workspace tab bar, in iframe viewport pixels. */
  const [tabsBottom, setTabsBottom] = useState(0);
  /** Bumped every time the workspace asks for the shell's sign-in dialog. */
  const [loginRequest, setLoginRequest] = useState(0);

  const tradingRef = useRef(trading);
  tradingRef.current = trading;

  const runtime = useRef({
    ready: false,
    alive: false,
    boots: 0,
    autoReloads: 0,
    stableSince: Date.now(),
    bootedAt: Date.now(),
    cursor: {} as BridgeCursor,
    accountSent: null as BridgeAccountMessage | null,
    grant: null as string | null,
    grantRevision: 0,
    pendingLoad: null as { xml: string; name: string; run: boolean } | null,
  });

  /** What Signal Lab is willing to share with the workspace, right now. */
  const sourceOf = useCallback((): BridgeSourceMarket[] => (
    feed.getSnapshot().map((market) => ({
      symbol: market.symbol,
      name: market.name,
      pipSize: market.pipSize,
      ticks: market.ticks,
    }))
  ), [feed]);

  const post = useCallback((payload: object) => {
    frameRef.current?.contentWindow?.postMessage(payload, window.location.origin);
  }, []);

  const sendAccount = useCallback(() => {
    const session = tradingRef.current;
    const account = session.activeAccount;
    if (!account || session.status !== 'connected' || runtime.current.grant !== account.accountId) return;
    const message = buildAccountMessage({
      accountId: account.accountId,
      accountType: account.accountType === 'real' ? 'real' : account.accountType === 'demo' ? 'demo' : 'unknown',
      balance: session.balance ?? account.balance,
      currency: session.currency || account.currency,
      openPositions: session.openPositions,
      closedPositions: session.closedPositions,
    });
    if (sameAccountState(runtime.current.accountSent, message)) return;
    runtime.current.accountSent = message;
    post(message);
  }, [post]);

  // ---- boot: hello retry with a bounded restart policy --------------------
  useEffect(() => {
    if (ready) return;
    const timer = window.setInterval(() => {
      const state = runtime.current;
      const elapsed = Date.now() - state.bootedAt;
      if (elapsed >= (state.alive ? BOOT_TIMEOUT_MS : DOCUMENT_TIMEOUT_MS)) {
        if (state.autoReloads < MAX_AUTO_RELOADS && state.boots <= MAX_FRAME_BOOTS) {
          state.autoReloads += 1;
          setFrameRevision((revision) => revision + 1);
          setNotice(
            state.alive
              ? 'The DBot workspace did not answer, so it was reloaded again.'
              : 'The workspace bundle did not load, so it was reloaded with a fresh copy.',
          );
          return;
        }
        setError(
          state.alive
            ? 'The DBot workspace keeps restarting. Reload it to try again.'
            : 'The DBot workspace did not load. Reload it to fetch a fresh copy.',
        );
        return;
      }
      post(hostHello());
    }, HELLO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [ready, post, frameRevision]);

  // A new document restarts the clock; the restart budget deliberately survives.
  useEffect(() => {
    runtime.current.bootedAt = Date.now();
    runtime.current.alive = false;
    runtime.current.ready = false;
    runtime.current.cursor = {};
    runtime.current.accountSent = null;
    setReady(false);
    setHostView(null);
  }, [frameRevision]);

  // ---- messages from the workspace ---------------------------------------
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      const state = runtime.current;
      switch (message.type) {
        case 'alive':
          state.alive = true;
          state.boots += 1;
          return;
        case 'ready': {
          state.ready = true;
          if (Date.now() - state.stableSince > STABLE_RUN_MS) state.autoReloads = 0;
          state.stableSince = Date.now();
          setReady(true);
          setError('');
          setNotice('');
          post(hostNavigate('builder'));
          const pending = state.pendingLoad;
          if (pending) {
            state.pendingLoad = null;
            post(hostLoadBot({ xml: pending.xml, name: pending.name, runAfterLoad: pending.run }));
          }
          const snapshot = buildBridgeSnapshot(sourceOf());
          state.cursor = snapshot.cursor;
          if (snapshot.message) post(snapshot.message);
          sendAccount();
          return;
        }
        case 'block-registry':
          setBlockRegistry(message.blocks);
          return;
        case 'bot-status':
          setBotRunning(message.running);
          return;
        case 'host-view':
          setHostView(message.view);
          return;
        case 'tabs-geometry':
          setTabsBottom(message.bottom);
          return;
        case 'login-request':
          setLoginRequest((count) => count + 1);
          return;
        case 'account-mode': {
          const mode = message.mode;
          const accounts = tradingRef.current.accounts;
          const target = accounts.find((entry) => (
            mode === 'demo' ? entry.accountType !== 'real' : entry.accountType === 'real'
          ));
          if (!target) {
            setNotice(`This token has no ${mode} account to switch to.`);
            return;
          }
          setNotice(`Switching the workspace to ${mode}…`);
          void tradingRef.current.selectAccount(target.accountId);
          return;
        }
        case 'workspace-error':
          state.ready = false;
          setReady(false);
          setError(message.message);
          return;
        case 'account-connected':
          setNotice('');
          return;
        case 'account-error':
          setNotice(message.message);
          return;
        case 'account-disconnected':
          state.grant = null;
          setNotice('The account link ended. Reconnecting…');
          return;
        default:
          return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post, sendAccount, sourceOf]);

  // ---- bridge: ticks and account, once a second --------------------------
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      const source = sourceOf();
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
  }, [ready, post, sendAccount, sourceOf]);

  // ---- automatic account link: no second login ---------------------------
  const linkAccount = useCallback(async () => {
    const session = tradingRef.current;
    const account = session.activeAccount;
    if (!runtime.current.ready || session.status !== 'connected' || !account || runtime.current.grant) return;
    runtime.current.grant = account.accountId;
    const revision = ++runtime.current.grantRevision;
    try {
      const socket = await session.createBotSocket();
      if (runtime.current.grantRevision !== revision) return;
      post(hostConnectAccount({
        grantId: revision,
        accountId: socket.accountId,
        url: socket.url,
        accountType: socket.accountType,
      }));
    } catch {
      runtime.current.grant = null;
      setNotice('Could not connect the workspace to this account. It will retry.');
    }
  }, [post]);

  useEffect(() => {
    if (!ready) return;
    if (trading.status !== 'connected' || !trading.activeAccount) return;
    if (runtime.current.grant === trading.activeAccount.accountId) return;
    const timer = window.setTimeout(() => { void linkAccount(); }, 0);
    return () => window.clearTimeout(timer);
  }, [ready, trading.status, trading.activeAccount, linkAccount]);

  /** A grant belongs to one exact account: switching or losing it unlinks. */
  useEffect(() => {
    const grant = runtime.current.grant;
    if (!grant) return;
    if (trading.activeAccount?.accountId === grant && trading.status === 'connected') return;
    runtime.current.grant = null;
    post(hostDisconnectAccount(runtime.current.grantRevision));
  }, [trading.activeAccount?.accountId, trading.status, post]);

  // ---- commands ----------------------------------------------------------
  const loadBot = useCallback((xml: string, name: string, run = false) => {
    if (!runtime.current.ready) {
      runtime.current.pendingLoad = { xml, name, run };
      setNotice('The bot will load as soon as the workspace is ready.');
      return;
    }
    post(hostLoadBot({ xml, name, runAfterLoad: run }));
  }, [post]);

  const reload = useCallback(() => {
    runtime.current.autoReloads = 0;
    runtime.current.boots = 0;
    runtime.current.stableSince = Date.now();
    setError('');
    setReady(false);
    setFrameRevision((revision) => revision + 1);
  }, []);

  const showTab = useCallback((tab: WorkspaceTab) => {
    // The workspace answers with `host-view: null`, but clearing here keeps the
    // panel from lingering over the builder for a frame or two.
    setHostView(null);
    if (runtime.current.ready) post(hostNavigate(tab));
  }, [post]);

  return useMemo(() => ({
    frameRef,
    frameRevision,
    ready,
    error,
    notice,
    botRunning,
    blockRegistry,
    aiRuntimeRegistered: blockRegistry.length > 0,
    shared,
    hostView,
    tabsBottom,
    loginRequest,
    reload,
    showTab,
    loadBot,
    loadAndRun: (xml: string, name: string) => loadBot(xml, name, true),
    setNotice,
  }), [
    frameRevision, ready, error, notice, botRunning, blockRegistry, shared,
    hostView, tabsBottom, loginRequest, reload, showTab, loadBot,
  ]);
}
