import { z } from 'zod'
import { call } from '../ipc/invoke'

const backgroundTaskTokenSchema = z.string()

/** Opaque handle for one finite-length native background execution assertion. */
export type BackgroundTaskToken = z.infer<typeof backgroundTaskTokenSchema>

/**
 * Ask the native shell to keep a finite persistence pass running after iOS
 * backgrounds the app. Returns `null` when no assertion is available; callers
 * must still attempt their best-effort flush.
 */
export function beginBackgroundTask(): Promise<BackgroundTaskToken | null> {
  return call('background_task_begin', {}, backgroundTaskTokenSchema.nullable())
}

/**
 * Balance {@link beginBackgroundTask}. The shell treats expired or repeated
 * tokens as no-ops, so cleanup is safe from a `finally` block.
 */
export async function endBackgroundTask(token: BackgroundTaskToken): Promise<void> {
  await call('background_task_end', { token }, z.null())
}
