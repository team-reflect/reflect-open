import { lazy, type ReactElement } from 'react'
import { useToday } from '@/lib/use-today.ts'
import { MobileDaily } from '@/mobile/screens/daily.tsx'
import { MobileNote } from '@/mobile/screens/note.tsx'
import type { AllNotesFilters, Route } from '@reflect/app'

const MobileAllNotes = lazy(async () => {
  const { MobileAllNotes } = await import('@/mobile/screens/all-notes.tsx')
  return { default: MobileAllNotes }
})
const MobileChat = lazy(async () => {
  const { MobileChat } = await import('@/mobile/screens/chat.tsx')
  return { default: MobileChat }
})
const MobileGraphs = lazy(async () => {
  const { MobileGraphs } = await import('@/mobile/screens/graphs.tsx')
  return { default: MobileGraphs }
})
const MobileLicenses = lazy(async () => {
  const { MobileLicenses } = await import('@/mobile/screens/licenses.tsx')
  return { default: MobileLicenses }
})
const MobileSettings = lazy(async () => {
  const { MobileSettings } = await import('@/mobile/screens/settings.tsx')
  return { default: MobileSettings }
})
const MobileTasks = lazy(async () => {
  const { MobileTasks } = await import('@/mobile/screens/tasks.tsx')
  return { default: MobileTasks }
})

interface MobileScreenProps {
  /**
   * The route this screen renders. A prop rather than `useRouterState()` because
   * the stack ({@link MobileStack}) keeps more than one screen mounted at a
   * time — the current route plus the screen a back-swipe would reveal.
   */
  route: Route
  /** The All tab's search text (owned by the shell — survives navigation). */
  allQuery: string
  onAllQueryChange: (query: string) => void
  /** The All tab's badge filters (owned by the shell — survive navigation). */
  allFilters: AllNotesFilters
  onAllFiltersChange: (filters: AllNotesFilters) => void
  /**
   * The Tasks tab's search text (owned by the shell — survives navigation).
   */
  tasksQuery: string
  onTasksQueryChange: (query: string) => void
}

/**
 * The mobile route switch (Plan 19): the same typed `Route` history desktop
 * uses, one screen per route — the daily spine, notes, the All
 * tab (which also hosts `search` entries), the Tasks tab, and the pushed
 * Chat / Settings / Graphs cards. Today is `useToday()`'s **live** date, so
 * an app left open overnight rolls to the new day's note at midnight instead
 * of editing yesterday's.
 */
export function MobileScreen({
  route,
  allQuery,
  onAllQueryChange,
  allFilters,
  onAllFiltersChange,
  tasksQuery,
  onTasksQueryChange,
}: MobileScreenProps): ReactElement {
  const today = useToday()

  switch (route.kind) {
    // One stable key for the whole daily surface (today + any day): a day
    // change scrolls the carousel rather than remounting it.
    case 'daily':
      return <MobileDaily key="daily" date={route.date} />
    case 'note':
      return <MobileNote key={route.path} path={route.path} />
    case 'allNotes':
      return (
        <MobileAllNotes
          query={allQuery}
          onQueryChange={onAllQueryChange}
          tag={route.tag}
          filters={allFilters}
          onFiltersChange={onAllFiltersChange}
        />
      )
    case 'tasks':
      return <MobileTasks key="tasks" query={tasksQuery} onQueryChange={onTasksQueryChange} />
    case 'chat':
      return <MobileChat key="chat" />
    case 'settings':
      switch (route.page) {
        case 'main':
          return <MobileSettings key="settings" />
        case 'graphs':
          return <MobileGraphs key="graphs" />
        case 'licenses':
          return <MobileLicenses key="licenses" />
      }
    default:
      return <MobileDaily key="daily" date={today} />
  }
}
