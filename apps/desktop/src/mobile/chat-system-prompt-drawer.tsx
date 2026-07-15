import { useState, type ReactElement } from 'react'
import { CHAT_SYSTEM_PROMPT_MAX_LENGTH, normalizeChatSystemPrompt } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { Textarea } from '@/components/ui/textarea'

interface ChatSystemPromptDrawerProps {
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (value: string) => void
}

/** The mobile editor for the AI chat's user-configured system prompt. */
export function ChatSystemPromptDrawer({
  value,
  open,
  onOpenChange,
  onSave,
}: ChatSystemPromptDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="System prompt">
        {open ? (
          <ChatSystemPromptSheet
            value={value}
            onSave={onSave}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

function ChatSystemPromptSheet({
  value,
  onSave,
  onClose,
}: {
  value: string
  onSave: (value: string) => void
  onClose: () => void
}): ReactElement {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const currentDraft = dirty ? draft : value

  return (
    <>
      <DrawerTitle className="px-4 pt-1">System prompt</DrawerTitle>
      <div className="flex max-h-[75dvh] flex-col gap-4 overflow-y-auto px-4 pb-8 pt-3">
        <p className="text-sm text-text-muted">
          Additional instructions sent with every AI chat (up to{' '}
          {CHAT_SYSTEM_PROMPT_MAX_LENGTH.toLocaleString()} characters). Reflect’s note-search,
          citation, and privacy rules still apply.
        </p>
        <Textarea
          aria-label="System prompt instructions"
          value={currentDraft}
          onChange={(event) => {
            setDirty(true)
            setDraft(event.target.value)
          }}
          maxLength={CHAT_SYSTEM_PROMPT_MAX_LENGTH}
          rows={8}
          autoFocus
          placeholder="Be concise. Challenge my assumptions and ask clarifying questions."
          className="min-h-36 resize-y text-sm"
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={normalizeChatSystemPrompt(currentDraft) === ''}
            onClick={() => {
              onSave('')
              onClose()
            }}
          >
            Use default
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSave(normalizeChatSystemPrompt(currentDraft))
              onClose()
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </>
  )
}
