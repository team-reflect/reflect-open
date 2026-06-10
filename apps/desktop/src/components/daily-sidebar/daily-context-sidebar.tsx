import type { ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { APP_COMMANDS } from '@/lib/commands/app-commands'
import { addDaysIso, formatDayLabel } from '@/lib/dates'
import { useToday } from '@/lib/use-today'
import { useRouter } from '@/routing/router'
import { DayBacklinks } from './day-backlinks'
import { DayCalendar } from './day-calendar'
import { DayRelatedNotes } from './day-related-notes'
import { SidebarSection } from './sidebar-section'

interface DailyContextSidebarProps {
  /** The day the sidebar describes — a validated ISO date from the route. */
  date: string
}

// The hint is derived from the real command definition so it can never drift
// from the actual binding (and disappears if the binding ever does).
const TODAY_KEYBINDING = APP_COMMANDS.find((command) => command.id === 'nav.today')
  ?.keybinding
const TODAY_HINT = TODAY_KEYBINDING
  ? TODAY_KEYBINDING.replace('Mod-', '⌘').toUpperCase()
  : null

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
    <div className="flex flex-col px-2 py-2 text-[color:var(--text)]">
      <header className="border-b border-black/5 px-1 pb-2 dark:border-white/5">
        <div className="flex items-center justify-between gap-1">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => navigate({ kind: 'daily', date: addDaysIso(date, -1) })}
            className="rounded p-1 text-[color:var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/5"
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
            className="rounded p-1 text-[color:var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/5"
          >
            <ChevronRight aria-hidden className="size-4" />
          </button>
        </div>
        <div className="mt-0.5 text-center">
          {isToday ? (
            <span className="text-xs font-medium text-[color:var(--accent)]">Today</span>
          ) : (
            <button
              type="button"
              onClick={() => navigate({ kind: 'today' })}
              className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-[color:var(--accent)] hover:bg-black/5 dark:hover:bg-white/5"
            >
              Go to today
              {TODAY_HINT !== null ? (
                <kbd className="rounded border border-black/10 px-1 font-sans text-[10px] text-[color:var(--text-muted)] dark:border-white/10">
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
      <DayBacklinks date={date} />
      <DayRelatedNotes date={date} />
    </div>
  )
}
