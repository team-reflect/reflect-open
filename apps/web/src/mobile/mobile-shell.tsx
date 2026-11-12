import { Suspense, useEffect, useRef, useState, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen.tsx'
import { useDoubleTap } from '@/hooks/use-double-tap.ts'
import { MobileFormattingToolbar } from '@/mobile/formatting-toolbar.tsx'
import { MobileStack } from '@/mobile/mobile-stack.tsx'
import { MobileTabBar, tabRootFor, type MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import { SafeAreaBoundary } from '@/mobile/safe-area-boundary.tsx'
import { useAllTabScreen } from '@/mobile/use-all-tab-screen.ts'
import {
  EMPTY_ALL_NOTES_FILTERS,
  type AllNotesFilters,
  routesEqual,
  type Route,
} from '@reflect/app'
import { useKeyboardVisible } from '@/mobile/use-keyboard.ts'
import { useChromeRenderer } from '@/mobile/chrome/chrome-renderer.ts'
import '@/mobile/native-chrome/native-chrome.css'
import { useWakeToToday } from '@/mobile/use-wake-to-today.ts'
import { useRouterState, useRouterActions } from '@/routing/router.tsx'

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
 * All also remembers the card it was left on (an open Chat or note): tapping
 * All from another tab returns to it, and tapping All again, or
 * double-tapping it, goes back to the list.
 */
export function MobileShell(): ReactElement {
  const { route, entryId, backRoute } = useRouterState()
  const { navigate } = useRouterActions()
  const [allQuery, setAllQuery] = useState('')
  const [allFilters, setAllFilters] = useState<AllNotesFilters>(EMPTY_ALL_NOTES_FILTERS)
  const [lastTab, setLastTab] = useState<MobileTab>('daily')
  const [lastDailyRoute, setLastDailyRoute] = useState<DailyRoute>({ kind: 'today' })
  // A card (a note, Chat) keeps the tab of the screen it was opened from:
  // the tab root its Back reveals, which also covers All returning to its
  // card with the list put beneath it in the same render. Deeper cards (a
  // note opened from a note) fall back to the last tab, remembered across
  // renders. Tracking that in state (adjusted during render) avoids
  // reading/writing a ref in render.
  const tab: MobileTab =
    tabRootFor(route) ?? (backRoute === null ? null : tabRootFor(backRoute)) ?? lastTab
  // A tab double-tap is a capture gesture (Daily focuses today's editor; the
  // list tabs focus their search inputs); a pending tap expires if the shown
  // tab changes between taps (a deep link elsewhere), so that second tap is a
  // return, not a double-tap. Watching the shown tab, not its root, lets the
  // All tap that returns to its open card still pair with a quick second tap.
  const isDoubleTap = useDoubleTap<MobileTab>(tab)
  const keyboardVisible = useKeyboardVisible()
  const chromeRenderer = useChromeRenderer()
  // V1's wake-to-today: foregrounding on a new calendar date lands on today.
  useWakeToToday()

  // A `search` history entry seeds the live query — once per entry, so the
  // user can keep typing without the effect snapping the text back.
  const seededEntryRef = useRef<number | null>(null)
  useEffect(() => {
    if (route.kind === 'search' && seededEntryRef.current !== entryId) {
      seededEntryRef.current = entryId
      setAllQuery(route.query)
    }
  }, [route, entryId])

  const currentDailyRoute = dailyRouteFrom(route)
  if (tab !== lastTab) {
    setLastTab(tab)
  }
  if (currentDailyRoute !== null && !routesEqual(currentDailyRoute, lastDailyRoute)) {
    setLastDailyRoute(currentDailyRoute)
  }
  const allScreen = useAllTabScreen(route, tab)

  const handleTabSelect = (next: MobileTab): void => {
    const doubleTap = isDoubleTap(next)
    // From another tab, All returns to the card it was left on.
    const restoredAllScreen = next === 'all' && tab !== 'all' ? allScreen : null

    if (next === 'all') {
      const allList: Route = { kind: 'allNotes', tag: null }
      if (restoredAllScreen !== null && !doubleTap) {
        // The list goes underneath, so the card's Back lands on All (and the
        // bar lights All), not the tab just left.
        navigate(allList)
        navigate(restoredAllScreen)
        return
      }
      // Tapped on All (its list or a card over it), the tab pops back to the
      // list. The double-tap is a search gesture: it lands there with the
      // search input focused (the Daily tab's capture double-tap,
      // All-flavored).
      navigate(allList, doubleTap ? { focusEditor: true } : undefined)
      return
    }

    if (next === 'tasks') {
      navigate({ kind: 'tasks' }, doubleTap ? { focusEditor: true } : undefined)
      return
    }

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
    <SafeAreaBoundary>
      <chromeRenderer.ShellBars
        tab={tab}
        keyboardVisible={keyboardVisible}
        onSelectTab={handleTabSelect}
      />
      {/* The shell yields to the software keyboard by height (Plan 19,
          decision 8): the root ends at the keyboard's top, so every screen's
          layout sees the true visible viewport. Only `position: fixed`
          elements need `--keyboard-height` themselves. */}
      <div
        className="mobile-shell flex w-screen flex-col"
        style={{ height: 'calc(100dvh - var(--keyboard-height, 0px))' }}
      >
        <div className="min-h-0 flex-1">
          {/* A stable boundary lets route transitions retain the current screen while lazy code loads. */}
          <Suspense fallback={<LoadingScreen />}>
            <MobileStack
              allQuery={allQuery}
              onAllQueryChange={setAllQuery}
              allFilters={allFilters}
              onAllFiltersChange={setAllFilters}
            />
          </Suspense>
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
    </SafeAreaBoundary>
  )
}
