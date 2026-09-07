import { lazy, Suspense, type ReactElement } from 'react'
import { DailyStream } from '@/components/daily-stream'
import { LoadingScreen } from '@/components/loading-screen'
import { SearchRoute } from '@/components/search-route'
import { SingleNoteView } from '@/components/single-note-view'
import { useRouter } from '@/routing/router'

const AllNotesScreen = lazy(async () => {
  const { AllNotesScreen } = await import('@/components/all-notes/all-notes-screen')
  return { default: AllNotesScreen }
})
const ChatScreen = lazy(async () => {
  const { ChatScreen } = await import('@/components/chat/chat-screen')
  return { default: ChatScreen }
})
const SettingsRoute = lazy(async () => {
  const { SettingsRoute } = await import('@/components/settings/settings-route')
  return { default: SettingsRoute }
})
const TasksScreen = lazy(async () => {
  const { TasksScreen } = await import('@/components/tasks/tasks-screen')
  return { default: TasksScreen }
})

/**
 * The route → view mapping (Plan 06): the single place a {@link Route} kind
 * becomes a workspace surface. Daily routes render the chronological stream; a
 * `note` route renders one ordinary note as a first-class editable pane (lazy,
 * so ⌘N's fresh path opens before any file exists). Extracted from the
 * workspace shell so this seam — the contract that non-daily notes are just as
 * editable as daily ones — is directly testable. The daily stream owns live
 * today tracking so route arrivals and the highlighted current day use the
 * same clock.
 */
function RouteContentBody(): ReactElement {
  const { route } = useRouter()
  switch (route.kind) {
    case 'today':
      return <DailyStream target={{ kind: 'today' }} />
    case 'daily':
      // The router normalizes daily routes (see normalizeRoute), so the date
      // is a real calendar day by the time it reaches a view.
      return <DailyStream target={{ kind: 'date', date: route.date }} />
    case 'note':
      return <SingleNoteView path={route.path} />
    case 'allNotes':
      // Owns its scroll container (virtualized table + fixed header), so no
      // ScrollRestored wrapper — same shape as the daily stream.
      return <AllNotesScreen tag={route.tag} />
    case 'tasks':
      // Owns its scroll container (a grouped list with a fixed header), so no
      // ScrollRestored wrapper — same shape as All Notes.
      return <TasksScreen />
    case 'search':
      return <SearchRoute query={route.query} />
    case 'chat':
      // Owns its scroll container (the message list pins to the bottom while
      // streaming), so no ScrollRestored wrapper — same shape as All Notes.
      return <ChatScreen />
    case 'graphs':
    // The graph-switcher route is a mobile settings sub-screen; on desktop
    // graph switching lives in the sidebar footer, so it renders as settings.
    case 'settings':
      return <SettingsRoute />
  }
}

export function RouteContent(): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <RouteContentBody />
    </Suspense>
  )
}
