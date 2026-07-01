import type { ReactElement } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { AiPrompt } from '@reflect/core'
import { Button } from '@/components/ui/button'

interface AiPromptRowProps {
  prompt: AiPrompt
  onEdit: (prompt: AiPrompt) => void
  onRemove: (id: string) => void
}

/** One saved AI prompt in the settings list: label, body preview, edit/delete. */
export function AiPromptRow({ prompt, onEdit, onRemove }: AiPromptRowProps): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-text">{prompt.label}</div>
        <p className="mt-0.5 truncate text-xs text-text-muted">{prompt.body}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${prompt.label}`}
          onClick={() => onEdit(prompt)}
          className="text-text-muted hover:bg-surface-hover hover:text-text"
        >
          <Pencil aria-hidden strokeWidth={1.75} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${prompt.label}`}
          onClick={() => onRemove(prompt.id)}
          className="text-text-muted hover:bg-surface-hover hover:text-text"
        >
          <Trash2 aria-hidden strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  )
}
