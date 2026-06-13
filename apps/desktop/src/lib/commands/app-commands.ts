import { errorMessage, randomNotePath } from '@reflect/core'
import { untitledNotePath } from '@/lib/create-note'
import { todayIso } from '@/lib/dates'
import { runGistPublish } from '@/lib/note-gist'
import { toggleNotePinned } from '@/lib/note-pin'
import { toggleNotePrivate } from '@/lib/note-private'
import { startOperation } from '@/lib/operations'
import { rebuildIndexVisibly } from '@/lib/rebuild-index'
import { notePathForRoute, type Route } from '@/routing/route'
import { registerCommands } from './registry'
import type { AppCommand } from './types'

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
export function newNoteRoute(): Route {
  return { kind: 'note', path: untitledNotePath() }
}

const APP_COMMANDS: AppCommand[] = [
  {
    id: 'nav.today',
    title: 'Go to today',
    keywords: ['daily', 'now'],
    keybinding: 'Mod-d',
    run: (context) => context.navigate({ kind: 'today' }),
  },
  {
    id: 'nav.allNotes',
    title: 'All notes',
    keywords: ['notes', 'list', 'browse', 'library'],
    run: (context) => context.navigate({ kind: 'allNotes', tag: null }),
  },
  {
    id: 'note.new',
    title: 'New note',
    keywords: ['create'],
    keybinding: 'Mod-n',
    run: (context) => context.navigate(newNoteRoute()),
  },
  {
    id: 'chat.open',
    title: 'Chat',
    keywords: ['ai', 'assistant', 'copilot', 'ask'],
    keybinding: 'Mod-j',
    run: (context) => context.navigate({ kind: 'chat' }),
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
    run: async (context) => {
      const generation = context.generation()
      const path = notePathForRoute(context.route(), todayIso())
      if (generation === null || path === null) {
        return
      }
      try {
        await toggleNotePinned(path, generation)
      } catch (cause) {
        // runCommand has no error channel of its own — an unreported failure
        // here would be a silent ⌘O. Surface it like other background work.
        startOperation('Pinning note').fail(errorMessage(cause))
      }
    },
  },
  {
    id: 'note.togglePrivate',
    title: 'Mark or un-mark note as private',
    keywords: ['privacy', 'lock', 'secret', 'hide', 'ai'],
    // Flips the `private` frontmatter flag — the hard block on sending the
    // note's content to AI or any other external service — of the note the
    // current route edits. No default keybinding: the palette keeps it
    // keyboard-reachable without spending a shortcut.
    run: async (context) => {
      const generation = context.generation()
      const path = notePathForRoute(context.route(), todayIso())
      if (generation === null || path === null) {
        return
      }
      try {
        await toggleNotePrivate(path, generation)
      } catch (cause) {
        startOperation('Marking note as private').fail(errorMessage(cause))
      }
    },
  },
  {
    id: 'note.publishGist',
    title: 'Publish note to gist',
    keywords: ['gist', 'github', 'share', 'publish', 'export'],
    // Publishes the body of the note the current route edits to a secret
    // GitHub gist (republishing to the same gist thereafter) and copies the
    // link. No default keybinding: the palette keeps it keyboard-reachable
    // without spending a shortcut. `runGistPublish` owns all feedback — the
    // progress line, the failure surface, and the "link copied" confirmation.
    run: async (context) => {
      const generation = context.generation()
      const path = notePathForRoute(context.route(), todayIso())
      if (generation === null || path === null) {
        return
      }
      await runGistPublish(path, generation)
    },
  },
  {
    id: 'note.random',
    title: 'Open random note',
    keywords: ['shuffle', 'serendipity'],
    run: async (context) => {
      const path = await randomNotePath()
      if (path !== null) {
        context.navigate({ kind: 'note', path })
      }
    },
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
      const generation = context.generation()
      if (generation === null) {
        return
      }
      await rebuildIndexVisibly(generation)
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

let registered = false

/**
 * Register the first-wave commands. Called explicitly from `main.tsx` (and by
 * tests) — registration as an import side effect couples behavior to module
 * graph order, which is exactly the kind of spooky action a registry invites.
 * Idempotent: hosts and tests can call it without coordinating.
 */
export function registerAppCommands(): void {
  if (registered) {
    return
  }
  registered = true
  registerCommands(APP_COMMANDS)
}

export { APP_COMMANDS }
