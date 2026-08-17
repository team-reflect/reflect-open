import { definePluginCommand, ignoredResult } from './plugin'

/**
 * Typed bindings for `plugins/tauri-plugin-keyboard`. Only haptics has a JS
 * surface: the keyboard height is derived from `visualViewport` on the web
 * side (decision 0003), and the plugin's remaining keyboard work is native
 * webview tuning with no IPC.
 */

const impactLightCommand = definePluginCommand<Record<string, never>, unknown>(
  'keyboard',
  'impact_light',
  ignoredResult,
)

/** Fire a light impact haptic (a no-op wherever there is no haptic engine). */
export async function impactLight(): Promise<void> {
  await impactLightCommand({})
}
