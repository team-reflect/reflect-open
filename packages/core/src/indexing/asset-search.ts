import {
  assetDescriptionSidecarPath,
  isDescribableAssetPath,
  parseAssetDescriptionSidecarMeta,
} from '../actions/asset-description'
import { isAppError } from '../errors'
import { readNote } from '../graph/commands'
import { splitFrontmatter } from '../markdown'
import {
  applyAssetSearch,
  removeAssetSearch as removeAssetSearchRows,
  type AssetSearchRow,
} from './commands'
import { db } from './db'
import { hashContent } from './hash'

/**
 * Search projection for generated asset-description sidecars. Rows attach
 * sidecar text to public referencing notes; assets are never indexed as notes.
 */

interface AssetReferenceRow {
  notePath: string
  isPrivate: number
}

async function referencedNotes(assetPath: string): Promise<AssetReferenceRow[]> {
  return db
    .selectFrom('assets')
    .innerJoin('notes', 'notes.path', 'assets.notePath')
    .where('assets.assetPath', '=', assetPath)
    .select(['assets.notePath', 'notes.isPrivate'])
    .orderBy('assets.notePath')
    .execute()
}

async function indexedAssetPaths(): Promise<string[]> {
  const referenced = await db
    .selectFrom('assets')
    .select('assetPath')
    .distinct()
    .orderBy('assetPath')
    .execute()
  const indexed = await db
    .selectFrom('assetSearch')
    .select('assetPath')
    .distinct()
    .orderBy('assetPath')
    .execute()
  return [...new Set([...referenced, ...indexed].map((row) => row.assetPath))].sort()
}

/** Source assets referenced by any of these note paths, based on current rows. */
export async function assetPathsForNotes(notePaths: string[]): Promise<string[]> {
  if (notePaths.length === 0) {
    return []
  }
  const rows = await db
    .selectFrom('assets')
    .where('notePath', 'in', notePaths)
    .select('assetPath')
    .distinct()
    .orderBy('assetPath')
    .execute()
  return rows.map((row) => row.assetPath).filter(isDescribableAssetPath)
}

/** Remove indexed rows for this asset unless it has public-only references and a managed sidecar. */
export async function reconcileAssetSearch(assetPath: string, generation: number): Promise<void> {
  if (!isDescribableAssetPath(assetPath)) {
    await removeAssetSearchRows(assetPath, generation)
    return
  }

  const refs = await referencedNotes(assetPath)
  const publicRefs = refs.filter((row) => row.isPrivate === 0)
  const hasPrivateRef = refs.some((row) => row.isPrivate !== 0)
  if (publicRefs.length === 0 || hasPrivateRef) {
    await removeAssetSearchRows(assetPath, generation)
    return
  }

  const sidecarPath = assetDescriptionSidecarPath(assetPath)
  let sidecarSource: string
  try {
    sidecarSource = await readNote(sidecarPath, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      await removeAssetSearchRows(assetPath, generation)
      return
    }
    throw cause
  }

  const meta = parseAssetDescriptionSidecarMeta(sidecarSource)
  if (meta === null || meta.source !== assetPath) {
    await removeAssetSearchRows(assetPath, generation)
    return
  }

  const text = splitFrontmatter(sidecarSource).body.trim()
  if (text === '') {
    await removeAssetSearchRows(assetPath, generation)
    return
  }

  const sidecarHash = await hashContent(sidecarSource)
  const rows: AssetSearchRow[] = publicRefs.map((row) => ({
    notePath: row.notePath,
    assetPath,
    sidecarPath,
    sourceHash: meta.sourceHash,
    sidecarHash,
    text,
  }))
  await applyAssetSearch(assetPath, rows, generation)
}

/**
 * Reconcile all referenced or previously indexed asset sidecars. This is safe
 * on open/rebuild: it reads sidecar markdown only and never generates it.
 */
export async function rebuildAssetSearchIndex(options: {
  generation: number
  signal?: AbortSignal
  isStale?: () => boolean
}): Promise<void> {
  const paths = await indexedAssetPaths()
  for (const path of paths) {
    if (options.signal?.aborted || options.isStale?.()) {
      return
    }
    try {
      await reconcileAssetSearch(path, options.generation)
    } catch (cause) {
      console.error(`asset search reconcile failed for ${path}:`, cause)
    }
  }
}

/** Remove all indexed asset sidecar rows. Used by tests and explicit cleanup paths. */
export async function removeAssetSearch(assetPath: string, generation: number): Promise<void> {
  await removeAssetSearchRows(assetPath, generation)
}
