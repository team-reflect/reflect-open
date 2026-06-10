import type { ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { keybindingFor } from '@/lib/commands/app-commands'
import { formatBindingLabel } from '@/lib/keybindings'
import { addDaysIso, formatDayLabel } from '@/lib/dates'
import { useToday } from '@/lib/use-today'
import { useRouter } from '@/routing/router'
import { DayCalendar } from './day-calendar'
import { SidebarBacklinks } from './sidebar-backlinks'
import { SidebarRelatedNotes } from './sidebar-related-notes'
import { SidebarSection } from './sidebar-section'

interface DailyContextSidebarProps {
  /** The day the sidebar describes — a validated ISO date from the route. */
  date: string
}

// Derived from the command definition (keybindingFor) and formatted per
// platform (⌘D on Apple, Ctrl+D elsewhere) by the shared keybinding formatter.
const TODAY_KEYBINDING = keybindingFor('nav.today')
const TODAY_HINT = TODAY_KEYBINDING !== null ? formatBindingLabel(TODAY_KEYBINDING) : null

/**
 * The daily note's contextual sidebar (modeled on the old app's note context
 * sidebar): adjacent-day navigation, a month calendar marking days with
 * notes, the day's inbound links, and semantic neighbors when embeddings are
 * available. Rendered in the AppShell's right region on daily routes only.
 */
export function DailyContextSidebar({ date }: DailyContextSidebarProps): ReactElement {
  const { navigate } = useRouter()
  const today = useToday()
  const isToday = date === today

  return (
    <div className="flex flex-col px-2 py-2 text-text">
      <header className="border-b border-black/5 px-1 pb-2 dark:border-white/5">
        <div className="flex items-center justify-between gap-1">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => navigate({ kind: 'daily', date: addDaysIso(date, -1) })}
            className="rounded p-1 text-text-secondary hover:bg-surface-hover"
          >
            <ChevronLeft aria-hidden className="size-4" />
          </button>
          <h2 className="min-w-0 truncate text-sm font-semibold">
            {formatDayLabel(date)}
          </h2>
          <button
            type="button"
            aria-label="Next day"
            onClick={() => navigate({ kind: 'daily', date: addDaysIso(date, 1) })}
            className="rounded p-1 text-text-secondary hover:bg-surface-hover"
          >
            <ChevronRight aria-hidden className="size-4" />
          </button>
        </div>
        <div className="mt-0.5 text-center">
          {isToday ? (
            <span className="text-xs font-medium text-accent">Today</span>
          ) : (
            <button
              type="button"
              onClick={() => navigate({ kind: 'today' })}
              className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-surface-hover"
            >
              Go to today
              {TODAY_HINT !== null ? (
                <kbd className="rounded border border-black/10 px-1 font-sans text-[10px] text-text-muted dark:border-white/10">
                  {TODAY_HINT}
                </kbd>
              ) : null}
            </button>
          )}
        </div>
      </header>

      <SidebarSection storageKey="calendar" title="Calendar">
        <DayCalendar selectedDate={date} today={today} />
      </SidebarSection>
      <SidebarBacklinks
        path={dailyPath(date)}
        emptyText="No notes link to this day yet."
      />
      <SidebarRelatedNotes path={dailyPath(date)} />
    </div>
  )
}
