import type { ZodType } from 'zod'
import type { AppError } from '../errors'
import { getBridge, type IpcBridge, type Unlisten } from './bridge'
import { call } from './invoke'

/**
 * Typed bindings for the first-party mobile plugins
 * (`plugins/tauri-plugin-*`). A plugin's commands are declared once as a
 * contract map — command name to args/result schemas — and its events as
 * schema-carrying subscriptions; per-plugin modules (`recording-plugin.ts`,
 * `keyboard-plugin.ts`) export plain functions on top so callers never see a
 * `plugin:name|command` string or an untyped payload.
 */

// Structural aliases for a schema's parameter and result types. Zod exposes
// the same as `z.input`/`z.output`; the conditional form keeps this module's
// zod import type-only.
type SchemaInput<Schema> = Schema extends ZodType<unknown, infer Input> ? Input : never
type SchemaOutput<Schema> = Schema extends ZodType<infer Output, unknown> ? Output : never

/**
 * One command in a plugin's contract: the schema for the args record the
 * webview sends (`z.object({})` for commands that take none) and the schema
 * for the raw response — `z.null()` for a Rust `Result<()>`.
 */
export interface PluginCommandSpec {
  args: ZodType<Record<string, unknown>, unknown>
  result: ZodType<unknown, unknown>
}

/**
 * Build the typed caller for one mobile plugin from its command contract.
 * The returned function composes `plugin:<plugin>|<command>` itself, parses
 * the outgoing args (a malformed args record is a caller bug and throws
 * loudly), and funnels through {@link call} — so responses are validated and
 * failures arrive as {@link AppError} like every other command.
 */
export function definePluginCommands<Commands extends Record<string, PluginCommandSpec>>(
  plugin: string,
  commands: Commands,
): <Name extends keyof Commands & string>(
  command: Name,
  args: SchemaInput<Commands[Name]['args']>,
) => Promise<SchemaOutput<Commands[Name]['result']>> {
  return async <Name extends keyof Commands & string>(
    command: Name,
    args: SchemaInput<Commands[Name]['args']>,
  ): Promise<SchemaOutput<Commands[Name]['result']>> => {
    // `Name` is `keyof Commands`, so the lookup can't miss; the constraint's
    // index signature just hides that from the checker.
    const spec = commands[command]!
    // Inside the generic body the indexed schema types are opaque; `call`
    // validates with the exact runtime schema, so the assertion only restates
    // what the contract already guarantees.
    return (await call(
      `plugin:${plugin}|${command}`,
      spec.args.parse(args),
      spec.result,
    )) as SchemaOutput<Commands[Name]['result']>
  }
}

/**
 * A live plugin-event subscription. Registration is asynchronous (an IPC
 * round-trip) and shared per event, so the two concerns are split: `ready`
 * reports the (possibly shared) registration outcome; `unlisten` is a
 * purely local, synchronous detach from the fan-out. There is no native
 * unregistration that could fail: the underlying listener is kept for the
 * bridge's lifetime (see `IpcBridge.listenPlugin`). Callers should observe
 * `ready` (`void sub.ready.catch(...)`) to log a host without the event
 * stream.
 */
export interface PluginSubscription {
  ready: Promise<void>
  unlisten: Unlisten
}

/**
 * Declare one plugin event: name plus payload schema, returning its
 * subscribe function. All subscribers of an event share one native
 * registration per bridge, created on the first subscribe and kept alive
 * afterwards; a failed registration is dropped from the cache so the next
 * subscriber retries instead of inheriting a dead event for the whole
 * session. Payloads that fail validation are dropped (native emitters are
 * trusted; a mismatch means contract drift, not user error).
 */
export function definePluginEvent<Payload>(
  plugin: string,
  event: string,
  schema: ZodType<Payload, unknown>,
): (handler: (payload: Payload) => void) => PluginSubscription {
  interface SharedListener {
    ready: Promise<void>
    handlers: Set<(payload: Payload) => void>
  }
  // REVIEW: "shared" should be placed in the root level and it should have type: `WeakMap<IpcBridge, Map<EventName, SharedListener>>`. Also rename this var so that it is not called as "shared"
  // swapped bridge must never inherit another bridge's registration.
  const shared = new WeakMap<IpcBridge, SharedListener>()

  function sharedListener(bridge: IpcBridge): SharedListener {
    const existing = shared.get(bridge)
    if (existing !== undefined) {
      return existing
    }
    const handlers = new Set<(payload: Payload) => void>()
    const entry: SharedListener = {
      handlers,
      ready: (async () => {
        if (bridge.listenPlugin === undefined) {
          const appError: AppError = {
            kind: 'io',
            message: `the installed IPC bridge has no plugin events for "${plugin}:${event}"`,
          }
          throw appError
        }
        await bridge.listenPlugin(plugin, event, (raw) => {
          const parsed = schema.safeParse(raw)
          if (!parsed.success) {
            // REVIEW: print console.warn if the payload is invalid
            return
          }
          for (const handler of handlers) {
            handler(parsed.data)
          }
        })
      })(),
    }
    // Drop a failed registration so the next subscriber retries. This catch
    // also keeps an unobserved rejection from surfacing as unhandled;
    // subscribers that do await ready still see it.
    entry.ready.catch(() => {
      shared.delete(bridge)
    })
    shared.set(bridge, entry)
    return entry
  }

  return (handler) => {
    const entry = sharedListener(getBridge())
    // Wrapped for identity: two subscriptions sharing one handler function
    // must detach independently.
    const deliver = (payload: Payload): void => {
      handler(payload)
    }
    entry.handlers.add(deliver)
    return {
      ready: entry.ready,
      unlisten: () => {
        entry.handlers.delete(deliver)
      },
    }
  }
}
