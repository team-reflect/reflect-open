import { setBridge, type AppPlatform } from '@reflect/core'
import { createDevBridge } from '@/dev/dev-bridge'
import { createDevFileStore } from '@/dev/dev-file-store'
import { createDevIndexDb } from '@/dev/dev-index-db'
import { seedGraphFiles } from '@/dev/seed-graph'

let installation: Promise<void> | null = null

/**
 * Install the in-browser dev bridge (dev builds only): an in-memory graph
 * seeded with demo notes, backed by the real index schema in wasm SQLite.
 * Loaded lazily by `PlatformRoot` whenever plain-browser dev has no native
 * shell — with platform `desktop` by default, or `ios`/`android` when the
 * `?platform=` override forces the mobile tree. The chosen tree then boots
 * through its ordinary path: graph open, full index rebuild from the seeded
 * files, queries over `db_query`.
 *
 * Idempotent: React 19 StrictMode double-fires the installing effect, and the
 * second call must not re-seed or swap the bridge mid-boot.
 */
export function installDevBridge(platform: AppPlatform): Promise<void> {
  installation ??= install(platform)
  return installation
}

async function install(platform: AppPlatform): Promise<void> {
  const index = await createDevIndexDb()
  const files = createDevFileStore(seedGraphFiles())
  setBridge(createDevBridge({ platform, files, index }))
  // A console handle for poking the shim while debugging mobile surfaces:
  // `__reflectDev.query('select path, title from notes')`, `.files.read(...)`.
  Object.assign(window, { __reflectDev: { query: index.query, files } })
  console.info(`[dev-bridge] installed: platform=${platform}, in-memory graph + wasm SQLite index`)
}
