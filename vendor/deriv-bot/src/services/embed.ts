// Is this DBot running as the workspace inside the Signal Lab shell?
//
// The embedded workspace is a panel of another application, not a standalone
// app: it must never open a modal of its own accord over the shell's chrome, and
// it must never depend on a second chunk to become usable. Both facts are needed
// in several places, so they live here instead of being re-derived per module.
export function isEmbeddedWorkspace(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    // Access to `window.parent` refused: a framed document. Treat as embedded.
    return true;
  }
}
