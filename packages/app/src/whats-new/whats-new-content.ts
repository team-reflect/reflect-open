import type { BuildPlatform } from '@reflect/core'

/**
 * One user-facing change.
 */
export interface WhatsNewItem {
  /**
   * Stays the same for the life of the item. Change it to show the item again.
   */
  readonly id: string
  readonly title: string
  readonly body: string
  readonly platforms: readonly BuildPlatform[]
}

const ALL_PLATFORMS: readonly BuildPlatform[] = ['darwin', 'windows', 'linux', 'ios', 'android']

const MENUS_TITLE = 'Menus for code blocks, images, and embeds'
const MENUS_BODY =
  'Code blocks, images, X posts, and YouTube videos now have a menu to copy, convert, or delete them.'

/**
 * User-facing changes keyed by marketing version. A beta appends to its
 * marketing version's list, and each update shows only the items not seen yet.
 */
export const WHATS_NEW: Readonly<Record<string, readonly WhatsNewItem[]>> = {
  '0.18.0': [
    {
      id: 'smoother-gestures',
      title: 'Faster, smoother gestures',
      body: 'Swipes, sheets, and image dragging respond faster and move more smoothly.',
      platforms: ['ios'],
    },
    {
      id: 'gpt-6-1-terra',
      title: 'New AI models',
      body: 'You can now choose GPT-6.1 Terra and Gemini Flash Lite Latest as your AI model.',
      platforms: ALL_PLATFORMS,
    },
    {
      id: 'mermaid-all-types',
      title: 'Every Mermaid diagram type',
      body: 'Mind maps, pie charts, Gantt charts, timelines, Sankey diagrams, and all other Mermaid diagram types now render in your notes.',
      platforms: ALL_PLATFORMS,
    },
    {
      id: 'quick-note-parent',
      title: 'Choose where quick notes go',
      body: 'Notes from Siri, Shortcuts, and the Action button can now go under a bullet of your choice in today’s note. Set it in Settings under Quick notes.',
      platforms: ['ios'],
    },
    {
      id: 'ipad-trackpad-scroll',
      title: 'Trackpad scrolling on iPad',
      body: 'On an iPad in landscape, two-finger trackpad scrolling now moves notes in the right direction.',
      platforms: ['ios'],
    },
    {
      id: 'node-menus-macos',
      title: MENUS_TITLE,
      body: `${MENUS_BODY} Press ⌘/ to open it.`,
      platforms: ['darwin'],
    },
    {
      id: 'node-menus-windows-linux',
      title: MENUS_TITLE,
      body: `${MENUS_BODY} Press Ctrl+/ to open it.`,
      platforms: ['windows', 'linux'],
    },
    {
      id: 'node-menus-ios',
      title: MENUS_TITLE,
      body: `${MENUS_BODY} With a keyboard, press ⌘/ to open it.`,
      platforms: ['ios'],
    },
    {
      id: 'safari-capture',
      title: 'Save pages from Safari',
      body: 'Turn on Reflect Capture in Safari Settings to save pages to your daily note.',
      platforms: ['darwin'],
    },
  ],
}
