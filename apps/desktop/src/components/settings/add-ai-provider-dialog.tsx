import { lazy, Suspense, type ReactElement } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { NewAiProvider } from '@/hooks/use-ai-providers'

interface AddAiProviderDialogProps {
  /** Persists the new provider (keychain + settings); rejects on failure. */
  onAdd: (draft: NewAiProvider) => Promise<void>
  onClose: () => void
}

const AddAiProviderForm = lazy(async () => {
  const { AddAiProviderForm } = await import('@/components/settings/add-ai-provider-form')
  return { default: AddAiProviderForm }
})

/**
 * The "Add AI provider" modal: pick a provider, pick its default model, paste
 * an API key, optionally mark it as the app default. The key goes to the OS
 * keychain, never into the settings document, and a failure keeps the dialog
 * open with the typed key intact for a retry.
 */
export function AddAiProviderDialog({ onAdd, onClose }: AddAiProviderDialogProps): ReactElement {
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
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

          <AddAiProviderForm onAdd={onAdd} onClose={onClose} />
        </DialogContent>
      </Suspense>
    </Dialog>
  )
}
