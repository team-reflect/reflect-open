import type { ReactElement } from 'react'
import { AllNotesScreen } from '@/components/all-notes/all-notes-screen'
import { ChatScreen } from '@/components/chat/chat-screen'
import { DailyStream } from '@/components/daily-stream'
import { NotePane } from '@/components/note-pane'
import { SearchRoute } from '@/components/search-route'
import { SettingsNavigator } from '@/components/settings/settings-navigator'
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
      // The vertical padding lives on the inner column (not the scroll
      // container) so `min-h-full` fills the viewport exactly; the flex chain
      // stretches the editor over any leftover space, making the whole note
      // body click-to-focus.
      return (
        <ScrollRestored className="h-full overflow-auto px-6">
          <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col py-8">
            <NotePane
              path={route.path}
              lazy
              autoFocus
              className="flex grow flex-col"
              editorClassName="grow"
            />
          </div>
        </ScrollRestored>
      )
    case 'allNotes':
      // Owns its scroll container (virtualized table + fixed header), so no
      // ScrollRestored wrapper — same shape as the daily stream.
      return <AllNotesScreen tag={route.tag} />
    case 'search':
      return <SearchRoute query={route.query} today={today} />
    case 'chat':
      // Owns its scroll container (the message list pins to the bottom while
      // streaming), so no ScrollRestored wrapper — same shape as All Notes.
      return <ChatScreen />
    case 'settings':
      // The section navigator floats in the left gutter — absolutely
      // positioned off the centered column so the column never shifts — and
      // only renders when the container query says the gutter can fit it:
      // the 42rem column plus a 12rem rail either side, with a little slack.
      return (
        <ScrollRestored className="@container h-full overflow-auto px-6 py-8">
          <div className="relative mx-auto w-full max-w-2xl">
            <div className="absolute inset-y-0 right-full hidden w-48 pr-8 @min-[68rem]:block">
              <SettingsNavigator className="sticky top-8" />
            </div>
            <SettingsScreen />
          </div>
        </ScrollRestored>
      )
  }
}
