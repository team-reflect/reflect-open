import { useEffect, useState, type ReactElement } from 'react'
import type { TimerHandle } from '@reflect/core'
import prettyMs from 'pretty-ms'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The time left until `until` (epoch ms) in words, such as `2 minutes`. It
 * re-renders only when the words change. // FIXME: rename BackupCountdown to a more generic name, like CountdownText or something. It is not specific to backup at all.
 */
export function BackupCountdown({ until }: { until: number }): ReactElement {
  return <>{useBackupCountdown(until)}</>
}

/**
 * {@link BackupCountdown} as a string, for surfaces that take text. `null`
 * when `until` is `null`.
 */
export function useBackupCountdown(until: number | null): string | null {
  const { clock } = useCoreServices()
  const [text, setText] = useState(() =>
    until === null ? '' : formatRemaining(until - clock.now()),
  )

  useEffect(() => {
    if (until === null) {
      return
    }
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

  return until === null ? null : text
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
