import { useEffect } from 'react'
import { errorMessage, hasBridge, icloudDownloadPending } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider'

/**
 * A resume transition fires `visibilitychange` and `focus` together in
 * WKWebView (same window as the backup controller's resume triggers);
 * triggers inside this window collapse into one refresh.
 */
const RESUME_REFRESH_DEDUPE_MS = 1500

/**
 * How long to wait before the one follow-up reconcile when placeholders were
 * still pending: long enough for small note files to finish downloading,
 * short enough that a phone picked up to read a Mac edit sees it appear.
 */
const RETRY_DELAY_MS = 4000

/**
 * Keeps an iCloud-stored graph fresh while the app is used (Plan 21).
 *
 * Mobile has no file watcher — local writes notify in-process, and for git
 * graphs remote changes only arrive through pull. iCloud is different: the
 * OS lands files in the container behind the app's back, and on iOS it
 * doesn't even download them until asked. So on every app resume (and once
 * after the graph opens) this hook nudges the pending downloads and re-runs
 * the index reconcile; when placeholders were still outstanding it
 * reconciles once more shortly after, so notes appear as they land instead
 * of on the next resume.
 *
 * Inert unless an iCloud graph is open (`mobileStorageKind === 'icloud'`).
 */
export function useICloudRefresh(): void {
  const { graph, mobileStorageKind, refreshIndex } = useGraph()
  const root = mobileStorageKind === 'icloud' ? (graph?.root ?? null) : null

  useEffect(() => {
    if (root === null || !hasBridge()) {
      return
    }
    let disposed = false
    let lastRefreshAt = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const refresh = async (): Promise<void> => {
      let pending = 0
      try {
        pending = await icloudDownloadPending(root)
      } catch (err) {
        // Best-effort: reconcile anyway — already-downloaded changes still land.
        console.error('iCloud download nudge failed:', errorMessage(err))
      }
      if (disposed) {
        return
      }
      refreshIndex()
      if (pending > 0 && retryTimer === null) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (!disposed) {
            refreshIndex()
          }
        }, RETRY_DELAY_MS)
      }
    }

    const onResume = (): void => {
      const now = Date.now()
      if (now - lastRefreshAt < RESUME_REFRESH_DEDUPE_MS) {
        return
      }
      lastRefreshAt = now
      void refresh()
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        onResume()
      }
    }

    // Once on open: the reconcile that ran at open indexed what was already
    // local; this pass asks iCloud for the rest.
    onResume()
    window.addEventListener('focus', onResume)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
      }
      window.removeEventListener('focus', onResume)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [root, refreshIndex])
}
