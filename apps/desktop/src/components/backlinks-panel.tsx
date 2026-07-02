import { type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { BacklinkSourceGroup } from '@/components/backlink-source-group'
import { useBacklinkNavigation } from '@/hooks/use-backlink-navigation'
import { useBacklinkSources } from '@/hooks/use-backlink-sources'
import { useBacklinksExpanded } from '@/hooks/use-backlinks-expanded'

interface BacklinksPanelProps {
  /** Graph-relative path of the note whose inbound links to show. */
  path: string
}

/**
 * Incoming backlinks at the bottom of every note — daily and ordinary — in
 * old Reflect's presentation: an "Incoming backlinks (N)" header with a
 * leading chevron, indented references grouped by source note, and hairline
 * dividers between groups. The header toggle collapses the linking lines while the
 * source titles stay visible, and the choice persists for the session
 * across all notes. Ambient and always-available — the associative recall
 * the product is built on — and cheap: one indexed query per visible note
 * ({@link useBacklinkSources}). Renders nothing when the note has no inbound
 * links, but a failed query surfaces as an alert — a failing query means the
 * index is broken, not that the note is unlinked.
 *
 * Desktop chrome (hover-revealed group chevrons, hover-sized targets); the
 * mobile surfaces render `IncomingBacklinks` over the same data layer.
 */
export function BacklinksPanel({ path }: BacklinksPanelProps): ReactElement | null {
  const { groups, count, isError } = useBacklinkSources(path)
  const [expanded, setExpanded] = useBacklinksExpanded()
  const { openSource, onWikilinkClick, resolveImageUrl } = useBacklinkNavigation()

  if (isError) {
    return (
      <section aria-label="Incoming backlinks" className="mt-8">
        <p role="alert" className="text-xs text-text-muted">
          Couldn’t load backlinks.
        </p>
      </section>
    )
  }

  if (count === 0) {
    return null
  }

  const toggleExpanded = (): void => {
    setExpanded(!expanded)
  }

  return (
    <section aria-label="Incoming backlinks" className="mt-8">
      <h3 className="text-xs font-medium text-text-muted">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex w-full items-center gap-2 text-left"
        >
          <ChevronRight
            aria-hidden
            className={`size-3 shrink-0 text-text-muted transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
          />
          <span>
            Incoming backlink{count === 1 ? '' : 's'} ({count})
          </span>
        </button>
      </h3>

      {/* pl-5 = the header's 12px chevron + 8px gap, so group titles line up
          with the header label and the group hover-chevrons (-left-5) land
          back at the section's left edge, under the header chevron. */}
      <div className="mt-5 pl-5">
        {groups.map((group, index) => (
          <BacklinkSourceGroup
            // Scoped to the open note: the pane is reused across navigation,
            // and a source shared by two notes must not carry its peeked or
            // collapsed state from one note's panel to the other's.
            key={`${path}:${group.path}`}
            source={group}
            first={index === 0}
            expanded={expanded}
            onOpen={openSource}
            onWikilinkClick={onWikilinkClick}
            resolveImageUrl={resolveImageUrl}
          />
        ))}
      </div>
    </section>
  )
}
