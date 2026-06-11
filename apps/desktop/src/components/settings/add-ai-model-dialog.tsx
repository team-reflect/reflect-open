import {
  useEffect,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react'
import { useForm } from 'react-hook-form'
import {
  AI_PROVIDERS,
  aiProvider,
  errorMessage,
  validateApiKey,
  type AiProviderId,
} from '@reflect/core'
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
import { providerFetch } from '@/lib/provider-fetch'
import type { NewAiModel } from '@/hooks/use-ai-models'

interface AddAiModelDialogProps {
  /** Persists the new model (keychain + settings); rejects on failure. */
  onAdd: (draft: NewAiModel) => Promise<void>
  onClose: () => void
}

interface AddAiModelForm {
  provider: AiProviderId
  model: string
  apiKey: string
  isDefault: boolean
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'
const SELECT_CLASS =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-text ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring'

/**
 * The "Add AI model" modal: pick a provider, pick one of its models, paste an
 * API key, optionally mark it as the app default. The key is verified against
 * the provider before anything is stored — a rejected key shows inline; an
 * unreachable provider (offline) downgrades the submit to an explicit "Save
 * anyway" instead of hard-blocking on connectivity. Submitting hands the
 * draft to {@link AddAiModelDialogProps.onAdd} — the key goes to the OS
 * keychain, never into the settings document — and a failure keeps the
 * dialog open with the typed key intact so the user can retry.
 */
export function AddAiModelDialog({ onAdd, onClose }: AddAiModelDialogProps): ReactElement {
  const { register, handleSubmit, watch, setValue, formState } = useForm<AddAiModelForm>({
    defaultValues: {
      provider: AI_PROVIDERS[0].id,
      model: AI_PROVIDERS[0].models[0].id,
      apiKey: '',
      isDefault: false,
    },
  })
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Set when the provider couldn't be reached to verify the key; the next
  // submit then saves without verification (the button says so).
  const [unverified, setUnverified] = useState(false)

  // The dialog is conditionally mounted by its parent (not kept alive with
  // open=false), so Radix's Presence/onCloseAutoFocus path is bypassed when
  // Cancel or a successful submit calls onClose() directly.  Capturing focus
  // here and restoring it in the cleanup ensures the opener always gets focus
  // back regardless of which close path runs.
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement) {
        opener.focus()
      }
    }
  }, [])

  const provider = aiProvider(watch('provider'))

  const submit = handleSubmit(async (values) => {
    setSubmitError(null)
    const apiKey = values.apiKey.trim()
    try {
      if (!unverified) {
        const validation = await validateApiKey(values.provider, apiKey, providerFetch)
        if (validation === 'invalid') {
          setSubmitError(`${aiProvider(values.provider).label} rejected this API key.`)
          return
        }
        if (validation === 'unreachable') {
          setUnverified(true)
          return
        }
      }
      await onAdd({
        provider: values.provider,
        model: values.model,
        apiKey,
        isDefault: values.isDefault,
      })
      onClose()
    } catch (error: unknown) {
      setSubmitError(errorMessage(error))
    }
  })

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add AI model</DialogTitle>
          <DialogDescription>
            The API key is stored in your OS keychain, never in your graph.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            void submit(event)
          }}
        >
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>Provider</span>
            <select
              className={SELECT_CLASS}
              {...register('provider', {
                onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                  const next = aiProvider(event.target.value as AiProviderId)
                  setValue('model', next.models[0].id)
                  setUnverified(false)
                },
              })}
            >
              {AI_PROVIDERS.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>Model</span>
            <select className={SELECT_CLASS} {...register('model')}>
              {provider.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>API key</span>
            <Input
              type="password"
              placeholder={provider.keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              {...register('apiKey', {
                validate: (value) => value.trim().length > 0 || 'Enter an API key.',
                onChange: () => {
                  setUnverified(false)
                },
              })}
            />
            {formState.errors.apiKey ? (
              <span role="alert" className="text-xs text-red-600 dark:text-red-400">
                {formState.errors.apiKey.message}
              </span>
            ) : null}
          </label>

          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-accent" {...register('isDefault')} />
            <span className="text-sm text-text">Use as the default model</span>
          </label>

          {submitError !== null ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
          {unverified ? (
            <InlineAlert tone="warning">
              Couldn't reach {provider.label} to verify the key. Submit again to save it
              unverified.
            </InlineAlert>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={formState.isSubmitting}>
              {unverified ? 'Save anyway' : 'Add model'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
