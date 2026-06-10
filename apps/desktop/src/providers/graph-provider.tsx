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
  openGraph,
  recentGraphs,
  type GraphInfo,
  type RecentGraph,
} from '@reflect/core'
import { invalidateIndexQueries } from '@/lib/query-client'
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
  /** Open a previously-used graph by its root path. */
  openRecent: (root: string) => Promise<void>
  /** Drop a graph from the recents list. */
  forget: (root: string) => Promise<void>
}

const GraphContext = createContext<GraphContextValue | null>(null)

/**
 * Owns the active graph and the open/choose flow. On mount it auto-opens the
 * most-recent graph (so the app reopens where you left off) and otherwise shows
 * the chooser. All durable file access goes through `@reflect/core` commands.
 */
export function GraphProvider({ children }: { children: ReactNode }) {
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
      onProgress: (progress) => setIndexing(progress === 'reconciling'),
      onApplied: invalidateIndexQueries,
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
    (root: string): Promise<void> => {
      const seq = ++openSeq.current
      setStatus('opening')
      setError(null)
      const run = async (): Promise<void> => {
        try {
          const info = await openGraph(root)
          if (seq !== openSeq.current) {
            return // superseded by a newer open
          }
          const index = indexRef.current
          // Stop any prior reconcile and wait for it to fully settle before the
          // Rust index connection is swapped, so a stale pass can't write into
          // this graph's index.
          await index.stop()
          // Open the index *before* 'ready' so reads can't hit the previous
          // graph's index. Best-effort: an index failure doesn't block editing.
          const generation = await index.open()
          if (seq !== openSeq.current) {
            return
          }
          setGraph(info)
          setIndexGeneration(generation)
          setStatus('ready')
          // Background-sync the index (reconcile → subscribe → watch), bailing if
          // a newer open supersedes this one.
          index.sync(generation, () => seq !== openSeq.current)
        } catch (err) {
          if (seq !== openSeq.current) {
            return
          }
          setError(errorMessage(err))
          setStatus('choosing')
        }
        if (seq === openSeq.current) {
          await loadRecents()
        }
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
      const list = await loadRecents({ surfaceErrors: true })
      if (!active) {
        return
      }
      if (list.length > 0) {
        await openRecent(list[0].root)
      } else {
        setStatus('choosing')
      }
    })()
    return () => {
      active = false
    }
  }, [loadRecents, openRecent])

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

  const forget = useCallback(
    async (root: string): Promise<void> => {
      try {
        await forgetRecent(root)
        await loadRecents()
      } catch {
        // best-effort
      }
    },
    [loadRecents],
  )

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
    }),
    [status, graph, recents, indexGeneration, indexing, error, pickAndOpen, openRecent, forget],
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
