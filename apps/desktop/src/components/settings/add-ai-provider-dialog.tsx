import { lazy, Suspense, useState, type ReactElement } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import type { NewAiProvider } from '@reflect/core'

interface AddAiProviderDialogProps {
  /** Persists the new provider (keychain + settings); rejects on failure. */
  onAdd: (draft: NewAiProvider) => Promise<void>
  onClose: () => void
}

const AddAiProviderForm = lazy(async () => {
  const { AddAiProviderForm } = await import('@/components/settings/add-ai-provider-form.tsx')
  return { default: AddAiProviderForm }
})

/**
 * The "Add AI provider" modal: pick a provider, pick its default model, paste
 * an API key, optionally mark it as the app default. The key goes to the OS
 * keychain, never into the settings document, and a failure keeps the dialog
 * open with the typed key intact for a retry. It cannot be dismissed while a
 * submit is running, since the provider would still be added.
 */
export function AddAiProviderDialog({ onAdd, onClose }: AddAiProviderDialogProps): ReactElement {
  const [pending, setPending] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen && !pending) onClose()
      }}
    >
      <Suspense>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add AI provider</DialogTitle>
            <DialogDescription>
              The API key is stored in your OS keychain, never in your graph.
            </DialogDescription>
          </DialogHeader>

          <AddAiProviderForm onAdd={onAdd} onClose={onClose} onPendingChange={setPending} />
        </DialogContent>
      </Suspense>
    </Dialog>
  )
}
