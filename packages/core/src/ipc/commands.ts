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
  /** The container's `Documents/` dir when iCloud is usable — new graphs are created inside it. */
  icloudDocumentsRoot: z.string().nullable(),
  /** Every graph already in the container (name-sorted) — onboarding and the switcher list them. */
  icloudGraphRoots: z.array(z.string()),
})

/**
 * Where the mobile graph can live (Plan 21): the app-sandbox `Documents/`
 * directory (always present, never synced) and the app's iCloud Drive
 * container when iCloud is usable — plus every graph the container already
 * holds (a user can keep several).
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

const icloudDownloadPendingSchema = z.number().int().nonnegative()

/**
 * Which placeholders a pending-download call covers: `'notes'` is markdown
 * under the note directories — what an open/resume requests first, so a
 * first sync isn't crushed under thousands of concurrent asset downloads —
 * and `'all'` is everything, requested once the notes have drained.
 */
export type IcloudDownloadScope = 'notes' | 'all'

/**
 * Asks iCloud to download every not-yet-local file in `scope` under `root`,
 * returning how many placeholders were found. iOS does not pull container
 * files down eagerly; call this once per open/resume for iCloud graphs, then
 * poll {@link icloudPendingCount} while the count stays above zero.
 */
export async function icloudDownloadPending(
  root: string,
  scope: IcloudDownloadScope,
): Promise<number> {
  return call(
    'icloud_download_pending',
    { root, notesOnly: scope === 'notes' },
    icloudDownloadPendingSchema,
  )
}

/**
 * Counts the not-yet-local placeholders in `scope` under `root` without
 * requesting anything — the poll half of {@link icloudDownloadPending}:
 * re-requesting thousands of in-flight downloads every tick is wasted
 * traffic.
 */
export async function icloudPendingCount(
  root: string,
  scope: IcloudDownloadScope,
): Promise<number> {
  return call(
    'icloud_pending_count',
    { root, notesOnly: scope === 'notes' },
    icloudDownloadPendingSchema,
  )
}

/**
 * The app-sandbox `Documents/` root alone — the cheap half of
 * {@link mobileStorage}, available before the iCloud container resolves (the
 * first container lookup can take a long time on a fresh install). Mobile
 * only; derive fresh every launch and never persist.
 */
export async function mobileStorageLocal(): Promise<string> {
  return call('mobile_storage_local', {}, z.string())
}

const icloudStatusSchema = z.object({
  available: z.boolean(),
  documentsRoot: z.string().nullable(),
  /** Every graph in the container (name-sorted) — onboarding lists them. */
  existingGraphRoots: z.array(z.string()),
})

/**
 * Whether this build can reach its iCloud Drive container (Plan 21). Dev
 * builds without the iCloud entitlement/provisioning profile honestly report
 * unavailable.
 */
export type IcloudStatus = z.infer<typeof icloudStatusSchema>

/** Resolve iCloud container availability (desktop settings, Plan 21). */
export async function icloudStatus(): Promise<IcloudStatus> {
  return call('icloud_status', {}, icloudStatusSchema)
}

const icloudAdoptedRootSchema = z.string()

/**
 * Copy the open graph into the iCloud container and return the new root
 * (Plan 21 Phase 1 move-in). The copy is count+byte verified; the original
 * graph stays untouched at its old path as the recovery copy. The caller
 * re-opens the graph at the returned root and runs a baseline conflict scan.
 */
export async function icloudAdoptGraph(generation: number): Promise<string> {
  return call('icloud_adopt_graph', { generation }, icloudAdoptedRootSchema)
}

const icloudSweepChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['upsert', 'remove']),
  modifiedMs: z.number().optional(),
})

const icloudSweepOutcomeSchema = z.object({
  changed: z.array(icloudSweepChangeSchema),
  needsReview: z.array(z.string()),
  deferred: z.array(z.string()),
  autoResolved: z.number().int().nonnegative(),
})

/**
 * What one iCloud conflict sweep did (Plan 21): the files it rewrote or
 * removed (reindex these directly), the paths now carrying markers, the
 * paths deferred for dirty sessions, and how many conflicts auto-resolved.
 */
export type IcloudSweepOutcome = z.infer<typeof icloudSweepOutcomeSchema>

/** Options for {@link icloudConflictsScan}. */
export interface IcloudScanOptions {
  /** The open graph's generation — the scan is pinned to it. */
  generation: number
  /** Notes with dirty open sessions; their conflicts defer to the next scan. */
  skipPaths?: string[]
  /**
   * External changes just applied cleanly — their content becomes the new
   * shadow merge base. Never pass this device's own writes.
   */
  ingestedPaths?: string[]
  /**
   * Record a fill-only baseline (adoption): notes without a base snapshot
   * their current content. Safe to repeat — existing bases never move here.
   */
  recordBaseline?: boolean
}

/** Run an iCloud conflict sweep over the open graph (Plan 21 Phase 2). */
export async function icloudConflictsScan(options: IcloudScanOptions): Promise<IcloudSweepOutcome> {
  return call(
    'icloud_conflicts_scan',
    {
      generation: options.generation,
      skipPaths: options.skipPaths ?? [],
      ingestedPaths: options.ingestedPaths ?? [],
      recordBaseline: options.recordBaseline ?? false,
    },
    icloudSweepOutcomeSchema,
  )
}

const voidResponseSchema = z.null()

/**
 * Start the iCloud metadata-query watch over `root` (Plan 21 Phase 2).
 * `emitFileChanges` turns its snapshot diffs into `index:changed` events —
 * pass true on mobile (no file watcher there), false on desktop. Conflict
 * paths always emit as `icloud:conflicts`.
 */
export async function icloudWatchStart(root: string, emitFileChanges: boolean): Promise<void> {
  await call('icloud_watch_start', { root, emitFileChanges }, voidResponseSchema)
}

/** Stop the active iCloud watch (graph switch). Idempotent. */
export async function icloudWatchStop(): Promise<void> {
  await call('icloud_watch_stop', {}, voidResponseSchema)
}
