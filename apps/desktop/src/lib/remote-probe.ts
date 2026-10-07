/** How often a visible desktop window asks the remote whether it moved. */
export const REMOTE_PROBE_MS = 90_000

/**
 * Poll the remote while the window is visible: `moved` runs once per tick
 * (one ref-advertisement round trip, no fetch) and `onMoved` runs only when
 * it reports that the remote tip moved past the last fetch. Focus and resume
 * cover a window that comes back; this covers the one that never left while
 * another device pushed. A failed probe is silent: the next tick retries,
 * and a real outage shows up in the cycle it would have started. Returns the
 * disposer.
 */
export function attachRemoteProbe(moved: () => Promise<boolean>, onMoved: () => void): () => void {
  const timer = setInterval(() => {
    if (document.visibilityState !== 'visible') {
      return
    }
    moved().then(
      (didMove) => {
        if (didMove) {
          onMoved()
        }
      },
      () => {},
    )
  }, REMOTE_PROBE_MS)
  return () => clearInterval(timer)
}
