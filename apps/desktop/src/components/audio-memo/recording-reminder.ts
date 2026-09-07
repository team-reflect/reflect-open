import { toast } from '@/components/ui/toast'
import { formatRecordingElapsed } from '@/lib/recording-time'

const REMINDER_TOAST_ID = 'audio-memo-reminder'

/**
 * The half-hour nudge for a running recording. Recording has no duration cap,
 * so a forgotten session would otherwise run until the disk or the battery
 * gives out; the nudge carries the stop control with it. One toast id, so a
 * later reminder replaces the earlier one instead of stacking.
 */
export function showRecordingReminder(elapsedMs: number, stop: () => void): void {
  toast.add({
    id: REMINDER_TOAST_ID,
    title: 'Still recording',
    description: formatRecordingElapsed(elapsedMs),
    actionProps: {
      children: 'Stop and save',
      onClick: stop,
    },
  })
}

/**
 * Take the nudge down with the recording it is about: left up, it keeps
 * claiming a session is running, and its stop control would land on whatever
 * recording started next.
 */
export function dismissRecordingReminder(): void {
  toast.close(REMINDER_TOAST_ID)
}
