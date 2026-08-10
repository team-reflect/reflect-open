import { z, type ZodType } from 'zod'
import type { AppError } from '../errors'
import { getBridge, type IpcBridge, type Unlisten } from './bridge'
import { call } from './invoke'

/**
 * Typed bindings for the first-party plugins (`plugins/tauri-plugin-*`).
 * A plugin's commands are declared one per command (args type plus result
 * schema) and its events as schema-carrying subscriptions; per-plugin
 * modules (`recording-plugin.ts`, `keyboard-plugin.ts`) export plain
 * functions on top so callers never see a `plugin:name|command` string or
 * an untyped payload.
 */

/**
 * Build the typed caller for one plugin command. Args are typed but not
 * validated: the binding modules construct them, so a malformed args record
 * is a compile error, not a runtime case. The response still crosses the
 * IPC boundary untyped and funnels through {@link call}: validated against
 * `resultSchema`, failures coerced to {@link AppError} like every other
 * command.
 */
export function definePluginCommand<Args extends Record<string, unknown>, Result>(
  plugin: string,
  command: string,
  resultSchema: ZodType<Result, unknown>,
): (args: Args) => Promise<Result> {
  return async (args) => {
    return await call(`plugin:${plugin}|${command}`, args, resultSchema)
  }
}

/**
 * Result schema for fire-and-forget commands: the acknowledgement payload
 * is deliberately not validated, so a future plugin response (a boolean
 * ack, a struct) cannot start rejecting calls whose result nobody reads.
 */
export const ignoredResult = z.unknown()

/**
 * A live plugin-event subscription. Registration is asynchronous (an IPC
 * round-trip) and shared per event, so the two concerns are split: `ready`
 * reports the (possibly shared) registration outcome; `unlisten` is a
 * purely local, synchronous detach from the fan-out. There is no native
 * unregistration that could fail: the underlying listener is kept for the
 * bridge's lifetime. Callers should observe
 * `ready` (`void sub.ready.catch(...)`) to log a host without the event
 * stream.
 */
export interface PluginSubscription {
  ready: Promise<void>
  unlisten: Unlisten
}

interface SharedListener<Payload> {
  ready: Promise<void>
  handlers: Set<(payload: Payload) => void>
}

// The shared native registrations, one per (bridge, plugin event). Keyed by
// bridge identity first: tests install a fresh bridge per test, and a
// swapped bridge must never inherit another bridge's registration. The inner
// map is heterogeneous (each event key carries its own payload type), so
// entries are stored erased; `getOrCreateSharedListener` is the only reader
// and restores the type its schema defines.
const pluginListeners = new WeakMap<IpcBridge, Map<string, SharedListener<never>>>()

/**
 * Register the shared native listener for one plugin event, fanning payloads
 * out to `handlers`. On failure the entry is removed from
 * {@link pluginListeners} and the error is rethrown, so every subscriber
 * awaiting `ready` sees it and the next subscriber retries instead of
 * inheriting a dead event for the whole session.
 */
async function registerSharedListener<Payload>(
  bridge: IpcBridge,
  plugin: string,
  event: string,
  schema: ZodType<Payload, unknown>,
  handlers: Set<(payload: Payload) => void>,
): Promise<void> {
  try {
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
        console.warn(`dropping a malformed "${plugin}:${event}" payload:`, parsed.error)
        return
      }
      for (const handler of handlers) {
        handler(parsed.data)
      }
    })
  } catch (error) {
    // A missing `listenPlugin` fails before the entry is cached, making this
    // delete a no-op; caching that rejection is still right, because the
    // bridge will never gain plugin events.
    pluginListeners.get(bridge)?.delete(`${plugin}:${event}`)
    throw error
  }
}

function getOrCreateSharedListener<Payload>(
  bridge: IpcBridge,
  plugin: string,
  event: string,
  schema: ZodType<Payload, unknown>,
): SharedListener<Payload> {
  let events = pluginListeners.get(bridge)
  if (events === undefined) {
    events = new Map()
    pluginListeners.set(bridge, events)
  }
  const key = `${plugin}:${event}`
  const existing = events.get(key)
  if (existing !== undefined) {
    return existing as SharedListener<Payload>
  }
  const handlers = new Set<(payload: Payload) => void>()
  const entry: SharedListener<Payload> = {
    handlers,
    ready: registerSharedListener(bridge, plugin, event, schema, handlers),
  }
  events.set(key, entry as SharedListener<never>)
  return entry
}

/**
 * Declare one plugin event: name plus payload schema, returning its
 * subscribe function. All subscribers of an event share one native
 * registration per bridge, created on the first subscribe and kept alive
 * afterwards; a failed registration is dropped from the registry so the next
 * subscriber retries instead of inheriting a dead event for the whole
 * session. Payloads that fail validation are dropped with a `console.warn`
 * (native emitters are trusted; a mismatch means contract drift, not user
 * error).
 */
export function definePluginEvent<Payload>(
  plugin: string,
  event: string,
  schema: ZodType<Payload, unknown>,
): (handler: (payload: Payload) => void) => PluginSubscription {
  return (handler) => {
    const entry = getOrCreateSharedListener(getBridge(), plugin, event, schema)
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
