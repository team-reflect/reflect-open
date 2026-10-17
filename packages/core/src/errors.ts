import { z } from 'zod'

/**
 * Every `kind` an {@link AppError} can carry. Kinds mirror the Rust `AppError`
 * enum (camelCase via serde).
 */
const appErrorKinds = [
  'io',
  'notFound',
  'traversal',
  'noGraph',
  'parse',
  'auth',
  'network',
  'unknown',
] as const

export type AppErrorKind = (typeof appErrorKinds)[number]

/**
 * The serialized Rust `AppError`: Rust commands return `Result<T, AppError>`
 * and reject with `{ kind, message }`. {@link toAppError} turns it into an
 * {@link AppError} at the IPC boundary.
 */
const appErrorWireSchema = z.object({ kind: z.enum(appErrorKinds), message: z.string() })

/**
 * The shared error contract. Rust-originated errors become instances at the
 * IPC boundary ({@link toAppError}); TypeScript code throws them directly, so
 * `catch` sites branch on `kind` with {@link isAppError} either way.
 */
export class AppError extends Error {
  readonly kind: AppErrorKind

  constructor(kind: AppErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppError'
    this.kind = kind
  }
}

/** Type guard: is this value an {@link AppError}? */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/**
 * Coerce any thrown/rejected value into an {@link AppError}. An `AppError`
 * passes through unchanged, a serialized Rust error keeps its `kind`, and
 * anything else becomes `unknown`.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) {
    return value
  }
  const parsed = appErrorWireSchema.safeParse(value)
  if (parsed.success) {
    return new AppError(parsed.data.kind, parsed.data.message)
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
  return new AppError('unknown', message, { cause: value })
}

/**
 * The display message for any thrown/rejected value — {@link toAppError}'s
 * normalization, as a string. The standard way to render a caught `unknown`
 * to the user (or a log line) without `[object Object]` surprises.
 */
export function errorMessage(value: unknown): string {
  return toAppError(value).message
}
