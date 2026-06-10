import { z } from 'zod'
import { call } from '../ipc/invoke'
import { settingsSchema, type Settings } from './schema'

/** Commands that return `()` from Rust serialize as `null` over IPC. */
const voidSchema = z.null()

/**
 * Load the persisted user settings, normalized through the schema: a fresh
 * install (empty document) and a document with missing or invalid values both
 * come back fully defaulted, never as an error.
 */
export async function loadSettings(): Promise<Settings> {
  return call('settings_load', {}, settingsSchema)
}

/**
 * Atomically replace the persisted settings document. Callers pass the full
 * document (typically the loaded settings plus the changed key) so unknown
 * keys from newer app versions survive the round trip.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  await call('settings_save', { settings }, voidSchema)
}
