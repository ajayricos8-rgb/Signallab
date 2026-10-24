// Read-only view of the Deriv application identifier configured for this app.
//
// `VITE_DERIV_APP_ID` is never modified at runtime. It identifies this client
// to Deriv's Options API in three places:
//   * the public market-data WebSocket URL, as `?app_id=...`;
//   * the `Deriv-App-ID` header on REST calls when a Personal Access Token is
//     used (Deriv requires the header for PAT authentication);
//   * the OTP request that mints the authenticated trading WebSocket URL.
// When the variable is unset the public test application ID 1089 is used.
const configuredAppId = (import.meta.env.VITE_DERIV_APP_ID || '').trim();

export const DERIV_APP_ID = configuredAppId || '1089';
export const USING_TEST_APP_ID = !configuredAppId;

/** REST base URL for Deriv's Options API v1. */
export const DERIV_REST_BASE_URL = 'https://api.derivws.com';
