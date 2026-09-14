import { XPostSchema } from '@post-embed/schema'
import { safeParse } from 'valibot'
import { z } from 'zod'

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

const mediaPositionSchema = z.object({
  slot: z.string(),
  unavailable: z.boolean(),
})
const mediaResultSchema = z.discriminatedUnion('status', [
  mediaPositionSchema.extend({
    status: z.literal('read'),
    kind: z.enum(['image', 'video']),
    mime: z.string(),
    bytes: z.number().int().positive(),
    signature: z.array(z.number().int().min(0).max(255)).max(32),
  }),
  mediaPositionSchema.extend({
    status: z.literal('failed'),
    kind: z.enum(['image', 'video']),
    reason: z.string(),
  }),
  mediaPositionSchema.extend({
    status: z.literal('unsupported'),
    reason: z.enum(['hls-only', 'no-source']),
  }),
])
export type ProbeMediaResult = z.output<typeof mediaResultSchema>

export const captureProbeReportSchema = z.object({
  post: capturedPostSchema,
  documentToken: z.uuid(),
  counts: z.object({
    videoCount: z.number().int().nonnegative(),
    mp4Available: z.number().int().nonnegative(),
    hlsOnly: z.number().int().nonnegative(),
    noSource: z.number().int().nonnegative(),
  }),
  results: z.array(mediaResultSchema),
})
export type CaptureProbeReport = z.output<typeof captureProbeReportSchema>
export const captureProbeResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), report: captureProbeReportSchema }),
  failureSchema,
])
