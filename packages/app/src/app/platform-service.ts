import type { PlatformFacts } from '@reflect/core'

export type ColorScheme = 'light' | 'dark'

/**
 * The platform facts plus the webview's reduced-motion and color-scheme signals.
 */
export interface PlatformService extends PlatformFacts {
  prefersReducedMotion(): boolean
  subscribeReducedMotion(listener: (value: boolean) => void): () => void
  colorScheme(): ColorScheme
  subscribeColorScheme(listener: (value: ColorScheme) => void): () => void
}

export interface PlatformMedia {
  readonly matchMedia?: (query: string) => MediaQueryList
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export interface PlatformServiceDeps {
  readonly facts: PlatformFacts
  readonly media?: PlatformMedia | undefined
}

class PlatformServiceImpl implements PlatformService {
  readonly #media: PlatformMedia | undefined

  readonly appPlatform: PlatformFacts['appPlatform']
  readonly isNativeShell: boolean
  readonly buildPlatform: PlatformFacts['buildPlatform']
  readonly isMacosDesktop: boolean
  readonly isApplePlatform: boolean
  readonly hasMacosTitleBarOverlay: boolean
  readonly surface: PlatformFacts['surface']
  readonly isDev: boolean
  readonly appVersion: string

  constructor(deps: PlatformServiceDeps) {
    const { facts, media } = deps
    this.#media = media
    this.appPlatform = facts.appPlatform
    this.isNativeShell = facts.isNativeShell
    this.buildPlatform = facts.buildPlatform
    this.isMacosDesktop = facts.isMacosDesktop
    this.isApplePlatform = facts.isApplePlatform
    this.hasMacosTitleBarOverlay = facts.hasMacosTitleBarOverlay
    this.surface = { touchEditor: facts.surface.touchEditor, mobileApp: facts.surface.mobileApp }
    this.isDev = facts.isDev
    this.appVersion = facts.appVersion
  }

  prefersReducedMotion(): boolean {
    return this.#matches(REDUCED_MOTION_QUERY)
  }

  subscribeReducedMotion(listener: (value: boolean) => void): () => void {
    return this.#subscribe(REDUCED_MOTION_QUERY, listener)
  }

  colorScheme(): ColorScheme {
    return this.#matches(DARK_QUERY) ? 'dark' : 'light'
  }

  subscribeColorScheme(listener: (value: ColorScheme) => void): () => void {
    return this.#subscribe(DARK_QUERY, (dark) => listener(dark ? 'dark' : 'light'))
  }

  // Resolved per call: the global `matchMedia` may be replaced after construction.
  #resolveMatchMedia(): ((query: string) => MediaQueryList) | undefined {
    if (this.#media) {
      return this.#media.matchMedia
    }
    if (typeof globalThis.matchMedia !== 'function') {
      return undefined
    }
    return (query) => globalThis.matchMedia(query)
  }

  #matches(query: string): boolean {
    const matchMedia = this.#resolveMatchMedia()
    return matchMedia !== undefined && matchMedia(query).matches
  }

  #subscribe(query: string, onChange: (matches: boolean) => void): () => void {
    const matchMedia = this.#resolveMatchMedia()
    if (matchMedia === undefined) {
      return () => {}
    }
    const list = matchMedia(query)
    const handler = (event: MediaQueryListEvent): void => onChange(event.matches)
    // Older WebKit exposes only the deprecated listener API.
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', handler)
      return () => list.removeEventListener('change', handler)
    }
    list.addListener(handler)
    return () => list.removeListener(handler)
  }
}

export function createPlatformService(deps: PlatformServiceDeps): PlatformService {
  return new PlatformServiceImpl(deps)
}
