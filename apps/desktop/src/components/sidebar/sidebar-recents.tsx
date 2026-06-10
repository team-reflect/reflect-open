import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { dailyPath, hasBridge, suggestWikiTargets } from '@reflect/core'
import { CalendarDays, FileText } from 'lucide-react'
import { formatDayLabel } from '@/lib/dates'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath, routesEqual } from '@/routing/route'
import { useRouter } from '@/routing/router'

const RECENTS_LIMIT = 8

/**
 * The sidebar's Recents section — the same recall feed the empty ⌘K palette
 * shows (recency-ordered title suggestions from the index), kept short: the
 * palette is the deep archive, this is ambient memory.
 */
export function SidebarRecents(): ReactElement | null {
  const { graph } = useGraph()
  const { route, navigate } = useRouter()
  const { data: suggestions } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'sidebar-recents'],
    queryFn: () => suggestWikiTargets('', RECENTS_LIMIT),
    enabled: hasBridge() && graph !== null,
  })

  const seen = new Set<string>()
  const entries = (suggestions ?? []).flatMap((suggestion) => {
    // A pathless suggestion is a valid daily whose file doesn't exist yet (the
    // lazy-creation contract) — synthesize its daily path so it stays jumpable.
    const path = suggestion.path ?? (suggestion.date !== null ? dailyPath(suggestion.date) : null)
    if (path === null || seen.has(path)) {
      return []
    }
    seen.add(path)
    return [{ path, title: suggestion.title, date: suggestion.date }]
  })

  if (entries.length === 0) {
    return null
  }

  return (
    <section aria-label="Recent notes">
      <h2 className="px-2.5 pb-1 pt-4 text-[11px] font-semibold tracking-[0.08em] text-[color:var(--text-muted)] uppercase">
        Recents
      </h2>
      <ul className="flex flex-col gap-px">
        {entries.map((entry) => {
          const target = routeForPath(entry.path)
          const active = routesEqual(route, target)
          const Icon = entry.date !== null ? CalendarDays : FileText
          return (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => navigate(target)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1 text-[13px]',
                  'transition-colors duration-100',
                  active
                    ? 'bg-[var(--surface-hover)] text-[color:var(--text)]'
                    : 'text-[color:var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[color:var(--text)]',
                )}
              >
                <Icon
                  aria-hidden
                  strokeWidth={1.75}
                  className="size-3.5 shrink-0 text-[color:var(--text-muted)]"
                />
                <span className="min-w-0 flex-1 truncate text-left">
                  {entry.date !== null ? formatDayLabel(entry.date) : entry.title}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
