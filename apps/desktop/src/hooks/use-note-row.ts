import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getNote, type NoteRow } from '@reflect/core'
import {
  applyNoteRowOverlay,
  reconcileNoteRowOverlay,
  useNoteRowOverlay,
} from '@/hooks/note-row-overlay'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { queryKeys } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

export interface NoteRowState {
  /** The overlay-bridged row, `null` while loading or when no row exists. */
  readonly row: NoteRow | null
  /** True once the row query has settled, so a `null` row means "no row". */
  readonly settled: boolean
}

/**
 * One note's index row plus whether the query has settled, so callers that
 * need to tell "still loading" from "no indexed row yet" (the lazy contract
 * means a visible note can predate its row) can do so. The row is kept fresh
 * by the usual index invalidation (a frontmatter write lands in the file, the
 * watcher re-indexes it, the query refetches) and made *immediately*
 * consistent with an in-app write by the optimistic {@link useNoteRowOverlay}:
 * an action records what it just wrote, this hook merges it over the index
 * row, and the overlay retires once the index agrees.
 */
export function useNoteRowState(path: string): NoteRowState {
  const { graph } = useGraph()
  const generation = graph?.generation
  const bridgeReady = useBridgeReady()
  const { data, isFetched } = useQuery({
    queryKey: queryKeys.index.note(graph?.root, path),
    queryFn: async () => (await getNote(path)) ?? null,
    enabled: bridgeReady && graph !== null,
  })
  const row = data ?? null
  const overlay = useNoteRowOverlay(path, generation)

  // Retire the overlay once the index reports the same value. An effect, not a
  // render-time mutation: the store is shared, and writing it during render
  // would tear other subscribers.
  useEffect(() => {
    if (generation !== undefined && overlay !== null) {
      reconcileNoteRowOverlay(path, generation, row)
    }
  }, [path, generation, overlay, row])

  return { row: applyNoteRowOverlay(row, overlay), settled: isFetched }
}

/**
 * {@link useNoteRowState}'s row alone, for the common callers that treat
 * loading and missing alike: `null` covers both.
 */
export function useNoteRow(path: string): NoteRow | null {
  return useNoteRowState(path).row
}
