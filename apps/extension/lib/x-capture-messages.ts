import { xPostSchema } from '@reflect/core/x-archive'
import { postIdSchema } from '@reflect/core/capture-envelope'
import { z } from 'zod'

export { postIdSchema }
export const capturedPostSchema = xPostSchema

export type CapturedPost = z.output<typeof capturedPostSchema>

export const captureLookupRequestSchema = z.object({
  type: z.literal('x-capture:lookup'),
  postId: postIdSchema,
})

const failureSchema = z.object({ ok: z.literal(false), reason: z.string() })
export const captureLookupResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    pageUrl: z.url(),
    post: capturedPostSchema,
  }),
  failureSchema,
])
export type CaptureLookupResponse = z.output<typeof captureLookupResponseSchema>
