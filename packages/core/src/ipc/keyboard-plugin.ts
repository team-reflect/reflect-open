import { z } from 'zod'
import { definePluginCommands, definePluginEvent } from './plugin'

/**
 * Typed bindings for `plugins/tauri-plugin-keyboard` — the mobile keyboard
 * bridge (Plan 19 decision 8) plus the app's single haptic. Schemas mirror
 * `KeyboardState` in the plugin's `src/models.rs`, which is also the
 * `keyboardChange` event payload.
 */

/** Mirrors `KeyboardState`: keyboard overlap in px, animation duration in s. */
const keyboardStateSchema = z.object({ height: z.number(), duration: z.number() })
export type KeyboardState = z.infer<typeof keyboardStateSchema>

const callKeyboard = definePluginCommands('keyboard', {
  current_height: { args: z.object({}), result: keyboardStateSchema },
  impact_light: { args: z.object({}), result: z.null() },
})

/** Mount-time keyboard state; live changes arrive on `keyboardChange`. */
export async function currentKeyboardState(): Promise<KeyboardState> {
  return await callKeyboard('current_height', {})
}

/** Fire a light impact haptic (a no-op wherever there is no haptic engine). */
export async function impactLight(): Promise<void> {
  await callKeyboard('impact_light', {})
}

export const subscribeKeyboardChange = definePluginEvent(
  'keyboard',
  'keyboardChange',
  keyboardStateSchema,
)
