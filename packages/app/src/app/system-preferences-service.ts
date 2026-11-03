import { deriveStore, type Store, type Unlisten } from '@reflect/core'

export type ColorScheme = 'light' | 'dark'

/**
 * The webview's reduced-motion and color-scheme preferences, live.
 */
export interface SystemPreferencesService {
  /**
   * Whether the user prefers reduced motion.
   */
  readonly reducedMotion: Store<boolean>
  /**
   * The system color scheme.
   */
  readonly colorScheme: Store<ColorScheme>
}

export interface PlatformMedia {
  readonly matchMedia?: (query: string) => MediaQueryList
}

export interface SystemPreferencesServiceDeps {
  readonly media?: PlatformMedia | undefined
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const DARK_QUERY = '(prefers-color-scheme: dark)'

// Resolved per call: the global `matchMedia` may be replaced after construction.
function resolveMatchMedia(
  media: PlatformMedia | undefined,
): ((query: string) => MediaQueryList) | undefined {
  if (media) {
    return media.matchMedia
  }
  if (typeof globalThis.matchMedia !== 'function') {
    return undefined
  }
  return (query) => globalThis.matchMedia(query)
}

function createMediaQueryStore(media: PlatformMedia | undefined, query: string): Store<boolean> {
  return {
    get: (): boolean => {
      const matchMedia = resolveMatchMedia(media)
      return matchMedia !== undefined && matchMedia(query).matches
    },
    subscribe: (listener: VoidFunction): Unlisten => {
      const list = resolveMatchMedia(media)?.(query)
      if (typeof list?.addEventListener !== 'function') {
        return () => {}
      }
      const controller = new AbortController()
      list.addEventListener('change', listener, { signal: controller.signal })
      return () => controller.abort()
    },
  }
}

class SystemPreferencesServiceImpl implements SystemPreferencesService {
  readonly reducedMotion: Store<boolean>
  readonly colorScheme: Store<ColorScheme>

  constructor(deps: SystemPreferencesServiceDeps) {
    const { media } = deps
    this.reducedMotion = createMediaQueryStore(media, REDUCED_MOTION_QUERY)
    this.colorScheme = deriveStore(createMediaQueryStore(media, DARK_QUERY), (dark) => {
      return dark ? 'dark' : 'light'
    })
  }
}

export function createSystemPreferencesService(
  deps: SystemPreferencesServiceDeps,
): SystemPreferencesService {
  return new SystemPreferencesServiceImpl(deps)
}
