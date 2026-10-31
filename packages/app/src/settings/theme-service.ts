import type { SettingsService, StorageService, ThemePreference, Unlisten } from '@reflect/core'
import type { ColorScheme, PlatformService } from '../app/platform-service.ts'

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
 * The app theme: the `theme` setting resolved against the system color
 * scheme. After a successful settings load, the preference (not the resolved
 * theme) is mirrored into local storage so the next launch can paint it
 * before the settings arrive. After a failed load nothing is mirrored,
 * because changes are session-only.
 */
export interface ThemeService {
  preference: () => ThemePreference
  resolved: () => ResolvedTheme
  /**
   * True once the settings load has ended, successfully or not.
   */
  settled: () => boolean
  setPreference: (preference: ThemePreference) => void
  /**
   * Calls `listener` after the preference, the resolved theme, or `settled()` changes.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Resolves once the settings load has ended, successfully or not.
   */
  whenSettled(): Promise<void>
}

export interface ThemeServiceDeps {
  readonly settings: SettingsService
  readonly storage: StorageService
  readonly platform: PlatformService
}

class ThemeServiceImpl implements ThemeService {
  readonly #deps: ThemeServiceDeps
  readonly #listeners = new Set<() => void>()
  #started = false
  #system: ColorScheme = 'light'
  #preference: ThemePreference = 'system'
  #isSettled = false
  #mirrored: ThemePreference | null = null

  constructor(deps: ThemeServiceDeps) {
    this.#deps = deps
  }

  readonly preference = (): ThemePreference => {
    this.#start()
    return this.#preference
  }

  readonly resolved = (): ResolvedTheme => {
    this.#start()
    return this.#resolve()
  }

  readonly settled = (): boolean => {
    this.#start()
    return this.#isSettled
  }

  readonly setPreference = (preference: ThemePreference): void => {
    this.#start()
    this.#deps.settings.update({ theme: preference })
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#start()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async whenSettled(): Promise<void> {
    this.#start()
    await this.#deps.settings.whenLoaded()
  }

  #resolve(): ResolvedTheme {
    return this.#preference === 'system' ? this.#system : this.#preference
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #sync(): void {
    const { settings, storage } = this.#deps
    const previous = {
      preference: this.#preference,
      resolved: this.#resolve(),
      settled: this.#isSettled,
    }
    this.#preference = settings.get().theme
    const status = settings.status()
    this.#isSettled = status !== 'loading'
    if (status === 'loaded' && this.#mirrored !== this.#preference) {
      this.#mirrored = this.#preference
      storage.local.set(THEME_PREFERENCE_CACHE_KEY, this.#preference)
    }
    if (
      previous.preference !== this.#preference ||
      previous.resolved !== this.#resolve() ||
      previous.settled !== this.#isSettled
    ) {
      this.#notify()
    }
  }

  #start(): void {
    const { settings, platform } = this.#deps
    if (this.#started) {
      return
    }
    this.#started = true
    this.#system = platform.colorScheme()
    platform.subscribeColorScheme((value) => {
      if (value === this.#system) {
        return
      }
      const before = this.#resolve()
      this.#system = value
      if (this.#resolve() !== before) {
        this.#notify()
      }
    })
    settings.subscribe(() => {
      this.#sync()
    })
    this.#sync()
  }
}

export function createThemeService(deps: ThemeServiceDeps): ThemeService {
  return new ThemeServiceImpl(deps)
}
