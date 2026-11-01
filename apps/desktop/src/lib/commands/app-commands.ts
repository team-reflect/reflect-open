import type { NoteCreationService } from '@reflect/core'
import { type CommandService, routeForPath, type Route } from '@reflect/app'
import { attachFilesToNote } from '@/lib/attach-files.ts'
import { copyNoteDeepLink, copyNotePath, publishGistAndCopyLink } from '@/lib/clipboard-actions.ts'
import type { AppCommand, CommandContext } from './types.ts'

/**
 * The first-wave commands (Plan 08). Keybindings here replace the hardcoded
 * switch that used to live in `app-shortcuts.ts` — the binding and the
 * behavior are one definition now.
 */

/**
 * A fresh note route; the file itself is created lazily on the first keystroke
 * (the same contract as daily notes). Shared by ⌘N and the All Notes screen's
 * New note button so "what a new note is" stays one definition.
 */
export function newNoteRoute(noteCreation: NoteCreationService): Route {
  return { kind: 'note', path: noteCreation.untitledNotePath() }
}

/**
 * ⌘N from the daily stream leaves its saved scroll offsets behind as stale
 * state: the fresh note is where attention moves, so a later return to the
 * stream — ⌘[ back or the Daily nav tab — should re-anchor to its target, not
 * restore the pre-note position. Other routes keep their offsets; only the
 * stream re-anchors around note creation.
 */
function openNewNote(context: CommandContext): void {
  const route = context.route()
  if (route.kind === 'today' || route.kind === 'daily') {
    context.clearScrollState()
  }
  context.navigate(newNoteRoute(context.services.noteCreation))
}

const GRAPH_SWITCH_COMMANDS: AppCommand[] = Array.from({ length: 9 }, (_, index) => {
  const position = index + 1
  return {
    id: `graph.switch${position}`,
    title: `Switch to graph ${position}`,
    keywords: ['graph', 'workspace', 'switch', 'recent'],
    keybinding: `Mod-${position}`,
    run: (context) => context.switchGraph(index),
  }
})

