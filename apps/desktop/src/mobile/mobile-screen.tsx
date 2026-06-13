import { type ReactElement } from 'react'
import { todayIso } from '@/lib/dates'
import { MobileDaily } from '@/mobile/screens/daily'
import { MobileNote } from '@/mobile/screens/note'
import { useRouter } from '@/routing/router'

/**
 * The mobile route switch (Plan 19): the same typed `Route` history desktop
 * uses, rendered one screen at a time. Kinds without a mobile surface yet
 * (search, all-notes, chat, settings) fall back to today — navigation to
 * them only happens once their screens exist in later slices.
 */
export function MobileScreen(): ReactElement {
  const { route } = useRouter()

  switch (route.kind) {
    case 'daily':
      return <MobileDaily key={route.date} date={route.date} />
    case 'note':
      return <MobileNote key={route.path} path={route.path} />
    default:
      return <MobileDaily key="today" date={todayIso()} />
  }
}
