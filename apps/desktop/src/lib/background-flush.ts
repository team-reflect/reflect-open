import { beginBackgroundTask, endBackgroundTask, type BackgroundTaskToken } from '@reflect/core'
import { flushOpenDocuments } from '@/editor/open-documents'
import { flushBackup } from '@/lib/backup-flush'
import { flushSettings } from '@/lib/settings-flush'

/**
 * The mobile leg of quit-time persistence (Plan 19, decision 6). Desktop's
 * exits are window close / ⌘Q / reload (`quit-flush.ts`); on mobile the exit
 * is *backgrounding*: iOS suspends the process soon after the app leaves the
 * foreground and may kill it outright, and note saves debounce — so a
 * mid-debounce edit would die with the webview. On every hide the same flush
 * sequence as desktop quit runs: note buffers and settings land first, then
 * the backup flusher makes a **local commit** (never a push — the next resume
 * cycle pushes, exactly like desktop quit).
 *
 * Two triggers, both belt-and-braces on iOS:
 * - `visibilitychange` → hidden: app switcher, home, lock. iOS grants a grace
 *   window after backgrounding, and the write IPCs reach the Rust process
 *   even if the webview never sees their responses.
 * - `pagehide`: webview teardown (dev reloads; some termination paths).
 */
export function installBackgroundFlush(): () => void {
  // One backgrounding fires several triggers at once (iOS emits both
  // `visibilitychange` and `pagehide`); a second chain would race the first
  // on the same buffers and git index. Triggers during an in-flight chain
  // queue exactly one follow-up (the engine's single-flight shape) rather
  // than being dropped: a quick foreground-edit-background while the first
  // chain is still landing must still get its flush, or that edit dies with
  // the process. The trailing chain is a cheap no-op when nothing changed.
  let inFlight: Promise<void> | null = null
  let rerun = false
  let hidden = document.visibilityState === 'hidden'
  let transition = hidden ? 1 : 0
  let lastRequestedTransition = 0

  const runProtectedFlush = async (): Promise<void> => {
    // Acquire before issuing any write IPC. If iOS cannot grant more time (or
    // browser/mobile dev has no native command), the flush remains best-effort.
    let backgroundTask: BackgroundTaskToken | null = null
    try {
      backgroundTask = await beginBackgroundTask()
    } catch {
      // Native protection is unavailable; still land as much as possible.
    }

    try {
      await Promise.allSettled([flushOpenDocuments(), flushSettings()])
      await flushBackup()
    } finally {
      if (backgroundTask !== null) {
        try {
          await endBackgroundTask(backgroundTask)
        } catch {
          // UIKit's expiration callback also ends an outstanding assertion.
          // Backgrounding cannot surface cleanup failures into the webview.
        }
      }
    }
  }

  const flush = (): void => {
    if (inFlight !== null) {
      rerun = true
      return
    }
    // Buffers and settings land first so the commit captures them. Failures
    // are surfaced by the save pipeline / next launch's sync — backgrounding
    // must never be blocked on them. The catch also guarantees cleanup errors
    // cannot become an unhandled rejection from this fire-and-forget trigger.
    inFlight = runProtectedFlush()
      .catch(() => {})
      .finally(() => {
        inFlight = null
        if (rerun) {
          rerun = false
          flush()
        }
      })
  }

  const flushTransition = (): void => {
    if (lastRequestedTransition === transition) {
      return
    }
    lastRequestedTransition = transition
    flush()
  }
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      if (!hidden) {
        hidden = true
        transition += 1
      }
      flushTransition()
    } else {
      hidden = false
    }
  }
  const onPageHide = (): void => {
    // Usually follows visibilitychange for the same transition. When it is
    // the only signal (some teardown/reload paths), create its transition.
    if (!hidden) {
      hidden = true
      transition += 1
    }
    flushTransition()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageHide)
  }
}
