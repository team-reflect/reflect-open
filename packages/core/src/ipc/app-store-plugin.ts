import { z } from 'zod'
import { definePluginCommand } from './plugin'

/**
 * Typed bindings for `plugins/tauri-plugin-app-store`, the install-channel
 * probe.
 */

const appStoreEnvironmentSchema = z.object({ environment: z.string() })

const getEnvironmentCommand = definePluginCommand<Record<string, never>, { environment: string }>(
  'app-store',
  'get_environment',
  appStoreEnvironmentSchema,
)

/**
 * Which channel installed this build, per StoreKit 2's
 * `AppTransaction.environment`: `'Production'` (App Store), `'Sandbox'`
 * (TestFlight or a development install), or `'Xcode'` (a
 * StoreKit-configuration run). Rejects when the probe cannot answer, so an
 * unanswered probe stays distinguishable from a named channel.
 */
export async function getAppStoreEnvironment(): Promise<string> {
  return (await getEnvironmentCommand({})).environment
}
