import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { hasBridge, relatedNotes } from '@reflect/core'
import { NoteLinkList } from '@/components/note-link-list'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

interface RelatedNotesProps {
  /** The open note (excluded from its own results). */
  path: string
}

/**
 * Semantic neighbors of the open note (Plan 09 — the "suggested backlinks"
 * deferred from Plan 07): the payoff surface for local embeddings. Seeded by
 * the note's own **stored** chunk vectors, so freshness rides the embedding
 * sync + index invalidation (saves re-embed → scope invalidates → refetch) —
 * no pane-provided seed text to go stale. Renders nothing when the note has
 * no vectors yet (model never enabled, not yet embedded) or nothing relates.
 */
export function RelatedNotes({ path }: RelatedNotesProps): ReactElement | null {
  const { navigate } = useRouter()
  const { graph } = useGraph()

  const { data } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'related', path],
    queryFn: () => relatedNotes(path),
    enabled: hasBridge() && graph !== null,
  })

  const related = data ?? []
  if (related.length === 0) {
    return null
  }

  return (
    <NoteLinkList
      ariaLabel="Related notes"
      heading="Related"
      items={related.map((hit) => ({
        key: hit.path,
        title: hit.title,
        snippet: hit.snippet,
        path: hit.path,
      }))}
      onOpen={(target) => navigate(routeForPath(target))}
    />
  )
}
