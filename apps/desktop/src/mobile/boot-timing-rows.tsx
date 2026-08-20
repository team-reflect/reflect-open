import { useSyncExternalStore, type ReactElement } from 'react'
import { getBootTimings, subscribeBootTimings } from '@/mobile/boot-timing'
import { SettingsValueRow } from '@/mobile/settings-list'

/**
 * Temporary: the recorded boot timings as Settings rows, because the device
 * that matters (a TestFlight build on a real phone, cold started) has no web
 * inspector attached to read the console. See `boot-timing.ts`.
 */
export function BootTimingRows(): ReactElement {
  const timings = useSyncExternalStore(subscribeBootTimings, getBootTimings, getBootTimings)
  return (
    <>
      {timings.map((timing, index) => (
        <SettingsValueRow
          key={`${index}:${timing.label}`}
          label={timing.label}
          value={
            timing.duration === null ? `+${timing.at}ms` : `${timing.duration}ms @ +${timing.at}ms`
          }
        />
      ))}
    </>
  )
}
