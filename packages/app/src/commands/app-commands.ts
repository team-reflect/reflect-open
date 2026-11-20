import type { NoteCreationService } from '@reflect/core'
import type { Route } from '../navigation/route.ts'

/**
 * The id of an app command.
 */
export type AppCommandId =
  | 'graph.switch1'
  | 'graph.switch2'
  | 'graph.switch3'
  | 'graph.switch4'
  | 'graph.switch5'
  | 'graph.switch6'
  | 'graph.switch7'
  | 'graph.switch8'
  | 'graph.switch9'
  | 'nav.today'
  | 'nav.allNotes'
  | 'nav.tasks'
  | 'note.new'
  | 'note.openInNewWindow'
  | 'note.find'
  | 'note.findNext'
  | 'note.findPrevious'
  | 'chat.open'
  | 'chat.new'
  | 'history.back'
  | 'history.forward'
  | 'palette.open'
  | 'note.togglePin'
  | 'note.togglePrivate'
  | 'note.publishGist'
  | 'note.attachFile'
  | 'note.copyDeepLink'
  | 'note.copyPath'
  | 'note.random'
  | 'template.insert'
  | 'template.new'
  | 'audioMemo.toggle'
  | 'theme.toggle'
  | 'sidebar.toggle'
  | 'settings.open'
  | 'whatsNew.show'
  | 'shortcuts.show'
  | 'semantic.enable'
  | 'index.rebuild'
  | 'dev.toggleDevtools'

/**
 * How the palette, the native menu, and the keybindings present a command.
 */
export interface CommandDeclaration {
  /**
   * Palette display title.
   */
  readonly title: string
  /**
   * Extra match terms for palette filtering.
   */
  readonly keywords?: readonly string[] | undefined
  /**
   * Keymap-registry binding (app scope), e.g. `Mod-d`.
   */
  readonly keybinding?: string | undefined
}

/**
 * A command declaration with its id.
 */
export interface Command extends CommandDeclaration {
  /**
   * Stable id, e.g. `nav.today`.
   */
  readonly id: AppCommandId
}

/**
 * A list of command declarations.
 */
export type Commands = readonly Command[] // FIXME: remove this COmmands type. It's useless. Just use readonly Command[] directly.

/**
 * A fresh note route; the file itself is created lazily on the first keystroke
 * (the same contract as daily notes). Shared by ⌘N and the All Notes screen's
 * New note button so "what a new note is" stays one definition.
 */
export function newNoteRoute(noteCreation: NoteCreationService): Route {
  return { kind: 'note', path: noteCreation.untitledNotePath() }
}

/**
 * The declarations of the app commands, in palette order.
 */
