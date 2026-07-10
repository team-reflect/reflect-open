import { useCallback, useEffect, useRef } from 'react'
import { createNoteWithTitle, dailyPath, resolveWikiTarget } from '@reflect/core'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { isIsoDate } from '@/lib/dates'
import {
  beginLinkNavigationIntent,
  isCurrentLinkNavigationIntent,
} from '@/lib/windows/link-navigation-intent'
import { routeForPath, type NoteRoute } from '@/routing/route'
import { useNavigationRevision } from '@/routing/router'

/**
 * Navigation for a clicked `[[wiki link]]`: resolve via the index, then open
 * the target. An unresolved ISO date is still a valid daily target (created
 * lazily on first write), and an unresolved non-empty title is created and
 * opened on the spot — Plan 07's create-from-unresolved, consistent with lazy
 * dailies. With no graph generation available, unresolved titles are a no-op
 * (nothing can be written).
 *
 * A ⌘-click (the originating `event`, when the caller passes it) opens the
 * resolved target in a secondary note window instead — falling back to
 * in-window navigation whenever the surface can't (browser dev, mobile), so
 * the modifier never makes a link do nothing. Keyboard follows (Mod-Enter)
 * deliberately stay in-window: their modifier is held by definition.
 *
 * Resolution is async, and the host pane can unmount while it's in flight
 * (route change, graph switch) — a late navigate would yank the user somewhere
 * they've already left, so the hook guards every navigation on its own
 * lifetime.
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
  const navigationRevision = useNavigationRevision()

  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  return useCallback(
    (target: string, event?: MouseEvent | KeyboardEvent) => {
      const intent = beginLinkNavigationIntent()
      const startedAtRevision = navigationRevision?.() ?? null
      const isStale = (): boolean =>
        unmountedRef.current ||
        !isCurrentLinkNavigationIntent(intent) ||
        (navigationRevision !== null && navigationRevision() !== startedAtRevision)
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
            open(routeForPath(dailyPath(resolution.text)))
          } else if (generation !== null && resolution.text.trim() !== '') {
            const created = await createNoteWithTitle(resolution.text, generation)
            if (!isStale()) {
              open({ kind: 'note', path: created })
            }
          }
        } catch (err) {
          console.error('wiki-link resolution failed:', err)
        }
      })()
    },
    [generation, navigateNoteLink, navigationRevision],
  )
}
