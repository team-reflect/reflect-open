import { z, type ZodType } from 'zod'
import type { IpcBridgeService, PluginSubscription } from './ipc-service.ts'

/**
 * Typed bindings for the first-party plugins (`plugins/tauri-plugin-*`).
 * A plugin's commands are declared one per command (args type plus result
 * schema) and its events as schema-carrying subscriptions; per-plugin
 * modules (`recording-plugin.ts`, `haptics-service.ts`) export plain
 * functions on top so callers never see a `plugin:name|command` string or
 * an untyped payload.
 */

/**
 * A declared plugin command, invoked through the given {@link IpcBridgeService}.
 */
export type PluginCommand<Args extends Record<string, unknown>, Result> = (
  ipc: IpcBridgeService,
  args: Args,
) => Promise<Result>

/**
 * A declared plugin event, subscribed through the given {@link IpcBridgeService}.
 */
export type PluginEvent<Payload> = (
  ipc: IpcBridgeService,
  handler: (payload: Payload) => void,
) => PluginSubscription

/**
 * Build the typed caller for one plugin command. Args are typed but not
 * validated: the binding modules construct them, so a malformed args record
 * is a compile error, not a runtime case. The response still crosses the
 * IPC boundary untyped and funnels through {@link IpcBridgeService.call}:
 * validated against `resultSchema`, failures coerced to an `AppError` like
 * every other command.
 */
export function definePluginCommand<Args extends Record<string, unknown>, Result>(
  plugin: string,
  command: string,
  resultSchema: ZodType<Result, unknown>,
): PluginCommand<Args, Result> {
  return async (ipc, args) => {
    return await ipc.call(`plugin:${plugin}|${command}`, args, resultSchema)
  }
}

/**
 * Result schema for fire-and-forget commands: the acknowledgement payload
 * is deliberately not validated, so a future plugin response (a boolean
 * ack, a struct) cannot start rejecting calls whose result nobody reads.
 */
export const ignoredResult = z.unknown()

/**
 * Declare one plugin event: name plus payload schema, returning its
 * subscribe function. Registration sharing, retry, and malformed-payload
 * handling are {@link IpcBridgeService.subscribePlugin}'s.
 */
export function definePluginEvent<Payload>(
  plugin: string,
  event: string,
  schema: ZodType<Payload, unknown>,
): PluginEvent<Payload> {
  return (ipc, handler) => ipc.subscribePlugin(plugin, event, schema, handler)
}
