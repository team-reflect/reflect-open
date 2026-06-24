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
import { open } from '@tauri-apps/plugin-dialog'
import {
  errorMessage,
  forgetRecent,
  hasBridge,
  isMobilePlatform,
  loadSettings,
  mobileGraphRoot,
  openGraph,
  recentGraphs,
  type AppPlatform,
  type GraphInfo,
  type RecentGraph,
} from '@reflect/core'
import { followHealedMove } from '@/editor/move-note'
import { resetNoteRowOverlays } from '@/hooks/note-row-overlay'
import { invalidateIndexQueries } from '@/lib/query-client'
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
  /** Open a graph by its root path. Resolves true only when it reached 'ready'. */
  openRecent: (root: string) => Promise<boolean>
  /** Drop a graph from the recents list. */
  forget: (root: string) => Promise<void>
  /**
   * Mobile only (Plan 19, step 6): the user hasn't yet chosen how to start
   * (Start fresh / Connect to GitHub), so the fixed root is left untouched and
   * the onboarding screen is shown instead of the graph. Always false on
   * desktop, which has its own chooser.
   */
  needsOnboarding: boolean
  /** Mobile only: the fixed graph root, derived once at bootstrap (null elsewhere). */
  mobileRoot: string | null
  /**
   * Mobile only: finish onboarding — open the (now-populated, for the GitHub
   * path already-cloned) fixed root and persist the onboarded flag so later
   * launches skip the screen. The GitHub clone must already have landed in the
   * root before this is called.
   */
  completeOnboarding: () => Promise<void>
}

const GraphContext = createContext<GraphContextValue | null>(null)

/**
 * Owns the active graph and the open/choose flow. On mount it auto-opens the
 * most-recent graph (so the app reopens where you left off) and otherwise shows
 * the chooser. All durable file access goes through `@reflect/core` commands.
 *
 * On mobile (Plan 19) there is no chooser and no recents-driven reopen: the
 * graph root is fixed (the app's `Documents/`) and is **derived fresh every
 * launch** — iOS container paths change across restore/update, so a persisted
 * recent would point at a dead path. `platform` selects the bootstrap;
 * everything downstream of the open is shared.
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
  const [mobileRoot, setMobileRoot] = useState<string | null>(null)
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
        // Fixed root, derived fresh (never from recents — see the docblock).
        try {
          const root = await mobileGraphRoot()
          if (!active) {
            return
          }
          setMobileRoot(root)
          // Gate the first launch on the onboarding choice (Plan 19, step 6).
          // A missing/false flag is a fresh install: defer the open so the
          // GitHub path can clone into the still-empty root (`git_clone`
          // refuses a non-empty directory, and opening here would bootstrap
          // and seed it). Once onboarded, open the fixed root directly.
          const onboarded = (await loadSettings()).mobileOnboarded === true
          if (!active) {
            return
          }
          if (onboarded) {
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

  const pickAndOpen = useCallback(async (): Promise<void> => {
    let selected: string | null = null
    try {
      const result = await open({
        directory: true,
        multiple: false,
        title: 'Choose a graph folder',
      })
      selected = typeof result === 'string' ? result : null
    } catch (err) {
      setError(errorMessage(err))
      return
    }
    if (selected) {
      await openRecent(selected)
    }
  }, [openRecent])

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

  const completeOnboarding = useCallback(async (): Promise<void> => {
    if (mobileRoot === null) {
      throw new Error('No mobile graph root to open')
    }
    // Keep the onboarding gate up while the open runs — `openRecent` moves the
    // status to 'opening' synchronously and the onboarding screen shows its own
    // pending state, so the shell never flashes. On failure throw rather than
    // clear the gate: the screen surfaces the error and stays on onboarding for
    // an in-app retry (Start fresh re-opens an already-cloned root) instead of
    // landing on the dead-end open-failed screen.
    const opened = await openRecent(mobileRoot)
    if (!opened) {
      throw new Error('Couldn’t open your notes — please try again.')
    }
    setNeedsOnboarding(false)
    // Persist the flag only once the graph is actually open, so a failed open
    // never strands the user past onboarding. Write through the settings
    // provider (not a raw save), awaiting hydration first — the provider's
    // contract for a setting paired with a keychain secret (here the GitHub
    // token): after a failed load it stays session-only and the next launch
    // re-onboards, where Start fresh re-opens the existing graph (no data loss).
    await whenSettingsLoaded()
    updateSettings({ mobileOnboarded: true })
  }, [mobileRoot, openRecent, updateSettings, whenSettingsLoaded])

  const value = useMemo<GraphContextValue>(
    () => ({
      status,
      graph,
      recents,
      indexGeneration,
      indexing,
      error,
      pickAndOpen,
      openRecent,
      forget,
      needsOnboarding,
      mobileRoot,
      completeOnboarding,
    }),
    [
      status,
      graph,
      recents,
      indexGeneration,
      indexing,
      error,
      pickAndOpen,
      openRecent,
      forget,
      needsOnboarding,
      mobileRoot,
      completeOnboarding,
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
