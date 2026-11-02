import { isShallowEqual } from '@ocavue/utils'
import {
  combineStores,
  type Settings,
  type SettingsLoadOutcome,
  type SettingsService,
  type StorageService,
  type Store,
  type ThemePreference,
  type Unlisten,
} from '@reflect/core'
import type { ColorScheme, SystemPreferencesService } from '../app/system-preferences-service.ts'

/**
 * The concrete theme applied to the document.
 */
export type ResolvedTheme = ColorScheme

/**
 * The local storage key that mirrors the theme preference for the next
 * launch. `public/theme-init.js` repeats this literal, because it runs
 * unbundled before the app boots.
 */
export const THEME_PREFERENCE_CACHE_KEY = 'reflect.theme.preference'

/**
 * The theme preference and the concrete theme it resolves to.
 */
export interface ThemeState {
  readonly preference: ThemePreference
  readonly resolved: ResolvedTheme
  /**
   * True once the settings load has ended, successfully or not.
   */
  readonly settled: boolean
}

/**
 * The app theme: the `theme` setting resolved against the system color
 * scheme. While subscribed and after a successful settings load, the
 * preference (not the resolved theme) is mirrored into local storage so the
 * next launch can paint it before the settings arrive. After a failed load
 * nothing is mirrored, because changes are session-only.
 */
export interface ThemeService extends Store<ThemeState> {
  setPreference: (preference: ThemePreference) => void
  /**
   * Sets the preference to the opposite of the resolved theme.
   */
  toggleTheme: () => void
  /**
   * Resolves once the settings load has ended, successfully or not.
   */
  whenSettled(): Promise<void>
}

export interface ThemeServiceDeps {
  readonly settings: SettingsService
  readonly storage: StorageService
  readonly systemPreferences: SystemPreferencesService
}

type SettingsStatus = SettingsLoadOutcome | 'loading'

function resolveTheme(settings: Settings, status: SettingsStatus, system: ColorScheme): ThemeState {
  return {
    preference: settings.theme,
    resolved: settings.theme === 'system' ? system : settings.theme,
    settled: status !== 'loading',
  }
}

/**
 * The preference to mirror into local storage, or `null` until a successful load.
 */
function selectMirroredPreference(
  settings: Settings,
  status: SettingsStatus,
): ThemePreference | null {
  return status === 'loaded' ? settings.theme : null
}

class ThemeServiceImpl implements ThemeService {
  readonly #deps: ThemeServiceDeps
  readonly #theme: Store<ThemeState>
  readonly #mirror: Store<ThemePreference | null>
  #mirrored: ThemePreference | null = null

  constructor(deps: ThemeServiceDeps) {
    this.#deps = deps
    this.#theme = combineStores(
      [deps.settings, deps.settings.status, deps.systemPreferences.colorScheme],
      resolveTheme,
      isShallowEqual,
    )
    this.#mirror = combineStores([deps.settings, deps.settings.status], selectMirroredPreference)
  }

  readonly get = (): ThemeState => {
    return this.#theme.get()
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    const unlistenMirror = this.#mirror.subscribe(() => {
      this.#writeMirror()
    })
    const unlisten = this.#theme.subscribe(listener)
    this.#writeMirror()
    return () => {
      unlistenMirror()
      unlisten()
    }
  }

  readonly setPreference = (preference: ThemePreference): void => {
    this.#deps.settings.update({ theme: preference })
  }

  readonly toggleTheme = (): void => {
    this.setPreference(this.get().resolved === 'dark' ? 'light' : 'dark')
  }

  async whenSettled(): Promise<void> {
    await this.#deps.settings.whenLoaded()
  }

  #writeMirror(): void {
    const preference = this.#mirror.get()
    if (preference !== null && preference !== this.#mirrored) {
      this.#mirrored = preference
      this.#deps.storage.local.set(THEME_PREFERENCE_CACHE_KEY, preference)
    }
  }
}

export function createThemeService(deps: ThemeServiceDeps): ThemeService {
  return new ThemeServiceImpl(deps)
}
