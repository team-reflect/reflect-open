/**
 * The id of an open-pinned-note command: `pinned.open1` opens the top of the
 * Pinned shelf.
 */
export type PinnedNoteCommandId = 'pinned.open1' | 'pinned.open2' | 'pinned.open3' | 'pinned.open4'

const pinnedKeywords = ['pinned', 'pin', 'shelf', 'favorite'] as const

/**
 * ⌘6–⌘9: open the top four pinned notes, in shelf order. The number row is
 * shared: ⌘1–⌘5 switch graphs. Few people keep more than five graphs, so
 * the high digits buy more as one-keystroke access to the Pinned shelf.
 */
export const PINNED_NOTE_COMMANDS = {
  'pinned.open1': { title: 'Open pinned note 1', keywords: pinnedKeywords, keybinding: 'Mod-6' },
  'pinned.open2': { title: 'Open pinned note 2', keywords: pinnedKeywords, keybinding: 'Mod-7' },
  'pinned.open3': { title: 'Open pinned note 3', keywords: pinnedKeywords, keybinding: 'Mod-8' },
  'pinned.open4': { title: 'Open pinned note 4', keywords: pinnedKeywords, keybinding: 'Mod-9' },
} as const satisfies Readonly<Record<PinnedNoteCommandId, unknown>>
// (`APP_COMMANDS` spreads these in and checks their shape.)

/**
 * The open-pinned-note command ids, top of the shelf first.
 */
export const PINNED_NOTE_COMMAND_IDS = Object.keys(PINNED_NOTE_COMMANDS) as PinnedNoteCommandId[]
