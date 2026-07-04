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

const mobileStorageInfoSchema = z.object({
  localRoot: z.string(),
  icloudRoot: z.string().nullable(),
  icloudHasGraph: z.boolean(),
})

/**
 * Where the mobile graph can live (Plan 21): the app-sandbox `Documents/`
 * directory (always present, never synced) and the app's iCloud Drive
 * container when iCloud is usable — plus whether the container already holds
 * notes from another device.
 */
export type MobileStorageInfo = z.infer<typeof mobileStorageInfoSchema>

/** Which of the {@link MobileStorageInfo} roots the graph lives in. */
export type MobileStorageKind = 'icloud' | 'local'

/**
 * Resolves the mobile storage roots (Plan 21). Mobile-only — the desktop
 * shell rejects it (graphs are user-picked there). iOS container paths change
 * across restore/update; resolve this fresh every launch and never persist
 * the returned paths.
 */
export async function mobileStorage(): Promise<MobileStorageInfo> {
  return call('mobile_storage', {}, mobileStorageInfoSchema)
}

/**
 * Asks iCloud to download every not-yet-local file under `root`, returning
 * how many placeholders were found. iOS does not pull container files down
 * eagerly; call this on open/resume for iCloud graphs and re-reconcile the
 * index while the count stays above zero.
 */
export async function icloudDownloadPending(root: string): Promise<number> {
  return call('icloud_download_pending', { root }, z.number().int().nonnegative())
}
