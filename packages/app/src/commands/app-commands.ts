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
  | 'note.print'
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

const graphSwitchKeywords = ['graph', 'workspace', 'switch', 'recent'] as const

/**
 * The declarations of the app commands, in palette order.
 */
export const APP_COMMANDS = {
  'graph.switch1': {
    title: 'Switch to Graph 1',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-1',
  },
  'graph.switch2': {
    title: 'Switch to Graph 2',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-2',
  },
  'graph.switch3': {
    title: 'Switch to Graph 3',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-3',
  },
  'graph.switch4': {
    title: 'Switch to Graph 4',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-4',
  },
  'graph.switch5': {
    title: 'Switch to Graph 5',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-5',
  },
  'graph.switch6': {
    title: 'Switch to Graph 6',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-6',
  },
  'graph.switch7': {
    title: 'Switch to Graph 7',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-7',
  },
  'graph.switch8': {
    title: 'Switch to Graph 8',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-8',
  },
  'graph.switch9': {
    title: 'Switch to Graph 9',
    keywords: graphSwitchKeywords,
    keybinding: 'Mod-9',
  },
  'nav.today': {
    title: 'Go to Today',
    keywords: ['daily', 'now'],
    keybinding: 'Mod-d',
  },
  'nav.allNotes': {
    title: 'All Notes',
    keywords: ['notes', 'list', 'browse', 'library'],
    keybinding: 'Mod-Shift-a',
  },
  'nav.tasks': {
    title: 'Tasks',
    keywords: ['todo', 'todos', 'checklist', 'checkbox', 'open'],
    keybinding: 'Mod-t',
  },
  'note.new': {
    title: 'New Note',
    keywords: ['create'],
    keybinding: 'Mod-n',
  },
  'note.openInNewWindow': {
    title: 'Open Note in New Window',
    keywords: ['window', 'duplicate', 'pop out'],
    keybinding: 'Mod-Shift-o',
  },
  'note.find': {
    title: 'Find in Note…',
    keywords: ['search', 'text', 'page'],
    keybinding: 'Mod-f',
  },
  'note.findNext': {
    title: 'Find Next',
    keywords: ['search', 'match', 'forward'],
    keybinding: 'Mod-g',
  },
  'note.findPrevious': {
    title: 'Find Previous',
    keywords: ['search', 'match', 'backward'],
    keybinding: 'Mod-Shift-g',
  },
  'chat.open': {
    title: 'Chat',
    keywords: ['ai', 'assistant', 'copilot', 'ask'],
    keybinding: 'Mod-j',
  },
  'chat.new': {
    title: 'New Chat',
    keywords: ['ai', 'assistant', 'copilot', 'conversation'],
    keybinding: 'Mod-Shift-n',
  },
  'history.back': {
    title: 'Back',
    keybinding: 'Mod-[',
  },
  'history.forward': {
    title: 'Forward',
    keybinding: 'Mod-]',
  },
  'palette.open': {
    title: 'Search…',
    keywords: ['find', 'open'],
    keybinding: 'Mod-k',
  },
  'note.togglePin': {
    title: 'Pin or Unpin Note',
    keywords: ['pinned', 'favorite', 'bookmark', 'sidebar'],
    // The original app's pin shortcut.
    keybinding: 'Mod-o',
  },
  // No default keybinding for the next three: the palette keeps them
  // keyboard-reachable without spending a shortcut.
  'note.togglePrivate': {
    title: 'Mark or Unmark Note as Private',
    keywords: ['privacy', 'lock', 'secret', 'hide', 'ai'],
  },
  'note.publishGist': {
    title: 'Share with Private Link',
    keywords: ['gist', 'github', 'share', 'publish', 'private link', 'export'],
  },
  'note.attachFile': {
    title: 'Attach File…',
    keywords: ['upload', 'attachment', 'import', 'pdf', 'document', 'insert'],
  },
  'note.copyDeepLink': {
    title: 'Copy Deep Link',
    keywords: ['url', 'share', 'clipboard', 'reflect://', 'address'],
    // The original app's copy-link shortcut.
    keybinding: 'Alt-Mod-l',
  },
  'note.copyPath': {
    title: 'Copy Note Path',
    keywords: ['file', 'absolute', 'filesystem', 'clipboard', 'location'],
    // Finder's Copy-as-Pathname chord.
    keybinding: 'Alt-Mod-c',
  },
  'note.print': {
    title: 'Print Note…',
    keywords: ['printer', 'paper', 'pdf', 'export'],
    keybinding: 'Mod-p',
  },
  'note.random': {
    title: 'Open Random Note',
    keywords: ['shuffle', 'serendipity'],
  },
  'template.insert': {
    title: 'Insert Template…',
    keywords: ['snippet', 'boilerplate', 'stamp'],
  },
  'template.new': {
    title: 'New Template',
    keywords: ['template', 'snippet', 'boilerplate', 'create'],
  },
  'audioMemo.toggle': {
    title: 'Record Audio Memo',
    keywords: ['voice', 'mic', 'dictate', 'transcribe', 'speech', 'capture'],
    keybinding: 'Mod-Shift-r',
  },
  'theme.toggle': {
    title: 'Toggle Theme',
    keywords: ['dark', 'light', 'appearance'],
  },
  'sidebar.toggle': {
    title: 'Toggle Sidebar',
    keywords: ['collapse', 'expand', 'navigation', 'focus'],
    keybinding: 'Mod-\\',
  },
  'settings.open': {
    title: 'Open Settings',
    keywords: ['preferences', 'config', 'options'],
    keybinding: 'Mod-,',
  },
  'whatsNew.show': {
    title: 'What’s New',
    keywords: ['changelog', 'release notes', 'update', 'version'],
  },
  'shortcuts.show': {
    title: 'Keyboard Shortcuts',
    keywords: ['cheat', 'sheet', 'keys', 'bindings', 'hotkeys', 'help'],
    keybinding: 'Mod-/',
  },
  'semantic.enable': {
    title: 'Enable Semantic Search',
    keywords: ['embeddings', 'ai', 'similar', 'model'],
  },
  'index.rebuild': {
    title: 'Rebuild Search Index',
    keywords: ['reindex', 'refresh'],
  },
  'dev.toggleDevtools': {
    title: 'Developer Tools',
    keywords: ['devtools', 'inspector', 'debug', 'console', 'inspect', 'web inspector'],
    keybinding: 'Mod-Shift-i',
  },
} as const satisfies Readonly<Record<AppCommandId, CommandDeclaration>>
