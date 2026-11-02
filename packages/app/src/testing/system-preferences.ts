import { WritableStore } from '@reflect/core'
import type { ColorScheme, SystemPreferencesService } from '../app/system-preferences-service.ts'

export interface TestSystemPreferencesOptions {
  reducedMotion?: boolean
  colorScheme?: ColorScheme
}

/**
 * System preferences that a test sets with `set` on each store.
 */
export interface TestSystemPreferencesService extends SystemPreferencesService {
  readonly reducedMotion: WritableStore<boolean>
  readonly colorScheme: WritableStore<ColorScheme>
}

/**
 * Defaults to no reduced motion and a light color scheme.
 */
export function createTestSystemPreferencesService(
  options?: TestSystemPreferencesOptions,
): TestSystemPreferencesService {
  return {
    reducedMotion: new WritableStore(options?.reducedMotion ?? false),
    colorScheme: new WritableStore<ColorScheme>(options?.colorScheme ?? 'light'),
  }
}
