import { useEffect, useState } from 'react'
import { routesEqual, type Route } from '@reflect/app'
import { tabRootFor, type MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

function sameScreen(left: Route | null, right: Route | null): boolean {
  return left === null || right === null ? left === right : routesEqual(left, right)
}

/**
 * The screen the All tab was left on, for a tab tap to return to: the last
 * card pushed over All (Chat, a note opened from the list, Settings reached
 * from Chat's setup prompt), or `null` when All was last on its list. Only
 * the top card is kept, not the stack under it. A remembered note follows
 * file moves, as the router's history does, so a return never lands on a
 * path that no longer exists.
 *
 * @param route The current route.
 * @param tab The tab the shell shows as current for `route`.
 */
export function useAllTabScreen(route: Route, tab: MobileTab): Route | null {
  const { noteMove } = useCoreServices()
  const [screen, setScreen] = useState<Route | null>(null)

  // Adjusted during render (the shell's `lastTab` pattern) so a tab tap in
  // the same frame already sees the screen All was just left on.
  if (tab === 'all') {
    const current = tabRootFor(route) === null ? route : null
    if (!sameScreen(current, screen)) {
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

  return screen
}
