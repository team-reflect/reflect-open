import { useState, type ReactElement } from 'react'
import { aiModelLabel, aiProvider } from '@reflect/core'
import { ArrowUp, Plus, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useChatSession } from '@/providers/chat-provider'

/**
 * The composer: a textarea (Enter sends, Shift-Enter breaks, Esc stops a
 * streaming turn), the session's model picker, and a send button that turns
 * into stop while a turn streams. "New chat" appears once there's a
 * conversation to clear.
 */
export function ChatInput(): ReactElement {
  const { turns, status, models, activeModel, selectModel, send, stop, newChat } = useChatSession()
  const [text, setText] = useState('')
  const streaming = status === 'streaming'

  const submit = () => {
    if (streaming || text.trim() === '') {
      return
    }
    void send(text)
    setText('')
  }

  return (
    <div className="flex-none px-6 pb-6">
      <div className="mx-auto w-full max-w-2xl rounded-xl border border-border bg-surface focus-within:border-ring">
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
          placeholder="Ask about your notes…"
          aria-label="Chat message"
          rows={2}
          autoFocus
          className="field-sizing-content max-h-48 w-full resize-none bg-transparent px-3.5 pt-3 text-sm text-text outline-none placeholder:text-text-muted"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          <Select value={activeModel?.id ?? ''} onValueChange={(id) => selectModel(id)}>
            <SelectTrigger
              aria-label="Model"
              size="sm"
              className="w-auto max-w-64 border-none bg-transparent text-xs text-text-muted shadow-none"
            >
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {/* Provider-qualified: the same model id can be configured
                      under two providers and must stay tellable apart. */}
                  {aiProvider(model.provider).label} · {aiModelLabel(model.provider, model.model)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1" />
          {turns.length > 0 && !streaming ? (
            <Button variant="ghost" size="sm" onClick={newChat}>
              <Plus aria-hidden data-icon="inline-start" />
              New chat
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
              disabled={text.trim() === '' || activeModel === null}
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
