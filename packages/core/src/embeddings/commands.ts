import { z } from 'zod'
import { localNoteReadSchema, type LocalNoteRead } from '../graph/commands'
import { getBridge, type Unlisten } from '../ipc/bridge'
import { call } from '../ipc/invoke'

/** Typed bindings for the Rust embedding runtime + vector writes (Plan 09). */

/** Byte counts for an active model download; absent until it starts. */
export const embedProgressSchema = z.object({
  /** Bytes fetched so far. */
  downloaded: z.number().int().nonnegative(),
  /** Bytes the download will fetch in total. */
  total: z.number().int().nonnegative(),
})
export type EmbedProgress = z.infer<typeof embedProgressSchema>

export const embedStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('uninitialized') }),
  z.object({
    status: z.literal('loading'),
    progress: embedProgressSchema.optional(),
  }),
  z.object({ status: z.literal('ready'), model: z.string() }),
  z.object({ status: z.literal('failed'), message: z.string() }),
])
export type EmbedStatus = z.infer<typeof embedStatusSchema>

const voidSchema = z.null()
const vectorsSchema = z.array(z.array(z.number()))
const embedPendingSchema = z.array(z.object({ path: z.string(), fingerprint: z.string() }))
const embedPreparedSchema = z
  .object({ fingerprint: z.string(), fileHash: z.string(), assetPaths: z.array(z.string()) })
  .nullable()

/** Identity of the embedding projection requested for an index session. */
export interface EmbedProjection {
  generation: number
  modelId: string
  projectionVersion: number
}

/** Select only notes without a successful checkpoint for their current inputs. */
export function embedPending(
  options: EmbedProjection,
): Promise<z.infer<typeof embedPendingSchema>> {
  return call('embed_pending', { ...options }, embedPendingSchema)
}

/** Recheck one candidate before reading it; null means no local work remains. */
export function embedPrepare(
  path: string,
  options: EmbedProjection,
): Promise<z.infer<typeof embedPreparedSchema>> {
  return call('embed_prepare', { path, ...options }, embedPreparedSchema)
}

/** Read local note/sidecar bytes from the pinned index root without hydrating iCloud files. */
export function embedRead(path: string, generation: number): Promise<LocalNoteRead> {
  return call('embed_read', { path, generation }, localNoteReadSchema)
}

export function embedStatus(): Promise<EmbedStatus> {
  return call('embed_status', {}, embedStatusSchema)
}

/** Load (downloading on first use) the model. Resolves with the outcome. */
export function embedEnsure(): Promise<EmbedStatus> {
  return call('embed_ensure', {}, embedStatusSchema)
}

/** Embed texts → 384-dim vectors. Errors unless status is `ready`. */
export function embedTexts(texts: string[]): Promise<number[][]> {
  return call('embed_texts', { texts }, vectorsSchema)
}

/** One chunk in the `embed_apply` payload; `vector` only for new/changed. */
export interface EmbedChunkPayload {
  heading: string | null
  posFrom: number
  posTo: number
  text: string
  contentHash: string
  modelId: string
  vector: number[] | null
}

/** Replace chunks and checkpoint their inputs atomically, if the revision still matches. */
export async function embedApply(
  path: string,
  chunks: EmbedChunkPayload[],
  options: EmbedProjection & { fingerprint: string },
): Promise<void> {
  const { generation, ...projection } = options
  await call('embed_apply', { request: { path, chunks, ...projection }, generation }, voidSchema)
}

/** Drop a deleted note's chunks + vectors (generation-pinned). */
export async function embedRemove(path: string, generation: number): Promise<void> {
  await call('embed_remove', { path, generation }, voidSchema)
}

/** Live runtime status changes (download started/finished/failed). */
export function subscribeEmbedStatus(handler: (status: EmbedStatus) => void): Promise<Unlisten> {
  return getBridge().listen('embed:status', (payload) => {
    const parsed = embedStatusSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid embed:status payload:', parsed.error)
    }
  })
}
