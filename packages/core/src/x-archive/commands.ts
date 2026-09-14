import { z } from 'zod'
import { call } from '../ipc/invoke'
import { archivedPostSchema } from './schema'

export const resolvedPostSchema = z.object({
  archive: archivedPostSchema,
  resources: z.array(z.object({
    url: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.string(), error: z.string().nullable(),
    bytes: z.number().nullable(),
  })),
})
export function readArchivedPost(generation: number, postId: string) {
  return call('x_archive_read', { generation, postId }, archivedPostSchema.nullable())
}
export function writeArchivedPost(generation: number, postId: string, expected: string | null, value: object) {
  return call('x_archive_write', { generation, postId, expected, value }, z.boolean())
}
export function markArchivedCaptureProcessed(generation: number, event: string) {
  return call('x_archive_processed', { generation, event }, z.null())
}
export function resolveArchivedPost(generation: number, postId: string) {
  return call('x_archive_resolve', { generation, postId }, resolvedPostSchema.nullable())
}

export function getXArchiveOwners(assetPath: string) {
  return call('x_archive_owners', { assetPath }, z.array(z.string()))
}

