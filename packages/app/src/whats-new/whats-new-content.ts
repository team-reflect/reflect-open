import type { AppPlatform } from '@reflect/core'

/**
 * One user-facing change.
 */
export interface WhatsNewItem {
  readonly title: string
  readonly body: string
  readonly platforms: readonly AppPlatform[]
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
      platforms: ['desktop', 'ios'],
    },

    // FIXME: Only show one item from all informattion below in the app. Use different text based on: whether you have keyboard and which platform you're using
    {
      title: 'Code block menu',
      body: 'Code blocks now have a menu to change the language, copy the code, or delete the block.',
      platforms: ['desktop', 'ios'],
    },
    {
      title: 'Image and embed menus',
      body: 'Images, X posts, and YouTube videos now have a menu. Copy the link, turn a card back into a link, or delete it.',
      platforms: ['desktop', 'ios'],
    },
    {
      title: 'Open menus from the keyboard',
      body: 'Press ⌘/ (Ctrl+/ on Windows) to open the menu of the selected image, embed, or code block.',
      platforms: ['desktop'], // FIXME: show different keyboard shortcut based on the BuildPlatform
    },
  ],
}
