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

/** Decode a standard Base64 string into bytes. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** Return the decoded byte length of standard Base64 without whitespace. Does not validate the input. */
export function base64ByteLength(base64: string): number {
  const length = base64.length
  if (length === 0) {
    return 0
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((length * 3) / 4) - padding
}

/** Decode Base64 as UTF-8, replacing invalid UTF-8 sequences. */
export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64))
}
