import {
  noteWindowNavigationSchema,
  type NoteWindowNavigation,
} from '../graph/schemas'
import { getBridge, type Unlisten } from '../ipc/bridge'

/**
 * Events the shell targets at one specific window (`emit_to`), as opposed to
 * the app-wide broadcasts in the indexing modules.
 */

/**
 * Delivered to an existing note window when its target is ⌘-clicked again:
 * the window may have navigated elsewhere, so the shell focuses it AND sends
 * the route/reveal intent to re-navigate it to the clicked note.
 */
export const WINDOW_NAVIGATE_EVENT = 'window:navigate'

/** Subscribe to shell-directed route/reveal requests. */
export function subscribeWindowNavigate(
  handler: (navigation: NoteWindowNavigation) => void,
): Promise<Unlisten> {
  return getBridge().listen(WINDOW_NAVIGATE_EVENT, (payload) => {
    const parsed = noteWindowNavigationSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid window:navigate payload:', parsed.error)
    }
  })
}
