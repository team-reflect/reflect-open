import { useState, type ReactElement } from 'react'
import { AI_PROVIDERS, aiProvider, aiProviderIdSchema, type AiProviderId } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAddAiProviderSubmit } from '@/hooks/use-add-ai-provider-submit'
import type { NewAiProvider } from '@/hooks/use-ai-providers'

interface AddAiProviderDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Persists the new provider (keychain + settings); rejects on failure. */
  onAdd: (draft: NewAiProvider) => Promise<void>
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The mobile "Add AI provider" bottom sheet — desktop's dialog as a Drawer
 * (the {@link ConnectGithubDrawer} form idiom: labeled fields, shadcn
 * Selects) over the same {@link useAddAiProviderSubmit} flow: verify key →
 * inline rejection / save-anyway downgrade → persist. Models come from the
 * provider's curated list; custom model ids stay a desktop affordance. The
 * sheet body mounts per open cycle, so a dismissed half-typed key never
 * leaks into the next open.
 */
export function AddAiProviderDrawer({
  open,
  onOpenChange,
  onAdd,
}: AddAiProviderDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Add AI provider">
        {open ? <AddAiProviderSheet onAdd={onAdd} onClose={() => onOpenChange(false)} /> : null}
      </DrawerContent>
    </Drawer>
  )
}

/** The sheet body — separate so each open starts a fresh draft. */
function AddAiProviderSheet({
  onAdd,
  onClose,
}: {
  onAdd: (draft: NewAiProvider) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [providerId, setProviderId] = useState<AiProviderId>(AI_PROVIDERS[0].id)
  const [model, setModel] = useState(AI_PROVIDERS[0].models[0].id)
  const [apiKey, setApiKey] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const { submitError, unverified, resetUnverified, submit } = useAddAiProviderSubmit({
    onAdd,
    onDone: onClose,
  })
  const provider = aiProvider(providerId)

  const submitDraft = async (): Promise<void> => {
    setSubmitting(true)
    try {
      await submit({ provider: providerId, model, apiKey, isDefault })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <DrawerTitle className="px-4 pt-1">Add AI provider</DrawerTitle>
      <div className="flex max-h-[75dvh] flex-col gap-4 overflow-y-auto px-4 pb-8 pt-3">
        <p className="text-sm text-text-muted">
          The API key is stored in this device’s keychain, never in your graph — add it on each
          device you chat from.
        </p>

        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Provider</span>
          <Select
            value={provider.id}
            onValueChange={(value) => {
              const next = aiProvider(aiProviderIdSchema.parse(value))
              setProviderId(next.id)
              setModel(next.models[0].id)
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
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger aria-label="Default model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {provider.models.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>API key</span>
          <Input
            type="password"
            placeholder={provider.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value)
              resetUnverified()
            }}
          />
        </label>

        <label className="flex items-center gap-2 py-1">
          <input
            type="checkbox"
            className="accent-accent"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
          />
          <span className="text-sm text-text">Use as the default provider</span>
        </label>

        {submitError !== null ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
        {unverified ? (
          <InlineAlert tone="warning">
            Couldn’t reach {provider.label} to verify the key. Submit again to save it unverified.
          </InlineAlert>
        ) : null}
        <Button disabled={apiKey.trim() === '' || submitting} onClick={() => void submitDraft()}>
          {unverified ? 'Save anyway' : 'Add provider'}
        </Button>
      </div>
    </>
  )
}
