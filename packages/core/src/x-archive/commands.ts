import { z } from 'zod'
import { call } from '../ipc/invoke'
import { archivedPostSchema } from './schema'

export const resolvedPostSchema = z.object({
  archive: archivedPostSchema,
  resources: z.array(z.object({ url: z.string(), hash: z.string() })),
})
export function readArchivedPost(generation: number, postId: string) {
  return call('x_archive_read', { generation, postId }, archivedPostSchema.nullable())
}
export function writeArchivedPost(generation: number, value: object) {
  return call('x_archive_write', { generation, value }, z.null())
}
export function resolveArchivedPost(generation: number, postId: string) {
  return call('x_archive_resolve', { generation, postId }, resolvedPostSchema.nullable())
}
export function getXArchiveOwners(assetPath: string) {
  if (!assetPath.startsWith('assets/x/')) return Promise.resolve([] as string[])
  return call('x_archive_owners', { assetPath }, z.array(z.string()))
}
