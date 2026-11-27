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
  '0.20.0': [
    {
      id: 'recently-opened-notes-macos',
      title: 'Recently opened notes',
      body: 'Press ⌘K to see the notes you opened most recently.',
      platforms: ['darwin'],
    },
    {
      id: 'recently-opened-notes-windows-linux',
      title: 'Recently opened notes',
      body: 'Press Ctrl+K to see the notes you opened most recently.',
      platforms: ['windows', 'linux'],
    },
    {
      id: 'recently-opened-notes-ipad',
      title: 'Recently opened notes',
      body: 'On iPad, Quick Open shows the notes you opened most recently.',
      platforms: ['ios'],
    },
    {
      id: 'faster-note-switching',
      title: 'Faster note switching',
      body: 'Jump between notes without waiting. A note you return to is ready right away, with your edits in place.',
      platforms: ALL_PLATFORMS,
    },
    {
      id: 'faster-tasks-list',
      title: 'Faster Tasks list',
      body: 'The Tasks list scrolls smoothly, even with thousands of tasks.',
      platforms: ALL_PLATFORMS,
    },
    {
      id: 'print-note-macos',
      title: 'Print notes',
      body: 'Press ⌘P to print the current note.',
      platforms: ['darwin'],
    },
    {
      id: 'print-note-windows-linux',
      title: 'Print notes',
      body: 'Press Ctrl+P to print the current note.',
      platforms: ['windows', 'linux'],
    },
    {
      id: 'cli-tasks',
      title: 'Tasks in the CLI',
      body: 'Agents can now run `reflect tasks` to list your open tasks. Set it up in Settings → Agents.',
      platforms: ['darwin', 'windows', 'linux'],
    },
  ],
  '0.19.0': [
    {
      id: 'claude-fable-5-2',
      title: 'New AI models',
      body: 'New AI models: Claude Fable 5.2, Gemini 4 Hydrogen, and Gemini 4 Carbon.',
      platforms: ALL_PLATFORMS,
    },
    {
      id: 'liquid-glass',
      title: 'A fresh new look',
      body: 'A new Liquid Glass design for iPhone and iPad.',
      platforms: ['ios'],
    },
    {
      id: 'mobile-keyboard-shortcuts',
      title: 'Keyboard shortcuts on mobile',
      body: 'Desktop keyboard shortcuts now work with a hardware keyboard.',
      platforms: ['ios'],
    },
    {
      id: 'mobile-faster-sync',
      title: 'Faster sync on mobile',
      body: 'Your notes now sync faster across devices.',
      platforms: ['ios'],
    },
  ],
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
