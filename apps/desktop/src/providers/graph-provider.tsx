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
import { isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  forgetRecent,
  openGraph,
  openIndex,
  reconcileIndex,
  recentGraphs,
  subscribeIndexChanges,
  toAppError,
  watchStart,
  watchStop,
  type GraphInfo,
  type RecentGraph,
} from '@reflect/core'

/** Lifecycle of the active graph (Plan 02 loading gate). */
export type GraphStatus = 'loading' | 'choosing' | 'opening' | 'ready'

interface GraphContextValue {
  status: GraphStatus
  graph: GraphInfo | null
  recents: RecentGraph[]
  error: string | null
  /** Show the OS folder picker, then open (and bootstrap) the chosen graph. */
  pickAndOpen: () => Promise<void>
  /** Open a previously-used graph by its root path. */
  openRecent: (root: string) => Promise<void>
  /** Drop a graph from the recents list. */
  forget: (root: string) => Promise<void>
}

const GraphContext = createContext<GraphContextValue | null>(null)

function messageOf(error: unknown): string {
  // `toAppError` already normalizes Errors/strings/objects safely, so unknown
  // throws never render as `[object Object]`.
  return toAppError(error).message
}

/**
 * Owns the active graph and the open/choose flow. On mount it auto-opens the
 * most-recent graph (so the app reopens where you left off) and otherwise shows
 * the chooser. All durable file access goes through `@reflect/core` commands.
 */
export function GraphProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GraphStatus>('loading')
  const [graph, setGraph] = useState<GraphInfo | null>(null)
  const [recents, setRecents] = useState<RecentGraph[]>([])
  const [error, setError] = useState<string | null>(null)
  // Monotonic open token: only the most recent open may commit `graph`/`status`,
  // so overlapping opens (double-click, StrictMode remount) can't finish out of
  // order and leave us on a graph the user didn't pick last.
  const openSeq = useRef(0)
  // Serializes backend opens (see `openRecent`).
  const openChain = useRef<Promise<unknown>>(Promise.resolve())
  // The active graph's background index reconcile + its abort handle, so a graph
  // switch can stop the prior pass before the Rust index connection is swapped.
  const indexAbort = useRef<AbortController | null>(null)
  const reconcileDone = useRef<Promise<void>>(Promise.resolve())
  // Unlistens the live `index:changed` subscription for the previous graph.
  const indexUnlisten = useRef<(() => void) | null>(null)

  const loadRecents = useCallback(
    async (options?: { surfaceErrors?: boolean }): Promise<RecentGraph[]> => {
      if (!isTauri()) {
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
          setError(messageOf(err))
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
          // Stop any prior reconcile and wait for it to fully settle before the
          // Rust index connection is swapped, so a stale pass can't write into
          // this graph's index.
          indexAbort.current?.abort()
          await reconcileDone.current.catch(() => {})
          // Open the index *before* 'ready' so reads can't hit the previous
          // graph's index. Best-effort: an index failure doesn't block editing.
          let generation: number | null = null
          try {
            generation = await openIndex()
          } catch (err) {
            console.error('index open failed:', messageOf(err))
          }
          if (seq !== openSeq.current) {
            return
          }
          setGraph(info)
          setStatus('ready')
          // Tear down the previous graph's live subscription unconditionally, so
          // a failed openIndex can't leave it attached to a different graph.
          indexUnlisten.current?.()
          indexUnlisten.current = null

          if (generation === null) {
            // No index for this graph — stop any watcher from the previous one.
            void watchStop().catch(() => {})
          } else {
            // Index sync, sequenced so the passes never write concurrently:
            // reconcile the whole graph first, then subscribe (listener up), then
            // start the Rust watcher (which replaces any previous one). reconcile
            // is abortable; seq checks bail if a newer open supersedes us.
            const controller = new AbortController()
            indexAbort.current = controller
            reconcileDone.current = (async () => {
              let unlisten: (() => void) | null = null
              try {
                await reconcileIndex({ generation, signal: controller.signal })
                if (seq !== openSeq.current) {
                  return
                }
                unlisten = await subscribeIndexChanges(generation)
                if (seq !== openSeq.current) {
                  return
                }
                await watchStart()
                if (seq !== openSeq.current) {
                  return
                }
                indexUnlisten.current?.()
                indexUnlisten.current = unlisten
                unlisten = null // ownership transferred to the ref
              } catch (err) {
                console.error('index sync failed:', messageOf(err))
              } finally {
                // Tear down a subscription that was created but never bound
                // (superseded, or a later step threw) so listeners can't leak.
                unlisten?.()
              }
            })()
          }
        } catch (err) {
          if (seq !== openSeq.current) {
            return
          }
          setError(messageOf(err))
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
      setError(messageOf(err))
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
    () => ({ status, graph, recents, error, pickAndOpen, openRecent, forget }),
    [status, graph, recents, error, pickAndOpen, openRecent, forget],
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
