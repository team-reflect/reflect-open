import { useCallback } from 'react'
import { resolveOrCreateNoteWithTitle, resolveWikiTarget } from '@reflect/core'
import { reportAmbiguousNoteTitle } from '@/editor/ambiguous-note-feedback'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { isIsoDate } from '@/lib/dates'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard'
import { routeForPath, type NoteRoute } from '@/routing/route'

/**
 * Navigation for a clicked `[[wiki link]]`: resolve via the index, then open
 * the target. An unresolved ISO date is still a valid daily target (created
 * lazily on first write). An unresolved non-empty title is rechecked against
 * the index and its on-disk slug family before it can be created and opened —
 * Plan 07's create-from-unresolved with a guard for a lagging device index and
 * title/path mismatch. With no graph generation available, unresolved titles
 * are a no-op (nothing can be written).
 *
 * A ⌘-click (the originating `event`, when the caller passes it) opens the
 * resolved target in a secondary note window instead — falling back to
 * in-window navigation whenever the surface can't (browser dev, mobile), so
 * the modifier never makes a link do nothing. Keyboard follows (Mod-Enter)
 * deliberately stay in-window: their modifier is held by definition.
 *
 * Resolution is async, and the host pane can unmount or the user can act
 * again while it's in flight — a late navigate would yank the user somewhere
 * they've already left, so every navigation is gated on the shared link
 * intent ({@link useLinkIntentGuard}).
 *
 * @param generation the open graph's write generation (`GraphInfo.generation`),
 *   or `null` when no graph is writable.
 * @returns a stable-per-`generation` click handler for the editor's wiki-link
 *   extension.
 */
export function useWikiLinkNavigation(
  generation: number | null,
): (target: string, event?: MouseEvent | KeyboardEvent) => void {
  const navigateNoteLink = useNoteLinkNavigation()
  const beginLinkIntent = useLinkIntentGuard()

  return useCallback(
    (target: string, event?: MouseEvent | KeyboardEvent) => {
      const isStale = beginLinkIntent()
      const open = (route: NoteRoute): void => {
        navigateNoteLink(route, event)
      }
      void (async () => {
        try {
          const resolution = await resolveWikiTarget(target)
          if (isStale()) {
            return
          }
          if (resolution.kind === 'resolved') {
            const route = routeForPath(resolution.ref)
            // Deliberately no focus request: on mobile, focusing mid-arrival
            // raises the keyboard through the stack animation. Desktop
            // autofocuses note arrivals on its own.
            open(route)
          } else if (isIsoDate(resolution.text)) {
            open({ kind: 'daily', date: resolution.text })
          } else if (generation !== null && resolution.text.trim() !== '') {
            const outcome = await resolveOrCreateNoteWithTitle(resolution.text, generation)
            if (isStale()) {
              return
            }
            if (outcome.kind === 'ambiguous') {
              reportAmbiguousNoteTitle('Opening link', resolution.text)
            } else {
              open({ kind: 'note', path: outcome.path })
            }
          }
        } catch (err) {
          console.error('wiki-link resolution failed:', err)
        }
      })()
    },
    [beginLinkIntent, generation, navigateNoteLink],
  )
}
