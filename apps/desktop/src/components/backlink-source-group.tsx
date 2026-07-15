import { useState, type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { BacklinkSnippet } from '@/components/backlink-snippet'
import type { BacklinkNavigation } from '@/hooks/use-backlink-navigation'
import type { BacklinkSource } from '@/lib/group-backlinks'
import type { NewWindowClickEvent } from '@/lib/windows/open-in-new-window'

interface BacklinkSourceGroupProps {
  source: BacklinkSource
  /** The first group renders without the leading hairline divider. */
  first: boolean
  /**
   * Panel-level toggle. Each change resets the group's own state, which the
   * group chevron can then override until the next panel toggle.
   */
  expanded: boolean
  /**
   * Open the source note (the panel wires this to the router). The click
   * event rides along so ⌘-click can open a new window.
   */
  onOpen: (path: string, event?: NewWindowClickEvent) => void
  /** Navigate a clicked `[[wiki link]]` inside a snippet to its target. */
  onWikilinkClick: BacklinkNavigation['onWikilinkClick']
  /** Navigate a standard Markdown note link inside a snippet. */
  onMarkdownLinkClick: BacklinkNavigation['onMarkdownLinkClick']
  /** Resolve `![…](…)` sources inside a snippet to displayable URLs. */
  resolveImageUrl: (sourcePath: string, src: string) => string | undefined
  resolveFileLink: BacklinkNavigation['resolveFileLink']
  resolveWikiEmbed: BacklinkNavigation['resolveWikiEmbed']
  resolveFileInfo: BacklinkNavigation['resolveFileInfo']
  openAttachment: BacklinkNavigation['openAttachment']
  resolverRevision: number
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
  onWikilinkClick,
  onMarkdownLinkClick,
  resolveImageUrl,
  resolveFileLink,
  resolveWikiEmbed,
  resolveFileInfo,
  openAttachment,
  resolverRevision,
}: BacklinkSourceGroupProps): ReactElement {
  const [expanded, setExpanded] = useState(expandedOverride)

  // Reset to the panel-level toggle whenever it changes; the group chevron can
  // then locally override again until the next panel toggle. Adjusting state
  // during render (React applies it before paint, no wasted re-render) is the
  // recommended alternative to a prop-syncing effect.
  const [appliedOverride, setAppliedOverride] = useState(expandedOverride)
  if (appliedOverride !== expandedOverride) {
    setAppliedOverride(expandedOverride)
    setExpanded(expandedOverride)
  }

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
          onClick={(event) => onOpen(source.path, event)}
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
            <BacklinkSnippet
              key={snippet.key}
              text={snippet.text}
              notePath={source.path}
              tasks={snippet.tasks}
              onWikilinkClick={onWikilinkClick}
              onMarkdownLinkClick={onMarkdownLinkClick}
              resolveImageUrl={resolveImageUrl}
              resolveFileLink={resolveFileLink}
              resolveWikiEmbed={resolveWikiEmbed}
              resolveFileInfo={resolveFileInfo}
              openAttachment={openAttachment}
              resolverRevision={resolverRevision}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
