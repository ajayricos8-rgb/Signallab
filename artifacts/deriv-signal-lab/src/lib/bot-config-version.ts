// One-time config migration for the premium bots.
//
// The bots store their configuration in `localStorage`. When a default that
// gates execution changes — an entry-delay interval, a warm-up, an
// expected-value brake that blocked every trade — a browser that still holds
// the old values would keep the old behaviour and the fix would never reach it.
//
// A per-bot version marker next to the stored config solves that: when the
// marker is missing or older than the code's, that bot's config is rebuilt from
// the current defaults exactly once. Nothing else is touched, no trade log is
// lost, and the operator's next edit is kept again under the new version.
export const BOT_CONFIG_VERSION = 2;

const MARKER_SUFFIX = '-version';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when the stored config for `configKey` predates this build. */
export function configNeedsReset(configKey: string, version: number = BOT_CONFIG_VERSION): boolean {
  const store = storage();
  if (!store) return false;
  try {
    return store.getItem(`${configKey}${MARKER_SUFFIX}`) !== String(version);
  } catch {
    return false;
  }
}

/** Records that the current defaults are now the stored shape for `configKey`. */
export function markConfigVersion(configKey: string, version: number = BOT_CONFIG_VERSION): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(`${configKey}${MARKER_SUFFIX}`, String(version));
  } catch {
    // Private browsing: the reset simply happens again next time.
  }
}
