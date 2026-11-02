import type { ReactElement } from 'react'
import { useForm } from 'react-hook-form'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { InlineAlert } from '@/components/inline-alert.tsx'
import type { CommandContext } from '@/lib/commands/types.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useReportPending } from '@/hooks/use-report-pending.ts'

interface TemplateCreateFormProps {
  context: CommandContext
  onClose: () => void
  /** Reports whether a create is running, so the host can refuse to dismiss. */
  onPendingChange: (pending: boolean) => void
}

interface TemplateCreateValues {
  name: string
}

export function TemplateCreateForm({
  context,
  onClose,
  onPendingChange,
}: TemplateCreateFormProps): ReactElement {
  const { register, handleSubmit, setError, formState } = useForm<TemplateCreateValues>({
    defaultValues: { name: '' },
  })
  const { templates } = useCoreServices()
  const pending = formState.isSubmitting
  const submitError = formState.errors.root?.message
  useReportPending(pending, onPendingChange)

  // react-hook-form clears the `root` error at the start of each submit.
  const submit = handleSubmit(async (values) => {
    try {
      const path = await templates.createTemplate(values.name)
      onClose()
      context.navigate({ kind: 'note', path })
    } catch (cause: unknown) {
      setError('root', { message: errorMessage(cause) })
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

      {submitError !== undefined ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          Create
        </Button>
      </div>
    </form>
  )
}
