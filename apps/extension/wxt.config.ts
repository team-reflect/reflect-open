import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'
import { SAVE_CURRENT_PAGE_COMMAND } from './lib/commands.ts'
import { X_ORIGINS } from './lib/x/origins.ts'

/**
 * Pins the extension ID (`dlbliojklpickgimjdmjjdnbjdiomjik`) for **unpacked**
 * loads — `wxt dev` and a `wxt build` loaded by hand — so it matches the
 * native-messaging host manifests the desktop app writes
 * (`src-tauri/src/capture.rs`, `EXTENSION_ORIGINS`). The ID is the SHA-256 of
 * this public key; the private half is deliberately not kept.
 *
 * The Chrome Web Store is different: it **rejects** a `key` in the uploaded
 * package ("key field is not allowed in manifest") and mints its own permanent
 * ID for the listing: `ccabifmooehighoonjeiololjfofkhkd`. So the store
 * artifact must omit `key` (see `WXT_STORE_BUILD` below), while the desktop
 * native-messaging allowlist keeps both IDs.
 */
const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7EMDbrG/PhZAaAz9GauuPizNI+98ua2aaI5yDgDEbXMk86Wm6LByEVD/ZVAJCa+Ic8xXeLw4GEDyNPPxM940eeoeDbU3KHWp1jl99WroEhMXFl1uYyXQ/0yFhZwIolDEt02uDCF+fDS93UMP8AJQKYxtLO2NH4wsv66gdRP1CEA82VUXiJV0R9b1BvIVVr8HJFHR4zmA9YsNbBTUQtkOGYuSz4mWrSZ7QKWP7RDdQcHFI6t9Y58+Bk8/4Ps1gmbGHPCWy5iURQ37m8ibPaVvrGOrAoS3n09E/4jP2OeCa2oM2gH3AcEz7T6daTdk+rzJ0VMbR4PNKLOiLYknxsigDQIDAQAB'

/**
 * `pnpm zip` sets this to strip the forbidden `key` from the store artifact.
 * Every other build keeps the key so unpacked loads hold the pinned dev ID.
 */
const isStoreBuild = process.env['WXT_STORE_BUILD'] === 'true'

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  hooks: {
    // WXT lifts a runtime-registered content script's `matches` into
    // `host_permissions`, which would make the X origins an install-time
    // grant. They must stay optional: nothing runs on x.com until the user
    // switches the feature on and Chrome's prompt is accepted.
    'build:manifestGenerated': (_wxt, manifest) => {
      const optional = new Set<string>(X_ORIGINS)
      const lifted: unknown = manifest.host_permissions
      const kept = Array.isArray(lifted)
        ? lifted.filter(
            (origin): origin is string => typeof origin === 'string' && !optional.has(origin),
          )
        : []
      if (kept.length > 0) {
        manifest.host_permissions = kept
      } else {
        delete manifest.host_permissions
      }
    },
  },
  // A stable, human-readable store artifact: `reflect-capture-<version>-chrome.zip`.
  zip: { name: 'reflect-capture' },
  manifest: {
    name: 'Reflect Capture',
    description: 'Save the page you are reading into Reflect.',
    homepage_url: 'https://github.com/team-reflect/reflect-open',
    // Unpacked dev/CI loads pin the ID; the store rejects `key`, so drop it there.
    ...(isStoreBuild ? {} : { key: PUBLIC_KEY }),
    // `activeTab` (granted by the action click / shortcut) covers the
    // screenshot and the selection grab — no broad host permissions.
    permissions: [
      'activeTab',
      'scripting',
      'nativeMessaging',
      'storage',
      'unlimitedStorage',
      'alarms',
    ],
    // X bookmark capture (Plan 25) is opt-in: the origins are requested from
    // the options page / popup when the user switches it on, and the content
    // script is registered at runtime only then (`lib/x/registration.ts`).
    optional_host_permissions: [...X_ORIGINS],
    commands: {
      [SAVE_CURRENT_PAGE_COMMAND]: {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Save the current page to Reflect',
      },
    },
  },
})
