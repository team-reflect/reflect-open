import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { hasBridge, relatedNotes } from '@reflect/core'
import { NoteLinkRows } from '@/components/note-link-rows'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { SidebarSection } from './sidebar-section'

interface SimilarNotesSectionProps {
  /** Graph-relative path of the note whose semantic neighbors to show. */
  path: string
}

/**
 * "Similar notes" as a context-sidebar section (the old app's feature of the
 * same name): semantic neighbors of `path`, seeded by the note's stored chunk
 * vectors. Renders nothing at all when there are no results — semantic search
 * may be disabled or the note not yet embedded, and an empty box would just
 * advertise a missing feature. Shared by the daily and note context sidebars.
 */
export function SimilarNotesSection({ path }: SimilarNotesSectionProps): ReactElement | null {
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
    <SidebarSection storageKey="similar" title="Similar notes" count={related.length}>
      <NoteLinkRows
        items={related.map((hit) => ({
          key: hit.path,
          title: hit.title,
          snippet: hit.snippet,
          path: hit.path,
        }))}
        onOpen={(target) => navigate(routeForPath(target))}
      />
    </SidebarSection>
  )
}