export const APP_COMMANDS: Record<AppCommandId, CommandDeclaration> = {
  'graph.switch1': {
    title: 'Switch to graph 1',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-1',
  },
  'graph.switch2': {
    title: 'Switch to graph 2',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-2',
  },
  'graph.switch3': {
    title: 'Switch to graph 3',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-3',
  },
  'graph.switch4': {
    title: 'Switch to graph 4',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-4',
  },
  'graph.switch5': {
    title: 'Switch to graph 5',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-5',
  },
  'graph.switch6': {
    title: 'Switch to graph 6',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-6',
  },
  'graph.switch7': {
    title: 'Switch to graph 7',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-7',
  },
  'graph.switch8': {
    title: 'Switch to graph 8',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-8',
  },
  'graph.switch9': {
    title: 'Switch to graph 9',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-9',
  },
  'nav.today': { title: 'Go to today', keywords: ['daily', 'now'], keybinding: 'Mod-d' },
  'nav.allNotes': {
    title: 'All notes',
    keywords: ['notes', 'list', 'browse', 'library'],
    keybinding: 'Mod-Shift-a',
  },
  'nav.tasks': {
    title: 'Tasks',
    keywords: ['todo', 'todos', 'checklist', 'checkbox', 'open'],
    keybinding: 'Mod-t',
  },
  'note.new': { title: 'New note', keywords: ['create'], keybinding: 'Mod-n' },
  'note.openInNewWindow': {
    title: 'Open note in new window',
    keywords: ['window', 'duplicate', 'pop out'],
    keybinding: 'Mod-Shift-o',
  },
  'note.find': {
    title: 'Find in note…',
    keywords: ['search', 'text', 'page'],
    keybinding: 'Mod-f',
  },
  'note.findNext': {
    title: 'Find next',
    keywords: ['search', 'match', 'forward'],
    keybinding: 'Mod-g',
  },
  'note.findPrevious': {
    title: 'Find previous',
    keywords: ['search', 'match', 'backward'],
    keybinding: 'Mod-Shift-g',
  },
  'chat.open': {
    title: 'Chat',
    keywords: ['ai', 'assistant', 'copilot', 'ask'],
    keybinding: 'Mod-j',
  },
  'chat.new': {
    title: 'New chat',
    keywords: ['ai', 'assistant', 'copilot', 'conversation'],
    keybinding: 'Mod-Shift-n',
  },
  'history.back': { title: 'Back', keybinding: 'Mod-[' },
  'history.forward': { title: 'Forward', keybinding: 'Mod-]' },
  'palette.open': { title: 'Search…', keywords: ['find', 'open'], keybinding: 'Mod-k' },
  'note.togglePin': {
    title: 'Pin or unpin note',
    keywords: ['pinned', 'favorite', 'bookmark', 'sidebar'],
    // The original app's pin shortcut.
    keybinding: 'Mod-o',
  },
  // No default keybinding for the next three: the palette keeps them
  // keyboard-reachable without spending a shortcut.
  'note.togglePrivate': {
    title: 'Mark or un-mark note as private',
    keywords: ['privacy', 'lock', 'secret', 'hide', 'ai'],
  },
  'note.publishGist': {
    title: 'Share with private link',
    keywords: ['gist', 'github', 'share', 'publish', 'private link', 'export'],
  },
  'note.attachFile': {
    title: 'Attach file…',
    keywords: ['upload', 'attachment', 'import', 'pdf', 'document', 'insert'],
  },
  'note.copyDeepLink': {
    title: 'Copy deep link',
    keywords: ['url', 'share', 'clipboard', 'reflect://', 'address'],
    // The original app's copy-link shortcut.
    keybinding: 'Alt-Mod-l',
  },
  'note.copyPath': {
    title: 'Copy note path',
    keywords: ['file', 'absolute', 'filesystem', 'clipboard', 'location'],
    // Finder's Copy-as-Pathname chord.
    keybinding: 'Alt-Mod-c',
  },
  'note.random': { title: 'Open random note', keywords: ['shuffle', 'serendipity'] },
  'template.insert': {
    title: 'Insert template…',
    keywords: ['snippet', 'boilerplate', 'stamp'],
  },
  'template.new': {
    title: 'New template',
    keywords: ['template', 'snippet', 'boilerplate', 'create'],
  },
  'audioMemo.toggle': {
    title: 'Record audio memo',
    keywords: ['voice', 'mic', 'dictate', 'transcribe', 'speech', 'capture'],
    keybinding: 'Mod-Shift-r',
  },
  'theme.toggle': { title: 'Toggle theme', keywords: ['dark', 'light', 'appearance'] },
  'sidebar.toggle': {
    title: 'Toggle sidebar',
    keywords: ['collapse', 'expand', 'navigation', 'focus'],
    keybinding: 'Mod-\\',
  },
  'settings.open': {
    title: 'Open settings',
    keywords: ['preferences', 'config', 'options'],
    keybinding: 'Mod-,',
  },
  'whatsNew.show': {
    title: 'What’s New',
    keywords: ['changelog', 'release notes', 'update', 'version'],
  },
  'shortcuts.show': {
    title: 'Keyboard shortcuts',
    keywords: ['cheat', 'sheet', 'keys', 'bindings', 'hotkeys', 'help'],
    keybinding: 'Mod-/',
  },
  'semantic.enable': {
    title: 'Enable semantic search',
    keywords: ['embeddings', 'ai', 'similar', 'model'],
  },
  'index.rebuild': { title: 'Rebuild search index', keywords: ['reindex', 'refresh'] },
  'dev.toggleDevtools': {
    title: 'Developer tools',
    keywords: ['devtools', 'inspector', 'debug', 'console', 'inspect', 'web inspector'],
    keybinding: 'Mod-Shift-i',
  },
}

/**
 * The declared keybinding for `commandId`, or `null` when the command has
 * none. UI hints (sidebar keycaps, "go to today" affordances) derive bindings
 * through this so they can never drift from the declaration.
 */
export function keybindingFor(commandId: AppCommandId): string | null {
  return APP_COMMANDS[commandId].keybinding ?? null
}
