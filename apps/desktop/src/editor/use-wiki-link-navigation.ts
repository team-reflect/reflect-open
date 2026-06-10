import { useCallback, useEffect, useRef } from 'react'
import { resolveWikiTarget } from '@reflect/core'
import { createNoteWithTitle } from '@/lib/create-note'
import { isIsoDate } from '@/lib/dates'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

/**
 * Navigation for a clicked `[[wiki link]]`: resolve via the index, then open
 * the target. An unresolved ISO date is still a valid daily target (created
 * lazily on first write), and an unresolved non-empty title is created and
 * opened on the spot — Plan 07's create-from-unresolved, consistent with lazy
 * dailies. With no graph generation available, unresolved titles are a no-op
 * (nothing can be written).
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
export function useWikiLinkNavigation(generation: number | null): (target: string) => void {
  const { navigate } = useRouter()

  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  return useCallback(
    (target: string) => {
      void (async () => {
        try {
          const resolution = await resolveWikiTarget(target)
          if (unmountedRef.current) {
            return
          }
          if (resolution.kind === 'resolved') {
            navigate(routeForPath(resolution.ref))
          } else if (isIsoDate(resolution.text)) {
            navigate({ kind: 'daily', date: resolution.text })
          } else if (generation !== null && resolution.text.trim() !== '') {
            const created = await createNoteWithTitle(resolution.text, generation)
            if (!unmountedRef.current) {
              navigate({ kind: 'note', path: created })
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
