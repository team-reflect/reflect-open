import { z } from 'zod'
import { safeParse } from 'valibot'
import { XPostSchema } from '@post-embed/schema'

/** One adapter shared by captured messages and archive files. */
export const xPostSchema = z.unknown().transform((value, context) => {
  const result = safeParse(XPostSchema, value)
  if (result.success) return result.output
  context.addIssue({ code: 'custom', message: 'invalid-post' })
  return z.NEVER
})
export const archivedPostSchema = z.looseObject({
  kind: z.literal('x-post'),
  capturedAt: z.iso.datetime({ offset: true }),
  data: xPostSchema,
})
export const parseArchivedPost = archivedPostSchema.parse
