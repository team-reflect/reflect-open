import type { NoteCreationService } from '@reflect/core'
import type { Route } from '../navigation/route.ts'

/**
 * The 1-based position of a recent graph that a `graph.switch` command opens.
 */
export type GraphSwitchPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/**
 * Every {@link GraphSwitchPosition}, in order.
 */
export const GRAPH_SWITCH_POSITIONS: readonly GraphSwitchPosition[] = [1, 2, 3, 4, 5, 6, 7, 8, 9]

/**
 * The handler signature of every app command, by id. A window registers the
 * handlers it supports with `CommandService.handle`; a command without a
 * handler in the current window does nothing.
 *
 * A command with no parameters can have a {@link Command} declaration, which
 * puts it in the palette, the native menu, and the keybindings. A command with
 * parameters is only reachable through `CommandService.run`.
 */
export interface AppCommands extends Record<
  `graph.switch${GraphSwitchPosition}`,
  () => Promise<void>
> {
  readonly 'nav.today': () => void
  readonly 'nav.allNotes': () => void
  readonly 'nav.tasks': () => void
  readonly 'note.new': () => void
  /**
   * Open the focused note in its own window.
   */
  readonly 'note.openInNewWindow': () => Promise<void>
  /**
   * Open Find for the focused note.
   */
  readonly 'note.find': () => void
  /**
   * Advance the active or most recently closed note Find query.
   */
  readonly 'note.findNext': () => void
  /**
   * Move backward through the active or most recently closed note Find query.
   */
  readonly 'note.findPrevious': () => void
  readonly 'chat.open': () => void
  /**
   * Start a fresh chat conversation.
   */
  readonly 'chat.new': () => void
  readonly 'history.back': () => void
  readonly 'history.forward': () => void
  readonly 'palette.open': () => void
  /**
   * Flip the `pinned` frontmatter flag of the focused note.
   */
  readonly 'note.togglePin': () => Promise<void>
  /**
   * Flip the `private` frontmatter flag of the focused note: the hard block
   * on sending its content to AI or any other external service.
   */
  readonly 'note.togglePrivate': () => Promise<void>
  /**
   * Publish the focused note to a secret GitHub gist and copy the link.
   */
  readonly 'note.publishGist': () => Promise<void>
  /**
   * Pick files and attach them at the caret of the focused note.
   */
  readonly 'note.attachFile': () => Promise<void>
  /**
   * Copy the `reflect://` address of the focused note.
   */
  readonly 'note.copyDeepLink': () => Promise<void>
  /**
   * Copy the absolute file path of the focused note.
   */
  readonly 'note.copyPath': () => Promise<void>
  readonly 'note.random': () => Promise<void>
  /**
   * Open the "Insert template…" picker for the focused note.
   */
  readonly 'template.insert': () => void
  /**
   * Open the "New template" name dialog.
   */
  readonly 'template.new': () => void
  /**
   * Start an audio memo, or stop and save the one recording.
   */
  readonly 'audioMemo.toggle': () => void
  readonly 'theme.toggle': () => void
  /**
   * Collapse or expand the workspace and contextual sidebars.
   */
  readonly 'sidebar.toggle': () => void
  readonly 'settings.open': () => void
  readonly 'whatsNew.show': () => void
  /**
   * Open the shortcuts cheat-sheet, or close it when it is open.
   */
  readonly 'shortcuts.show': () => void
  /**
   * Persist the semantic-search opt-in and retry a failed model load.
   */
  readonly 'semantic.enable': () => void
  readonly 'index.rebuild': () => Promise<void>
  readonly 'dev.toggleDevtools': () => Promise<void>
}

/**
 * The id of an app command.
 */
export type AppCommandId = keyof AppCommands

/**
 * The id of an app command that takes no arguments, so that a key, a menu
 * item, or a palette row can run it.
 */
export type TriggerableCommandId = {
  [Id in AppCommandId]: Parameters<AppCommands[Id]> extends [] ? Id : never
}[AppCommandId]

/**
 * How the palette, the native menu, and the keybindings present a command.
 */
export interface Command {
  /**
   * Stable id, e.g. `nav.today`.
   */
  readonly id: TriggerableCommandId
  /**
   * Palette display title.
   */
  readonly title: string
  /**
   * Extra match terms for palette filtering.
   */
  readonly keywords?: readonly string[]
  /**
   * Keymap-registry binding (app scope), e.g. `Mod-d`.
   */
  readonly keybinding?: string
}

/**
 * A list of command declarations.
 */
export type Commands = readonly Command[]

/**
 * A fresh note route; the file itself is created lazily on the first keystroke
 * (the same contract as daily notes). Shared by ⌘N and the All Notes screen's
 * New note button so "what a new note is" stays one definition.
 */
export function newNoteRoute(noteCreation: NoteCreationService): Route {
  return { kind: 'note', path: noteCreation.untitledNotePath() }
}

/**
 * Whether `position` has a `graph.switch` command.
 */
export function isGraphSwitchPosition(position: number): position is GraphSwitchPosition {
  return Number.isSafeInteger(position) && position >= 1 && position <= 9
}

function declareSwitchGraphCommand(position: GraphSwitchPosition): Command {
  return {
    id: `graph.switch${position}`,
    title: `Switch to graph ${position}`,
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: `Mod-${position}`,
  }
}

/**
 * The declarations of the app commands, in palette order.
 */
