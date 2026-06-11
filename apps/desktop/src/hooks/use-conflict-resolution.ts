import { useState } from 'react'
import {
  emitFileChanges,
  errorMessage,
  indexNote,
  readNote,
  resolveConflictMarkers,
  writeNote,
  type ConflictResolution,
} from '@reflect/core'
import { invalidateIndexQueries } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

export interface ConflictResolutionState {
  busy: boolean
  error: string | null
  /** Splice the chosen side(s) into the file, reindex it, and notify views. */
  resolve: (keep: ConflictResolution) => Promise<void>
}

/**
 * Resolution of sync conflict markers for one note, as raw-text surgery:
 * read the file, splice the kept side(s) (`resolveConflictMarkers` — markers
 * don't survive the editor round-trip, so the editor can't do this), write it
 * back, reindex, and notify open sessions. The conflict flag is a projection
 * of the file content, so consumers (the notice banner) clear themselves once
 * the resolved file reindexes.
 */
export function useConflictResolution(path: string): ConflictResolutionState {
  const { graph, indexGeneration } = useGraph()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writeGeneration = graph?.generation ?? null

  async function resolve(keep: ConflictResolution): Promise<void> {
    if (writeGeneration === null) {
      return
    }
    setBusy(true)
    setError(null)
    let wrote = false
    try {
      const source = await readNote(path)
      const resolved = resolveConflictMarkers(source, keep)
      await writeNote(path, resolved, writeGeneration)
      wrote = true
      if (indexGeneration !== null) {
        await indexNote(path, { generation: indexGeneration, content: resolved })
      }
    } catch (caught: unknown) {
      setError(errorMessage(caught))
    } finally {
      if (wrote) {
        // The file changed on disk even if the reindex step failed (the
        // watcher will redo that) — reload the open (protected) session,
        // which round-trips again now and reopens editable, and refresh
        // index-backed views.
        emitFileChanges([{ path, kind: 'upsert' }])
        invalidateIndexQueries()
      }
      setBusy(false)
    }
  }

  return { busy, error, resolve }
}
