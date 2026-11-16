import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type UserManifest } from 'wxt'
import { SAVE_CURRENT_PAGE_COMMAND } from './lib/commands.ts'
import { FIREFOX_ID, PUBLIC_KEY } from './lib/identity.ts'

/**
 * `pnpm zip` sets this to strip the forbidden `key` from the store artifact.
 * Every other build keeps the key so unpacked loads hold the pinned dev ID.
 */
const isStoreBuild = process.env['WXT_STORE_BUILD'] === 'true'

/** The manifest fields that pin the extension's identity in each browser. */
function identityFor(browser: string): UserManifest {
  if (browser === 'firefox') {
    return {
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ID,
          // 140 is the first release with built-in data-collection consent;
          // it is also past 128, which `world: 'MAIN'` content scripts need.
          strict_min_version: '140.0',
          // Firefox counts the hand-off to the local native host as
          // transmission outside the browser, so declare what a capture carries.
          data_collection_permissions: {
            required: ['websiteContent', 'browsingActivity', 'websiteActivity'],
          },
        },
      },
    }
  }

  // Unpacked dev/CI loads pin the ID; the store rejects `key`, so drop it
  // there. Safari ignores it: the containing app identifies the extension.
  return isStoreBuild || browser === 'safari' ? {} : { key: PUBLIC_KEY }
}

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Every module imports what it uses from its real `wxt/*` path.
  imports: false,
  vite: () => ({ plugins: [tailwindcss()] }),
  // Store artifact: `reflect-capture-<version>-chrome.zip`. The keyed build is
  // `reflect-capture-<version>-chrome-unpacked.zip` so the two never collide.
  zip: {
    name: 'reflect-capture',
    ...(isStoreBuild
      ? {}
      : { artifactTemplate: '{{name}}-{{packageVersion}}-{{browser}}-unpacked{{modeSuffix}}.zip' }),
  },
  // Firefox defaults to MV2 in WXT; ship the same MV3 manifest everywhere.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'Reflect Capture',
    description: 'Save the page you are reading into Reflect.',
    homepage_url: 'https://github.com/team-reflect/reflect-open',
    ...identityFor(browser),
    // `activeTab` (granted by the action click / shortcut) covers the
    // screenshot and the selection grab; `webRequest` on x.com only observes
    // bookmark and like requests.
    permissions: [
      'activeTab',
      'scripting',
      'nativeMessaging',
      'storage',
      'unlimitedStorage',
      'alarms',
      'webRequest',
    ],
    host_permissions: ['https://x.com/*'],
    commands: {
      [SAVE_CURRENT_PAGE_COMMAND]: {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Save the current page to Reflect',
      },
    },
  }),
})
