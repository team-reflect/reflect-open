import { useEffect, useState, type ReactElement } from 'react'
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
  runFilenameMigration,
  type MigrationCandidate,
} from '@/lib/filename-migration'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

/**
 * The one-time readable-filenames offer (Plan 17c). Mounted once per
 * workspace; renders nothing until the open-time reconcile finishes and
 * ULID-named notes exist. Accepting hands the candidates to
 * {@link runFilenameMigration} (checkpoint, rename, report — all through the
 * operations status). Declining is sticky per graph — recorded in settings,
 * never re-asked — while new notes get slug filenames regardless.
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
    void runFilenameMigration({ candidates, generation })
  }

  return (
    // Esc / outside-click is a **defer**, deliberately distinct from the
    // decline button: nothing is recorded and the next graph open re-offers.
    // A reflexive Esc at startup must not be a permanent answer; only the
    // explicit "Keep current names" choice is sticky.
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