export const APP_COMMANDS: Commands = [
  ...GRAPH_SWITCH_POSITIONS.map(declareSwitchGraphCommand),
  { id: 'nav.today', title: 'Go to today', keywords: ['daily', 'now'], keybinding: 'Mod-d' },
  {
    id: 'nav.allNotes',
    title: 'All notes',
    keywords: ['notes', 'list', 'browse', 'library'],
    keybinding: 'Mod-Shift-a',
  },
  {
    id: 'nav.tasks',
    title: 'Tasks',
    keywords: ['todo', 'todos', 'checklist', 'checkbox', 'open'],
    keybinding: 'Mod-t',
  },
  { id: 'note.new', title: 'New note', keywords: ['create'], keybinding: 'Mod-n' },
  {
    id: 'note.openInNewWindow',
    title: 'Open note in new window',
    keywords: ['window', 'duplicate', 'pop out'],
    keybinding: 'Mod-Shift-o',
  },
  {
    id: 'note.find',
    title: 'Find in note…',
    keywords: ['search', 'text', 'page'],
    keybinding: 'Mod-f',
  },
  {
    id: 'note.findNext',
    title: 'Find next',
    keywords: ['search', 'match', 'forward'],
    keybinding: 'Mod-g',
  },
  {
    id: 'note.findPrevious',
    title: 'Find previous',
    keywords: ['search', 'match', 'backward'],
    keybinding: 'Mod-Shift-g',
  },
  {
    id: 'chat.open',
    title: 'Chat',
    keywords: ['ai', 'assistant', 'copilot', 'ask'],
    keybinding: 'Mod-j',
  },
  {
    id: 'chat.new',
    title: 'New chat',
    keywords: ['ai', 'assistant', 'copilot', 'conversation'],
    keybinding: 'Mod-Shift-n',
  },
  { id: 'history.back', title: 'Back', keybinding: 'Mod-[' },
  { id: 'history.forward', title: 'Forward', keybinding: 'Mod-]' },
  { id: 'palette.open', title: 'Search…', keywords: ['find', 'open'], keybinding: 'Mod-k' },
  {
    id: 'note.togglePin',
    title: 'Pin or unpin note',
    keywords: ['pinned', 'favorite', 'bookmark', 'sidebar'],
    // The original app's pin shortcut.
    keybinding: 'Mod-o',
  },
  // No default keybinding for the next three: the palette keeps them
  // keyboard-reachable without spending a shortcut.
  {
    id: 'note.togglePrivate',
    title: 'Mark or un-mark note as private',
    keywords: ['privacy', 'lock', 'secret', 'hide', 'ai'],
  },
  {
    id: 'note.publishGist',
    title: 'Share with private link',
    keywords: ['gist', 'github', 'share', 'publish', 'private link', 'export'],
  },
  {
    id: 'note.attachFile',
    title: 'Attach file…',
    keywords: ['upload', 'attachment', 'import', 'pdf', 'document', 'insert'],
  },
  {
    id: 'note.copyDeepLink',
    title: 'Copy deep link',
    keywords: ['url', 'share', 'clipboard', 'reflect://', 'address'],
    // The original app's copy-link shortcut.
    keybinding: 'Alt-Mod-l',
  },
  {
    id: 'note.copyPath',
    title: 'Copy note path',
    keywords: ['file', 'absolute', 'filesystem', 'clipboard', 'location'],
    // Finder's Copy-as-Pathname chord.
    keybinding: 'Alt-Mod-c',
  },
  { id: 'note.random', title: 'Open random note', keywords: ['shuffle', 'serendipity'] },
  {
    id: 'template.insert',
    title: 'Insert template…',
    keywords: ['snippet', 'boilerplate', 'stamp'],
  },
  {
    id: 'template.new',
    title: 'New template',
    keywords: ['template', 'snippet', 'boilerplate', 'create'],
  },
  {
    id: 'audioMemo.toggle',
    title: 'Record audio memo',
    keywords: ['voice', 'mic', 'dictate', 'transcribe', 'speech', 'capture'],
    keybinding: 'Mod-Shift-r',
  },
  { id: 'theme.toggle', title: 'Toggle theme', keywords: ['dark', 'light', 'appearance'] },
  {
    id: 'sidebar.toggle',
    title: 'Toggle sidebar',
    keywords: ['collapse', 'expand', 'navigation', 'focus'],
    keybinding: 'Mod-\\',
  },
  {
    id: 'settings.open',
    title: 'Open settings',
    keywords: ['preferences', 'config', 'options'],
    keybinding: 'Mod-,',
  },
  {
    id: 'whatsNew.show',
    title: 'What’s New',
    keywords: ['changelog', 'release notes', 'update', 'version'],
  },
  {
    id: 'shortcuts.show',
    title: 'Keyboard shortcuts',
    keywords: ['cheat', 'sheet', 'keys', 'bindings', 'hotkeys', 'help'],
    keybinding: 'Mod-/',
  },
  {
    id: 'semantic.enable',
    title: 'Enable semantic search',
    keywords: ['embeddings', 'ai', 'similar', 'model'],
  },
  { id: 'index.rebuild', title: 'Rebuild search index', keywords: ['reindex', 'refresh'] },
  {
    id: 'dev.toggleDevtools',
    title: 'Developer tools',
    keywords: ['devtools', 'inspector', 'debug', 'console', 'inspect', 'web inspector'],
    keybinding: 'Mod-Shift-i',
  },
]

/**
 * The declared keybinding for `commandId`, or `null` when the command has
 * none. UI hints (sidebar keycaps, "go to today" affordances) derive bindings
 * through this so they can never drift from the declaration.
 */
export function keybindingFor(commandId: TriggerableCommandId): string | null {
  return APP_COMMANDS.find((command) => command.id === commandId)?.keybinding ?? null
}
