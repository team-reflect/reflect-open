import type { ReactElement } from 'react'
import type { ChatAttachment } from '@reflect/core'
import {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
} from '@/components/ui/attachment'

interface ChatUserAttachmentsProps {
  attachments: readonly ChatAttachment[]
}

/**
 * Image attachments shown above a user's chat bubble after the turn is sent.
 */
export function ChatUserAttachments({
  attachments,
}: ChatUserAttachmentsProps): ReactElement | null {
  if (attachments.length === 0) {
    return null
  }

  return (
    <AttachmentGroup className="justify-end gap-2 overflow-visible py-0">
      {attachments.map((attachment) => (
        <Attachment
          key={attachment.id}
          className="min-w-0 border-none bg-transparent p-0"
          orientation="horizontal"
          size="default"
        >
          <AttachmentMedia className="aspect-auto h-auto max-h-48 w-auto max-w-full rounded-xl bg-transparent">
            <img
              src={attachment.dataUrl}
              alt={attachment.name}
              className="max-h-48 max-w-full rounded-xl object-contain"
            />
          </AttachmentMedia>
        </Attachment>
      ))}
    </AttachmentGroup>
  )
}
