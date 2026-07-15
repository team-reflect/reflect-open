import { type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { BacklinkLoadMore } from '@/components/backlink-load-more'
import { useBacklinkNavigation } from '@/hooks/use-backlink-navigation'
import { useBacklinkSources } from '@/hooks/use-backlink-sources'
import { useBacklinksExpanded } from '@/hooks/use-backlinks-expanded'
import { IncomingBacklinkGroup } from '@/mobile/incoming-backlink-group'
import { cn } from '@/lib/utils'

interface IncomingBacklinksProps {
  /** Graph-relative path of the note whose inbound links to show. */
  path: string
  /** Extra classes for the section root (the host surface's gutter). */
  className?: string
}

/**
 * Incoming backlinks below a mobile note — the day slide and the note screen —
 * over the same data layer as desktop's `BacklinksPanel` but with touch
 * chrome: a full-width 44px header toggle and always-visible per-group
 * chevrons instead of hover-revealed ones. The header collapses the linking
 * lines while the source titles stay visible, shared live across every
 * mounted surface and persisted for the session (V1 kept it in session
 * storage too). Tapping a source that is a daily note swipes the day carousel
 * to that date — the daily surface stays mounted and follows the route —
 * while other sources open the note screen (without focusing the editor, so
 * the keyboard stays down). Source-note pages load as the shared sentinel
 * nears the viewport. Renders nothing when the note has no inbound links; a
 * failed query surfaces as an alert, because a failing query means the index
 * is broken, not that the note is unlinked.
 */
export function IncomingBacklinks({ path, className }: IncomingBacklinksProps): ReactElement | null {
  const {
    groups,
    count,
    isError,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
  } = useBacklinkSources(path)
  const [expanded, setExpanded] = useBacklinksExpanded()
  const {
    openSource,
    onWikilinkClick,
    onMarkdownLinkClick,
    resolveImageUrl,
    resolveFileLink,
    resolveWikiEmbed,
    resolveFileInfo,
    openAttachment,
    resolverRevision,
  } = useBacklinkNavigation()

  if (isError) {
    return (
      <section aria-label="Incoming backlinks" className={cn('mt-6', className)}>
        <p role="alert" className="text-sm text-text-muted">
          Couldn’t load backlinks.
        </p>
      </section>
    )
  }

  if (count === 0) {
    return null
  }

  return (
    <section aria-label="Incoming backlinks" className={cn('mt-6', className)}>
      <h3 className="text-sm font-medium text-text-muted">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex min-h-11 w-full items-center gap-2 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-90')}
          />
          <span>
            Incoming backlink{count === 1 ? '' : 's'} ({count})
          </span>
        </button>
      </h3>

      {/* pl-6 = the header's 16px chevron + 8px gap, so group titles line up
          with the header label. */}
      <div className="pl-6">
        {groups.map((group, index) => (
          <IncomingBacklinkGroup
            // Scoped to the open note: a source shared by two notes must not
            // carry its peeked or collapsed state from one note's section to
            // the other's.
            key={`${path}:${group.path}`}
            source={group}
            first={index === 0}
            expanded={expanded}
            onOpen={openSource}
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
        <BacklinkLoadMore
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isFetchNextPageError={isFetchNextPageError}
          loadMore={loadMore}
          className="py-2"
          buttonClassName="-ml-2 min-h-11"
        />
      </div>
    </section>
  )
}
