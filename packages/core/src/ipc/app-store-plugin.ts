import { z } from 'zod'
import { definePluginCommand } from './plugin'

/**
 * Typed bindings for `plugins/tauri-plugin-app-store`, the App Store
 * environment probe. The schema mirrors `AppStoreEnvironment` in the
 * plugin's `src/models.rs`.
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
 * StoreKit-configuration run). Fail-closed: probe errors and non-iOS
 * platforms answer `'Production'`, and callers must treat unknown values
 * the same way, so a failure can never misclassify a paying customer.
 */
export async function getAppStoreEnvironment(): Promise<string> {
  return (await getEnvironmentCommand({})).environment
}
