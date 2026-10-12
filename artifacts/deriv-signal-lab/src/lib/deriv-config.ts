// Deriv App ID registered on the developers.deriv.com dashboard. App IDs are
// public client identifiers (not account tokens); VITE_DERIV_APP_ID overrides it.
export const DERIV_APP_ID = (import.meta.env.VITE_DERIV_APP_ID || '').trim() || '34mtC7NMdqSHTg3tn2WIu';

// Public market-data channel of the current Deriv Options API. No OTP or token is
// needed; the App ID is sent so the connection is attributed to this app.
export const DERIV_PUBLIC_WS_URL = `wss://api.derivws.com/trading/v1/options/ws/public?app_id=${encodeURIComponent(DERIV_APP_ID)}`;
