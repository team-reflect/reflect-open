import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { homeDir, join } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import {
  deleteGraph as deleteGraphCommand,
  errorMessage,
  forgetRecent,
  hasBridge,
  createGraph,
  openGraph,
  recentGraphs,
  type AppPlatform,
  type GraphInfo,
  type RecentGraph,
} from '@reflect/core'
import { followHealedMove } from '@/editor/move-note'
import { resetNoteRowOverlays } from '@/hooks/note-row-overlay'
import { setIndexProgress } from '@/lib/index-progress'
import { dropIcloudStatusQuery, throttledInvalidateIndexQueries } from '@/lib/query-client'
import { ensureWelcomeNote } from '@/lib/welcome-note'
import { closeSecondaryWindows } from '@/lib/windows/close-secondary-windows'
import { isMainWindow, requireMainWindow } from '@/lib/windows/window-role'
import { createGraphIndex } from './graph-index'
import { useDesktopGraphBoot } from './use-desktop-graph-boot'
import { useMobileGraphBoot, type MobileGraphBoot } from './use-mobile-graph-boot'
import { useNoteWindowBoot } from './use-note-window-boot'

/** Lifecycle of the active graph (Plan 02 loading gate). */
export type GraphStatus = 'loading' | 'choosing' | 'opening' | 'ready'

/**
 * The graph context surface. The mobile-only slice (`needsOnboarding`,
 * storage roots, `completeOnboarding`) is documented on
 * {@link MobileGraphBoot}, whose hook owns it.
 */
interface GraphContextValue extends MobileGraphBoot {
  status: GraphStatus
  graph: GraphInfo | null
  recents: RecentGraph[]
  /**
   * The open **index session** generation (from `index_open`) — distinct from
   * `graph.generation` (the file-write generation): the two counters are
   * independent in Rust. Index-gated commands (`index_*`, `embed_*`,
   * `db_query` writes via the pipelines) must echo THIS one; `note_write`
   * and friends take `graph.generation`. Null when the index failed to open.
   */
  indexGeneration: number | null
  /** True while the background index reconcile is running (Plan 06b). */
  indexing: boolean
  error: string | null
  /** Show the OS folder picker, then open (and bootstrap) the chosen graph. */
  pickAndOpen: () => Promise<void>
  /** Close the active graph and show the desktop graph chooser. */
  chooseGraph: () => Promise<void>
  /**
   * Create (and open) a graph at an app-chosen absolute path — desktop
   * onboarding's iCloud path names the folder inside the container instead
   * of showing a picker. Resolves true only on a confirmed open.
   */
  createAt: (root: string) => Promise<boolean>
  /** Open a graph by its root path. Resolves true only when it reached 'ready'. */
  openRecent: (root: string) => Promise<boolean>
  /** Drop a graph from the recents list. */
  forget: (root: string) => Promise<void>
  /**
   * Move the open graph's directory to the OS trash (recoverable), drop it
   * from recents, and return to the chooser. Throws when the delete fails so
   * the settings confirm dialog can surface the error. Desktop-only.
   */
  deleteGraph: () => Promise<void>
  /**
   * Re-run the open graph's background index reconcile. External writers the
   * watcher can't see (mobile has none; iCloud lands files behind the app's
   * back) call this after nudging downloads so arrived files get indexed.
   * No-op while no index is open.
   */
  refreshIndex: () => void
}

const GraphContext = createContext<GraphContextValue | null>(null)

/**
 * On a macOS first run (no recents yet), start the folder picker in iCloud
 * Drive — the recommended home for a graph (Plan 21): notes back up
 * automatically and the iOS app's container lives there too. Suggestion
 * only: the user can navigate anywhere, and once they have a graph the
 * picker reverts to the OS default (their last-used location). Best-effort —
 * a resolution failure (or a signed-out account's missing folder, which the
 * open panel falls back from on its own) must never block picking.
 */
