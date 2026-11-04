import type { KeyedToastSpec } from '@reflect/app'
import { formatElapsed } from '@reflect/utils'

export const RECORDING_REMINDER_TOAST_ID = 'audio-memo-reminder'

/**
 * The half-hour nudge for a running recording. Recording has no duration cap,
 * so a forgotten session would otherwise run until the disk or the battery
 * gives out; the nudge carries the stop control with it. One toast id, so a
 * later reminder replaces the earlier one instead of stacking. Close it with
 * the recording it is about: left up, its stop control would land on whatever
 * recording started next.
 */
export function getRecordingReminderToast(elapsedMs: number, stop: () => void): KeyedToastSpec {
  return {
    id: RECORDING_REMINDER_TOAST_ID,
    title: 'Still recording',
    description: formatElapsed(elapsedMs),
    action: { label: 'Stop and save', run: stop },
  }
}
