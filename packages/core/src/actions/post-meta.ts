import { z } from 'zod'
import { postTriggerSchema, type CapturedPost } from './capture-envelope'

/**
 * The post keys of a capture note's frontmatter (Plan 25) — declared,
 * written, and read back here and nowhere else. `capture-note.ts` merges the
 * schema into the capture meta schema and writes {@link postFrontmatter} at
 * drain time; enrichment patches the same keys through
 * {@link postFrontmatterPatch}.
 */

export const postNoteMetaSchema = z.object({
  /** Set for post captures; absent on link captures. */
  captureKind: z.literal('post').optional(),
  postId: z.string().optional(),
  postTrigger: postTriggerSchema.optional(),
  /** The drain-written text is a prefix; enrichment tries to complete it. */
  postTruncated: z.boolean().optional(),
})

export type PostNoteMeta = z.infer<typeof postNoteMetaSchema>

/** The identity a post capture note carries, or `null` for a link capture. */
export interface PostCaptureMeta {
  id: string
  trigger: CapturedPost['trigger']
  truncated: boolean
}

export function postCaptureMeta(meta: PostNoteMeta): PostCaptureMeta | null {
  if (meta.captureKind !== 'post' || meta.postId === undefined) {
    return null
  }
  return {
    id: meta.postId,
    trigger: meta.postTrigger ?? 'manual',
    truncated: meta.postTruncated === true,
  }
}

/** The frontmatter the drain stamps on a post capture note. */
export function postFrontmatter(post: CapturedPost): Record<string, unknown> {
  return {
    captureKind: 'post',
    postId: post.id,
    postTrigger: post.trigger,
    ...postFrontmatterPatch(post),
  }
}

/** The keys enrichment re-stamps after merging (`undefined` deletes). */
export function postFrontmatterPatch(
  post: Pick<CapturedPost, 'truncated'>,
): Record<string, unknown> {
  return { postTruncated: post.truncated === true ? true : undefined }
}
