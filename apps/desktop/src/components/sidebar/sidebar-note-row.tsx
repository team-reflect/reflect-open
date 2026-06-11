import type { ReactElement } from 'react'
import { CalendarDays, FileText } from 'lucide-react'
import { formatDayLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { routeForPath, routesEqual } from '@/routing/route'
import { useRouter } from '@/routing/router'

interface SidebarNoteRowProps {
  /** Graph-relative path the row navigates to. */
  path: string
  title: string
  /** ISO date when the note is a daily — renders the calendar icon + day label. */
  date: string | null
}

/**
 * One note row in a sidebar list (Pinned, Recents): a nav button with the
 * note-vs-daily icon, truncated label, and active-route highlight. Shared so
 * the sidebar's note lists can't drift apart visually.
 */
export function SidebarNoteRow({ path, title, date }: SidebarNoteRowProps): ReactElement {
  const { route, navigate } = useRouter()
  const { settings } = useSettings()
  const target = routeForPath(path)
  const active = routesEqual(route, target)
  const Icon = date !== null ? CalendarDays : FileText
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate(target)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1 text-[13px]',
          'transition-colors duration-100',
          active
            ? 'bg-surface-hover text-text'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text',
        )}
      >
        <Icon aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-left">
          {date !== null ? formatDayLabel(date, settings.dateFormat) : title}
        </span>
      </button>
    </li>
  )
}
