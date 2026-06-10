import { z } from 'zod'

/**
 * The shared error contract for everything crossing the Rust↔TS boundary.
 *
 * Rust commands return `Result<T, AppError>`; the serialized error is validated
 * here so the UI can branch on `kind` with a type guard instead of inspecting
 * opaque strings. Kinds mirror the Rust `AppError` enum (camelCase via serde).
 */
export const appErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('io'), message: z.string() }),
  z.object({ kind: z.literal('notFound'), message: z.string() }),
  z.object({ kind: z.literal('traversal'), message: z.string() }),
  z.object({ kind: z.literal('noGraph'), message: z.string() }),
  z.object({ kind: z.literal('parse'), message: z.string() }),
  z.object({ kind: z.literal('unknown'), message: z.string() }),
])

export type AppError = z.infer<typeof appErrorSchema>

/** Type guard: is this value a well-formed {@link AppError}? */
export function isAppError(value: unknown): value is AppError {
  return appErrorSchema.safeParse(value).success
}

/**
 * Coerce any thrown/rejected value into an {@link AppError}. A well-formed
 * command error passes through; anything else becomes `unknown`.
 */
export function toAppError(value: unknown): AppError {
  const parsed = appErrorSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  let message: string
  if (value instanceof Error) {
    message = value.message
  } else if (typeof value === 'string') {
    message = value
  } else {
    try {
      // `JSON.stringify` can throw (BigInt, circular refs); never let the error
      // path itself throw.
      message = JSON.stringify(value)
    } catch {
      message = String(value)
    }
  }
  return { kind: 'unknown', message }
}

/**
 * The display message for any thrown/rejected value — {@link toAppError}'s
 * normalization, as a string. The standard way to render a caught `unknown`
 * to the user (or a log line) without `[object Object]` surprises.
 */
export function errorMessage(value: unknown): string {
  return toAppError(value).message
}
