import { useQuery } from '@tanstack/react-query'
import { getNote, hasBridge, type NoteRow } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/**
 * One note's index row by graph-relative path, kept fresh by the usual index
 * invalidation (a frontmatter write lands in the file, the watcher re-indexes
 * it, the query refetches). `null` while loading or when the note has no
 * indexed file yet — the lazy contract means a visible note can predate its
 * row. Powers per-note state like the private flag.
 */
export function useNoteRow(path: string): NoteRow | null {
  const { graph } = useGraph()
  const { data } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'note', path],
    queryFn: async () => (await getNote(path)) ?? null,
    enabled: hasBridge() && graph !== null,
  })
  return data ?? null
}
