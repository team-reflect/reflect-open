import { z } from 'zod'
import { definePluginCommand, definePluginEvent, ignoredResult } from './plugin'

/**
 * Typed bindings for `plugins/tauri-plugin-keyboard` — the software-keyboard
 * bridge (Plan 19 decision 8) plus the app's single haptic. Schemas mirror
 * `KeyboardState` in the plugin's `src/models.rs`, which is also the
 * `keyboardChange` event payload.
 */

/** Mirrors `KeyboardState`: keyboard overlap in px, animation duration in s. */
const keyboardStateSchema = z.object({ height: z.number(), duration: z.number() })
export type KeyboardState = z.infer<typeof keyboardStateSchema>

const currentHeightCommand = definePluginCommand<Record<string, never>, KeyboardState>(
  'keyboard',
  'current_height',
  keyboardStateSchema,
)
const impactLightCommand = definePluginCommand<Record<string, never>, unknown>(
  'keyboard',
  'impact_light',
  ignoredResult,
)

/** Mount-time keyboard state; live changes arrive on `keyboardChange`. */
export async function getCurrentKeyboardHeight(): Promise<KeyboardState> {
  return await currentHeightCommand({})
}

/** Fire a light impact haptic (a no-op wherever there is no haptic engine). */
export async function impactLight(): Promise<void> {
  await impactLightCommand({})
}

export const subscribeKeyboardChange = definePluginEvent(
  'keyboard',
  'keyboardChange',
  keyboardStateSchema,
)
