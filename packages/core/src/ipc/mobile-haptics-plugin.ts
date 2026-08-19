import { definePluginCommand, ignoredResult } from './plugin'

/**
 * Typed bindings for `plugins/tauri-plugin-mobile-haptics`, the app's
 * single haptic.
 */

const impactLightCommand = definePluginCommand<Record<string, never>, unknown>(
  'mobile-haptics',
  'impact_light',
  ignoredResult,
)

/** Fire a light impact haptic (a no-op wherever there is no haptic engine). */
export async function impactLight(): Promise<void> {
  await impactLightCommand({})
}
