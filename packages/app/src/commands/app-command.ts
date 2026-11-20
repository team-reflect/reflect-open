import type { MaybePromise } from '@reflect/utils'
import type { AttachmentInsertTarget, CoreServices } from '@reflect/core'
import type { AppServices } from '../create-app-services.ts'
import type { NavigateOptions } from '../navigation/navigation-service.ts'
import type { Route, Section } from '../navigation/route.ts'
import type { Command } from './command-service.ts'

/**
 * The typed command contract (Plan 08): one registry powers the ⌘K palette,
 * the app-scope keybindings, and — later — deep links and the CLI (Plan 14).
 * Commands receive their capabilities through {@link CommandContext} rather
 * than importing app state, so the registry stays testable and host-agnostic.
 */

export interface CommandContext {
  /**
   * The core services, for the commands that call one directly.
   */
  services: CoreServices
  app: AppServices<AppCommandId, CommandContext>
  navigate: (route: Route, options?: NavigateOptions) => void
  /**
   * Go to a section: where it was left from elsewhere, its root from within.
   */
  selectSection: (section: Section, options?: NavigateOptions) => void
  /** The current route, read at run time. */
  route: () => Route
  /**
   * The note file note-scoped commands (pin, private, publish) act on, or null
   * for screens that edit no note. Usually the routed note, but in the daily
   * stream it's the **focused** day — the same note the context sidebar
   * describes — so a command and the sidebar never target different days.
   */
  notePath: () => string | null
  /**
   * The mounted editor of the note at `path`, or null when none is on screen.
   */
  noteEditor: (path: string) => AttachmentInsertTarget | null
  /** Toggle the focused note pin with immediate shared feedback. */
  togglePin: () => MaybePromise<void>
  /** Toggle the focused note privacy with immediate shared feedback. */
  togglePrivate: () => MaybePromise<void>
  back: () => void
  forward: () => void
  /** Discard the current view's saved scroll offsets so it re-anchors when revisited. */
  clearScrollState: () => void
  toggleTheme: () => void
  /** Collapse/expand the workspace and contextual sidebars. */
  toggleSidebar: () => void
  /** Start a fresh chat conversation. */
  newChat: () => void
  /** Open Find for the note currently targeted by {@link notePath}. */
  openNoteFind: () => void
  /** Advance the active or most recently closed note Find query. */
  findNextInNote: () => void
  /** Move backward through the active or most recently closed Find query. */
  findPreviousInNote: () => void
  /** Switch to a recent graph by zero-based position in the graph switcher. */
  switchGraph: (index: number) => void
  /** Start an audio memo, or stop-and-save the one recording. */
  toggleAudioMemo: () => void
  /** Open the ⌘K palette (optionally pre-filled). */
  openPalette: (query?: string) => void
  /** Open the ⌘/ shortcuts cheat-sheet. */
  openShortcuts: () => void
  /** Open the "Insert template…" picker (inserts into {@link notePath}'s editor). */
  openTemplatePicker: () => void
  /** Open the "New template" name dialog. */
  openTemplateCreate: () => void
  /**
   * Persist the semantic-search opt-in (`semanticSearchEnabled`).
   * EmbeddingsSync reacts to the setting by loading — first time:
   * downloading — the model, so flipping the flag is the whole command.
   */
  enableSemanticSearch: () => void
}

/**
 * The 1-based position of a recent graph that a `graph.switch` command opens.
 */
export type GraphSwitchPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/**
 * The id of an app command.
 */
export type AppCommandId =
  | `graph.switch${GraphSwitchPosition}`
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
 * A command of this app: it runs with a {@link CommandContext}.
 */
export type AppCommand = Command<AppCommandId, CommandContext>
