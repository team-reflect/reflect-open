/**
 * Binary ⇄ base64 codecs for payloads that must cross a JSON boundary: the
 * base64 IPC fallback for hosts without a binary bridge, provider inline
 * uploads (Gemini `inline_data`), and recordings staged by the native mobile
 * recorder. Both directions are exact inverses; neither pads, wraps, or
 * accepts URL-safe variants — the peers on every path are our own encoders.
 */

/**
 * Encode in 32 KiB chunks: spreading a whole multi-megabyte payload into one
 * `String.fromCharCode` call overflows the JS engine's argument limit.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE))
  }
  return btoa(binary)
}

/** Decode {@link bytesToBase64}'s output (e.g. a stored recording read back). */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
