import { useCallback, useEffect, useRef } from 'react'
import { resolveOrCreateNoteWithTitle, resolveWikiTarget } from '@reflect/core'
import { reportAmbiguousNoteTitle } from '@/editor/ambiguous-note-feedback'
import { isIsoDate } from '@/lib/dates'
import { isNewWindowClick, openRouteInNewWindow } from '@/lib/windows/open-in-new-window'
import { routeForPath, type Route } from '@/routing/route'
import { useRouter } from '@/routing/router'

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
  const { navigate } = useRouter()

  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  return useCallback(
    (target: string, event?: MouseEvent | KeyboardEvent) => {
      const newWindow = isNewWindowClick(event)
      const open = async (route: Route): Promise<void> => {
        if (newWindow) {
          if (await openRouteInNewWindow(route)) {
            return
          }
          // The await above opened an unmount window; a late fallback must
          // not yank a pane the user already left.
          if (unmountedRef.current) {
            return
          }
        }
        navigate(route)
      }
      void (async () => {
        try {
          const resolution = await resolveWikiTarget(target)
          if (unmountedRef.current) {
            return
          }
          if (resolution.kind === 'resolved') {
            const route = routeForPath(resolution.ref)
            // Deliberately no focus request: on mobile, focusing mid-arrival
            // raises the keyboard through the stack animation. Desktop
            // autofocuses note arrivals on its own.
            await open(route)
          } else if (isIsoDate(resolution.text)) {
            await open({ kind: 'daily', date: resolution.text })
          } else if (generation !== null && resolution.text.trim() !== '') {
            const outcome = await resolveOrCreateNoteWithTitle(resolution.text, generation)
            if (unmountedRef.current) {
              return
            }
            if (outcome.kind === 'ambiguous') {
              reportAmbiguousNoteTitle('Opening link', resolution.text)
            } else {
              await open({ kind: 'note', path: outcome.path })
            }
          }
        } catch (err) {
          console.error('wiki-link resolution failed:', err)
        }
      })()
    },
    [navigate, generation],
  )
}
