import { useEffect, useState, type ReactElement } from 'react'
import { gitCommitAll, gitStatus } from '@reflect/core'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  findMigrationCandidates,
  migrateUlidNotes,
  type MigrationCandidate,
} from '@/lib/filename-migration'
import { startOperation } from '@/lib/operations'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

/**
 * The one-time readable-filenames offer (Plan 17c). Mounted once per
 * workspace; renders nothing until the open-time reconcile finishes and
 * ULID-named notes exist. Accepting checkpoints (a git commit, when the
 * graph has a repo) and renames every titled ULID note onto its slug path,
 * reporting through the operations status. Declining is sticky per graph —
 * recorded in settings, never re-asked — while new notes get slug filenames
 * regardless.
 */
export function FilenameMigrationPrompt(): ReactElement | null {
  const { graph, indexing } = useGraph()
  const { settings, updateSettingsWith } = useSettings()
  const [candidates, setCandidates] = useState<MigrationCandidate[] | null>(null)
  const [dismissed, setDismissed] = useState(false)

  const root = graph?.root ?? null
  const generation = graph?.generation ?? null
  const declined = root !== null && settings.filenameMigrationDeclined.includes(root)

  useEffect(() => {
    if (root === null || indexing || declined) {
      return
    }
    let active = true
    void findMigrationCandidates().then(
      (found) => {
        if (active) {
          setCandidates(found)
        }
      },
      (cause) => {
        // No candidates list, no prompt — the next graph open retries.
        console.error('readable-filenames scan failed:', cause)
      },
    )
    return () => {
      active = false
    }
  }, [root, indexing, declined])

  if (
    root === null ||
    generation === null ||
    declined ||
    dismissed ||
    candidates === null ||
    candidates.length === 0
  ) {
    return null
  }

  const count = candidates.length

  const decline = (): void => {
    setDismissed(true)
    updateSettingsWith((current) => ({
      filenameMigrationDeclined: [...current.filenameMigrationDeclined, root],
    }))
  }

  const accept = (): void => {
    setDismissed(true)
    void (async () => {
      const operation = startOperation(
        `Renaming ${count} ${count === 1 ? 'note' : 'notes'} to readable filenames`,
      )
      try {
        // Checkpoint first (Plan 12): with a repo, the whole rename pass is
        // one commit away from undoable. A graph without git has no
        // checkpoint to take — the user's standing choice, proceed.
        const status = await gitStatus(generation)
        if (status.initialized) {
          await gitCommitAll('Checkpoint before readable filenames', generation)
        }
      } catch (cause) {
        // A repo exists but can't commit: running without the safety net is
        // not our call to make. Keep the prompt dismissible-only this session.
        console.error('readable-filenames checkpoint failed:', cause)
        operation.fail('the pre-rename checkpoint commit failed; nothing was renamed')
        return
      }
      const result = await migrateUlidNotes({
        candidates,
        generation,
        onProgress: operation.progress,
      })
      if (result.failed.length > 0) {
        console.error('readable-filenames migration failures:', result.failed)
        const skippedToo =
          result.skipped > 0
            ? `; ${result.skipped} ${result.skipped === 1 ? 'was' : 'were'} skipped (opened or edited mid-run)`
            : ''
        operation.fail(
          `renamed ${result.moved} of ${count} — ${result.failed.length} failed and keep their old filenames${skippedToo}; reopening the graph offers the rest again`,
        )
      } else {
        // Pure skips need no alarm: the scan excludes open/conflicted notes
        // up front, so a skip here is a mid-run race, and the next graph
        // open simply offers the remainder.
        operation.done()
      }
    })()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && setDismissed(true)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use readable filenames?</DialogTitle>
          <DialogDescription>
            {count === 1 ? 'One note in this graph has' : `${count} notes in this graph have`}{' '}
            randomly-named files from an earlier version of Reflect. Reflect can rename{' '}
            {count === 1 ? 'it' : 'them'} after {count === 1 ? 'its title' : 'their titles'} —
            links keep working, and a backup checkpoint is created first.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={decline}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
          >
            Keep current names
          </button>
          <button
            type="button"
            autoFocus
            onClick={accept}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover"
          >
            Rename {count === 1 ? '1 note' : `${count} notes`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
