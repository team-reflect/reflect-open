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
export interface Command {
  /**
   * Stable id, e.g. `nav.today`.
   */
  readonly id: AppCommandId
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
 * The declarations of the app commands, in palette order.
 */
export const APP_COMMANDS: Commands = [
  {
    id: 'graph.switch1',
    title: 'Switch to graph 1',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-1',
  },
  {
    id: 'graph.switch2',
    title: 'Switch to graph 2',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-2',
  },
  {
    id: 'graph.switch3',
    title: 'Switch to graph 3',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-3',
  },
  {
    id: 'graph.switch4',
    title: 'Switch to graph 4',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-4',
  },
  {
    id: 'graph.switch5',
    title: 'Switch to graph 5',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-5',
  },
  {
    id: 'graph.switch6',
    title: 'Switch to graph 6',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-6',
  },
  {
    id: 'graph.switch7',
    title: 'Switch to graph 7',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-7',
  },
  {
    id: 'graph.switch8',
    title: 'Switch to graph 8',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-8',
  },
  {
    id: 'graph.switch9',
    title: 'Switch to graph 9',
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: 'Mod-9',
  },
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
export function keybindingFor(commandId: AppCommandId): string | null {
  return APP_COMMANDS.find((command) => command.id === commandId)?.keybinding ?? null
}
