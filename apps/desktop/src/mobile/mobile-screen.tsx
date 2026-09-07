import type { ReactElement } from 'react'
import { useToday } from '@/lib/use-today'
import { MobileAllNotesDynamic } from '@/mobile/screens/all-notes-dynamic'
import { MobileChatDynamic } from '@/mobile/screens/chat-dynamic'
import { MobileDaily } from '@/mobile/screens/daily'
import { MobileGraphsDynamic } from '@/mobile/screens/graphs-dynamic'
import { MobileNote } from '@/mobile/screens/note'
import { MobileSettingsDynamic } from '@/mobile/screens/settings-dynamic'
import { MobileTasksDynamic } from '@/mobile/screens/tasks-dynamic'
import type { AllNotesFilters } from '@/mobile/search-filters/filter-state'
import type { Route } from '@/routing/route'

interface MobileScreenProps {
  /**
   * The route this screen renders. A prop rather than `useRouter()` because
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
}

/**
 * The mobile route switch (Plan 19): the same typed `Route` history desktop
 * uses, one screen per route — the daily spine, notes, the All
 * tab (which also hosts `search` entries), the Tasks and Chat tabs, and the
 * pushed Settings / Graphs cards. Today is `useToday()`'s **live** date, so
 * an app left open overnight rolls to the new day's note at midnight instead
 * of editing yesterday's.
 */
export function MobileScreen({
  route,
  allQuery,
  onAllQueryChange,
  allFilters,
  onAllFiltersChange,
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
        <MobileAllNotesDynamic
          query={allQuery}
          onQueryChange={onAllQueryChange}
          tag={route.tag}
          filters={allFilters}
          onFiltersChange={onAllFiltersChange}
        />
      )
    case 'search':
      // Mobile has no dedicated search surface: a search entry (shared
      // history shapes with desktop) renders as the All tab; the shell seeds
      // the live query from the entry.
      return (
        <MobileAllNotesDynamic
          query={allQuery}
          onQueryChange={onAllQueryChange}
          tag={null}
          filters={allFilters}
          onFiltersChange={onAllFiltersChange}
        />
      )
    case 'tasks':
      return <MobileTasksDynamic key="tasks" />
    case 'chat':
      return <MobileChatDynamic key="chat" />
    case 'settings':
      return <MobileSettingsDynamic key="settings" />
    case 'graphs':
      return <MobileGraphsDynamic key="graphs" />
    default:
      return <MobileDaily key="daily" date={today} />
  }
}
