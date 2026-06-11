import type { ReactElement } from 'react'
import { formatDayLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { routeForPath, routesEqual } from '@/routing/route'
import { useRouter } from '@/routing/router'

interface SidebarNoteRowProps {
  /** Graph-relative path the row navigates to. */
  path: string
  title: string
  /** ISO date when the note is a daily — renders the day label as its title. */
  date: string | null
}

/**
 * One note row in a sidebar list (the Pinned shelf), in the original app's
 * idiom: a plain truncated title — no icon — with an active-route highlight.
 */
export function SidebarNoteRow({ path, title, date }: SidebarNoteRowProps): ReactElement {
  const { route, navigate } = useRouter()
  const { settings } = useSettings()
  const target = routeForPath(path)
  const active = routesEqual(route, target)
  return (
    // The negative margin lets the hover wash bleed past the section's
    // padding so the title text stays on the section's alignment line.
    <li className="-mx-2.5">
      <button
        type="button"
        onClick={() => navigate(target)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex w-full items-center rounded-md px-2.5 py-1 leading-5',
          'transition-colors duration-100',
          active
            ? 'bg-surface-hover text-text dark:bg-transparent dark:text-accent'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text',
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
          {date !== null ? formatDayLabel(date, settings.dateFormat) : title}
        </span>
      </button>
    </li>
  )
}
