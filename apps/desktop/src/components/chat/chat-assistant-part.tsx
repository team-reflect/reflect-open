import type { ReactElement } from 'react'
import type { AssistantPart } from '@reflect/core'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Marker, MarkerContent } from '@/components/ui/marker'
import { MarkdownPreview } from '@/editor/markdown-preview'
import { cn } from '@/lib/utils'
import { ChatToolChip } from './chat-tool-chip'

interface ChatAssistantPartProps {
  part: AssistantPart
  onWikiLinkClick: (options: { target: string; openInNewWindow: boolean }) => void
}

/**
 * One assistant transcript part: live markdown, tool
 * activity, or a terminal notice.
 */
export function ChatAssistantPart({ part, onWikiLinkClick }: ChatAssistantPartProps): ReactElement {
  switch (part.kind) {
    case 'text':
      return (
        <Bubble variant="ghost" className="max-w-full">
          <BubbleContent className="max-w-full text-text">
            <MarkdownPreview
              content={part.text}
              onWikiLinkClick={onWikiLinkClick}
              className="reflect-chat-message text-sm"
            />
          </BubbleContent>
        </Bubble>
      )
    case 'tool':
      return <ChatToolChip part={part} />
    case 'notice':
      return (
        <Marker
          className={cn(
            'reflect-chat-message text-sm',
            part.tone === 'error' ? 'text-destructive' : 'text-text-muted italic',
          )}
        >
          <MarkerContent>{part.text}</MarkerContent>
        </Marker>
      )
  }
}
