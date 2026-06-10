import { useEffect, useState } from 'react'
import { todayIso } from './dates'

/**
 * Today's ISO date as **live** state: re-renders when local midnight passes
 * (foundations hardening — an app left open overnight previously kept
 * yesterday's "Today" until some unrelated re-render). The timer re-arms each
 * rollover; a small pad absorbs timer drift around the boundary.
 */
export function useToday(): string {
  const [today, setToday] = useState(todayIso)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      const now = new Date()
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      timer = setTimeout(() => {
        setToday(todayIso())
        arm()
      }, midnight.getTime() - now.getTime() + 250)
    }
    arm()
    return () => {
      clearTimeout(timer)
    }
  }, [])
  return today
}
