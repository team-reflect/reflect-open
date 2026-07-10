import { useCallback } from 'react'
import type { WikilinkClickHandler } from '@meowdown/core'
import { useAssetPersistence } from '@/editor/use-asset-persistence'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import type { NewWindowClickEvent } from '@/lib/windows/open-in-new-window'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'

/** The click plumbing a backlinks surface wires into its rows and snippets. */
export interface BacklinkNavigation {
  /**
   * Open an already-resolved source-note path: a daily note opens the daily
   * view (on mobile that swipes the carousel to the date — the surface stays
   * mounted), anything else opens the note. The arrival never requests focus
   * — on mobile that would raise the keyboard through the stack animation;
   * desktop autofocuses note arrivals anyway. `event` (desktop) lets ⌘-click
   * open a new window; mobile taps omit it.
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
  const { graph } = useGraph()
  const navigateNoteLink = useNoteLinkNavigation()

  const openSource = useCallback(
    (target: string, event?: NewWindowClickEvent) => {
      navigateNoteLink(routeForPath(target), event)
    },
    [navigateNoteLink],
  )

  const navigateWikiLink = useWikiLinkNavigation(graph?.generation ?? null)
  const { resolveImageUrl } = useAssetPersistence(graph?.generation ?? null)
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
