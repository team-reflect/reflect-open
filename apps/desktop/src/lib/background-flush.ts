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
  // on the same buffers and git index, so triggers coalesce while one runs.
  let inFlight: Promise<void> | null = null
  const flush = (): void => {
    if (inFlight !== null) {
      return
    }
    // Buffers and settings land first so the commit captures them. Failures
    // are surfaced by the save pipeline / next launch's sync — backgrounding
    // must never be blocked on them.
    inFlight = Promise.allSettled([flushOpenDocuments(), flushSettings()])
      .then(() => flushBackup())
      .finally(() => {
        inFlight = null
      })
  }
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', flush)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', flush)
  }
}
