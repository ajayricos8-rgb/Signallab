import ReactDOM from 'react-dom/client';
import { AuthWrapper } from './app/AuthWrapper';
import { installChunkRecovery } from './services/chunk-recovery';
import { installSignalLabHost } from './services/signallab-host';
import { AnalyticsInitializer } from './utils/analytics';
import { registerPWA } from './utils/pwa-utils';
import './styles/index.scss';

/** True when DBot is the embedded workspace inside the Signal Lab shell. */
const isEmbedded = window.parent !== window;

// Answer the shell before React paints: it retries `hello` until it hears
// `ready`, and `alive` tells it the document itself reached the browser.
installSignalLabHost();
// A chunk from a previous deployment must not strand the workspace: recover
// with a bounded reload (see services/chunk-recovery).
installChunkRecovery();

AnalyticsInitializer();

if (isEmbedded) {
    // Never register the root-scoped service worker from inside the workspace:
    // it would take over the host app as well, and a stale cache is exactly how
    // an embedded bundle fails to load after a deploy.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker
            .getRegistrations()
            .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
            .catch(() => {
                // Nothing registered, or the browser refused: both are fine.
            });
    }
} else {
    registerPWA()
        .then(registration => {
            if (registration) console.log('PWA service worker registered successfully for Chrome');
            else console.log('PWA service worker disabled for non-Chrome browser');
        })
        .catch(error => {
            console.error('PWA service worker registration failed:', error);
        });
}

ReactDOM.createRoot(document.getElementById('root')!).render(<AuthWrapper />);
