import { useEffect, type ReactElement } from 'react'
import { usePalette } from '@/components/command-palette/palette-provider'
import { DailyStream } from '@/components/daily-stream'
import { NotePane } from '@/components/note-pane'
import { SettingsScreen } from '@/components/settings-screen'
import { isIsoDate } from '@/lib/dates'
import { useToday } from '@/lib/use-today'
import { useRouter } from '@/routing/router'
import { ScrollRestored } from '@/routing/scroll-restore'

/**
 * The route → view mapping (Plan 06): daily routes render the chronological
 * stream; a `note` route renders one ordinary note as a first-class editable
 * pane (lazy, so ⌘N's fresh path opens before any file exists). Extracted from
 * the workspace shell so this seam — the contract that non-daily notes are
 * just as editable as daily ones — is directly testable.
 */

/**
 * `search/:query` is a deep-link target, not a second search surface (decided
 * 2026-06-09): arriving opens the ⌘K palette pre-filled over the stream.
 */
function SearchRoute({ query, today }: { query: string; today: string }): ReactElement {
  const { openPalette } = usePalette()
  const { arrivalSeq, entryId } = useRouter()
  // Keyed on the *arrival*, not just the value (the daily stream's lesson):
  // re-navigating to the same search route bumps arrivalSeq without a remount,
  // and back/forward changes entryId without bumping arrivalSeq — both are
  // arrivals, and arriving on search opens the palette (decided).
  useEffect(() => {
    openPalette(query)
  }, [query, arrivalSeq, entryId, openPalette])
  return <DailyStream targetDate={today} />
}

/** Route → view. `today` tracks the live clock — midnight re-renders it. */
export function RouteContent(): ReactElement {
  const { route } = useRouter()
  const today = useToday()
  switch (route.kind) {
    case 'today':
      return <DailyStream targetDate={today} />
    case 'daily':
      // A malformed date (impossible calendar day) anchors to today instead of
      // letting dailyPath throw mid-render.
      return <DailyStream targetDate={isIsoDate(route.date) ? route.date : today} />
    case 'note':
      return (
        <ScrollRestored className="h-full overflow-auto px-6 py-8">
          <div className="mx-auto w-full max-w-2xl">
            <NotePane path={route.path} lazy autoFocus />
          </div>
        </ScrollRestored>
      )
    case 'search':
      return <SearchRoute query={route.query} today={today} />
    case 'settings':
      return (
        <ScrollRestored className="h-full overflow-auto px-6 py-8">
          <div className="mx-auto w-full max-w-2xl">
            <SettingsScreen />
          </div>
        </ScrollRestored>
      )
  }
}
