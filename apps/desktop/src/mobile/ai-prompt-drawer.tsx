import { useState, type ReactElement } from 'react'
import type { AiPrompt, AiPromptMode } from '@reflect/core'
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
import { Textarea } from '@/components/ui/textarea'
import type { AiPromptDraft } from '@/hooks/use-ai-prompts'

interface AiPromptDrawerProps {
  /** The prompt being edited, `'new'` when adding; null renders nothing (exit animation). */
  prompt: AiPrompt | 'new' | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Persists the draft (add or update). */
  onSave: (draft: AiPromptDraft) => void
  /** Drops the saved prompt being edited. */
  onRemove: (id: string) => void
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The mobile add/edit sheet for a saved AI prompt — desktop's
 * {@link AiPromptDialog} as a Drawer: a label for the picker, the prompt body
 * (referencing the selection via `{{selectedText}}`), and whether the
 * accepted result replaces the selection or is inserted below it. The sheet
 * body mounts per open cycle, so a dismissed half-typed draft never leaks
 * into the next open.
 */
export function AiPromptDrawer({
  prompt,
  open,
  onOpenChange,
  onSave,
  onRemove,
}: AiPromptDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label={prompt === 'new' ? 'Add prompt' : 'Edit prompt'}>
        {open && prompt !== null ? (
          <AiPromptSheet
            prompt={prompt === 'new' ? null : prompt}
            onSave={onSave}
            onRemove={onRemove}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

/** The sheet body — separate so each open starts a fresh draft. */
function AiPromptSheet({
  prompt,
  onSave,
  onRemove,
  onClose,
}: {
  prompt: AiPrompt | null
  onSave: (draft: AiPromptDraft) => void
  onRemove: (id: string) => void
  onClose: () => void
}): ReactElement {
  const [label, setLabel] = useState(prompt?.label ?? '')
  const [body, setBody] = useState(prompt?.body ?? '')
  const [mode, setMode] = useState<AiPromptMode>(prompt?.mode ?? 'replace')
  const saveDisabled = label.trim() === '' || body.trim() === ''

  return (
    <>
      <DrawerTitle className="px-4 pt-1">
        {prompt === null ? 'Add prompt' : 'Edit prompt'}
      </DrawerTitle>
      <div className="flex max-h-[75dvh] flex-col gap-4 overflow-y-auto px-4 pb-8 pt-3">
        <p className="text-sm text-text-muted">
          The prompt runs on the text you select in a note. Use{' '}
          <code className="font-mono text-xs">{'{{selectedText}}'}</code> where the selection should
          appear.
        </p>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Label</span>
          <Input
            autoComplete="off"
            placeholder="Translate to French"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Prompt</span>
          <Textarea
            rows={6}
            placeholder={'Translate the following text to French.\n\n{{selectedText}}'}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="min-h-36 resize-y text-sm"
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Result</span>
          <Select
            value={mode}
            items={{ replace: 'Replaces the selection', append: 'Inserted below the selection' }}
            onValueChange={(value) => setMode(value as AiPromptMode)}
          >
            <SelectTrigger aria-label="Result" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="replace">Replaces the selection</SelectItem>
              <SelectItem value="append">Inserted below the selection</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex justify-end gap-2">
          {prompt !== null ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                onRemove(prompt.id)
                onClose()
              }}
            >
              Remove
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={saveDisabled}
            onClick={() => {
              onSave({ label: label.trim(), body: body.trim(), mode })
              onClose()
            }}
          >
            {prompt === null ? 'Add prompt' : 'Save'}
          </Button>
        </div>
      </div>
    </>
  )
}
