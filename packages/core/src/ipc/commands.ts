import { z } from 'zod'
import { call } from './invoke'

const appVersionSchema = z.string()

/**
 * Returns the desktop application version reported by the Rust shell.
 *
 * Serves as the canonical round-trip example for the IPC boundary: a real
 * `#[tauri::command]`, a zod-validated response, no direct `invoke` in the UI.
 */
export async function getAppVersion(): Promise<string> {
  return call('app_version', {}, appVersionSchema)
}

const appPlatformSchema = z.enum(['desktop', 'ios', 'android'])

/** Which UI family the shell was built for (Plan 19's root gate). */
export type AppPlatform = z.infer<typeof appPlatformSchema>

/**
 * Returns the platform the Rust shell was compiled for. The frontend's root
 * gate switches between the desktop and mobile surface trees on this answer;
 * it is a build-time constant, so callers may cache it freely.
 */
export async function getAppPlatform(): Promise<AppPlatform> {
  return call('app_platform', {}, appPlatformSchema)
}

/** Narrows {@link AppPlatform} to the mobile family. */
export function isMobilePlatform(platform: AppPlatform): boolean {
  return platform !== 'desktop'
}

/**
 * The fixed mobile graph root: the app's `Documents/` directory (Plan 19).
 * Mobile-only — the desktop shell rejects it (graphs are user-picked there).
 * iOS container paths change across restore/update; resolve this fresh every
 * launch and never persist the returned path.
 */
export async function mobileGraphRoot(): Promise<string> {
  return call('mobile_graph_root', {}, z.string())
}
