import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isICloudRoot } from '@reflect/core'
import { SettingsField } from '@/components/settings/field.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.tsx'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useGitSync } from '@/providers/sync-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

const PENDING_NOTES_REFETCH_MS = 5_000

function pendingNotesLine(count: number): string {
  return count === 1
    ? '1 note is still downloading from iCloud.'
    : `${count} notes are still downloading from iCloud.`
}

/**
 * Settings → Sync → iCloud Drive (Plan 21 Phase 1, the desktop leg): see
 * whether the graph syncs through iCloud Drive, and move a local graph into the
 * container. The move copies (count+byte verified), then disconnects the old
 * folder's Git backup remote before reopening the graph at its iCloud home.
 * Ordered copy-first so a failed copy leaves everything — including the backup
 * — exactly as it was; the original folder stays on disk untouched as the
 * recovery copy either way.
 *
 * macOS only — Windows/Linux have no iCloud Drive, and mobile chooses its
 * storage in onboarding.
 */
export function IcloudSettingsField(): ReactElement | null {
  const { graph, openRecent } = useGraph()
  const { state, disconnectGraph } = useGitSync()
  const { icloudMigration: migration, icloudNative, platform } = useCoreServices()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const move = useAsyncAction()
  // The move's own failure text: a return value, set mid-action by `onCopied`.
  const [error, setError] = useState<string | null>(null)
  const hosted = graph !== null && isICloudRoot(graph.root)
  const { data: status } = useQuery({
    queryKey: queryKeys.icloud.status,
    queryFn: () => icloudNative.status(),
    enabled: platform.isMacosDesktop,
  })
  const pendingNotes = useQuery({
    queryKey: queryKeys.icloud.pendingNotes(graph?.root),
    queryFn: () => {
      return graph === null ? Promise.resolve(0) : icloudNative.pendingCount(graph.root, 'notes')
    },
    enabled: platform.isMacosDesktop && hosted,
    staleTime: PENDING_NOTES_REFETCH_MS,
    refetchInterval: (query) => {
      const count = query.state.data
      return typeof count === 'number' && count > 0 ? PENDING_NOTES_REFETCH_MS : false
    },
  })

  // The navigator hides the entry off macOS through the same gate — the two
  // must agree (see use-visible-settings-sections).
  if (!platform.isMacosDesktop || graph === null) {
    return null
  }
  const gitSyncConnected = state.phase === 'connected'

  async function moveToICloud(): Promise<void> {
    setError(null)
    // Never rejects: the result is the user-facing failure text.
    const failure = await migration.moveGraph({
      disconnectGitSync: gitSyncConnected ? disconnectGraph : null,
      openGraph: openRecent,
      onCopied: (failureSoFar) => {
        setError(failureSoFar)
        setConfirmOpen(false)
      },
    })
    setError(failure)
  }

  const shownError = error ?? move.error

  return (
    <>
      <SettingsField
        legend="iCloud Drive"
        description={
          hosted
            ? 'This graph lives in iCloud Drive. Edits sync to your other devices, and the app merges concurrent edits where possible.'
            : status?.available === true
              ? 'Copy this graph into iCloud Drive to sync it with your other devices.'
              : 'iCloud Drive isn’t reachable from this app — sign in to iCloud, or use a build with iCloud enabled.'
        }
      >
        {hosted && pendingNotes.data !== undefined && pendingNotes.data > 0 ? (
          <p className="mt-3 text-xs text-text-muted">{pendingNotesLine(pendingNotes.data)}</p>
        ) : null}
        {hosted ? null : (
          <div className="mt-2">
            <Dialog
              open={confirmOpen}
              onOpenChange={(open) => !move.pending && setConfirmOpen(open)}
            >
              <DialogTrigger
                render={
                  <Button size="xs" variant="outline" disabled={status?.available !== true}>
                    Move graph to iCloud…
                  </Button>
                }
              />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Move this graph to iCloud Drive?</DialogTitle>
                  <DialogDescription>
                    Your notes are copied into iCloud Drive and the graph reopens there. The current
                    folder stays on disk, untouched, as a recovery copy.
                    {gitSyncConnected
                      ? ' GitHub sync is disconnected from the recovery copy; you can reconnect GitHub sync after the iCloud graph opens.'
                      : ''}
                  </DialogDescription>
                </DialogHeader>
                {/* A failure before the copy lands keeps the dialog open; show it here too. */}
                {shownError !== null ? <InlineAlert tone="error">{shownError}</InlineAlert> : null}
                <DialogFooter>
                  <DialogClose
                    render={
                      <Button variant="ghost" disabled={move.pending}>
                        Cancel
                      </Button>
                    }
                  />
                  <Button disabled={move.pending} onClick={() => void move.run(moveToICloud)}>
                    {move.pending ? 'Moving…' : 'Move to iCloud'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
        {shownError !== null ? <p className="mt-2 text-xs text-destructive">{shownError}</p> : null}
      </SettingsField>
    </>
  )
}
