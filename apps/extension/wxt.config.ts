import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'
import { SAVE_CURRENT_PAGE_COMMAND } from './lib/commands'

/**
 * Pins the extension ID (`dlbliojklpickgimjdmjjdnbjdiomjik`) for unpacked dev
 * builds AND the Chrome Web Store: the ID is the SHA-256 of this public key,
 * and the store keeps a `key`-pinned ID on first upload. The matching private
 * key is deliberately not kept — the store re-signs uploads, so only the
 * public half matters. The native-messaging host manifests written by the
 * desktop app (`src-tauri/src/capture.rs`, `EXTENSION_ORIGINS`) allowlist
 * this ID; the two must move together.
 */
const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7EMDbrG/PhZAaAz9GauuPizNI+98ua2aaI5yDgDEbXMk86Wm6LByEVD/ZVAJCa+Ic8xXeLw4GEDyNPPxM940eeoeDbU3KHWp1jl99WroEhMXFl1uYyXQ/0yFhZwIolDEt02uDCF+fDS93UMP8AJQKYxtLO2NH4wsv66gdRP1CEA82VUXiJV0R9b1BvIVVr8HJFHR4zmA9YsNbBTUQtkOGYuSz4mWrSZ7QKWP7RDdQcHFI6t9Y58+Bk8/4Ps1gmbGHPCWy5iURQ37m8ibPaVvrGOrAoS3n09E/4jP2OeCa2oM2gH3AcEz7T6daTdk+rzJ0VMbR4PNKLOiLYknxsigDQIDAQAB'

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  // A stable, human-readable store artifact: `reflect-capture-<version>-chrome.zip`.
  zip: { name: 'reflect-capture' },
  manifest: {
    name: 'Reflect Capture',
    description: 'Save the page you are reading into Reflect.',
    homepage_url: 'https://github.com/team-reflect/reflect-open',
    key: PUBLIC_KEY,
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
    commands: {
      [SAVE_CURRENT_PAGE_COMMAND]: {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Save the current page to Reflect',
      },
    },
  },
})
