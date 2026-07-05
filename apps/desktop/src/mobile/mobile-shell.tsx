import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { MobileFormattingToolbar } from '@/mobile/formatting-toolbar'
import { MobileStack } from '@/mobile/mobile-stack'
import { MobileTabBar, type MobileTab } from '@/mobile/mobile-tab-bar'
import {
  EMPTY_ALL_NOTES_FILTERS,
  type AllNotesFilters,
} from '@/mobile/search-filters/filter-state'
import { useKeyboardVisible } from '@/mobile/use-keyboard'
import { useWakeToToday } from '@/mobile/use-wake-to-today'
import { routesEqual, type Route } from '@/routing/route'
import { useRouter } from '@/routing/router'

const DAILY_DOUBLE_TAP_MS = 450

type DailyRoute = Extract<Route, { kind: 'today' }> | Extract<Route, { kind: 'daily' }>

function dailyRouteFrom(route: Route): DailyRoute | null {
  return route.kind === 'today' || route.kind === 'daily' ? route : null
}

/**
 * The tabbed mobile shell (Plan 19, V1 parity): screens above, the
 * Daily / All bar below. The active tab derives from the route — a note
 * keeps whichever tab it was opened from, so reading a search result
 * doesn't flip the bar. The All tab's search text and filter badges live
 * here, not in the screen, so opening a note and coming back loses neither.
 */
export function MobileShell(): ReactElement {
  const { route, navigate, entryId } = useRouter()
  const [allQuery, setAllQuery] = useState('')
  const [allFilters, setAllFilters] = useState<AllNotesFilters>(EMPTY_ALL_NOTES_FILTERS)
  const [lastTab, setLastTab] = useState<MobileTab>('daily')
  const [lastDailyRoute, setLastDailyRoute] = useState<DailyRoute>({ kind: 'today' })
  const lastDailyTapAt = useRef<number | null>(null)
  const keyboardVisible = useKeyboardVisible()
  // V1's wake-to-today: foregrounding on a new calendar date lands on today.
  useWakeToToday()

  // A `search` history entry seeds the live query — once per entry, so the
  // user can keep typing without the effect snapping the text back.
  const seededEntry = useRef<number | null>(null)
  useEffect(() => {
    if (route.kind === 'search' && seededEntry.current !== entryId) {
      seededEntry.current = entryId
      setAllQuery(route.query)
    }
  }, [route, entryId])

  // A note keeps whichever tab it was opened from: routes that don't map to a
  // tab fall back to the last one, remembered across renders. Tracking that in
  // state (adjusted during render) avoids reading/writing a ref in render.
  const tab: MobileTab =
    route.kind === 'allNotes' || route.kind === 'search'
      ? 'all'
      : route.kind === 'tasks'
        ? 'tasks'
        : route.kind === 'chat'
          ? 'chat'
          : route.kind === 'today' || route.kind === 'daily'
            ? 'daily'
            : lastTab
  const currentDailyRoute = dailyRouteFrom(route)
  if (tab !== lastTab) {
    setLastTab(tab)
  }
  if (currentDailyRoute !== null && !routesEqual(currentDailyRoute, lastDailyRoute)) {
    setLastDailyRoute(currentDailyRoute)
  }

  useLayoutEffect(() => {
    if (currentDailyRoute === null) {
      lastDailyTapAt.current = null
    }
  }, [currentDailyRoute])

  const handleTabSelect = (next: MobileTab): void => {
    if (next !== 'daily') {
      lastDailyTapAt.current = null
      navigate(
        next === 'tasks'
          ? { kind: 'tasks' }
          : next === 'chat'
            ? { kind: 'chat' }
            : { kind: 'allNotes', tag: null },
      )
      return
    }

    const now = Date.now()
    const doubleTap =
      lastDailyTapAt.current !== null && now - lastDailyTapAt.current <= DAILY_DOUBLE_TAP_MS
    lastDailyTapAt.current = now

    if (doubleTap) {
      navigate({ kind: 'today' }, { focusEditor: true })
      return
    }

    if (currentDailyRoute !== null) {
      return
    }
    navigate(lastDailyRoute, { restoreSurfaceScroll: true })
  }

  return (
    // The shell yields to the software keyboard by height (Plan 19,
    // decision 8): the root ends at the keyboard's top, so every screen's
    // layout — and floating-ui's positioning boundary (`body`), which sizes
    // the editor's autocomplete menus — sees the true visible viewport.
    // Only `position: fixed` elements need `--keyboard-height` themselves.
    <div
      className="flex w-screen flex-col"
      style={{ height: 'calc(100dvh - var(--keyboard-height, 0px))' }}
    >
      <div className="min-h-0 flex-1">
        <MobileStack
          allQuery={allQuery}
          onAllQueryChange={setAllQuery}
          allFilters={allFilters}
          onAllFiltersChange={setAllFilters}
        />
      </div>
      {/* V1 lets the keyboard cover the tab bar; with the root shrunk it
          would ride above the keyboard instead, so it hides while typing.
          Its slot goes to the formatting toolbar, which — sitting at the
          bottom of a root that ends at the keyboard's top — lands exactly
          on the keyboard edge with no fixed positioning. */}
      {keyboardVisible ? (
        <MobileFormattingToolbar />
      ) : (
        <MobileTabBar tab={tab} onSelect={handleTabSelect} />
      )}
    </div>
  )
}
