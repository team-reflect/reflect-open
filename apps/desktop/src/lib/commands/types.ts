import type { Route } from '@/routing/route'

/**
 * The typed command contract (Plan 08): one registry powers the ⌘K palette,
 * the app-scope keybindings, and — later — deep links and the CLI (Plan 14).
 * Commands receive their capabilities through {@link CommandContext} rather
 * than importing app state, so the registry stays testable and host-agnostic.
 */

export interface CommandContext {
  navigate: (route: Route) => void
  /** The current route, read at run time. */
  route: () => Route
  /**
   * The note file note-scoped commands (pin, private, publish) act on, or null
   * for screens that edit no note. Usually the routed note, but in the daily
   * stream it's the **focused** day — the same note the context sidebar
   * describes — so a command and the sidebar never target different days.
   */
  notePath: () => string | null
  back: () => void
  forward: () => void
  toggleTheme: () => void
  /** Collapse/expand the workspace sidebar. */
  toggleSidebar: () => void
  /** Start a fresh chat conversation. */
  newChat: () => void
  /** Start an audio memo, or stop-and-save the one recording. */
  toggleAudioMemo: () => void
  /**
   * The open **index session** generation (`index_open`), or null when none —
   * what index/embedding commands echo. File writes (`note_write`) take
   * `graph.generation` instead; no current command needs that one.
   */
  generation: () => number | null
  /** Open the ⌘K palette (optionally pre-filled). */
  openPalette: (query?: string) => void
  /** Open the ⌘/ shortcuts cheat-sheet. */
  openShortcuts: () => void
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
