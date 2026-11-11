import type { AppPlatform, BuildPlatform, PlatformFacts } from '@reflect/core'
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

interface DevPlatformOverride {
  readonly appPlatform: AppPlatform
  readonly tablet: boolean
}

// Plain-browser dev (no Tauri build target) may pick a UI family with `?platform=`;
// `ipad` is the iOS app on a tablet.
function devPlatformOverride(env: string): DevPlatformOverride | null {
  if (env || !import.meta.env.DEV || typeof window === 'undefined') {
    return null
  }
  const query = new URLSearchParams(window.location.search).get('platform')
  switch (query) {
    case 'ios':
      return { appPlatform: 'ios', tablet: false }
    case 'ipad':
      return { appPlatform: 'ios', tablet: true }
    case 'android':
      return { appPlatform: 'android', tablet: false }
    case 'desktop':
      return { appPlatform: 'desktop', tablet: false }
  }
  if (query) {
    console.warn('[reflect-open] Unknown platform override in query string:', query)
  }
  return null
}

/**
 * Detect the host's platform facts from the user agent and the build env.
 * `nativeShell` is Tauri's `isTauri()`, passed in so this module stays free of Tauri imports.
 *
 * The surface facets follow `appPlatform`, which is also what selects the
 * mobile root (`@platform-root` in `vite.config.ts`, `platform-root.unknown.tsx`
 * in plain-browser dev): the mobile tree and the mobile surface cannot disagree.
 */
export function detectPlatformFacts(nativeShell: boolean): PlatformFacts {
  const env = import.meta.env.TAURI_ENV_PLATFORM || ''
  const hasNavigator = typeof navigator !== 'undefined'
  // iPadOS masquerades as macOS in the user agent; the touch-point check excludes it.
  const macosDesktop =
    nativeShell &&
    hasNavigator &&
    navigator.userAgent.includes('Macintosh') &&
    navigator.maxTouchPoints === 0

  const override = devPlatformOverride(env)
  const appPlatform = override?.appPlatform ?? envPlatform(env)
  const mobile = appPlatform !== 'desktop'
  // iPadOS asks for desktop-class pages, so its webview reports a Mac user
  // agent; only an iPhone (or iPod) names itself.
  const tablet =
    override?.tablet ??
    (appPlatform === 'ios' && hasNavigator && !/iPhone|iPod/.test(navigator.userAgent))

  return {
    appPlatform,
    isNativeShell: nativeShell,
    buildPlatform: buildPlatformFromEnv(env),
    isMacosDesktop: macosDesktop,
    isTablet: tablet,
    isApplePlatform:
      hasNavigator && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent),
    hasMacosTitleBarOverlay: macosDesktop,
    surface: { touchEditor: mobile, mobileApp: mobile },
    isDev: import.meta.env.DEV,
    appVersion: version,
  }
}
