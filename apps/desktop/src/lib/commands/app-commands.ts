import { embedStatus, notePath, randomNotePath, rebuildIndex } from '@reflect/core'
import { ulid } from 'ulidx'
import { startOperation } from '@/lib/operations'
import {
  backfillEmbeddingsVisibly,
  ensureEmbeddingsVisibly,
  setSemanticEnabled,
} from '@/lib/semantic'
import { registerCommands } from './registry'
import type { AppCommand } from './types'

/**
 * The first-wave commands (Plan 08). Keybindings here replace the hardcoded
 * switch that used to live in `app-shortcuts.ts` — the binding and the
 * behavior are one definition now.
 */

const APP_COMMANDS: AppCommand[] = [
  {
    id: 'nav.today',
    title: 'Go to today',
    keywords: ['daily', 'now'],
    keybinding: 'Mod-d',
    run: (context) => context.navigate({ kind: 'today' }),
  },
  {
    id: 'note.new',
    title: 'New note',
    keywords: ['create'],
    keybinding: 'Mod-n',
    // A fresh note path; the file itself is created lazily on the first
    // keystroke (the same contract as daily notes).
    run: (context) => context.navigate({ kind: 'note', path: notePath(ulid().toLowerCase()) }),
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
    id: 'semantic.enable',
    title: 'Enable semantic search',
    keywords: ['embeddings', 'ai', 'similar', 'model'],
    // Downloads the local model (~90MB) — deliberately a command, never
    // automatic: the first network fetch is the user's call. EmbeddingsSync
    // reacts to `ready` with the backfill, and the persisted flag makes
    // later launches load from cache without asking again.
    run: async () => {
      setSemanticEnabled(true)
      await ensureEmbeddingsVisibly()
    },
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
      // The index is a rebuildable cache; a full rebuild is safe and visible.
      const operation = startOperation('Rebuilding search index')
      try {
        await rebuildIndex({ generation })
        operation.done()
      } catch (cause) {
        operation.fail(cause instanceof Error ? cause.message : String(cause))
        return
      }
      // index_clear wiped the embedding tables with everything else — rebuild
      // them too, or semantic search stays silently empty until some other
      // trigger re-embeds.
      const embed = await embedStatus()
      if (embed.status === 'ready') {
        await backfillEmbeddingsVisibly({ generation, modelId: embed.model })
      }
    },
  },
]

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
