import { useEffect } from 'react'
import { errorMessage, hasBridge, icloudDownloadPending, icloudPendingCount } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider'

/**
 * A resume transition fires `visibilitychange` and `focus` together in
 * WKWebView (same window as the backup controller's resume triggers);
 * triggers inside this window collapse into one refresh.
 */
const RESUME_REFRESH_DEDUPE_MS = 1500

/**
 * While placeholders are still pending, poll the count at this interval and
 * reconcile the moment it reaches zero — note files are small, so downloads
 * usually land within a poll or two and the Mac edit appears in seconds.
 */
const PENDING_POLL_MS = 1000

/** Give up polling after this long; the metadata watch and the next resume
 * still cover stragglers (a large asset on a slow link, say). */
const PENDING_POLL_LIMIT_MS = 20_000

/**
 * Keeps an iCloud-stored graph fresh while the app is used (Plan 21).
 *
 * Mobile has no file watcher — local writes notify in-process, and for git
 * graphs remote changes only arrive through pull. iCloud is different: the
 * OS lands files in the container behind the app's back, and on iOS it
 * doesn't even download them until asked. The metadata-query watch nudges
 * downloads live while the app is open; this hook covers the resume seams
 * the query can miss: on every resume it nudges the pending downloads and
 * re-runs the index reconcile, and while placeholders remain it polls the
 * pending *count* (never re-requesting), reconciling the moment downloads
 * land instead of waiting for the next resume.
 *
 * The on-open trigger only nudges: the open itself just synced the index
 * against local disk, so an immediate second full pass would repeat that
 * work — on a first sync of a large graph, at the worst possible moment.
 *
 * Downloads are sequenced notes-first: the nudge and the poll cover only
 * markdown under the note directories, and the full-scope request (assets,
 * recordings) fires once the note count drains — so a first sync's bulk
 * bytes never compete with the first index pass.
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

    // Notes download first; everything else (assets are most of the bytes)
    // is requested only once the note placeholders drain. Kicking thousands
    // of concurrent downloads at open put the whole first sync — network,
    // disk, file coordination — under the first index pass, and the app
    // crawled until it finished. Fire-and-forget: nothing polls or
    // reconciles for assets (they aren't indexed; images appear as they
    // land), and a failed request is retried by the next resume's drain.
    const requestRemainingDownloads = (): void => {
      void icloudDownloadPending(root, 'all').catch((err: unknown) => {
        console.error('iCloud asset download request failed:', errorMessage(err))
      })
    }

    const pollPending = (startedAt: number): void => {
      if (retryTimer !== null) {
        return
      }
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (disposed) {
          return
        }
        void icloudPendingCount(root, 'notes').then(
          (pending) => {
            if (disposed) {
              return
            }
            if (pending === 0) {
              // The notes landed — one reconcile picks the batch up
              // together, and the deferred bulk (assets) may start.
              refreshIndex()
              requestRemainingDownloads()
              return
            }
            if (Date.now() - startedAt >= PENDING_POLL_LIMIT_MS) {
              // Done waiting (a slow link): index what landed. The asset
              // request stays deferred — it would compete with the notes
              // still downloading; the next resume retries the sequence.
              refreshIndex()
              return
            }
            pollPending(startedAt)
          },
          (err) => {
            console.error('iCloud pending poll failed:', errorMessage(err))
            if (!disposed) {
              refreshIndex()
            }
          },
        )
      }, PENDING_POLL_MS)
    }

    const refresh = async (options: { reconcile: boolean }): Promise<void> => {
      let pending = 0
      let nudged = false
      try {
        pending = await icloudDownloadPending(root, 'notes')
        nudged = true
      } catch (err) {
        // Best-effort: reconcile anyway — already-downloaded changes still land.
        console.error('iCloud download nudge failed:', errorMessage(err))
      }
      if (disposed) {
        return
      }
      if (options.reconcile) {
        refreshIndex()
      }
      if (pending > 0) {
        pollPending(Date.now())
      } else if (nudged) {
        // A confirmed-empty note count — never a failed nudge, which would
        // start the bulk while notes may still be pending. The next resume
        // retries the whole sequence.
        requestRemainingDownloads()
      }
    }

    const onResume = (): void => {
      const now = Date.now()
      if (now - lastRefreshAt < RESUME_REFRESH_DEDUPE_MS) {
        return
      }
      lastRefreshAt = now
      void refresh({ reconcile: true })
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        onResume()
      }
    }

    // Once on open: the reconcile that ran at open indexed what was already
    // local, so this pass only asks iCloud for the rest — the poll (or the
    // live watch) reconciles once something actually lands.
    lastRefreshAt = Date.now()
    void refresh({ reconcile: false })
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
