// Deriv application identifier configured for this app.
//
// Identifies this client to Deriv's API in three places:
//   * the public market-data WebSocket URL, as `?app_id=...`;
//   * the `Deriv-App-ID` header on REST calls when a Personal Access Token is
//     used (Deriv requires the header for PAT authentication);
//   * the OTP request that mints the authenticated trading WebSocket URL.

export const DEFAULT_DERIV_APP_ID = '34mtC7NMdqSHTg3tn2WIu';

function getInitialAppId(): string {
  try {
    const stored = window.localStorage.getItem('signal-lab-deriv-app-id');
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // localStorage not accessible
  }
  const envVal = (import.meta.env.VITE_DERIV_APP_ID || '').trim();
  return envVal || DEFAULT_DERIV_APP_ID;
}

export const DERIV_APP_ID = getInitialAppId();
export const USING_TEST_APP_ID = DERIV_APP_ID === '1089';

/** REST base URL for Deriv's Options API v1. */
export const DERIV_REST_BASE_URL = 'https://api.derivws.com';

/** Save custom app ID to browser storage */
export function persistAppId(appId: string): void {
  try {
    if (appId.trim()) {
      window.localStorage.setItem('signal-lab-deriv-app-id', appId.trim());
    } else {
      window.localStorage.removeItem('signal-lab-deriv-app-id');
    }
  } catch {
    // Ignore storage errors
  }
}
