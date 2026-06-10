import type { ReactElement } from 'react'
import { NoteLinkRows } from '@/components/note-link-rows'
import { useBacklinks } from '@/lib/use-backlinks'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { SidebarSection } from './sidebar-section'

interface BacklinksSectionProps {
  /** Graph-relative path of the note whose inbound links to show. */
  path: string
  /** Quiet empty-state line (the host knows whether it's a day or a note). */
  emptyLabel: string
}

/**
 * "Linked from" as a context-sidebar section: every note linking to `path`,
 * with the line around the link — the same query as the in-note backlinks
 * panel, presented collapsible with a quiet empty state. Shared by the daily
 * and note context sidebars. Errors surface as an alert (unlike similar
 * notes): a failing backlinks query means the index is broken.
 */
export function BacklinksSection({ path, emptyLabel }: BacklinksSectionProps): ReactElement {
  const { navigate } = useRouter()
  const { data, isLoading, isError } = useBacklinks(path)

  const backlinks = data ?? []
  return (
    <SidebarSection storageKey="backlinks" title="Linked from" count={data?.length}>
      {isLoading ? (
        <p className="px-2 py-1 text-xs text-text-muted">Loading…</p>
      ) : isError ? (
        <p role="alert" className="px-2 py-1 text-xs text-text-muted">
          Couldn’t load backlinks.
        </p>
      ) : backlinks.length === 0 ? (
        <p className="px-2 py-1 text-xs text-text-muted">{emptyLabel}</p>
      ) : (
        <NoteLinkRows
          items={backlinks.map((backlink) => ({
            key: `${backlink.sourcePath}:${backlink.posFrom}`,
            title: backlink.sourceTitle,
            snippet: backlink.snippet,
            path: backlink.sourcePath,
          }))}
          onOpen={(target) => navigate(routeForPath(target))}
        />
      )}
    </SidebarSection>
  )
}
