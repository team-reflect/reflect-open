import type { ReactElement } from 'react'
import { NoteLinkList } from '@/components/note-link-list'
import { useBacklinks } from '@/lib/use-backlinks'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

/**
 * Incoming backlinks under a note (Plan 07): source title + the line around
 * the link, click to open. Ambient and always-available — the associative
 * recall the product is built on — and cheap: one indexed query per visible
 * note, kept fresh by the index invalidation hook (no polling). Renders
 * nothing when the note has no inbound links.
 */
interface BacklinksPanelProps {
  /** Graph-relative path of the note whose inbound links to show. */
  path: string
}

export function BacklinksPanel({ path }: BacklinksPanelProps): ReactElement | null {
  const { navigate } = useRouter()
  const { data } = useBacklinks(path)

  if (!data || data.length === 0) {
    return null
  }

  return (
    <NoteLinkList
      ariaLabel="Backlinks"
      heading="Linked from"
      items={data.map((backlink) => ({
        key: `${backlink.sourcePath}:${backlink.posFrom}`,
        title: backlink.sourceTitle,
        snippet: backlink.snippet,
        path: backlink.sourcePath,
      }))}
      onOpen={(target) => navigate(routeForPath(target))}
    />
  )
}
