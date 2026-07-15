import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge'

/** Native event emitted when the active graph's shared file catalog changes. */
export const FILE_CATALOG_CHANGED_EVENT = 'graph:catalog-changed'

const fileCatalogChangedSchema = z
  .object({ generation: z.number().int().nonnegative() })
  .strict()

/** Identity of the graph session whose file catalog was invalidated. */
export type FileCatalogChanged = z.infer<typeof fileCatalogChangedSchema>

/**
 * Subscribe to generation-pinned catalog invalidations. This complements the
 * content-oriented `index:changed` stream: an iCloud eviction is neither an
 * upsert nor a removal, but cached attachment matches must still be discarded.
 */
export function subscribeFileCatalogChanged(
  handler: (change: FileCatalogChanged) => void,
): Promise<Unlisten> {
  return getBridge().listen(FILE_CATALOG_CHANGED_EVENT, (payload) => {
    const parsed = fileCatalogChangedSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid graph:catalog-changed payload:', parsed.error)
    }
  })
}
