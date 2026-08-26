import { toast } from '@/components/ui/toast'
import { formatRecordingElapsed } from '@/lib/recording-time'

/**
 * The half-hour nudge for a running recording. Recording has no duration cap,
 * so a forgotten session would otherwise run until the disk or the battery
 * gives out; the nudge carries the stop control with it. One toast id, so a
 * later reminder replaces the earlier one instead of stacking.
 */
export function showRecordingReminder(elapsedMs: number, stop: () => void): void {
  toast.add({
    id: 'audio-memo-reminder',
    title: 'Still recording',
    description: formatRecordingElapsed(elapsedMs),
    actionProps: {
      children: 'Stop and save',
      onClick: stop,
    },
  })
}