async function pickerDefaultPath(hasRecents: boolean): Promise<{ defaultPath: string } | null> {
  if (hasRecents || import.meta.env.TAURI_ENV_PLATFORM !== 'darwin') {
    return null
  }
  try {
    const home = await homeDir()
    return { defaultPath: await join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') }
  } catch (err) {
    console.warn('iCloud Drive picker suggestion failed:', errorMessage(err))
    return null
  }
}

/**
 * Owns the active graph and the open/choose flow. On mount it auto-opens the
 * most-recent graph (so the app reopens where you left off) and otherwise shows
 * the chooser. All durable file access goes through `@reflect/core` commands.
 *
 * On mobile (Plans 19/21) there is no chooser and no recents-driven reopen:
 * the graph lives in one of two fixed roots — the app's iCloud Drive
 * container (the recommended default; syncs across devices) or the app
 * sandbox `Documents/` — and only the *kind* is persisted. Absolute paths are
 * **derived fresh every launch** because iOS container paths change across
 * restore/update, so a persisted recent would point at a dead path.
 * `platform` selects the bootstrap; everything downstream of the open is
 * shared.
 */
export function GraphProvider({
  children,
  platform = 'desktop',
}: {
  children: ReactNode
  platform?: AppPlatform
}) {
  const [status, setStatus] = useState<GraphStatus>('loading')
  const [graph, setGraph] = useState<GraphInfo | null>(null)
  const [recents, setRecents] = useState<RecentGraph[]>([])
  const [indexing, setIndexing] = useState(false)
  const [indexGeneration, setIndexGeneration] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Monotonic open token: only the most recent open may commit `graph`/`status`,
  // so overlapping opens (double-click, StrictMode remount) can't finish out of
  // order and leave us on a graph the user didn't pick last.
  const openSeq = useRef(0)
  // Serializes backend opens (see `openRecent`).
  const openChain = useRef<Promise<unknown>>(Promise.resolve())
  // The active graph's index lifecycle (open → reconcile → subscribe → watch), so
  // a graph switch can stop the prior pass before the Rust connection is swapped.
  const indexRef = useRef(
    createGraphIndex({
      onError: (stage, err) => console.error(`index ${stage} failed:`, errorMessage(err)),
      onProgress: (progress) => {
        setIndexing(progress === 'reconciling')
        if (progress !== 'reconciling') {
          setIndexProgress(null) // the pass finished (or went idle) — clear the pill
        }
      },
      // Applied watcher batches stream every couple of seconds during a bulk
      // sync — the throttled variant collapses them to one refetch round per
      // window (an isolated batch still invalidates immediately).
      onApplied: throttledInvalidateIndexQueries,
      onFileProgress: (done, total, worked) => setIndexProgress({ done, total, worked }),
      // External renames healed by id follow through to sessions and routes,
      // exactly as for an in-app rename (Plan 17).
      onMoved: followHealedMove,
    }),
  )

  const loadRecents = useCallback(
    async (options?: { surfaceErrors?: boolean }): Promise<RecentGraph[]> => {
      if (!hasBridge()) {
        return [] // browser dev — there's no backend store to read.
      }
      try {
        const list = await recentGraphs()
        setRecents(list)
        return list
      } catch (err) {
        // Surface a real failure (e.g. a corrupt recent-graphs.json, which Rust
        // reports as an error rather than an empty list) only when this is the
        // primary load. As a post-open refresh it must not clobber an open error
        // or set one on a screen (the workspace) that never shows it.
        if (options?.surfaceErrors) {
          setError(errorMessage(err))
        }
        return []
      }
    },
    [],
  )

  const openRecent = useCallback(
    (root: string): Promise<boolean> => {
      if (!requireMainWindow('opening a graph')) {
        return Promise.resolve(false)
      }
      const seq = ++openSeq.current
      setStatus('opening')
      setError(null)
      // Resolves true only when this open actually reached 'ready' — callers
      // (mobile onboarding) gate side effects like persisting the onboarded
      // flag on a confirmed open, never on a clone that failed to open.
      const run = async (): Promise<boolean> => {
        let opened = false
        try {
          await closeSecondaryWindows(platform) // before openGraph bumps the session
          const info = await openGraph(root)
          if (seq !== openSeq.current) {
            return false // superseded by a newer open
          }
          const index = indexRef.current
          // Stop any prior reconcile and wait for it to fully settle before the
          // Rust index connection is swapped, so a stale pass can't write into
          // this graph's index.
          await index.stop()
          // Reclaim the prior graph's optimistic note-row overlays. They're
          // already invisible here (scoped by generation), so this is memory
          // hygiene, not correctness.
          resetNoteRowOverlays()
          // Open the index *before* 'ready' so reads can't hit the previous
          // graph's index. Best-effort: an index failure doesn't block editing.
          const generation = await index.open()
          if (seq !== openSeq.current) {
            return false
          }
          // Transition to 'ready' immediately — the user can start editing.
          setGraph(info)
          setIndexGeneration(generation)
          setStatus('ready')
          opened = true
          // Onboarding, considered exactly once per graph (the `welcomeSeeded`
          // meta marker): an empty graph gets the pinned "How to use Reflect"
          // note. Needs the index for the marker, so a graph whose index failed
          // to open simply tries again next time. On all launches after the
          // first, ensureWelcomeNote returns immediately (marker already set),
          // so it no longer blocks time-to-first-workspace-paint. The note must
          // land before the reconcile indexes files — index.sync starts in the
          // .finally so it always runs after the seed attempt.
          // Best-effort — a failed seed must never block opening.
          if (generation !== null) {
            ensureWelcomeNote({ fileGeneration: info.generation, indexGeneration: generation })
              .catch((err) => {
                console.error('welcome seed failed:', errorMessage(err))
              })
              .finally(() => {
                if (seq === openSeq.current) {
                  // Background-sync the index (reconcile → subscribe → watch),
                  // bailing if a newer open supersedes this one.
                  index.sync(generation, () => seq !== openSeq.current)
                }
              })
          } else {
            // No index — tear down any live lifecycle left from the prior graph.
            void index.close()
          }
        } catch (err) {
          if (seq !== openSeq.current) {
            return false
          }
          setError(errorMessage(err))
          setStatus('choosing')
        }
        if (seq === openSeq.current) {
          await loadRecents()
        }
        return opened
      }
      // `graph_open` mutates Rust's GraphState (`set_root`), so overlapping opens
      // could otherwise have a slow older call land *after* a newer one and leave
      // the backend on a different graph than the UI. Serialize them: running
      // one-at-a-time in request order makes the last-requested open the last to
      // touch GraphState, matching the `openSeq`-pinned UI.
      const next = openChain.current.then(run, run)
      openChain.current = next
      return next
    },
    [loadRecents, platform],
  )

  // The mobile bootstrap + onboarding slice (Plans 19/21) lives in its own
  // hook; `onParked` is its channel back onto this provider's status/error.
  const onParked = useCallback((parkError: string | null): void => {
    setError(parkError)
    setStatus('choosing')
  }, [])
  const {
    needsOnboarding,
    mobileStorageInfo,
    mobileStorageResolving,
    mobileStorageKind,
    completeOnboarding,
  } = useMobileGraphBoot({ platform, openRecent, onParked })

  // Secondary note windows never open a graph: they adopt the main window's.
  useNoteWindowBoot({
    platform,
    onAdopted: useCallback((boot) => {
      setGraph(boot.graph)
      setIndexGeneration(boot.indexGeneration)
      setStatus('ready')
    }, []),
    onFailed: useCallback((message) => {
      // Off-main, 'choosing' renders as an error screen (app.tsx), never the
      // chooser — choosing here would re-root every other window.
      setError(message)
      setStatus('choosing')
    }, []),
  })

  // Desktop main-window boot: reopen the most recent graph, or show the
  // chooser. Mobile and note windows boot through their hooks above.
  useDesktopGraphBoot({
    platform,
    loadRecents,
    openRecent,
    onChoose: useCallback(() => setStatus('choosing'), []),
  })

  /**
   * Create (and open) a graph at an app-chosen path — desktop onboarding's
   * iCloud path, where the app names the folder inside the container rather
   * than showing a picker. Same serialized open flow as `openRecent`;
   * `createGraph` bootstraps the directory first (idempotent when it exists).
   */
  const createAt = useCallback(
    async (root: string): Promise<boolean> => {
      // Guarded BEFORE createGraph: graph_create activates the shared Rust
      // session, so off-main it would re-root every window even though the
      // openRecent below refuses.
      if (!requireMainWindow('creating a graph')) {
        return false
      }
      try {
        await createGraph(root)
      } catch (err) {
        setError(errorMessage(err))
        return false
      }
      return openRecent(root)
    },
    [openRecent],
  )

  const pickAndOpen = useCallback(async (): Promise<void> => {
    let selected: string | null = null
    try {
      const result = await open({
        directory: true,
        multiple: false,
        title: 'Choose a graph folder',
        ...(await pickerDefaultPath(recents.length > 0)),
      })
      selected = typeof result === 'string' ? result : null
    } catch (err) {
      setError(errorMessage(err))
      return
    }
    if (selected) {
      await openRecent(selected)
    }
  }, [openRecent, recents])

  const closeActiveGraph = useCallback(async (): Promise<void> => {
    ++openSeq.current
    await indexRef.current.close()
    resetNoteRowOverlays()
    setGraph(null)
    setIndexGeneration(null)
    setIndexing(false)
    setError(null)
    setStatus('choosing')
  }, [])

  const chooseGraph = useCallback(async (): Promise<void> => {
    if (!requireMainWindow('switching graphs')) {
      return
    }
    await closeSecondaryWindows(platform) // the session they adopted is ending
    await closeActiveGraph()
    await loadRecents({ surfaceErrors: true })
  }, [closeActiveGraph, loadRecents, platform])

  const forget = useCallback(
    async (root: string): Promise<void> => {
      try {
        await forgetRecent(root)
        await loadRecents()
        if (graph?.root === root) {
          // Forgetting the ACTIVE graph ends the session its note windows
          // adopted — same close-first rule as switch/delete.
          await closeSecondaryWindows(platform)
          await closeActiveGraph()
        }
      } catch {
        // best-effort
      }
    },
    [closeActiveGraph, graph, loadRecents, platform],
  )

  const deleteGraph = useCallback(async (): Promise<void> => {
    if (!isMainWindow()) {
      throw new Error('Deleting a graph is only available from the main window.')
    }
    if (graph === null) {
      return
    }
    const { root, generation } = graph
    // A newer open while the delete is in flight supersedes it (the Rust
    // side already refuses the stale generation) — never tear down or
    // re-open the graph the user switched to.
    const seq = openSeq.current
    try {
      await closeSecondaryWindows(platform) // before the delete invalidates the session
      await deleteGraphCommand(generation)
    } catch (err) {
      // The command invalidates the Rust session before touching the
      // filesystem, so a failed trash leaves the directory intact but the
      // session pin dead — re-open the graph to restore a writable session,
      // then let the confirm dialog surface the error.
      if (seq === openSeq.current) {
        await openRecent(root)
      }
      throw err
    }
    // The delete trashed a directory the chooser may list — drop the cached
    // iCloud listing so the chooser refetches it rather than showing the
    // deleted graph (queries never go stale on their own, see query-client).
    dropIcloudStatusQuery()
    if (seq === openSeq.current) {
      await closeActiveGraph()
    }
    await loadRecents()
  }, [closeActiveGraph, graph, loadRecents, openRecent, platform])

  const refreshIndex = useCallback((): void => {
    // Off-main, a refresh would start a second concurrent index writer.
    if (indexGeneration === null || !isMainWindow()) {
      return
    }
    // The index lifecycle coalesces stacked triggers (resume + poll-end +
    // watch-failed can fire together) into a single queued rerun.
    const seq = openSeq.current
    indexRef.current.refresh(indexGeneration, () => seq !== openSeq.current)
  }, [indexGeneration])

  const value = useMemo<GraphContextValue>(
    () => ({
      status,
      graph,
      recents,
      indexGeneration,
      indexing,
      error,
      pickAndOpen,
      chooseGraph,
      createAt,
      openRecent,
      forget,
      deleteGraph,
      needsOnboarding,
      mobileStorageInfo,
      mobileStorageResolving,
      mobileStorageKind,
      completeOnboarding,
      refreshIndex,
    }),
    [
      status,
      graph,
      recents,
      indexGeneration,
      indexing,
      error,
      pickAndOpen,
      chooseGraph,
      createAt,
      openRecent,
      forget,
      deleteGraph,
      needsOnboarding,
      mobileStorageInfo,
      mobileStorageResolving,
      mobileStorageKind,
      completeOnboarding,
      refreshIndex,
    ],
  )

  return <GraphContext.Provider value={value}>{children}</GraphContext.Provider>
}

/** Access the active graph + open/choose actions. Use within a GraphProvider. */
export function useGraph(): GraphContextValue {
  const context = useContext(GraphContext)
  if (!context) {
    throw new Error('useGraph must be used within a GraphProvider')
  }
  return context
}
