import { useMemo, type ReactElement } from 'react'
import { ArrowUp, Plus, Square, X } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentGroup,
  AttachmentMedia,
} from '@/components/ui/attachment'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { imageFilesFrom } from '@/lib/chat-attachments'
import { groupModelOptions } from '@/lib/chat-model-groups'
import { keybindingFor } from '@/lib/commands/app-commands'
import { useChatSession } from '@/providers/chat-provider'
import { ChatHistoryMenu } from './chat-history-menu'

const NEW_CHAT_BINDING = keybindingFor('chat.new')

/**
 * The composer: a textarea (Enter sends, Shift-Enter breaks, Esc stops a
 * streaming turn), the session's model picker — every configured provider's
 * full model list — and a send button that turns into stop while a turn
 * streams. Pasted images queue as attachments and preview above the
 * textarea — a message can be a photo alone, so Enter sends whenever there
 * is text *or* something attached. The history menu loads past
 * conversations; "New chat" appears once there's a conversation to leave.
 */
export function ChatInput(): ReactElement {
  const {
    turns,
    status,
    providers,
    modelOptions,
    activeModel,
    selectModel,
    draft,
    setDraft,
    attachments,
    attachImages,
    removeAttachment,
    send,
    stop,
    newChat,
  } = useChatSession()
  const streaming = status === 'streaming'
  const empty = draft.trim() === '' && attachments.length === 0

  const groups = useMemo(
    () => groupModelOptions(modelOptions, providers),
    [modelOptions, providers],
  )
  const activeIndex = modelOptions.findIndex(
    (option) =>
      activeModel !== null &&
      option.configId === activeModel.id &&
      option.modelId === activeModel.model,
  )

  // The draft lives in the provider (it must survive the screen unmounting —
  // on mobile every tab switch does that), and a send that goes through
  // clears it there.
  const submit = () => {
    if (streaming || empty) {
      return
    }
    void send(draft)
  }

  return (
    <div className="flex-none px-6 pb-6">
      <div className="mx-auto w-full max-w-2xl rounded-xl border border-border bg-surface focus-within:border-ring">
        {attachments.length > 0 ? (
          <AttachmentGroup className="flex-wrap gap-2 overflow-visible px-3.5 pt-3 pb-0">
            {attachments.map((attachment) => (
              <Attachment
                key={attachment.id}
                orientation="vertical"
                size="sm"
                className="w-16 bg-surface"
              >
                <AttachmentMedia variant="image" className="w-14">
                  <img src={attachment.dataUrl} alt={attachment.name} />
                </AttachmentMedia>
                <AttachmentActions className="!top-0 !right-0 -translate-y-1/2 translate-x-1/2">
                  <AttachmentAction
                    aria-label={`Remove ${attachment.name}`}
                    className="size-4 rounded-full border border-border bg-surface p-0 text-text-muted hover:text-text"
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <X aria-hidden className="size-3" />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </AttachmentGroup>
        ) : null}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
            if (event.key === 'Escape' && streaming) {
              event.preventDefault()
              stop()
            }
          }}
          onPaste={(event) => {
            const files = imageFilesFrom(event.clipboardData)
            if (files.length === 0) {
              return
            }
            event.preventDefault()
            void attachImages(files)
          }}
          placeholder="Ask about your notes…"
          aria-label="Chat message"
          rows={2}
          autoFocus
          /* Opts out of the global :focus-visible outline (styles/index.css);
             the wrapper's focus-within border is the focus treatment here. */
          data-slot="textarea"
          className="field-sizing-content max-h-48 w-full resize-none bg-transparent px-3.5 pt-3 text-sm text-text outline-none placeholder:text-text-muted"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          <Select
            value={activeIndex >= 0 ? String(activeIndex) : ''}
            onValueChange={(value) => {
              const option = modelOptions[Number(value)]
              if (option !== undefined) {
                selectModel({ configId: option.configId, modelId: option.modelId })
              }
            }}
          >
            <SelectTrigger
              aria-label="Model"
              size="sm"
              className="w-auto max-w-64 border-none bg-transparent text-xs text-text-muted shadow-none"
            >
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) => (
                <SelectGroup key={group.configId}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.options.map(({ option, value }) => (
                    <SelectItem key={value} value={value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1" />
          <ChatHistoryMenu />
          {turns.length > 0 && !streaming ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={newChat}>
                  <Plus aria-hidden data-icon="inline-start" />
                  New chat
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                New chat {NEW_CHAT_BINDING ? <ShortcutKeys binding={NEW_CHAT_BINDING} /> : null}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {streaming ? (
            <Button size="icon-sm" aria-label="Stop" onClick={stop}>
              <Square aria-hidden className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label="Send"
              disabled={empty || activeModel === null}
              onClick={submit}
            >
              <ArrowUp aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
