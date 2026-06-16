import type { ZodType } from 'zod'
import { toAppError, type AppError } from '../errors'
import { getBridge } from './bridge'

/**
 * The single boundary where an untyped native IPC response becomes a typed,
 * validated domain value.
 *
 * Components and hooks must never reach for the bridge (or `@tauri-apps/api`)
 * directly — they call a typed binding (see the per-domain command modules)
 * that funnels through here. Every response is validated with a zod schema;
 * Rust emits camelCase keys so the parsed value needs no further normalization.
 *
 * On failure this always throws an {@link AppError}: a rejected command is
 * coerced via {@link toAppError}; a response that doesn't match `schema` becomes
 * a `parse` error. Callers can branch on `error.kind`.
 *
 * @param command  The `#[tauri::command]` name (snake_case).
 * @param args     Arguments passed to the command.
 * @param schema   Zod schema the response must satisfy.
 * @returns        The validated, typed result.
 */
export async function call<TOutput>(
  command: string,
  args: Record<string, unknown>,
  // Input is `unknown`, not `TOutput`: schemas that normalize (`.catch`,
  // `.default`) have a wider input type than output, and a validator's job is
  // to consume untyped IPC data anyway. (zod 4's `ZodType<Output, Input>`
  // dropped the `ZodTypeDef` middle generic that zod 3 required here.)
  schema: ZodType<TOutput, unknown>,
): Promise<TOutput> {
  const bridge = getBridge()
  let raw: unknown
  try {
    raw = await bridge.invoke(command, args)
  } catch (error) {
    throw toAppError(error)
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    const appError: AppError = {
      kind: 'parse',
      message: `unexpected response shape from "${command}": ${result.error.message}`,
    }
    throw appError
  }
  return result.data
}
