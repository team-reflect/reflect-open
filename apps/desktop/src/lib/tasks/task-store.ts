import {
  TaskStore,
  emitIndexApplied,
  indexNote,
  isAppError,
  readNote,
  ReflectError,
  writeNote,
} from '@reflect/core'
import { openSession, registerPendingWriter } from '@/editor/open-documents.ts'
import { toast } from '@/components/ui/toast.tsx'
import { queryClient, queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useMemo } from 'react'

const stores = new Map<string, { store: TaskStore; retire: () => Promise<void> }>()

/** Finish every graph's pending task writes and release the stores. */
export async function retireTaskStores(): Promise<void> {
  await Promise.all([...stores.values()].map(({ retire }) => retire()))
}

/**
 * The task store of one graph session, shared by every task surface. Reads
 * and writes go through the note's live `NoteSession` when it is open in an
 * editor, so unsaved editor content is preserved, and through the file
 * otherwise. Every write is indexed in-process and the task queries are
 * refetched before it counts as done. Save failures show one toast per note
 * with a Retry action.
 */
export function taskStore(root: string, generation: number): TaskStore {
  const key = JSON.stringify([root, generation])
  const existing = stores.get(key)
  if (existing) return existing.store
  let active = true
  const assertActive = () => {
    if (!active) throw new Error('This graph session has closed.')
  }
  const failures = new Set<string>()
  const toastId = (path: string) => `task-save:${key}:${path}`
  const store = new TaskStore({
    async read(path) {
      assertActive()
      const session = openSession(path, generation)
      if (session) {
        const source = session.liveContent()
        if (source === null) throw new Error('This note is still loading.')
        return source
      }
      try {
        return await readNote(path, generation)
      } catch (error) {
        if (isAppError(error) && error.kind === 'notFound') return null
        throw error
      }
    },
    async write(path, before, source) {
      assertActive()
      const session = openSession(path, generation)
      let saved = source
      if (session) {
        const applied = await session.commitSourceEdit(
          (current) => {
            if (current !== before) throw new ReflectError('io', 'This note changed while saving.')
            return source
          },
          (normalized) => {
            saved = normalized
          },
        )
        if (!applied) throw new Error('This note cannot be edited right now.')
      } else {
        await writeNote(path, source, generation, before)
      }
      // Index the note now instead of waiting for the file watcher, then let
      // the task queries refetch, so the store forgets a local change only
      // once the read model shows it. The watcher's later event finds the
      // same hash and skips. The file is written either way, so a failure
      // here is not a failed save; the watcher pipeline catches up.
      try {
        await indexNote(path, { generation, content: saved })
        emitIndexApplied([{ path, kind: 'upsert', modifiedMs: Date.now() }], generation)
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.index.openTasks(root) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.index.completedTasks(root) }),
        ])
      } catch (error) {
        console.error('indexing a task write failed:', error)
      }
      return saved
    },
    failure(path, _error, retry) {
      if (!active || failures.has(path)) return
      failures.add(path)
      toast.add({
        id: toastId(path),
        type: 'error',
        // Stays until saved or retried: the pending change is only visible here.
        timeout: 0,
        data: { dismissible: false },
        title: "Couldn't save tasks. Your changes are kept.",
        actionProps: {
          children: 'Retry',
          onClick: () => {
            failures.delete(path)
            retry()
          },
        },
      })
    },
    saved(path) {
      failures.delete(path)
      toast.close(toastId(path))
    },
  })
  const unregister = registerPendingWriter(store.flush)
  stores.set(key, {
    store,
    retire: async () => {
      await store.flush()
      active = false
      unregister()
      stores.delete(key)
      for (const path of failures) toast.close(toastId(path))
    },
  })
  return store
}

/** The current graph's task store, or null before a graph is open. */
export function useTaskStore(): TaskStore | null {
  const { graph } = useGraph()
  const root = graph?.root
  const generation = graph?.generation
  return useMemo(
    () => (root !== undefined && generation !== undefined ? taskStore(root, generation) : null),
    [root, generation],
  )
}
