import { useEffect, useState, type ReactElement } from 'react'
import type { TimerHandle } from '@reflect/core'
import prettyMs from 'pretty-ms'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The time left until `until` (epoch ms) in words, such as `2 minutes`. It
 * re-renders only when the words change.
 */
export function CountdownText({ until }: { until: number }): ReactElement {
  const { clock } = useCoreServices()
  const [text, setText] = useState(() => formatRemaining(until - clock.now()))

  useEffect(() => {
    let handle: TimerHandle | undefined
    const tick = (): void => {
      const remaining = until - clock.now()
      setText(formatRemaining(remaining))
      if (remaining > 0) {
        handle = clock.setTimeout(tick, msUntilNextChange(remaining))
      }
    }
    tick()
    return () => {
      if (handle !== undefined) {
        clock.clearTimeout(handle)
      }
    }
  }, [clock, until])

  return <>{text}</>
}

function formatRemaining(ms: number): string {
  // Whole seconds: pretty-ms words anything under a second in milliseconds.
  const seconds = Math.floor(Math.max(ms, 0) / 1000)
  return seconds === 0 ? '0 seconds' : prettyMs(seconds * 1000, { compact: true, verbose: true })
}

function msUntilNextChange(remaining: number): number {
  const unit = remaining >= 60_000 ? 60_000 : 1_000
  return (remaining % unit) + 1
}
