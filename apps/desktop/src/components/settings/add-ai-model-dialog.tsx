import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
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
const FIELD_CONTROL_CLASS =
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
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Modal focus contract: focus returns to the opener when the dialog closes
  // (the trap itself is in the keydown handler below).
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

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') {
      return
    }
    // Keyboard-native product: Tab must cycle within the modal, not escape
    // into the settings page behind it.
    const container = dialogRef.current
    if (!container) {
      return
    }
    const focusable = container.querySelectorAll<HTMLElement>('select, input, button')
    if (focusable.length === 0) {
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-[18vh]"
      onPointerDown={onClose}
      data-testid="add-ai-model-overlay"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add AI model"
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-4 shadow-lg"
        onPointerDown={(event) => {
          event.stopPropagation() // clicks inside must not close
        }}
        onKeyDown={handleDialogKeyDown}
      >
        <h2 className="text-sm font-semibold text-text">Add AI model</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          The API key is stored in your OS keychain, never in your graph.
        </p>
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            void submit(event)
          }}
        >
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>Provider</span>
            <select
              autoFocus
              className={FIELD_CONTROL_CLASS}
              {...register('provider', {
                onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                  // Each provider has its own model list; reset to its first.
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
            <select className={FIELD_CONTROL_CLASS} {...register('model')}>
              {provider.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>API key</span>
            <input
              type="password"
              placeholder={provider.keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className={FIELD_CONTROL_CLASS}
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
              Couldn’t reach {provider.label} to verify the key. Submit again to save it
              unverified.
            </InlineAlert>
          ) : null}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={formState.isSubmitting}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover disabled:opacity-50"
            >
              {unverified ? 'Save anyway' : 'Add model'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
