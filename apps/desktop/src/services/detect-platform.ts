import type { AppPlatform, BuildPlatform, PlatformFacts } from '@reflect/core'
import type { ReflectHost } from '@/services/swift-events.ts'
import { version } from '../../package.json' with { type: 'json' }

function buildPlatformFromEnv(env: string): BuildPlatform | null {
  switch (env) {
    case 'darwin':
    case 'windows':
    case 'linux':
    case 'ios':
    case 'android':
      return env
    default:
      return null
  }
}

function envPlatform(env: string): AppPlatform {
  switch (env) {
    case 'ios':
      return 'ios'
    case 'android':
      return 'android'
    case 'windows':
    case 'linux':
    case 'darwin':
    case '':
      return 'desktop'
    default:
      console.warn('[reflect-open] Unknown environment variable TAURI_ENV_PLATFORM:', env)
      return 'desktop'
  }
}

// Plain-browser dev (no Tauri build target) may pick a UI family with `?platform=`.
function devPlatformOverride(env: string): AppPlatform | null {
  if (env || !import.meta.env.DEV || typeof window === 'undefined') {
    return null
  }
  const query = new URLSearchParams(window.location.search).get('platform')
  switch (query) {
    case 'ios':
      return 'ios'
    case 'android':
      return 'android'
    case 'desktop':
      return 'desktop'
  }
  if (query) {
    console.warn('[reflect-open] Unknown platform override in query string:', query)
  }
  return null
}

/**
 * The shell that hosts the webview: Tauri, the Swift iOS shell, or a plain
 * browser in dev.
 */
export type HostKind = 'tauri' | 'swift' | 'browser'

/**
 * The globals that tell the shells apart: Tauri sets `isTauri`, the Swift
 * shell injects `__reflectHost`.
 */
export interface HostGlobals {
  readonly isTauri?: boolean | undefined
  readonly __reflectHost?: ReflectHost | undefined
}

/**
 * Detect which shell hosts the webview from its globals.
 */
export function detectHostKind(globals: HostGlobals): HostKind {
  if (globals.isTauri === true) {
    return 'tauri'
  }
  if (globals.__reflectHost !== undefined) {
    return 'swift'
  }
  return 'browser'
}

/**
 * Detect the host's platform facts from the user agent and the build env.
 * `nativeShell` is true when Tauri or the Swift shell hosts the webview.
 *
 * The surface facets follow `appPlatform`, which is also what selects the
 * mobile root (`@platform-root` in `vite.config.ts`, `platform-root.unknown.tsx`
 * in plain-browser dev): the mobile tree and the mobile surface cannot disagree.
 */
export function detectPlatformFacts(nativeShell: boolean): PlatformFacts {
  const env = import.meta.env.TAURI_ENV_PLATFORM || ''
  const hasNavigator = typeof navigator !== 'undefined'
  // iPadOS masquerades as macOS in the user agent; the touch-point check excludes it.
  // TODO: the latest MacBook Pro released on November 6, 2026 has a touch screen. We need to double check this detection logic.
  const macosDesktop =
    nativeShell &&
    hasNavigator &&
    navigator.userAgent.includes('Macintosh') &&
    navigator.maxTouchPoints === 0

  const appPlatform = devPlatformOverride(env) ?? envPlatform(env)
  const mobile = appPlatform !== 'desktop'

  return {
    appPlatform,
    isNativeShell: nativeShell,
    buildPlatform: buildPlatformFromEnv(env),
    isMacosDesktop: macosDesktop,
    isApplePlatform:
      hasNavigator && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent),
    hasMacosTitleBarOverlay: macosDesktop,
    surface: { touchEditor: mobile, mobileApp: mobile },
    isDev: import.meta.env.DEV,
    appVersion: version,
  }
}
