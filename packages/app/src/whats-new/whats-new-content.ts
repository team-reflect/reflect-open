import type { BuildPlatform } from '@reflect/core'

/**
 * One user-facing change.
 */
export interface WhatsNewItem {
  readonly title: string
  readonly body: string
  readonly platforms: readonly BuildPlatform[]
}

const DESKTOP_AND_IOS: readonly BuildPlatform[] = ['darwin', 'windows', 'linux', 'ios']

/**
 * The menus item, with the shortcut hint that fits each platform.
 */
function menusItem(shortcut: string, platforms: readonly BuildPlatform[]): WhatsNewItem {
  return {
    title: 'Menus for code blocks, images, and embeds',
    body: `Code blocks, images, X posts, and YouTube videos now have a menu to copy, convert, or delete them. ${shortcut}`,
    platforms,
  }
}

/**
 * User-facing changes keyed by marketing version. A beta appends to its
 * marketing version's list, so each beta update shows everything so far.
 */
export const WHATS_NEW: Readonly<Record<string, readonly WhatsNewItem[]>> = {
  '0.18.0': [
    {
      title: 'Faster, smoother gestures',
      body: 'Swipes, sheets, and image dragging respond faster and move more smoothly.',
      platforms: ['ios'],
    },
    {
      title: 'New AI models',
      body: 'You can now choose GPT-6.1 Terra and Gemini Flash Lite Latest as your AI model.',
      platforms: DESKTOP_AND_IOS,
    },
    menusItem('Press ⌘/ to open it.', ['darwin']),
    menusItem('Press Ctrl+/ to open it.', ['windows', 'linux']),
    menusItem('With a keyboard, press ⌘/ to open it.', ['ios']),
  ],
}
