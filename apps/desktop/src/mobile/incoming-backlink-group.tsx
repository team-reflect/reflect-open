import { useState, type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import type { WikilinkClickHandler } from '@meowdown/core'
import { BacklinkSnippet } from '@/components/backlink-snippet'
import type { BacklinkSource } from '@/lib/group-backlinks'
import { cn } from '@/lib/utils'

interface IncomingBacklinkGroupProps {
  source: BacklinkSource
  /** The first group renders without the leading hairline divider. */
  first: boolean
  /**
   * Section-level toggle. Each change resets the group's own state, which the
   * group chevron can then override until the next section toggle.
   */
  expanded: boolean
  /** Open the source note (the section wires this to the router). */
  onOpen: (path: string) => void
  /** Navigate a clicked `[[wiki link]]` inside a snippet to its target. */
  onWikilinkClick: WikilinkClickHandler
  /** Resolve `![…](…)` sources inside a snippet to displayable URLs. */
  resolveImageUrl: (src: string) => string | undefined
}

/**
 * One referencing note in the mobile incoming-backlinks section: an
 * accent-colored title that opens the note, the linking lines beneath as
 * selectable text, and an always-visible chevron on the row's trailing edge
 * that toggles just this group — desktop reveals it on hover, which doesn't
 * exist on touch, and both the title and the chevron are full-height (44px)
 * touch targets. The group chevron deliberately overrides the section-level
 * toggle (old Reflect's behavior): collapsing the section collapses every
 * group, after which one source can be peeked at without re-expanding the
 * rest. Groups are separated by hairline rules rather than boxed rows.
 */
export function IncomingBacklinkGroup({
  source,
  first,
  expanded: expandedOverride,
  onOpen,
  onWikilinkClick,
  resolveImageUrl,
}: IncomingBacklinkGroupProps): ReactElement {
  const [expanded, setExpanded] = useState(expandedOverride)

  // Reset to the section-level toggle whenever it changes; the group chevron
  // can then locally override again until the next section toggle. Adjusting
  // state during render (React applies it before paint, no wasted re-render)
  // is the recommended alternative to a prop-syncing effect.
  const [appliedOverride, setAppliedOverride] = useState(expandedOverride)
  if (appliedOverride !== expandedOverride) {
    setAppliedOverride(expandedOverride)
    setExpanded(expandedOverride)
  }

  return (
    <div>
      {first ? null : <div className="border-t border-border" />}

      <div className="flex items-center">
        <button
          type="button"
          onClick={() => onOpen(source.path)}
          className="flex min-h-11 min-w-0 flex-1 items-center text-left text-sm text-accent"
        >
          <span className="truncate">{source.title}</span>
        </button>

        {source.snippets.length > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} references from ${source.title}`}
            onClick={() => setExpanded(!expanded)}
            className="flex size-11 shrink-0 items-center justify-center text-text-muted"
          >
            <ChevronRight
              aria-hidden
              className={cn('size-4 transition-transform', expanded && 'rotate-90')}
            />
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="space-y-1.5 pb-3">
          {source.snippets.map((snippet) => (
            <BacklinkSnippet
              key={snippet.key}
              text={snippet.text}
              notePath={source.path}
              tasks={snippet.tasks}
              onWikilinkClick={onWikilinkClick}
              resolveImageUrl={resolveImageUrl}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
