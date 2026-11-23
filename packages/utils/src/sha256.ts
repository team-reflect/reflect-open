import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/**
 * Lowercase hex SHA-256 of the UTF-8 bytes of `text`.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Lowercase hex SHA-256 of the UTF-8 bytes of `text`, computed synchronously.
 */
export function sha256HexSync(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)))
}
