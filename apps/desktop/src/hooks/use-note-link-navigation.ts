import { useCallback } from 'react'
import { useLinkNavigationHost } from '@/hooks/use-link-navigation-host.ts'
import { useAppServices } from '@/services/services-provider.tsx'
import type { NoteRoute } from '@reflect/app'

/**
 * The modifier fields meowdown's `isModEvent` reads off a link-like control's click.
 */
export interface ModClickEvent {
  metaKey: boolean
  ctrlKey: boolean
}

/** Open one concrete note from a link-like UI control. */
export type NoteLinkNavigation = (options: { target: NoteRoute; openInNewWindow: boolean }) => void

/**
 * Apply the app-wide note-link convention: `openInNewWindow` (decided at
 * the UI boundary from a ⌘/Ctrl click or a spare-`mod` keyboard follow)
 * opens the note in a secondary window; otherwise navigate in place.
 *
 * A native open can be declined (browser/mobile) or fail. In that case the
 * click falls back to ordinary in-window navigation, unless the shared link
 * intent went stale (`useLinkIntentGuard`) or the host surface changed
 * scope while the open was in flight.
 *
 * @param scopeKey optional surface-local navigation state that should also
 *   invalidate a pending fallback (for example, the daily stream's focused
 *   date, which can change without a router navigation).
 */
export function useNoteLinkNavigation(scopeKey?: string | number | null): NoteLinkNavigation {
  const { linkNavigation } = useAppServices()
  const host = useLinkNavigationHost(scopeKey)

  return useCallback(
    (options) => {
      linkNavigation.openNoteLink(options, host)
    },
    [host, linkNavigation],
  )
}
