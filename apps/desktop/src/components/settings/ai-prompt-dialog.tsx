import { lazy, Suspense, type ReactElement } from 'react'
import type { AiPrompt } from '@reflect/core'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AiPromptDraft } from '@/hooks/use-ai-prompts'

interface AiPromptDialogProps {
  /** The prompt being edited, or null when adding a new one. */
  prompt: AiPrompt | null
  /** Persists the draft (add or update). */
  onSave: (draft: AiPromptDraft) => void
  onClose: () => void
}

const AiPromptForm = lazy(async () => {
  const { AiPromptForm } = await import('@/components/settings/ai-prompt-form')
  return { default: AiPromptForm }
})

/**
 * The add/edit dialog for a saved AI prompt: a label for the picker, the
 * prompt body (referencing the selection via `{{selectedText}}` — old
 * Reflect's syntax), and whether the accepted result replaces the selection
 * or is inserted below it.
 */
export function AiPromptDialog({ prompt, onSave, onClose }: AiPromptDialogProps): ReactElement {
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <Suspense>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{prompt === null ? 'Add prompt' : 'Edit prompt'}</DialogTitle>
            <DialogDescription>
              The prompt runs on the text you select in a note. Use{' '}
              <code className="font-mono text-xs">{'{{selectedText}}'}</code> where the selection
              should appear.
            </DialogDescription>
          </DialogHeader>

          <AiPromptForm prompt={prompt} onSave={onSave} onClose={onClose} />
        </DialogContent>
      </Suspense>
    </Dialog>
  )
}
