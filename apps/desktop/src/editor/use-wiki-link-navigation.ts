import { useCallback } from 'react'
import {
  bareWikiTitle,
  errorMessage,
  indexWikiNoteReference,
  normalizeWikiTarget,
  resolveExistingWikiTarget,
  resolveOrCreateWikiTarget,
  resolveWikiTarget,
} from '@reflect/core'
import { chooseAmbiguousNote } from '@/editor/ambiguous-note-chooser-store'
import { requestNoteHeadingReveal } from '@/editor/editor-handle-registry'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { startOperation } from '@/lib/operations'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard'
import { routeForPath, type NoteRoute } from '@/routing/route'

function reportUnavailableNoteTitle(title: string): void {
  startOperation('Opening link').fail(
    `Couldn’t open “${title}” because a matching note is currently unavailable. Try again when it is available on this device.`,
  )
}

function reportInvalidNoteTarget(target: string): void {
  startOperation('Opening link').fail(
    `Couldn’t open “${target}” because it isn’t a safe Markdown note link.`,
  )
}

/** Navigate a wiki link authored by an explicitly identified source note. */
export type WikiLinkNavigationFromSource = (
  sourcePath: string,
  target: string,
  event?: MouseEvent | KeyboardEvent,
) => void

/**
 * Navigation for a clicked `[[wiki link]]`. Calendar-valid ISO dates preserve
 * ordinary resolution precedence, then open their lazy daily route on a miss.
 * Every other writable title goes through the ambiguity-preserving index +
 * disk resolver before it opens or creates, so an indexed duplicate cannot
 * bypass the same guard used for an index miss. With no graph generation
 * available, existing titles still use the read-only index resolver and
 * unresolved titles are a no-op.
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
 * @returns a stable-per-generation handler that accepts the graph-relative
 *   source path for each link activation.
 */
export function useWikiLinkNavigationFromSource(
  generation: number | null,
): WikiLinkNavigationFromSource {
  const navigateNoteLink = useNoteLinkNavigation()
  const beginLinkIntent = useLinkIntentGuard()

  return useCallback(
    (sourcePath: string, target: string, event?: MouseEvent | KeyboardEvent) => {
      const isStale = beginLinkIntent()
      const open = (route: NoteRoute, path?: string, fragment?: string | null): void => {
        const headingReveal =
          path !== undefined && fragment !== undefined && fragment !== null
            ? { path, fragment }
            : undefined
        navigateNoteLink(
          route,
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
          if (target.trim() === '') {
            return
          }
          const reference = indexWikiNoteReference(sourcePath, target)
          if (reference === null) {
            reportInvalidNoteTarget(target)
            return
          }
          const bareTitle = bareWikiTitle(target)
          const normalized = normalizeWikiTarget(bareTitle ?? target)
          if (normalized.raw === '') {
            return
          }
          if (normalized.date !== undefined) {
            if (generation === null) {
              const resolution = await resolveWikiTarget(normalized.raw)
              if (isStale()) {
                return
              }
              open(
                resolution.kind === 'resolved'
                  ? routeForPath(resolution.ref)
                  : { kind: 'daily', date: normalized.date },
                resolution.kind === 'resolved' ? resolution.ref : undefined,
                reference.fragment,
              )
              return
            }

            const resolution = await resolveExistingWikiTarget(target, generation, sourcePath)
            if (isStale()) {
              return
            }
            if (resolution.kind === 'resolved') {
              open(routeForPath(resolution.path), resolution.path, reference.fragment)
            } else if (resolution.kind === 'missing') {
              open({ kind: 'daily', date: normalized.date })
            } else if (resolution.kind === 'ambiguous') {
              const chosen = await chooseAmbiguousNote(target, resolution.paths)
              if (chosen !== null && !isStale()) {
                open(routeForPath(chosen), chosen, reference.fragment)
              }
            } else if (resolution.kind === 'unavailable') {
              reportUnavailableNoteTitle(normalized.raw)
            } else {
              reportInvalidNoteTarget(target)
            }
            return
          }
          if (generation !== null) {
            const outcome = await resolveOrCreateWikiTarget(target, sourcePath, generation)
            if (isStale()) {
              return
            }
            if (outcome.kind === 'ambiguous') {
              const chosen = await chooseAmbiguousNote(target, outcome.paths)
              if (chosen !== null && !isStale()) {
                open(routeForPath(chosen), chosen, reference.fragment)
              }
            } else if (outcome.kind === 'unavailable') {
              reportUnavailableNoteTitle(normalized.raw)
            } else if (outcome.kind === 'invalid') {
              reportInvalidNoteTarget(target)
            } else {
              open(routeForPath(outcome.path), outcome.path, reference.fragment)
            }
            return
          }

          const resolution = await resolveWikiTarget(normalized.raw)
          if (isStale()) {
            return
          }
          if (resolution.kind === 'resolved') {
            // Deliberately no focus request: on mobile, focusing mid-arrival
            // raises the keyboard through the stack animation. Desktop
            // autofocuses note arrivals on its own.
            open(routeForPath(resolution.ref), resolution.ref, reference.fragment)
          }
        } catch (err) {
          console.error('wiki-link resolution failed:', err)
          startOperation('Opening link').fail(errorMessage(err))
        }
      })()
    },
    [beginLinkIntent, generation, navigateNoteLink],
  )
}

/** Navigate wiki links authored by one mounted note. */
export function useWikiLinkNavigation(
  generation: number | null,
  sourcePath = '',
): (target: string, event?: MouseEvent | KeyboardEvent) => void {
  const navigateFromSource = useWikiLinkNavigationFromSource(generation)
  return useCallback(
    (target, event) => navigateFromSource(sourcePath, target, event),
    [navigateFromSource, sourcePath],
  )
}
