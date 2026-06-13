import { useRef, useState, type ReactElement } from 'react'
import { MobileScreen } from '@/mobile/mobile-screen'
import { MobileTabBar, type MobileTab } from '@/mobile/mobile-tab-bar'
import { useRouter } from '@/routing/router'

/**
 * The tabbed mobile shell (Plan 19, V1 parity): screens above, the
 * Daily / All bar below. The active tab derives from the route — a note
 * keeps whichever tab it was opened from, so reading a search result
 * doesn't flip the bar. The All tab's search text lives here, not in the
 * screen, so opening a note and coming back doesn't lose the query.
 */
export function MobileShell(): ReactElement {
  const { route, navigate } = useRouter()
  const [allQuery, setAllQuery] = useState('')
  const lastTab = useRef<MobileTab>('daily')

  const tab: MobileTab =
    route.kind === 'allNotes' || route.kind === 'search'
      ? 'all'
      : route.kind === 'today' || route.kind === 'daily'
        ? 'daily'
        : lastTab.current
  lastTab.current = tab

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
