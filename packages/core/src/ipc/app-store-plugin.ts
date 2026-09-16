import { z } from 'zod'
import { definePluginCommand, ignoredResult } from './plugin'

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

const syncCommand = definePluginCommand<Record<string, never>, unknown>(
  'app-store',
  'sync',
  ignoredResult,
)

/**
 * Force StoreKit to refetch transactions from the App Store
 * (`AppStore.sync()`). Apple may show a sign-in prompt, so call it only from
 * an explicit user action such as Restore Purchases.
 */
export async function syncAppStore(): Promise<void> {
  await syncCommand({})
}
