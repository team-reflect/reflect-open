import type { ToastController } from '@/lib/use-toasts.ts'
import { formatElapsed } from '@reflect/utils'

const REMINDER_TOAST_ID = 'audio-memo-reminder'

/**
 * The half-hour nudge for a running recording. Recording has no duration cap,
 * so a forgotten session would otherwise run until the disk or the battery
 * gives out; the nudge carries the stop control with it. One toast id, so a
 * later reminder replaces the earlier one instead of stacking.
 */
export function showRecordingReminder(
  toastController: ToastController,
  elapsedMs: number,
  stop: () => void,
): void {
  toastController.add({
    id: REMINDER_TOAST_ID,
    title: 'Still recording',
    description: formatElapsed(elapsedMs),
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
export function dismissRecordingReminder(toastController: ToastController): void {
  toastController.close(REMINDER_TOAST_ID)
}
