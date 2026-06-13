import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Drift guard for the pinned extension identity. The manifest `key` in
 * `wxt.config.ts` determines the extension ID everywhere (unpacked dev, CI,
 * the Chrome Web Store), and the desktop app's native-messaging manifests
 * (`apps/desktop/src-tauri/src/capture.rs`, `EXTENSION_ORIGINS`) must
 * allowlist exactly that ID — they are coupled only by convention, so this
 * test recomputes the derivation (SHA-256 of the DER key, first 16 bytes,
 * hex mapped onto a–p) and pins the two files together.
 */

const here = resolve(import.meta.dirname)

function extensionIdFromKey(base64Key: string): string {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex')
  return [...digest.slice(0, 32)]
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + parseInt(nibble, 16)))
    .join('')
}

describe('pinned extension identity', () => {
  it('the manifest key derives the ID the desktop host manifests allowlist', () => {
    const wxtConfig = readFileSync(resolve(here, 'wxt.config.ts'), 'utf8')
    const keyMatch = /const PUBLIC_KEY =\s*'([A-Za-z0-9+/=]+)'/.exec(wxtConfig)
    expect(keyMatch, 'PUBLIC_KEY not found in wxt.config.ts').not.toBeNull()

    const captureRs = readFileSync(
      resolve(here, '../desktop/src-tauri/src/capture.rs'),
      'utf8',
    )
    const originMatches = [...captureRs.matchAll(/chrome-extension:\/\/([a-p]{32})\//g)].map(
      (match) => match[1],
    )
    expect(originMatches.length, 'no extension origins found in capture.rs').toBeGreaterThan(0)

    // The dev/unpacked ID derived from the committed key must be among the
    // allowlisted origins (the store ID joins the list after first publish).
    expect(originMatches).toContain(extensionIdFromKey(keyMatch![1]))
  })
})
