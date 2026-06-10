import type { Route } from '@/routing/route'

/**
 * The typed command contract (Plan 08): one registry powers the ⌘K palette,
 * the app-scope keybindings, and — later — deep links and the CLI (Plan 14).
 * Commands receive their capabilities through {@link CommandContext} rather
 * than importing app state, so the registry stays testable and host-agnostic.
 */

export interface CommandContext {
  navigate: (route: Route) => void
  /** The current route, read at run time — what note-scoped commands act on. */
  route: () => Route
  back: () => void
  forward: () => void
  toggleTheme: () => void
  /** Collapse/expand the workspace sidebar. */
  toggleSidebar: () => void
  /**
   * The open **index session** generation (`index_open`), or null when none —
   * what index/embedding commands echo. File writes (`note_write`) take
   * `graph.generation` instead; no current command needs that one.
   */
  generation: () => number | null
  /** Open the ⌘K palette (optionally pre-filled). */
  openPalette: (query?: string) => void
  /**
   * Persist the semantic-search opt-in (`semanticSearchEnabled`).
   * EmbeddingsSync reacts to the setting by loading — first time:
   * downloading — the model, so flipping the flag is the whole command.
   */
  enableSemanticSearch: () => void
}

export interface AppCommand {
  /** Stable id — the deep-link/CLI name (e.g. `nav.today`). */
  id: string
  /** Palette display title. */
  title: string
  /** Extra match terms for palette filtering. */
  keywords?: string[]
  /** Keymap-registry binding (app scope), e.g. `Mod-d`. */
  keybinding?: string
  run: (context: CommandContext) => void | Promise<void>
}
