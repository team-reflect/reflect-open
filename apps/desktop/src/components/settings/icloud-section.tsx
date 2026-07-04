import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { errorMessage, hasBridge, icloudAdoptGraph, icloudStatus } from '@reflect/core'
import { SettingsField } from '@/components/settings/field'
import { SettingsSection } from '@/components/settings/section'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { isICloudRoot } from '@/lib/icloud-controller'
import { isMacosDesktop } from '@/lib/platform'
import { useGraph } from '@/providers/graph-provider'
import { useSync } from '@/providers/sync-provider'

/**
 * Settings → iCloud sync (Plan 21 Phase 1, the desktop leg): see whether the
 * graph syncs through iCloud Drive, and move a local graph into the
 * container. The move copies (count+byte verified), then disconnects the
 * Git backup remote (iCloud sync and a Git remote are mutually exclusive per
 * graph — two merge machines over the same files would fight; the iCloud
 * copy carries no `.git`, so the exclusion holds structurally), then reopens
 * the graph at its iCloud home. Ordered copy-first so a failed copy leaves
 * everything — including the backup — exactly as it was; the original folder
 * stays on disk untouched as the recovery copy either way.
 *
 * macOS only — Windows/Linux have no iCloud Drive, and mobile chooses its
 * storage in onboarding.
 */
export function IcloudSection(): ReactElement | null {
  const { graph, openRecent } = useGraph()
  const { backup, disconnectGraph } = useSync()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data: status } = useQuery({
    queryKey: ['icloud-status'],
    queryFn: icloudStatus,
    enabled: hasBridge() && isMacosDesktop,
  })

  // The navigator hides the entry off macOS through the same gate — the two
  // must agree (see use-visible-settings-sections).
  if (!isMacosDesktop || graph === null) {
    return null
  }
  const hosted = isICloudRoot(graph.root)
  const backupConnected = backup.phase === 'connected'

  async function moveToICloud(): Promise<void> {
    if (graph === null) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Copy first: if it fails, nothing changed — the backup is still
      // connected and the graph untouched.
      const newRoot = await icloudAdoptGraph(graph.generation)
      if (backupConnected) {
        try {
          await disconnectGraph()
        } catch (caught) {
          // The iCloud copy has no .git, so exclusivity holds for the new
          // graph regardless; the original folder keeping its backup is the
          // recovery copy working as intended. Tell the user, don't block.
          setError(
            `The graph moved to iCloud, but GitHub backup could not be disconnected from the original folder: ${errorMessage(caught)}`,
          )
        }
      }
      setConfirmOpen(false)
      const opened = await openRecent(newRoot)
      if (!opened) {
        // Append rather than replace: a disconnect failure above must stay
        // visible alongside this one — both tell the user something distinct.
        setError((previous) =>
          [previous, 'The copy landed in iCloud but could not be opened — open it from Saved graphs.']
            .filter(Boolean)
            .join(' '),
        )
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection id="icloud">
      <SettingsField
        legend="iCloud Drive"
        description={
          hosted
            ? 'This graph lives in iCloud Drive — edits sync to your other devices, and conflicts resolve automatically where possible.'
            : status?.available === true
              ? 'Copy this graph into iCloud Drive to sync it with your other devices.'
              : 'iCloud Drive isn’t reachable from this app — sign in to iCloud, or use a build with iCloud enabled.'
        }
      >
        {hosted ? null : (
          <div className="mt-2">
            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <DialogTrigger asChild>
                <Button size="xs" variant="outline" disabled={status?.available !== true}>
                  Move graph to iCloud…
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Move this graph to iCloud Drive?</DialogTitle>
                  <DialogDescription>
                    Your notes are copied into iCloud Drive and the graph reopens there. The
                    current folder stays on disk, untouched, as a recovery copy.
                    {backupConnected
                      ? ' GitHub backup is disconnected first — a graph syncs through iCloud or a Git remote, not both.'
                      : ''}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost" disabled={busy}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button disabled={busy} onClick={() => void moveToICloud()}>
                    {busy ? 'Moving…' : 'Move to iCloud'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
        {error !== null ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </SettingsField>
    </SettingsSection>
  )
}
