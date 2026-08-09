import type { ReactElement, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitMerge } from 'lucide-react'
import { conflictMarkerBlockCount, conflictMarkerLabels, getNote, readNote } from '@reflect/core'
import { CONFLICT_SIDE_DOT } from '@/components/conflict-note-view'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { useConflictResolution } from '@/hooks/use-conflict-resolution'
import { isMobileSurface } from '@/lib/platform-surface'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { cn } from '@/lib/utils'
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
 * marker lines mangling), so conflicted notes open **protected** — the file
 * is shown read-only with each block's sides color-coded
 * ({@link ConflictNoteView}), and the buttons here carry the matching color
 * dots. Resolution therefore happens here, as
 * a pure text splice over the raw file ({@link useConflictResolution}):
 * keep this device's side, the other device's, or both. Either way nothing
 * is lost — every version remains in the backup history. The flag is a
 * projection of the file content, so the banner clears itself once the
 * resolved file reindexes.
 *
 * Mobile uses the same protected session contract and raw-text resolution
 * actions. The buttons are touch-sized there, but still call the same resolver.
 */
export function SyncConflictNotice({
  path,
  className,
}: SyncConflictNoticeProps): ReactElement | null {
  const { graph } = useGraph()
  const { busy, error, resolve } = useConflictResolution(path)
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, 'note-conflict', graph?.root, path],
    queryFn: async () => (await getNote(path)) ?? null,
    enabled: bridgeReady && graph !== null,
  })
  const hasConflict = data?.hasConflict === true
  // The iCloud sweep labels marker sides with real device names (or the two
  // colliding filenames) — read them so the buttons say what they keep. The
  // Git path's generic `this device`/`other device` keeps the classic copy.
  // A multi-block note (three-plus devices, Plan 21) pluralizes: `theirs`
  // splices in every non-first side, so naming a single device would lie.
  const { data: markerInfo } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, 'note-conflict-labels', graph?.root, path],
    queryFn: async () => {
      const source = await readNote(path)
      return {
        labels: conflictMarkerLabels(source),
        blocks: conflictMarkerBlockCount(source),
      }
    },
    enabled: bridgeReady && graph !== null && hasConflict,
  })

  if (data == null || !hasConflict || graph === null) {
    return null
  }
  const labels = markerInfo?.labels ?? null
  const manySided = (markerInfo?.blocks ?? 0) > 1
  const named = labels != null && labels.ours !== 'this device'
  const mobile = isMobileSurface()
  // One row when the labels fit (short generic labels, wide panes); a button
  // whose device name doesn't fit wraps to its own full-width line. Mobile
  // buttons are touch-sized and stretch to share the row evenly.
  const actionClassName = mobile ? 'h-9 flex-1 justify-center px-3' : undefined

  return (
    <InlineAlert tone="warning" className={className}>
      <div className="flex gap-2">
        <GitMerge aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">This note was edited on two devices at once.</p>
          <p className="mt-0.5">
            Both versions are highlighted below. Choose what to keep — every version stays
            recoverable in the backup history.
          </p>
        </div>
      </div>
      <div className={cn('flex flex-wrap gap-2', mobile ? 'mt-3' : 'mt-2.5')}>
        <ResolveButton
          dot="ours"
          className={actionClassName}
          disabled={busy}
          onClick={() => void resolve('ours')}
        >
          {named ? `Keep “${labels.ours}”` : 'Keep this device’s version'}
        </ResolveButton>
        <ResolveButton
          dot="theirs"
          className={actionClassName}
          disabled={busy}
          onClick={() => void resolve('theirs')}
        >
          {manySided
            ? 'Keep the other versions'
            : named
              ? `Keep “${labels.theirs}”`
              : 'Keep the other device’s'}
        </ResolveButton>
        <ResolveButton
          dot="both"
          className={actionClassName}
          disabled={busy}
          onClick={() => void resolve('both')}
        >
          {manySided ? 'Keep all' : 'Keep both'}
        </ResolveButton>
      </div>
      {error !== null ? (
        <p className="mt-2 text-red-700 dark:text-red-300">Couldn’t resolve: {error}</p>
      ) : null}
    </InlineAlert>
  )
}

interface ResolveButtonProps {
  /** Which side's color dot the button carries — `both` shows the pair. */
  dot: 'ours' | 'theirs' | 'both'
  className?: string | undefined
  disabled: boolean
  onClick: () => void
  children: ReactNode
}

/**
 * One resolution action, color-matched to the conflict view: the dot inside
 * the button is the same tone as the version it keeps.
 */
function ResolveButton({
  dot,
  className,
  disabled,
  onClick,
  children,
}: ResolveButtonProps): ReactElement {
  return (
    <Button size="sm" variant="outline" className={className} disabled={disabled} onClick={onClick}>
      {dot === 'both' ? (
        <span aria-hidden className="flex items-center -space-x-0.5">
          <span
            className={cn('size-2 rounded-full ring-1 ring-background', CONFLICT_SIDE_DOT.ours)}
          />
          <span className={cn('size-2 rounded-full', CONFLICT_SIDE_DOT.theirs)} />
        </span>
      ) : (
        <span aria-hidden className={cn('size-2 rounded-full', CONFLICT_SIDE_DOT[dot])} />
      )}
      {children}
    </Button>
  )
}
