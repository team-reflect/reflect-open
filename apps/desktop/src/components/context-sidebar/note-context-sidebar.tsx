import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getNote, hasBridge } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { SidebarBacklinks } from './sidebar-backlinks'
import { SidebarRelatedNotes } from './sidebar-related-notes'

interface NoteContextSidebarProps {
  /** Graph-relative path of the open (non-daily) note. */
  path: string
}

/**
 * The filename without directory or extension — the display fallback while a
 * brand-new note has no indexed title yet (the index lags the first save).
 */
function titleFromPath(path: string): string {
  const basename = path.split('/').at(-1) ?? path
  return basename.replace(/\.md$/, '')
}

/**
 * An ordinary note's contextual sidebar (modeled on the old app's note context
 * sidebar): the note's title, its inbound links, and semantic neighbors when
 * embeddings are available. The old app's remaining sections (note actions,
 * published URL, contacts, books) ride cloud features V2 doesn't have.
 * Rendered in the AppShell's right region on note routes only — daily routes
 * get {@link DailyContextSidebar} instead.
 */
export function NoteContextSidebar({ path }: NoteContextSidebarProps): ReactElement {
  const { graph } = useGraph()
  const { data: note } = useQuery({
    // getNote resolves `undefined` for an unindexed path; normalize to `null`
    // because TanStack Query reserves `undefined` for "no data yet".
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'note', path],
    queryFn: async () => (await getNote(path)) ?? null,
    enabled: hasBridge() && graph !== null,
  })

  return (
    <div className="flex flex-col px-2 py-2 text-text">
      <header className="border-b border-black/5 px-1 pb-2 dark:border-white/5">
        <h2 className="truncate text-center text-sm font-semibold">
          {note?.title ?? titleFromPath(path)}
        </h2>
      </header>

      <SidebarBacklinks path={path} emptyText="No notes link to this note yet." />
      <SidebarRelatedNotes path={path} />
    </div>
  )
}
