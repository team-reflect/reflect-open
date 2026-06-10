import type { ReactElement } from 'react'
import { NoteLinkList } from '@/components/note-link-list'
import { useSimilarNotes } from '@/lib/use-similar-notes'
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
 * Query errors are deliberately as quiet as emptiness — unlike backlinks,
 * a failing semantic leg means an optional feature is unavailable, not that
 * the index is broken.
 */
export function RelatedNotes({ path }: RelatedNotesProps): ReactElement | null {
  const { navigate } = useRouter()
  const { data } = useSimilarNotes(path)

  const related = data ?? []
  if (related.length === 0) {
    return null
  }

  return (
    <NoteLinkList
      ariaLabel="Similar notes"
      heading="Similar notes"
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
