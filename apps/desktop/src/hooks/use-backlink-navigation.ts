import { useCallback, useEffect, useRef } from 'react'
import type { WikilinkClickHandler } from '@meowdown/core'
import { useAssetPersistence } from '@/editor/use-asset-persistence'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import {
  isNewWindowClick,
  openRouteInNewWindow,
  type NewWindowClickEvent,
} from '@/lib/windows/open-in-new-window'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

/** The click plumbing a backlinks surface wires into its rows and snippets. */
export interface BacklinkNavigation {
  /**
   * Open an already-resolved source-note path: a daily note opens the daily
   * view (on mobile that swipes the carousel to the date — the surface stays
   * mounted), anything else opens the note. A backlink tap restores focus on
   * the destination (the mobile focus contract); desktop autofocuses note
   * arrivals anyway. `event` (desktop) lets ⌘-click open a new window;
   * mobile taps omit it.
   */
  openSource: (path: string, event?: NewWindowClickEvent) => void
  /**
   * Navigate a `[[wiki link]]` clicked *inside* a snippet — resolves its
   * target the same way the editor does, distinct from {@link openSource}.
   * Stable, so it never rebuilds the snippet trees.
   */
  onWikilinkClick: WikilinkClickHandler
  /** Resolve `![…](…)` sources inside a snippet to displayable URLs. Stable. */
  resolveImageUrl: (src: string) => string | undefined
}

/**
 * Navigation for an incoming-backlinks surface, shared by the desktop panel
 * and the mobile section. Wiki links and images inside snippets resolve
 * through the same pipelines as the editor.
 */
export function useBacklinkNavigation(): BacklinkNavigation {
  const { navigate } = useRouter()
  const { graph } = useGraph()

  // The new-window fallback below resolves async — a late in-window
  // navigation must not yank a surface the user already left (the same
  // lifetime guard as useWikiLinkNavigation's).
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  const openSource = useCallback(
    (target: string, event?: NewWindowClickEvent) => {
      const route = routeForPath(target)
      const arrive = (): void => navigate(route, { focusEditor: route.kind === 'note' })
      if (isNewWindowClick(event)) {
        // Degrade a declined/failed open to in-window navigation so the
        // modifier can never make the click do nothing.
        void openRouteInNewWindow(route).then((opened) => {
          if (!opened && !unmountedRef.current) {
            arrive()
          }
        })
        return
      }
      arrive()
    },
    [navigate],
  )

  const navigateWikiLink = useWikiLinkNavigation(graph?.generation ?? null)
  const { resolveImageUrl } = useAssetPersistence(graph?.root ?? null, graph?.generation ?? null)
  const onWikilinkClick = useCallback<WikilinkClickHandler>(
    ({ target, event }) => navigateWikiLink(target, event),
    [navigateWikiLink],
  )
  const resolveImageUrlStable = useCallback(
    (src: string) => resolveImageUrl(src) ?? undefined,
    [resolveImageUrl],
  )

  return { openSource, onWikilinkClick, resolveImageUrl: resolveImageUrlStable }
}
