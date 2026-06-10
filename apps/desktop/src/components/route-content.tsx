import type { ReactElement } from 'react'
import { DailyStream } from '@/components/daily-stream'
import { NotePane } from '@/components/note-pane'
import { SearchRoute } from '@/components/search-route'
import { SettingsScreen } from '@/components/settings-screen'
import { useToday } from '@/lib/use-today'
import { useRouter } from '@/routing/router'
import { ScrollRestored } from '@/routing/scroll-restore'

/**
 * The route → view mapping (Plan 06): the single place a {@link Route} kind
 * becomes a workspace surface. Daily routes render the chronological stream; a
 * `note` route renders one ordinary note as a first-class editable pane (lazy,
 * so ⌘N's fresh path opens before any file exists). Extracted from the
 * workspace shell so this seam — the contract that non-daily notes are just as
 * editable as daily ones — is directly testable. `today` tracks the live
 * clock — midnight re-renders it.
 */
export function RouteContent(): ReactElement {
  const { route } = useRouter()
  const today = useToday()
  switch (route.kind) {
    case 'today':
      return <DailyStream targetDate={today} />
    case 'daily':
      // The router normalizes daily routes (see normalizeRoute), so the date
      // is a real calendar day by the time it reaches a view.
      return <DailyStream targetDate={route.date} />
    case 'note':
      return (
        <ScrollRestored className="h-full overflow-auto px-6 py-8">
          <div className="mx-auto w-full max-w-2xl">
            <NotePane path={route.path} lazy autoFocus contextInSidebar />
          </div>
        </ScrollRestored>
      )
    case 'search':
      return <SearchRoute query={route.query} today={today} />
    case 'settings':
      return (
        <ScrollRestored className="h-full overflow-auto px-6 py-8">
          <div className="mx-auto w-full max-w-2xl">
            <SettingsScreen />
          </div>
        </ScrollRestored>
      )
  }
}
