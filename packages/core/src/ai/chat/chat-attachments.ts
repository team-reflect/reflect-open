import type { IdService } from '../../ports/id-service.ts'
import type { ImageCodecService } from '../../ports/image-codec-service.ts'
import { bytesToBase64 } from '@reflect/utils'
import type { ChatAttachment } from './transcript.ts'

/**
 * Image attachments for the chat composer. A dropped, pasted, or picked photo
 * is read once into a {@link ChatAttachment} whose `data:` URL serves double
 * duty — it is the `<img src>` for the composer preview and the transcript
 * bubble, and the image payload the AI SDK sends to the provider.
 *
 * Oversized images are downscaled before they enter the attachment (Plan 23):
 * a camera photo re-encodes to a bounded JPEG instead of riding the provider
 * payload, the saved conversation row, and webview memory at full resolution.
 */

/**
 * Long-edge cap for attached images. Providers tile images at roughly this
 * scale anyway (Anthropic's documented ceiling is 1568px), so pixels beyond
 * it cost payload and memory without adding anything the model can see.
 */
const MAX_IMAGE_EDGE = 1568

const JPEG_QUALITY = 0.85

/**
 * Formats every provider accepts as-is; anything else gets re-encoded.
 */
const PROVIDER_SAFE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/**
 * Re-encode `file` to a JPEG within {@link MAX_IMAGE_EDGE}, or null when the
 * original bytes should be used: already small in a provider-safe format, no
 * decoder on this surface (jsdom, old webviews), or undecodable — sending the
 * original is then the honest fallback, and the provider's own error surfaces
 * in the transcript if it can't read it either.
 */
async function downscaledImage(
  imageCodec: ImageCodecService,
  file: File,
): Promise<{ dataUrl: string; mediaType: string } | null> {
  const image = await imageCodec.decode(file)
  if (image === null) {
    return null
  }
  try {
    const scale = Math.min(MAX_IMAGE_EDGE / Math.max(image.width, image.height, 1), 1)
    if (scale === 1 && PROVIDER_SAFE_TYPES.has(file.type)) {
      return null
    }
    const encoded = await image.encode({
      type: 'image/jpeg',
      quality: JPEG_QUALITY,
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale)),
    })
    if (encoded === null) {
      return null
    }
    return { dataUrl: await dataUrlOf(encoded), mediaType: 'image/jpeg' }
  } finally {
    image.close()
  }
}

async function dataUrlOf(blob: Blob): Promise<string> {
  return `data:${blob.type};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`
}

/**
 * Read an image file into an attachment, bytes inlined as a `data:` URL.
 */
export async function readChatAttachment(
  ctx: { imageCodec: ImageCodecService; id: IdService },
  file: File,
): Promise<ChatAttachment> {
  const downscaled = await downscaledImage(ctx.imageCodec, file)
  if (downscaled !== null) {
    return {
      id: ctx.id.uuid(),
      name: file.name,
      mediaType: downscaled.mediaType,
      dataUrl: downscaled.dataUrl,
    }
  }
  return {
    id: ctx.id.uuid(),
    name: file.name,
    mediaType: file.type,
    dataUrl: await dataUrlOf(file),
  }
}
