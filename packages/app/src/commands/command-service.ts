import type { LoggerService, PlatformFacts } from '@reflect/core'
import {
  APP_COMMANDS,
  type AppCommandId,
  type AppCommands,
  type Commands,
  type TriggerableCommandId,
} from './app-commands.ts'
import { normalizeBinding } from './keybindings.ts'

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
 * The app command registry of one window. The declarations are static
 * ({@link APP_COMMANDS}); the handlers are registered at run time by the UI
 * that implements them, and removed when it goes away.
 */
export interface CommandService {
  /**
   * Every declared command, in declaration order.
   */
  list(): Commands
  /**
   * Make `handler` the handler of `id` until `signal` aborts. A later handler
   * for the same id shadows an earlier one; when it is removed, the earlier
   * one runs again.
   */
  handle<Id extends AppCommandId>(id: Id, handler: AppCommands[Id], signal: AbortSignal): void
  /**
   * Whether `id` has a handler.
   */
  isHandled(id: AppCommandId): boolean
  /**
   * Call the current handler of `id` and return its result, or `undefined`
   * when `id` has no handler. Blocks do not apply: a caller that runs a
   * command directly (a button, the palette) owns that decision.
   */
  run<Id extends AppCommandId>(
    id: Id,
    ...args: Parameters<AppCommands[Id]>
  ): ReturnType<AppCommands[Id]> | undefined
  /**
   * Run `id` for a key or a menu item. Returns whether a handler ran: false
   * when `id` has no handler or a block stops it. The handler's failure is
   * logged, not thrown.
   */
  trigger(id: TriggerableCommandId): boolean
  /**
   * Stop {@link trigger} for every command except `allow` until `signal`
   * aborts. A modal screen blocks while it is open.
   */
  block(allow: readonly AppCommandId[], signal: AbortSignal): void
  /**
   * The id of the command whose keybinding `event` types, or `null`. Only
   * chords with ⌘ or Ctrl match, and a held key (`repeat`) never does.
   */
  commandForKeyDown(event: CommandKeyEvent): TriggerableCommandId | null
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

type StoredHandler = (...args: readonly unknown[]) => unknown

class CommandServiceImpl implements CommandService {
  readonly #deps: CommandServiceDeps
  readonly #handlers = new Map<AppCommandId, StoredHandler[]>()
  readonly #blocks: (readonly AppCommandId[])[] = []
  /**
   * Normalized binding → command id, for Apple platforms and for the others.
   */
  readonly #appleBindingToId = new Map<string, TriggerableCommandId>()
  readonly #otherBindingToId = new Map<string, TriggerableCommandId>()

  constructor(deps: CommandServiceDeps) {
    this.#deps = deps
    const ids = new Set<AppCommandId>()
    for (const command of APP_COMMANDS) {
      if (command.title.trim() === '') {
        throw new Error(`command title cannot be empty: ${command.id}`)
      }
      if (ids.has(command.id)) {
        throw new Error(`command declared twice: ${command.id}`)
      }
      ids.add(command.id)
      if (command.keybinding) {
        this.#appleBindingToId.set(normalizeBinding(command.keybinding, true), command.id)
        this.#otherBindingToId.set(normalizeBinding(command.keybinding, false), command.id)
      }
    }
  }

  list(): Commands {
    return APP_COMMANDS
  }

  handle<Id extends AppCommandId>(id: Id, handler: AppCommands[Id], signal: AbortSignal): void {
    if (signal.aborted) {
      return
    }
    const stored = handler
    let stack = this.#handlers.get(id)
    if (stack === undefined) {
      stack = []
      this.#handlers.set(id, stack)
    }
    stack.push(stored)
    signal.addEventListener('abort', () => stack.splice(stack.lastIndexOf(stored), 1), {
      once: true,
    })
  }

  isHandled(id: AppCommandId): boolean {
    return this.#current(id) !== undefined
  }

  run<Id extends AppCommandId>(
    id: Id,
    ...args: Parameters<AppCommands[Id]>
  ): ReturnType<AppCommands[Id]> | undefined {
    const handler = this.#current(id)
    if (handler === undefined) {
      return undefined
    }
    return handler(...args) as ReturnType<AppCommands[Id]>
  }

  trigger(id: TriggerableCommandId): boolean {
    const block = this.#blocks.at(-1)
    if (block !== undefined && !block.includes(id)) {
      return false
    }
    const handler = this.#current(id)
    if (handler === undefined) {
      return false
    }
    void this.#settle(id, handler())
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

  commandForKeyDown(event: CommandKeyEvent): TriggerableCommandId | null {
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

  #current(id: AppCommandId): StoredHandler | undefined {
    return this.#handlers.get(id)?.at(-1)
  }

  async #settle(id: AppCommandId, result: unknown): Promise<void> {
    try {
      await result
    } catch (cause) {
      this.#deps.logger.error(`command failed: ${id}`, cause)
    }
  }
}

export function createCommandService(deps: CommandServiceDeps): CommandService {
  return new CommandServiceImpl(deps)
}
