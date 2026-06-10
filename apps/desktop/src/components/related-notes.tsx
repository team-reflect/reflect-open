import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { hasBridge, relatedNotes } from '@reflect/core'
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
    <section
      aria-label="Related notes"
      className="mt-6 border-t border-black/5 pt-3 dark:border-white/5"
    >
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
        Related
      </h3>
      <ul className="space-y-0.5">
        {related.map((hit) => (
          <li key={hit.path}>
            <button
              type="button"
              onClick={() => navigate(routeForPath(hit.path))}
              className="w-full rounded px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/5"
            >
              <span className="block truncate text-sm font-medium">{hit.title}</span>
              {hit.snippet !== '' ? (
                <span className="block truncate text-xs text-[color:var(--text-muted)]">
                  {hit.snippet}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