const APP_COMMANDS: AppCommand[] = [
  ...GRAPH_SWITCH_COMMANDS,
  {
    id: 'nav.today',
    title: 'Go to today',
    keywords: ['daily', 'now'],
    keybinding: 'Mod-d',
    // ⌘D is a capture gesture, not just navigation: the arrival asks the
    // stream to focus today's editor with the caret at the end of its
    // content, ready to append — the same one-shot `focusEditor` intent as
    // the mobile Daily-tab double-tap. Ordinary daily links and history
    // moves stay on the calm default (focus at the note start, or none).
    run: (context) => context.navigate({ kind: 'today' }, { focusEditor: true }),
  },
  {
    id: 'nav.allNotes',
    title: 'All notes',
    keywords: ['notes', 'list', 'browse', 'library'],
    keybinding: 'Mod-Shift-a',
    run: (context) => context.navigate({ kind: 'allNotes', tag: null }),
  },
  {
    id: 'nav.tasks',
    title: 'Tasks',
    keywords: ['todo', 'todos', 'checklist', 'checkbox', 'open'],
    keybinding: 'Mod-t',
    run: (context) => context.navigate({ kind: 'tasks' }),
  },
  {
    id: 'note.new',
    title: 'New note',
    keywords: ['create'],
    keybinding: 'Mod-n',
    run: openNewNote,
  },
  {
    id: 'note.openInNewWindow',
    title: 'Open note in new window',
    keywords: ['window', 'duplicate', 'pop out'],
    keybinding: 'Mod-Shift-o',
    // `notePath` follows the focused day inside the daily stream. Converting
    // that path back to a route also canonicalizes Today to a dated daily
    // link, so every way of opening the day dedupes to the same window.
    run: async (context) => {
      const path = context.notePath()
      if (path === null) {
        return
      }
      await context.app.linkNavigation.openRouteInNewWindow(routeForPath(path))
    },
  },
  {
    id: 'note.find',
    title: 'Find in note…',
    keywords: ['search', 'text', 'page'],
    keybinding: 'Mod-f',
    run: (context) => context.openNoteFind(),
  },
  {
    id: 'note.findNext',
    title: 'Find next',
    keywords: ['search', 'match', 'forward'],
    keybinding: 'Mod-g',
    run: (context) => context.findNextInNote(),
  },
  {
    id: 'note.findPrevious',
    title: 'Find previous',
    keywords: ['search', 'match', 'backward'],
    keybinding: 'Mod-Shift-g',
    run: (context) => context.findPreviousInNote(),
  },
  {
    id: 'chat.open',
    title: 'Chat',
    keywords: ['ai', 'assistant', 'copilot', 'ask'],
    keybinding: 'Mod-j',
    run: (context) => context.navigate({ kind: 'chat' }),
  },
  {
    id: 'chat.new',
    title: 'New chat',
    keywords: ['ai', 'assistant', 'copilot', 'conversation'],
    keybinding: 'Mod-Shift-n',
    run: (context) => {
      if (context.route().kind !== 'chat') {
        return
      }
      context.newChat()
    },
  },
  {
    id: 'history.back',
    title: 'Back',
    keybinding: 'Mod-[',
    run: (context) => context.back(),
  },
  {
    id: 'history.forward',
    title: 'Forward',
    keybinding: 'Mod-]',
    run: (context) => context.forward(),
  },
  {
    id: 'palette.open',
    title: 'Search…',
    keywords: ['find', 'open'],
    keybinding: 'Mod-k',
    run: (context) => context.openPalette(),
  },
  {
    id: 'note.togglePin',
    title: 'Pin or unpin note',
    keywords: ['pinned', 'favorite', 'bookmark', 'sidebar'],
    // The original app's pin shortcut. Flips the `pinned` frontmatter flag of
    // the note the current route edits; on search/settings there is no such
    // note and the command is a no-op.
    keybinding: 'Mod-o',
    run: (context) => context.togglePin(),
  },
  {
    id: 'note.togglePrivate',
    title: 'Mark or un-mark note as private',
    keywords: ['privacy', 'lock', 'secret', 'hide', 'ai'],
    // Flips the `private` frontmatter flag — the hard block on sending the
    // note's content to AI or any other external service — of the note the
    // current route edits. No default keybinding: the palette keeps it
    // keyboard-reachable without spending a shortcut.
    run: (context) => context.togglePrivate(),
  },
  {
    id: 'note.publishGist',
    title: 'Share with private link',
    keywords: ['gist', 'github', 'share', 'publish', 'private link', 'export'],
    // Publishes the body of the note the current route edits to a secret
    // GitHub gist (republishing to the same gist thereafter) and copies the
    // link. No default keybinding: the palette keeps it keyboard-reachable
    // without spending a shortcut. `GistPublishService.publish` owns the progress line
    // and the failure surface; `publishGistAndCopyLink` owns the "link copied" confirmation.
    run: async (context) => {
      const path = context.notePath()
      if (path === null) {
        return
      }
      await publishGistAndCopyLink(context.services, context.app, path)
    },
  },
  {
    id: 'note.attachFile',
    title: 'Attach file…',
    keywords: ['upload', 'attachment', 'import', 'pdf', 'document', 'insert'],
    // Native file picker → copies into the graph's `assets/` → a markdown
    // link per file at the caret (the keyboard-native twin of dropping a
    // file on the note). No default keybinding: the palette keeps it
    // keyboard-reachable without spending a shortcut.
    run: (context) => attachFilesToNote(context),
  },
  {
    id: 'note.copyDeepLink',
    title: 'Copy deep link',
    keywords: ['url', 'share', 'clipboard', 'reflect://', 'address'],
    // The original app's copy-link shortcut. Copies a `reflect://` address for
    // the note the current route edits — id-shaped so it survives renames,
    // minting the frontmatter id on first copy. `copyNoteDeepLink` owns all
    // feedback (the "Deep link copied" status line and failure surfaces).
    keybinding: 'Alt-Mod-l',
    run: async (context) => {
      const path = context.notePath()
      if (path === null) {
        return
      }
      await copyNoteDeepLink(context.services, context.app, path)
    },
  },
  {
    id: 'note.copyPath',
    title: 'Copy note path',
    keywords: ['file', 'absolute', 'filesystem', 'clipboard', 'location'],
    // The OS-path sibling of "Copy deep link": copies the note's absolute
    // file path (Finder's Copy-as-Pathname chord) for use outside Reflect,
    // where a reflect:// address cannot resolve. `copyNotePath` owns all
    // feedback (the "Note path copied" status line and failure surfaces).
    keybinding: 'Alt-Mod-c',
    run: async (context) => {
      const path = context.notePath()
      if (path === null) {
        return
      }
      await copyNotePath(context.services, context.app, path)
    },
  },
  {
    id: 'note.random',
    title: 'Open random note',
    keywords: ['shuffle', 'serendipity'],
    run: async (context) => {
      const path = await context.services.indexQuery.randomNotePath()
      if (path !== null) {
        context.navigate({ kind: 'note', path })
      }
    },
  },
  {
    id: 'template.insert',
    title: 'Insert template…',
    keywords: ['snippet', 'boilerplate', 'stamp'],
    // Inserts into the note the current route edits (the focused stream day on
    // daily views); on screens with no note there is nothing to insert into.
    // The picker itself carries the empty state — a "New template" row — so
    // the command stays discoverable before any template exists.
    run: (context) => {
      if (context.notePath() === null) {
        return
      }
      context.openTemplatePicker()
    },
  },
  {
    id: 'template.new',
    title: 'New template',
    keywords: ['template', 'snippet', 'boilerplate', 'create'],
    run: (context) => context.openTemplateCreate(),
  },
  {
    id: 'audioMemo.toggle',
    title: 'Record audio memo',
    keywords: ['voice', 'mic', 'dictate', 'transcribe', 'speech', 'capture'],
    keybinding: 'Mod-Shift-r',
    run: (context) => context.toggleAudioMemo(),
  },
  {
    id: 'theme.toggle',
    title: 'Toggle theme',
    keywords: ['dark', 'light', 'appearance'],
    run: (context) => context.toggleTheme(),
  },
  {
    id: 'sidebar.toggle',
    title: 'Toggle sidebar',
    keywords: ['collapse', 'expand', 'navigation', 'focus'],
    keybinding: 'Mod-\\',
    run: (context) => context.toggleSidebar(),
  },
  {
    id: 'settings.open',
    title: 'Open settings',
    keywords: ['preferences', 'config', 'options'],
    keybinding: 'Mod-,',
    run: (context) => context.navigate({ kind: 'settings' }),
  },
  {
    id: 'shortcuts.show',
    title: 'Keyboard shortcuts',
    keywords: ['cheat', 'sheet', 'keys', 'bindings', 'hotkeys', 'help'],
    keybinding: 'Mod-/',
    run: (context) => context.openShortcuts(),
  },
  {
    id: 'semantic.enable',
    title: 'Enable semantic search',
    keywords: ['embeddings', 'ai', 'similar', 'model'],
    // Downloads the local model (~90MB) — deliberately opt-in, never
    // automatic: the first network fetch is the user's call. Persisting the
    // setting is the entire command — EmbeddingsSync loads the model when the
    // flag flips on and backfills once it's `ready`; later launches load from
    // cache without asking again.
    run: (context) => context.enableSemanticSearch(),
  },
  {
    id: 'index.rebuild',
    title: 'Rebuild search index',
    keywords: ['reindex', 'refresh'],
    run: async (context) => {
      await context.services.indexLifecycle.rebuildVisibly()
    },
  },
  {
    id: 'dev.toggleDevtools',
    title: 'Developer tools',
    keywords: ['devtools', 'inspector', 'debug', 'console', 'inspect', 'web inspector'],
    // The web inspector ships in every build (see `src-tauri/src/devtools.rs`),
    // so users can always debug. Plain-browser dev has no native shell — and its
    // own DevTools — so this no-ops there rather than throwing through the
    // bridge. Errors are swallowed: a debug affordance never interrupts the user.
    keybinding: 'Mod-Shift-i',
    run: async (context) => {
      if (!context.services.platform.isNativeShell) {
        return
      }
      try {
        await context.app.window.toggleDevtools()
      } catch {
        // Best effort — opening the inspector is never worth a surfaced failure.
      }
    },
  },
]

/**
 * The registered keybinding for `commandId`, or `null` when the command has
 * none (or the id is unknown). UI hints — sidebar keycaps, "go to today"
 * affordances — derive bindings through this so they can never drift from the
 * command definition, and disappear if the binding ever does.
 */
export function keybindingFor(commandId: string): string | null {
  return APP_COMMANDS.find((command) => command.id === commandId)?.keybinding ?? null
}

const registeredIn = new WeakSet<object>()

/**
 * Register the first-wave commands in `registry`. Called explicitly from
 * `main.tsx` (and by the test render helpers) — registration as an
 * import side effect couples behavior to module graph order, which is exactly
 * the kind of spooky action a registry invites. Idempotent per registry:
 * hosts and tests can call it without coordinating.
 */
export function registerAppCommands(registry: CommandService<CommandContext>): void {
  if (registeredIn.has(registry)) {
    return
  }
  registeredIn.add(registry)
  registry.register(APP_COMMANDS)
}

export { APP_COMMANDS }
