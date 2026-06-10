import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { dailyPath, getBacklinksWithContext, hasBridge } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { SidebarSection } from './sidebar-section'

interface DayBacklinksProps {
  /** The day whose inbound links to show (validated ISO date). */
  date: string
}

/**
 * "Linked from" for the selected day: every note linking to its daily note,
 * with the line around the link (the same query as the in-note backlinks
 * panel, presented as a sidebar section with a quiet empty state).
 */
export function DayBacklinks({ date }: DayBacklinksProps): ReactElement {
  const { navigate } = useRouter()
  const { graph } = useGraph()
  const path = dailyPath(date)
  const { data, isPending, isError } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'backlinks', path],
    queryFn: () => getBacklinksWithContext(path),
    enabled: hasBridge() && graph !== null,
  })

  const backlinks = data ?? []
  return (
    <SidebarSection storageKey="backlinks" title="Linked from" count={data?.length}>
      {isPending ? (
        <p className="px-2 py-1 text-xs text-[color:var(--text-muted)]">Loading…</p>
      ) : isError ? (
        <p role="alert" className="px-2 py-1 text-xs text-[color:var(--text-muted)]">
          Couldn’t load backlinks.
        </p>
      ) : backlinks.length === 0 ? (
        <p className="px-2 py-1 text-xs text-[color:var(--text-muted)]">
          No notes link to this day yet.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {backlinks.map((backlink) => (
            <li key={`${backlink.sourcePath}:${backlink.posFrom}`}>
              <button
                type="button"
                onClick={() => navigate(routeForPath(backlink.sourcePath))}
                className="w-full rounded px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span className="block truncate text-sm font-medium">
                  {backlink.sourceTitle}
                </span>
                {backlink.snippet !== '' ? (
                  <span className="block truncate text-xs text-[color:var(--text-muted)]">
                    {backlink.snippet}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </SidebarSection>
  )
}
