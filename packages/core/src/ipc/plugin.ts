import type { ZodType } from 'zod'
import type { IpcBridgeService, PluginSubscription } from './ipc-service.ts'

/**
 * Typed subscriptions to the plugin events (`plugin:<name>:<event>`) that the
 * iOS app emits (`apps/ios/Sources/Capabilities/`). The plugin commands are
 * rows of the command table.
 */

/**
 * A declared plugin event, subscribed through the given {@link IpcBridgeService}.
 */
export type PluginEvent<Payload> = (
  ipc: IpcBridgeService,
  handler: (payload: Payload) => void,
) => PluginSubscription

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
