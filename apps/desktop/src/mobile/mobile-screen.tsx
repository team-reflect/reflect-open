import { type ReactElement } from 'react'
import { useToday } from '@/lib/use-today'
import { MobileAllNotes } from '@/mobile/screens/all-notes'
import { MobileDaily } from '@/mobile/screens/daily'
import { MobileNote } from '@/mobile/screens/note'
import { useRouter } from '@/routing/router'

interface MobileScreenProps {
  /** The All tab's search text (owned by the shell — survives navigation). */
  allQuery: string
  onAllQueryChange: (query: string) => void
}

/**
 * The mobile route switch (Plan 19): the same typed `Route` history desktop
 * uses, rendered one screen at a time — the daily spine, notes, and the All
 * tab. Kinds without a mobile surface yet (search, chat, settings) fall back
 * to today. Today is `useToday()`'s **live** date, so an app left open
 * overnight rolls to the new day's note at midnight instead of editing
 * yesterday's.
 */
export function MobileScreen({ allQuery, onAllQueryChange }: MobileScreenProps): ReactElement {
  const { route } = useRouter()
  const today = useToday()

  switch (route.kind) {
    case 'daily':
      return <MobileDaily key={route.date} date={route.date} />
    case 'note':
      return <MobileNote key={route.path} path={route.path} />
    case 'allNotes':
      return <MobileAllNotes query={allQuery} onQueryChange={onAllQueryChange} tag={route.tag} />
    default:
      return <MobileDaily key="today" date={today} />
  }
}
