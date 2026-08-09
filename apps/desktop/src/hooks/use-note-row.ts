import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getNote, type NoteRow } from '@reflect/core'
import {
  applyNoteRowOverlay,
  reconcileNoteRowOverlay,
  useNoteRowOverlay,
} from '@/hooks/note-row-overlay'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/**
 * One note's index row by graph-relative path, kept fresh by the usual index
 * invalidation (a frontmatter write lands in the file, the watcher re-indexes
 * it, the query refetches) and made *immediately* consistent with an in-app
 * write by the optimistic {@link useNoteRowOverlay}: an action records what it
 * just wrote, this hook merges it over the index row, and the overlay retires
 * once the index agrees. `null` while loading or when the note has no indexed
 * file yet — the lazy contract means a visible note can predate its row.
 */
export function useNoteRow(path: string): NoteRow | null {
  const { graph } = useGraph()
  const generation = graph?.generation
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'note', path],
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

  return applyNoteRowOverlay(row, overlay)
}
