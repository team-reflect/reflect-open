/** Which UI family the app was built for. */
export type AppPlatform = 'desktop' | 'ios' | 'android'

/** Narrows {@link AppPlatform} to the mobile family. */
export function isMobilePlatform(platform: AppPlatform): boolean {
  return platform !== 'desktop'
}

/**
 * The Tauri build targets the app ships for.
 */
export type BuildPlatform = 'darwin' | 'windows' | 'linux' | 'ios' | 'android'

/**
 * How the running surface differs from stock desktop.
 */
export interface PlatformSurface {
  /**
   * Editors apply touch text-input hygiene (the mobile app).
   */
  readonly touchEditor: boolean
  /**
   * Shared components render their mobile variants (the mobile app).
   */
  readonly mobileApp: boolean
}

/**
 * What the host is and can do, decided once by the app at startup.
 */
export interface PlatformFacts {
  /**
   * Which UI family the app runs.
   */
  readonly appPlatform: AppPlatform
  /**
   * A real native shell (plugins, OS windows) exists; false in browser dev.
   */
  readonly isNativeShell: boolean
  /**
   * The Tauri build target; null outside a Tauri build.
   */
  readonly buildPlatform: BuildPlatform | null
  /**
   * The macOS desktop shell (not iPadOS, not browser dev).
   */
  readonly isMacosDesktop: boolean
  /**
   * Mod renders as ⌘ rather than Ctrl.
   */
  readonly isApplePlatform: boolean
  /**
   * The window draws content under a transparent macOS title bar.
   */
  readonly hasMacosTitleBarOverlay: boolean
  readonly surface: PlatformSurface
  readonly isDev: boolean
  readonly appVersion: string
}
