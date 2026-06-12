import type { ChatAttachment } from '@reflect/core'
import { base64Of } from '@/lib/base64'

/**
 * Image attachments for the chat composer. A dropped or pasted photo is read
 * once into a {@link ChatAttachment} whose `data:` URL serves double duty —
 * it is the `<img src>` for the composer preview and the transcript bubble,
 * and the image payload the AI SDK sends to the provider. The type itself
 * lives in `@reflect/core` (it is part of the persisted conversation model);
 * this module owns only the browser side — reading `File`s into it.
 */

export type { ChatAttachment } from '@reflect/core'

/** The image files in a drop or paste payload; everything else is ignored. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) {
    return []
  }
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'))
}

/** Read an image file into an attachment, bytes inlined as a `data:` URL. */
export async function toChatAttachment(file: File): Promise<ChatAttachment> {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: file.type,
    dataUrl: `data:${file.type};base64,${base64Of(await file.arrayBuffer())}`,
  }
}
