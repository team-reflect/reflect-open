import { useEffect, useRef, useState, type ReactElement } from 'react'
import { MobileScreen } from '@/mobile/mobile-screen'
import { MobileTabBar, type MobileTab } from '@/mobile/mobile-tab-bar'
import { useWakeToToday } from '@/mobile/use-wake-to-today'
import { useRouter } from '@/routing/router'

/**
 * The tabbed mobile shell (Plan 19, V1 parity): screens above, the
 * Daily / All bar below. The active tab derives from the route — a note
 * keeps whichever tab it was opened from, so reading a search result
 * doesn't flip the bar. The All tab's search text lives here, not in the
 * screen, so opening a note and coming back doesn't lose the query.
 */
export function MobileShell(): ReactElement {
  const { route, navigate, entryId } = useRouter()
  const [allQuery, setAllQuery] = useState('')
  const [lastTab, setLastTab] = useState<MobileTab>('daily')
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
    <div className="flex h-dvh w-screen flex-col">
      <div className="min-h-0 flex-1">
        <MobileScreen allQuery={allQuery} onAllQueryChange={setAllQuery} />
      </div>
      <MobileTabBar
        tab={tab}
        onSelect={(next) =>
          navigate(next === 'daily' ? { kind: 'today' } : { kind: 'allNotes', tag: null })
        }
      />
    </div>
  )
}
