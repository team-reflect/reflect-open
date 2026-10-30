import { useCallback, useState, type ReactElement } from 'react'
import { getIsComposing } from '@meowdown/core'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useGraph } from '@/providers/graph-provider.tsx'
import { ConfirmActionDialog } from '@/components/confirm-action-dialog.tsx'
import { SettingsField } from './field.tsx'
import { SettingsSection } from './section.tsx'

export function DestructiveSection(): ReactElement {
  const { graph, forget } = useGraph()
  const [confirming, setConfirming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const graphRoot = graph?.root ?? null
  const forgetGraph = useCallback(async () => {
    if (graphRoot !== null) {
      await forget(graphRoot)
    }
  }, [forget, graphRoot])
  const closeForget = useCallback(() => setConfirming(false), [])
  const closeDelete = useCallback(() => setConfirmingDelete(false), [])
  const graphId = graph?.root ?? 'this graph'

  return (
    <>
      <SettingsSection id="destructive">
        <SettingsField legend="Saved graph" description="Forget this graph. Files stay on disk.">
          <div className="mt-3 flex justify-start">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={graph === null}
              onClick={() => setConfirming(true)}
            >
              Forget graph
            </Button>
          </div>
        </SettingsField>
        <SettingsField
          legend="Delete graph"
          description="Move the entire selected folder and everything inside it to Trash."
        >
          <div className="mt-3 flex justify-start">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={graph === null}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete graph
            </Button>
          </div>
        </SettingsField>
      </SettingsSection>

      {confirming && graph !== null ? (
        <ConfirmActionDialog
          title="Forget graph?"
          description={
            <>
              Remove <span className="font-mono text-text [overflow-wrap:anywhere]">{graphId}</span>{' '}
              from saved graphs. Files stay on disk.
            </>
          }
          confirmLabel="Forget graph"
          pendingLabel="Forgetting…"
          variant="destructive"
          onConfirm={forgetGraph}
          onClose={closeForget}
        />
      ) : null}

      {confirmingDelete && graph !== null ? (
        <DeleteGraphDialog root={graph.root} name={graph.name} onClose={closeDelete} />
      ) : null}
    </>
  )
}

/** Mounted only while open, so the typed name and any error start fresh each time. */
function DeleteGraphDialog({
  root,
  name,
  onClose,
}: {
  root: string
  name: string
  onClose: () => void
}): ReactElement {
  const { deleteGraph } = useGraph()
  const [typedName, setTypedName] = useState('')
  // GitHub-style guard: the delete button stays dead until the typed name
  // matches the graph's folder name exactly.
  const nameConfirmed = typedName === name

  return (
    <ConfirmActionDialog
      title="Delete graph?"
      description={
        <>
          Move the entire selected folder{' '}
          <span className="font-mono text-text [overflow-wrap:anywhere]">{root}</span> and
          everything inside it to Trash. Type <span className="font-mono text-text">{name}</span> to
          confirm.
        </>
      }
      confirmLabel="Delete graph"
      pendingLabel="Deleting…"
      variant="destructive"
      confirmDisabled={!nameConfirmed}
      onConfirm={deleteGraph}
      onClose={onClose}
    >
      {({ confirm, pending }) => (
        <Input
          aria-label="Graph name"
          placeholder={name}
          value={typedName}
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          onChange={(event) => setTypedName(event.target.value)}
          onKeyDown={(event) => {
            if (getIsComposing()) {
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              confirm()
            }
          }}
        />
      )}
    </ConfirmActionDialog>
  )
}
