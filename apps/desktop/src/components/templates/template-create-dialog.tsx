import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CommandContext } from '@/lib/commands/types'
import { useNoteTemplates } from '@/providers/note-templates-provider'
import { once } from '@ocavue/utils'
import { lazy, Suspense, useState, type ReactElement } from 'react'

/**
 * The "New template" dialog (docs/porting/note-templates.md): name it, and the
 * file lands at `templates/<slug>.md` seeded with the name as its H1, opened
 * in the normal editor to fill in. Creating the first template also creates
 * the `templates/` folder — the graph is never seeded with one.
 */

interface TemplateCreateDialogProps {
  /** The command capabilities (navigate + generation). */
  context: CommandContext
}

const loadTemplateCreateForm = once(async () => {
  const { TemplateCreateForm } = await import('@/components/templates/template-create-form')
  return { default: TemplateCreateForm }
})

const TemplateCreateForm = lazy(loadTemplateCreateForm)

export function TemplateCreateDialog({ context }: TemplateCreateDialogProps): ReactElement {
  const { createOpen, closeTemplateCreate } = useNoteTemplates()
  const [showForm, setShowForm] = useState(createOpen)

  if (createOpen && !showForm) {
    setShowForm(true)
  }

  return (
    <Dialog
      open={createOpen}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          closeTemplateCreate()
        }
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) {
          setShowForm(false)
        }
      }}
    >
      <Suspense>
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New template</DialogTitle>
            <DialogDescription>
              A markdown file in your graph's <code>templates/</code> folder.
            </DialogDescription>
          </DialogHeader>

          {showForm ? <TemplateCreateForm onClose={closeTemplateCreate} context={context} /> : null}
        </DialogContent>
      </Suspense>
    </Dialog>
  )
}
