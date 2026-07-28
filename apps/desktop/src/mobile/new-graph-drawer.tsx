import { useId, useState, type ReactElement } from 'react'
import { errorMessage } from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cleanGraphName, graphRootForName, isGraphNameTaken } from '@/lib/graph-names'

interface NewGraphDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The iCloud container's `Documents/` root the new graph goes into. */
  documentsRoot: string
  /** Existing container graph roots, for the name-collision check. */
  existingRoots: readonly string[]
  /**
   * Create (and switch to) the graph at this root. A confirmed switch
   * remounts the workspace, which unmounts the sheet; a rejection keeps the
   * sheet open with the error shown.
   */
  onCreate: (root: string) => Promise<void>
}

/**
 * The create-a-graph sheet, opened from the Graphs screen's "New graph" row —
 * a single name field plus Create, in a bottom sheet so the switcher list
 * itself stays a plain selection list (no inline forms).
 */
export function NewGraphDrawer({
  open,
  onOpenChange,
  documentsRoot,
  existingRoots,
  onCreate,
}: NewGraphDrawerProps): ReactElement {
  const nameId = useId()
  // The usual first graph name pre-fills only a fresh container — next to an
  // existing list it would likely collide and paint the sheet invalid.
  const [typedName, setTypedName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = typedName ?? (existingRoots.length > 0 ? '' : 'Notes')
  const cleanName = cleanGraphName(name)
  const nameTaken = cleanName !== null && isGraphNameTaken(cleanName, existingRoots)
  const canCreate = cleanName !== null && !nameTaken && !busy

  function create(): void {
    if (!canCreate || cleanName === null) {
      return
    }
    setBusy(true)
    setError(null)
    onCreate(graphRootForName(documentsRoot, cleanName)).catch((err: unknown) => {
      setBusy(false)
      setError(errorMessage(err))
    })
  }

  function handleOpenChange(next: boolean): void {
    if (!next && busy) {
      return // the switch is committing — don't dismiss under it
    }
    if (!next) {
      setTypedName(null)
      setError(null)
    }
    onOpenChange(next)
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent aria-label="New iCloud graph">
        <DrawerTitle>New iCloud graph</DrawerTitle>
        <div className="flex flex-col gap-3 pt-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-xs font-medium text-text-secondary">
              Name
            </label>
            <Input
              id={nameId}
              value={name}
              placeholder={existingRoots.length > 0 ? 'New name' : undefined}
              enterKeyHint="go"
              onChange={(event) => setTypedName(event.target.value)}
              onKeyDown={(event) => {
                if (getIsComposing()) {
                  return
                }
                if (event.key === 'Enter') {
                  create()
                }
              }}
              aria-invalid={nameTaken}
              disabled={busy}
            />
          </div>
          {nameTaken ? (
            <p className="text-xs text-destructive">That name already exists in iCloud Drive.</p>
          ) : null}
          {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button type="button" disabled={!canCreate} onClick={create}>
            {busy ? <Spinner /> : null}
            {busy ? 'Setting up…' : 'Create'}
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
