import type { ReactElement } from 'react'
import { MarkdownPreview } from '@/editor/markdown-preview'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import type { ChatTurn as ChatTurnModel } from '@reflect/core'
import { cn } from '@/lib/utils'
import { ChatToolChip } from './chat-tool-chip'

interface ChatTurnProps {
  turn: ChatTurnModel
}

/**
 * One conversation turn: the user's message as a compact right-aligned
 * bubble — attached images above the text, which a photo-only message
 * omits — then the assistant's parts in order: text interleaved with the
 * tool activity that grounded it.
 *
 * Text still streaming renders as plain text; once it settles it re-renders
 * through the same read-only markdown preview the palette uses (so
 * `[[citations]]` appear as the editor's wiki-link chips and click through
 * to the note). Live markdown would re-parse the whole message through a
 * ProseMirror editor on every delta — quadratic work the reader can feel.
 *
 * Wiki navigation passes a null generation deliberately: a clicked citation
 * that doesn't resolve must never *create* a note the model hallucinated.
 */
export function ChatTurn({ turn }: ChatTurnProps): ReactElement {
  const navigateWikiLink = useWikiLinkNavigation(null)
  const lastIndex = turn.parts.length - 1

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <div className="flex max-w-[85%] flex-col items-end gap-2">
          {turn.attachments.map((attachment) => (
            <img
              key={attachment.id}
              src={attachment.dataUrl}
              alt={attachment.name}
              className="max-h-48 max-w-full rounded-2xl"
            />
          ))}
          {turn.userText !== '' ? (
            <div className="rounded-2xl bg-surface-hover px-4 py-2 text-sm whitespace-pre-wrap text-text">
              {turn.userText}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {turn.parts.length === 0 && turn.status === 'streaming' ? (
          <span className="animate-pulse text-sm text-text-muted">Thinking…</span>
        ) : null}
        {turn.parts.map((part, index) => {
          switch (part.kind) {
            case 'text':
              return turn.status === 'streaming' && index === lastIndex ? (
                <div key={index} className="text-sm whitespace-pre-wrap text-text">
                  {part.text}
                </div>
              ) : (
                <MarkdownPreview
                  key={index}
                  content={part.text}
                  onWikiLinkClick={navigateWikiLink}
                  className="text-sm"
                />
              )
            case 'tool':
              return <ChatToolChip key={index} part={part} />
            case 'notice':
              return (
                <p
                  key={index}
                  className={cn(
                    'text-sm',
                    part.tone === 'error' ? 'text-destructive' : 'text-text-muted italic',
                  )}
                >
                  {part.text}
                </p>
              )
          }
        })}
      </div>
    </div>
  )
}
