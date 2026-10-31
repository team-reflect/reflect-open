/**
 * Image attachments for the chat composer. A dropped, pasted, or picked photo
 * is read once into a {@link ChatAttachment} whose `data:` URL serves double
 * duty — it is the `<img src>` for the composer preview and the transcript
 * bubble, and the image payload the AI SDK sends to the provider. The type
 * itself lives in `@reflect/core` (it is part of the persisted conversation
 * model), and so does reading a `File` into it (`readChatAttachment`, which
 * downscales oversized images); this module owns only the DOM side.
 */

/** The image files in a drop or paste payload; everything else is ignored. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) {
    return []
  }
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'))
}
