import type { MaybePromise } from '@reflect/utils'
import type {
  AttachmentInsertTarget,
  CoreServices,
  LoggerService,
  PlatformFacts,
} from '@reflect/core'
import type { ClipboardService } from '../app/clipboard-service.ts'
import type { DialogService } from '../app/dialog-service.ts'
import type { OperationsService } from '../app/operations-service.ts'
import type { WindowService } from '../app/window-service.ts'
import type { LinkNavigationService } from '../navigation/link-navigation-service.ts'
import type { NavigateOptions } from '../navigation/navigation-service.ts'
import type { Route, Section } from '../navigation/route.ts'
import type { WhatsNewService } from '../whats-new/whats-new-service.ts'
import { normalizeBinding } from './keybindings.ts'

/**
 * What a command runs with (Plan 08). Commands receive their capabilities
 * here rather than importing app state, so the registry stays testable and
 * host-agnostic.
 */
export interface CommandContext {
  /**
   * The core services, for the commands that call one directly.
   */
  services: CoreServices
  app: CommandAppServices
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
 * The app services a command reaches through {@link CommandContext.app}.
 */
export interface CommandAppServices {
  readonly window: WindowService
  readonly dialog: DialogService
  readonly clipboard: ClipboardService
  readonly operations: OperationsService
  readonly linkNavigation: LinkNavigationService
  readonly whatsNew: WhatsNewService
  readonly commands: CommandService
}

/**
 * The typed command contract: one registry powers the ⌘K palette, the
 * app-scope keybindings, and the native menu. A command receives its
 * capabilities through {@link CommandContext}, an object the app assembles.
 */
export interface Command {
  /**
   * Stable id — the deep-link/CLI name (e.g. `nav.today`).
   */
  id: AppCommandId
  /**
   * Palette display title.
   */
  title: string
  /**
   * Extra match terms for palette filtering.
   */
  keywords?: string[]
  /**
   * Keymap-registry binding (app scope), e.g. `Mod-d`.
   */
  keybinding?: string
  run: (context: CommandContext) => MaybePromise<void>
}

/**
 * A list of commands, in registration order.
 */
export type Commands = readonly Command[]

/**
 * The fields of a `keydown` event that {@link CommandService.commandForKeyDown} reads.
 */
export interface CommandKeyEvent {
  readonly key: string
  readonly code: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
}

/**
 * A flat, collision-checked id → command map.
 */
export interface CommandService {
  /**
   * Register commands; duplicate or blank ids/titles are programmer errors.
   */
  register(definitions: Commands): void
  /**
   * Every registered command, in registration order.
   */
  list(): Command[]
  /**
   * Run a command by id; unknown ids are a loud no-op (deep links may dangle).
   */
  run(id: AppCommandId, context: CommandContext): Promise<void>
  /**
   * The id of the command whose keybinding `event` types, or `null`. Only
   * chords with ⌘ or Ctrl match, and a held key (`repeat`) never does.
   */
  commandForKeyDown(event: CommandKeyEvent): AppCommandId | null
}

export interface CommandServiceDeps {
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

const CODE_TO_BINDING_KEY: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
}

interface BindingKeyLookup {
  key: string
  shift: boolean
}

function bindingKeyFor(event: CommandKeyEvent): string {
  if (!event.altKey && event.key.length === 1) {
    return event.key.toLowerCase()
  }
  const fromCode = CODE_TO_BINDING_KEY[event.code]
  if (fromCode !== undefined) {
    return fromCode
  }
  // Alt rewrites `event.key` on macOS (⌥L reports "Ò"), so alt chords match
  // letters and digits by physical code instead.
  if (event.altKey) {
    const code = /^(?:Key([A-Z])|Digit(\d))$/.exec(event.code)
    if (code !== null) {
      return (code[1] ?? code[2] ?? '').toLowerCase()
    }
  }
  return event.key.toLowerCase()
}

function physicalDigitKeyFor(event: CommandKeyEvent): string | null {
  if (event.altKey) {
    return null
  }
  const match = /^Digit(\d)$/.exec(event.code)
  if (match === null) {
    return null
  }
  const digit = match[1]!
  // Some layouts type number-row digits with Shift. Treat that as the same
  // graph-switch shortcut, but don't make US-style Cmd+Shift+@ mean Cmd+2.
  if (event.shiftKey && event.key !== digit) {
    return null
  }
  return digit
}

function addBindingLookup(lookups: BindingKeyLookup[], lookup: BindingKeyLookup): void {
  if (lookups.some((existing) => existing.key === lookup.key && existing.shift === lookup.shift)) {
    return
  }
  lookups.push(lookup)
}

function bindingLookupsFor(event: CommandKeyEvent): BindingKeyLookup[] {
  const lookups: BindingKeyLookup[] = []
  addBindingLookup(lookups, { key: bindingKeyFor(event), shift: event.shiftKey })

  const digit = physicalDigitKeyFor(event)
  if (digit !== null) {
    addBindingLookup(lookups, { key: digit, shift: false })
  }

  return lookups
}

class CommandServiceImpl implements CommandService {
  readonly #deps: CommandServiceDeps
  readonly #commands = new Map<AppCommandId, Command>()
  /**
   * Normalized binding → command id, for Apple platforms and for the others.
   */
  readonly #appleBindingToId = new Map<string, AppCommandId>()
  readonly #otherBindingToId = new Map<string, AppCommandId>()

  constructor(deps: CommandServiceDeps) {
    this.#deps = deps
  }

  register(definitions: Commands): void {
    for (const command of definitions) {
      if (command.id.trim() === '') {
        throw new Error('command id cannot be empty')
      }
      if (command.title.trim() === '') {
        throw new Error(`command title cannot be empty: ${command.id}`)
      }
      if (this.#commands.has(command.id)) {
        throw new Error(`command id already registered: ${command.id}`)
      }
      this.#commands.set(command.id, command)
      if (command.keybinding) {
        this.#appleBindingToId.set(normalizeBinding(command.keybinding, true), command.id)
        this.#otherBindingToId.set(normalizeBinding(command.keybinding, false), command.id)
      }
    }
  }

  list(): Command[] {
    return [...this.#commands.values()]
  }

  async run(id: AppCommandId, context: CommandContext): Promise<void> {
    const command = this.#commands.get(id)
    if (!command) {
      this.#deps.logger.error(`unknown command: ${id}`)
      return
    }
    await command.run(context)
  }

  commandForKeyDown(event: CommandKeyEvent): AppCommandId | null {
    if ((!event.metaKey && !event.ctrlKey) || event.repeat) {
      return null // held keys must not spam navigations (e.g. a stack of new notes)
    }
    const apple = this.#deps.platform.isApplePlatform
    const ids = apple ? this.#appleBindingToId : this.#otherBindingToId
    for (const { key, shift } of bindingLookupsFor(event)) {
      // Every held modifier is part of the lookup, so `Mod-Alt-l` can bind while
      // an alt chord still never fires a plain `Mod-` command.
      const modifiers = [
        event.ctrlKey ? 'Ctrl' : null,
        event.metaKey ? 'Meta' : null,
        event.altKey ? 'Alt' : null,
        shift ? 'Shift' : null,
      ].filter((modifier): modifier is string => modifier !== null)
      const id = ids.get(normalizeBinding([...modifiers, key].join('-'), apple))
      if (id !== undefined) {
        return id
      }
    }
    return null
  }
}

export function createCommandService(deps: CommandServiceDeps): CommandService {
  return new CommandServiceImpl(deps)
}
