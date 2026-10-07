import { z } from 'zod'
import { call } from '../ipc/invoke.ts'

/**
 * Per-device sync preferences (`.reflect/sync.json`, never synced). Today one
 * flag: on a graph iCloud Drive already syncs, whether this device is the one
 * that pushes the git backup. Off by default, so a graph with both iCloud
 * and a remote has one writer and the other devices keep local history only.
 */
export const syncPrefsSchema = z.object({
  backupWriter: z.boolean(),
})
export type SyncPrefs = z.infer<typeof syncPrefsSchema>

export async function getSyncPrefs(generation: number): Promise<SyncPrefs> {
  return await call('sync_prefs_get', { generation }, syncPrefsSchema)
}

export async function setSyncPrefs(prefs: SyncPrefs, generation: number): Promise<void> {
  await call('sync_prefs_set', { prefs, generation }, z.null())
}
