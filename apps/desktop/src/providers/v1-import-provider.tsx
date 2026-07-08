import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  cancelReflectV1Import,
  errorMessage,
  importReflectV1Zip,
  markReflectV1ImportOwnWrites,
  subscribeImportProgress,
  type GraphImportProgress,
  type GraphImportSummary,
  type GraphInfo,
} from '@reflect/core'
import { V1ImportDialog } from '@/components/v1-import-dialog'
import { useGraph } from '@/providers/graph-provider'

/**
 * Where the Reflect V1 import stands. `running.progress` is null until the
 * first native progress tick (the zip is being read); `cancelling` means the
 * user asked to stop and the native side is winding down.
 */
export type V1ImportState =
  | { phase: 'idle' }
  | { phase: 'running'; progress: GraphImportProgress | null; cancelling: boolean }
  | { phase: 'done'; summary: GraphImportSummary }
  | { phase: 'failed'; message: string }

interface V1ImportContextValue {
  state: V1ImportState
  /** Kick off an import of the chosen `.zip`; ignored while one runs. */
  startImport: (zipPath: string) => void
  /** Ask the running import to stop (safe: nothing lands after a cancel). */
  cancelImport: () => void
  /** Clear a finished (done/failed) import back to idle. */
  dismiss: () => void
}

const V1ImportContext = createContext<V1ImportContextValue | null>(null)

interface V1ImportProviderProps {
  graph: GraphInfo
  children: ReactNode
}

/**
 * Owns the Reflect V1 import for the workspace: the settings section only
 * picks the zip; the import itself lives here so navigating away from
 * settings can't orphan it. Renders the modal progress dialog
 * ({@link V1ImportDialog}) above the routed views — the import is the only
 * activity until it finishes, errors, or is cancelled.
 */
export function V1ImportProvider({ graph, children }: V1ImportProviderProps): ReactElement {
  const { refreshIndex } = useGraph()
  const [state, setState] = useState<V1ImportState>({ phase: 'idle' })
  const runningRef = useRef(false)
  const cancelRequestedRef = useRef(false)
  const graphRef = useRef(graph)
  useEffect(() => {
    graphRef.current = graph
  }, [graph])

  // The native import keeps running without this window; if the workspace
  // unmounts mid-import (graph switch, app teardown) nobody is left to show
  // or apply the result, so stop the work too. `mountedRef` also gates the
  // completion bookkeeping: cancellation only aborts before the write phase,
  // so a near-finished import can still resolve after unmount — its
  // own-write echoes and index refresh would then land on whatever graph is
  // open now, not the one it imported into.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (runningRef.current) {
        void cancelReflectV1Import().catch(() => {})
      }
    }
  }, [])

  const startImport = useCallback(
    (zipPath: string) => {
      if (runningRef.current) {
        return
      }
      runningRef.current = true
      cancelRequestedRef.current = false
      setState({ phase: 'running', progress: null, cancelling: false })
      const startedFor = graphRef.current
      const unlistenPromise = subscribeImportProgress((progress) => {
        setState((previous) =>
          previous.phase === 'running' ? { ...previous, progress } : previous,
        )
      })
      void (async () => {
        try {
          const summary = await importReflectV1Zip(zipPath, startedFor.generation)
          const current = graphRef.current
          if (
            mountedRef.current &&
            current.root === startedFor.root &&
            current.generation === startedFor.generation
          ) {
            markReflectV1ImportOwnWrites(summary)
            refreshIndex()
            setState({ phase: 'done', summary })
          } else {
            setState({ phase: 'idle' })
          }
        } catch (caught: unknown) {
          // A rejection after the user hit Cancel is the cancellation itself,
          // not a failure worth surfacing.
          setState(
            cancelRequestedRef.current
              ? { phase: 'idle' }
              : { phase: 'failed', message: errorMessage(caught) },
          )
        } finally {
          runningRef.current = false
          void unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
        }
      })()
    },
    [refreshIndex],
  )

  const cancelImport = useCallback(() => {
    if (!runningRef.current || cancelRequestedRef.current) {
      return
    }
    cancelRequestedRef.current = true
    setState((previous) =>
      previous.phase === 'running' ? { ...previous, cancelling: true } : previous,
    )
    void cancelReflectV1Import().catch(() => {})
  }, [])

  const dismiss = useCallback(() => {
    setState((previous) => (previous.phase === 'running' ? previous : { phase: 'idle' }))
  }, [])

  const value = useMemo(
    () => ({ state, startImport, cancelImport, dismiss }),
    [state, startImport, cancelImport, dismiss],
  )

  return (
    <V1ImportContext.Provider value={value}>
      {children}
      <V1ImportDialog state={state} onCancel={cancelImport} onDismiss={dismiss} />
    </V1ImportContext.Provider>
  )
}

/** The workspace's Reflect V1 import (state + controls). */
export function useV1Import(): V1ImportContextValue {
  const context = useContext(V1ImportContext)
  if (context === null) {
    throw new Error('useV1Import must be used within V1ImportProvider')
  }
  return context
}
