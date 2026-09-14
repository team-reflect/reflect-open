import { XPostSchema } from '@post-embed/schema'
import { safeParse } from 'valibot'
import { z } from 'zod'

// FIXME: duplicate of `postIdSchema` in `@reflect/core/capture-envelope`. And the
// `postIdSchema.safeParse(parsed.output.id)` below is redundant: `XPostSchema` already enforces the
// same regex on `id`.
export const postIdSchema = z.string().regex(/^[1-9]\d{0,19}$/)

export const capturedPostSchema = z.unknown().transform((input, context) => {
  const parsed = safeParse(XPostSchema, input)
  if (!parsed.success || !postIdSchema.safeParse(parsed.output.id).success) {
    context.addIssue({ code: 'custom', message: 'invalid-snapshot' })
    return z.NEVER
  }
  return parsed.output
})

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
    documentToken: z.uuid(),
    post: capturedPostSchema,
  }),
  failureSchema,
])
export type CaptureLookupResponse = z.output<typeof captureLookupResponseSchema>
