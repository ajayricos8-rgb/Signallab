// Recover from a chunk that the current page can no longer fetch.
//
// The workspace is deployed to a CDN (Cloudflare Workers assets) and every
// build replaces the hashed chunks. A page that was loaded a moment before a
// deploy still holds the older `index` runtime, so the first lazy import it
// makes can ask for a chunk that only exists in the other version. Cloudflare
// serves each version atomically, so the request fails and webpack raises
// `ChunkLoadError` — which React Router then renders as a raw stack trace over
// the whole workspace.
//
// The fix is one reload: the fresh document is served the current chunk graph.
// This module makes that automatic, but bounded — a real 404 must not become a
// reload loop, so a second failure inside the retry window is left to the route
// error boundary, which offers a manual retry.
const RETRY_WINDOW_MS = 20_000;
const RETRY_KEY = 'signal-lab:dbot:chunk-reload';

/** Text a webpack/rsbuild chunk failure can carry across browsers. */
const CHUNK_FAILURE_PATTERNS = [
  /Loading chunk [\w.-]+ failed/i,
  /Loading CSS chunk [\w.-]+ failed/i,
  /ChunkLoadError/,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
];

let installed = false;

/** Readable one-liner for a thrown value, used by the route error UI. */
export function messageOfError(value: unknown): string {
  return messageOf(value) || 'The workspace stopped while loading.';
}

function messageOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

/** True for anything that means "this chunk is not on the server any more". */
export function isChunkLoadFailure(value: unknown): boolean {
  if (!value) return false;
  const name = value && typeof value === 'object' ? (value as { name?: unknown }).name : undefined;
  if (name === 'ChunkLoadError') return true;
  const text = messageOf(value);
  return CHUNK_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function readLastAttempt(): number {
  try {
    return Number(window.sessionStorage.getItem(RETRY_KEY) ?? 0) || 0;
  } catch {
    return Date.now(); // No storage: never auto-reload, the boundary can still.
  }
}

function writeLastAttempt(at: number) {
  try {
    window.sessionStorage.setItem(RETRY_KEY, String(at));
  } catch {
    // Storage is a convenience here, not a requirement.
  }
}

/**
 * Reload once for a stale chunk graph. Returns `true` when the reload was
 * started, `false` when this page already tried too recently.
 */
export function recoverFromChunkFailure(): boolean {
  if (typeof window === 'undefined') return false;
  const now = Date.now();
  if (now - readLastAttempt() < RETRY_WINDOW_MS) return false;
  writeLastAttempt(now);
  window.location.reload();
  return true;
}

/** A workspace that booted is healthy again: allow a future retry. */
export function clearChunkRecoveryGuard() {
  try {
    window.sessionStorage.removeItem(RETRY_KEY);
  } catch {
    // Nothing stored.
  }
}

/**
 * Only the workspace's own bundle counts as a chunk.
 *
 * This used to accept any `<script>` whose URL looked like `.js`, which meant a
 * blocked third-party script — Google Tag Manager, the Survicate survey widget,
 * any analytics tag — reloaded the whole workspace. That is the one failure an
 * ad blocker guarantees, and it turned a working builder into a page that kept
 * restarting itself. A chunk from this app always shares the document's origin
 * and lives under its `static/js` folder.
 */
export function isScriptChunkFailure(event: Event): boolean {
  const target = event.target as HTMLScriptElement | null;
  if (!target || typeof target.tagName !== 'string' || target.tagName.toUpperCase() !== 'SCRIPT') return false;
  const src = target.src || '';
  if (!src) return false;
  try {
    const url = new URL(src, window.location.origin);
    if (url.origin !== window.location.origin) return false;
    return /\/static\/js\//.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Watch for chunk failures anywhere in the frame: a failed `<script>` tag, a
 * rejected dynamic import, or an error thrown by the loader. Idempotent.
 */
export function installChunkRecovery() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'error',
    (event) => {
      if (isScriptChunkFailure(event) || isChunkLoadFailure((event as ErrorEvent).error)) {
        recoverFromChunkFailure();
      }
    },
    true,
  );
  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadFailure((event as PromiseRejectionEvent).reason)) recoverFromChunkFailure();
  });
}
