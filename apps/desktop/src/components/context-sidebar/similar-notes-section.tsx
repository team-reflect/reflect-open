import type { ReactElement } from 'react'
import { ArrowUturnLeftIcon } from '@/components/icons/arrow-uturn-left-icon'
import { useSimilarNotes } from '@/lib/use-similar-notes'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { SidebarSection } from './sidebar-section'

interface SimilarNotesSectionProps {
  /** Graph-relative path of the note whose semantic neighbors to show. */
  path: string
}

/**
 * "Similar notes" as a context-sidebar section, in the old app's exact shape:
 * one truncated title per neighbor with a flipped return-arrow on the right —
 * no snippets. Neighbors of `path` are seeded by the note's stored chunk
 * vectors. Renders nothing at all when there are no results — semantic search
 * may be disabled or the note not yet embedded, and an empty box would just
 * advertise a missing feature. Query errors are deliberately just as quiet:
 * a failing semantic leg means an optional feature is unavailable, not that
 * the index is broken. Shared by the daily and note context sidebars.
 */
export function SimilarNotesSection({ path }: SimilarNotesSectionProps): ReactElement | null {
  const { navigate } = useRouter()
  const related = useSimilarNotes(path)
  if (related.length === 0) {
    return null
  }

  return (
    <SidebarSection storageKey="similar" title="Similar notes">
      <ul className="space-y-2">
        {related.map((hit) => (
          <li key={hit.path}>
            <button
              type="button"
              onClick={() => navigate(routeForPath(hit.path))}
              className="flex w-full cursor-pointer items-center space-x-1 px-4 text-left text-xs"
            >
              <span className="min-w-0 flex-1 truncate">{hit.title}</span>
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
