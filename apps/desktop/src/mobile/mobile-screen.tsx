import { type ReactElement } from 'react'
import { useToday } from '@/lib/use-today'
import { MobileDaily } from '@/mobile/screens/daily'
import { MobileNote } from '@/mobile/screens/note'
import { useRouter } from '@/routing/router'

/**
 * The mobile route switch (Plan 19): the same typed `Route` history desktop
 * uses, rendered one screen at a time. Kinds without a mobile surface yet
 * (search, all-notes, chat, settings) fall back to today — navigation to
 * them only happens once their screens exist in later slices. Today is
 * `useToday()`'s **live** date, so an app left open overnight rolls to the
 * new day's note at midnight instead of editing yesterday's.
 */
export function MobileScreen(): ReactElement {
  const { route } = useRouter()
  const today = useToday()

  switch (route.kind) {
    case 'daily':
      return <MobileDaily key={route.date} date={route.date} />
    case 'note':
      return <MobileNote key={route.path} path={route.path} />
    default:
      return <MobileDaily key="today" date={today} />
  }
}
