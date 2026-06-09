import { z } from 'zod'

/**
 * The shared error contract for everything crossing the Rust↔TS boundary.
 *
 * Rust commands return `Result<T, AppError>`; the serialized error is validated
 * here so the UI can branch on `kind` with a type guard instead of inspecting
 * opaque strings.
 */
export const appErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('io'), message: z.string() }),
  z.object({ kind: z.literal('parse'), message: z.string() }),
  z.object({ kind: z.literal('notFound'), message: z.string() }),
  z.object({ kind: z.literal('unknown'), message: z.string() }),
])

export type AppError = z.infer<typeof appErrorSchema>

/** Type guard: is this value a well-formed {@link AppError}? */
export function isAppError(value: unknown): value is AppError {
  return appErrorSchema.safeParse(value).success
}
