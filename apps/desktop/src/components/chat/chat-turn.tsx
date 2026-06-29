import type { ReactElement } from 'react'
import type { ChatTurn as ChatTurnModel } from '@reflect/core'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Marker, MarkerContent } from '@/components/ui/marker'
import { Message, MessageContent, MessageGroup } from '@/components/ui/message'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import { ChatAssistantPart } from './chat-assistant-part'
import { ChatUserAttachments } from './chat-user-attachments'

interface ChatTurnProps {
  turn: ChatTurnModel
}

/**
 * One conversation turn: the user's message and images render through
 * shadcn chat primitives, followed by assistant text, tool markers, and
 * notices in the order the engine produced them.
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
    <MessageGroup className="gap-6">
      <Message align="end">
        <MessageContent className="items-end gap-2">
          <ChatUserAttachments attachments={turn.attachments} />
          {turn.userText !== '' ? (
            <Bubble align="end" variant="muted" className="max-w-[85%]">
              <BubbleContent className="reflect-chat-message !bg-surface-hover px-4 py-2 leading-normal whitespace-pre-wrap !text-text">
                {turn.userText}
              </BubbleContent>
            </Bubble>
          ) : null}
        </MessageContent>
      </Message>

      <Message align="start">
        <MessageContent className="gap-2">
          {turn.parts.length === 0 && turn.status === 'streaming' ? (
            <Marker className="animate-pulse text-sm text-text-muted">
              <MarkerContent>Thinking…</MarkerContent>
            </Marker>
          ) : null}
          {turn.parts.map((part, index) => (
            <ChatAssistantPart
              key={index}
              index={index}
              lastIndex={lastIndex}
              part={part}
              status={turn.status}
              onWikiLinkClick={navigateWikiLink}
            />
          ))}
        </MessageContent>
      </Message>
    </MessageGroup>
  )
}
