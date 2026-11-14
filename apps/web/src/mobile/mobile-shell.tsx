import { Suspense, useEffect, useRef, useState, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen.tsx'
import { useDoubleTap } from '@/hooks/use-double-tap.ts'
import { MobileStack } from '@/mobile/mobile-stack.tsx'
import { mobileTabForSection, type MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import { SafeAreaBoundary } from '@/mobile/safe-area-boundary.tsx'
import { EMPTY_ALL_NOTES_FILTERS, type AllNotesFilters } from '@reflect/app'
import { useKeyboardVisible } from '@/mobile/use-keyboard.ts'
import { useChromeRenderer } from '@/mobile/chrome/chrome-renderer.ts'
import { useMobileForm } from '@/mobile/mobile-form.ts'
import { useWakeToToday } from '@/mobile/use-wake-to-today.ts'
import { useRouterState, useRouterActions } from '@/routing/router.tsx'
import { useSyncChatSection } from '@/mobile/sidebar.ts'

/**
 * The tabbed mobile shell (Plan 19, V1 parity): screens above, the
 * Daily / All / Tasks bar below. The active tab is the section of the
 * history entry on screen, so a note keeps the tab it was opened from. The
 * All tab's search text and filter badges live here, not in the screen, so
 * opening a note and coming back loses neither. A tab tap from another tab
 * returns to where that tab was left (Daily to its last day, All and Tasks
 * to their last screen); a tap within the tab goes to its root.
 */
export function MobileShell(): ReactElement {
  const { route, entryId, section } = useRouterState()
  const { navigate, selectSection } = useRouterActions()
  const [allQuery, setAllQuery] = useState('')
  const [allFilters, setAllFilters] = useState<AllNotesFilters>(EMPTY_ALL_NOTES_FILTERS)
  const tab = mobileTabForSection(section)
  // A tab double-tap is a capture gesture (Daily focuses today's editor; the
  // list tabs focus their search inputs); a pending tap expires if the shown
  // tab changes between taps (a deep link elsewhere), so that second tap is a
  // return, not a double-tap. Watching the shown tab, not its root, lets the
  // tap that returns to a tab's card still pair with a quick second tap.
  const isDoubleTap = useDoubleTap<MobileTab>(tab)
  const keyboardVisible = useKeyboardVisible()
  const chromeRenderer = useChromeRenderer()
  const form = useMobileForm()
  // V1's wake-to-today: foregrounding on a new calendar date lands on today.
  useWakeToToday()
  useSyncChatSection()

  // A `search` history entry seeds the live query — once per entry, so the
  // user can keep typing without the effect snapping the text back.
  const seededEntryRef = useRef<number | null>(null)
  useEffect(() => {
    if (route.kind === 'search' && seededEntryRef.current !== entryId) {
      seededEntryRef.current = entryId
      setAllQuery(route.query)
    }
  }, [route, entryId])

  const handleTabSelect = (next: MobileTab): void => {
    const doubleTap = isDoubleTap(next)

    // The list tabs' double-tap is a search gesture: it lands on the root
    // with the search input focused (the Daily tab's capture double-tap,
    // list-flavored).
    if (next !== 'daily') {
      selectSection(next, doubleTap ? { focusEditor: true } : undefined)
      return
    }

    if (doubleTap) {
      navigate({ kind: 'today' }, { focusEditor: true })
      return
    }

    if (route.kind === 'today' || route.kind === 'daily') {
      return
    }
    selectSection('daily')
  }

  return (
    <SafeAreaBoundary>
      {/* The shell yields to the software keyboard by height (Plan 19,
          decision 8): the root ends at the keyboard's top, so every screen's
          layout sees the true visible viewport. Only `position: fixed`
          elements need `--keyboard-height` themselves. */}
      <div
        className="mobile-shell flex w-screen flex-col"
        style={{
          ...chromeRenderer.shellStyle(form),
          height: 'calc(100dvh - var(--keyboard-height, 0px))',
        }}
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
        <chromeRenderer.ShellBars
          form={form}
          tab={tab}
          keyboardVisible={keyboardVisible}
          onSelectTab={handleTabSelect}
        />
      </div>
    </SafeAreaBoundary>
  )
}
