import { useEffect, useRef, useState, type ReactElement } from 'react'
import { MobileScreen } from '@/mobile/mobile-screen'
import { MobileTabBar, type MobileTab } from '@/mobile/mobile-tab-bar'
import {
  EMPTY_ALL_NOTES_FILTERS,
  type AllNotesFilters,
} from '@/mobile/search-filters/filter-state'
import { useKeyboardVisible } from '@/mobile/use-keyboard'
import { useWakeToToday } from '@/mobile/use-wake-to-today'
import { useRouter } from '@/routing/router'

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
      : route.kind === 'today' || route.kind === 'daily'
        ? 'daily'
        : lastTab
  if (tab !== lastTab) {
    setLastTab(tab)
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
        <MobileScreen
          allQuery={allQuery}
          onAllQueryChange={setAllQuery}
          allFilters={allFilters}
          onAllFiltersChange={setAllFilters}
        />
      </div>
      {/* V1 lets the keyboard cover the tab bar; with the root shrunk it
          would ride above the keyboard instead, so it hides while typing. */}
      {keyboardVisible ? null : (
        <MobileTabBar
          tab={tab}
          onSelect={(next) =>
            navigate(next === 'daily' ? { kind: 'today' } : { kind: 'allNotes', tag: null })
          }
        />
      )}
    </div>
  )
}
