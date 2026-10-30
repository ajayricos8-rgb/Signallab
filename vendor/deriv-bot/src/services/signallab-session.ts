/**
 * Same-origin, opt-in account bridge. Signal Lab retains the PAT and provides
 * only short-lived, single-use Deriv socket URLs for the selected account.
 * Nothing here persists credentials or starts a strategy.
 */
let accountId: string | null = null;
let initialUrl: string | null = null;
let sessionRevision = 0;
let parentGrantId: number | null = null;
let requestSequence = 0;
const pending = new Map<number, { resolve: (url: string) => void; reject: (error: Error) => void; timer: number }>();

function validUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'wss:' && (url.hostname === 'api.derivws.com' || url.hostname.endsWith('.derivws.com'));
    } catch { return false; }
}

export function linkSignalLabAccount(id: string, url: unknown, grantId: unknown): boolean {
    if (!id || !validUrl(url) || typeof grantId !== 'number') return false;
    parentGrantId = grantId;
    sessionRevision += 1;
    accountId = id;
    initialUrl = url;
    return true;
}

export function unlinkSignalLabAccount() {
    sessionRevision += 1;
    accountId = null;
    initialUrl = null;
    parentGrantId = null;
    for (const item of pending.values()) { window.clearTimeout(item.timer); item.reject(new Error('DBot account disconnected.')); }
    pending.clear();
}

export const hasSignalLabAccount = () => accountId !== null;
export const getSignalLabAccountId = () => accountId;
export const getSignalLabGrantId = () => parentGrantId;
export const getSignalLabSessionRevision = () => sessionRevision;

export async function getSignalLabSocketUrl(): Promise<string> {
    if (!accountId || window.parent === window) throw new Error('The Signal Lab account is not connected.');
    if (initialUrl) { const url = initialUrl; initialUrl = null; return url; }
    const id = ++requestSequence;
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => { pending.delete(id); reject(new Error('Signal Lab did not provide a new connection.')); }, 20_000);
        pending.set(id, { resolve, reject, timer });
        window.parent.postMessage({ source: 'signal-lab-dbot', type: 'request-otp', requestId: id, accountId }, window.location.origin);
    });
}

export function receiveSignalLabSocket(requestId: unknown, id: unknown, url: unknown, error?: unknown) {
    if (typeof requestId !== 'number') return;
    const item = pending.get(requestId);
    if (!item) return;
    pending.delete(requestId);
    window.clearTimeout(item.timer);
    if (id !== accountId || !validUrl(url)) item.reject(new Error(typeof error === 'string' ? error : 'Could not renew the DBot connection.'));
    else item.resolve(url);
}
