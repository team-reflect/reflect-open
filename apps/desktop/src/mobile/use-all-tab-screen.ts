import { useEffect, useState } from 'react'
import type { Route } from '@reflect/app'
import { tabRootFor, type MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The screen the All tab was left on, for a tab tap to return to: the last
 * card pushed over All (Chat, a note opened from the list, Settings reached
 * from Chat's setup prompt), or `null` when All was last on its list. Only
 * the top card is kept, not the stack under it. A remembered note follows
 * file moves, as the router's history does, and is forgotten once it is
 * trashed in the app.
 *
 * @param route The current route.
 * @param tab The tab the shell shows as current for `route`.
 */
export function useAllTabScreen(route: Route, tab: MobileTab): Route | null {
  const { noteMove, noteRows } = useCoreServices()
  const [screen, setScreen] = useState<Route | null>(null)

  // Adjusted during render (the shell's `lastTab` pattern) so a tab tap in
  // the same frame already sees the screen All was just left on. Router
  // history hands out one route object per entry, so identity is enough.
  if (tab === 'all') {
    const current = tabRootFor(route) === null ? route : null
    if (current !== screen) {
      setScreen(current)
    }
  }

  useEffect(() => {
    return noteMove.onMoved((from, to) => {
      setScreen((current) => {
        return current?.kind === 'note' && current.path === from
          ? { kind: 'note', path: to }
          : current
      })
    })
  }, [noteMove])

  useEffect(() => {
    return noteRows.subscribe(() => {
      const overlays = noteRows.get()
      setScreen((current) => {
        return current?.kind === 'note' && overlays.get(current.path)?.trashed === true
          ? null
          : current
      })
    })
  }, [noteRows])

  return screen
}
