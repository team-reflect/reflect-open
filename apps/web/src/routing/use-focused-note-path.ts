import { focusedNotePathForRoute } from '@reflect/app'
import { useToday } from '@/lib/use-today.ts'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider.tsx'
import { useRouterState } from './router.tsx'

/**
 * The note that note-scoped commands act on, or null on screens that edit no
 * note. In the daily stream it is the focused day, the same note the context
 * sidebar describes.
 */
export function useFocusedNotePath(): string | null {
  const { route } = useRouterState()
  const today = useToday()
  const focusedDailyDate = useFocusedDailyDate()
  return focusedNotePathForRoute(route, today, focusedDailyDate)
}
