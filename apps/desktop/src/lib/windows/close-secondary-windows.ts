import { closeNoteWindows, errorMessage, isMobilePlatform, type AppPlatform } from '@reflect/core'
import { isNativeShell } from '@/lib/platform'

/**
 * Close every note window before a graph switch or delete replaces the
 * session they adopted. Must run BEFORE anything bumps the graph/index
 * generations: each child's close-requested flush lands against the
 * still-valid session, and bump-first ordering would reject their final
 * saves as stale. Best-effort — a wedged child must not block the switch
 * (it dies with the old session either way) — and a no-op on mobile and in
 * browser dev, where secondary windows don't exist.
 */
export async function closeSecondaryWindows(platform: AppPlatform): Promise<void> {
  if (isMobilePlatform(platform) || !isNativeShell()) {
    return
  }
  try {
    await closeNoteWindows()
  } catch (err) {
    console.error('closing note windows failed:', errorMessage(err))
  }
}
