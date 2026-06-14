import { useMemo, useState, type ReactElement } from 'react'
import { aiProvider, type AiProviderConfig, type ChatModelOption } from '@reflect/core'
import { ArrowUp, Plus, Square, X } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'
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
import { imageFilesFrom } from '@/lib/chat-attachments'
import { keybindingFor } from '@/lib/commands/app-commands'
import { useChatSession } from '@/providers/chat-provider'
import { ChatHistoryMenu } from './chat-history-menu'

const NEW_CHAT_BINDING = keybindingFor('chat.new')

interface ModelOptionGroup {
  configId: string
  /** Provider label, key-hint-qualified when the provider is configured twice. */
  label: string
  /** The group's models, each with its picker value (index into the options). */
  options: Array<{ option: ChatModelOption; value: string }>
}

/**
 * The flat option list regrouped per configured provider for rendering
 * (options arrive consecutively per entry). Values are list indexes — model
 * ids alone can collide across providers.
 */
function groupModelOptions(
  options: ChatModelOption[],
  providers: AiProviderConfig[],
): ModelOptionGroup[] {
  const groups: ModelOptionGroup[] = []
  options.forEach((option, index) => {
    const item = { option, value: String(index) }
    const last = groups.at(-1)
    if (last?.configId === option.configId) {
      last.options.push(item)
      return
    }
    const providerLabel = aiProvider(option.provider).label
    const duplicated =
      providers.filter((provider) => provider.provider === option.provider).length > 1
    const keyHint = providers.find((provider) => provider.id === option.configId)?.keyHint ?? ''
    groups.push({
      configId: option.configId,
      label: duplicated && keyHint !== '' ? `${providerLabel} ·····${keyHint}` : providerLabel,
      options: [item],
    })
  })
  return groups
}

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
    attachments,
    attachImages,
    removeAttachment,
    send,
    stop,
    newChat,
  } = useChatSession()
  const [text, setText] = useState('')
  const streaming = status === 'streaming'
  const empty = text.trim() === '' && attachments.length === 0

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

  const submit = () => {
    if (streaming || empty) {
      return
    }
    void send(text)
    setText('')
  }

  return (
    <div className="flex-none px-6 pb-6">
      <div className="mx-auto w-full max-w-2xl rounded-xl border border-border bg-surface focus-within:border-ring">
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3.5 pt-3">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="relative">
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="size-14 rounded-lg border border-border object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-surface text-text-muted hover:text-text"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
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
            <Button variant="ghost" size="sm" onClick={newChat}>
              <Plus aria-hidden data-icon="inline-start" />
              New chat
              {NEW_CHAT_BINDING ? (
                <ShortcutKeys binding={NEW_CHAT_BINDING} className="ml-1 text-text-muted" />
              ) : null}
            </Button>
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
