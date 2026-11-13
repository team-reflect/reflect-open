import type { AppError as AppErrorWire } from '@reflect/types'

/**
 * Every `kind` an {@link AppError} can carry, generated from the Rust
 * `AppError` enum.
 */
export type AppErrorKind = AppErrorWire['kind']

/**
 * Every {@link AppErrorKind} at runtime. The `Record` type makes `tsc` reject
 * a missing or unknown kind.
 */
const appErrorKinds: Record<AppErrorKind, true> = {
  io: true,
  notFound: true,
  traversal: true,
  noGraph: true,
  parse: true,
  auth: true,
  network: true,
  unknown: true,
}

/**
 * Checks for the serialized Rust `AppError`: Rust commands return
 * `Result<T, AppError>` and reject with `{ kind, message }`.
 */
function isAppErrorWire(value: unknown): value is AppErrorWire {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const wire = value as Record<string, unknown>
  return (
    typeof wire.kind === 'string' &&
    Object.hasOwn(appErrorKinds, wire.kind) &&
    typeof wire.message === 'string'
  )
}

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
  if (isAppErrorWire(value)) {
    return new AppError(value.kind, value.message, { cause: value })
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
