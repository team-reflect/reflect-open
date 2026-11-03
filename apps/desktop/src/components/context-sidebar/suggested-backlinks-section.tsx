import type { ReactElement } from 'react'
import { Check } from 'lucide-react'
import { isModEvent } from '@meowdown/core'
import { routeForPath } from '@reflect/app'
import { ArrowUturnLeftIcon } from '@/components/icons/arrow-uturn-left-icon.tsx'
import { useNoteLabel } from '@/hooks/use-note-label.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useSuggestedBacklinks } from '@/hooks/use-suggested-backlinks.ts'
import { SidebarSection } from './sidebar-section.tsx'

interface SuggestedBacklinksSectionProps {
  /**
   * Graph-relative path of the note whose unlinked mentions to suggest.
   */
  path: string
}

/**
 * "Suggested backlinks" as a context-sidebar section, in the old app's shape:
 * one entry per line of another note that names this note without linking
 * to it — a return arrow and the source's title (which opens it), the line
 * beneath as plain text, and a check that rewrites the mention as a
 * `[[wiki link]]`, after which the source shows among the incoming
 * backlinks. Renders nothing when there are no suggestions; a failed lookup
 * says so. Mounted in the note context
 * sidebar only: daily notes are never suggested as link targets.
 */
export function SuggestedBacklinksSection({
  path,
}: SuggestedBacklinksSectionProps): ReactElement | null {
  const navigateNoteLink = useNoteLinkNavigation(path)
  const noteLabel = useNoteLabel()
  const { mentions, isError, link, isLinking } = useSuggestedBacklinks(path)

  if (isError) {
    return (
      <SidebarSection storageKey="suggested-backlinks" title="Suggested backlinks">
        <p role="alert" className="px-3 text-xs text-text-muted">
          Couldn’t load suggested backlinks.
        </p>
      </SidebarSection>
    )
  }

  if (mentions.length === 0) {
    return null
  }

  return (
    <SidebarSection storageKey="suggested-backlinks" title="Suggested backlinks">
      <ul className="space-y-2">
        {mentions.map((entry) => {
          const label = noteLabel({ path: entry.sourcePath, title: entry.sourceTitle })
          return (
            <li key={`${entry.sourcePath}:${entry.mention.from}`} className="px-3">
              <div className="flex items-center gap-1.5 text-text-secondary">
                <button
                  type="button"
                  onClick={(event) => {
                    navigateNoteLink({
                      target: routeForPath(entry.sourcePath),
                      openInNewWindow: isModEvent(event),
                    })
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-text"
                >
                  <span aria-hidden className="flex-none">
                    <ArrowUturnLeftIcon width={13} height={13} />
                  </span>
                  <span className="truncate text-xs font-medium">{label}</span>
                </button>
                <button
                  type="button"
                  disabled={isLinking}
                  aria-label={`Link “${entry.mention.text}” in ${label}`}
                  onClick={() => link(entry.sourcePath, entry.mention)}
                  className="flex-none rounded p-0.5 text-text-muted hover:bg-surface-hover hover:text-text disabled:opacity-50"
                >
                  <Check aria-hidden className="size-3.5" />
                </button>
              </div>
              <p className="mt-0.5 text-xs leading-5 break-words text-text">{entry.line}</p>
            </li>
          )
        })}
      </ul>
    </SidebarSection>
  )
}
