import { type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getNote, hasBridge } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { useConflictResolution } from '@/hooks/use-conflict-resolution'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

interface SyncConflictNoticeProps {
  /** Graph-relative path of the open note. */
  path: string
  className?: string
}

/**
 * The `Needs review` banner + resolution actions for a note whose file
 * carries sync conflict markers (a backup merge where this and another
 * device edited the same note, Plan 12).
 *
 * Conflict markers don't survive the editor's markdown round-trip (the
 * discovery spike showed `=======` re-parsing as a setext underline and both
 * marker lines mangling), so conflicted notes open **protected** — the raw
 * source is visible but not editable. Resolution therefore happens here, as
 * a pure text splice over the raw file ({@link useConflictResolution}):
 * keep this device's side, the other device's, or both. Either way nothing
 * is lost — every version remains in the backup history. The flag is a
 * projection of the file content, so the banner clears itself once the
 * resolved file reindexes.
 */
export function SyncConflictNotice({ path, className }: SyncConflictNoticeProps): ReactElement | null {
  const { graph } = useGraph()
  const { busy, error, resolve } = useConflictResolution(path)
  const { data } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, 'note-conflict', graph?.root, path],
    queryFn: async () => (await getNote(path)) ?? null,
    enabled: hasBridge() && graph !== null,
  })

  if (data == null || !data.hasConflict || graph === null) {
    return null
  }

  return (
    <InlineAlert tone="warning" className={className}>
      <p>
        This note was edited on two devices at once, and both versions are shown below between
        conflict markers. Choose what to keep — every version stays recoverable in the backup
        history either way.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void resolve('ours')}>
          Keep this device’s version
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void resolve('theirs')}>
          Keep the other device’s
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void resolve('both')}>
          Keep both
        </Button>
      </div>
      {error !== null ? <p className="mt-2">Couldn’t resolve: {error}</p> : null}
    </InlineAlert>
  )
}
