/**
 * Pins the Chromium extension ID (`dlbliojklpickgimjdmjjdnbjdiomjik`) for
 * **unpacked** loads — `wxt dev` and a `wxt build` loaded by hand — so it
 * matches the native-messaging host manifests the desktop app writes
 * (`crates/core/src/capture.rs`, `extension-ids.json`). The ID is the
 * SHA-256 of this public key; the private half is deliberately not kept.
 *
 * The Chrome Web Store is different: it **rejects** a `key` in the uploaded
 * package ("key field is not allowed in manifest") and mints its own permanent
 * ID for the listing: `ccabifmooehighoonjeiololjfofkhkd`. So the store
 * artifact must omit `key` (see `WXT_STORE_BUILD` in `wxt.config.ts`), while the desktop
 * native-messaging allowlist keeps both IDs.
 */
export const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7EMDbrG/PhZAaAz9GauuPizNI+98ua2aaI5yDgDEbXMk86Wm6LByEVD/ZVAJCa+Ic8xXeLw4GEDyNPPxM940eeoeDbU3KHWp1jl99WroEhMXFl1uYyXQ/0yFhZwIolDEt02uDCF+fDS93UMP8AJQKYxtLO2NH4wsv66gdRP1CEA82VUXiJV0R9b1BvIVVr8HJFHR4zmA9YsNbBTUQtkOGYuSz4mWrSZ7QKWP7RDdQcHFI6t9Y58+Bk8/4Ps1gmbGHPCWy5iURQ37m8ibPaVvrGOrAoS3n09E/4jP2OeCa2oM2gH3AcEz7T6daTdk+rzJ0VMbR4PNKLOiLYknxsigDQIDAQAB'

/**
 * The Firefox add-on ID. Firefox takes the ID from the manifest for temporary
 * loads and signed builds alike, so one value covers every install mode. The
 * desktop host manifest (`crates/core/src/capture.rs`, `extension-ids.json`)
 * must allowlist it.
 */
export const FIREFOX_ID = 'capture@reflect.app'
