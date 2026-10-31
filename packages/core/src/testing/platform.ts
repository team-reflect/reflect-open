import { appleFileSrc, type FileSrcSource } from '../ports/file-src.ts'
import type {
  AppPlatform,
  BuildPlatform,
  PlatformFacts,
  PlatformSurface,
} from '../ports/platform-facts.ts'

type ColorScheme = 'light' | 'dark'

export interface TestPlatformOptions extends Partial<Omit<PlatformFacts, 'surface'>> {
  surface?: Partial<PlatformSurface>
  reducedMotion?: boolean
  colorScheme?: ColorScheme
}

/**
 * Platform facts that also answer the file URL and the webview's
 * reduced-motion and color-scheme signals, so one double serves both layers.
 */
export interface TestPlatformService extends PlatformFacts, FileSrcSource {
  prefersReducedMotion(): boolean
  subscribeReducedMotion(listener: (value: boolean) => void): () => void
  colorScheme(): ColorScheme
  subscribeColorScheme(listener: (value: ColorScheme) => void): () => void
  /**
   * Change the reduced-motion preference and notify subscribers.
   */
  setReducedMotion(value: boolean): void
  /**
   * Change the color scheme and notify subscribers.
   */
  setColorScheme(value: ColorScheme): void
}

class TestPlatformServiceImpl implements TestPlatformService {
  #reducedMotion: boolean
  #colorScheme: ColorScheme
  readonly #reducedMotionListeners = new Set<(value: boolean) => void>()
  readonly #colorSchemeListeners = new Set<(value: ColorScheme) => void>()

  readonly appPlatform: AppPlatform
  readonly isNativeShell: boolean
  readonly buildPlatform: BuildPlatform | null
  readonly isMacosDesktop: boolean
  readonly isApplePlatform: boolean
  readonly hasMacosTitleBarOverlay: boolean
  readonly surface: PlatformSurface
  readonly isDev: boolean
  readonly appVersion: string

  constructor(options: TestPlatformOptions) {
    this.#reducedMotion = options.reducedMotion ?? false
    this.#colorScheme = options.colorScheme ?? 'light'
    this.appPlatform = options.appPlatform ?? 'desktop'
    this.isNativeShell = options.isNativeShell ?? true
    this.buildPlatform = options.buildPlatform ?? 'darwin'
    this.isMacosDesktop = options.isMacosDesktop ?? true
    this.isApplePlatform = options.isApplePlatform ?? true
    this.hasMacosTitleBarOverlay = options.hasMacosTitleBarOverlay ?? true
    this.surface = {
      touchEditor: options.surface?.touchEditor ?? false,
      mobileApp: options.surface?.mobileApp ?? false,
    }
    this.isDev = options.isDev ?? false
    this.appVersion = options.appVersion ?? '0.0.0-test'
  }

  convertFileSrc(filePath: string, protocol: string): string {
    return appleFileSrc(filePath, protocol)
  }

  prefersReducedMotion(): boolean {
    return this.#reducedMotion
  }

  subscribeReducedMotion(listener: (value: boolean) => void): () => void {
    this.#reducedMotionListeners.add(listener)
    return () => this.#reducedMotionListeners.delete(listener)
  }

  colorScheme(): ColorScheme {
    return this.#colorScheme
  }

  subscribeColorScheme(listener: (value: ColorScheme) => void): () => void {
    this.#colorSchemeListeners.add(listener)
    return () => this.#colorSchemeListeners.delete(listener)
  }

  setReducedMotion(value: boolean): void {
    if (value === this.#reducedMotion) {
      return
    }
    this.#reducedMotion = value
    for (const listener of this.#reducedMotionListeners) {
      listener(value)
    }
  }

  setColorScheme(value: ColorScheme): void {
    if (value === this.#colorScheme) {
      return
    }
    this.#colorScheme = value
    for (const listener of this.#colorSchemeListeners) {
      listener(value)
    }
  }
}

/**
 * A test platform with fixed facts; defaults to a macOS desktop native shell.
 */
export function createTestPlatformService(options: TestPlatformOptions = {}): TestPlatformService {
  return new TestPlatformServiceImpl(options)
}
