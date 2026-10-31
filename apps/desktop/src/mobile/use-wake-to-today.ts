import { useEffect } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * V1's wake-to-today: when the app returns to the foreground on a later
 * calendar date than it was last seen on, navigate to today — open the app,
 * see today. The detection lives in `DailyNoteService`; an app left *open*
 * across midnight rolls over via `useToday` instead, so this only handles the
 * backgrounded case.
 */
export function useWakeToToday(): void {
  const { navigate } = useRouter()
  const { dailyNotes } = useCoreServices()
  useEffect(() => {
    return dailyNotes.subscribeWakeOnNewDay(() => {
      navigate({ kind: 'today' })
    })
  }, [dailyNotes, navigate])
}
