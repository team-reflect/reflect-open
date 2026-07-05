import { useEffect, type ReactElement } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { AI_PROVIDERS, aiProvider, aiProviderIdSchema, type AiProviderId } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { InlineAlert } from '@/components/inline-alert'
import { useAddAiProviderSubmit } from '@/hooks/use-add-ai-provider-submit'
import type { NewAiProvider } from '@/hooks/use-ai-providers'
import { ModelCombobox } from './model-combobox'

interface AddAiProviderDialogProps {
  /** Persists the new provider (keychain + settings); rejects on failure. */
  onAdd: (draft: NewAiProvider) => Promise<void>
  onClose: () => void
}

interface AddAiProviderForm {
  provider: AiProviderId
  model: string
  apiKey: string
  isDefault: boolean
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The "Add AI provider" modal: pick a provider, pick its default model, paste
 * an API key, optionally mark it as the app default. The verify-then-persist
 * flow (rejected keys inline, unreachable providers downgrading to "Save
 * anyway") is {@link useAddAiProviderSubmit}, shared with the mobile sheet.
 * The key goes to the OS keychain, never into the settings document, and a
 * failure keeps the dialog open with the typed key intact for a retry.
 */
export function AddAiProviderDialog({ onAdd, onClose }: AddAiProviderDialogProps): ReactElement {
  const { register, control, handleSubmit, setValue, formState } = useForm<AddAiProviderForm>({
    defaultValues: {
      provider: AI_PROVIDERS[0].id,
      model: AI_PROVIDERS[0].models[0].id,
      apiKey: '',
      isDefault: false,
    },
  })
  const { submitError, unverified, resetUnverified, submit } = useAddAiProviderSubmit({
    onAdd,
    onDone: onClose,
  })

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

  const providerId = useWatch({ control, name: 'provider' })
  const selectedModel = useWatch({ control, name: 'model' })
  const provider = aiProvider(providerId)

  const submitForm = handleSubmit(async (values) => {
    await submit(values)
  })

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add AI provider</DialogTitle>
          <DialogDescription>
            The API key is stored in your OS keychain, never in your graph.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            void submitForm(event)
          }}
        >
          <div className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>Provider</span>
            <Select
              value={provider.id}
              onValueChange={(value) => {
                const next = aiProvider(aiProviderIdSchema.parse(value))
                setValue('provider', next.id)
                setValue('model', next.models[0].id)
                resetUnverified()
              }}
            >
              <SelectTrigger aria-label="Provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_PROVIDERS.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>Default model</span>
            <ModelCombobox
              value={selectedModel}
              provider={provider.id}
              models={provider.models}
              onChange={(modelId) => setValue('model', modelId)}
            />
          </div>

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
                  resetUnverified()
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
            <span className="text-sm text-text">Use as the default provider</span>
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
              {unverified ? 'Save anyway' : 'Add provider'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
