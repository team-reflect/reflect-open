import { useState, type ReactElement } from 'react'
import { useForm } from 'react-hook-form'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { InlineAlert } from '@/components/inline-alert'
import type { CommandContext } from '@/lib/commands/types'
import { createTemplate } from '@/lib/note-templates'
import { useNoteTemplates } from '@/providers/note-templates-provider'

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

interface TemplateCreateForm {
  name: string
}

/**
 * The dialog lives for the workspace's lifetime, so the form only mounts while
 * it is open: every "New template" starts from an empty name and no stale
 * error, rather than the last name this workspace typed.
 */
export function TemplateCreateDialog({ context }: TemplateCreateDialogProps): ReactElement | null {
  const { createOpen } = useNoteTemplates()

  if (!createOpen) {
    return null
  }

  return <TemplateCreateDialogContent context={context} />
}

function TemplateCreateDialogContent({ context }: TemplateCreateDialogProps): ReactElement {
  const { closeTemplateCreate } = useNoteTemplates()
  const { register, handleSubmit, formState } = useForm<TemplateCreateForm>({
    defaultValues: { name: '' },
  })
  const [submitError, setSubmitError] = useState<string | null>(null)

  const submit = handleSubmit(async (values) => {
    setSubmitError(null)
    const generation = context.generation()
    if (generation === null) {
      return
    }
    try {
      const path = await createTemplate(values.name, generation)
      closeTemplateCreate()
      context.navigate({ kind: 'note', path })
    } catch (cause: unknown) {
      setSubmitError(errorMessage(cause))
    }
  })

  return (
    <Dialog
      open
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
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            void submit(event)
          }}
        >
          <Input
            autoFocus
            placeholder="Template name"
            autoComplete="off"
            spellCheck={false}
            {...register('name', {
              validate: (value) => value.trim().length > 0 || 'Enter a name.',
            })}
          />
          {formState.errors.name ? (
            <span role="alert" className="text-xs text-red-600 dark:text-red-400">
              {formState.errors.name.message}
            </span>
          ) : null}

          {submitError !== null ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={closeTemplateCreate}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={formState.isSubmitting}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
