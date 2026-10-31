import type { MaybePromise } from '@reflect/utils'
import type { LoggerService, PlatformFacts } from '@reflect/core'
import { normalizeBinding } from './keybindings.ts'

/**
 * The typed command contract: one registry powers the ⌘K palette, the
 * app-scope keybindings, and the native menu. A command receives its
 * capabilities through `Context`, an object the app assembles, so the
 * registry stays testable and host-agnostic.
 */
export interface Command<Context = unknown> {
  /**
   * Stable id — the deep-link/CLI name (e.g. `nav.today`).
   */
  id: string
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
  run: (context: Context) => MaybePromise<void>
}

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
export interface CommandService<Context = unknown> {
  /**
   * Register commands; duplicate or blank ids/titles are programmer errors.
   */
  register(definitions: readonly Command<Context>[]): void
  /**
   * Every registered command, in registration order.
   */
  list(): Command<Context>[]
  /**
   * Run a command by id; unknown ids are a loud no-op (deep links may dangle).
   */
  run(id: string, context: Context): Promise<void>
  /**
   * The id of the command whose keybinding `event` types, or `null`. Only
   * chords with ⌘ or Ctrl match, and a held key (`repeat`) never does.
   */
  commandForKeyDown(event: CommandKeyEvent): string | null
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

class CommandServiceImpl<Context> implements CommandService<Context> {
  readonly #deps: CommandServiceDeps
  readonly #commands = new Map<string, Command<Context>>()
  /**
   * Normalized binding → command id, for Apple platforms and for the others.
   */
  readonly #appleBindingToId = new Map<string, string>()
  readonly #otherBindingToId = new Map<string, string>()

  constructor(deps: CommandServiceDeps) {
    this.#deps = deps
  }

  register(definitions: readonly Command<Context>[]): void {
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

  list(): Command<Context>[] {
    return [...this.#commands.values()]
  }

  async run(id: string, context: Context): Promise<void> {
    const command = this.#commands.get(id)
    if (!command) {
      this.#deps.logger.error(`unknown command: ${id}`)
      return
    }
    await command.run(context)
  }

  commandForKeyDown(event: CommandKeyEvent): string | null {
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

export function createCommandService<Context = unknown>(
  deps: CommandServiceDeps,
): CommandService<Context> {
  return new CommandServiceImpl<Context>(deps)
}
