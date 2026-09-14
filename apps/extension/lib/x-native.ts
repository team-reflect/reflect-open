import { browser } from 'wxt/browser'
import { z } from 'zod'
import { CAPTURE_MESSAGE_MAX_BYTES, type ArchiveRequest } from '@reflect/core/x-archive'
import { HOST_NAME } from './native'
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown(), binding: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export async function sendArchiveMessage(request: ArchiveRequest) {
  const message = { version: 2, ...request }
  // FIXME: self-imposed 512 KB limit; the host already accepts 64 MiB frames (protocol.rs). See
  // x-download.ts.
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > CAPTURE_MESSAGE_MAX_BYTES) {
    throw new Error('payload-too-large')
  }
  const response = responseSchema.parse(await browser.runtime.sendNativeMessage(HOST_NAME, message))
  if (!response.ok) throw new Error(response.error)
  return response
}
