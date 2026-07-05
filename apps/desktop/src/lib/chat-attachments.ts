import type { ChatAttachment } from '@reflect/core'
import { base64Of } from '@/lib/base64'

/**
 * Image attachments for the chat composer. A dropped, pasted, or picked photo
 * is read once into a {@link ChatAttachment} whose `data:` URL serves double
 * duty — it is the `<img src>` for the composer preview and the transcript
 * bubble, and the image payload the AI SDK sends to the provider. The type
 * itself lives in `@reflect/core` (it is part of the persisted conversation
 * model); this module owns only the browser side — reading `File`s into it.
 *
 * Oversized images are downscaled before they enter the attachment (Plan 23):
 * a camera photo re-encodes to a bounded JPEG instead of riding the provider
 * payload, the saved conversation row, and webview memory at full resolution.
 */

export type { ChatAttachment } from '@reflect/core'

/**
 * Long-edge cap for attached images. Providers tile images at roughly this
 * scale anyway (Anthropic's documented ceiling is 1568px), so pixels beyond
 * it cost payload and memory without adding anything the model can see.
 */
const MAX_IMAGE_EDGE = 1568

const JPEG_QUALITY = 0.85

/** Formats every provider accepts as-is; anything else gets re-encoded. */
const PROVIDER_SAFE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** The image files in a drop or paste payload; everything else is ignored. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) {
    return []
  }
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'))
}

/**
 * Re-encode `file` to a JPEG within {@link MAX_IMAGE_EDGE}, or null when the
 * original bytes should be used: already small in a provider-safe format, no
 * decoder on this surface (jsdom, old webviews), or undecodable — sending the
 * original is then the honest fallback, and the provider's own error surfaces
 * in the transcript if it can't read it either.
 */
async function downscaledImage(file: File): Promise<{ dataUrl: string; mediaType: string } | null> {
  if (typeof createImageBitmap !== 'function') {
    return null
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  try {
    const scale = Math.min(MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height, 1), 1)
    if (scale === 1 && PROVIDER_SAFE_TYPES.has(file.type)) {
      return null
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (context === null) {
      return null
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), mediaType: 'image/jpeg' }
  } finally {
    bitmap.close()
  }
}

/** Read an image file into an attachment, bytes inlined as a `data:` URL. */
export async function toChatAttachment(file: File): Promise<ChatAttachment> {
  const downscaled = await downscaledImage(file)
  if (downscaled !== null) {
    return {
      id: crypto.randomUUID(),
      name: file.name,
      mediaType: downscaled.mediaType,
      dataUrl: downscaled.dataUrl,
    }
  }
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: file.type,
    dataUrl: `data:${file.type};base64,${base64Of(await file.arrayBuffer())}`,
  }
}
