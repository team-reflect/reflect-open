import { useState, type ReactElement } from 'react'
import { useForm } from 'react-hook-form'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { InlineAlert } from '@/components/inline-alert.tsx'
import type { CommandContext } from '@/lib/commands/types.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

interface TemplateCreateFormProps {
  context: CommandContext
  onClose: () => void
}

interface TemplateCreateValues {
  name: string
}

export function TemplateCreateForm({ context, onClose }: TemplateCreateFormProps): ReactElement {
  const { register, handleSubmit, formState } = useForm<TemplateCreateValues>({
    defaultValues: { name: '' },
  })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const { templates } = useCoreServices()

  const submit = handleSubmit(async (values) => {
    setSubmitError(null)
    try {
      const path = await templates.createTemplate(values.name)
      onClose()
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
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={formState.isSubmitting}>
          Create
        </Button>
      </div>
    </form>
  )
}
