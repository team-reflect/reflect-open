import { useEffect, useState } from 'react'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The clock's current time (epoch ms) as live state, refreshed every `intervalMs`.
 */
export function useNow(intervalMs: number): number {
  const { clock } = useCoreServices()
  const [now, setNow] = useState(() => clock.now())
  useEffect(() => {
    const handle = clock.setInterval(() => {
      setNow(clock.now())
    }, intervalMs)
    return () => {
      clock.clearInterval(handle)
    }
  }, [clock, intervalMs])
  return now
}
