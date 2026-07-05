import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  isMobilePlatform,
  loadSettings,
  mobileStorage,
  createGraph,
  openGraph,
  recentGraphs,
  type AppPlatform,
  type GraphInfo,
  type MobileStorageInfo,
  type MobileStorageKind,
  type RecentGraph,
} from '@reflect/core'
import { followHealedMove } from '@/editor/move-note'
import { resetNoteRowOverlays } from '@/hooks/note-row-overlay'
import { dropIcloudStatusQuery, invalidateIndexQueries } from '@/lib/query-client'
import { ensureWelcomeNote } from '@/lib/welcome-note'
import { useSettings } from '@/providers/settings-provider'
import { createGraphIndex } from './graph-index'

/** Lifecycle of the active graph (Plan 02 loading gate). */
export type GraphStatus = 'loading' | 'choosing' | 'opening' | 'ready'

interface GraphContextValue {
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
   * Mobile only (Plan 19, step 6): the user hasn't yet chosen how to start
   * (iCloud Drive / this device / GitHub), so both fixed roots are left
   * untouched and the onboarding screen is shown instead of the graph. Always
   * false on desktop, which has its own chooser.
   */
  needsOnboarding: boolean
  /**
   * Mobile only: the storage roots available to the graph (Plan 21), derived
   * fresh at bootstrap (null elsewhere). Paths must never be persisted — iOS
   * container paths change across restore/update.
   */
  mobileStorageInfo: MobileStorageInfo | null
  /**
   * Mobile only: which root the open graph lives in — `'icloud'` for the
   * iCloud Drive container, `'local'` for the app sandbox. Null until a graph
   * is open (and always null on desktop). The iCloud foreground refresh keys
   * off this.
   */
  mobileStorageKind: MobileStorageKind | null
  /**
   * Mobile only: open a storage choice and persist it (onboarded flag,
   * storage kind, and — for iCloud — the graph *name*, since the container
   * can hold several graphs). Used by onboarding to finish, and by the
   * settings graph switcher to move between graphs. `root` selects a
   * specific container graph (or a fresh directory to create); omitted, the
   * kind's default root opens. For the GitHub path the clone must already
   * have landed in the local root before this is called (with `'local'`).
   */
  completeOnboarding: (kind: MobileStorageKind, root?: string) => Promise<void>
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

/** The graph directory created in the container for a fresh start — reads as
 * `iCloud Drive → Reflect → Notes` in Files/Finder. */
const DEFAULT_ICLOUD_GRAPH_NAME = 'Notes'

/** `/…/Documents/My Notes` → `My Notes`. */
function graphNameFromRoot(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? ''
}

/**
 * The absolute root for a mobile storage kind, or null when that root is
 * unavailable (an `'icloud'` kind with iCloud signed out / off). The one
 * mapping from the persisted selectors — the *kind* plus, for iCloud, the
 * graph *name* — to a launch-derived path. The container can hold several
 * graphs: prefer the persisted name, fall back to the first existing graph
 * (a rename on another device must not strand the phone), and only a truly
 * empty container yields a fresh directory to create.
 */
function storageRoot(
  info: MobileStorageInfo,
  kind: MobileStorageKind,
  graphName: string,
): string | null {
  if (kind === 'local') {
    return info.localRoot
  }
  if (info.icloudDocumentsRoot === null) {
    return null
  }
  const byName = info.icloudGraphRoots.find((root) => graphNameFromRoot(root) === graphName)
  return (
    byName ??
    info.icloudGraphRoots[0] ??
    `${info.icloudDocumentsRoot}/${graphName === '' ? DEFAULT_ICLOUD_GRAPH_NAME : graphName}`
  )
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
  // Mobile onboarding gate (Plan 19, step 6) — inert on desktop.
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [mobileStorageInfo, setMobileStorageInfo] = useState<MobileStorageInfo | null>(null)
  const [mobileStorageKind, setMobileStorageKind] = useState<MobileStorageKind | null>(null)
  // Settings live in one place (the app-wide provider, mounted above
  // PlatformRoot): write the onboarded flag through it so its cached document
  // carries the flag too — a raw save would be clobbered by the next change.
  const { updateSettings, whenSettingsLoaded } = useSettings()
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
      onProgress: (progress) => setIndexing(progress === 'reconciling'),
      onApplied: invalidateIndexQueries,
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
      const seq = ++openSeq.current
      setStatus('opening')
      setError(null)
      // Resolves true only when this open actually reached 'ready' — callers
      // (mobile onboarding) gate side effects like persisting the onboarded
      // flag on a confirmed open, never on a clone that failed to open.
      const run = async (): Promise<boolean> => {
        let opened = false
        try {
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
    [loadRecents],
  )

  useEffect(() => {
    let active = true
    void (async () => {
      if (isMobilePlatform(platform)) {
        // Fixed roots, derived fresh (never from recents — see the docblock).
        try {
          const storage = await mobileStorage()
          if (!active) {
            return
          }
          setMobileStorageInfo(storage)
          // Gate the first launch on the onboarding choice (Plan 19, step 6).
          // A missing/false flag is a fresh install: defer the open so the
          // GitHub path can clone into the still-empty local root (`git_clone`
          // refuses a non-empty directory, and opening here would bootstrap
          // and seed it). Once onboarded, open the persisted storage kind.
          const settings = await loadSettings()
          if (!active) {
            return
          }
          if (settings.mobileOnboarded === true) {
            const kind = settings.mobileStorage
            const root = storageRoot(storage, kind, settings.mobileGraphName)
            if (root === null) {
              // The graph lives in iCloud but the account is gone (signed
              // out, iCloud Drive off). Opening the empty local root instead
              // would silently start a second graph — park on an honest
              // error until iCloud is back.
              setError(
                'Your notes are stored in iCloud Drive, but iCloud isn’t available on this device. Sign in to iCloud in Settings, then reopen Reflect.',
              )
              setStatus('choosing')
              return
            }
            setMobileStorageKind(kind)
            await openRecent(root)
          } else {
            setNeedsOnboarding(true)
            setStatus('choosing')
          }
        } catch (err) {
          if (active) {
            setError(errorMessage(err))
            setStatus('choosing')
          }
        }
        return
      }
      const list = await loadRecents({ surfaceErrors: true })
      if (!active) {
        return
      }
      if (list.length > 0) {
        await openRecent(list[0]!.root)
      } else {
        setStatus('choosing')
      }
    })()
    return () => {
      active = false
    }
  }, [loadRecents, openRecent, platform])

  /**
   * Create (and open) a graph at an app-chosen path — desktop onboarding's
   * iCloud path, where the app names the folder inside the container rather
   * than showing a picker. Same serialized open flow as `openRecent`;
   * `createGraph` bootstraps the directory first (idempotent when it exists).
   */
  const createAt = useCallback(
    async (root: string): Promise<boolean> => {
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
    await closeActiveGraph()
    await loadRecents({ surfaceErrors: true })
  }, [closeActiveGraph, loadRecents])

  const forget = useCallback(
    async (root: string): Promise<void> => {
      try {
        await forgetRecent(root)
        await loadRecents()
        if (graph?.root === root) {
          await closeActiveGraph()
        }
      } catch {
        // best-effort
      }
    },
    [closeActiveGraph, graph, loadRecents],
  )

  const deleteGraph = useCallback(async (): Promise<void> => {
    if (graph === null) {
      return
    }
    const { root, generation } = graph
    // A newer open while the delete is in flight supersedes it (the Rust
    // side already refuses the stale generation) — never tear down or
    // re-open the graph the user switched to.
    const seq = openSeq.current
    try {
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
  }, [closeActiveGraph, graph, loadRecents, openRecent])

  const completeOnboarding = useCallback(
    async (kind: MobileStorageKind, chosenRoot?: string): Promise<void> => {
      // An explicit root comes from the onboarding graph list or the settings
      // switcher (open THIS container graph / create one with this name);
      // without one, fall back to the kind's default root — the local path
      // and the GitHub clone flow never pass a root.
      const root =
        chosenRoot ??
        (mobileStorageInfo === null ? null : storageRoot(mobileStorageInfo, kind, ''))
      if (root === null) {
        throw new Error(
          kind === 'icloud'
            ? 'iCloud Drive isn’t available on this device.'
            : 'No graph folder available.',
        )
      }
      const shouldCreateIcloudRoot =
        kind === 'icloud' && mobileStorageInfo?.icloudGraphRoots.includes(root) !== true
      if (shouldCreateIcloudRoot) {
        await createGraph(root)
      }
      // Keep the onboarding gate up while the open runs — `openRecent` moves the
      // status to 'opening' synchronously and the onboarding screen shows its own
      // pending state, so the shell never flashes. On failure throw rather than
      // clear the gate: the screen surfaces the error and stays on onboarding for
      // an in-app retry (re-choosing re-opens an already-populated root) instead
      // of landing on the dead-end open-failed screen.
      const opened = await openRecent(root)
      if (!opened) {
        throw new Error('Couldn’t open your notes — please try again.')
      }
      setMobileStorageKind(kind)
      setNeedsOnboarding(false)
      // Persist the flags only once the graph is actually open, so a failed open
      // never strands the user past onboarding. Write through the settings
      // provider (not a raw save), awaiting hydration first — the provider's
      // contract for a setting paired with a keychain secret (here the GitHub
      // token): after a failed load it stays session-only and the next launch
      // re-onboards, where re-choosing re-opens the existing graph (no data loss).
      await whenSettingsLoaded()
      updateSettings({
        mobileOnboarded: true,
        mobileStorage: kind,
        // The container can hold several graphs — remember WHICH one by name
        // (never by path; container paths change across restore/update).
        mobileGraphName: kind === 'icloud' ? graphNameFromRoot(root) : '',
      })
    },
    [mobileStorageInfo, openRecent, updateSettings, whenSettingsLoaded],
  )

  const refreshIndex = useCallback((): void => {
    if (indexGeneration === null) {
      return
    }
    const seq = openSeq.current
    const index = indexRef.current
    // Settle (abort) any in-flight pass first so two reconciles never write
    // concurrently, then bail if a newer open superseded this graph meanwhile.
    void index.stop().then(() => {
      if (seq !== openSeq.current) {
        return
      }
      index.sync(indexGeneration, () => seq !== openSeq.current)
    })
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
