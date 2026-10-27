/**
 * Signal Lab embeds DBot on the same origin. The upstream version check clears
 * ALL localStorage and cookies on first use; that would delete unrelated app
 * data and credentials. Keep a namespaced marker without destructive cleanup.
 */
export const performVersionCheck = (): void => {
    try { localStorage.setItem('signal-lab-dbot-version', '2'); } catch { /* optional storage */ }
};
