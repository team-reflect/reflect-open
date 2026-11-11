import type { ReactElement } from 'react'
import { ArrowUturnLeftIcon } from '@/components/icons/arrow-uturn-left-icon.tsx'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useSimilarNotes } from '@/lib/use-similar-notes.ts'
import { routeForPath } from '@reflect/app'
import { SidebarSection } from './sidebar-section.tsx'
import { isModEvent } from '@meowdown/core'
import { useNoteLabel } from '@/hooks/use-note-label.ts'

interface SimilarNotesSectionProps {
  /** Graph-relative path of the note whose semantic neighbors to show. */
  path: string
}

/**
 * "Similar notes" as a context-sidebar section, in the old app's exact shape:
 * one truncated title per neighbor with a flipped return-arrow on the right —
 * no snippets. Rows use the same horizontal inset as the Published URL
 * section so the sidebar's note metadata reads on one line. Neighbors of
 * `path` are seeded by the note's stored chunk vectors. Renders nothing at all
 * when there are no results — semantic search may be disabled or the note not
 * yet embedded, and an empty box would just advertise a missing feature. Query
 * errors are deliberately just as quiet: a failing semantic leg means an
 * optional feature is unavailable, not that the index is broken. Shared by the
 * daily and note context sidebars.
 */
export function SimilarNotesSection({ path }: SimilarNotesSectionProps): ReactElement | null {
  const navigateNoteLink = useNoteLinkNavigation(path)
  const related = useSimilarNotes(path)
  const noteLabel = useNoteLabel()
  if (related.length === 0) {
    return null
  }

  return (
    <SidebarSection storageKey="similar" title="Similar notes">
      <ul className="space-y-1">
        {related.map((hit) => (
          <li key={hit.path}>
            <button
              type="button"
              onClick={(event) => {
                navigateNoteLink({
                  target: routeForPath(hit.path),
                  openInNewWindow: isModEvent(event),
                })
              }}
              className="flex w-full items-center space-x-1 rounded-md px-3 py-1 leading-5 text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                {noteLabel(hit)}
              </span>
              <span aria-hidden className="flex-none -scale-x-100">
                <ArrowUturnLeftIcon width={13} height={13} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </SidebarSection>
  )
}
