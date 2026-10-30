import { getSocketURL } from '@/components/shared';
import { getSignalLabSessionRevision, hasSignalLabAccount } from '@/services/signallab-session';
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import APIMiddleware from './api-middleware';

/**
 * Singleton instance management for DerivAPI
 */
let derivApiInstance = null;
let derivApiPromise = null;
let currentWebSocketURL = null;
let instanceRevision = 0;

/**
 * Clears the singleton instance (useful for logout or forced reconnection)
 */
export const clearDerivApiInstance = () => {
    instanceRevision += 1;
    if (derivApiInstance?.connection) {
        try {
            derivApiInstance.connection.close();
        } catch (error) {
            console.error('[DerivAPI] Error closing WebSocket:', error);
        }
    }
    derivApiInstance = null;
    derivApiPromise = null;
    currentWebSocketURL = null;
};

/**
 * Generates a Deriv API instance with WebSocket connection using singleton pattern
 * Prevents multiple WebSocket connections by reusing existing instance
 * Now supports async WebSocket URL fetching with authenticated flow
 * @param {boolean} forceNew - Force creation of new instance (default: false)
 * @returns Promise with DerivAPIBasic instance
 */
export const generateDerivApiInstance = async (forceNew = false) => {
    // If forcing new instance, clear existing one
    if (forceNew) {
        console.log('[DerivAPI] Forcing new instance creation');
        clearDerivApiInstance();
    }

    // If there's already an instance, check its state
    if (derivApiInstance) {
        const readyState = derivApiInstance.connection?.readyState;
        // Return existing instance if it's connecting or open
        if (readyState === WebSocket.CONNECTING || readyState === WebSocket.OPEN) {
            console.log('[DerivAPI] Reusing existing instance (state:', readyState, ')');
            return derivApiInstance;
        } else {
            // Connection is closed or closing, clear it
            console.log('[DerivAPI] Existing instance not usable (state:', readyState, '), creating new');
            clearDerivApiInstance();
        }
    }

    // If there's already a creation in progress, return that promise
    if (derivApiPromise) {
        console.log('[DerivAPI] Reusing existing creation promise');
        return derivApiPromise;
    }

    // A pending URL fetch must not resurrect a connection after revocation.
    const creationRevision = instanceRevision;
    // Create new instance
    derivApiPromise = (async () => {
        try {
            // Remember the particular grant used to create this connection.
            const isSignalLabSocket = hasSignalLabAccount();
            const signalLabRevision = getSignalLabSessionRevision();
            const wsURL = await getSocketURL();
            if (creationRevision !== instanceRevision || (isSignalLabSocket && (!hasSignalLabAccount() || signalLabRevision !== getSignalLabSessionRevision()))) {
                throw new Error('DBot connection request was superseded.');
            }

            // Check if URL changed (account switch scenario)
            if (currentWebSocketURL && currentWebSocketURL !== wsURL) {
                throw new Error('A different DBot socket is already active.');
            }

            currentWebSocketURL = wsURL;

            // The URL may contain a single-use credential; never log it.
            console.log('[DerivAPI] Creating WebSocket connection');
            const deriv_socket = new WebSocket(wsURL);
            const deriv_api = new DerivAPIBasic({
                connection: deriv_socket,
                middleware: new APIMiddleware({}),
            });

            // Store the instance immediately (don't wait for connection)
            derivApiInstance = deriv_api;

            // Set up close handler to clear instance
            deriv_socket.addEventListener('close', () => {
                if (isSignalLabSocket && hasSignalLabAccount() && signalLabRevision === getSignalLabSessionRevision()) {
                    // Fail closed: stop the bot and revoke the grant before the
                    // upstream socket handlers attempt an automatic reconnect.
                    window.dispatchEvent(new Event('signallab-dbot-socket-closed'));
                }
                console.log('[DerivAPI] WebSocket connection closed');
                if (derivApiInstance === deriv_api) {
                    derivApiInstance = null;
                    currentWebSocketURL = null;
                }
            });

            // Log when connection opens
            deriv_socket.addEventListener('open', () => {
                console.log('[DerivAPI] WebSocket connection established');
            });

            deriv_socket.addEventListener('error', error => {
                console.error('[DerivAPI] WebSocket connection error:', error);
            });

            return deriv_api;
        } catch (error) {
            console.error('[DerivAPI] Error creating instance:', error);
            if (creationRevision === instanceRevision) {
                derivApiPromise = null;
                derivApiInstance = null;
            }
            throw error;
        } finally {
            // Clear the promise after a short delay to allow reuse during concurrent calls
            setTimeout(() => {
                if (creationRevision === instanceRevision) derivApiPromise = null;
            }, 100);
        }
    })();

    return derivApiPromise;
};

export const getLoginId = () => {
    const login_id = sessionStorage.getItem('signal-lab-dbot-active_loginid');
    if (login_id && login_id !== 'null') return login_id;
    return null;
};

export const V2GetActiveAccountId = () => {
    const account_id = sessionStorage.getItem('signal-lab-dbot-active_loginid');
    if (account_id && account_id !== 'null') return account_id;
    return null;
};

export const getToken = () => {
    const active_loginid = getLoginId();
    const client_accounts = JSON.parse(sessionStorage.getItem('signal-lab-dbot-accountsList')) ?? undefined;
    const active_account = (client_accounts && client_accounts[active_loginid]) || {};
    return {
        token: active_account ?? undefined,
        account_id: active_loginid ?? undefined,
    };
};
