// Authenticated Deriv Options trading session.
//
// Lifecycle (Deriv Options API v1):
//   1. REST  GET  /trading/v1/options/accounts          → accounts for the PAT
//   2. REST  POST /trading/v1/options/accounts/{id}/otp → single-use wss URL
//   3. WS    connect to that URL (demo or real, already authenticated)
//   4. WS    balance / portfolio / profit_table / proposal_open_contract,
//            and proposal → buy / sell for order placement
//
// The public market-data socket used by the research tools is untouched: this
// hook opens a separate authenticated socket, and Deriv's public channel does
// not accept account-scoped requests anyway.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DerivRestError,
  fetchDerivAccounts,
  forgetStoredPat,
  persistPat,
  readStoredPat,
  requestDerivOtp,
  type DerivAccount,
} from '@/lib/deriv-rest';
import {
  buildBalanceRequest,
  buildBuyRequest,
  buildContractSubscriptionRequest,
  buildPortfolioRequest,
  buildProfitTableRequest,
  buildProposalRequest,
  buildSellRequest,
  contractToClosedPosition,
  mergeClosedPositions,
  mergePortfolioPositions,
  parseBalanceMessage,
  parseBuyMessage,
  parseContractMessage,
  parseErrorMessage,
  parsePortfolioMessage,
  parseProfitTableMessage,
  parseProposalMessage,
  receiptToOpenPosition,
  removeOpenPosition,
  upsertOpenPosition,
  type DerivBuyReceipt,
  type DerivClosedPosition,
  type DerivOpenPosition,
  type DerivQuote,
  type DerivTradeRequest,
} from '@/lib/deriv-trading';

export type DerivSessionStatus = 'disconnected' | 'authorizing' | 'connecting' | 'connected' | 'error';

export type DerivTradingSession = {
  status: DerivSessionStatus;
  error: string;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  balance: number | null;
  currency: string;
  openPositions: DerivOpenPosition[];
  closedPositions: DerivClosedPosition[];
  connectedAt: number | null;
  connect: (token: string, options?: { remember?: boolean; accountId?: string }) => Promise<void>;
  selectAccount: (accountId: string) => Promise<void>;
  disconnect: () => void;
  requestQuote: (request: DerivTradeRequest) => Promise<DerivQuote>;
  confirmBuy: (quote: DerivQuote, request: DerivTradeRequest) => Promise<DerivBuyReceipt>;
  sellContract: (contractId: number) => Promise<void>;
  refresh: () => void;
  clearError: () => void;
};

type PendingRequest = {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: number;
};

const REQUEST_TIMEOUT_MS = 20_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 75_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const HISTORY_LIMIT = 50;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorText(error: unknown): string {
  if (error instanceof DerivRestError || error instanceof Error) return error.message;
  return 'Deriv rejected the request.';
}

