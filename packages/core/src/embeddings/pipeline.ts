import { isTemplatePath } from '../graph/paths'
import { gatherAssetDescriptionBodies } from '../indexing/asset-description-text'
import { db } from '../indexing/db'
import { hashContent } from '../indexing/hash'
import { parseNote } from '../markdown'
import { chunkAssetDescriptions, chunkNote } from './chunk'
import {
  embedApply,
  embedPending,
  embedPrepare,
  embedRead,
  embedTexts,
  type EmbedChunkPayload,
} from './commands'

/**
 * The incremental embedding pass (Plan 09): chunk a note, diff chunk hashes
 * against the stored rows, embed only what changed, and apply as one
 * generation-pinned write. TS owns this orchestration (Rust supplies
 * `embed_texts` + the table writes), mirroring the indexing pipeline.
 *
 * A note's chunk set also carries its referenced assets' description bodies
 * (Plan 20 → semantic leg), mirroring the FTS fold — so a meaning-level query
 * about an image or PDF's contents surfaces the referencing note on the
 * semantic side of hybrid retrieval, not just on keyword matches.
 */

/** Bump when chunking, asset folding, or other embedding projection rules change. */
export const EMBEDDING_PROJECTION_VERSION = 1

export interface EmbedNoteOptions {
  path: string
  generation: number
  /** The model recorded per vector (from the runtime's `ready` status). */
  modelId: string
  /** Pre-loaded content (the watcher path has it); read from disk if absent. */
  content?: string
  /** Stop work after a graph/model switch or semantic-search disable. */
  isStale?: (() => boolean) | undefined
}

/**
 * Bring one note's embeddings up to date. Returns the number of chunks that
 * were (re)embedded; current checkpoints, reusable vectors, and deferred or
 * cancelled work all return 0.
 */
export async function embedNote(options: EmbedNoteOptions): Promise<number> {
  const { path, generation, modelId, isStale } = options
  if (isStale?.() || isTemplatePath(path)) {
    return 0 // templates are boilerplate — never embedded, never retrieved
  }
  const projection = { generation, modelId, projectionVersion: EMBEDDING_PROJECTION_VERSION }
  const prepared = await embedPrepare(path, projection)
  if (prepared === null || isStale?.()) {
    return 0
  }
  let content = options.content
  if (content === undefined) {
    let read: Awaited<ReturnType<typeof embedRead>>
    try {
      read = await embedRead(path, generation)
    } catch {
      return 0 // deleted between event and read; the remove path handles it
    }
    if (read.kind === 'evicted') {
      // iCloud-evicted: reading would force an on-demand download, and the
      // backfill sweeping a whole evicted graph would turn into thousands of
      // serial blocking downloads. The pre-eviction vectors stay valid (rows
      // survive eviction); if the note re-materializes with new content, the
      // index-applied follow-up re-embeds it then.
      return 0
    }
    content = read.content
  }
  if (isStale?.() || (await hashContent(content)) !== prepared.fileHash || isStale?.()) {
    return 0 // the index must first catch up with the bytes we actually read
  }

  const parsed = parseNote({ path, source: content })
  const assetPaths = [...new Set(parsed.assets.map((asset) => asset.path))].sort()
  if (JSON.stringify(assetPaths) !== JSON.stringify([...prepared.assetPaths].sort())) {
    return 0 // path-relative references changed; wait for the index projection
  }
  const gathered = await gatherAssetDescriptionBodies(
    parsed.assets.map((asset) => asset.path),
    (descriptionPath) => embedRead(descriptionPath, generation),
  )
  if (isStale?.() || gathered.evicted.length > 0) {
    // A referenced sidecar is iCloud-evicted. `embedApply` replaces the
    // note's *entire* chunk set, so applying without that sidecar's body
    // would silently drop its previously embedded chunks — and sidecars are
    // untracked by the watcher, so nothing would ever restore them. Skip the
    // whole note this pass; the stored vectors stay valid until the sidecar
    // is local again.
    return 0
  }
  const chunks = [
    ...(await chunkNote(path, content, parsed)),
    ...(await chunkAssetDescriptions(gathered.bodies, content.length + 1)),
  ]
  if (isStale?.()) {
    return 0
  }

  // Stored hash+model pairs, **counted**: duplicate identical sections mean
  // several chunks can share one hash, and only as many may skip embedding as
  // there are stored rows to pair with (apply_chunks pairs one row per
  // skipped chunk — an unmatched skip is a loud error). A model change makes
  // every chunk "new", so a model switch re-embeds with no extra bookkeeping.
  const existing =
    chunks.length === 0
      ? []
      : await db
          .selectFrom('embeddingChunks')
          .where('notePath', '=', path)
          .select(['contentHash', 'modelId'])
          .execute()
  if (isStale?.()) {
    return 0
  }
  const available = new Map<string, number>()
  for (const row of existing) {
    const key = `${row.modelId} ${row.contentHash}`
    available.set(key, (available.get(key) ?? 0) + 1)
  }

  const skip = chunks.map((chunk) => {
    const key = `${modelId} ${chunk.contentHash}`
    const remaining = available.get(key) ?? 0
    if (remaining > 0) {
      available.set(key, remaining - 1)
      return true
    }
    return false
  })
  const toEmbed = chunks.filter((_, index) => !skip[index])
  const vectors = toEmbed.length > 0 ? await embedTexts(toEmbed.map((chunk) => chunk.text)) : []
  if (isStale?.()) {
    return 0
  }
  let vectorAt = 0

  const payload: EmbedChunkPayload[] = chunks.map((chunk, index) => ({
    heading: chunk.heading,
    posFrom: chunk.posFrom,
    posTo: chunk.posTo,
    text: chunk.text,
    contentHash: chunk.contentHash,
    modelId,
    // A non-skipped chunk always has a freshly-embedded vector: `vectors` is
    // exactly as long as the non-skipped chunks, consumed in order here.
    vector: skip[index] ? null : vectors[vectorAt++]!,
  }))
  await embedApply(path, payload, { ...projection, fingerprint: prepared.fingerprint })
  return toEmbed.length
}

/**
 * Backfill dirty indexed notes (initial enable, repair). Unchanged graphs
 * need one candidate query and no note reads, chunk queries, or writes.
 */
export interface BackfillEmbeddingsOptions {
  generation: number
  modelId: string
  onProgress?: (done: number, total: number) => void
  /** Abort between notes (e.g. graph switch). */
  isStale?: () => boolean
  /** Serialize each note with live work without making discovery hold the queue. */
  scheduleNote?: (work: () => Promise<void>) => Promise<void>
}

/** Process current dirty candidates, checking cancellation between asynchronous stages. */
export async function backfillEmbeddings(
  options: BackfillEmbeddingsOptions,
): Promise<'completed' | 'aborted'> {
  const { generation, modelId, onProgress, isStale, scheduleNote } = options
  if (isStale?.()) {
    return 'aborted'
  }
  const rows = await embedPending({
    generation,
    modelId,
    projectionVersion: EMBEDDING_PROJECTION_VERSION,
  })
  let done = 0
  for (const row of rows) {
    if (isStale?.()) {
      return 'aborted'
    }
    try {
      const work = async (): Promise<void> => {
        await embedNote({ path: row.path, generation, modelId, isStale })
      }
      if (scheduleNote) {
        await scheduleNote(work)
      } else {
        await work()
      }
    } catch (cause) {
      console.error(`embedding backfill failed for ${row.path}:`, cause)
    }
    done += 1
    onProgress?.(done, rows.length)
  }
  return isStale?.() ? 'aborted' : 'completed'
}
