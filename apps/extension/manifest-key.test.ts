import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import extensionIds from './extension-ids.json'
import { FIREFOX_ID, PUBLIC_KEY } from './lib/identity.ts'
import config from './wxt.config.ts'

/**
 * Drift guard for the pinned extension identity. The manifest `key` in
 * `wxt.config.ts` determines the Chromium extension ID everywhere (unpacked
 * dev, CI, but not the Chrome Web Store), and Firefox reads its ID straight
 * from `FIREFOX_ID`. The desktop app writes native-messaging manifests that
 * allowlist the IDs in `extension-ids.json` (embedded by
 * `crates/core/src/capture.rs`), so this test recomputes the Chromium
 * derivation (SHA-256 of the DER key, first 16 bytes, hex mapped onto a-p) and
 * checks both browsers' IDs are on that list.
 */

function extensionIdFromKey(base64Key: string): string {
  const digest = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex')
  return [...digest.slice(0, 32)]
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + parseInt(nibble, 16)))
    .join('')
}

function manifestFor(browser: string): Record<string, unknown> {
  const { manifest } = config
  if (typeof manifest !== 'function')
    throw new TypeError('wxt.config.ts manifest must be a function')
  return manifest({ browser, mode: 'production', command: 'build', manifestVersion: 3 }) as Record<
    string,
    unknown
  >
}

describe('pinned extension identity', () => {
  it('the manifest key derives the ID the desktop host manifests allowlist', () => {
    // The dev/unpacked ID derived from the committed key must stay among the
    // allowlisted IDs even though the Chrome Web Store listing has its own ID.
    expect(manifestFor('chrome')['key']).toBe(PUBLIC_KEY)
    expect(extensionIds.chromium).toContain(extensionIdFromKey(PUBLIC_KEY))
  })

  it('the Firefox manifest carries the add-on ID the desktop host manifests allowlist', () => {
    expect(manifestFor('firefox')).toMatchObject({
      browser_specific_settings: { gecko: { id: FIREFOX_ID } },
    })

    expect(extensionIds.firefox).toContain(FIREFOX_ID)
  })
})
