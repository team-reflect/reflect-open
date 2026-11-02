import {
  combineStores,
  WritableStore,
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
 * scheme. After a successful settings load, the preference (not the resolved
 * theme) is mirrored into local storage so the next launch can paint it
 * before the settings arrive. After a failed load nothing is mirrored,
 * because changes are session-only.
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

interface ThemeSourceState {
  readonly preference: ThemePreference
  readonly settled: boolean
}

function resolveTheme(state: ThemeSourceState, system: ColorScheme): ThemeState {
  return {
    preference: state.preference,
    resolved: state.preference === 'system' ? system : state.preference,
    settled: state.settled,
  }
}

function isThemeStateEqual(a: ThemeState, b: ThemeState): boolean {
  return a.preference === b.preference && a.resolved === b.resolved && a.settled === b.settled
}

class ThemeServiceImpl implements ThemeService {
  readonly #deps: ThemeServiceDeps
  readonly #state = new WritableStore<ThemeSourceState>({
    preference: 'system',
    settled: false,
  })
  readonly #theme: Store<ThemeState>
  #started = false
  #mirrored: ThemePreference | null = null

  constructor(deps: ThemeServiceDeps) {
    this.#deps = deps
    this.#theme = combineStores(
      [this.#state, deps.systemPreferences.colorScheme],
      resolveTheme,
      isThemeStateEqual,
    )
  }

  readonly get = (): ThemeState => {
    this.#start()
    return this.#theme.get()
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    this.#start()
    return this.#theme.subscribe(listener)
  }

  readonly setPreference = (preference: ThemePreference): void => {
    this.#start()
    this.#deps.settings.update({ theme: preference })
  }

  readonly toggleTheme = (): void => {
    this.setPreference(this.get().resolved === 'dark' ? 'light' : 'dark')
  }

  async whenSettled(): Promise<void> {
    this.#start()
    await this.#deps.settings.whenLoaded()
  }

  #setState(patch: Partial<ThemeSourceState>): void {
    this.#state.set({ ...this.#state.get(), ...patch })
  }

  #sync(): void {
    const { settings, storage } = this.#deps
    const preference = settings.get().theme
    const status = settings.status.get()
    if (status === 'loaded' && this.#mirrored !== preference) {
      this.#mirrored = preference
      storage.local.set(THEME_PREFERENCE_CACHE_KEY, preference)
    }
    this.#setState({ preference, settled: status !== 'loading' })
  }

  #start(): void {
    const { settings } = this.#deps
    if (this.#started) {
      return
    }
    this.#started = true
    settings.subscribe(() => {
      this.#sync()
    })
    settings.status.subscribe(() => {
      this.#sync()
    })
    this.#sync()
  }
}

export function createThemeService(deps: ThemeServiceDeps): ThemeService {
  return new ThemeServiceImpl(deps)
}
