import { useCallback } from 'react'
import {
  errorMessage,
  indexMarkdownNoteReference,
  resolveExistingMarkdownTarget,
} from '@reflect/core'
import { chooseAmbiguousNote } from '@/editor/ambiguous-note-chooser-store'
import { requestNoteHeadingReveal } from '@/editor/editor-handle-registry'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { startOperation } from '@/lib/operations'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard'
import { routeForPath } from '@/routing/route'

/** A standard Markdown link handler that synchronously reports whether it claimed the href. */
export type MarkdownNoteLinkNavigation = (
  href: string,
  event?: MouseEvent | KeyboardEvent,
) => boolean

/** Resolve a standard Markdown note link for an explicitly identified source note. */
export type MarkdownNoteLinkNavigationFromSource = (
  sourcePath: string,
  href: string,
  event?: MouseEvent | KeyboardEvent,
) => boolean

function reportMissingMarkdownNote(href: string): void {
  startOperation('Opening link').fail(`Couldn’t find a Markdown note matching “${href}”.`)
}

function reportUnavailableMarkdownNote(href: string): void {
  startOperation('Opening link').fail(
    `Couldn’t open “${href}” because a matching note is currently unavailable. Try again when it is available on this device.`,
  )
}

/**
 * Resolve local standard-Markdown note hrefs from `sourcePath`. Invalid and
 * non-note hrefs are left unclaimed so the editor can continue through its
 * attachment, deep-link, and external-URL handlers.
 */
export function useMarkdownLinkNavigationFromSource(
  generation: number | null,
): MarkdownNoteLinkNavigationFromSource {
  const navigateNoteLink = useNoteLinkNavigation()
  const beginLinkIntent = useLinkIntentGuard()

  return useCallback(
    (sourcePath, href, event) => {
      if (generation === null) {
        return false
      }
      const reference = indexMarkdownNoteReference(sourcePath, href)
      if (reference === null) {
        return false
      }

      const isStale = beginLinkIntent()
      const fragment = reference.fragment
      const open = (path: string): void => {
        const headingReveal = fragment === null ? undefined : { path, fragment }
        navigateNoteLink(
          routeForPath(path),
          event,
          headingReveal === undefined
            ? undefined
            : {
                headingReveal,
                beforeInWindowNavigate: () =>
                  requestNoteHeadingReveal(
                    headingReveal.path,
                    headingReveal.fragment,
                    generation,
                  ),
              },
        )
      }

      void (async () => {
        try {
          const resolution = await resolveExistingMarkdownTarget(href, sourcePath, generation)
          if (isStale()) {
            return
          }
          if (resolution.kind === 'resolved') {
            open(resolution.path)
            return
          }
          if (resolution.kind === 'ambiguous') {
            const chosen = await chooseAmbiguousNote(href, resolution.paths)
            if (chosen !== null && !isStale()) {
              open(chosen)
            }
            return
          }
          if (resolution.kind === 'unavailable') {
            reportUnavailableMarkdownNote(href)
            return
          }
          reportMissingMarkdownNote(href)
        } catch (cause) {
          if (isStale()) {
            return
          }
          console.error('Markdown-link resolution failed:', cause)
          startOperation('Opening link').fail(errorMessage(cause))
        }
      })()
      return true
    },
    [beginLinkIntent, generation, navigateNoteLink],
  )
}

/** Resolve local standard-Markdown note hrefs from one mounted note. */
export function useMarkdownLinkNavigation(
  generation: number | null,
  sourcePath: string,
): MarkdownNoteLinkNavigation {
  const navigateFromSource = useMarkdownLinkNavigationFromSource(generation)
  return useCallback(
    (href, event) => navigateFromSource(sourcePath, href, event),
    [navigateFromSource, sourcePath],
  )
}
