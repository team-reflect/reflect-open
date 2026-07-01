import type { ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { DailyEventsSection } from './daily-events-section'
import { DayCalendar } from './day-calendar'
import { NoteActionsSection } from './note-actions-section'
import { PublishedUrlSection } from './published-url-section'
import { SimilarNotesSection } from './similar-notes-section'
import { useToday } from '@/lib/use-today'
import { cn } from '@/lib/utils'
import { hasMacosTitleBarOverlay } from '@/lib/window-chrome'

interface DailyContextSidebarProps {
  /** The day the sidebar describes — a validated ISO date from the route. */
  date: string
}

/**
 * The daily note's contextual sidebar (modeled on the old app's note context
 * sidebar): the month calendar up top — itself the day-navigation surface,
 * with a jump-to-today button — then note actions and semantic neighbors.
 * Inbound links live under the note itself (the incoming-backlinks section),
 * not here. Rendered in the AppShell's right region on daily routes only.
 */
export function DailyContextSidebar({ date }: DailyContextSidebarProps): ReactElement {
  const today = useToday()

  return (
    <div
      className={cn(
        'flex flex-col text-text',
        // The calendar's controls must clear the WindowDragRegion strip when
        // the macOS title bar is overlaid.
        hasMacosTitleBarOverlay ? 'pt-0' : 'pt-2',
      )}
    >
      <DayCalendar selectedDate={date} today={today} />
      <div className="my-4 space-y-4 pb-4">
        <DailyEventsSection date={date} />
        <NoteActionsSection path={dailyPath(date)} />
        <PublishedUrlSection path={dailyPath(date)} />
        <SimilarNotesSection path={dailyPath(date)} />
      </div>
    </div>
  )
}
