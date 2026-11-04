import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

/**
 * An early build of the embedded workspace registered a service worker with a
 * root scope. A worker like that keeps answering for the whole origin — the
 * shell's own HTML and the workspace document included — so a browser that ever
 * ran that build can keep replaying an old DBot bundle that never reports
 * itself ready. The shell does not use a service worker at all, so dropping
 * every registration and every cache it left behind is always safe, and it is
 * the only way to reach a browser that is already stuck in that cycle.
 */
async function dropStaleWorkspaceCaches() {
  if (typeof navigator === 'undefined') return;
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch {
    // No worker support, or the browser refused: nothing to clean up.
  }
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  } catch {
    // CacheStorage is optional too.
  }
}

void dropStaleWorkspaceCaches();

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
