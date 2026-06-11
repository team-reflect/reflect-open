import { useEffect, useState, type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import type { BacklinkSource } from '@/lib/group-backlinks'

interface BacklinkSourceGroupProps {
  source: BacklinkSource
  /** The first group renders without the leading hairline divider. */
  first: boolean
  /**
   * Panel-level toggle. Each change resets the group's own state, which the
   * group chevron can then override until the next panel toggle.
   */
  expanded: boolean
  /** Open the source note (the panel wires this to the router). */
  onOpen: (path: string) => void
}

/**
 * One referencing note in the incoming-backlinks section, in old Reflect's
 * presentation: an accent-colored title that opens the note, the linking
 * lines beneath as selectable text, and a chevron in the indent to its
 * left — revealed on hover — that toggles just this group. The group chevron
 * deliberately overrides the panel-level toggle (old Reflect's behavior):
 * collapsing the panel collapses every group, after which one source can be
 * peeked at without re-expanding the rest. Groups are separated by hairline
 * rules rather than boxed rows.
 */
export function BacklinkSourceGroup({
  source,
  first,
  expanded: expandedOverride,
  onOpen,
}: BacklinkSourceGroupProps): ReactElement {
  const [expanded, setExpanded] = useState(expandedOverride)

  useEffect(() => {
    setExpanded(expandedOverride)
  }, [expandedOverride])

  return (
    <div className="group relative">
      {first ? null : (
        <div className="py-4">
          <div className="border-t border-border" />
        </div>
      )}

      <div className="relative flex items-center">
        <button
          type="button"
          onClick={() => onOpen(source.path)}
          className="min-w-0 cursor-pointer truncate text-left text-xs text-accent"
        >
          {source.title}
        </button>

        {source.snippets.length > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} references from ${source.title}`}
            onClick={() => setExpanded(!expanded)}
            className="absolute inset-y-0 -left-5 flex items-center text-text-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <ChevronRight
              aria-hidden
              className={`size-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-1 space-y-1">
          {source.snippets.map((snippet) => (
            <p key={snippet.key} className="select-text text-xs text-text">
              {snippet.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