export function useDerivTradingSession(): DerivTradingSession {
  const [status, setStatus] = useState<DerivSessionStatus>('disconnected');
  const [error, setError] = useState('');
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [currency, setCurrency] = useState('');
  const [openPositions, setOpenPositions] = useState<DerivOpenPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<DerivClosedPosition[]>([]);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef('');
  const accountRef = useRef<DerivAccount | null>(null);
  const pendingRef = useRef(new Map<number, PendingRequest>());
  const requestIdRef = useRef(1_000);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const keepAliveRef = useRef<number | undefined>(undefined);
  const lastPongRef = useRef(0);
  const manualCloseRef = useRef(false);
  const unmountedRef = useRef(false);
  const generationRef = useRef(0);

  const nextRequestId = useCallback(() => {
    requestIdRef.current = requestIdRef.current >= 2_000_000_000 ? 1_000 : requestIdRef.current + 1;
    return requestIdRef.current;
  }, []);

  const resolvePending = useCallback((reqId: number | null, message: Record<string, unknown>) => {
    if (reqId === null) return;
    const pending = pendingRef.current.get(reqId);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingRef.current.delete(reqId);
    pending.resolve(message);
  }, []);

  const rejectAllPending = useCallback((reason: string) => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    pendingRef.current.clear();
  }, []);

  const sendRequest = useCallback(
    (
      build: (reqId: number) => Record<string, unknown>,
      kind: 'proposal' | 'buy' | 'sell' | 'portfolio' | 'profit_table' | 'balance' | 'contracts',
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          reject(new Error('The Deriv trading connection is not open.'));
          return;
        }
        const reqId = nextRequestId();
        const timer = window.setTimeout(() => {
          pendingRef.current.delete(reqId);
          reject(new Error(kind === 'buy'
            ? 'Deriv did not confirm the purchase in time. Check your open positions before retrying.'
            : 'Deriv did not answer in time. Try again.'));
        }, REQUEST_TIMEOUT_MS);
        pendingRef.current.set(reqId, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify(build(reqId)));
        } catch {
          window.clearTimeout(timer);
          pendingRef.current.delete(reqId);
          reject(new Error('The trading connection rejected the request. Reconnect and try again.'));
        }
      }),
    [nextRequestId],
  );

  const scheduleRefresh = useCallback(
    (delayMs = 1_200) => {
      if (unmountedRef.current) return;
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = undefined;
        void sendRequest((reqId) => buildPortfolioRequest(reqId), 'portfolio').catch(() => undefined);
        void sendRequest((reqId) => buildProfitTableRequest(reqId, HISTORY_LIMIT), 'profit_table').catch(() => undefined);
      }, delayMs);
    },
    [sendRequest],
  );

  const handleMessage = useCallback(
    (raw: unknown) => {
      const message = asRecord(raw);
      if (!message) return;
      const reqId = typeof message.req_id === 'number' ? message.req_id : null;
      const failure = parseErrorMessage(message);
      if (failure !== null) {
        const pending = reqId === null ? undefined : pendingRef.current.get(reqId);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingRef.current.delete(reqId as number);
          pending.reject(new Error(failure));
        } else {
          setError(failure);
        }
        return;
      }

      switch (message.msg_type) {
        case 'balance': {
          const parsed = parseBalanceMessage(message);
          if (parsed) {
            setBalance(parsed.balance);
            if (parsed.currency) setCurrency(parsed.currency);
          }
          resolvePending(reqId, message);
          return;
        }
        case 'portfolio': {
          const rows = parsePortfolioMessage(message);
          if (rows.length || Array.isArray(asRecord(message.portfolio)?.contracts)) {
            setOpenPositions((current) => mergePortfolioPositions(current, rows));
          }
          resolvePending(reqId, message);
          return;
        }
        case 'profit_table': {
          const rows = parseProfitTableMessage(message);
          setClosedPositions((current) => mergeClosedPositions(current, rows));
          resolvePending(reqId, message);
          return;
        }
        case 'proposal': {
          resolvePending(reqId, message);
          return;
        }
        case 'buy': {
          resolvePending(reqId, message);
          return;
        }
        case 'sell': {
          resolvePending(reqId, message);
          scheduleRefresh(600);
          return;
        }
        case 'proposal_open_contract': {
          const position = parseContractMessage(message);
          if (position) {
            if (position.isSold) {
              setOpenPositions((current) => removeOpenPosition(current, position.contractId));
              setClosedPositions((current) => mergeClosedPositions(current, [contractToClosedPosition(position)]));
              scheduleRefresh(1_500);
            } else {
              setOpenPositions((current) => upsertOpenPosition(current, position));
            }
          }
          resolvePending(reqId, message);
          return;
        }
        case 'ping': {
          lastPongRef.current = Date.now();
          resolvePending(reqId, message);
          return;
        }
        default:
          resolvePending(reqId, message);
      }
    },
    [resolvePending, scheduleRefresh],
  );

  const closeSocket = useCallback((silent: boolean) => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (keepAliveRef.current !== undefined) {
      window.clearInterval(keepAliveRef.current);
      keepAliveRef.current = undefined;
    }
    if (!socket) return;
    if (silent) manualCloseRef.current = true;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // The socket may already be closed; nothing else to do.
    }
  }, []);

  const startKeepAlive = useCallback(() => {
    if (keepAliveRef.current !== undefined) window.clearInterval(keepAliveRef.current);
    lastPongRef.current = Date.now();
    keepAliveRef.current = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongRef.current > PONG_TIMEOUT_MS) {
        // Deriv stopped answering: drop the socket so the reconnect path runs.
        closeSocket(false);
        return;
      }
      try {
        socket.send(JSON.stringify({ ping: 1, req_id: nextRequestId() }));
      } catch {
        closeSocket(false);
      }
    }, PING_INTERVAL_MS);
  }, [closeSocket, nextRequestId]);

  const subscribeToAccountState = useCallback(() => {
    void sendRequest((reqId) => buildBalanceRequest(reqId), 'balance').catch(() => undefined);
    void sendRequest((reqId) => buildPortfolioRequest(reqId), 'portfolio').catch(() => undefined);
    void sendRequest((reqId) => buildContractSubscriptionRequest(reqId), 'contracts').catch(() => undefined);
    void sendRequest((reqId) => buildProfitTableRequest(reqId, HISTORY_LIMIT), 'profit_table').catch(() => undefined);
  }, [sendRequest]);

  const scheduleReconnect = useCallback(
    (openSocket: () => Promise<void>) => {
      if (unmountedRef.current) return;
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setStatus('error');
        setError('The Deriv trading connection closed. Reconnect to continue trading.');
        return;
      }
      const attempt = reconnectAttemptsRef.current;
      reconnectAttemptsRef.current = attempt + 1;
      setStatus('connecting');
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = undefined;
        void openSocket();
      }, 1_500 * (attempt + 1));
    },
    [],
  );

  const openSocket = useCallback(
    async (account: DerivAccount): Promise<void> => {
      const token = tokenRef.current;
      if (!token) {
        setStatus('error');
        setError('Connect a Deriv account before trading.');
        return;
      }
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      closeSocket(true);
      manualCloseRef.current = false;
      rejectAllPending('The trading connection was replaced.');
      setStatus('connecting');
      setError('');

      let url: string;
      try {
        url = await requestDerivOtp(token, account.accountId);
      } catch (tokenError) {
        if (generation !== generationRef.current || unmountedRef.current) return;
        setStatus('error');
        setError(errorText(tokenError));
        return;
      }
      if (generation !== generationRef.current || unmountedRef.current) return;

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        setStatus('error');
        setError('This browser could not open the Deriv trading socket.');
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (generation !== generationRef.current || unmountedRef.current) return;
        reconnectAttemptsRef.current = 0;
        setStatus('connected');
        setConnectedAt(Date.now());
        setError('');
        startKeepAlive();
        subscribeToAccountState();
      };
      socket.onmessage = (event) => {
        if (generation !== generationRef.current || unmountedRef.current) return;
        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data)) as unknown;
        } catch {
          setError('Deriv sent a trading message that could not be parsed.');
          return;
        }
        handleMessage(payload);
      };
      socket.onerror = () => {
        if (generation !== generationRef.current || unmountedRef.current) return;
        setError('The Deriv trading socket reported an error.');
      };
      socket.onclose = () => {
        if (generation !== generationRef.current || unmountedRef.current) return;
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        rejectAllPending('The trading connection closed before Deriv answered.');
        setOpenPositions([]);
        setConnectedAt(null);
        if (manualCloseRef.current) {
          manualCloseRef.current = false;
          setStatus('disconnected');
          return;
        }
        setError('The Deriv trading connection dropped. Reconnecting…');
        scheduleReconnect(() => openSocket(account));
      };
    },
    [closeSocket, handleMessage, rejectAllPending, scheduleReconnect, startKeepAlive, subscribeToAccountState],
  );

  const activeAccount = useMemo(
    () => accounts.find((account) => account.accountId === activeAccountId) ?? null,
    [accounts, activeAccountId],
  );

  const connect = useCallback(
    async (token: string, options?: { remember?: boolean; accountId?: string }) => {
      const trimmed = token.trim();
      if (!trimmed) {
        setStatus('error');
        setError('Enter your Deriv Personal Access Token to connect.');
        return;
      }
      setStatus('authorizing');
      setError('');
      setConnectedAt(null);
      try {
        const discovered = await fetchDerivAccounts(trimmed);
        if (unmountedRef.current) return;
        tokenRef.current = trimmed;
        setAccounts(discovered);
        const preferred =
          discovered.find((account) => account.accountId === options?.accountId) ??
          discovered.find((account) => account.accountId === accountRef.current?.accountId) ??
          discovered.find((account) => account.accountType === 'demo') ??
          discovered[0];
        accountRef.current = preferred;
        setActiveAccountId(preferred.accountId);
        if (preferred.currency) setCurrency(preferred.currency);
        if (preferred.balance !== null) setBalance(preferred.balance);
        if (options?.remember !== undefined) persistPat(trimmed, options.remember);
        await openSocket(preferred);
      } catch (connectError) {
        if (unmountedRef.current) return;
        setStatus('error');
        setError(errorText(connectError));
        if (connectError instanceof DerivRestError && connectError.unauthorized) {
          forgetStoredPat();
          tokenRef.current = '';
        }
      }
    },
    [openSocket],
  );

  const selectAccount = useCallback(
    async (accountId: string) => {
      const account = accounts.find((candidate) => candidate.accountId === accountId);
      if (!account || account.accountId === activeAccountId) return;
      accountRef.current = account;
      setActiveAccountId(account.accountId);
      setBalance(account.balance);
      setCurrency(account.currency);
      setOpenPositions([]);
      setClosedPositions([]);
      await openSocket(account);
    },
    [accounts, activeAccountId, openSocket],
  );

  const disconnect = useCallback(() => {
    generationRef.current += 1;
    manualCloseRef.current = true;
    closeSocket(false);
    rejectAllPending('Disconnected.');
    forgetStoredPat();
    tokenRef.current = '';
    accountRef.current = null;
    reconnectAttemptsRef.current = 0;
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    if (refreshTimerRef.current !== undefined) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = undefined;
    }
    setAccounts([]);
    setActiveAccountId('');
    setBalance(null);
    setCurrency('');
    setOpenPositions([]);
    setClosedPositions([]);
    setConnectedAt(null);
    setError('');
    setStatus('disconnected');
  }, [closeSocket, rejectAllPending]);

  const refresh = useCallback(() => {
    if (status !== 'connected') return;
    void sendRequest((reqId) => buildBalanceRequest(reqId), 'balance').catch(() => undefined);
    scheduleRefresh(0);
  }, [sendRequest, scheduleRefresh, status]);

  const requestQuote = useCallback(
    async (request: DerivTradeRequest): Promise<DerivQuote> => {
      const message = await sendRequest((reqId) => buildProposalRequest(request, reqId), 'proposal');
      const quote = parseProposalMessage(message);
      if (!quote) throw new Error('Deriv returned a proposal that could not be read. Nothing was purchased.');
      return quote;
    },
    [sendRequest],
  );

  const confirmBuy = useCallback(
    async (quote: DerivQuote, request: DerivTradeRequest): Promise<DerivBuyReceipt> => {
      const message = await sendRequest((reqId) => buildBuyRequest(quote, reqId), 'buy');
      const receipt = parseBuyMessage(message);
      if (!receipt) {
        throw new Error('Deriv returned a purchase receipt that could not be read. Check the trade history tab before retrying.');
      }
      if (receipt.balanceAfter !== null) setBalance(receipt.balanceAfter);
      setOpenPositions((current) => upsertOpenPosition(current, receiptToOpenPosition(receipt, request)));
      scheduleRefresh(1_200);
      return receipt;
    },
    [scheduleRefresh, sendRequest],
  );

  const sellContract = useCallback(
    async (contractId: number): Promise<void> => {
      await sendRequest((reqId) => buildSellRequest(contractId, reqId), 'sell');
      scheduleRefresh(600);
    },
    [scheduleRefresh, sendRequest],
  );

  const clearError = useCallback(() => setError(''), []);

  // Restore a stored token once, then keep the session reachable for the app's
  // lifetime. Storage never changes here — only an explicit connect does that.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const stored = readStoredPat();
    if (!stored) return;
    void connect(stored);
  }, [connect]);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      generationRef.current += 1;
      manualCloseRef.current = true;
      if (reconnectTimerRef.current !== undefined) window.clearTimeout(reconnectTimerRef.current);
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
      if (keepAliveRef.current !== undefined) window.clearInterval(keepAliveRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      }
      for (const pending of pendingRef.current.values()) window.clearTimeout(pending.timer);
      pendingRef.current.clear();
    },
    [],
  );

  return useMemo(
    () => ({
      status,
      error,
      accounts,
      activeAccount,
      balance,
      currency,
      openPositions,
      closedPositions,
      connectedAt,
      connect,
      selectAccount,
      disconnect,
      requestQuote,
      confirmBuy,
      sellContract,
      refresh,
      clearError,
    }),
    [
      accounts,
      activeAccount,
      balance,
      clearError,
      closedPositions,
      connect,
      confirmBuy,
      connectedAt,
      currency,
      disconnect,
      error,
      openPositions,
      refresh,
      requestQuote,
      selectAccount,
      sellContract,
      status,
    ],
  );
}
