import { useState, type ReactElement } from 'react'
import { useForm } from 'react-hook-form'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineAlert } from '@/components/inline-alert'
import type { CommandContext } from '@/lib/commands/types'
import { createTemplate } from '@/lib/note-templates'
import { useNoteTemplates } from '@/providers/note-templates-provider'

interface TemplateCreateFormProps {
  context: CommandContext
}

interface TemplateCreateValues {
  name: string
}

/** The on-demand template form, reset when the dialog finishes closing. */
export function TemplateCreateForm({ context }: TemplateCreateFormProps): ReactElement {
  const { closeTemplateCreate } = useNoteTemplates()
  const { register, handleSubmit, formState } = useForm<TemplateCreateValues>({
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
  )
}
