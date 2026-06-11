import type { ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { getBacklinksWithContext, hasBridge } from '@reflect/core'
import { BacklinkSourceGroup } from '@/components/backlink-source-group'
import { groupBacklinksBySource } from '@/lib/group-backlinks'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useSessionFlag } from '@/lib/use-session-flag'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

interface BacklinksPanelProps {
  /** Graph-relative path of the note whose inbound links to show. */
  path: string
}

/** Session-wide (all notes) expanded state, old Reflect's `backlinks-expanded`. */
const EXPANDED_STORAGE_KEY = 'reflect.backlinks-expanded'

/**
 * Incoming backlinks at the bottom of every note — daily and ordinary — in
 * old Reflect's presentation: an "Incoming backlinks (N)" header with a
 * leading chevron, indented references grouped by source note, and hairline
 * dividers between groups. The header toggle collapses the linking lines while the
 * source titles stay visible, and the choice persists for the session
 * across all notes. Ambient and always-available — the associative recall
 * the product is built on — and cheap: one indexed query per visible note,
 * kept fresh by the index invalidation hook (no polling). Renders nothing
 * when the note has no inbound links, but a failed query surfaces as an
 * alert — this is the only backlinks surface, and a failing query means the
 * index is broken, not that the note is unlinked.
 */
export function BacklinksPanel({ path }: BacklinksPanelProps): ReactElement | null {
  const { navigate } = useRouter()
  const { graph } = useGraph()
  // The graph root is part of the key: index rows belong to one graph, and a
  // graph switch must never serve the previous graph's cached rows (the cache
  // outlives the workspace remount; invalidation alone lags the reconcile).
  const { data, isError } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'backlinks', path],
    queryFn: () => getBacklinksWithContext(path),
    enabled: hasBridge() && graph !== null,
  })
  // Shared across every mounted panel: the daily stream shows one per day,
  // and the header toggle must move them together, not just this instance.
  const [expanded, setExpanded] = useSessionFlag(EXPANDED_STORAGE_KEY, true)

  if (isError) {
    return (
      <section aria-label="Incoming backlinks" className="mt-8">
        <p role="alert" className="text-xs text-text-muted">
          Couldn’t load backlinks.
        </p>
      </section>
    )
  }

  if (!data || data.length === 0) {
    return null
  }

  const toggleExpanded = (): void => {
    setExpanded(!expanded)
  }

  const count = data.length
  const groups = groupBacklinksBySource(data)

  return (
    <section aria-label="Incoming backlinks" className="mt-8">
      <h3 className="text-xs font-medium text-text-muted">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex w-full items-center gap-2 text-left"
        >
          <ChevronRight
            aria-hidden
            className={`size-3 shrink-0 text-text-muted transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
          />
          <span>
            Incoming backlink{count === 1 ? '' : 's'} ({count})
          </span>
        </button>
      </h3>

      {/* pl-5 = the header's 12px chevron + 8px gap, so group titles line up
          with the header label and the group hover-chevrons (-left-5) land
          back at the section's left edge, under the header chevron. */}
      <div className="mt-5 pl-5">
        {groups.map((group, index) => (
          <BacklinkSourceGroup
            // Scoped to the open note: the pane is reused across navigation,
            // and a source shared by two notes must not carry its peeked or
            // collapsed state from one note's panel to the other's.
            key={`${path}:${group.path}`}
            source={group}
            first={index === 0}
            expanded={expanded}
            onOpen={(target) => navigate(routeForPath(target))}
          />
        ))}
      </div>
    </section>
  )
}
