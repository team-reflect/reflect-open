import type { MaybePromise } from '@reflect/utils'
import type { LoggerService, PlatformFacts } from '@reflect/core'
import { APP_COMMANDS, type AppCommandId, type Command } from './app-commands.ts'
import { normalizeBinding } from './keybindings.ts'
import { objectEntries } from '@ocavue/utils'

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
 * What a command does in the current window.
 */
export type CommandHandler = () => MaybePromise<void>

/**
 * The app command registry of one window. The declarations are static
 * ({@link APP_COMMANDS}); the handlers are registered at run time by the UI
 * that implements them, and removed when it goes away.
 */
export interface CommandService {
  /**
   * Every declared command, in declaration order.
   */
  list(): readonly Command[]
  /**
   * Make `handler` the handler of `id` until `signal` aborts.
   */
  handle(id: AppCommandId, handler: CommandHandler, signal: AbortSignal): void
  /**
   * Whether `id` has a handler.
   */
  isHandled(id: AppCommandId): boolean
  /**
   * Run the handler of `id`, if any. Blocks do not apply: a caller that runs
   * a command directly (a button, the palette) owns that decision.
   */
  run(id: AppCommandId): Promise<void>
  /**
   * Run `id` for a key or a menu item. Returns whether a handler ran: false
   * when `id` has no handler or a block stops it. The handler's failure is
   * logged, not thrown.
   */
  trigger(id: AppCommandId): boolean
  /**
   * Stop {@link trigger} for every command except `allow` until `signal`
   * aborts. A modal screen blocks while it is open. Only the latest active
   * block applies, so a modal opened on top of another decides alone.
   */
  block(allow: readonly AppCommandId[], signal: AbortSignal): void
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
  readonly #handlers = new Map<AppCommandId, CommandHandler>()
  readonly #blocks: (readonly AppCommandId[])[] = []
  readonly #commands: readonly Command[]
  /**
   * Normalized binding → command id, for Apple platforms and for the others.
   */
  readonly #appleBindingToId = new Map<string, AppCommandId>()
  readonly #otherBindingToId = new Map<string, AppCommandId>()

  constructor(deps: CommandServiceDeps) {
    this.#deps = deps
    // FIXME: 1. if you use objectEntries here, you do not need `as AppCommandId` anymore; 2. find the whole codebase, do the refactors like this and remove unnecessary `as` casts for `Object.entries`;
    this.#commands = objectEntries(APP_COMMANDS).map(([id, declaration]) => ({
      id: id as AppCommandId,
      ...declaration,
    }))
    for (const command of this.#commands) {
      if (command.keybinding) {
        this.#appleBindingToId.set(normalizeBinding(command.keybinding, true), command.id)
        this.#otherBindingToId.set(normalizeBinding(command.keybinding, false), command.id)
      }
    }
  }

  list(): readonly Command[] {
    return this.#commands
  }

  handle(id: AppCommandId, handler: CommandHandler, signal: AbortSignal): void {
    if (signal.aborted) {
      return
    }
    // A fresh function per registration, so an abort removes only its own
    // registration, even when two registrations share one handler.
    const registered: CommandHandler = () => handler()
    this.#handlers.set(id, registered)
    signal.addEventListener(
      'abort',
      () => {
        if (this.#handlers.get(id) === registered) {
          this.#handlers.delete(id)
        }
      },
      { once: true },
    )
  }

  isHandled(id: AppCommandId): boolean {
    return this.#handlers.has(id)
  }

  async run(id: AppCommandId): Promise<void> {
    await this.#handlers.get(id)?.()
  }

  trigger(id: AppCommandId): boolean {
    const block = this.#blocks.at(-1)
    if (block !== undefined && !block.includes(id)) {
      return false
    }
    if (!this.#handlers.has(id)) {
      return false
    }
    void this.#runLogged(id)
    return true
  }

  block(allow: readonly AppCommandId[], signal: AbortSignal): void {
    if (signal.aborted) {
      return
    }
    this.#blocks.push(allow)
    signal.addEventListener(
      'abort',
      () => this.#blocks.splice(this.#blocks.lastIndexOf(allow), 1),
      {
        once: true,
      },
    )
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

  async #runLogged(id: AppCommandId): Promise<void> {
    try {
      await this.run(id)
    } catch (cause) {
      this.#deps.logger.error(`command failed: ${id}`, cause)
    }
  }
}

export function createCommandService(deps: CommandServiceDeps): CommandService {
  return new CommandServiceImpl(deps)
}
