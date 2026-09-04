import type { ReactElement } from 'react'
import { createDeferredFeature } from '@/components/deferred-feature'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CommandContext } from '@/lib/commands/types'
import { useNoteTemplates } from '@/providers/note-templates-provider'

const TemplateCreateForm = createDeferredFeature(
  async () => ({ default: (await import('./template-create-form')).TemplateCreateForm }),
  { name: 'the template form' },
)

interface TemplateCreateDialogProps {
  /** The command capabilities (navigate + generation). */
  context: CommandContext
}

/** Name a new template, then open its markdown file in the editor. */
export function TemplateCreateDialog({ context }: TemplateCreateDialogProps): ReactElement {
  const { createOpen, closeTemplateCreate } = useNoteTemplates()

  return (
    <Dialog
      open={createOpen}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          closeTemplateCreate()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            A markdown file in your graph's <code>templates/</code> folder.
          </DialogDescription>
        </DialogHeader>
        <TemplateCreateForm context={context} />
      </DialogContent>
    </Dialog>
  )
}
